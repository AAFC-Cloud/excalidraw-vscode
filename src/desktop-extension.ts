import * as vscode from "vscode";
import { activate as activateShared } from "./extension";
import { LocalSceneFile } from "./local-scene-file";

/** Desktop adds local-file coordination; the browser entry retains workspace.fs. */
export async function activate(context: vscode.ExtensionContext) {
  await activateShared(context, async (uri) => {
    if (
      uri.scheme !== "file" ||
      !/\.excalidraw(?:\.json)?$/i.test(uri.fsPath)
    ) {
      return undefined;
    }
    return LocalSceneFile.open(uri.fsPath);
  });
}
