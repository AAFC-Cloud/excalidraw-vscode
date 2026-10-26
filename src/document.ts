import * as vscode from "vscode";
import * as path from "path";
import { mergeSceneChange, sceneEqual, SceneData } from "./scene";
import type { SceneFile } from "./scene-file";
import { mergeSceneFile, parseSceneFile } from "./scene-file-merge";

/** Shared scene and persistence lifecycle for all views of one resource. */
export class ExcalidrawDocument implements vscode.CustomDocument {
  public readonly contentType: string;
  public scene?: SceneData;
  public revision = 0;
  // A revert starts a new generation: messages from the discarded canvas cannot
  // bring an old edit back after VS Code has cleared the document's dirty state.
  public documentId = this.newDocumentId();
  private readonly sequences = new Map<string, number>();
  private readonly serializers = new Set<
    (scene: SceneData, contentType: string) => Promise<Uint8Array>
  >();
  private writes: Promise<void> = Promise.resolve();
  private diskBase?: SceneData;
  private watcher?: { dispose(): void };
  private disposed = false;
  private pendingLocalChanges = false;

  /** Used to reinstate VS Code dirty state after an extension-host handoff. */
  public get hasUnsavedChanges() {
    return this.pendingLocalChanges;
  }

  public recoveryMetadata() {
    return {
      diskBase: this.diskBase,
      dirty: this.pendingLocalChanges,
      sequences: [...this.sequences],
    };
  }

  private readonly _onDidContentChange = new vscode.EventEmitter<void>();
  public readonly onDidContentChange = this._onDidContentChange.event;
  private readonly _onDidSceneChange = new vscode.EventEmitter<
    | {
        clientId: string;
        sequence: number;
      }
    | undefined
  >();
  public readonly onDidSceneChange = this._onDidSceneChange.event;
  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;

  constructor(
    public readonly uri: vscode.Uri,
    public content: Uint8Array,
    fromBackup = false,
    private readonly sceneFile?: SceneFile
  ) {
    this.pendingLocalChanges = fromBackup;
    switch (path.parse(uri.fsPath).ext) {
      case ".svg":
        this.contentType = "image/svg+xml";
        break;
      case ".png":
        this.contentType = "image/png";
        break;
      default:
        this.contentType = "application/json";
    }
    // Backups are private to the extension and retain protocol acknowledgements
    // as well as drawing data. They never add metadata to the user's scene.
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(content));
    } catch {
      // Untouched PNG/SVG documents retain their original bytes until decoded.
    }
    if (fromBackup && data?.type === "excalidraw-vscode-backup") {
      if (data.version !== 1) {
        throw new Error("Unsupported Excalidraw backup version.");
      }
      this.documentId = data.documentId;
      this.revision = data.revision;
      for (const [clientId, sequence] of data.sequences) {
        this.sequences.set(clientId, sequence);
      }
      this.scene = data.scene;
      this.diskBase = data.diskBase;
      this.pendingLocalChanges = data.pendingLocalChanges ?? true;
      this.content = data.scene
        ? new TextEncoder().encode(JSON.stringify(data.scene))
        : new Uint8Array(data.content);
    } else if (data?.type === "excalidraw" && Array.isArray(data.elements)) {
      // Also recognizes older JSON backups of image documents, so a save before
      // the webview is ready cannot accidentally write JSON into a PNG file.
      this.scene = {
        ...data,
        appState: data.appState || {},
        files: data.files || {},
      };
      if (!fromBackup) {
        this.diskBase = this.scene;
      }
    }
  }

  private newDocumentId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /** Follow atomic replacements without turning clean external updates into edits. */
  public watchFile(report: (error: Error) => void) {
    if (!this.sceneFile || this.watcher) {
      return;
    }
    let lastError: string | undefined;
    let refreshing = false;
    const refresh = () => {
      if (refreshing || this.disposed) {
        return;
      }
      refreshing = true;
      void this.refreshFromDisk().then(
        () => {
          lastError = undefined;
          refreshing = false;
        },
        (error: unknown) => {
          refreshing = false;
          const failure =
            error instanceof Error ? error : new Error(String(error));
          if (!this.disposed && lastError !== failure.message) {
            report(failure);
          }
          lastError = failure.message;
        }
      );
    };
    this.watcher = this.sceneFile.watch(refresh, report);
    refresh();
  }

  public async refreshFromDisk() {
    await this.enqueueWrite(async () => {
      if (!this.sceneFile || this.disposed) {
        return;
      }
      const disk = await this.sceneFile.read();
      if (this.disposed || sceneEqual(this.diskBase, disk)) {
        return;
      }
      const merged =
        this.scene && this.pendingLocalChanges
          ? mergeSceneFile(this.diskBase, this.scene, disk)
          : disk;
      this.acceptDisk(disk, merged);
    });
  }

  private acceptDisk(disk: SceneData, merged: SceneData) {
    this.diskBase = disk;
    this.content = new TextEncoder().encode(JSON.stringify(disk));
    if (!sceneEqual(this.scene, merged)) {
      this.scene = merged;
      this.revision++;
      // A scene message preserves the canvas's viewport and active gesture.
      // init/revert would recreate the entire renderer and drop those controls.
      this._onDidSceneChange.fire({ clientId: "disk", sequence: 0 });
    }
  }

  public sequenceFor(clientId: string) {
    return this.sequences.get(clientId) || 0;
  }

  /** Decoding the original image/JSON does not itself constitute a user edit. */
  public loaded(documentId: string, scene: SceneData) {
    if (
      documentId === this.documentId &&
      this.sequences.size === 0 &&
      this.revision === 0
    ) {
      this.scene = scene;
    }
  }

  public update(
    clientId: string,
    documentId: string,
    sequence: number,
    before: SceneData,
    scene: SceneData
  ) {
    if (documentId !== this.documentId) {
      return false;
    }
    if (sequence <= this.sequenceFor(clientId)) {
      return false;
    }
    this.sequences.set(clientId, sequence);
    const current = this.scene || before;
    const merged = mergeSceneChange(current, before, scene);
    this.scene = merged;
    if (!sceneEqual(current, merged)) {
      this.revision++;
      this.pendingLocalChanges = true;
      this._onDidContentChange.fire();
    }
    // Acknowledge even a no-op. A recreated webview may replay an edit whose
    // acknowledgement was lost when VS Code replaced its iframe.
    this._onDidSceneChange.fire({ clientId, sequence });
    return true;
  }

  public registerSerializer(
    serialize: (scene: SceneData, contentType: string) => Promise<Uint8Array>
  ): vscode.Disposable {
    this.serializers.add(serialize);
    return new vscode.Disposable(() => this.serializers.delete(serialize));
  }

  async revert() {
    // Order the read after outstanding saves, so a late image export cannot
    // overwrite the file after all canvases have reverted to an older version.
    await this.enqueueWrite(async () => {
      const disk = this.sceneFile ? await this.sceneFile.read() : undefined;
      const content = disk
        ? new TextEncoder().encode(JSON.stringify(disk))
        : await vscode.workspace.fs.readFile(this.uri);
      this.diskBase = disk;
      this.pendingLocalChanges = false;
      this.content = content;
      this.scene = undefined;
      this.revision = 0;
      this.documentId = this.newDocumentId();
      this.sequences.clear();
      this._onDidSceneChange.fire(undefined);
    });
  }

  async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    // Capture synchronously, including the generation and acknowledged edits.
    // Retained webview state can then replay only edits missing from this backup.
    // Image encoding is unnecessary while VS Code is shutting down the renderer.
    const content = new TextEncoder().encode(
      JSON.stringify({
        type: "excalidraw-vscode-backup",
        version: 1,
        documentId: this.documentId,
        revision: this.revision,
        sequences: [...this.sequences],
        scene: this.scene,
        diskBase: this.diskBase,
        pendingLocalChanges: this.pendingLocalChanges,
        content: this.scene ? undefined : Array.from(this.content),
      })
    );
    await this.enqueueWrite(() =>
      vscode.workspace.fs.writeFile(destination, content)
    );
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // VS Code may already have removed an obsolete backup.
        }
      },
    };
  }

  async save() {
    await this.saveAs(this.uri, this.sceneFile);
  }

  async saveAs(destination: vscode.Uri, sceneFile?: SceneFile) {
    await this.enqueueWrite(async () => {
      if (sceneFile) {
        this.scene ||= parseSceneFile(this.content);
        await this.saveLocalScene(sceneFile);
        if (destination.toString() === this.uri.toString()) {
          this.revision++;
          this._onDidSceneChange.fire({ clientId: "saved", sequence: 0 });
        }
        return;
      }
      // VS Code clears a content-change provider's dirty flag when save resolves.
      // An edit during asynchronous encoding/writing therefore has to be saved
      // too; otherwise a newer canvas would appear clean despite older disk data.
      while (true) {
        const revision = this.revision;
        const scene = this.scene;
        const content = scene ? await this.serialize(scene) : this.content;
        if (revision !== this.revision) {
          continue;
        }
        await vscode.workspace.fs.writeFile(destination, content);
        if (revision === this.revision) {
          if (destination.toString() === this.uri.toString()) {
            this.pendingLocalChanges = false;
            this.diskBase = scene;
            this.revision++;
            this._onDidSceneChange.fire({ clientId: "saved", sequence: 0 });
          }
          return;
        }
      }
    });
  }

  private async saveLocalScene(file: SceneFile) {
    const sameFile = file.path === this.sceneFile?.path;
    while (true) {
      let captured = this.scene!;
      let revision = this.revision;
      const saved = await file.update((disk) => {
        // Capture after acquiring the lock; edits can arrive while waiting.
        captured = this.scene!;
        revision = this.revision;
        if (!sameFile) {
          return captured;
        }
        // Renderer normalization is not a user edit. A clean external revision
        // wins over those defaults, including externally removed elements.
        if (
          !this.pendingLocalChanges &&
          this.diskBase &&
          disk &&
          !sceneEqual(this.diskBase, disk)
        ) {
          return disk;
        }
        return mergeSceneFile(this.diskBase, captured, disk);
      });
      if (sameFile) {
        const merged = mergeSceneFile(captured, this.scene!, saved);
        this.acceptDisk(saved, merged);
      }
      // acceptDisk can increment the scene revision for an external contribution.
      // Only edits arriving while writing require another publication.
      if (sceneEqual(this.scene, sameFile ? saved : captured)) {
        if (sameFile) {
          this.pendingLocalChanges = false;
        }
        return;
      }
      if (!sameFile && revision === this.revision) {
        return;
      }
    }
  }

  private async serialize(scene: SceneData): Promise<Uint8Array> {
    if (this.contentType === "application/json") {
      return new TextEncoder().encode(
        JSON.stringify(
          {
            ...scene,
            elements: scene.elements.filter((element) => !element.isDeleted),
          },
          null,
          2
        )
      );
    }
    // SVG/PNG encoding needs the Excalidraw renderer. It receives the captured
    // save snapshot, not the potentially newer scene currently on the canvas.
    let failure = new Error("Open an Excalidraw view to save this image.");
    for (const serialize of [...this.serializers].reverse()) {
      try {
        return await serialize(scene, this.contentType);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw failure;
  }

  private enqueueWrite(write: () => Thenable<void>): Promise<void> {
    const pending = this.writes.then(write);
    this.writes = pending.catch(() => {});
    return pending;
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
    this._onDidContentChange.dispose();
    this._onDidSceneChange.dispose();
    this.serializers.clear();
  }
}
