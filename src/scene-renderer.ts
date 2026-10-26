import * as vscode from "vscode";
import { SceneData } from "./scene";

/** Owns the pending image exports for one webview, including iframe recreation. */
export class SceneRenderer implements vscode.Disposable {
  private nextRequestId = 0;
  private ready = false;
  private generation = 0;
  private readonly pending = new Map<
    number,
    {
      scene: SceneData;
      contentType: string;
      resolve: (content: Uint8Array) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly webview: vscode.Webview) {}

  public restarted() {
    this.generation++;
    this.ready = false;
  }

  public loaded() {
    this.ready = true;
    // Moving a tab replaces its iframe. Re-send outstanding exports after the
    // new page has installed its handlers and restored the current document.
    for (const [requestId, request] of this.pending) {
      void this.send(requestId, request.scene, request.contentType);
    }
  }

  public serialize(scene: SceneData, contentType: string): Promise<Uint8Array> {
    if (!this.ready) {
      return Promise.reject(new Error("The Excalidraw view is still loading."));
    }
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(
          requestId,
          undefined,
          "Excalidraw did not finish exporting the image. Try saving again."
        );
      }, 30000);
      this.pending.set(requestId, {
        scene,
        contentType,
        resolve,
        reject,
        timer,
      });
      void this.send(requestId, scene, contentType);
    });
  }

  private async send(requestId: number, scene: SceneData, contentType: string) {
    const generation = this.generation;
    try {
      if (
        !(await this.webview.postMessage({
          type: "serialize",
          requestId,
          scene,
          contentType,
        })) &&
        generation === this.generation
      ) {
        this.finish(
          requestId,
          undefined,
          "The Excalidraw view closed before the image could be saved."
        );
      }
    } catch (error) {
      if (generation === this.generation) {
        this.finish(requestId, undefined, String(error));
      }
    }
  }

  public finish(requestId: number, content?: number[], error?: string) {
    const request = this.pending.get(requestId);
    if (!request) {
      return;
    }
    clearTimeout(request.timer);
    this.pending.delete(requestId);
    if (content) {
      request.resolve(new Uint8Array(content));
    } else {
      request.reject(
        new Error(error || "Excalidraw could not export the image.")
      );
    }
  }

  dispose() {
    this.ready = false;
    for (const requestId of this.pending.keys()) {
      this.finish(
        requestId,
        undefined,
        "The Excalidraw editor closed before the image could be saved."
      );
    }
  }
}
