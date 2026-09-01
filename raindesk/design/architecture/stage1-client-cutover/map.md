# map.md — A-G2: cartography for the cutover cluster (integration branch b452dd1)

## Module Inventory
| path | role | owner |
|---|---|---|
| `public/js/v4-client.js` (NEW) | v4 wire client: actor/incarnation minting, durable intent outbox, typed-conflict surfaces | client intent/outbox lifecycle |
| `public/js/api.js` | HTTP surface for all browser calls; v3 workspace fns stay for other clients | request encoding |
| `public/js/window-manager.js` | WindowManager engine: models, gestures, groups, shelf, render (HOT SPOT: `renderFrame` fan-in 20, `get` 28) | freeform window UX + local cache |
| `lib/workspace-v4.js` | canonical v4 store: identities, tombstones, receipts, mutations, ops, readV4 | workspace truth for `window_*` |
| `server-core.js` | v4 routes (GET /api/workspace/v4, POST intents, GET receipt, PATCH spatial) + legacy tombstone guard | HTTP boundary |
| `lib/partner-actions.js` | Partner spatial action executor (applyAction/revert) | partner authority |
| `lib/workspace.js` | v3 store + legacy projection (UNTOUCHED this cluster) | truth for `world_*`/`panel_*` |
| `tests/frontend/v4-client.test.js` (NEW) | v4-client unit tests (mock fetch + localStorage) | — |
| `tests/frontend/freeform-window-manager.test.js` | WindowManager unit tests (fake DOM) | — |
| `lib/tests/partner-actions.test.js` | partner v4-path tests | — |
| `dev/browser-freeform-desk-journey.js` | 25-step native acceptance journey (HOT: boots both modes) | — |
| `public/js/app.js` | boot composition; `?freeform=1` wiring; `installSurfaces` deps (HOT: `$` fan-in 29) | mode gating |

## Entry Points
- Default boot: index.html → app.js (no freeform manager).
- `?freeform=1`: app.js → `RaindeskFreeformSurfaces.installSurfaces` → `WindowManager({api})` → NEW: `v4Client.replayOutbox()` THEN `init()` (readV4 restore) → auto-open scenes/layers only if empty.

## Data-Flow Seams (text diagram)
```
WindowManager (cache)
  ├─ intents (create/close/presentation/flags/groups/shelf/focus/viewport)
  │     → v4-client outbox [localStorage] → api.applyWorkspaceIntent
  │         → server-core POST /api/workspace/v4/intents → workspace-v4
  │     ← response {ok, changed, structuralRevision} (adopt refs; dequeue outbox)
  ├─ spatial patches (drag/resize/z) → api.patchWorkspaceSpatial (mutationId)
  │         → server-core PATCH …/spatial → workspace-v4
  │     ← {window.spatial, spatialVersion} (adopt; 410→drop/refetch, 409→refetch)
  └─ init() ← GET /api/workspace/v4 (readV4: windows/groups/shelf/focus/viewport)

Partner: partner-actions applyAction(window_* target)
  → workspace-v4 intent (server-side) → receipt+inverse carry WindowRef
```

## Where-Does-X-Live Index
- Window truth (`window_*`): `lib/workspace-v4.js`. Legacy truth (`world_*`/`panel_*`): `lib/workspace.js`.
- Actor identity: `localStorage['raindesk.v4.actor']` (minted once by v4-client).
- Pending intents: `localStorage['raindesk.v4.outbox']` (ordered, bounded).
- Typed conflict codes: workspace-v4 httpError extras (`code`, `tombstone`, `live`, `shelf`, `group`) surfaced via server-core v4Envelope.

## External Deps
- None new. Browser: fetch, localStorage, Pointer Events. Server: node stdlib only.

## Hot Spots
- `window-manager.js` — every write path changes; spike = title split (S0) before structural edits.
- `app.js` — freeform wiring block (`installSurfaces` deps) is the only touched region.
- `freeform-window-manager.test.js` — adapter mocks must flip from v3 fns to v4 shapes in lockstep with S4/S5.
