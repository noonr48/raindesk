# scope.md — Stage-5: viewport recovery + responsive reflow (Round-5/6 [major] viewport finding)

## Problem
Live and restored geometry is not responsive (Round-5 GPT_PRO_ROUND5_VERDICT.md:21, reaffirmed by Round-6's stage order): clampRect constrains sizes but leaves persisted x/y alone; right/bottom docks detach after viewport changes; off-screen title bars become unreachable; the manager has no stage-resize entry point; the journey is fixed at one viewport. Round-6's stage gate: "recoverable equivalent geometry across the viewport matrix".

## In Scope
- A `reflow(viewport)` entry point on WindowManager: responsive normalization after stage resize — reachable-titlebar invariant (every open window's controls reachable), dock re-anchoring (docked frames re-derive rail geometry from the new metrics or explicitly float), frame rect clamping that PRESERVES canonical world geometry (projection re-derives; only screen-frame edges clamp), and a bring-all-into-view command for stranded windows.
- Group frames: the GROUP frame participates in reflow (anchored docks re-derive; members render at the frame — one reflow per group).
- The viewport/browser matrix: the journey (or a companion harness) boots at 320×568, 768×1024, 1280×720, 1440×900, and ultrawide — seeded extreme/oversized positions must converge to reachable geometry at first load AND under continuous resize; pre/post-reload geometry equivalent.
- CreativeDesk already re-derives the world projection per resize (Stage-2 getViewport wiring) — world surfaces re-project for free; the reflow owns the SCREEN-frame edge cases and dock anchoring.

## Out of Scope
- Keyboard/a11y (Stage 6), adapter family, mobile/pointer-model changes (matrix is desktop viewports), multi-instance viewport arbitration.

## Success Criteria (measurable)
1. BINARY discriminator: seeded off-screen/detached/oversized rows → first-load reflow yields reachable controls for every open window at each matrix viewport.
2. BINARY: continuous resize preserves reachable controls and dock anchoring (or explicit float); no persisted row is destructively rewritten by a projection change (canonical rects survive — Stage-2 invariant).
3. Suite green; the matrix harness green across the five viewports; journey 26/26 unchanged.
