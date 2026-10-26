import type { EditorRecoveryState } from "./editor-recovery-state";
import { mergeSceneChange, sceneEqual } from "./scene";

/** Rebuild a host document without replaying changes it had already accepted. */
export function recoverEditorScene(states: EditorRecoveryState[]): Uint8Array {
  if (!states.length) {
    throw new Error("No canvas snapshots were received.");
  }
  const latest = states.reduce((a, b) => (a.revision >= b.revision ? a : b));
  if (
    states.some(
      (state) =>
        state.documentId !== latest.documentId || state.uri !== latest.uri
    )
  ) {
    throw new Error(
      "The retained canvases disagree about the document generation. Their originals have been left open."
    );
  }
  let scene = latest.scene;
  let dirty = latest.dirty;
  let revision = latest.revision;
  const sequences = new Map(latest.sequences);
  for (const state of states) {
    for (const change of state.pending) {
      if (change.sequence <= (sequences.get(state.clientId) || 0)) {
        continue;
      }
      const merged = mergeSceneChange(scene, change.before, change.scene);
      if (!sceneEqual(scene, merged)) {
        revision++;
        dirty = true;
      }
      scene = merged;
      sequences.set(state.clientId, change.sequence);
    }
  }
  return new TextEncoder().encode(
    JSON.stringify({
      type: "excalidraw-vscode-backup",
      version: 1,
      documentId: latest.documentId,
      revision,
      sequences: [...sequences],
      scene,
      diskBase: latest.diskBase,
      pendingLocalChanges: dirty,
    })
  );
}
