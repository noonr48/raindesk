# Stage-6 — PLAN (verify-wave clusters)

- **K1 Focus model** — focusFrame/unfocus + DOM focus on title, focusOrder recency, deterministic restore chain (close/minimise), :focus-visible CSS, frame role/aria-roledescription/aria-label, focus(windowId) moves DOM focus. Gates: unit tests (focus chain, aria attrs); suite green.
- **K2 Keyboard move/resize** — keydown on focused frame: arrows move (8/32px, space-correct via WProj, clampRect for screen, world canonical), Shift+arrows resize (minimumSize), debounced persist (one PATCH per ~120ms burst). Gates: unit tests incl. world-zoom invariant + intent recording; suite.
- **K3 Dock / maximise / minimise / close keys** — Ctrl+arrows dock/undock (existing snap lanes), Ctrl+Enter maximise↔restore, Ctrl+M minimise, Ctrl+W minimise-to-shelf (close requires Ctrl+Shift+W), announcer texts. Gates: unit tests asserting the exact v4 intents; suite.
- **K4 Tablist + group keys** — role=tablist/tab/aria-selected, Arrow L/R + Ctrl+Tab switch (group.activate), Ctrl+T tearOut, Ctrl+G pairwise group (recency pairing), announcer. Gates: unit tests; suite.
- **K5 Announcer + hit areas** — single polite region, lifecycle-derived announcements, resize-handle ≥20px invisible hit targets. Gates: unit tests + manual CSS check.
- **K6 Journey keyboard-only leg** — CDP key events end-to-end through the full acceptance sequence; focus-position + announcer assertions; zero console errors. Gates: journey green; matrix green (regression); suite green.

Rollback per cluster: revert the cluster commit; no schema/data migrations exist in this stage.
Closeout: dual-lens review (spec then implementation) → repairs → focused re-reviews → CLOSEOUT.md.
