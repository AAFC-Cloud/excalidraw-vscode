const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function load(name, dependencies = {}) {
  const code = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, "..", name), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
      },
    }
  ).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", code)(
    module.exports,
    (id) => dependencies[id] || require(id),
    module
  );
  return module.exports;
}
const scenes = load("src/scene.ts");
const { recoverEditorScene } = load("src/recover-editor-scene.ts", {
  "./scene": scenes,
});
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
const uri = (value) => ({ toString: () => value });
const scene = (x = 0, color = "black") => ({
  type: "excalidraw",
  elements: [
    { id: "box", version: x + 1, versionNonce: 1, isDeleted: false, x, color },
  ],
  appState: {},
  files: {},
});
const state = (overrides = {}) => ({
  uri: "drawing.excalidraw",
  clientId: "first",
  documentId: "generation",
  revision: 1,
  sequence: 0,
  scene: scene(),
  diskBase: scene(),
  dirty: false,
  sequences: [],
  pending: [],
  ...overrides,
});

test("recovery retains accepted unsaved work and merges another pane's pending edit", () => {
  const accepted = state({
    revision: 4,
    scene: scene(12),
    dirty: true,
    sequences: [["first", 1]],
  });
  const pending = state({
    clientId: "second",
    pending: [{ sequence: 1, before: scene(), scene: scene(0, "red") }],
  });
  const restored = decode(recoverEditorScene([pending, accepted]));
  assert.equal(restored.scene.elements[0].x, 12);
  assert.equal(restored.scene.elements[0].color, "red");
  assert.equal(restored.pendingLocalChanges, true);
  assert.deepEqual(restored.diskBase, scene());
  assert.deepEqual(
    new Map(restored.sequences),
    new Map([
      ["first", 1],
      ["second", 1],
    ])
  );
});

test("a lost acknowledgement cannot replay an edit that a later accepted edit superseded", () => {
  const old = state({
    pending: [{ sequence: 1, before: scene(), scene: scene(10) }],
  });
  const latest = state({
    clientId: "second",
    revision: 3,
    scene: scene(20),
    dirty: true,
    sequences: [
      ["first", 1],
      ["second", 1],
    ],
  });
  assert.equal(
    decode(recoverEditorScene([old, latest])).scene.elements[0].x,
    20
  );
});

test("a clean saved snapshot stays clean after reconnect and keeps its latest disk baseline", () => {
  const latest = state({
    revision: 3,
    scene: scene(20),
    diskBase: scene(20),
    dirty: false,
    sequences: [["first", 1]],
  });
  const old = state({
    revision: 2,
    scene: scene(20),
    dirty: true,
    sequences: [["first", 1]],
  });
  const result = decode(recoverEditorScene([old, latest]));
  assert.equal(result.pendingLocalChanges, false);
  assert.deepEqual(result.diskBase, scene(20));
});

test("disagreeing generations are preserved for manual recovery instead of merged", () => {
  assert.throws(
    () => recoverEditorScene([state(), state({ documentId: "reverted" })]),
    /generation/
  );
  assert.throws(() => recoverEditorScene([]), /No canvas/);
});

function storage(initial = []) {
  let stored = structuredClone(initial);
  const files = new Map();
  const events = [];
  const context = {
    storageUri: uri("private"),
    workspaceState: {
      get: () => stored,
      update: async (_key, value) => {
        events.push("manifest");
        stored = value;
      },
    },
  };
  const vscode = {
    Uri: {
      parse: uri,
      joinPath: (base, ...parts) => uri([base.toString(), ...parts].join("/")),
    },
    workspace: {
      fs: {
        createDirectory: async () => {},
        writeFile: async (target, bytes) => {
          events.push("backup");
          files.set(target.toString(), bytes);
        },
        readFile: async (target) => {
          if (!files.has(target.toString())) throw Error("missing");
          return files.get(target.toString());
        },
        delete: async (target) => {
          events.push("delete");
          files.delete(target.toString());
        },
      },
    },
  };
  const { EditorRecovery } = load("src/editor-recovery.ts", {
    vscode,
    "./recover-editor-scene": { recoverEditorScene },
  });
  return {
    recovery: new EditorRecovery(context),
    context,
    vscode,
    files,
    events,
    stored: () => stored,
  };
}

test("all pane snapshots become durable before the recovery manifest is published", async () => {
  const fixture = storage();
  await fixture.recovery.capture(
    [state(), state({ uri: "other.excalidraw" })],
    () => [{ column: 2, active: true }]
  );
  assert.deepEqual(fixture.events, ["backup", "backup", "manifest"]);
  assert.equal(fixture.stored().length, 2);
  assert.deepEqual(fixture.stored()[0].views, [{ column: 2, active: true }]);
});

test("failed backup publication never replaces the prior recovery manifest", async () => {
  const original = [
    { uri: "old.excalidraw", backup: "old-private", views: [] },
  ];
  const fixture = storage(original);
  fixture.vscode.workspace.fs.writeFile = async () => {
    throw Error("disk full");
  };
  await assert.rejects(
    fixture.recovery.capture([state()], () => []),
    /disk full/
  );
  assert.deepEqual(fixture.stored(), original);
  assert.equal(fixture.events.includes("manifest"), false);
});

test("window reload chooses newer hot-exit work while older hot-exit backups cannot overwrite a handoff", async () => {
  const fixture = storage();
  const entry = { uri: "drawing.excalidraw", backup: "checkpoint", views: [] };
  const checkpoint = decode(
    recoverEditorScene([state({ revision: 2, scene: scene(10), dirty: true })])
  );
  fixture.files.set("checkpoint", encode(checkpoint));
  fixture.files.set(
    "hot-exit",
    encode({ ...checkpoint, revision: 3, scene: scene(20) })
  );
  assert.equal(
    decode(await fixture.recovery.read(entry, "hot-exit")).scene.elements[0].x,
    20
  );
  fixture.files.set(
    "hot-exit",
    encode({ ...checkpoint, revision: 1, scene: scene() })
  );
  assert.equal(
    decode(await fixture.recovery.read(entry, "hot-exit")).scene.elements[0].x,
    10
  );
});

test("consuming recovery removes only the private checkpoint after clearing the manifest", async () => {
  const entry = {
    uri: "drawing.excalidraw",
    backup: "private-checkpoint",
    views: [],
  };
  const fixture = storage([entry]);
  fixture.files.set("drawing.excalidraw", encode(scene()));
  fixture.files.set("private-checkpoint", encode(scene(10)));
  await fixture.recovery.consumed(fixture.recovery.pending[0]);
  assert.deepEqual(fixture.events, ["manifest", "delete"]);
  assert.equal(fixture.files.has("drawing.excalidraw"), true);
});

test("Save All removes concurrent recovery entries without retaining deleted checkpoints", async () => {
  const fixture = storage([
    { uri: "first.excalidraw", backup: "first-checkpoint", views: [] },
    { uri: "second.excalidraw", backup: "second-checkpoint", views: [] },
  ]);
  for (const entry of fixture.recovery.pending) {
    fixture.files.set(entry.backup, encode(scene(10)));
  }
  await Promise.all(
    [...fixture.recovery.pending].map((entry) =>
      fixture.recovery.consumed(entry)
    )
  );
  assert.deepEqual(fixture.recovery.pending, []);
  assert.equal(fixture.stored(), undefined);
  assert.equal(fixture.files.size, 0);
});

test("concurrent captures retain both drawings in the recovery manifest", async () => {
  const fixture = storage();
  await Promise.all([
    fixture.recovery.capture([state({ uri: "first.excalidraw" })], () => []),
    fixture.recovery.capture([state({ uri: "second.excalidraw" })], () => []),
  ]);
  assert.deepEqual(
    fixture
      .stored()
      .map((entry) => entry.uri)
      .sort(),
    ["first.excalidraw", "second.excalidraw"]
  );
  for (const entry of fixture.recovery.pending) {
    assert.equal(fixture.files.has(entry.backup), true);
  }
});

test("a capture arriving during checkpoint consumption survives the pending manifest write", async () => {
  const fixture = storage([
    { uri: "saved.excalidraw", backup: "saved-checkpoint", views: [] },
  ]);
  fixture.files.set("saved-checkpoint", encode(scene(10)));
  let releaseRemoval;
  const removalPending = new Promise((resolve) => {
    releaseRemoval = resolve;
  });
  let markRemovalStarted;
  const removalStarted = new Promise((resolve) => {
    markRemovalStarted = resolve;
  });
  const update = fixture.context.workspaceState.update;
  fixture.context.workspaceState.update = async (key, value) => {
    if (value === undefined) {
      markRemovalStarted();
      await removalPending;
    }
    await update(key, value);
  };
  const consumption = fixture.recovery.consumed(fixture.recovery.pending[0]);
  await removalStarted;
  const capture = fixture.recovery.capture(
    [state({ uri: "new.excalidraw" })],
    () => []
  );
  // Allow an unsynchronized capture to reach publication while removal waits.
  await new Promise((resolve) => setImmediate(resolve));
  releaseRemoval();
  await Promise.all([consumption, capture]);
  assert.deepEqual(
    fixture.stored().map((entry) => entry.uri),
    ["new.excalidraw"]
  );
  assert.deepEqual(fixture.recovery.pending, fixture.stored());
  assert.equal(fixture.files.has("saved-checkpoint"), false);
  assert.equal(fixture.files.has(fixture.stored()[0].backup), true);
});

test("failed journal publication does not prevent a later recovery attempt", async () => {
  const fixture = storage();
  const update = fixture.context.workspaceState.update;
  fixture.context.workspaceState.update = async () => {
    throw Error("storage unavailable");
  };
  await assert.rejects(
    fixture.recovery.capture([state()], () => []),
    /storage unavailable/
  );
  assert.deepEqual(fixture.recovery.pending, []);
  fixture.context.workspaceState.update = update;
  await fixture.recovery.capture([state()], () => []);
  assert.equal(fixture.recovery.pending.length, 1);
  assert.deepEqual(fixture.stored(), fixture.recovery.pending);
});
