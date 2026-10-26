const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const filename = path.join(__dirname, "../src/scene-renderer.ts");
const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
  },
}).outputText;
const compiled = { exports: {} };
new Function("exports", "require", "module", code)(
  compiled.exports,
  (name) => (name === "vscode" ? {} : require(name)),
  compiled
);
const { SceneRenderer } = compiled.exports;

function scene(x = 0) {
  return {
    elements: [{ id: "box", version: 1, versionNonce: 1, isDeleted: false, x }],
    appState: {},
    files: {},
  };
}
function fixture(t, post = async () => true) {
  const messages = [];
  const renderer = new SceneRenderer({
    postMessage: (message) => {
      messages.push(message);
      return post(message);
    },
  });
  t.after(() => renderer.dispose());
  renderer.loaded();
  return { renderer, messages };
}

test("an export survives iframe recreation and replays its captured snapshot after loading", async (t) => {
  const { renderer, messages } = fixture(t);
  const snapshot = scene(20);
  const exporting = renderer.serialize(snapshot, "image/png");
  assert.equal(messages.length, 1);
  renderer.restarted();
  assert.equal(messages.length, 1);
  renderer.loaded();
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], messages[0]);
  assert.equal(messages[1].scene, snapshot);
  renderer.finish(messages[1].requestId, [137, 80, 78, 71]);
  assert.deepEqual(await exporting, Uint8Array.of(137, 80, 78, 71));
});

test("closing the editor rejects all outstanding exports rather than leaving saves pending", async (t) => {
  const { renderer } = fixture(t);
  const first = assert.rejects(
    renderer.serialize(scene(10), "image/svg+xml"),
    /editor closed/
  );
  const second = assert.rejects(
    renderer.serialize(scene(20), "image/png"),
    /editor closed/
  );
  renderer.dispose();
  await Promise.all([first, second]);
});

test("an image serialization error reaches the caller and a later save can succeed", async (t) => {
  const { renderer, messages } = fixture(t);
  const failing = renderer.serialize(scene(), "image/png");
  const rejected = assert.rejects(failing, /image too large/);
  renderer.finish(messages[0].requestId, undefined, "image too large");
  await rejected;
  const retried = renderer.serialize(scene(), "image/png");
  renderer.finish(messages[1].requestId, [1, 2, 3]);
  assert.deepEqual(await retried, Uint8Array.of(1, 2, 3));
});

test("a closed webview that rejects message delivery fails the save promptly", async (t) => {
  const { renderer } = fixture(t, async () => false);
  await assert.rejects(renderer.serialize(scene(), "image/png"), /view closed/);
});

test("late duplicate export responses cannot settle a newer export", async (t) => {
  const { renderer, messages } = fixture(t);
  const first = renderer.serialize(scene(10), "image/png");
  renderer.finish(messages[0].requestId, [10]);
  await first;
  let completed = false;
  const second = renderer.serialize(scene(20), "image/png").then((content) => {
    completed = true;
    return content;
  });
  renderer.finish(messages[0].requestId, [99]);
  await Promise.resolve();
  assert.equal(completed, false);
  renderer.finish(messages[1].requestId, [20]);
  assert.deepEqual(await second, Uint8Array.of(20));
});

test("late message failure from the old iframe does not reject its replay in a new iframe", async (t) => {
  let closeOldIframe;
  const oldDelivery = new Promise((resolve) => {
    closeOldIframe = resolve;
  });
  let deliveries = 0;
  const { renderer, messages } = fixture(t, () =>
    ++deliveries === 1 ? oldDelivery : Promise.resolve(true)
  );
  const exporting = renderer.serialize(scene(20), "image/png");
  exporting.catch(() => {});
  renderer.restarted();
  renderer.loaded();
  closeOldIframe(false);
  await Promise.resolve();
  renderer.finish(messages[1].requestId, [20]);
  assert.deepEqual(await exporting, Uint8Array.of(20));
});
