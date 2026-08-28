# GPT Pro review request — Raindesk Freeform Creative Desk v2 (round 3)

You are reviewing a completed 6-phase implementation of a browser-based creative desk — plus a floating-window evolution pass landed on top of it — a vanilla-JS window manager ("freeform desk") layered over an existing Raindesk art application. You have NO repo access — everything you may consider is INLINE BELOW. Do not assume files exist beyond what is shown.

## Output contract (strict)
- Findings ONLY, severity-ranked (critical/major/minor). No praise, no summary of what we did well.
- Each finding: [severity] location anchor (file + function/range as given below) -> mechanism (what breaks, input -> bad outcome) -> concrete recommendation -> acceptance test (how we would prove the fix).
- If a concern cannot be anchored to included code, prefix it SPECULATIVE and keep it short.
- End with: TOP-3 next work items ranked by impact/effort, each with an acceptance criterion.

## Review questions (ranked)
Q1. Pointer-lifecycle robustness in the drag/resize/gesture paths (interrupted drags, pointercancel, release-outside, multi-pointer, DOM-vs-state desync windows) — what top guards are missing?
Q2. Persistence/concurrency: revision-gated structural writes (groups/shelf) vs last-write-wins object upserts, client-side revision adoption, serialization chain — what race or edge remains?
Q3. Surface-registry boundary integrity: does anything leak between registry-owned window bodies and bespoke layout code? Which bespoke remnants create the highest coupling debt, and in what order should they retire?
Q4. Interaction/UX quality: gesture thresholds (>10px tear threshold, Alt disables snap), keyboard/a11y/reduced-motion coverage, sub-900px behavior — what would a real artist hit first?
Q5. Test blind spots: the 25-step native journey runs single-viewport/headless — what regression harness cases are missing for a real artist session?
Q6. The docked-by-default rollout: every surface can now edge-dock. What artist-facing surprises or content-sizing failures does this create, and what per-surface opt-outs (if any) should be reintroduced?
Q7. TOP-3 next work items (this doubles as the closing triad).

## Mission snapshot
- Phases 1-6 landed on branch chatgpt/freeform-desk-v2, HEAD after these commits: cec9105 (registry+frame+schema v3), 72f1098 (drop zones look-through), 5b5ea6f/fafbb78/1ba7cb4 (Takes/Characters/Notes surfaces), 391e1b6/ff11406 (proposals surface + contextual strips), 7d2aa2c (paper-desk visuals), 6dda071 (25-step journey + persistence hardening), 7183534 (writeChain serialization), 8a3701d (init revision seeding), 490cb1e (two-desks convergence test).
- On top of the phases, HEAD 295a044 (feat(desk): floating-window evolution — 8-way resize RESIZE_DIRECTIONS n/s/e/w/ne/nw/se/sw with anchored-edge min clamping; visible 4-edge paper snap zones cleared on settle/severed gestures, Alt disables; docked added to register() defaults AND all seven real surface supportedStates after adversarial review caught silent opt-out; drag-off-edge re-floats; Beats surface migrated onto registry entityRef beats:... with bespoke shell gated behind !useFreeFormDesk).
- Deterministic suite 290/290 (node:test, fake-DOM); native Chromium smoke (normal+empty) green; 25-step acceptance journey green end-to-end against the real server after the last mutation (journey steps 8 and 24 were rewritten for the new contract: dock→re-float roundtrip + snap-ghost leak check).
- Persistence model: workspace schema v3 {windows[], groups[], shelf[], revision}; object upserts are last-write-wins and return the post-write revision; groups/shelf writes are revision-gated (409 carries current state); the client serializes ALL writes through one promise chain and adopts revisions monotonically.

## ARCHITECTURE DOC (FREEFORM_DESK_V2.md, verbatim)

````markdown
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
3. **Beats** — registered (was claimed registered on 2026-08-21 but actually
   bespoke until 2026-08-23); `refresh/setShot` coupling moves behind the
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

## 9. Phase status (2026-08-21)

Phases 1–6 landed on `chatgpt/freeform-desk-v2`, each phase verified by
the deterministic suite plus real-Chrome native runs before commit:

1. Registry + window frame + schema v3 + empty-mode (`cec9105`, suite 231).
2. Tear-off tabs + grouping + shelf semantics (`9285e30`…`72f1098`, battery 23).
3. Takes / Characters / Notes surfaces migrated onto the registry
   (`5b5ea6f`, `fafbb78`, `1ba7cb4`, suite 269). Bespoke retirement stays
   deferred until replacements are journey-proven per §5.
4. Contextual tools strips + Partner proposals surface — reversible chain
   approve→execute→accept only; authority model untouched (`391e1b6`,
   `ff11406`, suite 272).
5. Paper-desk visual language: ivory tokens, sheet materials, focus shadow
   tiers, live snap preview (docked surfaces only), reduced-motion
   (`7d2aa2c`, suite 274).
6. 25-step native acceptance journey (`dev/browser-freeform-desk-journey.js`)
   green end-to-end on empty-project mode, including drag→minimise→restore→
   group→tear→rejoin→reload survival, surface checks (takes/characters/
   notes), notes persistence across reload, and zero console errors.

Two journey-caught hardening fixes are part of Phase 6: (a) drop-to-group
hit-testing walks the `elementsFromPoint` stack (the dragged frame is
topmost under the cursor at release); (b) workspace revision is now
returned by `/api/workspace/object` and adopted (monotonic) by the client
so ungated upserts no longer desync gated groups/shelf writes — the
409 adopt-and-retry now works against the real server (ApiError carries
`workspace`), with per-route warned flags.

## 10. Floating-window evolution (2026-08-23)

Owner reference mockup (`/tmp/raindesk-vision-ref.png`) drove three gap-
closers on top of Phases 1–6:

1. **Free scale** — resize grew from a single corner grip to 8-way
   (`RESIZE_DIRECTIONS` n/s/e/w/ne/nw/se/sw in `window-manager.js`), each
   direction clamped against its anchored edge so per-surface minimumSize
   holds; gesture laws unchanged (pointerId filter, cancel-reverts,
   persist-on-commit, maximised refuses).
2. **Visible snap zones** — during a header drag of a dock-capable window,
   four paper-language edge drop zones render (`.freeform-snap-zones`,
   left/right/top/bottom at 32% depth), the settling edge emphasized;
   cleared on settle AND on severed gestures; Alt still disables.
3. **Snap for every window** — `docked` joined the register() default
   `supportedStates` AND every real surface declaration in
   `freeform-surfaces.js` (an earlier state left all seven surfaces
   explicitly opting out, which silently disabled snapping everywhere —
   caught by adversarial review). Drag off an edge re-floats a docked
   window.
4. **Beats migrated** onto the registry (surface id `beats`, entityRef
   `beats:…`); the bespoke desktop shell only mounts when the freeform
   desk did not (`useFreeFormDesk` gate).

Journey steps 8 and 24 were rewritten for the new contract (dock→re-float
roundtrips + snap-ghost leak check). Suite 290/290; journey {ok:true,
steps:25} witnessed after the last mutation.

Remaining honest limitations: single-viewport journey (mobile evidence
and regressions harness per §7 are future work); bespoke layout code of
§5 still present alongside the registry surfaces (Partner drawer, scene
strip, reference board sheet, shot canvas world object).
````

## public/js/window-manager.js — EXCERPTS (line ranges from the real file)

```javascript

/* ===== window-manager.js lines 143-181: persist() — last-write-wins upserts, monotonic revision adoption, single writeChain ===== */

    /* ------------------------------------------------------- persistence */

    function persist(model) {
      if (!api || typeof api.upsertWorkspaceObject !== 'function') return Promise.resolve(model);
      const next = writeChain.then(() => api.upsertWorkspaceObject({
        windowId: model.windowId,
        type: model.entityType,
        entityRef: model.entityRef || undefined,
        x: Math.round(model.rect.x), y: Math.round(model.rect.y),
        width: Math.round(model.rect.width), height: Math.round(model.rect.height),
        zIndex: model.zIndex,
        state: model.state,
        collapsed: model.collapsed,
        pinned: model.pinned,
        locked: model.locked,
      })).then((res) => {
        // Ungated upserts still bump the server revision; adopt it (monotonic —
        // an older response arriving late must never move it backward) so
        // gated structural writes (groups/shelf) do not fire stale.
        const rev = res && res.revision;
        if (Number.isFinite(rev)) lastRevision = Math.max(lastRevision, rev);
        model.persistFailed = false; return model;
      }).catch((error) => {
        // Bounded failure signal: persistence must not break the creative
        // flow, but a window that never reaches disk deserves one visible
        // warning per window, not silence (adversarial-review repair).
        if (!model.persistFailed) {
          model.persistFailed = true;
          console.warn(`[freeform] window ${model.windowId} is not persisting:`, error && error.message || error);
        }
        return model;
      });
      writeChain = next.catch(() => {});
      saves.set(model.windowId, next);
      return next;
    }

    /* ---------------------------------------------------------- rendering */

/* ===== window-manager.js lines 33-68: surface registry + register() defaults (docked now default-on) ===== */
  /* ------------------------------------------------------- surface registry */

  const registry = new Map();
  const SUPPORTED_STATES = new Set(['floating', 'tabbed', 'docked', 'minimised', 'maximised']);

  const CreativeSurfaces = {
    register(surface) {
      if (!surface || typeof surface !== 'object') throw new Error('surface definition is required');
      if (typeof surface.id !== 'string' || !/^[a-z0-9_]{1,48}$/.test(surface.id)) {
        throw new Error(`surface id must be a short slug: ${surface && surface.id}`);
      }
      if (registry.has(surface.id)) return registry.get(surface.id);
      const def = Object.freeze({
        id: surface.id,
        title: String(surface.title || surface.id),
        entityType: surface.entityType || 'generic_panel',
        createController: typeof surface.createController === 'function' ? surface.createController : null,
        minimumSize: Object.freeze({
          width: Math.max(120, Number(surface.minimumSize && surface.minimumSize.width) || 280),
          height: Math.max(90, Number(surface.minimumSize && surface.minimumSize.height) || 180),
        }),
        defaultPlacement: surface.defaultPlacement || { width: 460, height: 360, dock: null },
        // Every window snaps to the desk edges by default (owner reference:
        // all panels dock); a surface opts out by declaring its own list.
        supportedStates: new Set(
          (Array.isArray(surface.supportedStates) ? surface.supportedStates : ['floating', 'docked', 'minimised', 'maximised'])
            .filter((state) => SUPPORTED_STATES.has(state)),
        ),
        contextualTools: Array.isArray(surface.contextualTools) ? surface.contextualTools.slice() : [],
      });
      registry.set(def.id, def);
      return def;
    },
    get(id) { return registry.get(id) || null; },
    ids() { return [...registry.keys()]; },
    clear() { registry.clear(); },

/* ===== window-manager.js lines 79-83: resize directions + snap-zone edges ===== */
  const DRAG_THRESHOLD_PX = 3;

  /* 8-way resize: edge strips + corner pads, keyed by data-resize-dir. */
  const RESIZE_DIRECTIONS = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
  const SNAP_ZONE_EDGES = Object.freeze(['left', 'right', 'top', 'bottom']);

/* ===== window-manager.js lines 268-295: renderAll + guarded transition reducer (surface supportedStates gate, ALWAYS_ALLOWED) ===== */
    function renderAll() { for (const model of windows.values()) renderFrame(model); }

    /* ------------------------------------------------- state transitions */

    function transition(model, next) {
      const surface = surfaceFor(model);
      // Tabbing and floating are manager-level spatial lifecycle states every
      // grouped surface must accept; the surface gate covers content-affecting
      // states only (minimise/maximise/dock).
      const ALWAYS_ALLOWED = new Set(['floating', 'tabbed']);
      if (surface && !ALWAYS_ALLOWED.has(next) && !surface.supportedStates.has(next)) {
        throw new Error(`surface ${model.surfaceId} does not support state ${next}`);
      }
      model.state = next;
      if (next === 'maximised' && !model.restoreRect) {
        model.restoreRect = { ...model.rect };
      }
      if (next !== 'maximised' && model.restoreRect && next !== 'floating') {
        // leaving maximise always returns through floating geometry
        model.rect = { ...model.restoreRect }; model.restoreRect = null;
      }
      if (next === 'floating' && model.restoreRect) {
        model.rect = { ...model.restoreRect }; model.restoreRect = null;
      }
      if (next === 'minimised') model.collapsed = true;
      if (next === 'floating' || next === 'maximised') model.collapsed = false;
    }


/* ===== window-manager.js lines 296-349: snap preview + visible snap-zone render/clear lifecycle ===== */
    /* ------------------------------------------------------ gesture logic */

    /* Phase 5: live snap preview — a calm ghost of where a drag would
     * dock, cleared the moment the gesture settles. */
    let snapPreviewEl = null;
    function showSnapPreview(rect) {
      if (!rect) { if (snapPreviewEl) snapPreviewEl.classList.add('freeform-snap-preview-hidden'); return; }
      if (!snapPreviewEl) {
        snapPreviewEl = el(document, 'div', 'freeform-snap-preview');
        snapPreviewEl.setAttribute('aria-hidden', 'true');
        root.appendChild(snapPreviewEl);
      }
      snapPreviewEl.style.left = `${rect.x}px`;
      snapPreviewEl.style.top = `${rect.y}px`;
      snapPreviewEl.style.width = `${rect.width}px`;
      snapPreviewEl.style.height = `${rect.height}px`;
      snapPreviewEl.classList.remove('freeform-snap-preview-hidden');
    }
    function clearSnapPreview() {
      if (snapPreviewEl && snapPreviewEl.parentNode) snapPreviewEl.parentNode.removeChild(snapPreviewEl);
      snapPreviewEl = null;
    }

    /* Phase 6: visible edge drop zones while a docking-capable window is
     * dragged — four calm paper washes, one per desk edge; the zone
     * snapPlace() would settle into carries the accent emphasis. The layer
     * mounts lazily and switches off the moment any drag settles or tears
     * down (including the severed-gesture ev.buttons path). */
    let snapZoneHost = null;
    let snapZoneEls = null;
    function ensureSnapZones() {
      if (snapZoneHost) return;
      snapZoneHost = el(document, 'div', 'freeform-snap-zones');
      snapZoneHost.setAttribute('aria-hidden', 'true');
      snapZoneEls = new Map();
      for (const edge of SNAP_ZONE_EDGES) {
        const zone = el(document, 'div', `freeform-snap-zone ${edge}`);
        zone.setAttribute('aria-hidden', 'true');
        snapZoneHost.appendChild(zone);
        snapZoneEls.set(edge, zone);
      }
      root.appendChild(snapZoneHost);
    }
    function showSnapZones(activeDock) {
      ensureSnapZones();
      snapZoneHost.classList.add('on');
      for (const [edge, zone] of snapZoneEls) zone.classList.toggle('active', edge === activeDock);
    }
    function clearSnapZones() {
      if (!snapZoneHost) return;
      snapZoneHost.classList.remove('on');
      for (const [, zone] of snapZoneEls) zone.classList.remove('active');
    }


/* ===== window-manager.js lines 350-505: installDrag (zones, Alt, Escape, re-float), installResize (8-way), snapPlace/applySnap ===== */
    function installDrag(model) {
      const head = model.head;
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button,input,textarea,a,[contenteditable="true"],[data-no-drag]')) return;
        const current = windows.get(model.windowId); if (!current || current.locked) return;
        if (current.state === 'maximised') return; // maximised windows do not drag; restore first
        e.preventDefault();
        const surface = surfaceFor(current);
        const canDock = Boolean(surface && surface.supportedStates.has('docked'));
        const start = { x: e.clientX, y: e.clientY, ox: current.rect.x, oy: current.rect.y, pointerId: e.pointerId };
        // Deferred capture (>3px) so dblclick-to-rename survives; threshold
        // listeners live at DOCUMENT capture level because a steep drag can
        // leave the head rect on its first interpolated step (proven v1).
        let captured = false;
        const moved = (ev) => Math.abs(ev.clientX - start.x) > DRAG_THRESHOLD_PX || Math.abs(ev.clientY - start.y) > DRAG_THRESHOLD_PX;
        const onKeyDown = (ev) => {
          if (ev.key !== 'Escape') return;
          // Escape cancels a pending drop: pre-gesture geometry, overlays
          // gone, listeners detached — the gesture never commits.
          current.rect.x = start.ox; current.rect.y = start.oy;
          renderFrame(current);
          clearSnapPreview();
          clearSnapZones();
          teardown();
        };
        const teardown = () => {
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', up, true);
          document.removeEventListener('pointercancel', up, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
        const move = (ev) => {
          if (ev.pointerId !== start.pointerId) return; // foreign pointer: never steer another gesture
          if (!ev.buttons) { teardown(); clearSnapPreview(); clearSnapZones(); return; } // severed-gesture guard: also clear the dock ghost
          if (!captured) {
            if (!moved(ev)) return;
            captured = true;
            try { head.setPointerCapture(ev.pointerId); } catch (_e) {}
            bringToFront(current.windowId);
          }
          current.rect.x = start.ox + (ev.clientX - start.x);
          current.rect.y = start.oy + (ev.clientY - start.y);
          renderFrame(current);
          // Phase 5: preview the dock the drag would settle into.
          // Phase 6: light up the four edge zones, emphasizing the one
          // snapPlace() would choose. Alt disables snapping entirely —
          // zones included.
          const preview = snapPlace(current, ev.altKey);
          if (canDock && !ev.altKey) showSnapZones(preview ? preview.dock : null);
          else clearSnapZones();
          showSnapPreview(preview ? preview.rect : null);
        };
        const up = async (ev) => {
          if (ev.pointerId !== start.pointerId) return; // foreign pointer cannot commit or tear down
          teardown();
          clearSnapPreview();
          clearSnapZones();
          try { if (captured) head.releasePointerCapture(ev.pointerId); } catch (_e) {}
          if (!captured || !moved(ev)) return; // a click is not a drag
          // Put-away drop zones take precedence over snapping (Phase 2):
          // release over the shelf minimises; release over another window
          // joins that window's stack.
          const drop = resolveDropZone(ev.clientX, ev.clientY, current.windowId);
          if (drop && drop.kind === 'shelf') { minimise(current.windowId); return; }
          if (drop && drop.kind === 'group') { joinGroup(current.windowId, drop.targetWindowId); return; }
          const snapped = snapPlace(current, ev.altKey);
          if (snapped) applySnap(current, snapped);
          else if (current.state === 'docked') transition(current, 'floating'); // dragged off the edge re-floats
          renderFrame(current);
          await persist(current);
        };
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', up, true);
        document.addEventListener('pointercancel', up, true);
        document.addEventListener('keydown', onKeyDown, true);
      });
    }

    /** 8-way resize over n/s/e/w strips plus the four corners. Gesture laws
     * are identical to v1: initiating-pointerId filters everywhere,
     * pointercancel reverts to the pre-gesture rect (never commits),
     * persistence happens only on commit, maximised windows refuse. */
    function installResize(model, handles) {
      const grips = Array.isArray(handles) ? handles : [handles];
      for (const grip of grips) {
        grip.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          const current = windows.get(model.windowId); if (!current || current.locked) return;
          if (current.state === 'maximised') return;
          e.preventDefault(); e.stopPropagation();
          const dir = grip.dataset.resizeDir || 'se';
          try { grip.setPointerCapture(e.pointerId); } catch (_e) {}
          const surface = surfaceFor(current);
          const min = surface ? surface.minimumSize : { width: 200, height: 140 };
          const start = { x: e.clientX, y: e.clientY, rect: { ...current.rect }, pointerId: e.pointerId };
          const move = (ev) => {
            if (ev.pointerId !== start.pointerId) return; // foreign pointer
            const r = start.rect;
            let left = r.x; let top = r.y;
            let right = r.x + r.width; let bottom = r.y + r.height;
            // Moving edges clamp against the opposite (anchored) edge so the
            // per-surface minimum size holds; free edges simply grow/shrink.
            if (dir.includes('e')) right = Math.max(right + (ev.clientX - start.x), left + min.width);
            if (dir.includes('w')) left = Math.min(left + (ev.clientX - start.x), right - min.width);
            if (dir.includes('s')) bottom = Math.max(bottom + (ev.clientY - start.y), top + min.height);
            if (dir.includes('n')) top = Math.min(top + (ev.clientY - start.y), bottom - min.height);
            current.rect = { x: left, y: top, width: right - left, height: bottom - top };
            renderFrame(current);
          };
          const detach = () => {
            grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', cancel);
          };
          const up = async (ev) => {
            if (ev.pointerId !== start.pointerId) return; // foreign pointer
            try { grip.releasePointerCapture(ev.pointerId); } catch (_e) {}
            detach();
            await persist(current);
          };
          // Interrupted resize reverts to the pre-gesture rect instead of
          // committing half a gesture (GPT Pro round-4 finding).
          const cancel = (ev) => {
            if (ev.pointerId !== start.pointerId) return; // foreign pointer
            try { grip.releasePointerCapture(start.pointerId); } catch (_e) {}
            current.rect = { ...start.rect };
            renderFrame(current);
            detach();
          };
          grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', cancel);
        });
      }
    }

    /* --------------------------------------------------------- placement */

    function snapPlace(model, disableSnap) {
      if (disableSnap) return null;
      // Registry honesty: only surfaces that declare `docked` may dock —
      // offering a dock to a non-docking surface would throw on apply.
      const surface = surfaceFor(model);
      if (!surface || !surface.supportedStates.has('docked')) return null;
      const m = metrics();
      const rect = { ...model.rect, width: model.rect.width, height: model.rect.height };
      if (geo.edgeSnap) {
        const edge = geo.edgeSnap(rect, m, 18);
        if (edge && edge.dock) return { kind: 'dock', dock: edge.dock, rect: edge.rect };
      }
      return null;
    }
    function applySnap(model, snapped) {
      if (snapped.kind === 'dock') {
        model.rect = { ...snapped.rect };
        transition(model, 'docked');
      }
    }

    /* ------------------------------------------------------------ public */

/* ===== window-manager.js lines 942-981: put-away drop zones (resolveDropZone / frameDropZone) ===== */

    function pointInRect(x, y, rect) {
      return Boolean(rect) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }
    function rectOf(node) {
      if (!node || typeof node.getBoundingClientRect !== 'function') return null;
      try { return node.getBoundingClientRect(); } catch (_e) { return null; }
    }

    /** Put-away drop zones at drag release: the shelf (minimise) and other
     * windows (join their stack). Pure hit-testing, guarded for environments
     * without layout. The dragged window itself sits under the cursor at
     * release, so the hit must look THROUGH the element stack, not stop at
     * the topmost hit. */
    function resolveDropZone(x, y, draggedId) {
      if (shelfHostEl && pointInRect(x, y, rectOf(shelfHostEl))) return { kind: 'shelf' };
      if (typeof document.elementsFromPoint === 'function') {
        let stack = null;
        try { stack = document.elementsFromPoint(x, y); } catch (_e) { return null; }
        for (const el of (stack || [])) {
          const zone = frameDropZone(el, draggedId);
          if (zone) return zone;
        }
        return null;
      }
      if (typeof document.elementFromPoint !== 'function') return null;
      let hit = null;
      try { hit = document.elementFromPoint(x, y); } catch (_e) { return null; }
      return frameDropZone(hit, draggedId);
    }

    function frameDropZone(el, draggedId) {
      const frame = el && typeof el.closest === 'function' ? el.closest('.freeform-window') : null;
      if (!frame) return null;
      const targetId = frame.dataset && frame.dataset.windowId;
      if (!targetId || targetId === draggedId || !windows.has(targetId)) return null;
      const target = windows.get(targetId);
      if (target.state === 'minimised') return null; // over a shelf chip is the shelf case
      return { kind: 'group', targetWindowId: targetId };
    }

/* ===== window-manager.js lines 1028-1061: persistStructure — revision-gated groups/shelf writes, one adopt-and-retry on 409 ===== */
    }

    /** Structural persistence: groups + shelf through the revision-gated
     * API, with one adopt-and-retry on 409 and a bounded warning. */
    function persistStructure() {
      if (!api || typeof api.setWorkspaceGroups !== 'function') return Promise.resolve();
      const attempt = (baseRevision) => api.setWorkspaceGroups(
        [...groups.values()].map((g) => ({ groupId: g.groupId, windowIds: g.windowIds.slice(), activeWindowId: g.activeWindowId })),
        { baseRevision },
      ).then((res) => {
        const ws = res && res.workspace;
        if (ws && Number.isFinite(ws.revision)) lastRevision = Math.max(lastRevision, ws.revision);
        groupsWarned = false;
      }).catch((error) => {
        const ws = error && error.workspace;
        if (!ws || !Number.isFinite(ws.revision)) {
          if (!groupsWarned) {
            groupsWarned = true;
            console.warn('[freeform] window groups are not persisting:', error && error.message || error);
          }
          return;
        }
        // Adopt even when the retry is latched off: a stale token must never
        // outlive a conflict we chose not to retry.
        lastRevision = Math.max(lastRevision, ws.revision);
        if (baseRevision !== null && !groupsWarned) {
          groupsWarned = true;
          return attempt(ws.revision);
        }
      });
      // Serialized behind every pending workspace write.
      writeChain = writeChain.then(() => attempt(lastRevision), () => attempt(lastRevision));
      return writeChain;
    }

```
## public/js/freeform-surfaces.js — all seven register() calls, verbatim (supportedStates now include `docked` on every surface; `beats` is the newly migrated registry surface)

```javascript
'use strict';

/**
 * Freeform Creative Desk v2 — first registry surfaces (Phase 1).
 *
 * Layers + Scenes extracted from the bespoke app.js panels into
 * CreativeSurfaces registrations. Flag-gated: app.js only mounts the
 * WindowManager when the page runs with ?freeform=1, so the default
 * experience is unchanged until the freeform desk is proven (the mission's
 * incremental-migration rule). The bespoke renderers remain until Phase 3
 * retires them — these controllers own their window body only.
 */

(function (root, factory) {
  const mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.RaindeskFreeformSurfaces = mod;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function el(document, tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * installSurfaces({ surfaces, deps }) — registers Layers + Scenes (Phase 1)
   * and Takes (Phase 3 unit 1) on the shared registry. deps carries
   * app-level seams:
   *   getBoard() -> board shots array
   *   getActiveShotId() -> string | null
   *   openShot(id), getLayers(), setActiveLayer(id), addLayer(spec),
   *   toggleLayerVisible(layer), laneCounts(), lanesMeta(), moveShot(lane),
   *   getTakeState() -> { count, index } | null,
   *   prevTake() -> boolean, nextTake() -> boolean,
   *   commitTake() -> void, discardTakes() -> void,
   *   getCastState() -> { shotId, characters: [{id,name,locked,anchors}], boundIds } | null,
   *   toggleBound(characterId) -> void,
   *   mountBeatTrail(host) -> { render, destroy } (installs the EXISTING
   *   beats.js BeatTrail into a registry window body; Phase 3 unit 2),
   *   getNotes() -> string, setNotes(text) -> void,
   *   getProposals() -> [{id,type,label,status,executable}] ,
   *   applyProposal(id) -> Promise<void>, cancelProposal(id) -> Promise<void>,
   *   refreshCast() -> void, refreshProposals() -> void
   */
  /** Contextual-tools strip (Phase 4): a per-surface row of quick actions
   * rendered inside the surface body it belongs to. Surfaces own their
   * bodies, so surface-contextual actions live with the surface — the
   * shared window chrome stays window-level only. */
  function contextStrip(doc, body, actions) {
    const strip = el(doc, 'nav', 'freeform-context-actions');
    strip.setAttribute('aria-label', 'surface quick actions');
    for (const action of actions || []) {
      const btn = el(doc, 'button', 'freeform-context-action', action.label);
      btn.type = 'button';
      btn.addEventListener('click', () => { if (action.run) action.run(); });
      strip.appendChild(btn);
    }
    body.appendChild(strip);
    return strip;
  }

  function installSurfaces({ surfaces, deps } = {}) {
    if (!surfaces || typeof surfaces.register !== 'function') throw new Error('CreativeSurfaces registry is required');
    if (!deps) throw new Error('surface deps are required');

    surfaces.register({
      id: 'scenes',
      title: 'Scenes',
      entityType: 'sequence_strip',
      entityRefPrefix: 'scenes',
      minimumSize: { width: 260, height: 200 },
      defaultPlacement: { width: 340, height: 420, x: 24, y: 96 },
      supportedStates: ['floating', 'docked', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        const list = el(doc, 'div', 'freeform-scene-rows');
        body.appendChild(list);
        const render = () => {
          list.innerHTML = '';
          const shots = deps.getBoard ? deps.getBoard() : [];
          const active = deps.getActiveShotId ? deps.getActiveShotId() : null;
          for (const shot of shots) {
            const row = el(doc, 'button', 'freeform-scene-row' + (shot && shot.id === active ? ' active' : ''));
            row.type = 'button';
            row.append(
              el(doc, 'strong', '', shot && shot.id || ''),
              el(doc, 'span', '', String(shot && shot.beat || 'untitled scene').slice(0, 58)),
              el(doc, 'small', '', String(shot && shot.lane || '').replace('_', ' ')),
            );
            row.addEventListener('click', () => deps.openShot && deps.openShot(shot.id));
            list.appendChild(row);
          }
        };
        render();
        return { render, destroy() { list.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'layers',
      title: 'Layers',
      entityType: 'layers_panel',
      entityRefPrefix: 'layers',
      minimumSize: { width: 240, height: 180 },
      defaultPlacement: { width: 300, height: 380, x: null, y: 96 },
      supportedStates: ['floating', 'docked', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        const list = el(doc, 'div', 'freeform-layer-rows');
        body.appendChild(list);
        const render = () => {
          list.innerHTML = '';
          const layers = deps.getLayers ? deps.getLayers() : [];
          const activeId = deps.getActiveLayerId ? deps.getActiveLayerId() : null;
          for (const layer of layers) {
            const row = el(doc, 'div', 'freeform-layer' + (layer.id === activeId ? ' on' : ''));
            const sw = el(doc, 'div', 'sw sw-' + layer.kind);
            const nm = el(doc, 'span', 'nm', layer.name);
            const tag = el(doc, 'span', 'tag', layer.kind === 'base' ? 'LOCK' : String(layer.kind).toUpperCase());
            const eye = el(doc, 'button', 'eye', layer.visible ? '👁' : '—');
            eye.type = 'button';
            eye.setAttribute('aria-label', 'toggle layer visibility');
            eye.addEventListener('click', (e) => {
              e.stopPropagation();
              if (deps.toggleLayerVisible) deps.toggleLayerVisible(layer);
              render();
            });
            row.append(sw, nm, tag, eye);
            row.addEventListener('click', () => {
              if (deps.setActiveLayer && deps.setActiveLayer(layer.id)) render();
            });
            list.appendChild(row);
          }
          const add = el(doc, 'button', 'freeform-add-layer', '+ pen layer');
          add.type = 'button';
          add.addEventListener('click', () => {
            if (deps.addLayer) deps.addLayer({ name: 'notes ' + (layers.filter((l) => l.kind === 'pen').length), kind: 'pen' });
            render();
          });
          list.appendChild(add);
        };
        render();
        return { render, destroy() { list.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'takes',
      title: 'Takes',
      entityType: 'take_stack',
      entityRefPrefix: 'takes',
      minimumSize: { width: 220, height: 120 },
      defaultPlacement: { width: 260, height: 150, x: null, y: 96 },
      supportedStates: ['floating', 'docked', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        const label = el(doc, 'span', 'freeform-take-label', '');
        const prev = el(doc, 'button', 'freeform-take-prev', '◀');
        const next = el(doc, 'button', 'freeform-take-next', '▶');
        const commit = el(doc, 'button', 'freeform-take-commit', 'accept');
        const discard = el(doc, 'button', 'freeform-take-discard', 'clear');
        for (const b of [prev, next, commit, discard]) b.type = 'button';
        const row = el(doc, 'div', 'freeform-take-row');
        row.append(prev, label, next);
        body.append(row, commit, discard);
        const sync = () => {
          const s = deps.getTakeState ? deps.getTakeState() : null;
          const has = Boolean(s && s.count > 0);
          label.textContent = has ? `take ${s.index + 1}/${s.count}` : 'no takes yet';
          prev.disabled = !has || s.index <= 0;
          next.disabled = !has || s.index >= s.count - 1;
          commit.disabled = !has;
          discard.disabled = !has;
        };
        prev.addEventListener('click', () => { deps.prevTake && deps.prevTake(); sync(); });
        next.addEventListener('click', () => { deps.nextTake && deps.nextTake(); sync(); });
        commit.addEventListener('click', () => { if (deps.commitTake) deps.commitTake(); sync(); });
        discard.addEventListener('click', () => {
          if (deps.discardTakes) deps.discardTakes();
          sync();
        });
        sync();
        return { render: sync, destroy() { body.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'beats',
      title: 'Beats',
      entityType: 'beat_trail',
      entityRefPrefix: 'beats',
      minimumSize: { width: 300, height: 240 },
      defaultPlacement: { width: 350, height: 430, x: null, y: 96 },
      supportedStates: ['floating', 'docked', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        // Phase 3 unit 2: the trail rendering itself stays in beats.js — this
        // surface only hosts it. deps.mountBeatTrail installs the existing
        // BeatTrail into this window body and returns its controller so
        // refresh/setShot ride the registry lifecycle.
        if (typeof deps.mountBeatTrail !== 'function') {
          const note = el(doc, 'p', 'freeform-beat-empty', 'beat trail unavailable');
          body.appendChild(note);
          return { render() {}, destroy() { body.innerHTML = ''; } };
        }
        return deps.mountBeatTrail(body);
      },
    });

    surfaces.register({
      id: 'characters',
      title: 'Characters',
      entityType: 'character_registry',
      entityRefPrefix: 'characters',
      minimumSize: { width: 240, height: 160 },
      defaultPlacement: { width: 300, height: 340, x: null, y: 96 },
      supportedStates: ['floating', 'docked', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        contextStrip(doc, body, [{
          label: 'refresh cast',
          run: () => { if (deps.refreshCast) deps.refreshCast(); },
        }]);
        const list = el(doc, 'div', 'freeform-character-rows');
        body.appendChild(list);
        const render = () => {
          list.innerHTML = '';
          const cast = deps.getCastState ? deps.getCastState() : null;
          if (!cast || !cast.characters.length) {
            list.appendChild(el(doc, 'p', 'freeform-character-empty',
              cast ? 'no characters yet — pin a Character sheet in the world' : 'character registry offline (local server needed)'));
            return;
          }
          const bound = new Set(cast.boundIds || []);
          for (const ch of cast.characters) {
            const row = el(doc, 'div', 'freeform-character' + (bound.has(ch.id) ? ' bound' : ''));
            const name = el(doc, 'span', 'nm', ch.name || ch.id);
            const meta = el(doc, 'small', 'meta',
              (ch.anchors && ch.anchors.length ? `${ch.anchors.length} anchors` : 'no anchors'));
            const lock = el(doc, 'span', 'lock', ch.locked ? '🔒' : '');
            const castBtn = el(doc, 'button', 'cast', bound.has(ch.id) ? 'in cast' : 'add to cast');
            castBtn.type = 'button';
            castBtn.addEventListener('click', () => {
              if (deps.toggleBound) deps.toggleBound(ch.id);
            });
            row.append(name, meta, lock, castBtn);
            list.appendChild(row);
          }
        };
        render();
        return { render, destroy() { list.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'notes',
      title: 'Notes',
      entityType: 'notes_panel',
      entityRefPrefix: 'notes',
      minimumSize: { width: 200, height: 140 },
      defaultPlacement: { width: 280, height: 220, x: null, y: 96 },
      supportedStates: ['floating', 'docked', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        const ta = el(doc, 'textarea', 'freeform-notes-area');
        ta.rows = 6;
        ta.placeholder = 'scratch thoughts, cues, reminders — saved as you type';
        body.appendChild(ta);
        ta.addEventListener('input', () => {
          if (deps.setNotes) deps.setNotes(String(ta.value || ''));
        });
        const render = () => {
          const v = deps.getNotes ? String(deps.getNotes() || '') : '';
          // Never clobber in-progress typing: only sync when the stored
          // text genuinely diverges from what the artist sees.
          if (String(ta.value || '') !== v) ta.value = v;
        };
        render();
        return { render, destroy() { body.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'proposals',
      title: 'Partner proposals',
      entityType: 'partner_proposals',
      entityRefPrefix: 'proposals',
      minimumSize: { width: 240, height: 140 },
      defaultPlacement: { width: 320, height: 240, x: null, y: 96 },
      supportedStates: ['floating', 'docked', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        contextStrip(doc, body, [{
          label: 'refresh',
          run: () => { if (deps.refreshProposals) deps.refreshProposals(); },
        }]);
        const list = el(doc, 'div', 'freeform-proposal-rows');
        body.appendChild(list);
        const render = () => {
          list.innerHTML = '';
          const proposals = (deps.getProposals ? deps.getProposals() : []) || [];
          const pending = proposals.filter((p) => p && p.status === 'proposed');
          if (!pending.length) {
            list.appendChild(el(doc, 'p', 'freeform-proposal-empty', 'no spatial suggestions right now'));
            return;
          }
          for (const p of pending) {
            const row = el(doc, 'div', 'freeform-proposal');
            const label = el(doc, 'span', 'nm', p.label || `${p.type} ${p.targetId || ''}`.trim());
            row.appendChild(label);
            if (p.executable) {
              const apply = el(doc, 'button', 'freeform-proposal-apply', 'apply');
              apply.type = 'button';
              apply.addEventListener('click', () => { if (deps.applyProposal) deps.applyProposal(p.id); });
              row.appendChild(apply);
            } else {
              const note = el(doc, 'small', 'meta', 'advisory');
              row.appendChild(note);
            }
            const dismiss = el(doc, 'button', 'freeform-proposal-dismiss', 'dismiss');
            dismiss.type = 'button';
            dismiss.addEventListener('click', () => { if (deps.cancelProposal) deps.cancelProposal(p.id); });
            row.appendChild(dismiss);
            list.appendChild(row);
          }
        };
        render();
        return { render, destroy() { list.innerHTML = ''; } };
      },
    });

    return true;
  }

  return { installSurfaces };
});
```
## app.js — freeform mount gating excerpt (useFreeformDesk; bespoke Beats shell registered only when the registry desk did NOT mount)

```javascript
    // Freeform-desk routing flag, computed once so the Beats panel can be
    // retired from the bespoke shell on the desktop path while the legacy
    // experience keeps it everywhere else.
    const useFreeformDesk = new URLSearchParams(location.search).get('freeform') === '1' &&
      Boolean(window.RaindeskWindowManager && window.RaindeskFreeformSurfaces);
    state.workspaceUI.registerPanel({
      id: 'panel_layers', key: 'layers', type: 'layers_panel', label: 'Layers',
      element: $('layersPanel'), handle: $('layersPanel').querySelector('h4'),
      visibilityTarget: $('layersPanel'), visibleClass: 'open',
      open: () => { panelOpen = true; $('layersPanel').classList.add('open'); renderPanel(); },
      close: () => { panelOpen = false; $('layersPanel').classList.remove('open'); },
    });
    state.workspaceUI.registerPanel({
      id: 'panel_scenes', key: 'scenes', type: 'sequence_strip', label: 'Scenes',
      element: $('scenesPanel'), handle: $('scenesPanel').querySelector('.workspace-panel-head'),
      visibilityTarget: $('scenesPanel'), visibleClass: 'open',
      open: () => { $('scenesPanel').classList.add('open'); renderScenesPanel(); },
      close: () => $('scenesPanel').classList.remove('open'),
    });
    // Phase 3 migration: when the registry desk mounts, the bespoke Beats
    // shell is not registered — window_beats owns the surface instead.
    if (!useFreeformDesk) {
      state.workspaceUI.registerPanel({
        id: 'panel_beats', key: 'beats', type: 'beat_trail', label: 'Beats',
        element: $('beatTrail'), handle: $('beatTrail').querySelector('.beat-trail-head'),
        visibilityTarget: $('beatTrail'), visibleClass: 'open',
        isOpen: () => state.beatTrail && state.beatTrail.isOpen(),
        open: () => state.beatTrail && state.beatTrail.open(),
        close: () => state.beatTrail && state.beatTrail.close(),
      });
    }
```
## lib/workspace.js — ENTITY_REF_RE + sanitizeWindow/validate/assertBaseRevision excerpts (unchanged from round 2)

```javascript
// crosses prefixes (reference_board windows reference sheet: ids), so the
// prefix set is permissive, not type-locked.
const ENTITY_REF_RE = /^(sheet|shot|comic_page|character|note|board|partner|beats|layers|scenes|takes):[A-Za-z0-9_.-]{1,96}$/;
const WINDOW_FIELDS = new Set([
  'windowId', 'type', 'space', 'entityRef', 'x', 'y', 'width', 'height',
  'rotation', 'scale', 'zIndex', 'state', 'groupId', 'collapsed', 'pinned', 'locked', 'dock',
]);

/** Strict v3 window sanitizer: unknown structural fields are REJECTED (the
 * v2 sanitizer silently dropped them, which loses group/shelf writes). */
function sanitizeWindow(input = {}, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'window must be an object');
  const extra = Object.keys(input).find((key) => !WINDOW_FIELDS.has(key));
  if (extra) throw new HttpError(400, `window contains unsupported field ${extra}`);
  const windowId = assertId(input.windowId || (existing && existing.windowId), 'window id');
  const type = WINDOW_TYPES.has(input.type) ? input.type : (existing && existing.type) || 'generic_panel';
  const inheritedSpace = existing && SPACES.has(existing.space) ? existing.space : defaultSpaceForType(type);
  const space = SPACES.has(input.space) ? input.space : inheritedSpace;
  const rawRef = input.entityRef !== undefined ? input.entityRef : (existing && existing.entityRef) || null;
  if (rawRef != null && !ENTITY_REF_RE.test(String(rawRef))) throw new HttpError(400, 'window entityRef is not a typed reference');
  const rawState = input.state !== undefined ? input.state : (existing && existing.state) || 'floating';
  if (!STATES.has(rawState)) throw new HttpError(400, 'window state must be floating|tabbed|docked|minimised|maximised');
  const rawGroup = input.groupId !== undefined ? input.groupId : (existing && existing.groupId) || null;
  if (rawGroup != null && !ID_RE.test(String(rawGroup))) throw new HttpError(400, 'bad window groupId');
  return {
    windowId, type, space,
    entityRef: rawRef == null ? null : String(rawRef),
    x: finite(input.x, existing ? existing.x : 0),
    y: finite(input.y, existing ? existing.y : 0),
    width: finite(input.width, existing ? existing.width : 360, 40, 20000),
    height: finite(input.height, existing ? existing.height : 260, 40, 20000),
    rotation: finite(input.rotation, existing ? existing.rotation : 0, -360000, 360000),
    scale: finite(input.scale, existing ? existing.scale : 1, 0.05, 64),
    zIndex: finite(input.zIndex, existing ? existing.zIndex : 0, -100000, 100000),
    state: rawState,
    groupId: rawGroup == null ? null : String(rawGroup),
    collapsed: input.collapsed !== undefined ? Boolean(input.collapsed) : Boolean(existing && existing.collapsed),
    pinned: input.pinned !== undefined ? Boolean(input.pinned) : Boolean(existing && existing.pinned),
    locked: input.locked !== undefined ? Boolean(input.locked) : Boolean(existing && existing.locked),
    dock: space === 'world' ? null : (input.dock === null ? null : (DOCKS.has(input.dock) ? input.dock : (existing && existing.dock) || null)),
    updatedAt: now(),
  };
}

/** Whole-store referential integrity after any mutation, before write. */
function validateWorkspace(ws) {
  const ids = new Set();
  for (const win of ws.windows) {
    if (!win || !ID_RE.test(win.windowId)) throw new HttpError(500, 'workspace window identity is malformed');
    if (ids.has(win.windowId)) throw new HttpError(500, 'workspace window ids are not unique');
    ids.add(win.windowId);
  }
  const seenGroups = new Set();
  for (const group of ws.groups) {
    if (!group || !ID_RE.test(group.groupId)) throw new HttpError(500, 'workspace group identity is malformed');
    if (seenGroups.has(group.groupId)) throw new HttpError(500, 'workspace group ids are not unique');
    seenGroups.add(group.groupId);
    const members = Array.isArray(group.windowIds) ? group.windowIds : [];
    if (!members.length || new Set(members).size !== members.length) throw new HttpError(500, 'workspace group membership is empty or duplicated');
    for (const id of members) {
      if (!ids.has(id)) throw new HttpError(500, `workspace group references unknown window ${id}`);
    }
    if (group.activeWindowId != null && !members.includes(group.activeWindowId)) {
      throw new HttpError(500, 'workspace group active window is not a member');
    }
  }
  for (const win of ws.windows) {
    if (win.groupId != null && !seenGroups.has(win.groupId)) {
      throw new HttpError(500, `window ${win.windowId} references unknown group ${win.groupId}`);
    }
  }
  const shelf = ws.shelf && Array.isArray(ws.shelf.windowIds) ? ws.shelf.windowIds : [];
  if (new Set(shelf).size !== shelf.length) throw new HttpError(500, 'workspace shelf contains duplicates');
  for (const id of shelf) {
    if (!ids.has(id)) throw new HttpError(500, `workspace shelf references unknown window ${id}`);
  }
  if (ws.activeWindowId != null && !ids.has(ws.activeWindowId)) {
    throw new HttpError(500, 'workspace active window does not exist');
  }
}

function assertBaseRevision(ws, options = {}) {
  if (options && options.baseRevision != null && Number(options.baseRevision) !== ws.revision) {
    throw Object.assign(new HttpError(409, 'workspace changed since this edit'), { workspace: ws });
  }
}
```
## 25-step journey manifest (step labels only; steps 8 and 24 rewritten for the floating-window evolution)

```
function step(n, label) {
step(1, 'default boot mounts no freeform windows');
step(2, 'freeform boot reaches ready');
step(3, 'scenes and layers windows mount');
step(4, 'window chrome completeness');
step(5, 'empty project stays empty');
step(6, 'focus raises z-order');
step(7, 'native drag moves scenes');
step(8, 'edge drag docks, drag-away re-floats');
step(9, 'rename through title edit');
step(10, 'minimise hides the window');
step(11, 'shelf chip appears');
step(12, 'shelf chip restores');
step(13, 'group into a tab stack');
step(14, 'inactive member hidden');
step(15, 'switch tab flips visibility');
step(16, 'tear out to floating');
step(17, 'drop-to-group rejoins');
step(18, 'reload restores the group');
step(19, 'geometry survives reload');
step(20, 'takes surface empty state');
step(21, 'characters surface empty registry');
step(22, 'notes typing persists');
step(23, 'notes survive reload');
step(24, 'edge snap docks, no leaked snap ghost');
step(25, 'zero console errors');
```
