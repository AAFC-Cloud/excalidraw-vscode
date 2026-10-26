// Native VS Code regression for extension-host restart. Uses its own temporary
// workspace/profile/extensions and closes only the process it launched.
// Build first, then: node test/native-lifecycle-smoke.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const { chromium } = createRequire(require.resolve("@vscode/test-web"))(
  "playwright"
);
const root = path.resolve(__dirname, "..");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, duration = 20000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(100);
  }
  throw new Error(label);
}
async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function run() {
  const executable =
    process.env.VS_CODE_EXE ||
    path.join(
      process.env.LOCALAPPDATA,
      "Programs/Microsoft VS Code Insiders/Code - Insiders.exe"
    );
  assert.ok(
    fs.existsSync(executable),
    "Set VS_CODE_EXE to a desktop VS Code executable"
  );
  const output = path.join(root, "out", "native-lifecycle-" + Date.now());
  const workspace = path.join(output, "workspace");
  const profile = path.join(output, "profile");
  const extensions = path.join(output, "extensions");
  for (const folder of [workspace, path.join(profile, "User"), extensions])
    fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(profile, "User/settings.json"),
    JSON.stringify({
      "security.workspace.trust.enabled": false,
      "window.dialogStyle": "custom",
      "workbench.startupEditor": "none",
      "window.restoreWindows": "none",
      "files.autoSave": "off",
      "extensions.autoUpdate": false,
      "git.openRepositoryInParentFolders": "never",
      "typescript.experimental.useTsgo": false,
      "chat.disableAIFeatures": true,
      "workbench.editorAssociations": { "*.excalidraw": "editor.excalidraw" },
    })
  );
  const drawing = path.join(workspace, "restart.excalidraw");
  fs.writeFileSync(
    drawing,
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    })
  );
  const debuggingPort = await port();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    executable,
    [
      "--new-window",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--disable-gpu",
      "--user-data-dir=" + profile,
      "--extensions-dir=" + extensions,
      "--extensionDevelopmentPath=" + root,
      "--remote-debugging-port=" + debuggingPort,
      workspace,
    ],
    { env, windowsHide: true, stdio: "ignore" }
  );
  let browser;
  let page;
  const checks = [];
  try {
    await until(async () => {
      try {
        browser = await chromium.connectOverCDP(
          "http://127.0.0.1:" + debuggingPort
        );
        return true;
      } catch {
        return false;
      }
    }, "Native VS Code debugger did not start");
    page = browser.contexts()[0].pages()[0];
    const files = (directory) =>
      fs.existsSync(directory)
        ? fs
            .readdirSync(directory, { withFileTypes: true })
            .flatMap((entry) =>
              entry.isDirectory()
                ? files(path.join(directory, entry.name))
                : [path.join(directory, entry.name)]
            )
        : [];
    await until(
      () =>
        files(path.join(profile, "logs")).some(
          (file) =>
            file.endsWith("Excalidraw.log") &&
            fs
              .readFileSync(file, "utf8")
              .includes("desktop file synchronization enabled")
        ),
      "Test extension did not activate"
    );
    await page
      .getByText("restart.excalidraw", { exact: true })
      .first()
      .dblclick();
    async function frames() {
      const result = [];
      for (const frame of page.frames()) {
        try {
          if (await frame.locator(".excalidraw").count()) result.push(frame);
        } catch {}
      }
      return result;
    }
    async function waitFrames(count) {
      await until(
        async () => (await frames()).length === count,
        "Expected " + count + " live Excalidraw panes"
      );
      return frames();
    }
    async function command(label) {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Shift+p");
      const input = page.locator(".quick-input-widget input");
      await input.waitFor({ state: "visible" });
      await input.fill(">" + label);
      await page
        .locator(".quick-input-list .monaco-list-row")
        .first()
        .waitFor({ state: "visible" });
      await wait(250);
      await input.press("Enter");
    }
    async function draw(index, offset = 0) {
      const frame = (await frames())[index];
      await frame
        .locator("[data-testid=toolbar-rectangle]")
        .locator("..")
        .click();
      const box = await frame
        .locator("canvas.excalidraw__canvas.interactive")
        .boundingBox();
      assert.ok(box, "Canvas has measurable bounds");
      const x = box.x + box.width * 0.5,
        y = box.y + box.height * 0.45 + offset;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 100, y + 60, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.press("Escape");
    }
    const dirty = () => page.locator(".tab.dirty").count();
    const saved = () =>
      JSON.parse(fs.readFileSync(drawing, "utf8")).elements.filter(
        (e) => !e.isDeleted
      ).length;
    async function save(count) {
      // Reload replaces the focused iframe; focus a live editor before the shortcut.
      await page
        .locator(".tab")
        .filter({ hasText: "restart.excalidraw" })
        .last()
        .click();
      await page.keyboard.press("Control+s");
      await until(
        () => saved() === count,
        "Save did not publish " + count + " scene elements"
      );
      await until(
        async () => (await dirty()) === 0,
        "Saved drawing remains dirty"
      );
    }
    const sessionId = async (frame) =>
      frame.evaluate(
        () =>
          JSON.parse(
            atob(
              document
                .getElementById("root")
                .getAttribute("data-excalidraw-config")
            )
          ).sessionId
      );
    async function restart(expectedPanes, expectDirty) {
      const old = (await frames())[0];
      const previousSession = await sessionId(old);
      await command("Developer: Restart Extension Host");
      const confirmation = page.getByRole("button", {
        name: "Restart Anyway",
        exact: true,
      });
      await confirmation.waitFor({ state: "visible" });
      await confirmation.click();
      await until(() => old.isDetached(), "Restart left old canvas attached");
      await waitFrames(expectedPanes);
      assert.equal(
        await sessionId((await frames())[0]),
        previousSession,
        "Extension-host restart retains workbench sessionId"
      );
      await until(
        async () => Boolean(await dirty()) === expectDirty,
        "Restart restored incorrect dirty state"
      );
    }
    await waitFrames(1);
    assert.equal(await dirty(), 0);
    await draw(0);
    await until(
      async () => (await dirty()) > 0,
      "Drawing did not become dirty"
    );
    await save(1);
    checks.push("native drawing/save before restart");
    console.log("PASS " + checks.at(-1));
    await restart(1, false);
    assert.equal(saved(), 1);
    await draw(0, 100);
    await until(
      async () => (await dirty()) > 0,
      "Post-restart drawing did not become dirty"
    );
    await save(2);
    checks.push("clean restart reconnects and saves subsequent edits");
    console.log("PASS " + checks.at(-1));
    await command("View: Split Editor Right");
    await waitFrames(2);
    await draw(1, 180);
    await until(
      async () => (await dirty()) === 2,
      "Split panes do not share dirty state"
    );
    assert.equal(saved(), 2, "Unsaved drawing changed the disk");
    await restart(2, true);
    assert.equal(saved(), 2, "Restart implicitly saved unsaved content");
    await draw(1, 260);
    // A newer normal hot-exit backup must outrank the retained restart journal.
    const beforeReload = (await frames())[0];
    const beforeReloadSession = await sessionId(beforeReload);
    await command("Developer: Reload Window");
    await until(
      () => beforeReload.isDetached(),
      "Reload Window did not recreate renderer"
    );
    await waitFrames(2);
    assert.notEqual(
      await sessionId((await frames())[0]),
      beforeReloadSession,
      "Window reload creates a new workbench sessionId"
    );
    await until(
      async () => (await dirty()) === 2,
      "Window reload lost dirty state"
    );
    assert.equal(saved(), 2, "Window reload implicitly saved newer changes");
    await save(4);
    checks.push("window reload preserves edits newer than restart journal");
    console.log("PASS " + checks.at(-1));
    checks.push(
      "dirty split-pane restart preserves unsaved scene and original disk"
    );
    console.log("PASS " + checks.at(-1));
    const editingFrame = (await frames())[1];
    await editingFrame
      .locator("[data-testid=toolbar-text]")
      .locator("..")
      .click();
    const editBounds = await editingFrame
      .locator("canvas.excalidraw__canvas.interactive")
      .boundingBox();
    await page.mouse.click(
      editBounds.x + editBounds.width * 0.4,
      editBounds.y + editBounds.height * 0.7
    );
    const textEditor = editingFrame.locator(".excalidraw-wysiwyg");
    await textEditor.waitFor({ state: "visible" });
    await textEditor.fill("Latest unsaved native restart text");
    await restart(2, true);
    assert.equal(saved(), 4, "Restart implicitly saved active text");
    await save(5);
    assert.ok(
      JSON.parse(fs.readFileSync(drawing, "utf8")).elements.some(
        (e) => e.text === "Latest unsaved native restart text"
      ),
      "Latest text survived reconnect"
    );
    checks.push("active text survives host restart");
    console.log("PASS " + checks.at(-1));
    const restoredFrame = (await frames())[1];
    await restoredFrame.evaluate(() => {
      window.nativeSceneMessages = [];
      window.addEventListener("message", (event) => {
        if (event.data.type === "scene")
          window.nativeSceneMessages.push(event.data.scene);
      });
    });
    const external = JSON.parse(fs.readFileSync(drawing, "utf8"));
    external.elements.push({
      ...external.elements.find((e) => e.type === "rectangle"),
      id: "native-external-change",
      x: 200,
      y: 200,
      version: 1,
      versionNonce: 918273,
      updated: Date.now(),
    });
    fs.writeFileSync(drawing + ".temporary", JSON.stringify(external));
    fs.renameSync(drawing + ".temporary", drawing);
    await until(
      () =>
        restoredFrame.evaluate(() =>
          window.nativeSceneMessages.some((scene) =>
            scene.elements.some((e) => e.id === "native-external-change")
          )
        ),
      "Restored pane did not receive external file change"
    );
    assert.equal(await dirty(), 0, "External change dirtied restored drawing");
    checks.push("restored file watcher propagates atomic external update");
    console.log("PASS " + checks.at(-1));
    await page.screenshot({ path: path.join(output, "restored.png") });
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify({ passed: true, checks }, null, 2)
    );
    console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
  } catch (error) {
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify(
        { passed: false, error: String(error), stack: error.stack, checks },
        null,
        2
      )
    );
    if (page)
      await page
        .screenshot({ path: path.join(output, "failure.png") })
        .catch(() => {});
    console.error("Native lifecycle artifacts:", output);
    throw error;
  } finally {
    await browser?.close();
    child.kill();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
