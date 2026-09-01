# Stage-6 — MAP (seams touched)

- public/js/window-manager.js — focus model (focusFrame/DOM focus, restore chain), keyboard handler on frames + document-level command dispatch (Ctrl+G pairing, shelf), tablist semantics in renderGroupTabs, announcer wiring, keyboard move/resize → existing persist lanes, dock/maximise/minimise/tear/switch keys → existing ops.
- public/css/freeform-desk.css — :focus-visible ring for frames/tabs/chips; resize-handle invisible ≥20px hit areas (padding/::after).
- public/js/app.js — one live announcer region mount; no route changes.
- dev/browser-freeform-desk-journey.js — keyboard-only leg (Input.dispatchKeyEvent): open → focus assert → move → resize → group (Ctrl+G) → switch tabs → maximise/restore → minimise → shelf keyboard restore → tear-out → close; announcer + focus assertions.
- tests/frontend/freeform-window-manager.test.js — unit gates: keydown dispatches (title.keydown / document keydown), move/resize rect deltas (screen + world canonical), dock/max/min intents recorded, tablist aria + switch, tear-out, focus chain on close/minimise, announcer text, no-new-writers (all through v4 intents).

Seam discipline: keyboard is a PRESENTATION-layer trigger. Every mutation rides existing ops (focus/minimise/restore/restoreAt/maximise/tearOut/switchTab/drag-equivalents) → existing v4 intents. Zero new protocol ops; zero direct store writes.
