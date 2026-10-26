import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { ExcalidrawEditorProvider } from "./editor";
import { ExcalidrawUriHandler } from "./uri-handler";
import type { SceneFile } from "./scene-file";

export async function activate(
  context: vscode.ExtensionContext,
  sceneFile?: (uri: vscode.Uri) => Promise<SceneFile | undefined>
) {
  const output = vscode.window.createOutputChannel("Excalidraw");
  context.subscriptions.push(output);
  output.appendLine(
    `Excalidraw ${context.extension.packageJSON.version}: ${
      sceneFile
        ? "desktop file synchronization enabled"
        : "browser filesystem mode"
    }`
  );
  // Register our custom editor providers
  const provider = await ExcalidrawEditorProvider.register(
    context,
    sceneFile,
    output
  );
  context.subscriptions.push(provider);
  context.subscriptions.push(ExcalidrawUriHandler.register());
  registerCommands(context);
}
