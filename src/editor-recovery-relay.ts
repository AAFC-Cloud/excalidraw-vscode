import * as vscode from "vscode";
import type { EditorRecoveryState } from "./editor-recovery-state";

/** A fresh custom-editor iframe can reach retained orphan canvases through their
 * shared browser origin even after VS Code has severed extension-host messaging.
 * No server or external application participates in this handoff.
 */
export class EditorRecoveryRelay implements vscode.Disposable {
  public readonly uri = vscode.Uri.from({
    scheme: "excalidraw-recovery",
    path: `/reconnecting-${Date.now()}.excalidraw`,
  });
  public readonly snapshots: Promise<EditorRecoveryState[]>;
  private resolve!: (states: EditorRecoveryState[]) => void;
  private reject!: (error: Error) => void;
  private panel?: vscode.WebviewPanel;
  private listener?: vscode.Disposable;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly states = new Map<string, EditorRecoveryState>();
  private readonly requestId = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;

  constructor(
    private readonly hostId: string,
    private readonly targets: Map<string, number>
  ) {
    this.snapshots = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  attach(panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.webview.options = { enableScripts: true };
    this.listener = panel.webview.onDidReceiveMessage((message) => {
      if (
        message.type !== "captured" ||
        message.requestId !== this.requestId ||
        !this.targets.has(message.state?.uri)
      ) {
        return;
      }
      const state = message.state as EditorRecoveryState;
      if (
        !state.clientId ||
        !state.documentId ||
        !Array.isArray(state.scene?.elements) ||
        !Array.isArray(state.pending) ||
        !Array.isArray(state.sequences)
      ) {
        return;
      }
      this.states.set(state.clientId, state);
      if (
        [...this.targets].every(
          ([uri, count]) =>
            [...this.states.values()].filter((item) => item.uri === uri)
              .length >= count
        )
      ) {
        if (this.timer) {
          clearTimeout(this.timer);
        }
        this.resolve([...this.states.values()]);
      }
    });
    this.timer = setTimeout(
      () =>
        this.reject(
          new Error(
            "Some open Excalidraw canvases did not respond. They have been left open; export their drawings before reloading the window."
          )
        ),
      10000
    );
    const request = JSON.stringify({
      type: "capture",
      requestId: this.requestId,
      hostId: this.hostId,
      sessionId: vscode.env.sessionId,
      uris: [...this.targets.keys()],
    }).replace(/</g, "\\u003c");
    const nonce = this.requestId;
    panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';"></head>
<body><p>Reconnecting open Excalidraw drawings…</p><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const request = ${request};
const channel = new BroadcastChannel("excalidraw-editor-recovery-v1");
channel.onmessage = event => {
  if (event.data?.type === "captured" && event.data.requestId === request.requestId) vscode.postMessage(event.data);
};
channel.postMessage(request);
const retry = setInterval(() => channel.postMessage(request), 250);
window.addEventListener("message", event => {
  if (event.data?.type === "release") { clearInterval(retry); channel.close(); }
});
</script></body></html>`;
  }

  dispose() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.listener?.dispose();
    this.panel?.dispose();
  }
}
