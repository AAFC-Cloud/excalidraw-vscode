import type { SceneData } from "./scene";

/** A retained canvas's last host snapshot and edits still awaiting acknowledgement. */
export interface EditorRecoveryState {
  uri: string;
  clientId: string;
  documentId: string;
  sequence: number;
  revision: number;
  scene: SceneData;
  pending: { sequence: number; before: SceneData; scene: SceneData }[];
  diskBase?: SceneData;
  dirty: boolean;
  sequences: [string, number][];
}
