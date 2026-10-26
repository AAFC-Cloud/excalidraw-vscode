import { mergeSceneChange, sceneEqual } from "../../src/scene";
import type { SceneData } from "../../src/scene";
import type { EditorRecoveryState } from "../../src/editor-recovery-state";

export interface SceneUpdate {
  scene: SceneData;
  documentId: string;
  revision: number;
  clientId?: string;
  sequence?: number;
  diskBase?: SceneData;
  dirty?: boolean;
  sequences?: [string, number][];
}

export interface PendingSceneChange {
  sequence: number;
  before: SceneData;
  scene: SceneData;
}

export interface SceneSessionState {
  clientId: string;
  documentId?: string;
  sequence: number;
  pending: PendingSceneChange[];
}

/** Keeps unacknowledged edits across webview recreation and rebases split-pane edits. */
export class SceneSession {
  private state: SceneSessionState;
  private revision = -1;
  private authoritative?: SceneData;
  private diskBase?: SceneData;
  private dirty = false;
  private sequences: [string, number][] = [];
  public scene?: SceneData;

  constructor(
    state: SceneSessionState | undefined,
    private readonly persist: (state: SceneSessionState) => void,
    private readonly post: (message: unknown) => void
  ) {
    this.state = state || {
      clientId: crypto.randomUUID(),
      sequence: 0,
      pending: [],
    };
  }

  ready() {
    this.persist(this.state);
    this.post({ type: "ready", clientId: this.state.clientId });
  }

  initialize(
    scene: SceneData,
    documentId: string,
    revision: number,
    acceptedSequence: number,
    diskBase?: SceneData,
    dirty = false,
    sequences: [string, number][] = [],
    authoritativeScene = scene
  ) {
    if (this.state.documentId !== documentId) {
      this.state.pending = [];
      this.state.sequence = acceptedSequence;
    }
    this.state.documentId = documentId;
    this.state.sequence = Math.max(this.state.sequence, acceptedSequence);
    this.state.pending = this.state.pending.filter(
      (change) => change.sequence > acceptedSequence
    );
    this.revision = revision;
    this.authoritative = authoritativeScene;
    this.diskBase = diskBase;
    this.dirty = dirty;
    this.sequences = sequences;
    this.rebase();
    this.persist(this.state);
    // This initializes image documents without marking them dirty. JSON documents
    // already have an authoritative scene in the extension host.
    this.post({
      type: "loaded",
      clientId: this.state.clientId,
      documentId,
      scene,
    });
    for (const change of this.state.pending) {
      this.send(change);
    }
    return this.scene!;
  }

  /** Restoration may normalize old Excalidraw fields; opening alone is not an edit. */
  renderedInitialScene(scene: SceneData, loaded = false) {
    this.scene = scene;
    if (loaded) {
      this.post({
        type: "loaded",
        clientId: this.state.clientId,
        documentId: this.state.documentId,
        scene,
      });
    }
  }

  change(scene: SceneData) {
    if (!this.scene || sceneEqual(this.scene, scene)) {
      return;
    }
    const change = {
      sequence: ++this.state.sequence,
      before: this.scene,
      scene,
    };
    this.scene = scene;
    this.state.pending.push(change);
    // Persist before sending: moving a tab can destroy its webview before the
    // extension acknowledges this message.
    this.persist(this.state);
    this.send(change);
  }

  /** Keep the host snapshot current without rebasing an in-progress gesture. */
  acknowledge(message: SceneUpdate) {
    if (message.documentId !== this.state.documentId) return;
    if (message.revision >= this.revision) {
      this.authoritative = message.scene;
      this.revision = message.revision;
      this.diskBase = message.diskBase;
      this.dirty = message.dirty ?? this.dirty;
      this.sequences = message.sequences ?? this.sequences;
    }
    if (message.clientId === this.state.clientId) {
      this.state.pending = this.state.pending.filter(
        (change) => change.sequence > (message.sequence || 0)
      );
    }
    this.persist(this.state);
  }

  /** Retain the host baseline and pending edits separately for restart merging. */
  recovery(uri: string): EditorRecoveryState | undefined {
    if (!this.authoritative || !this.state.documentId) return undefined;
    return {
      uri,
      clientId: this.state.clientId,
      documentId: this.state.documentId,
      sequence: this.state.sequence,
      revision: this.revision,
      scene: this.authoritative,
      pending: this.state.pending,
      diskBase: this.diskBase,
      dirty: this.dirty,
      sequences: this.sequences,
    };
  }
  receive(message: SceneUpdate) {
    if (message.documentId !== this.state.documentId) {
      return undefined;
    }
    this.acknowledge(message);

    const previous = this.scene;
    this.rebase();
    this.persist(this.state);
    return previous && sceneEqual(previous, this.scene!)
      ? undefined
      : this.scene;
  }

  private rebase() {
    this.scene = this.state.pending.reduce(
      (scene, change) => mergeSceneChange(scene, change.before, change.scene),
      this.authoritative!
    );
  }

  private send(change: PendingSceneChange) {
    this.post({
      type: "change",
      clientId: this.state.clientId,
      documentId: this.state.documentId,
      ...change,
    });
  }
}
