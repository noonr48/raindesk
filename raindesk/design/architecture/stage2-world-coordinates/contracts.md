# contracts.md — Stage-2 seams

## world-projection module
- **Surface:** `public/js/world-projection.js` (UMD like siblings).
- **Signature:** exports { MIN_ZOOM, MAX_ZOOM, WORLD_SIZE, cleanViewport, baseScale, worldScale, worldToScreen, screenToWorld, zoomAround, focusViewport } — byte-identical semantics to creative-desk.js:26-70.
- **Preconditions:** metrics {width,height} ≥1; viewport finite.
- **Postconditions:** pure functions; no DOM, no store.
- **Errors:** clampZoom bounds violations clamp (never throw).
- **Idempotency:** N/A — pure.
- **Versioning:** additive exports only.

## Surface classification
- **Surface:** registry `coordinateSpace: 'world'|'screen'` (freeform-surfaces register defs).
- **Signature:** default 'world' for content surfaces; screen requires explicit declaration.
- **Errors:** unknown value → registration 400 (registry validates like supportedStates).
- **Idempotency:** N/A (declarative).

## WindowManager world geometry
- **Surface:** window-manager geometry paths behind `coordinateSpace === 'world'`.
- **Signature:** model.rect holds WORLD units; renderFrame computes screen placement via worldToScreen; pointer drag/resize deltas divided by worldScale; persisted spatial PATCH carries world units (v4 lane unchanged — it already stores what it is given).
- **Postconditions:** criterion-1 discriminator (beside-artwork invariance).
- **Errors:** projection never throws; clampRect semantics preserved in world units.
- **Idempotency:** existing v4 lanes unchanged.
- **Versioning:** screen surfaces keep today's path verbatim (parallel-run, migrate readers, delete old — P4's contract step).

## v4 backfill (P3)
- **Surface:** lib/workspace-v4 migration on read-once upgrade.
- **Signature:** screen `window_*` rows: spatial ×(viewport transform at migration time) → world; sets space='world'; writes migration-repair receipt; down-migration inverts.
- **Errors:** corrupt viewport → row floats at identity transform + receipt marks it.
- **Idempotency:** schemaVersion bump gates re-application.
