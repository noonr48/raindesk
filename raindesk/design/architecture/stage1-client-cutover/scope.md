# scope.md — A-G1: Stage-1 completion — client v4 cutover + durable outbox

## Problem
STAGE-1's identity/intent protocol ships server-side with ZERO browser consumers (repo grep: no `/api/workspace/v4` caller in `public/js`). WindowManager still writes ungated v3 upserts, whole-array groups/shelf, and delete-with-one-retry; Partner spatial actions execute against v3 without WindowRef; a failed close has no durable retry. This is exactly the STAGE-1 DESIGN migration-order steps 3–4 ("Move WindowManager to v4 create/intent/spatial APIs and durable outbox", "Route Partner workspace actions through the v4 executor") — unmet. The client remains the last un-upgraded writer the protocol was built to replace.

Additionally, a live-read caught the round-1 P0-class title model/DOM collision still present in `window-manager.js` `ensureFrame` (`model.title` is overwritten with the title span node), which the cutover must not carry forward.

## In Scope
- NEW `public/js/v4-client.js`: actorId minting (durable per browser), incarnationId minting per window, ordered intent outbox persisted to localStorage (replay-on-boot BEFORE auto-open), intent + spatial-patch wrappers with typed-conflict surfaces.
- `public/js/api.js`: additive v4 functions (getWorkspaceV4, applyWorkspaceIntent, getWorkspaceIntentReceipt, patchWorkspaceSpatial).
- `public/js/window-manager.js`: title model/DOM split fix; init() restores from `readV4`; persist() → spatial PATCH (mutationId); groups/shelf/presentation/flags/focus/close → intents with taxonomy-aware conflict adoption; 410 own-incarnation → drop local model + refetch.
- `lib/partner-actions.js` (v4 path): workspace actions against `window_*` targets execute as v4 intents; receipts and inverses carry WindowRef `{windowId, generation, incarnationId}`; revert of a reopened window must fail 409 INCARNATION_REPLACED.
- Tests: NEW `tests/frontend/v4-client.test.js`; freeform-window-manager tests re-based to v4 adapter shape; partner-actions lib tests for the v4 path.
- `dev/browser-freeform-desk-journey.js`: server-side workspace assertions switch to `GET /api/workspace/v4`.

## Out of Scope
- CreativeDesk / WorkspaceShell cutover (Stages 2–3; they keep v3 routes for `world_*`/`panel_*` namespaces).
- World-coordinate unification (Stage 2), duplicate-owner retirement (Stage 3), group-frame model (Stage 4), viewport recovery/matrix (Stage 5), keyboard/a11y (Stage 6).
- REMOVAL of v3 collection routes — separate later step, gated on a no-caller grep proof (design: "only after repository search proves no caller remains").
- IndexedDB migration for the outbox (localStorage suffices for bounded entries).
- Multi-tab v4 live sync UI (conflict adoption handles it silently; no push channel).

## Success Criteria (measurable)
1. BINARY: `rg "upsertWorkspaceObject|setWorkspaceGroups|setWorkspaceShelf|deleteWorkspaceWindow" public/js/window-manager.js` returns zero matches.
2. BINARY: deterministic test — reload with a pending close intent replays the outbox and the closed incarnation never reappears (server readV4 witness).
3. BINARY: `state().title` is always a string; group tab labels render the surface title string (discriminator test).
4. BINARY: Partner revert targeting a closed-and-reopened window returns 409 `INCARNATION_REPLACED` (lib test).
5. `npm test` all green (441 baseline + new tests); freeform journey `{"ok":true,"steps":25}`; animatic reload smoke `ok:true` (regression).

## Constraints
- No new dependencies; `?freeform=1` gating unchanged; default boot unchanged.
- `GET /api/workspace` (v3 projection) contract unchanged for `panel_*`/`world_*` consumers.
- Every client mutation idempotent (receipts/mutationIds) and taxonomy-aware (410/409/422 adoption rules named per code).
- Namespaces stay disjoint: v4 owns `window_*`; v3 keeps `world_*`/`panel_*` until Stages 2–3.

## Non-goals
- Outbox conflict-resolution UI beyond the existing warn-once surface (defer — no dual-writer scenario in scope).
- Optimistic structural sync between tabs (defer with Stage-5 viewport/recovery work).
