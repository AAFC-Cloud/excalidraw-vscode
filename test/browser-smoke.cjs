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
    uri: "file:///smoke.excalidraw",
    hostId: "smoke-host",
    sessionId: "smoke-workbench",
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
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
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
    let hostAlive = true;
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
      if (message.type === "heartbeat" && hostAlive)
        await send(page, { type: "heartbeat" });
      if (message.type === "ready") {
        await send(page, {
          type: "init",
          scene,
          documentId: "smoke-document",
          revision,
          sequence: accepted.get(message.clientId) || 0,
          contentType: "application/json",
          content: [],
          diskBase: scene,
          dirty: revision > 0,
          sequences: [...accepted],
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
          dirty: true,
          sequences: [...accepted],
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
      navigator.clipboard.writeText = async (text) => {
        window.copiedScene = text;
      };
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
    // Extension-host shutdown must commit the live text editor before its
    // acknowledgement, and keep serialization alive while input is suspended.
    await first.locator("[data-testid=toolbar-text]").locator("..").click();
    await first.mouse.click(600, 750);
    const textEditor = first.locator(".excalidraw-wysiwyg");
    await textEditor.waitFor();
    await textEditor.fill("Unsaved text survives extension restart");
    await send(first, { type: "suspend", requestId: 46 });
    await until(
      () =>
        messages.some(
          (message) => message.type === "suspended" && message.requestId === 46
        ),
      "Canvas acknowledges suspension"
    );
    assert.ok(
      visible().some(
        (element) =>
          element.originalText === "Unsaved text survives extension restart"
      ),
      "Suspension snapshot includes text still being edited"
    );
    assert.equal(
      await textEditor.count(),
      0,
      "Suspension commits the text editor"
    );
    await first.locator("#excalidraw-reconnecting").waitFor();
    settled = revision;
    await first.keyboard.press("Control+a");
    await first.keyboard.press("Delete");
    await first.mouse.move(600, 400);
    await first.mouse.down();
    await first.mouse.move(700, 500);
    await first.mouse.up();
    await wait(150);
    assert.equal(
      revision,
      settled,
      "Suspended editor rejects keyboard and pointer edits"
    );
    await send(first, {
      type: "serialize",
      requestId: 47,
      scene,
      contentType: "image/svg+xml",
    });
    await until(
      () =>
        messages.some(
          (message) => message.type === "serialized" && message.requestId === 47
        ),
      "Suspended canvas still serializes image documents"
    );
    await send(first, { type: "resume" });
    await first
      .locator("#excalidraw-reconnecting")
      .waitFor({ state: "detached" });
    await draw(first, 700, 400);
    await until(() => revision > settled, "Resumed canvas reports edits again");
    assert.deepEqual(errors, []);
    console.log(
      "PASS suspend preserves live text, blocks edits, serializes images, and resumes"
    );

    // A new host communicates through a same-origin editor relay, even when the
    // old canvas cannot deliver its final edits through the abandoned RPC link.
    holdChanges = true;
    await first.locator("[data-testid=toolbar-text]").locator("..").click();
    await first.mouse.click(500, 650);
    await first
      .locator(".excalidraw-wysiwyg")
      .fill("Pending text from detached canvas");
    const firstClient = await first.evaluate(
      () => JSON.parse(sessionStorage.getItem("state")).clientId
    );
    await first.evaluate(() => {
      window.recoveryReplies = [];
      window.recoveryProbe = new BroadcastChannel(
        "excalidraw-editor-recovery-v1"
      );
      window.recoveryProbe.onmessage = (event) =>
        window.recoveryReplies.push(event.data);
      window.recoveryProbe.postMessage({
        type: "capture",
        sessionId: "another-workbench",
        requestId: "other-window",
        hostId: "new-host",
        uris: ["file:///smoke.excalidraw"],
      });
      window.recoveryProbe.postMessage({
        type: "capture",
        sessionId: "smoke-workbench",
        requestId: "same-host",
        hostId: "smoke-host",
        uris: ["file:///smoke.excalidraw"],
      });
      window.recoveryProbe.postMessage({
        type: "capture",
        sessionId: "smoke-workbench",
        requestId: "other-file",
        hostId: "new-host",
        uris: ["file:///unrelated.excalidraw"],
      });
    });
    await wait(100);
    assert.equal(
      await first.evaluate(() => window.recoveryReplies.length),
      0,
      "Other workbench, same host and unrelated resource cannot capture this canvas"
    );
    await first.evaluate(() =>
      window.recoveryProbe.postMessage({
        type: "capture",
        sessionId: "smoke-workbench",
        requestId: "new-host-capture",
        hostId: "new-host",
        uris: ["file:///smoke.excalidraw"],
      })
    );
    await first.waitForFunction(
      (clientId) =>
        window.recoveryReplies.some(
          (message) =>
            message.type === "captured" && message.state.clientId === clientId
        ),
      firstClient
    );
    const recovered = await first.evaluate(
      (clientId) =>
        window.recoveryReplies.find(
          (message) => message.state?.clientId === clientId
        ).state,
      firstClient
    );
    assert.ok(
      recovered.pending
        .at(-1)
        .scene.elements.some(
          (element) =>
            element.originalText === "Pending text from detached canvas"
        ),
      "Relay captures the active text editor and unacknowledged edits"
    );
    assert.ok(
      !recovered.scene.elements.some(
        (element) =>
          element.originalText === "Pending text from detached canvas"
      ),
      "Relay keeps the accepted baseline separate from pending changes"
    );
    assert.ok(
      recovered.sequences.length > 0,
      "Relay includes acknowledgement positions from all panes"
    );
    await first.locator("#excalidraw-reconnecting").waitFor();
    await first.evaluate(() =>
      window.recoveryProbe.postMessage({
        type: "resume",
        requestId: "unrelated-capture",
      })
    );
    await wait(100);
    assert.equal(
      await first.locator("#excalidraw-reconnecting").count(),
      1,
      "Stale resume cannot unlock a captured drawing"
    );
    await first.evaluate(() =>
      window.recoveryProbe.postMessage({
        type: "resume",
        requestId: "new-host-capture",
      })
    );
    await first
      .locator("#excalidraw-reconnecting")
      .waitFor({ state: "detached" });
    holdChanges = false;
    hostAlive = false;
    await first.locator("#excalidraw-reconnecting").waitFor();
    const downloadPromise = first.waitForEvent("download");
    await first
      .getByRole("button", { name: "Download recovery drawing" })
      .click();
    const recoveryDownload = await downloadPromise;
    const downloadedScene = JSON.parse(
      fs.readFileSync(await recoveryDownload.path(), "utf8")
    );
    assert.ok(
      downloadedScene.elements.some(
        (element) =>
          element.originalText === "Pending text from detached canvas"
      ),
      "Recovery download includes edits unreachable through extension messaging"
    );
    assert.deepEqual(
      downloadedScene.files,
      recovered.pending.at(-1).scene.files
    );
    hostAlive = true;
    await first
      .locator("#excalidraw-reconnecting")
      .waitFor({ state: "detached" });
    await first.evaluate(() => window.recoveryProbe.close());
    console.log(
      "PASS relay preserves pending live text, scopes capture/resume, and heartbeat detects detachment"
    );

    // External writers provide semantic text and a width. The actual renderer
    // must wrap it on import and live replacement without generating dirty edits.
    const originalText =
      "Native wrapping keeps message words together and measures the actual font instead of counting characters.";
    const textElement = {
      id: "external-fixed-text",
      type: "text",
      version: 1,
      versionNonce: 1,
      x: 200,
      y: 200,
      width: 200,
      height: 20,
      angle: 0,
      strokeColor: "#1971c2",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      text: originalText,
      originalText,
      fontSize: 16,
      fontFamily: 3,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: false,
      lineHeight: 1.25,
    };
    const textScene = { ...scene, elements: [textElement] };
    const dirtyBefore = messages.filter(
      (message) => message.type === "change"
    ).length;
    await send(first, {
      type: "init",
      scene: textScene,
      documentId: "text-document",
      revision: 0,
      sequence: 0,
      contentType: "application/json",
      content: [],
    });
    await until(
      () =>
        messages.some(
          (message) =>
            message.type === "loaded" && message.documentId === "text-document"
        ),
      "Fixed-width initial scene loads"
    );
    const copiedText = async () => {
      await first
        .locator(".excalidraw")
        .click({ position: { x: 1000, y: 800 } });
      await first.keyboard.press("Escape");
      await first.keyboard.press("v");
      await first.keyboard.press("Control+a");
      await first.evaluate(() => {
        window.copiedScene = undefined;
      });
      await first.keyboard.press("Control+c");
      await first.waitForFunction(() => !!window.copiedScene);
      return first.evaluate(() =>
        JSON.parse(window.copiedScene).elements.find(
          (element) => element.id === "external-fixed-text"
        )
      );
    };
    const narrow = await copiedText();
    assert.equal(narrow.originalText, originalText);
    assert.ok(
      narrow.text.includes("\n"),
      "Native renderer inserts measured wraps"
    );
    assert.equal(narrow.width, 200);
    assert.ok(narrow.height > 20);
    const lineWidths = await first.evaluate((element) => {
      const context = document.createElement("canvas").getContext("2d");
      context.font = element.fontSize + "px Cascadia";
      return element.text
        .split("\n")
        .map((line) => context.measureText(line).width);
    }, narrow);
    assert.ok(
      lineWidths.every((width) => width <= narrow.width + 1),
      "Wrapping uses the loaded Cascadia font, not fallback metrics"
    );
    const wideScene = {
      ...textScene,
      elements: [{ ...narrow, width: 1200, version: 2, versionNonce: 2 }],
    };
    await send(first, {
      type: "scene",
      scene: wideScene,
      documentId: "text-document",
      revision: 1,
      clientId: "disk",
      sequence: 0,
    });
    await wait(300);
    const wide = await copiedText();
    assert.equal(
      wide.text,
      originalText,
      "Growing width reflows from originalText, removing old wraps"
    );
    assert.equal(wide.width, 1200);
    assert.equal(wide.height, 20);
    const nextText =
      originalText + " A fresh external change also wraps natively.";
    await send(first, {
      type: "scene",
      scene: {
        ...textScene,
        elements: [
          {
            ...textElement,
            text: nextText,
            originalText: nextText,
            version: 3,
            versionNonce: 3,
          },
        ],
      },
      documentId: "text-document",
      revision: 2,
      clientId: "disk",
      sequence: 0,
    });
    await wait(300);
    const changed = await copiedText();
    assert.equal(changed.originalText, nextText);
    assert.ok(changed.text.includes("\n"));
    assert.ok(changed.height > narrow.height);
    assert.equal(
      messages.filter((message) => message.type === "change").length,
      dirtyBefore,
      "Import and external wrapping do not dirty the document"
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS native initial/live text wrapping, width reflow, and no dirty echoes"
    );
    const rowGroups = ["oldest-row", "middle-row", "latest-row"];
    const frame = {
      ...textElement,
      id: "rows-frame",
      type: "frame",
      x: 100,
      y: 100,
      width: 800,
      height: narrow.height * 2 + 8 + 30 + 10,
      name: "Generic native rows",
      customData: {
        layout: {
          type: "rows",
          groups: rowGroups,
          top: 30,
          bottom: 10,
          gap: 8,
        },
      },
    };
    const rows = rowGroups.flatMap((group, index) => [
      {
        ...textElement,
        id: group + "-level",
        x: 110,
        y: 300 + index * 10,
        width: 60,
        groupIds: [group],
        frameId: frame.id,
        originalText: "Info",
        text: "Info",
      },
      {
        ...textElement,
        id: group + "-message",
        x: 190,
        y: 300 + index * 10,
        groupIds: [group],
        frameId: frame.id,
      },
    ]);
    const rowScene = { ...textScene, elements: [frame, ...rows] };
    await send(first, {
      type: "init",
      scene: rowScene,
      documentId: "row-document",
      revision: 0,
      sequence: 0,
      contentType: "application/json",
      content: [],
    });
    await until(
      () =>
        messages.some(
          (message) =>
            message.type === "loaded" && message.documentId === "row-document"
        ),
      "Rows initial scene loads"
    );
    await first.locator(".excalidraw").click({ position: { x: 1000, y: 800 } });
    await first.keyboard.press("Escape");
    await first.keyboard.press("v");
    await first.keyboard.press("Control+a");
    await first.evaluate(() => {
      window.copiedScene = undefined;
    });
    await first.keyboard.press("Control+c");
    await first.waitForFunction(() => !!window.copiedScene);
    const renderedRows = await first.evaluate(
      () => JSON.parse(window.copiedScene).elements
    );
    const row = (id) => renderedRows.find((element) => element.id === id);
    assert.equal(
      row("oldest-row-message").opacity,
      0,
      "Oldest row hidden when native heights do not fit"
    );
    assert.equal(row("middle-row-message").opacity, 100);
    assert.equal(row("latest-row-message").opacity, 100);
    assert.equal(
      row("middle-row-level").y,
      row("middle-row-message").y,
      "Columns align at native row origin"
    );
    assert.equal(
      row("latest-row-message").y,
      row("middle-row-message").y + row("middle-row-message").height + 8,
      "Rows use measured heights without overlap"
    );
    assert.equal(row("middle-row-message").y, 130);
    assert.equal(
      messages.filter((message) => message.type === "change").length,
      dirtyBefore,
      "Row layout stays clean"
    );
    await first.keyboard.press("Escape");
    await draw(first, 1100, 650);
    const editedRows = messages
      .filter(
        (message) =>
          message.type === "change" && message.documentId === "row-document"
      )
      .at(-1).scene.elements;
    assert.equal(
      editedRows.find((element) => element.id === "oldest-row-message").opacity,
      100,
      "Hidden presentation opacity is not persisted by unrelated edits"
    );
    assert.equal(
      editedRows.find((element) => element.id === "latest-row-message").y,
      320,
      "Calculated row positions are not persisted by unrelated edits"
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS native row layout, newest fitting entries, aligned columns, and presentation-only save state"
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
