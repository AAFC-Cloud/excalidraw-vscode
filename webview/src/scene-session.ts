import { mergeSceneChange, sceneEqual } from "../../src/scene";
import type { SceneData } from "../../src/scene";

export interface SceneUpdate {
  scene: SceneData;
  documentId: string;
  revision: number;
  clientId?: string;
  sequence?: number;
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
    acceptedSequence: number
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
    this.authoritative = scene;
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

  /** Release accepted snapshots without replacing an in-progress canvas gesture. */
  acknowledge(message: SceneUpdate) {
    if (
      message.documentId !== this.state.documentId ||
      message.clientId !== this.state.clientId
    )
      return;
    this.state.pending = this.state.pending.filter(
      (change) => change.sequence > (message.sequence || 0)
    );
    this.persist(this.state);
  }
  receive(message: SceneUpdate) {
    if (message.documentId !== this.state.documentId) {
      return undefined;
    }
    this.acknowledge(message);

    if (message.revision >= this.revision) {
      this.authoritative = message.scene;
      this.revision = message.revision;
    }
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
