# plan.md — Stage-2 skeleton (seed; refine with full gates before S1)

| id | change | files | verify hook | rollback |
|---|---|---|---|---|
| P0 | Extract the projection module (worldScale/worldToScreen/screenToWorld/zoomAround/focusViewport) from creative-desk.js into public/js/world-projection.js; CreativeDesk consumes it unchanged | `public/js/world-projection.js` (NEW), `public/js/creative-desk.js` | creative-desk unit tests green unchanged (pure extraction) | revert (creative-desk inlines again) |
| P1 | Registry surfaces gain `coordinateSpace: 'world'|'screen'` (content surfaces default world; chrome explicit screen); WindowManager consults it at open/init | `public/js/window-manager.js`, `public/js/freeform-surfaces.js`, tests | registry tests: classification present for every surface | revert |
| P2 | Walking skeleton: ONE surface (scenes) renders through the projection (world rect → screen placement) with drag/resize deltas unprojected; persists world units via the v4 spatial lane | `window-manager.js`, `world-projection.js`, journey step | Round-6 acceptance discriminator: scenes beside artwork survives pan/zoom/resize/reload (canonical world rect witness) | revert to screen-space for scenes only |
| P3 | Backfill: legacy `space:"screen"` rows for world-classified surfaces convert at CLIENT restore through the live viewport+metrics (client-informed — the server lacks stage metrics; LEDGER L-4) and re-persist canonical world rects; new creates flag their coordinateSpace at birth | `public/js/window-manager.js` (open + init), tests | manager discriminator: screen-unit legacy doc row → world rect adopted + world spatial PATCH persisted | per-window: revert conversion block (legacy rows restore raw) |
| P4 | Migrate remaining surfaces through the projection (layers/beats/takes/characters/notes/proposals); screen stays only for classified chrome | window-manager + surfaces + tests | criterion 2 validator green; journey 25/25 | per-surface revert |
| P5 | Gates: full suite, journey (with the new acceptance discriminator), animatic smoke, dual sequential review, push; then deep-review | all | reviewer packets + gates | docs only |

## Dependency Order
P0 pure extraction first (zero behavior change). P1 classification is additive. P2 needs P0+P1 (the skeleton proves the whole path before batch migration — P-RIG: the riskiest assumption, projection correctness, is probed with ONE surface, not at P4). P3 backfill is its own verified step. P4 batches only after the skeleton passed. P5 last. No forward dependencies.

## Done When
scope.md criteria 1-3 green; shelf full gates (map/data-model/contracts/risks) completed and reviewed BEFORE S1 execution; cluster committed + pushed + dual-reviewed.

## Next entry point (for the resuming session)
Read this shelf + the Round-6 critical finding (GPT_PRO_ROUND6_VERDICT.md:5) + the cutover CLOSEOUT; complete the L-tier gates (map/data-model/contracts/risks) for THIS scope; then execute P0.
