# map.md — Stage-2 cartography

## Module Inventory
| path | role | owner |
|---|---|---|
| `public/js/world-projection.js` (NEW, P0) | the ONE world↔screen projection (baseScale, worldScale, worldToScreen, screenToWorld, zoomAround, focusViewport, cleanViewport) | coordinate projection |
| `public/js/creative-desk.js` | CreativeDesk world engine; currently owns the transform math in-file (:26-70) — becomes a CONSUMER | world artwork objects (`world_*`, v3 store until Stage 3) |
| `public/js/window-manager.js` | WindowManager engine; screen-pixel rects (clampRect/defaultRect/renderFrame/installDrag/installResize/dock geometry) — becomes a CONSUMER for world surfaces | freeform window UX |
| `public/js/freeform-surfaces.js` | registry: surfaces gain `coordinateSpace` | surface classification |
| `lib/workspace-v4.js` | canonical store: `spatial` already world-unit for `space:"world"` rows; P3 backfill reclassifies `window_*` screen rows | workspace truth |
| `dev/browser-freeform-desk-journey.js` | acceptance: gains the Round-6 beside-artwork discriminator | — |
| `tests/frontend/creative-desk.test.js`, `freeform-window-manager.test.js`, `lib/tests/workspace-v4.test.js` | pin extraction purity, classification, backfill | — |

## Entry Points
- `?freeform=1` boot → v4 replay → init (readV4) → open/render through the projection for world surfaces.
- CreativeDesk init → projection module (unchanged behavior post-P0).

## Data-Flow Seams
```
persisted viewport (pan, zoom) ──┐
                                 ├→ world-projection.js ─→ worldToScreen(rect) → frame CSS
pointer deltas (screen px) ──────┘   screenToWorld(dx)/scale → world-unit deltas → model.rect + spatial PATCH (world)
```

## Where-Does-X-Live
- Projection math → world-projection.js (sole author). CreativeDesk + WindowManager read it.
- Canonical geometry → v4 `spatial` (world units for world surfaces).
- Viewport → v3 store until CreativeDesk migrates (Stage 3); WindowManager reads it via the projection's input.

## Hot Spots
- `creative-desk.js` transform block (fan-in: every world render + gesture).
- `window-manager.js` geometry paths (clampRect/renderFrame/installDrag/installResize/applySnap/dockRect) — all re-plumbed through the projection for world surfaces.

## External Deps — none new.
