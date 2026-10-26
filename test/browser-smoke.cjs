// Exercises the real built Excalidraw webview with a simulated VS Code message
// host. This does not claim coverage of VS Code's native tab/window lifecycle.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createRequire } = require("node:module");
const ts = require("typescript");
const { chromium } = createRequire(require.resolve("@vscode/test-web"))(
  "playwright"
);

const root = path.resolve(__dirname, "..");
const assets = path.join(root, "webview/dist");
const compiled = ts.transpileModule(
  fs.readFileSync(path.join(root, "src/scene.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  }
).outputText;
const sceneModule = { exports: {} };
new Function("exports", "module", compiled)(sceneModule.exports, sceneModule);
const { mergeSceneChange } = sceneModule.exports;

const config = Buffer.from(
  JSON.stringify({
    name: "Synchronization smoke test",
    theme: "light",
    langCode: "en",
    viewModeEnabled: false,
    imageParams: {
      exportBackground: true,
      exportScale: 1,
      exportWithDarkMode: false,
    },
  })
).toString("base64");

async function main() {
  assert.ok(
    fs.existsSync(path.join(assets, "index.html")),
    "Run npm run build-webview first"
  );
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const filename = path.join(
      assets,
      pathname === "/" ? "index.html" : decodeURIComponent(pathname)
    );
    if (!filename.startsWith(assets + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const extension = path.extname(filename);
      let data = fs.readFileSync(filename);
      response.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
        }[extension] || "application/octet-stream"
      );
      if (extension === ".html") {
        data = Buffer.from(
          data
            .toString()
            .replace("{{data-excalidraw-config}}", config)
            .replace("{{excalidraw-asset-path}}", "/")
        );
      }
      response.end(data);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    const executablePath =
      process.env.CHROME_PATH ||
      [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ].find((candidate) => fs.existsSync(candidate));
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1300, height: 900 },
    });
    let scene = {
      type: "excalidraw",
      version: 2,
      source: "smoke",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    let revision = 0;
    let holdChanges = false;
    const accepted = new Map();
    const messages = [];
    const saves = [];
    const errors = [];
    const send = (page, message) =>
      page.evaluate(
        (data) => window.dispatchEvent(new MessageEvent("message", { data })),
        message
      );
    await context.exposeBinding("hostMessage", async ({ page }, message) => {
      messages.push(message);
      if (message.type === "ready") {
        await send(page, {
          type: "init",
          scene,
          documentId: "smoke-document",
          revision,
          sequence: accepted.get(message.clientId) || 0,
          contentType: "application/json",
          content: [],
        });
      }
      if (message.type === "loaded" && accepted.size === 0)
        scene = message.scene;
      if (message.type === "change" && !holdChanges) {
        if (message.sequence > (accepted.get(message.clientId) || 0)) {
          scene = mergeSceneChange(scene, message.before, message.scene);
          revision++;
          accepted.set(message.clientId, message.sequence);
        }
        const update = {
          type: "scene",
          scene,
          documentId: "smoke-document",
          revision,
          clientId: message.clientId,
          sequence: accepted.get(message.clientId),
        };
        await Promise.all(
          context.pages().map((pane) => send(pane, update).catch(() => {}))
        );
      }
      if (message.type === "save") saves.push(structuredClone(scene));
      if (message.type === "error" || message.type === "serialization-error")
        errors.push(message.content || message.error);
    });
    await context.addInitScript(() => {
      window.acquireVsCodeApi = () => ({
        getState: () =>
          JSON.parse(sessionStorage.getItem("state") || "null") || undefined,
        setState: (state) =>
          sessionStorage.setItem("state", JSON.stringify(state)),
        postMessage: (message) => {
          void window.hostMessage(message);
        },
      });
    });
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (predicate, label) => {
      const deadline = Date.now() + 15000;
      while (!predicate() && Date.now() < deadline) await wait(25);
      assert.ok(predicate(), label);
    };
    const open = async () => {
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator(".excalidraw").waitFor();
      await wait(300);
      return page;
    };
    const rectangle = (page) =>
      page.locator("[data-testid=toolbar-rectangle]").locator("..").click();
    const draw = async (page, x, y) => {
      await rectangle(page);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 120, y + 90, { steps: 10 });
      await page.mouse.up();
    };
    const visible = () =>
      scene.elements.filter((element) => !element.isDeleted);

    const first = await open();
    assert.equal(revision, 0, "Opening alone must not mark the document dirty");
    await draw(first, 500, 300);
    await first.keyboard.press("Control+s");
    await until(() => saves.length === 1, "Ctrl+S reaches host");
    assert.equal(saves[0].elements.length, 1);
    assert.deepEqual(
      [saves[0].elements[0].width, saves[0].elements[0].height],
      [120, 90],
      "Immediate save includes the completed drag"
    );
    console.log("PASS clean startup and immediate save of 120 x 90 rectangle");

    const second = await open();
    const beforeOpen = revision;
    await wait(300);
    assert.equal(
      revision,
      beforeOpen,
      "Opening another pane must not echo an edit"
    );
    await draw(second, 750, 550);
    await until(
      () => visible().length === 2 && visible()[1].width === 120,
      "Second pane retains both rectangles"
    );
    let settled = revision;
    await wait(300);
    assert.equal(revision, settled, "Broadcasts settle without an echo loop");
    await first.locator("[data-testid=toolbar-hand]").locator("..").click();
    await first.mouse.move(400, 700);
    await first.mouse.down();
    await first.mouse.move(500, 750);
    await first.mouse.up();
    await wait(200);
    assert.equal(revision, settled, "Panning does not dirty the document");
    console.log("PASS split-pane drawing, no echo, and local panning");

    // A remote edit arriving during a local gesture must not replace the active
    // element object that Excalidraw's pointer handler is still mutating.
    await rectangle(first);
    await first.mouse.move(800, 300);
    await first.mouse.down();
    await first.mouse.move(860, 345, { steps: 5 });
    await draw(second, 900, 650);
    await first.mouse.move(920, 390, { steps: 5 });
    await first.mouse.up();
    await until(
      () =>
        visible().length === 4 &&
        visible().every(
          (element) => element.width === 120 && element.height === 90
        ),
      "Concurrent pane update preserves active drag geometry"
    );
    console.log("PASS remote update during active drag");

    await second.keyboard.press("Control+z");
    await until(
      () => visible().length === 3,
      "Local undo removes only that pane's latest rectangle"
    );
    assert.ok(
      visible().every(
        (element) => element.width === 120 && element.height === 90
      )
    );
    console.log("PASS local undo preserves the other pane's objects");

    holdChanges = true;
    await draw(first, 850, 500);
    const pending = await first.evaluate(
      () => JSON.parse(sessionStorage.getItem("state")).pending.length
    );
    assert.ok(
      pending > 0,
      "Unacknowledged edits are persisted before recreation"
    );
    holdChanges = false;
    await first.reload({ waitUntil: "domcontentloaded" });
    await first.locator(".excalidraw").waitFor();
    await until(
      () =>
        visible().length === 4 &&
        visible().every(
          (element) => element.width === 120 && element.height === 90
        ),
      "Pending drawing survives webview recreation"
    );
    console.log("PASS pending-edit recovery across webview recreation");

    await send(first, {
      type: "serialize",
      requestId: 44,
      scene,
      contentType: "image/svg+xml",
    });
    await until(
      () =>
        messages.some(
          (message) => message.type === "serialized" && message.requestId === 44
        ),
      "SVG export replies"
    );
    const svg = messages.find(
      (message) => message.type === "serialized" && message.requestId === 44
    );
    assert.ok(
      new TextDecoder().decode(new Uint8Array(svg.content)).includes("<svg")
    );
    await send(first, {
      type: "serialize",
      requestId: 45,
      scene,
      contentType: "image/png",
    });
    await until(
      () =>
        messages.some(
          (message) => message.type === "serialized" && message.requestId === 45
        ),
      "PNG export replies"
    );
    const png = messages.find(
      (message) => message.type === "serialized" && message.requestId === 45
    );
    assert.deepEqual(png.content.slice(0, 4), [137, 80, 78, 71]);
    settled = revision;
    await wait(300);
    assert.equal(revision, settled, "Export does not alter the scene");
    assert.deepEqual(errors, [], "No editor or bridge runtime errors");
    console.log(
      `PASS SVG/PNG export (${svg.content.length}/${png.content.length} bytes), ${revision} accepted changes, ${saves.length} immediate save`
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
