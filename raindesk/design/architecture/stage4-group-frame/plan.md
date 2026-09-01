# plan.md — Stage-4 skeleton (group frame)

| id | change | files | verify hook | rollback |
|---|---|---|---|---|
| G1 | v4 protocol EXPAND: groups gain an optional canonical `frame` {rect{x,y,width,height}, presentation{kind,edge?}, zIndex} — additive; group.create accepts an initial frame (derived from the first member's projected rect when absent); new op `group.setFrame {group locator, patch, expectedGroupVersion}` mutates the frame under the group revision discipline; readV4 exposes frame | `lib/workspace-v4.js`, `lib/tests/workspace-v4.test.js` | lib discriminators: create-with-frame; setFrame bumps group version not member spatial; eviction/restore untouched | revert (frame is additive — old readers unchanged) |
| G2 | Client render model: ONE frame element per group — WindowManager renders the group's frame geometry (from the server frame when present); the active member's content controller mounts in it; switchTab swaps content ONLY (no rect change, no z-jump); inactive members' frames unmount | `public/js/window-manager.js`, `tests/frontend/freeform-window-manager.test.js` | discriminator: members with different rects grouped → switchTab keeps the rendered rect byte-identical; exactly one member visible | revert |
| G3 | Group-owned lifecycle: resize/dock/maximise/minimise/restore on a grouped member mutate the GROUP frame (group.setFrame + presentation intents on the group; member rows' spatial untouched); shelf/group exclusion unchanged (a shelved member leaves the group per existing canonical rules) | `public/js/window-manager.js`, `lib/workspace-v4.js` (ops as needed) | discriminator: resize a grouped window → server group.frame.rect changes, member spatial untouched (readV4 witness) | revert |
| G4 | Group gesture lock: one gesture per GROUP (the frame owns gestures); a second pointer on another member's tab is refused while a group gesture is live | `public/js/window-manager.js` | discriminator: two-tab simultaneous gesture refused by the group-scoped lock | revert |
| G5 | Reload + journey: init restores the group frame once; journey group steps (13-18) now exercise the frame; acceptance battery (different geometry → switch/resize/dock/max/min/restore/reload invariance) | journey + tests | suite; journey 26/26; smoke ok | revert |
| G6 | Gates: dual sequential review, closeout, checkpoint | docs | reviewer packets | docs |

## Dependency Order
G1 (protocol additive) first — the client reads a server-owned frame. G2 (render) after G1. G3 (lifecycle) after G2 (frame exists to mutate). G4 (lock) after G2. G5 integration. G6 gates. No forward dependencies.

## Done When
scope criteria 1-4 green; CLOSEOUT; cluster committed/pushed/reviewed.

## Next entry point (for the resuming session)
Read this shelf + Round-6 :19; implement G1 (group frame field + group.setFrame op + lib discriminators) before any client change.
