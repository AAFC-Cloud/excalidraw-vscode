import type { SceneData } from "./scene";

/** A local scene's atomic read/merge/publication boundary and change notifications. */
export interface SceneFile {
  readonly path: string;
  read(): Promise<SceneData>;
  update(
    change: (disk: SceneData | undefined) => SceneData
  ): Promise<SceneData>;
  watch(
    changed: () => void,
    failed: (error: Error) => void
  ): { dispose(): void };
}
