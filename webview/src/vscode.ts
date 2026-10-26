import {
  serializeAsJSON,
  exportToSvg,
  exportToBlob,
} from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { SceneData } from "../../src/scene";
import type { SceneSessionState } from "./scene-session";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): SceneSessionState | undefined;
  setState(state: SceneSessionState): void;
};
export const vscode = acquireVsCodeApi();

/** Only persisted scene properties participate in dirty tracking. */
export function sceneFromEditor(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  previous?: SceneData
): SceneData {
  const serialized = JSON.parse(
    serializeAsJSON(elements, appState, files, "local")
  );
  return {
    ...previous,
    ...serialized,
    source: previous?.source || serialized.source,
    // Tombstones are needed to merge a deletion made in another split pane.
    elements: JSON.parse(JSON.stringify(elements)),
  };
}

/** Image encoding happens at save time, using the host's exact scene snapshot. */
export async function serializeScene(
  scene: SceneData,
  contentType: string,
  imageParams: Partial<AppState>
): Promise<number[]> {
  const elements = scene.elements as unknown as ExcalidrawElement[];
  const appState = {
    ...scene.appState,
    ...imageParams,
    exportEmbedScene: true,
  } as Partial<AppState>;
  const files = scene.files as BinaryFiles;
  const nonDeletedElements = elements.filter((element) => !element.isDeleted);
  if (contentType === "image/svg+xml") {
    const svg = await exportToSvg({
      elements: nonDeletedElements,
      appState,
      files,
    });
    return Array.from(new TextEncoder().encode(svg.outerHTML));
  }
  if (contentType === "image/png") {
    const blob = await exportToBlob({
      elements: nonDeletedElements,
      appState,
      files,
      getDimensions(width: number, height: number) {
        const scale = appState.exportScale || 2;
        return { width: width * scale, height: height * scale, scale };
      },
    });
    if (!blob) {
      throw new Error("Failed to export scene as PNG");
    }
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }
  if (contentType === "application/json") {
    return Array.from(
      new TextEncoder().encode(
        serializeAsJSON(elements, appState, files, "local")
      )
    );
  }
  throw new Error(`Unsupported content type: ${contentType}`);
}
