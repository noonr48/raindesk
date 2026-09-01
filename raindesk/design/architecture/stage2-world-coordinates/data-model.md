# data-model.md — Stage-2 SSOT

## Entities
- **WorldRect** — {x,y,width,height,rotation,scale} in canonical world units (value object; lives inside v4 rows' `spatial` and client models).
- **Viewport** — {x,y,zoom} persisted pan/zoom (owner today: v3 store via CreativeDesk; WindowManager becomes a reader through the projection).
- **Projection** — pure functions Viewport×metrics → world↔screen (owner: world-projection.js).

## Fields — v4 window row (relevant slice)
| field | type | meaning post-Stage-2 |
|---|---|---|
| space | 'world'\|'screen' | coordinate authority of `spatial` |
| spatial | WorldRect \| screen rect | world units when space=world |

## Invariants
- A row's `space` never changes at runtime; geometry units follow it.
- Screen persistence ONLY for registry surfaces classified `coordinateSpace:'screen'` (explicit chrome).
- Dock edges are presentation metadata, never coordinate transforms.

## State Owner
- Canonical geometry: `lib/workspace-v4.js`. Projection: `world-projection.js` (pure, no state). Viewport: CreativeDesk/v3 until Stage 3.

## SSOT Declaration
- ONE projection implementation. REJECTED: WindowManager keeping its own pixel math for world surfaces (dual authority — the Round-6 critical finding itself). REJECTED: converting artwork to screen units (artwork is the world authority).
- REJECTED: storing BOTH world and screen rects on a row (derived data is computed, never stored twice).

## Migration (expand-contract)
- EXPAND: projection module beside inline math (P0); `coordinateSpace` additive (P1); scenes skeleton (P2).
- BACKFILL: existing screen `window_*` rows → world using the persisted viewport AT MIGRATION TIME, one server-side step with a down-migration (P3) — own verified step, count-unchanged spot-check.
- CONTRACT: validator refuses mixed authority (criterion 2) only after backfill verified (P4).
