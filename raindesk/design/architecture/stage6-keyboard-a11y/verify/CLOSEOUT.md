# Stage-6 — Keyboard / Accessibility — CLOSEOUT

HEAD 8799578 · branch chatgpt/raindesk-v2-integration · suite 485/485 · journey 38 steps (zero console errors) · matrix 6/6 · smoke ok · manager 82/82

## What shipped (K1–K6)
- **K1 focus model**: focus() MOVES DOM focus (the Round-5 gap) to the title (tabindex=-1); focusOrder recency (capped 16, stale-tolerant); deterministic restore chain on close/minimise (most-recent remaining visible frame → first shelf chip via Array.from → blur); restore() re-focuses; frames are named regions (role=region, aria-roledescription=window, aria-label tracking the title SSOT); :focus-visible rings.
- **K2 keyboard geometry**: arrows move 8px (Alt 32px) in the frame's OWN space (world: 8/worldScale via WProj inverse — constant on screen); Shift+arrows resize with universal registry-minimum floors (world/grouped/screen all); screen clampRect, world origins never clamp; grouped members nudge the GROUP frame (member latent; group.setFrame); 120ms per-window coalescing.
- **K3 lifecycle keys**: Ctrl+Enter maximise↔restore (grouped frames ride group.setFrame), Ctrl+M minimise, Ctrl+Shift+W real close (shift-guarded), Ctrl+arrows dock/undock (registry-gated; screen rail baked after transition; world latent per Stage-2 P2; floatingAt mirrors the drag lane). Every key rides the SAME v4 intent lanes pointer gestures emit (no-new-writers grep-verified).
- **K4 tablist**: role=tablist/tab/aria-selected/roving tabindex; tab arrows switch with roving focus (Array.from'd children); Ctrl+Tab cycles from the title AND re-focuses the new member (impl-F2); Ctrl+T tear-out; Ctrl+G pairwise grouping by focus recency (documented no-multi-select).
- **K5 announcer**: one polite role=status region; 14 lifecycle ops announce state-derived ≤120-char text at the persist/render seams; nbsp tick for re-announcement; resize handles ≥20px invisible ::after hit targets.
- **K6 journey keyboard-only leg** (journey steps 27–39): CDP Input.dispatchKeyEvent covering the FULL Round-5 acceptance verb sequence — open, focus, move, resize, dock, undock, group, switch, maximise/restore, tear, minimise, shelf-restore (Enter), close — with focus-position, announcer, aria-selected, and page-still assertions; zero-console gate LAST. Enter dispatch carries text '\r' for default activation.
- **F2 rename key** (spec-F4): plain F2 enters rename on titled surfaces (parity with dblclick).

## Review record (dual lens, all green)
1. Spec full (bg-mtj05dgm, 3b46a20): blocked ×5 → repairs 1698552 (HTMLCollection chip tier + .find-less discriminator; journey dock/undock verbs on the dock-capable surface — takes excludes docked and the registry gate correctly refuses it; universal minimum floors + discriminators; F2 key + recorded Ctrl+W cut; page-still assertion).
2. Spec focused (bg-mtj0k3e1, 1698552): **pass, no findings**.
3. Impl full (bg-mtj0rovl, 1698552): 8 attack surfaces verified clean (focusOrder, nudge races, dock mirrors, rename blocking, announcer mounting, modifier hygiene, discriminator non-vacuity, pointer/boot regression); advisory-blocked ×3 follow-ups → repairs 8799578 (rail re-baked after transition + rail-won discriminator; Ctrl+Tab re-focus + second-cycle discriminator; close() clearTimeout + zero-wire-call discriminator).
4. Impl focused r2 (bg-mtj156ux, 8799578): **pass, no findings** — structural reddening proofs for all three repairs.

## Journey-caught product fixes this stage
Stale tab strips on hidden members; unconditional rename-Enter blur (stole DOM focus); shelf restore re-focus; Array.from HTMLCollection (×2 sites); Enter '\r' activation; dock-verb surface gating.

## Honest limitations
- Fake DOM models no hidden→blur (real-DOM focus semantics proven only in the journey).
- Ctrl+Tab is browser-contingent where delivered; tab-strip arrows are the guaranteed lane.
- Screen-space surfaces are fixture-only today (all 7 production surfaces world) — the rail-clobber class is pinned by unit discriminator, not by production use.
- Screen-reader operation is proven at the ARIA-semantics/focus-determinism layer; no NVDA/VoiceOver automation.

## Scope deviations
- Ctrl+W minimise CUT with rationale (Chromium reserves it; false affordance) — recorded in scope.md amendments. None other.
