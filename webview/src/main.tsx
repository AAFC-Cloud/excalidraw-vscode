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
import { mergeSceneChange, sceneEqual, type SceneData } from "../../src/scene";
import App from "./App";
import { SceneSession, type SceneUpdate } from "./scene-session";
import { SceneTextLayout } from "./scene-text-layout";
import {
  sceneFromEditor as snapshotFromEditor,
  serializeScene,
  vscode,
} from "./vscode";

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
  const textLayout = new SceneTextLayout();
  const sceneFromEditor: typeof snapshotFromEditor = (elements, ...args) =>
    snapshotFromEditor(textLayout.forPersistence(elements), ...args);
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
  let pendingTextRefresh = false;
  let pointerActive = false;
  let flushTimer: number | undefined;
  let suspended = false;
  let suspensionGeneration = 0;
  let capturedRequest: string | number | undefined;
  let heartbeatSuspended = false;
  let lastHostMessage = performance.now();
  const reconnecting = document.createElement("div");
  reconnecting.id = "excalidraw-reconnecting";
  reconnecting.setAttribute("role", "status");
  reconnecting.tabIndex = -1;
  const recoveryControls = document.createElement("div");
  recoveryControls.style.textAlign = "center";
  recoveryControls.style.maxWidth = "32em";
  recoveryControls.style.padding = "2em";
  const recoveryStatus = document.createElement("p");
  recoveryStatus.textContent = "Reconnecting to the Excalidraw extension…";
  const recoveryHelp = document.createElement("p");
  recoveryHelp.textContent =
    "Your drawing remains in this tab. If reconnection fails, download it before reloading the window.";
  const downloadRecovery = document.createElement("button");
  downloadRecovery.type = "button";
  downloadRecovery.textContent = "Download recovery drawing";
  Object.assign(downloadRecovery.style, {
    font: "inherit",
    padding: "0.5em 1em",
    cursor: "pointer",
    color: "var(--vscode-button-foreground, white)",
    background: "var(--vscode-button-background, #0078d4)",
    border: "1px solid var(--vscode-button-border, transparent)",
    borderRadius: "3px",
  });
  downloadRecovery.addEventListener("click", () => {
    const state = session.recovery(config.uri);
    if (!state) return;
    const scene = state.pending.reduce(
      (current, change) =>
        mergeSceneChange(current, change.before, change.scene),
      state.scene
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = (config.name || "drawing") + ".recovered.excalidraw";
    recoveryControls.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  recoveryControls.append(recoveryStatus, recoveryHelp, downloadRecovery);
  reconnecting.appendChild(recoveryControls);
  Object.assign(reconnecting.style, {
    position: "fixed",
    inset: "0",
    zIndex: "100000",
    display: "grid",
    placeItems: "center",
    background:
      "color-mix(in srgb, var(--vscode-editor-background, white) 80%, transparent)",
    color: "var(--vscode-editor-foreground, #333)",
    font: "14px var(--vscode-font-family, sans-serif)",
    cursor: "wait",
  });
  const resume = () => {
    suspended = false;
    heartbeatSuspended = false;
    rootElement.removeAttribute("inert");
    reconnecting.remove();
  };
  const suspend = () => {
    suspensionGeneration++;
    // Excalidraw's text editor can temporarily disable blur submission while a
    // property control is active. Escape explicitly commits its current value.
    // Flush React before the final snapshot, including edits not yet onChange'd.
    if (!suspended) {
      ReactDOM.flushSync(() => {
        rootElement
          .querySelector<HTMLTextAreaElement>(".excalidraw-wysiwyg")
          ?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            })
          );
      });
    }
    suspended = true;
    rootElement.setAttribute("inert", "");
    document.body.appendChild(reconnecting);
    reconnecting.focus({ preventScroll: true });
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
  };
  // Inert blocks element interaction; capture listeners also stop Excalidraw's
  // window keyboard and pointer handlers while its extension host is detached.
  for (const type of [
    "keydown",
    "keyup",
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "click",
    "dblclick",
    "wheel",
    "paste",
    "cut",
    "drop",
    "beforeinput",
    "input",
  ]) {
    window.addEventListener(
      type,
      (event) => {
        if (!suspended) return;
        // Recovery controls remain usable without the extension host. Keep
        // canvas shortcuts blocked, including when its overlay button is focused.
        if (
          event.target instanceof Node &&
          recoveryControls.contains(event.target)
        ) {
          if (
            !(event instanceof KeyboardEvent) ||
            ["Tab", "Enter", " "].includes(event.key)
          )
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true, passive: false }
    );
    reconnecting.addEventListener(type, (event) => event.stopPropagation());
  }
  // A restarted extension host cannot reach retained custom-editor panels via
  // VS Code's old RPC handles. A fresh editor relay shares their browser origin
  // and hands these snapshots back through its new, connected message channel.
  const recoveryChannel = new BroadcastChannel("excalidraw-editor-recovery-v1");
  recoveryChannel.addEventListener("message", (event) => {
    const message = event.data;
    if (
      message.type === "capture" &&
      message.sessionId === config.sessionId &&
      message.hostId !== config.hostId &&
      message.uris?.includes(config.uri) &&
      !firstRender
    ) {
      suspend();
      capturedRequest = message.requestId;
      const state = session.recovery(config.uri);
      if (state) {
        recoveryChannel.postMessage({
          type: "captured",
          requestId: message.requestId,
          state,
        });
      }
    } else if (
      message.type === "resume" &&
      (message.sessionId === undefined ||
        message.sessionId === config.sessionId) &&
      capturedRequest !== undefined &&
      message.requestId === capturedRequest
    ) {
      capturedRequest = undefined;
      resume();
    }
  });
  window.setInterval(() => {
    if (firstRender) return;
    vscode.postMessage({ type: "heartbeat" });
    if (!suspended && performance.now() - lastHostMessage > 4000) {
      suspend();
      heartbeatSuspended = true;
    }
  }, 1000);

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
      const generation = initialization;
      // Excalidraw mounts/registers the scene fonts after its initial snapshot.
      // Wait for those fonts before caching measurements of fixed-width text.
      rootElement.ownerDocument.defaultView!.setTimeout(() => {
        void rootElement.ownerDocument.fonts.ready
          .then(async () => {
            if (generation !== initialization || !session.scene) return;
            await textLayout.loadFonts(
              session.scene.elements as unknown as ExcalidrawElement[],
              rootElement.ownerDocument
            );
            if (generation !== initialization) return;
            pendingTextRefresh = true;
            scheduleSceneFlush();
          })
          .catch((error) =>
            vscode.postMessage({ type: "error", content: String(error) })
          );
      }, 0);
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

  const applyScene = (scene: SceneData, forceTextRefresh = false) => {
    if (!api || firstRender) {
      pendingRender = scene;
      return;
    }
    const currentElements = api.getSceneElementsIncludingDeleted();
    const currentById = new Map(
      currentElements.map((element) => [element.id, element])
    );
    const elements = textLayout.refresh(
      scene.elements.map((element) => {
        const current = currentById.get(element.id);
        // JSON omits undefined optional fields on the live element. Compare its
        // wire representation before deciding that a replacement is necessary.
        if (
          current &&
          sceneEqual(JSON.parse(JSON.stringify(current)), element)
        ) {
          return current;
        }
        // This is a live scene, not an import: restoreElements would discard a
        // zero-size element or assign an index while its pointer drag is ongoing.
        return element as unknown as ExcalidrawElement;
      }),
      forceTextRefresh ? [] : currentElements
    );
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
    if (
      flushTimer !== undefined ||
      (!deferredScenes.size && !pendingTextRefresh)
    )
      return;
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
      if (pendingTextRefresh && session.scene) {
        pendingTextRefresh = false;
        applyScene(session.scene, true);
      }
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
    // Freeze immediately, even when earlier messages are awaiting font loads.
    // Serialization remains available so the host can preserve image documents.
    const suspensionAtMessage = suspensionGeneration;
    lastHostMessage = performance.now();
    if (heartbeatSuspended && capturedRequest === undefined) resume();
    if (event.data.type === "suspend") suspend();
    // Store acknowledgements immediately, before asynchronous font loading.
    // Recovery must include the newest host baseline even during a local drag.
    if (event.data.type === "scene") session.acknowledge(event.data);
    incoming = incoming
      .then(async () => {
        const message = event.data;
        switch (message.type) {
          case "init": {
            textLayout.reset();
            deferredScenes.clear();
            pointerActive = false;
            api = undefined;
            firstRender = true;
            pendingRender = undefined;
            pendingTextRefresh = false;
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
              message.sequence,
              message.diskBase,
              message.dirty,
              message.sequences,
              message.scene || initialScene
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
            if (suspensionAtMessage === suspensionGeneration) resume();
            break;
          }
          case "scene": {
            await textLayout.loadFonts(
              message.scene.elements as unknown as ExcalidrawElement[],
              rootElement.ownerDocument
            );
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
          case "suspend":
            // change and suspended are posted in order: the host has the final
            // edit before it starts preserving or replacing the editor.
            vscode.postMessage({
              type: "suspended",
              requestId: message.requestId,
            });
            break;
          case "resume":
            if (suspensionAtMessage === suspensionGeneration) resume();
            break;
          case "heartbeat":
            break;
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
