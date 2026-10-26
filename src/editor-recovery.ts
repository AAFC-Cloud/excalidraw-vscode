import * as vscode from "vscode";
import type { EditorRecoveryState } from "./editor-recovery-state";
import { recoverEditorScene } from "./recover-editor-scene";

/** An extension-private handoff; the user's drawing is never saved implicitly. */
export interface RecoveredEditor {
  uri: string;
  backup: string;
  views: { column?: vscode.ViewColumn; active: boolean }[];
}

/** Commits restart backups before any editor is detached from its provider. */
export class EditorRecovery {
  private readonly key = "excalidraw.editorHandoff.v1";
  public readonly pending: RecoveredEditor[];
  private mutations: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.pending = context.workspaceState.get<RecoveredEditor[]>(this.key, []);
  }

  find(uri: vscode.Uri) {
    return this.pending.find((entry) => entry.uri === uri.toString());
  }

  /** A normal window reload may have a newer hot-exit backup than our retained
   * restart checkpoint. Never restore the older private copy over those edits.
   */
  async read(entry: RecoveredEditor, backupId?: string): Promise<Uint8Array> {
    const checkpoint = await vscode.workspace.fs.readFile(
      vscode.Uri.parse(entry.backup)
    );
    if (!backupId) {
      return checkpoint;
    }
    const backup = await vscode.workspace.fs.readFile(
      vscode.Uri.parse(backupId)
    );
    const saved = JSON.parse(new TextDecoder().decode(checkpoint));
    let normal;
    try {
      normal = JSON.parse(new TextDecoder().decode(backup));
    } catch {
      return checkpoint;
    }
    if (
      normal?.type === "excalidraw-vscode-backup" &&
      (normal.documentId !== saved.documentId ||
        normal.revision >= saved.revision)
    ) {
      return backup;
    }
    return checkpoint;
  }

  async capture(
    snapshots: EditorRecoveryState[],
    views: (uri: string) => RecoveredEditor["views"]
  ) {
    return this.enqueueMutation(async () => {
      const directory = vscode.Uri.joinPath(
        this.context.storageUri || this.context.globalStorageUri,
        "editor-handoff",
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      await vscode.workspace.fs.createDirectory(directory);
      const entries: RecoveredEditor[] = [];
      for (const uri of new Set(snapshots.map((state) => state.uri))) {
        const backup = vscode.Uri.joinPath(
          directory,
          `${entries.length}.backup`
        );
        await vscode.workspace.fs.writeFile(
          backup,
          recoverEditorScene(snapshots.filter((state) => state.uri === uri))
        );
        entries.push({
          uri,
          backup: backup.toString(),
          views: views(uri),
        });
      }
      // Publish last. A failed backup never authorizes closing a tab.
      // Keep failed restores from a previous activation available for another try.
      const retained = this.pending.filter(
        (old) => !entries.some((entry) => entry.uri === old.uri)
      );
      const next = [...retained, ...entries];
      await this.context.workspaceState.update(this.key, next);
      this.pending.splice(0, this.pending.length, ...next);
    });
  }

  async consumed(entry: RecoveredEditor) {
    return this.enqueueMutation(async () => {
      const remaining = this.pending.filter((candidate) => candidate !== entry);
      await this.context.workspaceState.update(
        this.key,
        remaining.length ? remaining : undefined
      );
      this.pending.splice(0, this.pending.length, ...remaining);
      // Delete only our private snapshot, never the drawing or a VS Code backup.
      try {
        await vscode.workspace.fs.delete(vscode.Uri.parse(entry.backup));
      } catch {
        // An orphaned private backup is harmless; do not fail a recovered editor.
      }
    });
  }

  /** Save All may finish several drawings together. Read, publish, and replace
   * the manifest as one ordered operation so a stale removal cannot restore an
   * entry whose checkpoint another completed operation has already deleted.
   */
  private enqueueMutation(mutate: () => Promise<void>): Promise<void> {
    const pending = this.mutations.then(mutate);
    this.mutations = pending.catch(() => {});
    return pending;
  }
}
