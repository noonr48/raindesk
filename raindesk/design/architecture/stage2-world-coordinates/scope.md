# scope.md — Stage-2: canonical world coordinates (Round-6 CRITICAL)

> STATUS: SEED — written at the cutover-block boundary (e9ab016) so the next
> session starts on a committed contract. The full L-tier pass (map/
> data-model/contracts/risks refinement) happens BEFORE implementation.

## Problem
Two coordinate authorities coexist (Round-6 [critical], docs/reviews/GPT_PRO_ROUND6_VERDICT.md:5): CreativeDesk stores artwork in canonical world units through the persisted pan/zoom viewport, while every registry surface type defaults to `space:"screen"` and WindowManager persists raw stage-pixel rects. Panning/zooming moves artwork but not its logically adjacent surfaces — the two models cannot form a coherent endless desk or a future shared group frame.

## In Scope
- Canonical persisted geometry for creative surfaces becomes WORLD rect (x,y,w,h + rotation/scale) with one projection layer (world↔screen) feeding render + pointer deltas. CreativeDesk's transform math (creative-desk.js:42-70 worldScale/worldToScreen/screenToWorld/zoomAround) is the seed of that projection — promote it to ONE owned module both engines use.
- v4 store: `space:"world"` rows' spatial fields already carry world units (CreativeDesk writes world coords today via upsertObject); WindowManager's `window_*` rows migrate screen→world per expand-contract (additive `space` reclassification + one-time backfill from the current viewport, then enforce).
- Screen-space persistence restricted to EXPLICITLY classified application chrome (registry gains `coordinateSpace` per surface; default for existing content surfaces = world).
- Docking stays a temporary PRESENTATION (already true in v4 typed presentations) — never a second coordinate authority.
- Journey/acceptance: the Round-6 acceptance test (place a surface beside a marked artwork feature; pan, zoom, resize, reload, dock, minimise, restore, tear from group — canonical rect unchanged, artwork relationship invariant).

## Out of Scope
- Duplicate-owner retirement (Stage 3), group-frame model (Stage 4), viewport recovery/matrix (Stage 5), keyboard/a11y (Stage 6).
- CreativeDesk/WorkspaceShell v3-route migration off `world_*`/`panel_*` (Stage 2/3 boundary per the STAGE-1 design — they may ADOPT the shared projection module without changing stores).

## Success Criteria (measurable)
1. BINARY: a surface placed beside a marked artwork feature keeps its world rect invariant (deterministic test) across pan/zoom/viewport-resize/reload/dock/minimise/tear.
2. BINARY: no surface persists mixed authority — a grep/validator proves every creative surface row is `space:"world"` with world-unit spatial, screen only for classified chrome.
3. Suite green + journey 25/25 + animatic smoke (regression).

## Constraints
- Round-6 order is fixed; Stage-2 precedes owner retirement/group frames.
- Expand-contract: never break-and-fix the persisted store; backfill is its own verified step with a down-migration.
- One projection module, one owner (SSOT); WindowManager and CreativeDesk both become its CONSUMERS.

## Non-goals
- Infinite-canvas tiling/chunking (no requirement yet).
- Multi-viewport simultaneous rendering (Stage 5).
