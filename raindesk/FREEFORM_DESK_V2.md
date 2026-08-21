# Freeform Creative Desk v2 — Architecture & Mission

Status: ACTIVE mission (2026-08-21). Source: GPT Pro implementation prompt (owner-relayed).
Branch: `chatgpt/freeform-desk-v2` (off `main` @ 0fd4d1d — deliberately NOT off the
animatic PR16 branch; that PR stays independently mergeable and its surfaces are
absent from this line).

> One application window. One living creative desk. Any creative surface may be
> opened, floated, grouped, expanded, minimised, returned to a tab, or brought
> forward without interrupting the artist's train of thought.

## 1. Core architecture decision (five-lens recon, 2026-08-21)

**World-space unified window model.** All creative windows live inside the
pannable/zoomable desk world (the `creative-desk.js` viewport model), not in a
screen-space panel layer. Rationale:

- The mission's feel is PureRef/storyboard-wall: panning the desk moves the
  windows with it; zooming out reveals the whole chaotic desk; "off-screen"
  recovery is world-clamping + reveal-active, not viewport pixel clamping.
- The proven v1 primitives already live there: deferred-capture header drag
  (3px threshold, document-capture listeners), put-away drop-on-tabs hit-test,
  tab tear-out (>10px), rename coexistence, `elementsFromPoint` topmost
  claiming, render-time listener teardown.
- One coordinate authority. The v1 split (screen-space
  `.workspace-floating-panel` vs world-space `.creative-sheet`) is the bespoke
  dual system this mission retires.

The shot canvas remains the locked 1024×1024 world object it already is; it
becomes "the dominant window" through size and focus, never through structural
specialness.

**Registry, not constructor patches.** `CreativeSurfaces.register()` (new
`public/js/window-manager.js`) owns frame rendering, movement, resize, z-order,
groups/tabs, shelf, snap, focus, persistence, and lifecycle. Each feature owns
only content. `WorkspaceShell`'s instance layer is replaced; its pure geometry
helpers (`normalizedRect`, `dockRect`, `edgeSnap`, `peerSnap`,
`toWorkspaceObject`) are reused by import.

## 2. Window state machine

Per window: `floating | tabbed | docked | minimised | maximised` (single
derived `state`) + boolean flags `collapsed`, `pinned`, `locked`. Transitions
are a guarded reducer in `window-manager.js`; every transition emits exactly
one persistence event. Group membership (`groupId`) is orthogonal to state; a
tabbed window's rect belongs to its group frame.

## 3. Workspace schema v3 (server-side migration)

```json
{
  "schemaVersion": 3,
  "revision": 1,
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "activeWindowId": "window_shot_main",
  "windows": [{
    "windowId": "window_reference_main",
    "type": "board", "space": "world",
    "entityRef": "sheet:references_main",
    "x": 940, "y": 110, "width": 430, "height": 390, "zIndex": 12,
    "state": "floating", "groupId": null,
    "collapsed": false, "pinned": false, "locked": false
  }],
  "groups": [{ "groupId": "g1", "windowIds": ["w1", "w2"], "activeWindowId": "w2" }],
  "shelf": { "windowIds": ["window_partner"] }
}
```

- **Migration** (server-side, in `read()`, mirroring the v1→v2 pattern):
  objects→windows (`windowId=id`, `minimised ⇐ visible===false && collapsed`),
  synthesize `groups[]` from existing `groupId` values (already persisted,
  previously unread), `activeWindowId ⇐ activeObjectId`, one-time `.bak`
  backup before the in-place rewrite, unknown versions stay fail-closed 500.
- **Concurrency**: monotonic integer `revision` bumped on every `write()`.
  Structural writes (window create/delete, group/shelf changes) require
  `baseRevision` → 409 + current state on mismatch (sheet-documents
  precedent). High-frequency spatial drags stay last-write-wins.
- **Validation**: whitelist-and-reject (not silent-drop): typed `entityRef`
  (`^(sheet|shot|comic_page|character|note|board|partner|beats|layers|scenes|takes):…`),
  unique `windowId`s, referential integrity for groups/shelf/activeWindowId,
  numeric clamps retained.
- `space`/`dock` retained from v2 (utility docking state must survive
  migration).

## 4. Gesture ownership (explicit, test-enforced)

| Gesture | Owner | Mechanism |
|---|---|---|
| Blank-desk drag | desk pan | `#canvas`/world background pointerdown |
| Wheel on desk | desk zoom (cursor-anchored) | existing `zoomAround`; window frames exempt |
| Window header drag | window move | deferred capture (>3px), document-capture listeners |
| Window body | content edit | content `pointerdown` (drawing, text, boards) |
| Tab drag | tear-off / regroup | >10px tear threshold, `justTore` click suppression |
| Resize grips | resize | grip-owned pointers, min-size per surface |
| Space+drag / middle | temporary pan | `body.desk-panning` mode |
| dblclick on title | rename | movement-threshold coexistence (v1 proven) |

Modifier key (Alt) temporarily disables snapping. Snap previews are
non-committal; Escape cancels a pending drop.

## 5. Migration order (coupling-measured, within GPT's Phase 1 set)

1. **Scenes + Layers** — already shell-registered; extract `app.js` renderers
   into surface modules; zero scrim/wrapper entanglement.
2. **Reference Board** — already a world sheet; unify its MutationObserver
   chrome injection into the registry.
3. **Beats** — registered; `refresh/setShot` coupling moves behind the
   registry's focus events.
4. **Partner LAST** — highest coupling: scrim close, mobile fallback (the
   workspace shell is disabled <900px today), `surface-handoff` hard-targets,
   server `move_panel` action ids, global resize side effects.

Bespoke layout code that REMAINS after v2 Phase 3 (deliverable 12, from
recon): drawer overlay logic (`chat.js:56-112`, `app.css:254-268`),
desktop-docked rail (`app.css:419-424`), `dtab` tabs, `drawerHandle`,
scene strip (`app.js:1115-1136`), beat-trail head chrome, lanes sheet modal
scrim (`app.js:1219-1253`), Escape god-closer (`app.js:781-790`),
`surface-handoff` constructor wrapper. Each gets an owner + phase in the
closeout doc; removal only after replacements are proven.

## 6. Empty-project mode (Phase 1 blocker)

Today a fresh `RAINDESK_DATA_DIR` still self-seeds S01–S07 (`board.js:25`),
auto-places BUILTIN_SHEETS, and paints stock rain-city art. The acceptance
journey's steps 1–2 (genuinely empty, no stock artwork) require a v2
empty-mode: seeding becomes explicit (first-run choice / demo opt-in), not
implicit. Implementation lands with Phase 1 so the journey can assert
emptiness honestly.

## 7. Test strategy

- **Deterministic (node:test)**: window state machine transitions, snap
  geometry, schema v3 migration + validation + 409 concurrency, off-screen
  clamping, undo stack — fake-DOM pattern from the sibling PR16
  (`drawer-dom-ownership.test.js`) for controller-level behavior.
- **Native browser**: `dev/browser-freeform-desk-journey.js` (the 25-step
  acceptance, phase-tracked receipt + failure diagnostics per the animatic
  smoke contract) + `dev/browser-freeform-desk-regressions.js` (interrupted
  pointers, release-outside, dblclick-vs-drag, tab-drag over overlaps,
  ghost-drag, high-DPI `Emulation.setDeviceMetricsOverride`, zoom,
  keyboard focus, reduced-motion, small screen, mobile one-surface).
- **CI**: `.github/workflows/freeform-desk-v2.yml` on the
  animatic-source-snapshot pattern (env receipts, upload if:always()).

## 8. Phases

1. **Registry + window frame** (window-manager.js, geometry split, schema v3 +
   migration + revision concurrency, empty-mode, migrate Scenes/Layers/
   Reference/Beats; Partner when mechanics hold). Mechanics before visuals.
2. **Tear-off tabs + grouping + shelf semantics** (world-space groups with
   tab strips, minimise-to-shelf, active-tab restore).
3. **Migrate remaining surfaces** (Takes, character sheets, notes; retire
   bespoke code only after replacements proven).
4. **Contextual tools + spatial Partner suggestions** (reversible proposals
   only; existing authority model untouched).
5. **Paper-desk visual language** (warm ivory/paper tokens, sheet materials,
   shadows, snap previews, subtle motion + reduced-motion; content stays
   visually dominant).
6. **Acceptance + hardening** (25-step journey green across viewports,
   mobile evidence, recording/sequential screenshots, honest limitations).
