import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { SceneData } from "./scene";
import { sceneEqual } from "./scene";
import type { SceneFile } from "./scene-file";
import { parseSceneFile } from "./scene-file-merge";

/**
 * Desktop file coordination. All cooperating writers acquire the sibling
 * .sync-lock with exclusive creation, reread, and atomically replace the scene.
 * Browser/remote filesystem providers do not expose these guarantees.
 */
export class LocalSceneFile implements SceneFile {
  private constructor(
    public readonly path: string,
    private allowInitialEmpty: boolean
  ) {}

  public static async open(filename: string): Promise<LocalSceneFile> {
    let canonical: string;
    try {
      canonical = await fs.promises.realpath(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      canonical = path.join(
        await fs.promises.realpath(path.dirname(filename)),
        path.basename(filename)
      );
    }
    let initiallyEmpty = false;
    try {
      initiallyEmpty = (await fs.promises.stat(canonical)).size === 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return new LocalSceneFile(canonical, initiallyEmpty);
  }

  async read(): Promise<SceneData> {
    // readFile owns one handle: rename publishes a different inode, while this
    // read finishes against its complete original snapshot.
    const deadline = Date.now() + 200;
    while (true) {
      try {
        const content = await fs.promises.readFile(this.path);
        if (!content.length && this.allowInitialEmpty) {
          // A newly created zero-byte drawing has always opened as a blank
          // canvas. After a real scene is observed/published, zero bytes mean
          // external truncation and must not replace the last accepted scene.
          return {
            type: "excalidraw",
            version: 2,
            elements: [],
            appState: {},
            files: {},
          };
        }
        const scene = parseSceneFile(content);
        this.allowInitialEmpty = false;
        return scene;
      } catch (error) {
        if (
          process.platform !== "win32" ||
          !["EPERM", "EACCES", "EBUSY"].includes(
            (error as NodeJS.ErrnoException).code || ""
          ) ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  async update(
    change: (disk: SceneData | undefined) => SceneData
  ): Promise<SceneData> {
    const lockPath = `${this.path}.sync-lock`;
    const deadline = Date.now() + 5000;
    let lock: fs.promises.FileHandle;
    while (true) {
      try {
        lock = await fs.promises.open(lockPath, "wx");
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code !== "EEXIST" &&
          !(
            process.platform === "win32" &&
            ["EPERM", "EACCES", "EBUSY"].includes(code || "")
          )
        ) {
          throw error;
        }
        if (Date.now() >= deadline) {
          if (code !== "EEXIST") {
            throw error;
          }
          throw new Error(
            `Drawing is locked: ${lockPath}. No file was overwritten. Retry after the other writer finishes; remove an abandoned lock only after verifying its owner has stopped.`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    let temporary: string | undefined;
    try {
      await lock.writeFile(
        JSON.stringify({
          version: 1,
          owner: `excalidraw-vscode:${process.pid}:${randomUUID()}`,
          pid: process.pid,
        })
      );
      await lock.sync();
      let disk: SceneData | undefined;
      try {
        disk = await this.read();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const next = change(disk);
      if (disk && sceneEqual(disk, next)) {
        return disk;
      }
      const mode =
        process.platform !== "win32" && disk
          ? (await fs.promises.stat(this.path)).mode & 0o7777
          : undefined;
      temporary = path.join(
        path.dirname(this.path),
        `.${path.basename(this.path)}.${randomUUID()}.tmp`
      );
      const handle = await fs.promises.open(temporary, "wx", mode);
      try {
        await handle.writeFile(JSON.stringify(next, null, 2));
        // Replacement creates a new inode. Retain the existing access mode,
        // restoring bits filtered by umask only after the complete write.
        // Supplying it at creation also keeps private drawings private in flight.
        if (mode !== undefined) {
          await handle.chmod(mode);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Same-directory rename replaces atomically on supported local filesystems.
      // Never unlink the destination as a fallback: failed replacement keeps it.
      const replaceDeadline = Date.now() + 2000;
      while (true) {
        try {
          await fs.promises.rename(temporary, this.path);
          break;
        } catch (error) {
          // Antivirus/indexer handles can briefly deny Windows replacement.
          // Retain the old target and our lock while retrying, never delete it.
          if (
            process.platform !== "win32" ||
            !["EPERM", "EACCES", "EBUSY"].includes(
              (error as NodeJS.ErrnoException).code || ""
            ) ||
            Date.now() >= replaceDeadline
          ) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      temporary = undefined;
      this.allowInitialEmpty = false;
      return next;
    } finally {
      if (temporary) {
        await fs.promises.unlink(temporary).catch(() => {});
      }
      await lock.close();
      await fs.promises.unlink(lockPath);
    }
  }

  watch(
    changed: () => void,
    failed: (error: Error) => void
  ): { dispose(): void } {
    let disposed = false;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const notify = () => {
      if (disposed || scheduled !== undefined) {
        return;
      }
      scheduled = setTimeout(() => {
        scheduled = undefined;
        if (!disposed) {
          changed();
        }
      }, 40);
    };
    // Watch the parent because atomic replacement changes the file's inode.
    // Polling also covers missed/coalesced filesystem notifications.
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(path.dirname(this.path), (_event, filename) => {
        if (!filename || filename.toString() === path.basename(this.path)) {
          notify();
        }
      });
      watcher.on("error", failed);
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));
    }
    const poll = setInterval(notify, 500);
    return {
      dispose: () => {
        disposed = true;
        watcher?.close();
        clearInterval(poll);
        if (scheduled !== undefined) {
          clearTimeout(scheduled);
        }
      },
    };
  }
}
