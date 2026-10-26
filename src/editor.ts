import * as vscode from "vscode";
import * as path from "path";
import { Base64 } from "js-base64";

import { ExcalidrawDocument } from "./document";
import { SceneRenderer } from "./scene-renderer";
import { EditorRecovery } from "./editor-recovery";
import { EditorRecoveryRelay } from "./editor-recovery-relay";
import type { SceneFile } from "./scene-file";
import { languageMap } from "./lang";
import { showEditor } from "./commands";

export class ExcalidrawEditorProvider
  implements vscode.CustomEditorProvider<ExcalidrawDocument>, vscode.Disposable
{
  private static readonly viewType = "editor.excalidraw";
  private readonly hostId = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private registration?: vscode.Disposable;
  private restoreTimer?: ReturnType<typeof setTimeout>;
  private relay?: EditorRecoveryRelay;
  private readonly documents = new Set<ExcalidrawDocument>();
  private readonly opening = new Set<string>();
  private readonly panels = new Map<vscode.WebviewPanel, ExcalidrawEditor>();
  private readonly recovering = new Set<ExcalidrawDocument>();
  private readonly recovery: EditorRecovery;

  public static async register(
    context: vscode.ExtensionContext,
    sceneFile?: (uri: vscode.Uri) => Promise<SceneFile | undefined>,
    output?: vscode.OutputChannel
  ) {
    // A new workbench has lazily restored tabs with no retained canvas yet.
    // Only a second activation in the SAME workbench session needs the relay.
    const sessionKey = `excalidraw.editorSession.${vscode.env.sessionId}`;
    const reconnectRetained = context.workspaceState.get<boolean>(
      sessionKey,
      false
    );
    await context.workspaceState.update(sessionKey, true);
    const provider = new ExcalidrawEditorProvider(context, sceneFile, output);
    provider.registration = vscode.window.registerCustomEditorProvider(
      ExcalidrawEditorProvider.viewType,
      provider,
      {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
    ExcalidrawEditorProvider.migrateLegacyLibraryItems(context);
    // Let activation finish and normal hot-exit documents begin resolving first.
    provider.restoreTimer = setTimeout(
      () => void provider.restoreEditors(reconnectRetained),
      500
    );
    return provider;
  }

  private static migrateLegacyLibraryItems(context: vscode.ExtensionContext) {
    const libraryItems = context.globalState.get("libraryItems");
    if (!libraryItems) {
      return;
    }
    void context.globalState
      .update(
        "library",
        JSON.stringify({
          type: "excalidrawlib",
          version: 2,
          source:
            "https://marketplace.visualstudio.com/items?itemName=pomdtr.excalidraw-editor",
          libraryItems,
        })
      )
      .then(() => context.globalState.update("libraryItems", undefined));
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sceneFile?: (
      uri: vscode.Uri
    ) => Promise<SceneFile | undefined>,
    private readonly output?: vscode.OutputChannel
  ) {
    this.recovery = new EditorRecovery(context);
  }

  private async recoverRetainedEditors() {
    const orphans = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType === ExcalidrawEditorProvider.viewType &&
          tab.input.uri.scheme !== "excalidraw-recovery" &&
          !this.opening.has(tab.input.uri.toString())
      );
    if (!orphans.length) {
      return;
    }
    const targets = new Map<string, number>();
    for (const tab of orphans) {
      const uri = (tab.input as vscode.TabInputCustom).uri.toString();
      targets.set(uri, (targets.get(uri) || 0) + 1);
    }
    const views = new Map(
      [...targets.keys()].map((uri) => [
        uri,
        orphans
          .filter(
            (tab) => (tab.input as vscode.TabInputCustom).uri.toString() === uri
          )
          .map((tab) => ({
            column: tab.group.viewColumn,
            active: tab.isActive && tab.group.isActive,
          })),
      ])
    );
    const relay = new EditorRecoveryRelay(this.hostId, targets);
    this.relay = relay;
    try {
      this.output?.appendLine(
        "Recovering retained canvases after extension-host restart"
      );
      await vscode.commands.executeCommand(
        "vscode.openWith",
        relay.uri,
        ExcalidrawEditorProvider.viewType,
        { preserveFocus: true, preview: false }
      );
      const snapshots = await relay.snapshots;
      // Capture ALL panes and publish the private journal before releasing ANY.
      await this.recovery.capture(snapshots, (uri) => views.get(uri)!);
      for (const uri of targets.keys()) {
        const tabs = orphans.filter(
          (tab) => (tab.input as vscode.TabInputCustom).uri.toString() === uri
        );
        // Revert-and-close captures the active input and performs a soft revert
        // if its old provider is gone. The latest scene is already checkpointed;
        // this clears ONLY the obsolete workbench model, never the user's file.
        await vscode.commands.executeCommand(
          "vscode.openWith",
          vscode.Uri.parse(uri),
          ExcalidrawEditorProvider.viewType,
          { viewColumn: tabs[0].group.viewColumn, preview: false }
        );
        const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (
          !(active instanceof vscode.TabInputCustom) ||
          active.viewType !== ExcalidrawEditorProvider.viewType ||
          active.uri.toString() !== uri
        ) {
          throw new Error(
            "The active editor changed during recovery; original tabs were left open."
          );
        }
        await vscode.commands.executeCommand(
          "workbench.action.revertAndCloseActiveEditor"
        );
        const remaining = orphans.filter(
          (tab) =>
            vscode.window.tabGroups.all.some((group) =>
              group.tabs.includes(tab)
            ) && (tab.input as vscode.TabInputCustom).uri.toString() === uri
        );
        if (
          remaining.length &&
          !(await vscode.window.tabGroups.close(remaining, true))
        ) {
          throw new Error(
            "Could not release the old Excalidraw views; the recovery backup is retained."
          );
        }
      }
    } finally {
      relay.dispose();
      this.relay = undefined;
    }
  }

  private async restoreEditors(reconnectRetained: boolean) {
    try {
      if (reconnectRetained) {
        await this.recoverRetainedEditors();
      }
      for (const entry of [...this.recovery.pending]) {
        for (const view of [...entry.views].sort(
          (a, b) => (a.column || 1) - (b.column || 1)
        )) {
          if (
            [...this.panels].some(
              ([panel, editor]) =>
                editor.document.uri.toString() === entry.uri &&
                panel.viewColumn === view.column
            )
          ) {
            continue;
          }
          await vscode.commands.executeCommand(
            "vscode.openWith",
            vscode.Uri.parse(entry.uri),
            ExcalidrawEditorProvider.viewType,
            {
              viewColumn: view.column,
              preserveFocus: true,
              preview: false,
            }
          );
        }
        this.output?.appendLine(
          `Restored editor after extension restart: ${entry.uri}`
        );
        // Keep the private recovery until save/revert/close. A failed renderer
        // initialization must not consume the only durable copy of unsaved work.
      }
      const focused = this.recovery.pending.flatMap((entry) =>
        entry.views
          .filter((view) => view.active)
          .map((view) => ({ uri: entry.uri, column: view.column }))
      )[0];
      if (focused) {
        await vscode.commands.executeCommand(
          "vscode.openWith",
          vscode.Uri.parse(focused.uri),
          ExcalidrawEditorProvider.viewType,
          { viewColumn: focused.column, preserveFocus: false, preview: false }
        );
      }
    } catch (error) {
      this.output?.appendLine(
        `Editor recovery failed; original canvases and any private backups retained: ${String(
          error
        )}`
      );
      void vscode.window.showErrorMessage(
        `Excalidraw could not reconnect every drawing. Keep the original tabs open. ${String(
          error
        )}`
      );
    }
  }

  private async consumeRecovery(document: ExcalidrawDocument) {
    const entry = this.recovery.find(document.uri);
    if (entry) {
      await this.recovery.consumed(entry);
    }
  }

  dispose() {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
    }
    this.relay?.dispose();
    this.registration?.dispose();
    for (const document of this.documents) {
      document.dispose();
    }
    this._onDidChangeCustomDocument.dispose();
  }

  public async resolveCustomEditor(
    document: ExcalidrawDocument,
    webviewPanel: vscode.WebviewPanel
  ) {
    if (document.uri.toString() === this.relay?.uri.toString()) {
      this.relay.attach(webviewPanel);
      return;
    }
    const editor = new ExcalidrawEditor(
      document,
      webviewPanel.webview,
      this.context,
      this.hostId
    );
    this.panels.set(webviewPanel, editor);
    const editorDisposable = await editor.setupWebview();
    webviewPanel.onDidDispose(() => {
      this.panels.delete(webviewPanel);
      editorDisposable.dispose();
    });
    if (this.recovering.delete(document) && document.hasUnsavedChanges) {
      this._onDidChangeCustomDocument.fire({ document });
    }
  }

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<ExcalidrawDocument>
  >();
  public readonly onDidChangeCustomDocument =
    this._onDidChangeCustomDocument.event;

  async backupCustomDocument(
    document: ExcalidrawDocument,
    context: vscode.CustomDocumentBackupContext
  ): Promise<vscode.CustomDocumentBackup> {
    return document.backup(context.destination);
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext
  ): Promise<ExcalidrawDocument> {
    if (uri.toString() === this.relay?.uri.toString()) {
      return new ExcalidrawDocument(
        uri,
        new TextEncoder().encode(
          JSON.stringify({ type: "excalidraw", elements: [] })
        )
      );
    }
    this.opening.add(uri.toString());
    const sceneFile = await this.sceneFile?.(uri);
    const recovered = this.recovery.find(uri);
    let content: Uint8Array;
    if (recovered) {
      content = await this.recovery.read(recovered, openContext.backupId);
    } else if (openContext.backupId) {
      content = await vscode.workspace.fs.readFile(
        vscode.Uri.parse(openContext.backupId)
      );
    } else if (uri.scheme === "untitled") {
      content = new TextEncoder().encode(
        JSON.stringify({ type: "excalidraw", elements: [] })
      );
    } else if (sceneFile) {
      content = new TextEncoder().encode(
        JSON.stringify(await sceneFile.read())
      );
    } else {
      content = await vscode.workspace.fs.readFile(uri);
    }
    const document = new ExcalidrawDocument(
      uri,
      content,
      Boolean(recovered || openContext.backupId),
      sceneFile
    );
    this.documents.add(document);
    if (recovered) {
      this.recovering.add(document);
    }
    const onDidDocumentChange = document.onDidContentChange(() =>
      this._onDidChangeCustomDocument.fire({ document })
    );
    document.onDidDispose(() => {
      this.documents.delete(document);
      this.opening.delete(uri.toString());
      this.recovering.delete(document);
      onDidDocumentChange.dispose();
      if (!document.hasUnsavedChanges) {
        void this.consumeRecovery(document);
      }
    });
    if (sceneFile) {
      this.output?.appendLine(
        `Watching local drawing ${JSON.stringify(sceneFile.path)}`
      );
      const onDiskScene = document.onDidSceneChange((change) => {
        if (change?.clientId === "disk") {
          this.output?.appendLine(
            `Applied external revision ${document.revision}: ${JSON.stringify(
              sceneFile.path
            )}`
          );
        }
      });
      document.onDidDispose(() => onDiskScene.dispose());
    }
    document.watchFile((error) => {
      this.output?.appendLine(
        `File synchronization failed for ${JSON.stringify(uri.fsPath)}: ${
          error.message
        }`
      );
      void vscode.window.showWarningMessage(
        `Excalidraw file synchronization: ${error.message}`
      );
    });
    return document;
  }

  async revertCustomDocument(document: ExcalidrawDocument) {
    await document.revert();
    await this.consumeRecovery(document);
  }

  async saveCustomDocument(document: ExcalidrawDocument) {
    await document.save();
    await this.consumeRecovery(document);
  }

  async saveCustomDocumentAs(
    document: ExcalidrawDocument,
    destination: vscode.Uri
  ) {
    await document.saveAs(destination, await this.sceneFile?.(destination));
    await this.consumeRecovery(document);
  }
}

export class ExcalidrawEditor {
  // Allows to pass events between editors
  private static _onDidChangeLibrary = new vscode.EventEmitter<string>();
  private static onDidChangeLibrary =
    ExcalidrawEditor._onDidChangeLibrary.event;
  private static _onLibraryImport = new vscode.EventEmitter<{
    library: string;
  }>();
  private static onLibraryImport = ExcalidrawEditor._onLibraryImport.event;
  private textDecoder = new TextDecoder();
  constructor(
    readonly document: ExcalidrawDocument,
    readonly webview: vscode.Webview,
    readonly context: vscode.ExtensionContext,
    private readonly hostId: string
  ) {}

  isViewOnly() {
    return (
      this.document.uri.scheme === "git" ||
      this.document.uri.scheme === "conflictResolution"
    );
  }

  public async setupWebview() {
    // Setup initial content for the webview
    // Receive message from the webview.
    this.webview.options = {
      enableScripts: true,
    };

    const renderer = new SceneRenderer(this.webview);
    const serializer = this.document.registerSerializer((scene, contentType) =>
      renderer.serialize(scene, contentType)
    );
    let clientId = "";
    const initialize = () =>
      this.webview.postMessage({
        type: "init",
        content: Array.from(this.document.content),
        contentType: this.document.contentType,
        scene: this.document.scene,
        documentId: this.document.documentId,
        revision: this.document.revision,
        sequence: this.document.sequenceFor(clientId),
        ...this.document.recoveryMetadata(),
      });
    const sendScene = (sourceClientId: string, sequence: number) =>
      this.webview.postMessage({
        type: "scene",
        scene: this.document.scene,
        documentId: this.document.documentId,
        revision: this.document.revision,
        clientId: sourceClientId,
        sequence,
        ...this.document.recoveryMetadata(),
      });
    const onDidSceneChange = this.document.onDidSceneChange((change) => {
      if (!clientId) {
        return;
      }
      if (change) {
        void sendScene(change.clientId, change.sequence);
      } else {
        void initialize();
      }
    });

    let libraryUri = await this.getLibraryUri();

    const onDidReceiveMessage = this.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.type) {
          case "library-change":
            const library = msg.library;
            await this.saveLibrary(library, libraryUri);
            ExcalidrawEditor._onDidChangeLibrary.fire(library);
            break;
          case "ready":
            clientId = msg.clientId;
            renderer.restarted();
            await initialize();
            break;
          case "loaded":
            if (msg.documentId === this.document.documentId) {
              this.document.loaded(msg.documentId, msg.scene);
              renderer.loaded();
            }
            break;
          case "heartbeat":
            await this.webview.postMessage({ type: "heartbeat" });
            break;
          case "change":
            if (this.isViewOnly()) {
              break;
            }
            if (
              !this.document.update(
                msg.clientId,
                msg.documentId,
                msg.sequence,
                msg.before,
                msg.scene
              )
            ) {
              if (msg.documentId !== this.document.documentId) {
                await initialize();
              } else {
                await sendScene(
                  msg.clientId,
                  this.document.sequenceFor(msg.clientId)
                );
              }
            }
            break;
          case "save":
            if (!this.isViewOnly()) {
              await vscode.commands.executeCommand(
                "workbench.action.files.save"
              );
            }
            break;
          case "serialized":
            renderer.finish(msg.requestId, msg.content);
            break;
          case "serialization-error":
            renderer.finish(msg.requestId, undefined, msg.error);
            break;
          case "link-open":
            await openLink(vscode.Uri.parse(msg.url), this.document.uri);
            break;
          case "error":
            vscode.window.showErrorMessage(msg.content);
            break;
          case "info":
            vscode.window.showInformationMessage(msg.content);
            break;
        }
      },
      this
    );

    const onDidChangeThemeConfiguration =
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("excalidraw.theme", this.document.uri)) {
          return;
        }
        this.webview.postMessage({
          type: "theme-change",
          theme: this.getTheme(),
        });
      }, this);

    const onDidChangeLanguageConfiguration =
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("excalidraw.language", this.document.uri)) {
          return;
        }
        this.webview.postMessage({
          type: "language-change",
          langCode: this.getLanguage(),
        });
      }, this);

    const onDidChangeEmbedConfiguration =
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("excalidraw.image", this.document.uri)) {
          return;
        }
        this.webview.postMessage({
          type: "image-params-change",
          imageParams: this.getImageParams(),
        });
      }, this);

    const onDidChangeLibraryConfiguration =
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (
          !e.affectsConfiguration(
            "excalidraw.workspaceLibraryPath",
            this.document.uri
          )
        ) {
          return;
        }

        libraryUri = await this.getLibraryUri();
        const library = await this.loadLibrary(libraryUri);
        this.webview.postMessage({
          type: "library-change",
          library,
          merge: false,
        });
      });

    const onLibraryImport = ExcalidrawEditor.onLibraryImport(
      async ({ library }) => {
        this.webview.postMessage({
          type: "library-change",
          library,
          merge: true,
        });
      }
    );

    const onDidChangeLibrary = ExcalidrawEditor.onDidChangeLibrary(
      (library) => {
        this.webview.postMessage({
          type: "library-change",
          library,
          merge: false,
        });
      }
    );

    this.webview.html = await this.buildHtmlForWebview({
      uri: this.document.uri.toString(),
      hostId: this.hostId,
      sessionId: vscode.env.sessionId,
      contentType: this.document.contentType,
      library: await this.loadLibrary(libraryUri),
      viewModeEnabled: this.isViewOnly() || undefined,
      theme: this.getTheme(),
      imageParams: this.getImageParams(),
      langCode: this.getLanguage(),
      name: this.extractName(this.document.uri),
    });

    return new vscode.Disposable(() => {
      onDidReceiveMessage.dispose();
      onDidSceneChange.dispose();
      onDidChangeLanguageConfiguration.dispose();
      serializer.dispose();
      renderer.dispose();
      onDidChangeThemeConfiguration.dispose();
      onLibraryImport.dispose();
      onDidChangeLibraryConfiguration.dispose();
      onDidChangeLibrary.dispose();
      onDidChangeEmbedConfiguration.dispose();
    });
  }

  private getImageParams() {
    return vscode.workspace.getConfiguration("excalidraw").get("image");
  }

  private getLanguage() {
    return (
      vscode.workspace.getConfiguration("excalidraw").get("language") ||
      languageMap[vscode.env.language as keyof typeof languageMap]
    );
  }

  private getTheme() {
    return vscode.workspace
      .getConfiguration("excalidraw")
      .get("theme", "light");
  }

  public extractName(uri: vscode.Uri) {
    const name = path.parse(uri.fsPath).name;
    return name.endsWith(".excalidraw") ? name.slice(0, -11) : name;
  }

  public async getLibraryUri() {
    const libraryPath = await vscode.workspace
      .getConfiguration("excalidraw")
      .get<string>("workspaceLibraryPath");
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!libraryPath || !workspaceFolders) {
      return;
    }

    const fileWorkspace = getFileWorkspaceFolder(
      this.document.uri,
      workspaceFolders as vscode.WorkspaceFolder[]
    );
    if (!fileWorkspace) {
      return;
    }

    return vscode.Uri.joinPath(fileWorkspace.uri, libraryPath);
  }

  public static importLibrary(library: string) {
    this._onLibraryImport.fire({ library });
  }

  public async loadLibrary(libraryUri?: vscode.Uri) {
    if (!libraryUri) {
      return this.context.globalState.get<string>("library");
    }
    try {
      const libraryContent = await vscode.workspace.fs.readFile(libraryUri);
      return this.textDecoder.decode(libraryContent);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to load library: ${e}`);
      return this.context.globalState.get<string>("library");
    }
  }

  public async saveLibrary(library: string, libraryUri?: vscode.Uri) {
    if (!libraryUri) {
      return this.context.globalState.update("library", library);
    }
    try {
      await vscode.workspace.fs.writeFile(
        libraryUri,
        new TextEncoder().encode(library)
      );
    } catch (e) {
      await vscode.window.showErrorMessage(`Failed to save library: ${e}`);
    }
  }

  private async buildHtmlForWebview(config: any): Promise<string> {
    const webviewUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      "webview",
      "dist"
    );
    const content = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(webviewUri, "index.html")
    );
    let html = this.textDecoder.decode(content);

    html = html.replace(
      "{{data-excalidraw-config}}",
      Base64.encode(JSON.stringify(config))
    );

    html = html.replace(
      "{{excalidraw-asset-path}}",
      `${this.webview.asWebviewUri(webviewUri).toString()}/`
    );

    return this.fixLinks(html, webviewUri);
  }
  private fixLinks(document: string, documentUri: vscode.Uri): string {
    return document.replace(
      new RegExp("((?:src|href)=['\"])(.*?)(['\"])", "gmi"),
      (subString: string, p1: string, p2: string, p3: string): string => {
        const lower = p2.toLowerCase();
        if (
          p2.startsWith("#") ||
          lower.startsWith("http://") ||
          lower.startsWith("https://")
        ) {
          return subString;
        }
        const newUri = vscode.Uri.joinPath(documentUri, p2);
        const newUrl = [p1, this.webview.asWebviewUri(newUri), p3].join("");
        return newUrl;
      }
    );
  }
}

function getFileWorkspaceFolder(
  uri: vscode.Uri,
  workspaceFolders: vscode.WorkspaceFolder[]
): vscode.WorkspaceFolder | undefined {
  const parts = uri.path.split(path.sep).slice(0, -1);
  while (parts.length > 0) {
    const joined = parts.join(path.sep);
    const folder = workspaceFolders.find((f) => f.uri.path === joined);
    if (folder) {
      return folder;
    }
    parts.pop();
  }
}

async function openLink(uri: vscode.Uri, source: vscode.Uri): Promise<void> {
  if (uri.scheme !== "file") {
    await vscode.env.openExternal(uri);
    return;
  }

  const targetUri = vscode.Uri.joinPath(source, "..", uri.path);
  try {
    // Ensure the resource exists and is a file
    const stat = await vscode.workspace.fs.stat(targetUri);
    if (stat.type !== vscode.FileType.File) {
      throw new Error(`${targetUri.fsPath} is not a file`);
    }
  } catch (e) {
    // Otherwise, open it externally
    await vscode.env.openExternal(uri);
    return;
  }

  const extensions = [
    ".excalidraw",
    ".excalidraw.json",
    ".excalidraw.png",
    ".excalidraw.svg",
  ];
  for (const ext of extensions) {
    if (targetUri.fsPath.endsWith(ext)) {
      await showEditor(targetUri);
      return;
    }
  }

  await vscode.window.showTextDocument(targetUri, {
    preview: true,
  });
}
