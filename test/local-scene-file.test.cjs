const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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
const mergeModule = compile("../src/scene-file-merge.ts", {
  "./scene": sceneModule,
});
const { LocalSceneFile } = compile("../src/local-scene-file.ts", {
  "./scene": sceneModule,
  "./scene-file-merge": mergeModule,
});
const { mergeSceneFile } = mergeModule;
function scene() {
  return {
    type: "excalidraw",
    version: 2,
    elements: [
      {
        id: "box",
        type: "rectangle",
        x: 0,
        y: 0,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
      },
    ],
    appState: {},
    files: {},
    customTopLevel: { keep: true },
  };
}
async function fixture(t) {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "excalidraw-file-sync-")
  );
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "drawing.excalidraw");
  await fs.promises.writeFile(filename, JSON.stringify(scene()));
  return { file: await LocalSceneFile.open(filename), filename, directory };
}

test("a cooperating writer waits for the lock, rereads the new snapshot, and retains both writers' edits", async (t) => {
  const { file, filename, directory } = await fixture(t);
  const base = await file.read();
  const local = structuredClone(base);
  local.elements[0].x = 20;
  const lock = await fs.promises.open(filename + ".sync-lock", "wx");
  const saving = file.update((disk) => mergeSceneFile(base, local, disk));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const external = structuredClone(base);
  external.elements[0].y = 30;
  const temporary = path.join(directory, "external.tmp");
  await fs.promises.writeFile(temporary, JSON.stringify(external));
  await fs.promises.rename(temporary, filename);
  await lock.close();
  await fs.promises.unlink(filename + ".sync-lock");
  await saving;
  const saved = await file.read();
  assert.equal(saved.elements[0].x, 20);
  assert.equal(saved.elements[0].y, 30);
  assert.deepEqual(saved.customTopLevel, { keep: true });
  assert.deepEqual(await fs.promises.readdir(directory), [
    "drawing.excalidraw",
  ]);
});

test("a conflicting transaction does not write and releases the lock", async (t) => {
  const { file, filename, directory } = await fixture(t);
  const base = await file.read();
  const local = structuredClone(base);
  local.elements[0].x = 20;
  const remote = structuredClone(base);
  remote.elements[0].x = 40;
  const bytes = JSON.stringify(remote);
  await fs.promises.writeFile(filename, bytes);
  await assert.rejects(
    file.update((disk) => mergeSceneFile(base, local, disk)),
    /conflict/
  );
  assert.equal(await fs.promises.readFile(filename, "utf8"), bytes);
  assert.deepEqual(await fs.promises.readdir(directory), [
    "drawing.excalidraw",
  ]);
});

test("malformed content cannot be overwritten even when a local scene is available", async (t) => {
  const { file, filename, directory } = await fixture(t);
  await fs.promises.writeFile(filename, "{incomplete");
  await assert.rejects(
    file.update(() => scene()),
    SyntaxError
  );
  assert.equal(await fs.promises.readFile(filename, "utf8"), "{incomplete");
  assert.deepEqual(await fs.promises.readdir(directory), [
    "drawing.excalidraw",
  ]);
});

test("continuous readers observe only complete scenes during atomic publication", async (t) => {
  const { file } = await fixture(t);
  let reading = true;
  let snapshots = 0;
  const reader = (async () => {
    while (reading) {
      const disk = await file.read();
      assert.equal(disk.elements[0].x, disk.elements[0].y);
      snapshots++;
    }
  })();
  try {
    for (let index = 1; index <= 15; index++) {
      await file.update((disk) => ({
        ...disk,
        elements: [{ ...disk.elements[0], x: index, y: index }],
      }));
    }
  } finally {
    reading = false;
    await reader;
  }
  assert.ok(snapshots > 1);
});

test("watcher sees atomic replacements and stops after disposal", async (t) => {
  const { file } = await fixture(t);
  let notification;
  let fail;
  const noticed = new Promise((resolve, reject) => {
    notification = resolve;
    fail = reject;
  });
  const watcher = file.watch(notification, fail);
  t.after(() => watcher.dispose());
  await file.update((disk) => ({ ...disk, source: "external" }));
  await Promise.race([
    noticed,
    new Promise((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("No change notification")),
        2000
      );
      timeout.unref();
    }),
  ]);
  watcher.dispose();
  assert.equal((await file.read()).source, "external");
});

test("an external deletion is retained and conflicts with a local edit to that element", () => {
  const base = scene();
  const remote = { ...base, elements: [] };
  const unchanged = mergeSceneFile(base, base, remote);
  assert.equal(unchanged.elements[0].isDeleted, true);
  const local = structuredClone(base);
  local.elements[0].x = 20;
  assert.throws(
    () => mergeSceneFile(base, local, remote),
    /deletion versus edit/
  );
});

test("canonical path aliases coordinate on the same lock", async (t) => {
  const { file, filename } = await fixture(t);
  const aliased = await LocalSceneFile.open(
    path.join(path.dirname(filename), ".", path.basename(filename))
  );
  assert.equal(aliased.path, file.path);
});

test("an abandoned-looking lock is never stolen and a timed-out writer leaves disk untouched", async (t) => {
  const { file, filename } = await fixture(t);
  const lockPath = filename + ".sync-lock";
  const lock = JSON.stringify({ version: 1, owner: "unknown-owner", pid: 123 });
  await fs.promises.writeFile(lockPath, lock);
  const old = new Date(0);
  await fs.promises.utimes(lockPath, old, old);
  const before = await fs.promises.readFile(filename, "utf8");
  let invoked = false;
  await assert.rejects(
    file.update(() => {
      invoked = true;
      return scene();
    }),
    /Drawing is locked/
  );
  assert.equal(invoked, false);
  assert.equal(await fs.promises.readFile(filename, "utf8"), before);
  assert.equal(await fs.promises.readFile(lockPath, "utf8"), lock);
});

test("an initially empty drawing opens blank, but later truncation cannot erase an established scene", async (t) => {
  const { filename } = await fixture(t);
  await fs.promises.writeFile(filename, "");
  const file = await LocalSceneFile.open(filename);
  assert.deepEqual((await file.read()).elements, []);
  await file.update(() => scene());
  assert.equal((await file.read()).elements.length, 1);
  await fs.promises.writeFile(filename, "");
  await assert.rejects(file.read(), SyntaxError);
  await assert.rejects(
    file.update(() => scene()),
    SyntaxError
  );
  assert.equal(await fs.promises.readFile(filename, "utf8"), "");
});

test(
  "atomic replacement preserves existing POSIX permissions regardless of umask",
  { skip: process.platform === "win32" },
  async (t) => {
    const { file, filename } = await fixture(t);
    // Opposing permission modes catch both widening a private file and dropping
    // intended read permissions, without changing the process-wide umask.
    for (const mode of [0o600, 0o644]) {
      await fs.promises.chmod(filename, mode);
      await file.update((disk) => ({ ...disk, source: `mode-${mode}` }));
      assert.equal((await fs.promises.stat(filename)).mode & 0o7777, mode);
      assert.equal((await file.read()).source, `mode-${mode}`);
    }
  }
);
