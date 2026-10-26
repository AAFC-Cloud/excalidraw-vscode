import * as vscode from "vscode";
import * as path from "path";
import { mergeSceneChange, sceneEqual, SceneData } from "./scene";

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
    fromBackup = false
  ) {
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
    }
  }

  private newDocumentId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  public sequenceFor(clientId: string) {
    return this.sequences.get(clientId) || 0;
  }

  /** Decoding the original image/JSON does not itself constitute a user edit. */
  public loaded(documentId: string, scene: SceneData) {
    if (documentId === this.documentId && this.sequences.size === 0) {
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
      const content = await vscode.workspace.fs.readFile(this.uri);
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
    await this.saveAs(this.uri);
  }

  async saveAs(destination: vscode.Uri) {
    await this.enqueueWrite(async () => {
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
          return;
        }
      }
    });
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
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
    this._onDidContentChange.dispose();
    this._onDidSceneChange.dispose();
    this.serializers.clear();
  }
}
