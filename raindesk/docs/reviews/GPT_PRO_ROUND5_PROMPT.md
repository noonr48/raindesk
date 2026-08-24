# GPT Pro review request — Raindesk Freeform Creative Desk v2, ROUND 5

You are reviewing a browser-based creative desk (vanilla-JS floating window manager over an art application). Round 5. Round 4's verdict is committed at `docs/reviews/GPT_PRO_ROUND4_VERDICT.md` — read it first: its bounded fix-now slice is implemented, and this round should verify those fixes and produce an updated roadmap.

## Repo access

- REPO: github.com/noonr48/raindesk (private; you have connector access)
- BRANCH: `chatgpt/freeform-desk-v2`
- HEAD: `9e4a981`

## What changed since round 4 (commits to review)

1. `d4589c0` — round-4 triage fixes:
   - Close is truly authoritative: delete enqueued UNCONDITIONALLY after pending writes (the old model.persisted gate raced the first upsert — open() then immediate close() resurrected the row); revision adopted from `res.workspace.revision`; 409 adopts `error.workspace` and retries once; an absent row is success.
   - Dock durability through the shelf: `restore()` returns a minimised window to its stored dock edge (geometry re-derived via dockRect) when policy allows; `restoreAt` (explicit placement) undocks first; `init()` downgrades out-of-policy rows, clears the stale edge, AND persists the repair immediately.
   - Kernel hardening: resize acquires the gesture lock BEFORE setPointerCapture; tab-tear and shelf-chip moves cancel on buttons === 0 (strict, tolerating synthetic events).
   - Docked resize invariant (partial): pulling a docked window's ANCHORED edge explicitly undocks it.
   - supportedStates exposed as a frozen ARRAY (was a mutable Set reachable through the frozen registry).
2. `9e4a981` — journey repair (spec-lens F1): journey step 19 now REALLY asserts rect equality across reload (pre-reload scenes rect captured before the step-18 reload, compared verbatim after restoration; drift fails with both rects).

## Step 1 — gather current status from the repo

Read: `docs/reviews/GPT_PRO_ROUND4_VERDICT.md` (round-4 context + what was deferred), `FREEFORM_DESK_V2.md`, `public/js/window-manager.js` (full — close/restore/init/resize/kernel/policy paths), `public/js/freeform-surfaces.js`, `lib/workspace.js` (delete semantics: the bare 404 without workspace attach, revision gating), `dev/browser-freeform-desk-journey.js` (steps 8, 18, 19, 24), `tests/frontend/freeform-window-manager.test.js` (close-race, shelf-dock, init-repair, severed, lock, policy tests).

## Step 2 — produce the comprehensive review

Answer these ranked questions:

- Q1. Round-4 fix verification: are the five `d4589c0` fixes sound and complete? Hunt residuals — e.g. the single 409 retry on close-delete, init repair persist failure handling (console.warn only), anchored-edge-undock rollback coherence (cancel after undock reverts to the docked rect under floating state), frozen-array completeness (any remaining mutable policy surface?).
- Q2. Evidence adequacy: with journey step 19 now asserting rect equality, is the evidence base adequate for the fixed class? Which of the round-4 "cannot falsify" critiques remain open (mutation testing, multi-viewport, deferred-promise wire races)?
- Q3. Roadmap sequencing: re-rank the still-open items under the current state — world-coordinate unification (round-3+4 critical), group/shelf intent-based server transactions, group-frame model, bespoke ownership retirement, a11y keyboard surface, viewport reflow + multi-viewport matrix. The owner wants a concrete recommended order with rationale.
- Q4. New seams introduced by `d4589c0`/`9e4a981` not covered above.
- Q5. Anything in the round-4 verdict you now consider WRONG or overstated, given the current code?

## Output contract (strict)

- Findings ONLY, severity-ranked (critical/major/minor). No praise.
- Each finding: [severity] location anchor (file + function/range) -> mechanism (what breaks, input -> bad outcome) -> concrete recommendation -> acceptance test.
- Prefix SPECULATIVE where you cannot anchor to included code.
- End with: TOP-3 next work items ranked by impact/effort, each with an acceptance criterion.
