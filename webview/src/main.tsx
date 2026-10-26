import {
  CaptureUpdateAction,
  loadFromBlob,
  loadLibraryFromBlob,
} from "@excalidraw/excalidraw";
import ReactDOM from "react-dom";
import { Base64 } from "js-base64";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { sceneEqual, type SceneData } from "../../src/scene";
import App from "./App";
import { SceneSession, type SceneUpdate } from "./scene-session";
import { sceneFromEditor, serializeScene, vscode } from "./vscode";

const mimeTypeFallbacks = {
  "application/json": ["image/png", "image/svg+xml"],
  "image/svg+xml": ["application/json", "image/png"],
  "image/png": ["application/json", "image/svg+xml"],
};

async function getInitialData(
  content: Uint8Array,
  contentType: string
): Promise<ExcalidrawInitialDataState> {
  if (!content.length) {
    return { elements: [], appState: { viewBackgroundColor: "#ffffff" } };
  }
  const potentialContentTypes = [
    contentType,
    ...mimeTypeFallbacks[contentType as keyof typeof mimeTypeFallbacks],
  ];
  for (const candidate of potentialContentTypes) {
    try {
      return await loadFromBlob(
        new Blob(
          [
            candidate === "image/png"
              ? content
              : new TextDecoder().decode(content),
          ],
          { type: candidate }
        ),
        null,
        null
      );
    } catch {
      // A backup may contain scene JSON even when the document is PNG or SVG.
    }
  }
  throw new Error("Unable to load initial data");
}

function getExcalidrawConfig(rootElement: HTMLElement) {
  const b64Config = rootElement.getAttribute("data-excalidraw-config");
  if (!b64Config) {
    throw Error("data-excalidraw-config attribute is missing");
  }
  return JSON.parse(Base64.decode(b64Config));
}

async function getLibraryItems(libraryString: string) {
  try {
    return await loadLibraryFromBlob(
      new Blob([libraryString], { type: "application/json" })
    );
  } catch (error) {
    vscode.postMessage({
      type: "error",
      content: `Failed to load library: ${error}`,
    });
    return [];
  }
}

async function main() {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw Error("root element is missing");
  }
  const config = getExcalidrawConfig(rootElement);
  const libraryItems = config.library
    ? await getLibraryItems(config.library)
    : [];
  const session = new SceneSession(
    vscode.getState(),
    (state) => vscode.setState(state),
    (message) => vscode.postMessage(message)
  );
  let api: ExcalidrawImperativeAPI | undefined;
  let firstRender = true;
  let initialization = 0;
  let applyingScene = false;
  let imageParams: Partial<AppState> = config.imageParams;
  let pendingRender: SceneData | undefined;
  let pointerActive = false;
  let flushTimer: number | undefined;
  // One latest acknowledgement per pane bounds memory even during long drags.
  const deferredScenes = new Map<string, SceneUpdate>();

  const onChange = (
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles
  ) => {
    if (applyingScene) {
      return;
    }
    const scene = sceneFromEditor(elements, appState, files, session.scene);
    if (firstRender) {
      firstRender = false;
      session.renderedInitialScene(scene, true);
      if (pendingRender) {
        const next = pendingRender;
        pendingRender = undefined;
        applyScene(next);
      }
      return;
    }
    // No debounce: VS Code must know the document is dirty before a save or
    // moving the tab can dispose this webview.
    session.change(scene);
    if (!pointerActive && !appState.editingTextElement) scheduleSceneFlush();
  };

  const applyScene = (scene: SceneData) => {
    if (!api || firstRender) {
      pendingRender = scene;
      return;
    }
    const currentElements = api.getSceneElementsIncludingDeleted();
    const currentById = new Map(
      currentElements.map((element) => [element.id, element])
    );
    const elements = scene.elements.map((element) => {
      const current = currentById.get(element.id);
      // JSON omits undefined optional fields on the live element. Compare its
      // wire representation before deciding that a replacement is necessary.
      if (current && sceneEqual(JSON.parse(JSON.stringify(current)), element)) {
        return current;
      }
      // This is a live scene, not an import: restoreElements would discard a
      // zero-size element or assign an index while its pointer drag is ongoing.
      return element as unknown as ExcalidrawElement;
    });
    // Apply only persisted app-state keys. Zoom, selection and scroll remain
    // local to each editor, and remote changes do not enter its undo history.
    const appState = { ...api.getAppState(), ...scene.appState };
    const normalized = sceneFromEditor(
      elements,
      appState,
      scene.files as BinaryFiles,
      scene
    );
    session.renderedInitialScene(normalized);
    // An acknowledgement can omit app-state defaults that this canvas restored.
    // Do not replace its in-progress drawing with an equivalent serialized copy.
    // Excalidraw retains references to the active element during pointer drags.
    if (
      sceneEqual(
        normalized,
        sceneFromEditor(
          currentElements,
          api.getAppState(),
          api.getFiles(),
          scene
        )
      )
    ) {
      return;
    }
    applyingScene = true;
    try {
      api.addFiles(Object.values(scene.files) as BinaryFiles[string][]);
      api.updateScene({
        elements,
        appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    } finally {
      applyingScene = false;
    }
  };

  const receiveScene = (message: SceneUpdate) => {
    if (api && !firstRender) {
      session.change(
        sceneFromEditor(
          api.getSceneElementsIncludingDeleted(),
          api.getAppState(),
          api.getFiles(),
          session.scene
        )
      );
    }
    const scene = session.receive(message);
    if (scene) applyScene(scene);
  };

  const scheduleSceneFlush = () => {
    if (flushTimer !== undefined || !deferredScenes.size) return;
    // Excalidraw finalizes lines/freehand after its pointer-up callback, so wait
    // until the event and React's pending onChange work have both completed.
    flushTimer = window.setTimeout(() => {
      flushTimer = undefined;
      if (pointerActive || api?.getAppState().editingTextElement) return;
      const messages = [...deferredScenes.values()].sort(
        (a, b) => a.revision - b.revision
      );
      deferredScenes.clear();
      for (const message of messages) receiveScene(message);
    }, 0);
  };

  window.addEventListener(
    "pointerdown",
    () => {
      pointerActive = true;
    },
    true
  );
  const endPointer = () => {
    window.setTimeout(() => {
      pointerActive = false;
      scheduleSceneFlush();
    }, 0);
  };
  window.addEventListener("pointerup", endPointer, true);
  window.addEventListener("pointercancel", endPointer, true);
  // Serialize message handling so an asynchronous initial image decode cannot
  // race a later authoritative scene update or a revert.
  let incoming = Promise.resolve();
  window.addEventListener("message", (event) => {
    incoming = incoming
      .then(async () => {
        const message = event.data;
        switch (message.type) {
          case "init": {
            deferredScenes.clear();
            pointerActive = false;
            api = undefined;
            firstRender = true;
            pendingRender = undefined;
            const initialData = await getInitialData(
              message.scene
                ? new TextEncoder().encode(JSON.stringify(message.scene))
                : new Uint8Array(message.content),
              message.scene ? "application/json" : message.contentType
            );
            const initialScene = sceneFromEditor(
              initialData.elements || [],
              initialData.appState || {},
              initialData.files || {},
              message.scene
            );
            const scene = session.initialize(
              initialScene,
              message.documentId,
              message.revision,
              message.sequence
            );
            ReactDOM.render(
              <App
                key={`${message.documentId}:${++initialization}`}
                initialData={{
                  ...initialData,
                  elements: scene.elements as unknown as ExcalidrawElement[],
                  appState: scene.appState,
                  files: scene.files as BinaryFiles,
                }}
                libraryItems={libraryItems}
                name={config.name}
                viewModeEnabled={config.viewModeEnabled}
                theme={config.theme}
                onChange={onChange}
                onAPI={(nextAPI) => {
                  api = nextAPI;
                }}
                langCode={config.langCode}
              />,
              rootElement
            );
            break;
          }
          case "scene": {
            if (pointerActive || api?.getAppState().editingTextElement) {
              session.acknowledge(message);
              deferredScenes.set(message.clientId || "", message);
            } else {
              receiveScene(message);
            }
            break;
          }
          case "serialize": {
            try {
              const content = await serializeScene(
                message.scene,
                message.contentType,
                imageParams
              );
              vscode.postMessage({
                type: "serialized",
                requestId: message.requestId,
                content,
              });
            } catch (error) {
              vscode.postMessage({
                type: "serialization-error",
                requestId: message.requestId,
                error: String(error),
              });
            }
            break;
          }
          case "image-params-change":
            imageParams = message.imageParams;
            break;
        }
      })
      .catch((error) => {
        vscode.postMessage({ type: "error", content: String(error) });
      });
  });

  window.addEventListener(
    "keydown",
    (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "s" &&
        !event.shiftKey &&
        !event.altKey
      ) {
        if (!api || firstRender) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        // The change and save messages are posted in order. The host sees the
        // latest scene even when Ctrl+S is pressed before the next render callback.
        session.change(
          sceneFromEditor(
            api.getSceneElementsIncludingDeleted(),
            api.getAppState(),
            api.getFiles(),
            session.scene
          )
        );
        vscode.postMessage({ type: "save" });
      }
    },
    true
  );

  // Register listeners before asking the host for its current in-memory data.
  // Embedded HTML content can be stale when a tab moves to a new window.
  session.ready();
}

main().catch((error) => {
  vscode.postMessage({
    type: "error",
    content: `Failed to load Document: ${error}`,
  });
});
