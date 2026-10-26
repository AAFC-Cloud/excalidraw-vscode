const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function load(filename, dependencies = {}) {
  const compiled = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, filename), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
      },
    }
  ).outputText;
  const loaded = { exports: {} };
  new Function("exports", "require", "module", compiled)(
    loaded.exports,
    (name) => dependencies[name] || require(name),
    loaded
  );
  return loaded.exports;
}
const scenes = load("../src/scene.ts");
const { SceneSession } = load("../webview/src/scene-session.ts", {
  "../../src/scene": scenes,
});

function scene(x = 0, color = "black") {
  return {
    elements: [
      { id: "box", version: 1, versionNonce: 1, isDeleted: false, x, color },
    ],
    appState: { viewBackgroundColor: "white" },
    files: {},
  };
}
function session(state = { clientId: "pane", sequence: 0, pending: [] }) {
  const messages = [];
  let persisted;
  return {
    controller: new SceneSession(
      state,
      (next) => {
        persisted = structuredClone(next);
      },
      (message) => messages.push(structuredClone(message))
    ),
    messages,
    state: () => persisted,
  };
}

test("edits are posted and retained immediately, before an acknowledgement", () => {
  const pane = session();
  pane.controller.initialize(scene(), "document", 0, 0);
  pane.controller.change(scene(100));
  assert.equal(pane.messages.at(-1).type, "change");
  assert.equal(pane.messages.at(-1).scene.elements[0].x, 100);
  assert.equal(pane.state().pending.length, 1);
});

test("recreated webview replays only edits the host has not acknowledged", () => {
  const old = session();
  old.controller.initialize(scene(), "document", 0, 0);
  old.controller.change(scene(100));
  old.controller.change(scene(200));
  const moved = session(old.state());
  const restored = moved.controller.initialize(scene(100), "document", 1, 1);
  assert.equal(restored.elements[0].x, 200);
  const edits = moved.messages.filter((message) => message.type === "change");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].sequence, 2);
});

test("incoming pane changes preserve edits still waiting for acknowledgement", () => {
  const pane = session();
  pane.controller.initialize(scene(), "document", 0, 0);
  pane.controller.change(scene(100));
  const rebased = pane.controller.receive({
    scene: scene(0, "red"),
    documentId: "document",
    revision: 1,
    clientId: "another-pane",
    sequence: 1,
  });
  assert.equal(rebased.elements[0].x, 100);
  assert.equal(rebased.elements[0].color, "red");
  assert.equal(pane.state().pending.length, 1);
});

test("acknowledging an earlier edit does not rewind a later edit", () => {
  const pane = session();
  pane.controller.initialize(scene(), "document", 0, 0);
  pane.controller.change(scene(100));
  pane.controller.change(scene(200));
  pane.controller.receive({
    scene: scene(100),
    documentId: "document",
    revision: 1,
    clientId: "pane",
    sequence: 1,
  });
  assert.equal(pane.controller.scene.elements[0].x, 200);
  assert.equal(pane.state().pending.length, 1);
});

test("revert discards old pending edits and rejects acknowledgements from that generation", () => {
  const pane = session();
  pane.controller.initialize(scene(), "document", 0, 0);
  pane.controller.change(scene(100));
  pane.messages.length = 0;
  pane.controller.initialize(scene(), "reverted", 0, 0);
  assert.equal(pane.state().pending.length, 0);
  assert.equal(
    pane.messages.some((message) => message.type === "change"),
    false
  );
  assert.equal(
    pane.controller.receive({
      scene: scene(100),
      documentId: "document",
      revision: 1,
      clientId: "pane",
      sequence: 1,
    }),
    undefined
  );
  assert.equal(pane.controller.scene.elements[0].x, 0);
});

test("unchanged scene and opening normalization do not mark the document dirty", () => {
  const pane = session();
  pane.controller.initialize(scene(), "document", 0, 0);
  const normalized = scene();
  normalized.elements[0].version = 2;
  pane.controller.renderedInitialScene(normalized);
  pane.controller.change(structuredClone(normalized));
  assert.equal(
    pane.messages.some((message) => message.type === "change"),
    false
  );
});

test("gesture acknowledgements release snapshots without rebasing the active scene", () => {
  const pane = session();
  pane.controller.initialize(scene(), "document", 0, 0);
  pane.controller.change(scene(100));
  const acknowledgement = {
    scene: scene(100),
    documentId: "document",
    revision: 1,
    clientId: "pane",
    sequence: 1,
  };
  pane.controller.acknowledge(acknowledgement);
  assert.equal(pane.state().pending.length, 0);
  assert.equal(pane.controller.scene.elements[0].x, 100);
  pane.controller.change(scene(200));
  pane.controller.receive(acknowledgement);
  assert.equal(pane.controller.scene.elements[0].x, 200);
  assert.equal(pane.state().pending.length, 1);
});

test("recovery retains the latest host baseline while a gesture defers rendering", () => {
  const pane = session();
  const disk = scene();
  pane.controller.initialize(disk, "document", 0, 0, disk, false, []);
  pane.controller.change(scene(100));
  const host = scene(0, "red");
  pane.controller.acknowledge({
    scene: host,
    documentId: "document",
    revision: 1,
    clientId: "another-pane",
    sequence: 2,
    diskBase: disk,
    dirty: true,
    sequences: [["another-pane", 2]],
  });
  const recovery = pane.controller.recovery("file:///drawing.excalidraw");
  assert.equal(
    pane.controller.scene.elements[0].color,
    "black",
    "Active gesture was not rebased"
  );
  assert.deepEqual(
    recovery.scene,
    host,
    "Recovery uses host state before pending edits"
  );
  assert.deepEqual(
    recovery.pending.map((edit) => edit.sequence),
    [1]
  );
  assert.deepEqual(recovery.sequences, [["another-pane", 2]]);
  assert.equal(recovery.dirty, true);
  assert.deepEqual(recovery.diskBase, disk);
  assert.equal(recovery.revision, 1);
});

test("recovery captures acknowledged edits and save metadata without replaying them", () => {
  const pane = session();
  pane.controller.initialize(scene(), "document", 0, 0, scene(), false);
  pane.controller.change(scene(100));
  pane.controller.acknowledge({
    scene: scene(100),
    documentId: "document",
    revision: 1,
    clientId: "pane",
    sequence: 1,
    diskBase: scene(),
    dirty: true,
    sequences: [["pane", 1]],
  });
  pane.controller.acknowledge({
    scene: scene(100),
    documentId: "document",
    revision: 1,
    clientId: "disk",
    sequence: 0,
    diskBase: scene(100),
    dirty: false,
    sequences: [["pane", 1]],
  });
  pane.controller.acknowledge({
    scene: scene(),
    documentId: "document",
    revision: 0,
    clientId: "another-pane",
    sequence: 0,
    diskBase: scene(),
    dirty: true,
    sequences: [],
  });
  const recovery = pane.controller.recovery("file:///drawing.excalidraw");
  assert.equal(recovery.pending.length, 0);
  assert.equal(recovery.scene.elements[0].x, 100);
  assert.equal(recovery.diskBase.elements[0].x, 100);
  assert.equal(recovery.dirty, false);
  assert.deepEqual(recovery.sequences, [["pane", 1]]);
});
