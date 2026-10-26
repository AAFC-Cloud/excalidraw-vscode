const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const filename = path.join(__dirname, "../src/scene.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
  },
}).outputText;
const sceneModule = { exports: {} };
new Function("exports", "require", "module", compiled)(
  sceneModule.exports,
  require,
  sceneModule
);
const { mergeSceneChange } = sceneModule.exports;

function element(id, properties = {}) {
  return {
    id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x: 0,
    ...properties,
  };
}
function scene(elements, appState = {}, files = {}) {
  return { elements, appState, files };
}
function edit(value, properties) {
  return {
    ...value,
    version: value.version + 1,
    versionNonce: 2,
    ...properties,
  };
}

test("stale split views retain independent element and property edits", () => {
  const before = scene([
    element("box", { strokeColor: "black" }),
    element("text"),
  ]);
  const current = scene([
    edit(before.elements[0], { x: 40 }),
    edit(before.elements[1], { text: "From the other pane" }),
  ]);
  const after = scene([
    edit(before.elements[0], { strokeColor: "red" }),
    before.elements[1],
  ]);
  const merged = mergeSceneChange(current, before, after);
  assert.equal(merged.elements[0].x, 40);
  assert.equal(merged.elements[0].strokeColor, "red");
  assert.equal(merged.elements[1].text, "From the other pane");
  assert.ok(merged.elements[0].version > current.elements[0].version);
  assert.equal(current.elements[0].strokeColor, "black");
});

test("stale edits do not resurrect deleted elements, but deliberate undo can", () => {
  const before = scene([element("box")]);
  const deleted = scene([edit(before.elements[0], { isDeleted: true })]);
  const moved = scene([edit(before.elements[0], { x: 50 })]);
  const merged = mergeSceneChange(deleted, before, moved);
  assert.equal(merged.elements[0].isDeleted, true);
  assert.equal(merged.elements[0].x, 50);
  const restored = scene([edit(deleted.elements[0], { isDeleted: false })]);
  const undone = mergeSceneChange(merged, deleted, restored);
  assert.equal(undone.elements[0].isDeleted, false);
  assert.equal(undone.elements[0].x, 50);
});

test("removed elements become tombstones without removing concurrent additions", () => {
  const before = scene([element("box")]);
  const current = scene([edit(before.elements[0], { x: 50 }), element("new")]);
  const merged = mergeSceneChange(current, before, scene([]));
  assert.equal(merged.elements[0].isDeleted, true);
  assert.equal(merged.elements[0].x, 50);
  assert.equal(merged.elements[1].id, "new");
  assert.equal(merged.elements[1].isDeleted, false);
});

test("fractional indices combine an insertion with another pane's reorder", () => {
  const before = scene([
    element("a", { index: "a0" }),
    element("b", { index: "a1" }),
    element("c", { index: "a2" }),
  ]);
  const current = scene([
    edit(before.elements[2], { index: "Zz" }),
    before.elements[0],
    before.elements[1],
  ]);
  const after = scene([
    before.elements[0],
    element("new", { index: "a0V" }),
    before.elements[1],
    before.elements[2],
  ]);
  const merged = mergeSceneChange(current, before, after);
  assert.deepEqual(
    merged.elements.map((item) => item.id),
    ["c", "a", "new", "b"]
  );
});

test("legacy explicit reorder preserves elements added by another pane", () => {
  const before = scene([element("a"), element("b"), element("c")]);
  const current = scene([
    before.elements[0],
    element("new"),
    before.elements[1],
    before.elements[2],
  ]);
  const after = scene([
    before.elements[2],
    before.elements[0],
    before.elements[1],
  ]);
  assert.deepEqual(
    mergeSceneChange(current, before, after).elements.map((item) => item.id),
    ["c", "new", "a", "b"]
  );
  const edited = scene([
    edit(before.elements[0], { x: 8 }),
    ...before.elements.slice(1),
  ]);
  assert.deepEqual(
    mergeSceneChange(after, before, edited).elements.map((item) => item.id),
    ["c", "a", "b"]
  );
});

test("background changes preserve concurrent settings and image assets", () => {
  const before = scene(
    [],
    { viewBackgroundColor: "white", gridSize: 20 },
    { old: { dataURL: "old" } }
  );
  const current = scene(
    [element("image", { fileId: "other" })],
    { viewBackgroundColor: "white", gridSize: 40 },
    { old: { dataURL: "old" }, other: { dataURL: "other" } }
  );
  const after = scene(
    [element("incoming", { fileId: "incoming-file" })],
    { viewBackgroundColor: "blue", gridSize: 20 },
    { "incoming-file": { dataURL: "incoming" } }
  );
  const merged = mergeSceneChange(current, before, after);
  assert.deepEqual(merged.appState, {
    viewBackgroundColor: "blue",
    gridSize: 40,
  });
  assert.deepEqual(Object.keys(merged.files).sort(), [
    "incoming-file",
    "old",
    "other",
  ]);
  assert.equal(merged.elements.length, 2);
});

test("replayed updates are idempotent and preserve unknown element fields", () => {
  const before = scene([element("box", { customData: { external: "value" } })]);
  const after = scene([edit(before.elements[0], { x: 50 })]);
  const merged = mergeSceneChange(before, before, after);
  assert.deepEqual(mergeSceneChange(merged, before, after), merged);
  assert.deepEqual(merged.elements[0].customData, { external: "value" });
});

test("a conflicting stale edit advances the authoritative element revision", () => {
  const before = scene([element("box")]);
  const current = scene([edit(before.elements[0], { x: 60, version: 8 })]);
  const after = scene([edit(before.elements[0], { x: 20 })]);
  const merged = mergeSceneChange(current, before, after);
  assert.equal(merged.elements[0].x, 20);
  assert.ok(merged.elements[0].version > current.elements[0].version);
  assert.deepEqual(mergeSceneChange(merged, before, after), merged);
});
