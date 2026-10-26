const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function compile(relativePath, imports) {
  const filename = path.join(__dirname, relativePath);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  }).outputText;
  const compiled = { exports: {} };
  new Function("exports", "require", "module", code)(
    compiled.exports,
    (name) => imports[name] ?? require(name),
    compiled
  );
  return compiled.exports;
}
const sceneModule = compile("../src/scene.ts", {});
const fileMerge = compile("../src/scene-file-merge.ts", {
  "./scene": sceneModule,
});

class Disposable {
  constructor(dispose) {
    this.dispose = dispose;
  }
}
class EventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose() {
    this.listeners.clear();
  }
}
function uri(value) {
  return { fsPath: value, toString: () => value };
}
function bytes(value) {
  return new TextEncoder().encode(value);
}
function decode(value) {
  return JSON.parse(new TextDecoder().decode(value));
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function scene(x = 0) {
  return {
    type: "excalidraw",
    elements: [
      { id: "box", version: x + 1, versionNonce: x + 1, isDeleted: false, x },
    ],
    appState: { viewBackgroundColor: "white" },
    files: {},
  };
}
function fixture(
  extension = "excalidraw",
  originalContent = bytes("original"),
  sceneFile
) {
  const writes = [];
  const filesystem = {
    readFile: async () => bytes(JSON.stringify(scene())),
    writeFile: async (destination, content) => {
      writes.push({ destination, content });
    },
    delete: async () => {},
  };
  const vscode = { EventEmitter, Disposable, workspace: { fs: filesystem } };
  const { ExcalidrawDocument } = compile("../src/document.ts", {
    vscode,
    "./scene": sceneModule,
    "./scene-file-merge": fileMerge,
  });
  const document = new ExcalidrawDocument(
    uri(`drawing.${extension}`),
    originalContent,
    false,
    sceneFile
  );
  return {
    document,
    filesystem,
    writes,
    restore: (content) =>
      new ExcalidrawDocument(document.uri, content, true, sceneFile),
  };
}
function update(
  document,
  sequence,
  before,
  after,
  documentId = document.documentId
) {
  return document.update("pane", documentId, sequence, before, after);
}

test("an edit immediately reports dirty state and Ctrl+S writes the current JSON scene", async () => {
  const { document, writes } = fixture();
  let dirty = 0;
  document.onDidContentChange(() => dirty++);
  document.loaded(document.documentId, scene());
  assert.equal(dirty, 0);
  update(document, 1, scene(), scene(20));
  assert.equal(dirty, 1);
  assert.equal(document.revision, 1);
  assert.equal(document.scene.elements[0].x, 20);
  await document.save();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].destination, document.uri);
  assert.equal(decode(writes[0].content).elements[0].x, 20);
});

test("save awaits the filesystem write and reports failures without poisoning later saves", async () => {
  const { document, filesystem } = fixture();
  document.loaded(document.documentId, scene());
  const started = deferred();
  const writing = deferred();
  filesystem.writeFile = async () => {
    started.resolve();
    await writing.promise;
  };
  let completed = false;
  const saving = document.save().then(() => {
    completed = true;
  });
  await started.promise;
  assert.equal(completed, false);
  writing.resolve();
  await saving;
  assert.equal(completed, true);
  const error = new Error("disk full");
  filesystem.writeFile = async () => {
    throw error;
  };
  await assert.rejects(document.save(), (actual) => actual === error);
  let recovered = false;
  filesystem.writeFile = async () => {
    recovered = true;
  };
  await document.save();
  assert.equal(recovered, true);
});

test("image saves converge to edits made during export before reporting the document saved", async () => {
  const { document, writes } = fixture("excalidraw.svg");
  document.loaded(document.documentId, scene());
  const started = deferred();
  const firstExport = deferred();
  const serialized = [];
  document.registerSerializer(async (snapshot, contentType) => {
    assert.equal(contentType, "image/svg+xml");
    serialized.push(snapshot.elements[0].x);
    if (serialized.length === 1) {
      started.resolve();
      await firstExport.promise;
    }
    return bytes(JSON.stringify(snapshot));
  });
  update(document, 1, scene(), scene(10));
  const firstSave = document.save();
  await started.promise;
  update(document, 2, scene(10), scene(20));
  const secondSave = document.save();
  assert.deepEqual(serialized, [10]);
  assert.equal(document.scene.elements[0].x, 20);
  firstExport.resolve();
  await Promise.all([firstSave, secondSave]);
  assert.deepEqual(serialized, [10, 20, 20]);
  assert.deepEqual(
    writes.map((write) => decode(write.content).elements[0].x),
    [20, 20]
  );
  assert.equal(document.scene.elements[0].x, 20);
});

test("image backup preserves unsaved scene JSON and tombstones without an active renderer", async () => {
  const { document, filesystem, writes } = fixture("excalidraw.png");
  document.loaded(document.documentId, scene());
  update(document, 1, scene(), scene(30));
  const deleted = {
    ...scene(30),
    elements: [{ ...scene(30).elements[0], isDeleted: true }],
  };
  update(document, 2, scene(30), deleted);
  const destination = uri("backup-file");
  const backup = await document.backup(destination);
  assert.equal(backup.id, "backup-file");
  assert.equal(writes[0].destination, destination);
  assert.deepEqual(decode(writes[0].content).scene, document.scene);
  assert.equal(decode(writes[0].content).scene.elements[0].isDeleted, true);
  let deletedBackup;
  filesystem.delete = async (target) => {
    deletedBackup = target;
  };
  await backup.delete();
  assert.equal(deletedBackup, destination);
});

test("revert refreshes the document generation without dirtying it and rejects delayed old edits", async () => {
  const { document, filesystem } = fixture();
  const originalId = document.documentId;
  document.loaded(originalId, scene());
  let dirty = 0;
  const sceneChanges = [];
  document.onDidContentChange(() => dirty++);
  document.onDidSceneChange((change) => sceneChanges.push(change));
  update(document, 1, scene(), scene(10));
  const diskContent = bytes(JSON.stringify(scene(50)));
  filesystem.readFile = async () => diskContent;
  await document.revert();
  assert.notEqual(document.documentId, originalId);
  assert.equal(document.content, diskContent);
  assert.equal(document.scene, undefined);
  assert.equal(document.revision, 0);
  assert.equal(document.sequenceFor("pane"), 0);
  assert.equal(dirty, 1);
  assert.equal(sceneChanges.at(-1), undefined);
  assert.equal(update(document, 2, scene(10), scene(20), originalId), false);
  document.loaded(originalId, scene(20));
  assert.equal(document.scene, undefined);
  document.loaded(document.documentId, scene(50));
  assert.equal(update(document, 1, scene(50), scene(60)), true);
  assert.equal(document.scene.elements[0].x, 60);
  assert.equal(dirty, 2);
});

test("replayed sequences are idempotent and a new no-op sequence is acknowledged without dirtying", () => {
  const { document } = fixture();
  document.loaded(document.documentId, scene());
  let dirty = 0;
  const acknowledgements = [];
  document.onDidContentChange(() => dirty++);
  document.onDidSceneChange((value) => acknowledgements.push(value));
  assert.equal(update(document, 1, scene(), scene(10)), true);
  assert.equal(update(document, 1, scene(), scene(10)), false);
  assert.equal(document.revision, 1);
  assert.equal(dirty, 1);
  assert.equal(update(document, 2, scene(), scene(10)), true);
  assert.equal(document.revision, 1);
  assert.equal(dirty, 1);
  assert.equal(document.sequenceFor("pane"), 2);
  assert.deepEqual(acknowledgements, [
    { clientId: "pane", sequence: 1 },
    { clientId: "pane", sequence: 2 },
  ]);
});

test("an edit during the filesystem write is saved before the save operation resolves", async () => {
  const { document, filesystem, writes } = fixture();
  document.loaded(document.documentId, scene());
  const started = deferred();
  const firstWrite = deferred();
  filesystem.writeFile = async (destination, content) => {
    writes.push({ destination, content });
    if (writes.length === 1) {
      started.resolve();
      await firstWrite.promise;
    }
  };
  const saving = document.save();
  await started.promise;
  update(document, 1, scene(), scene(20));
  firstWrite.resolve();
  await saving;
  assert.deepEqual(
    writes.map((write) => decode(write.content).elements[0].x),
    [0, 20]
  );
  assert.equal(document.scene.elements[0].x, 20);
});

test("backup restoration retains generation and acknowledgements while accepting missing edits", async () => {
  const { document, writes, restore } = fixture();
  document.loaded(document.documentId, scene());
  update(document, 1, scene(), scene(10));
  await document.backup(uri("backup"));
  const restored = restore(writes[0].content);
  assert.equal(restored.documentId, document.documentId);
  assert.equal(restored.revision, document.revision);
  assert.equal(restored.sequenceFor("pane"), 1);
  assert.deepEqual(restored.scene, document.scene);
  let dirty = 0;
  restored.onDidContentChange(() => dirty++);
  assert.equal(update(restored, 1, scene(), scene(10)), false);
  assert.equal(dirty, 0);
  assert.equal(update(restored, 2, scene(10), scene(20)), true);
  assert.equal(restored.scene.elements[0].x, 20);
  assert.equal(dirty, 1);
  await restored.save();
  const saved = decode(writes[1].content);
  assert.equal(saved.type, "excalidraw");
  assert.equal(saved.documentId, undefined);
  assert.equal(saved.sequences, undefined);
});

test("restored image scenes cannot overwrite a PNG with backup JSON before a renderer is ready", async () => {
  const { document, writes, restore } = fixture("excalidraw.png");
  document.loaded(document.documentId, scene());
  update(document, 1, scene(), scene(20));
  await document.backup(uri("backup"));
  const restored = restore(writes[0].content);
  const legacy = restore(bytes(JSON.stringify(scene(20))));
  for (const candidate of [restored, legacy]) {
    assert.equal(candidate.scene.elements[0].x, 20);
    await assert.rejects(candidate.save(), /Open an Excalidraw view/);
    assert.equal(writes.length, 1);
  }
  const encodedImage = Uint8Array.of(137, 80, 78, 71);
  restored.registerSerializer(async (snapshot) => {
    assert.equal(snapshot.elements[0].x, 20);
    return encodedImage;
  });
  await restored.save();
  assert.deepEqual(writes[1].content, encodedImage);
});

test("revert waits for an in-flight save to converge before reading the file", async () => {
  const { document, filesystem } = fixture("excalidraw.svg");
  document.loaded(document.documentId, scene());
  const originalId = document.documentId;
  const started = deferred();
  const firstExport = deferred();
  let exports = 0;
  let reads = 0;
  let disk = bytes(JSON.stringify(scene()));
  document.registerSerializer(async (snapshot) => {
    if (++exports === 1) {
      started.resolve();
      await firstExport.promise;
    }
    return bytes(JSON.stringify(snapshot));
  });
  filesystem.writeFile = async (_destination, content) => {
    disk = content;
  };
  filesystem.readFile = async () => {
    reads++;
    return disk;
  };
  update(document, 1, scene(), scene(10));
  const saving = document.save();
  await started.promise;
  update(document, 2, scene(10), scene(20));
  const reverting = document.revert();
  assert.equal(reads, 0);
  firstExport.resolve();
  await Promise.all([saving, reverting]);
  assert.equal(reads, 1);
  assert.equal(decode(document.content).elements[0].x, 20);
  assert.equal(decode(disk).elements[0].x, 20);
  assert.equal(document.scene, undefined);
  assert.notEqual(document.documentId, originalId);
});

test("initial renderer normalization stays clean and a delayed pane load cannot replace an accepted edit", async () => {
  const original = scene();
  const { document, writes } = fixture(
    "excalidraw",
    bytes(JSON.stringify(original))
  );
  assert.deepEqual(document.scene, original);
  let dirty = 0;
  document.onDidContentChange(() => dirty++);
  const normalized = {
    ...original,
    elements: [{ ...original.elements[0], index: "a0", roundness: null }],
  };
  document.loaded(document.documentId, normalized);
  assert.deepEqual(document.scene, normalized);
  assert.equal(document.revision, 0);
  assert.equal(dirty, 0);
  const edited = {
    ...normalized,
    elements: [
      { ...normalized.elements[0], x: 40, version: 2, versionNonce: 2 },
    ],
  };
  update(document, 1, normalized, edited);
  document.loaded(document.documentId, normalized);
  assert.equal(document.scene.elements[0].x, 40);
  assert.equal(document.scene.elements[0].index, "a0");
  assert.equal(document.revision, 1);
  assert.equal(dirty, 1);
  await document.save();
  assert.equal(decode(writes[0].content).elements[0].x, 40);
});

function sharedFixture(initial = scene()) {
  let disk = structuredClone(initial);
  let writes = 0;
  const file = {
    path: "drawing.excalidraw",
    read: async () => structuredClone(disk),
    update: async (change) => {
      const next = change(structuredClone(disk));
      disk = structuredClone(next);
      writes++;
      return next;
    },
    watch: () => ({ dispose() {} }),
  };
  return {
    ...fixture("excalidraw", bytes(JSON.stringify(initial)), file),
    file,
    disk: () => disk,
    replace: (next) => {
      disk = structuredClone(next);
    },
    writeCount: () => writes,
  };
}

test("external changes refresh a clean document without dirtying and stale normalization cannot replace them", async () => {
  const { document, replace } = sharedFixture();
  let dirty = 0;
  const changes = [];
  document.onDidContentChange(() => dirty++);
  document.onDidSceneChange((value) => changes.push(value));
  const normalized = scene();
  normalized.elements[0].index = "a0";
  document.loaded(document.documentId, normalized);
  replace(scene(90));
  await document.refreshFromDisk();
  assert.equal(document.scene.elements[0].x, 90);
  assert.equal(dirty, 0);
  assert.deepEqual(changes, [{ clientId: "disk", sequence: 0 }]);
  document.loaded(document.documentId, normalized);
  assert.equal(document.scene.elements[0].x, 90);
});

test("external label changes merge with an unsaved position and are retained by save", async () => {
  const initial = scene();
  initial.elements[0].text = "before";
  const { document, replace, disk } = sharedFixture(initial);
  const moved = structuredClone(initial);
  moved.elements[0].x = 50;
  update(document, 1, initial, moved);
  const external = structuredClone(initial);
  external.elements[0].text = "after";
  external.elements[0].version = 3;
  replace(external);
  await document.refreshFromDisk();
  assert.equal(document.scene.elements[0].x, 50);
  assert.equal(document.scene.elements[0].text, "after");
  await document.save();
  assert.equal(disk().elements[0].x, 50);
  assert.equal(disk().elements[0].text, "after");
});

test("a conflicting external edit leaves both versions intact and blocks ordinary save", async () => {
  const { document, replace, disk, writeCount } = sharedFixture();
  update(document, 1, scene(), scene(40));
  replace(scene(70));
  await assert.rejects(
    document.refreshFromDisk(),
    /conflict.*elements\[box\]\.x/
  );
  await assert.rejects(document.save(), /Neither version was overwritten/);
  assert.equal(document.scene.elements[0].x, 40);
  assert.equal(disk().elements[0].x, 70);
  assert.equal(writeCount(), 0);
  await document.revert();
  document.loaded(document.documentId, scene(70));
  assert.equal(document.scene.elements[0].x, 70);
});

test("backup retains the disk baseline so recovered local edits merge with later external changes", async () => {
  const initial = scene();
  initial.elements[0].text = "before";
  const { document, writes, restore, replace, disk } = sharedFixture(initial);
  const moved = structuredClone(initial);
  moved.elements[0].x = 25;
  update(document, 1, initial, moved);
  await document.backup(uri("backup"));
  const recovered = restore(writes[0].content);
  const external = structuredClone(initial);
  external.elements[0].text = "after";
  replace(external);
  await recovered.refreshFromDisk();
  await recovered.save();
  assert.equal(disk().elements[0].x, 25);
  assert.equal(disk().elements[0].text, "after");
});

test("a clean externally removed element stays deleted despite renderer normalization", async () => {
  const { document, replace, disk } = sharedFixture();
  const normalized = scene();
  normalized.elements[0].index = "a0";
  document.loaded(document.documentId, normalized);
  replace({ ...scene(), elements: [] });
  await document.refreshFromDisk();
  await document.save();
  assert.equal(
    disk().elements.filter((element) => !element.isDeleted).length,
    0
  );
});

test("malformed or unavailable external content preserves the last accepted scene", async () => {
  const { document, file } = sharedFixture();
  update(document, 1, scene(), scene(40));
  file.read = async () => {
    throw new Error("Malformed file");
  };
  await assert.rejects(document.refreshFromDisk(), /Malformed file/);
  assert.equal(document.scene.elements[0].x, 40);
});

test("an edit arriving during atomic publication is saved before the document reports success", async () => {
  const { document, file, disk } = sharedFixture();
  const original = file.update;
  const started = deferred();
  const release = deferred();
  let count = 0;
  file.update = async (change) => {
    const saved = await original(change);
    if (++count === 1) {
      started.resolve();
      await release.promise;
    }
    return saved;
  };
  const saving = document.save();
  await started.promise;
  update(document, 1, scene(), scene(80));
  release.resolve();
  await saving;
  assert.equal(count, 2);
  assert.equal(disk().elements[0].x, 80);
});

test("a same-field edit arriving while the externally changed version is being saved reports a conflict", async () => {
  const { document, file, replace, disk } = sharedFixture();
  replace(scene(70));
  const original = file.update;
  const started = deferred();
  const release = deferred();
  file.update = async (change) => {
    const saved = await original(change);
    started.resolve();
    await release.promise;
    return saved;
  };
  const saving = document.save();
  await started.promise;
  update(document, 1, scene(), scene(80));
  release.resolve();
  await assert.rejects(saving, /conflict/);
  assert.equal(document.scene.elements[0].x, 80);
  assert.equal(disk().elements[0].x, 70);
});

test("legacy backup without a disk baseline preserves recovered edits and requires explicit recovery", async () => {
  const { restore, disk } = sharedFixture();
  const recovered = restore(bytes(JSON.stringify(scene(75))));
  await assert.rejects(recovered.refreshFromDisk(), /no disk baseline/);
  await assert.rejects(recovered.save(), /no disk baseline/);
  assert.equal(recovered.scene.elements[0].x, 75);
  assert.equal(disk().elements[0].x, 0);
});
