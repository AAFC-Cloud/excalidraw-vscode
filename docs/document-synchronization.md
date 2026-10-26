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

This is synchronization within one workbench. Independent VS Code processes and
arbitrary external file writers are not a collaborative editing protocol.

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
