# GPT Pro review request — Raindesk Freeform Creative Desk v2, ROUND 4

You are reviewing a browser-based creative desk (vanilla-JS floating window manager over an art application). This is round 4. Round 3's verdict is committed in this repo at `docs/reviews/GPT_PRO_ROUND3_VERDICT.md` — read it first: its four fix-now findings were implemented, and its deferred roadmap is what this round should re-rank.

## Repo access

- REPO: github.com/noonr48/raindesk (private; you have connector access)
- BRANCH: `chatgpt/freeform-desk-v2`
- HEAD: `09978ee`

## What changed since round 3 (commits to review)

1. `295a044` — floating-window evolution: 8-way resize (RESIZE_DIRECTIONS with anchored-edge min clamping), visible 4-edge snap zones (cleared on settle AND severed gestures, Alt disables), `docked` in register() defaults and all seven real surface declarations, Beats migrated onto the registry, journey steps 8/24 rewritten.
2. `b0f2c5c` — round-3 triage fixes: canonical surface persistence (WINDOW_TYPES/SCREEN_TYPES gained take_stack/character_registry/notes_panel/partner_proposals; ENTITY_REF_RE admits characters:/notes:/proposals:; unknown types REJECTED with 400 instead of silent generic_panel coercion; read() repairs legacy coerced rows by stable windowId), durable docks (persist() sends the dock edge, applySnap stores it, drag-off-edge clears it, init() keeps docked windows docked and re-derives geometry from the stored edge), authoritative close (close() chains revision-aware deleteWorkspaceWindow through the write chain after pending saves), drag pointercancel as a dedicated terminal.
3. `09978ee` — gesture-session kernel + dock policies: per-window gesture lock (beginGesture/endGesture/abortGesturesFor) enforced at drag/8-way-resize/tab-tear/shelf-chip; kernel terminals = document pointercancel + visibilitychange(only when document.hidden); per-site severed-buttons guards (drag rolls back mutated rect; resize uses strict ===0); close() aborts live gestures; dockEdges policy (frozen, default ['left','right']), snapPlace/showSnapZones filter by policy (.blocked CSS masking), init() downgrades out-of-policy persisted rows, Takes opts out of docking entirely.

NOTE on deliberate scope cuts: window `blur` and `lostpointercapture` are NOT wired as cancel terminals. Probe-witnessed evidence (2026-08-23): spurious mid-gesture blur (focus churn / CDP attachment) rolled back healthy drags; lostpointercapture dispatches asynchronously with a recycled pointerId, making a stale prior-gesture release indistinguishable from genuine capture loss. The rationale comment sits above `endGesture` in `public/js/window-manager.js`. Challenge this decision if you disagree — but engage with the recorded evidence.

## Step 1 — gather current status from the repo

Read: `FREEFORM_DESK_V2.md` (§10 + §11 if present), `public/js/window-manager.js` (full), `public/js/freeform-surfaces.js`, `public/js/app.js` (freeform gating), `public/js/workspace-ui.js`, `public/css/freeform-desk.css` (snap zones), `lib/workspace.js` (schema v3, validation, repair), `dev/browser-freeform-desk-journey.js`, `tests/frontend/freeform-window-manager.test.js`, `tests/frontend/freeform-surfaces.test.js`, `docs/reviews/GPT_PRO_ROUND3_VERDICT.md`.

## Step 2 — produce the comprehensive review

Answer these ranked questions:

- Q1. Round-3 fix verification: are the four `b0f2c5c` fixes sound and complete? Hunt residuals — e.g. stale-writer resurrection paths around close-delete, dock geometry restore coordinate space, repair-migration edge cases.
- Q2. Gesture kernel soundness: lock lifecycle across all four sites and every terminal (commit/cancel/severed/close); multi-pointer races the lock does/doesn't close; do you CONCUR with the blur/lostpointercapture cuts given the recorded evidence, and what residual risk do the cuts create?
- Q3. Dock-policy rollout: is left/right-only + Takes opt-out right? Remaining artist-facing surprises (resize-off-edge on a docked window, viewport resize reflow, docked content sizing)?
- Q4. Re-rank the still-open round-3 majors under the CURRENT state: two coordinate authorities (world vs screen), group/shelf whole-collection retry races, bespoke ownership retirement, accessibility, multi-viewport test matrix. What moved up, what moved down?
- Q5. New seams introduced by 295a044/b0f2c5c/09978ee not covered above — find what we cannot see.

## Output contract (strict)

- Findings ONLY, severity-ranked (critical/major/minor). No praise.
- Each finding: [severity] location anchor (file + function/range) -> mechanism (what breaks, input -> bad outcome) -> concrete recommendation -> acceptance test.
- Prefix SPECULATIVE where you cannot anchor to included code.
- End with: TOP-3 next work items ranked by impact/effort, each with an acceptance criterion.
