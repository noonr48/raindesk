# Raindesk Floating Workspace Shell

This slice hydrates the persistent workspace model from `lib/workspace.js` into the real desktop app.

## Product rule

Creative utilities should behave like papers/tools on an artist's desk, not permanent software rails. On desktop the Partner, Layers, Scenes, and Beat Trail are now stable workspace objects that can float, resize, minimise, reopen, and magnetically dock. The main art surface keeps its width instead of surrendering a permanent column to chat.

The same stable object IDs are supplied to the Partner context and are used by the permission-gated Partner action ledger. A human drag and an approved `move_panel` therefore modify the same durable object rather than two disconnected UI states.

## Implemented

- floating desktop Partner instead of permanent docked rail
- floating Layers, Scenes and Beat Trail windows
- persistent x/y/width/height/z/dock/visible/collapsed state
- drag from panel headers
- bottom-right resize grips
- edge magnetic docking
- peer-edge snapping guides
- panel shelf for hiding/reopening utilities
- Scenes panel backed by the canonical board shot list
- stable Partner workspace context (`panel_partner`, `panel_beats`, etc.)
- Suggest-mode executable workspace proposals surface as `try it` / `not now`
- Act-mode workspace actions are executed only after the server permission gate pre-approves them
- completed Partner spatial actions expose `keep` / `undo`
- move-action inverse now restores a previous dock as well as coordinates
- mobile keeps the existing overlay behaviour; the desktop shell is intentionally progressive

## Deliberate non-goals

This is **not** yet the final endless canvas.

Not included here:

- the final warm paper/sketchbook visual language
- world-space comic pages / character canvases / reference boards
- free pan/zoom of arbitrary creative objects
- detachable canvas tabs
- persistent reference-board content or image pinning UI
- drawing directly on a PureRef-like reference board
- multi-window OS-level detach

Those should build on this shell rather than reintroduce fixed rails or screen-coordinate-only semantics.

## Validation target

`dev/browser-workspace-smoke.js` uses native Chromium/CDP pointer input to prove:

1. workspace objects seed on a real boot;
2. the Partner does not permanently shrink the art stage;
3. Scenes opens from the shelf;
4. native drag persists a free position;
5. dragging to the left edge persists a left dock;
6. minimise persists hidden/collapsed state;
7. shelf reopen preserves the dock;
8. reload restores the same visible docked workspace state.
