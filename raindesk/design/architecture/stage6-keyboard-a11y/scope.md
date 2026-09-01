# Stage-6 — Keyboard / Accessibility — SCOPE

## Mandate (Round-5 [major], Round-6 stage-6 gate)
"Complete keyboard and screen-reader operation" against the now-stabilized frame/ownership model. Acceptance: the full journey — open, focus, move, resize, group, switch, tear, minimise, restore, dock, maximise, close — keyboard-only; focus visible and deterministic; every state/selection change exposes correct role/name/selected state/status.

## In scope
- Managed DOM focus: one focus owner per frame; open() focuses; close/minimise restores deterministically (next window → shelf → stage); :focus-visible ring.
- Keyboard commands on the focused frame, routing through EXISTING manager ops + v4 intents (no new protocol ops, no new writers):
  - Arrows move (8px grid; Shift+Arrows resize; 4× with Ctrl held on top of arrows? no — keep: arrows/shift-arrows, Alt = 4× multiplier)
  - Ctrl+Left/Right/Up/Down: dock to edge / maximise (Up) / minimise (Down)
  - Ctrl+Enter: maximise↔restore toggle; Ctrl+M minimise; Ctrl+W minimise-to-shelf (close stays pointer/guarded Ctrl+Shift+W real close)
  - F2 on title: rename (contenteditable exists; Escape cancels)
  - Ctrl+Tab / Ctrl+Shift+Tab, and Arrow Left/Right in the tablist: switchTab; Ctrl+T: tearOut
  - Ctrl+G: group focused frame with the most-recently-focused OTHER frame (deterministic pairing — no multi-select model this stage)
  - Shelf chips: focusable buttons, Enter restores (chips are already <button aria-label>)
- ARIA: frame role="region" aria-roledescription="window" + accessible name = title; tablist/tab/aria-selected on group tabs; aria-live polite announcer for lifecycle (open/close/group/switch/dock/maximise/minimise/reflow bring-back).
- Resize-handle hit areas: invisible ≥20px hit target (visual 9–15px unchanged), stays aria-hidden (not in tab order — resize is keyboard-driven instead).
- Journey: keyboard-only leg covering the full acceptance sequence with focus-position + announcer assertions.

## Out of scope (recorded, not silent)
- Multi-window selection model (grouping >2 by keyboard, marquee select) — Ctrl+G pairwise covers the acceptance verb.
- Screen-reader-specific behavior beyond ARIA semantics (no NVDA/VoiceOver automation; semantics + focus determinism are the provable layer).
- Animatic-mode keyboard surface (freeform desk is the Round-5/6 target; animatic adapters come later in the adapter family).
- Persisting focus across reloads (focus is ephemeral presentation; workspace.focus field stays unused this stage).
