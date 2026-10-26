# Document synchronization

Each open resource has one `ExcalidrawDocument`, shared by its split editor panes
and auxiliary windows in the same VS Code workbench. The document owns the current
scene, edit acknowledgements, save ordering, and backup generation.

The webview requests that current scene on startup. It does not reload the stale
file snapshot embedded in its original HTML when VS Code recreates the iframe.
Edits are sent immediately and retained with `setState` until acknowledged. A
recreated webview replays only its unacknowledged edits. Revert creates a new
generation and discards pending edits from the old one.

Split views send before/after scene changes. The shared document merges changed
fields instead of replacing the drawing with a potentially stale whole scene.
Independent edits survive; simultaneous changes to the same property use arrival
order. Deleted elements remain tombstones during synchronization. Receiving a
remote update preserves the pane's viewport and selection and does not add that
update to its local undo history.

Normal VS Code autosave settings apply. There is no inactivity debounce before
marking a scene dirty. Ctrl/Cmd+S sends a fresh canvas snapshot before asking VS
Code to save. PNG/SVG encoding runs at the save boundary; if an edit arrives while
encoding or writing, the save catches up before resolving. Write failures propagate
to VS Code. Revert is ordered with saves so an old image export cannot overwrite
an already reverted drawing.

Backups use an extension-private envelope containing the scene (or original bytes
before decoding), generation, and acknowledged edit sequences. This supports
untitled recovery and replay after a document is reopened. Saved `.excalidraw`, SVG,
and PNG files keep their ordinary formats; no synchronization metadata is added to
their elements.

Split-pane synchronization is shared within one workbench. Local JSON files also
support the cooperative external-file protocol described below; independent
processes must use that protocol to coordinate writes.

## Verification

Use the versions pinned in both lockfiles:

```sh
npm ci --ignore-scripts
cd webview
npm ci
cd ..
npm test
npm run build
npm run test:browser
```

On Windows, run the build from the directory's physical path if the checkout is
reached through a directory junction; Vite can otherwise calculate invalid asset
paths from the difference between the working directory and resolved modules.

The Node tests cover stale split-pane edits, deletions and order, acknowledgement
replay, image encoding and filesystem save races, backup recovery, and revert.
They use synthetic scenes and filesystem/event boundaries; they do not launch
VS Code. The separate browser smoke check runs the built Excalidraw webview in
headless Chromium with a simulated VS Code message host. It checks drawing
geometry, immediate saving, split-pane synchronization, pending-edit recovery,
and image export. It uses an installed Edge/Chrome on Windows, `CHROME_PATH`
when supplied, or Playwright's Chromium installation. It does not exercise
native VS Code window movement. Use the existing `Launch extension` configuration to check the complete
editor lifecycle:

1. Draw and immediately press Ctrl/Cmd+S. Reopen and verify the last edit.
2. With autosave disabled, edit and move the tab to a new window. Repeat immediately
   after an edit, before waiting for the dirty indicator.
3. Split the same drawing. Alternate edits, delete and undo, change the background,
   and add an image. Verify both views agree while retaining separate viewports.
4. Enable VS Code autosave. Verify edits persist without a manual save.
5. Repeat save/reopen for the SVG and PNG examples.
6. Revert an edited drawing and verify every pane refreshes. Check untitled recovery
   and reopening after a window reload.

## Local files shared with another process

The desktop extension also coordinates local `.excalidraw` and `.excalidraw.json` files with cooperating external writers, without launching or connecting to those programs. The browser build and SVG/PNG documents retain the existing filesystem behavior; remote providers are not claimed to support atomic replacement.

Opening a local JSON document resolves its physical path. Every save:

1. Exclusively creates `<drawing-path>.sync-lock`.
2. Writes diagnostic JSON `{"version":1,"owner":"excalidraw-vscode:<pid>:<nonce>","pid":123}`.
3. Rereads the drawing while holding the lock and merges the last accepted disk snapshot, unsaved editor state, and new disk state.
4. Writes and flushes a unique sibling temporary file, then renames it over the drawing. The destination is never unlinked as a fallback.
5. Closes and removes its lock.

An existing lock is retried for at most five seconds. Windows sharing violations during replacement receive bounded retries while retaining the old destination. Locks are never stolen or expired: after a crash, inspect the diagnostic owner and verify that it has stopped before manually removing an abandoned lock. Each participant must use the same canonical-path protocol. Ordinary text editors and other nonparticipating writers can still race this transaction. Atomic replacement prevents partial reads; it does not promise durability across power failure.

The extension watches the parent directory (replacement changes the file inode) and polls every 500 ms to recover missed notifications. Clean external changes do not dirty the drawing. Unsaved independent edits are merged. A simultaneous change to the same field, or deleting an element that the editor changed, blocks the refresh/save and reports a conflict rather than discarding either version. Save As can preserve the editor version separately; Revert loads the disk version. Malformed or unavailable files leave the last good canvas intact.

External refresh uses the existing scene-message path, so split views receive it without recreating their renderers. Updates wait for the current drag/text edit to finish. Unfamiliar scene properties are retained, and local JSON saves retain Excalidraw deletion tombstones. Backups now include the disk baseline, allowing recovered unsaved edits to merge with changes made while VS Code was closed. An older backup without a baseline must be saved elsewhere or reverted before overwriting a changed existing file.

VS Code's normal save/autosave setting controls publication of user edits to disk. External programs observe saved changes; there is no separate unsaved-buffer protocol or required Cloud Terrastodon extension integration.

To verify the complete native editor flow, open a drawing in the desktop extension and an external cooperating writer. Change a label externally while dragging a different box in the editor, save, and check that both survive. Repeat with an intentional same-field conflict, malformed disk content, editor reload, and an external atomic replacement while the editor is clean.

### Checking the active file synchronization build

After installing a VSIX, save open drawings and run **Developer: Reload Window**.
Replacing a package on disk does not replace an extension already running in the
window, and an older browser host cannot acquire the desktop file watcher.

Open **View: Toggle Output** and select **Excalidraw**. The first line identifies
the active version and whether desktop file synchronization is enabled. Each local
JSON drawing logs its canonical watched path; applied external revisions and
conflicts are reported there. Browser filesystem mode does not watch local files.
If the channel is absent after installation, the window is still running an older
build. Desktop file synchronization uses the workspace extension host so it runs
where the drawing resides.

### Native wrapping for external text

Fixed-width text (`autoResize: false`) is measured by Excalidraw when a drawing opens and when external changes arrive. External writers supply the full `originalText` and desired `width`; the renderer computes wrapped `text` and its height with Excalidraw's font metrics. Increasing the width reflows from `originalText`, so old line breaks do not accumulate. This normalization does not dirty the document or replace unrelated scene elements. It does not impose a maximum text height or lay out neighboring elements.

A native frame may opt into grouped rows through `customData.layout`: `{ "type": "rows", "groups": ["oldest-group", "newest-group"], "top": 100, "bottom": 12, "gap": 8 }`. Insets and gaps use scene units. Only listed groups whose elements belong to that frame participate; controls and other annotations retain their positions. Members align at the row top, using the largest native measured height. The newest contiguous rows that fit are shown, or the newest row alone when it exceeds the frame. The native frame clips overflow. Hidden rows retain their objects and full text. Calculated row positions and visibility are presentation only and are excluded from ordinary save state. This optional layout metadata is generic and has no knowledge of Cloud Terrastodon or decision markers.

## Extension-host restarts

A retained canvas can outlive its extension host. VS Code may cut the message
channel before extension deactivation, so a shutdown hook cannot reliably flush
or reconnect it. See the [upstream lifecycle report](https://github.com/microsoft/vscode/issues/150135).

On activation the provider identifies open Excalidraw tabs it does not own and
opens a temporary custom-editor relay using the same browser origin. A
`BroadcastChannel`, scoped to the VS Code window session and resource URIs, asks
old canvases to commit active text, suspend editing, and return their latest
host snapshot plus unacknowledged edits. This channel is internal to the editor;
there is no server or connection to Cloud Terrastodon.

The provider merges snapshots using accepted per-pane sequence numbers, writes
private recovery files, and publishes their manifest before releasing any old
tab. It then recreates the editors, restores split columns and focus, and
reinstates the dirty indicator for unsaved work. Saved drawings stay clean.
The drawing on disk is not implicitly saved. Private checkpoints survive
renderer startup failures and are consumed on save or revert; a newer standard
hot-exit backup takes precedence during a later window reload.

A missed heartbeat suspends editing instead of leaving a silently disconnected
canvas. The reconnecting overlay offers **Download recovery drawing**, which
exports the retained scene without requiring the extension host. If a handoff
fails, original canvases and any written private backups remain available.
Recovery requires the retained canvas or an existing backup; it cannot recover
edits from a terminated renderer process that were never backed up.

Upgrading from a version without this protocol requires one ordinary window
reload. **Export edits in an already detached old canvas before reloading**:
that canvas cannot answer recovery requests, and Ctrl/Cmd+S may no longer reach
VS Code.

Run `npm run build` followed by `npm run test:native` for the native regression.
It uses an isolated profile, workspace, extension directory, and VS Code process
to check real extension-host restarts, dirty-state restoration, split views,
active text, subsequent saving, external updates, and full window reloads.
On Windows it finds VS Code Insiders under LocalAppData; set `VS_CODE_EXE` to
test another installation. Existing user windows and drawings are not touched.
