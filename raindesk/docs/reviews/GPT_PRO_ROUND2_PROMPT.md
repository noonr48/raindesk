# GPT Pro review request — Raindesk Freeform Creative Desk v2

You are reviewing a completed 6-phase implementation of a browser-based creative desk: a vanilla-JS window manager ("freeform desk") layered over an existing Raindesk art application. You have NO repo access — everything you may consider is INLINE BELOW. Do not assume files exist beyond what is shown.

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
Q6. TOP-3 next work items (this doubles as the closing triad).

## Mission snapshot
- Phases 1-6 landed on branch chatgpt/freeform-desk-v2, HEAD after these commits: cec9105 (registry+frame+schema v3), 72f1098 (drop zones look-through), 5b5ea6f/fafbb78/1ba7cb4 (Takes/Characters/Notes surfaces), 391e1b6/ff11406 (proposals surface + contextual strips), 7d2aa2c (paper-desk visuals), 6dda071 (25-step journey + persistence hardening), 7183534 (writeChain serialization), 8a3701d (init revision seeding), 490cb1e (two-desks convergence test).
- Deterministic suite 276/276 (node:test, fake-DOM); native Chromium smoke (normal+empty) green; 25-step acceptance journey green end-to-end against the real server.
- Persistence model: workspace schema v3 {windows[], groups[], shelf[], revision}; object upserts are last-write-wins and return the post-write revision; groups/shelf writes are revision-gated (409 carries current state); the client serializes ALL writes through one promise chain and adopts revisions monotonically.

## ARCHITECTURE DOC (FREEFORM_DESK_V2.md, verbatim)

```markdown
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

Remaining honest limitations: single-viewport journey (mobile evidence
and regressions harness per §7 are future work); bespoke layout code of
§5 still present alongside the registry surfaces.

```

## public/js/window-manager.js — EXCERPTS (line ranges from the real file)

```javascript


/* ===== window-manager.js lines 1-60 ===== */
'use strict';

/**
 * Freeform Creative Desk v2 — shared creative-window manager (Phase 1).
 *
 * One window model for every creative surface. The registry
 * (CreativeSurfaces.register) declares surfaces; this module owns frame
 * rendering, movement, resize, z-order, focus, minimise/maximise/restore,
 * snap-assisted placement and persistence through workspace schema v3.
 * Features own only content: a registered controller receives a body element
 * and keeps its own document logic. Mechanics before visuals (Phase 5 owns
 * the paper-desk restyle).
 *
 * Gesture ownership (explicit, test-enforced):
 *   header drag   -> window move      (deferred capture >3px, document-capture)
 *   resize grips  -> resize           (grip-owned pointer capture)
 *   window body   -> content          (never moved by the manager)
 *   dblclick title-> rename           (survives drag via movement threshold)
 */

(function (root, factory) {
  const mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else {
    root.RaindeskWindowManager = mod;
    if (root.document && root.RaindeskSurfaces) mod.install(root);
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const Geometry = root.RaindeskWorkspaceUI || {}; // pure helpers (normalizedRect, edgeSnap, peerSnap)

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
        supportedStates: new Set(
          (Array.isArray(surface.supportedStates) ? surface.supportedStates : ['floating', 'minimised', 'maximised'])
            .filter((state) => SUPPORTED_STATES.has(state)),
        ),
        contextualTools: Array.isArray(surface.contextualTools) ? surface.contextualTools.slice() : [],
      });


/* ===== window-manager.js lines 96-176 ===== */
    const controllers = new Map();    // windowId -> controller
    const groups = new Map();         // groupId -> { groupId, windowIds, activeWindowId }
    const saves = new Map();          // windowId -> serialized save chain
    let shelfHostEl = shelfHost || null; // attachShelf() may bind it later
    let zTop = 100;
    let focusedId = null;
    let lastRevision = null;          // optimistic-concurrency token for structural writes
    let groupsWarned = false; // per-route: a shelf conflict must not silence the groups self-heal
    let shelfWarned = false;
    // Single serialization chain for ALL workspace writes: object upserts,
    // shelf and groups can never interleave on the wire, so an upsert landing
    // between a gated write's send and server-handle (invalidating its
    // adopted revision mid-retry) is impossible by construction.
    let writeChain = Promise.resolve();

    root.classList.add('freeform-desk-windows');

    function surfaceFor(model) { return CreativeSurfaces.get(model.surfaceId) || null; }

    function clampRect(rect, surface) {
      const min = surface ? surface.minimumSize : { width: 200, height: 140 };
      const m = metrics();
      return {
        x: Number.isFinite(rect.x) ? rect.x : 0,
        y: Number.isFinite(rect.y) ? rect.y : 0,
        width: Math.min(Math.max(rect.width || min.width, min.width), Math.max(min.width, m.width)),
        height: Math.min(Math.max(rect.height || min.height, min.height), Math.max(min.height, m.height)),
      };
    }

    function defaultRect(surface) {
      const m = metrics();
      const place = surface.defaultPlacement || {};
      const n = windows.size;
      const base = clampRect({
        x: place.x != null ? place.x : Math.round(m.width * 0.5 - (place.width || 460) * 0.5) + ((n % 5) - 2) * 36,
        y: place.y != null ? place.y : Math.round(m.height * 0.5 - (place.height || 360) * 0.5) + ((n % 4) - 1) * 28,
        width: place.width || 460, height: place.height || 360,
      }, surface);
      return geo.normalizedRect ? geo.normalizedRect(base, m) : base;
    }

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



/* ===== window-manager.js lines 255-300 ===== */
      frame.style.zIndex = String(model.zIndex);
      renderGroupTabs(model);
    }
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


/* ===== window-manager.js lines 306-452 ===== */
      snapPreviewEl = null;
    }

    function installDrag(model) {
      const head = model.head;
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button,input,textarea,a,[contenteditable="true"],[data-no-drag]')) return;
        const current = windows.get(model.windowId); if (!current || current.locked) return;
        if (current.state === 'maximised') return; // maximised windows do not drag; restore first
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY, ox: current.rect.x, oy: current.rect.y };
        // Deferred capture (>3px) so dblclick-to-rename survives; threshold
        // listeners live at DOCUMENT capture level because a steep drag can
        // leave the head rect on its first interpolated step (proven v1).
        let captured = false;
        const moved = (ev) => Math.abs(ev.clientX - start.x) > DRAG_THRESHOLD_PX || Math.abs(ev.clientY - start.y) > DRAG_THRESHOLD_PX;
        const teardown = () => {
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', up, true);
          document.removeEventListener('pointercancel', up, true);
        };
        const move = (ev) => {
          if (!ev.buttons) { teardown(); return; } // severed-gesture guard
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
          const preview = snapPlace(current, ev.altKey);
          showSnapPreview(preview ? preview.rect : null);
        };
        const up = async (ev) => {
          teardown();
          clearSnapPreview();
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
          renderFrame(current);
          await persist(current);
        };
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', up, true);
        document.addEventListener('pointercancel', up, true);
      });
    }

    function installResize(model, grip) {
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const current = windows.get(model.windowId); if (!current || current.locked) return;
        if (current.state === 'maximised') return;
        e.preventDefault(); e.stopPropagation();
        grip.setPointerCapture(e.pointerId);
        const surface = surfaceFor(current);
        const min = surface ? surface.minimumSize : { width: 200, height: 140 };
        const start = { x: e.clientX, y: e.clientY, w: current.rect.width, h: current.rect.height };
        const move = (ev) => {
          current.rect.width = Math.max(min.width, start.w + (ev.clientX - start.x));
          current.rect.height = Math.max(min.height, start.h + (ev.clientY - start.y));
          renderFrame(current);
        };
        const up = async (ev) => {
          try { grip.releasePointerCapture(ev.pointerId); } catch (_e) {}
          grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
          await persist(current);
        };
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
      });
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

    function open(surfaceId, options = {}) {
      const surface = CreativeSurfaces.get(surfaceId);
      if (!surface) throw new Error(`unknown creative surface "${surfaceId}"`);
      const windowId = options.windowId || `window_${surfaceId}`;
      if (windows.has(windowId)) {
        bringToFront(windowId);
        if (options.focus !== false) focus(windowId);
        return controllers.get(windowId) || null;
      }
      const model = {
        windowId, surfaceId,
        title: options.title || surface.title,
        entityType: surface.entityType,
        entityRef: options.entityRef || null,
        rect: clampRect(options.rect || defaultRect(surface), surface),
        zIndex: ++zTop,
        state: 'floating',
        collapsed: false, pinned: false, locked: false,
        restoreRect: null,
        onRename: options.onRename || null,
        frame: null, body: null, head: null, title: null,
      };
      windows.set(windowId, model);
      if (options.state && surface.supportedStates.has(options.state)) model.state = options.state;
      renderFrame(model);
      let controller = null;
      if (surface.createController) {
        controller = surface.createController({
          windowId, body: model.body, api, document, root,
          setTitle(title) { model.title = String(title || '').slice(0, 120); if (model.title) model.titleNode = null; renderFrame(model); },
          close: () => close(windowId),
        }) || null;
      }
      controllers.set(windowId, controller);
      bringToFront(windowId);
      if (options.focus !== false) focus(windowId);
      persist(model);
      return controller;
    }



/* ===== window-manager.js lines 600-720 ===== */
      windows.delete(windowId); controllers.delete(windowId); saves.delete(windowId);
      if (focusedId === windowId) focusedId = null;
      persistStructure();
      return model;
    }

    function state(windowId) {
      const model = windows.get(windowId);
      if (!model) return null;
      return { windowId, surfaceId: model.surfaceId, state: model.state, title: model.title,
        rect: { ...model.rect }, zIndex: model.zIndex, collapsed: model.collapsed,
        pinned: model.pinned, locked: model.locked, focused: model.windowId === focusedId };
    }
    function list() { return [...windows.keys()].map(state); }

    /** Restore persisted windows from a workspace v3 document (ws.windows). */
    async function init() {
      if (!api || typeof api.getWorkspace !== 'function') return list();
      let ws = null;
      try { ws = await api.getWorkspace(); } catch (_e) { return list(); }
      // Seed the revision token from server truth so the FIRST gated
      // structural write carries a real baseRevision instead of null
      // (null bypasses the 409 gate entirely — a second tab's first write
      // could silently clobber a concurrent tab's landed write).
      if (ws && Number.isFinite(ws.revision)) lastRevision = Math.max(lastRevision || 0, ws.revision);
      const persisted = ws && Array.isArray(ws.windows) ? ws.windows : [];
      // Namespace boundary during migration: freeform windows own the
      // `window_` prefix; the still-running WorkspaceShell owns its legacy
      // `panel_*` objects. Restoring those here would shadow the shell's own
      // panels and block first-run auto-open (live-caught by the freeform
      // smoke: hidden legacy frames made list() non-empty).
      const freeformWindows = persisted.filter((win) => win && String(win.windowId).startsWith('window_'));
      for (const win of freeformWindows) {
        const surfaceId = surfaceIdForEntityType(win.type, win.entityRef);
        if (!surfaceId || !CreativeSurfaces.get(surfaceId)) continue;
        if (windows.has(win.windowId)) continue;
        const model = {
          windowId: win.windowId, surfaceId,
          title: win.windowId, entityType: win.type,
          entityRef: win.entityRef || null,
          rect: clampRect({ x: win.x, y: win.y, width: win.width, height: win.height }, CreativeSurfaces.get(surfaceId)),
          zIndex: Number(win.zIndex) || 1,
          state: SUPPORTED_STATES.has(win.state) ? win.state : 'floating',
          collapsed: Boolean(win.collapsed), pinned: Boolean(win.pinned || false), locked: Boolean(win.locked || false),
          groupId: win.groupId || null,
          restoreRect: null, onRename: null, frame: null, body: null, head: null, title: null, tabsSlot: null,
        };
        if (model.state === 'minimised') continue; // restored below as shelf-backed models
        // Tabbed members restore with their group (rebuilt below); docked
        // rects are stale across viewports and re-derive as floating.
        if (model.state === 'docked') model.state = 'floating';
        windows.set(model.windowId, model);
        zTop = Math.max(zTop, model.zIndex);
        renderFrame(model);
        const surface = CreativeSurfaces.get(surfaceId);
        if (surface && surface.createController) {
          const controller = surface.createController({
            windowId: model.windowId, body: model.body, api, document, root,
            setTitle() {}, close: () => close(model.windowId),
          }) || null;
          controllers.set(model.windowId, controller);
        }
      }
      // Shelf-backed models: minimised windows keep their identity, content
      // controller and rect on disk; restore() re-floats them.
      for (const win of freeformWindows) {
        if (!win || win.state !== 'minimised') continue;
        if (windows.has(win.windowId)) continue;
        const surfaceId = surfaceIdForEntityType(win.type, win.entityRef);
        if (!surfaceId || !CreativeSurfaces.get(surfaceId)) continue;
        const model = {
          windowId: win.windowId, surfaceId,
          title: win.windowId, entityType: win.type,
          entityRef: win.entityRef || null,
          rect: clampRect({ x: win.x, y: win.y, width: win.width, height: win.height }, CreativeSurfaces.get(surfaceId)),
          zIndex: Number(win.zIndex) || 1,
          state: 'minimised',
          collapsed: true, pinned: Boolean(win.pinned || false), locked: Boolean(win.locked || false),
          restoreRect: null, onRename: null, frame: null, body: null, head: null, title: null, tabsSlot: null,
        };
        windows.set(model.windowId, model);
        zTop = Math.max(zTop, model.zIndex);
        renderFrame(model);
        const surface = CreativeSurfaces.get(surfaceId);
        if (surface && surface.createController) {
          const controller = surface.createController({
            windowId: model.windowId, body: model.body, api, document, root,
            setTitle() {}, close: () => close(model.windowId),
          }) || null;
          controllers.set(model.windowId, controller);
        }
      }
      // Groups restore: rebuild group records; members above carry their
      // groupId. Stale groups (<2 live members) dissolve; a stranded tabbed
      // member (its group lost) re-floats so no window restores invisible.
      const persistedGroups = ws && Array.isArray(ws.groups) ? ws.groups : [];
      for (const group of persistedGroups) {
        if (!group || !group.groupId || !Array.isArray(group.windowIds)) continue;
        const windowIds = group.windowIds.filter((id) => windows.has(id));
        if (windowIds.length < 2) continue;
        const activeWindowId = windowIds.includes(group.activeWindowId) ? group.activeWindowId : windowIds[0];
        groups.set(group.groupId, { groupId: group.groupId, windowIds, activeWindowId });
      }
      for (const model of windows.values()) {
        if (model.state === 'tabbed' && (!model.groupId || !groups.has(model.groupId))) {
          model.state = 'floating';
          model.groupId = null;
        }
      }
      renderAll();
      renderShelf();
      return list();
    }

    /* ------------------------------------------------------ grouping */

    function groupIds() { return [...groups.keys()]; }
    function groupFor(windowId) {
      const model = windows.get(windowId);
      if (!model || !model.groupId) return null;
      return groups.get(model.groupId) || null;


/* ===== window-manager.js lines 722-1015 ===== */

    function renderGroupTabs(model) {
      if (!model.tabsSlot) return;
      model.tabsSlot.innerHTML = '';
      const group = groupFor(model.windowId);
      if (!group || group.activeWindowId !== model.windowId) return;
      for (const memberId of group.windowIds) {
        const member = windows.get(memberId);
        if (!member) continue;
        const tab = el(document, 'button', 'freeform-window-tab' + (memberId === model.windowId ? ' active' : ''));
        tab.type = 'button';
        tab.textContent = member.title;
        // Distinct attribute from frames: tabs must never collide with
        // window elements on data-window-id (live-caught: querySelector
        // returned the embedded tab before the frame and the smoke's
        // hidden-check timed out while the product state was correct).
        tab.dataset.tabFor = memberId;
        tab.addEventListener('click', () => switchTab(memberId));
        installTabTear(tab, memberId);
        model.tabsSlot.appendChild(tab);
      }
    }

    /** Tab tear-out: a >10px drag on a tab pulls that window out of the
     * group as a floating window (v1 creative-desk pattern, adapted). */
    function installTabTear(tab, memberId) {
      tab.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const sx = e.clientX; const sy = e.clientY; let torn = false;
        const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) torn = true; };
        const up = (ev) => {
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', up, true);
          if (!torn) return;
          // A drag that releases INSIDE the strip reorders the tab instead of
          // tearing it out (Phase 2: tab reordering).
          const strip = tab.parentNode;
          if (pointInRect(ev.clientX, ev.clientY, rectOf(strip))) {
            reorderTab(memberId, ev.clientX);
            return;
          }
          e.preventDefault && e.preventDefault();
          tearOut(memberId, ev.clientX, ev.clientY);
        };
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', up, true);
      });
    }

    function tearOut(memberId, x, y) {
      const model = windows.get(memberId); if (!model) return null;
      removeFromGroup(model);
      transition(model, 'floating');
      if (Number.isFinite(x) && Number.isFinite(y)) {
        model.rect.x = x; model.rect.y = y;
      }
      renderFrame(model); persist(model); persistStructure();
      return model;
    }

    function removeFromGroup(model) {
      if (!model.groupId) return;
      const group = groups.get(model.groupId);
      if (group) {
        group.windowIds = group.windowIds.filter((id) => id !== model.windowId);
        if (group.activeWindowId === model.windowId) group.activeWindowId = group.windowIds[0] || null;
        // Store-aligned semantics: a group survives losing members down to a
        // single survivor; only the LAST member leaving dissolves it (the
        // lib/route tests pin the same behavior server-side).
        if (group.windowIds.length === 0) {
          groups.delete(group.groupId);
        }
      }
      model.groupId = null;
      if (group) { for (const id of group.windowIds) { const win = windows.get(id); if (win) renderFrame(win); } }
    }

    function groupWindows(windowIds, options = {}) {
      const ids = (Array.isArray(windowIds) ? windowIds : []).filter((id) => windows.has(id));
      if (ids.length < 2) throw new Error('grouping needs at least two open windows');
      const groupId = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const activeWindowId = options.activeWindowId && ids.includes(options.activeWindowId) ? options.activeWindowId : ids[0];
      groups.set(groupId, { groupId, windowIds: ids.slice(), activeWindowId });
      for (const id of ids) {
        const model = windows.get(id);
        model.groupId = groupId;
        transition(model, 'tabbed');
        renderFrame(model);
        persist(model);
      }
      persistStructure();
      bringToFront(activeWindowId);
      return groups.get(groupId);
    }

    function ungroup(groupIdOrWindowId) {
      const group = groups.get(groupIdOrWindowId) || groupFor(groupIdOrWindowId);
      if (!group) return null;
      for (const id of group.windowIds.slice()) {
        const model = windows.get(id);
        if (!model) continue;
        model.groupId = null;
        transition(model, 'floating');
        renderFrame(model);
        persist(model);
      }
      groups.delete(group.groupId);
      persistStructure();
      return group;
    }

    function switchTab(memberId) {
      const group = groupFor(memberId);
      if (!group) return null;
      group.activeWindowId = memberId;
      for (const id of group.windowIds) renderFrame(windows.get(id));
      bringToFront(memberId);
      persistStructure();
      return group;
    }

    /* ------------------------------------------------------ drop zones */

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

    /** Drop-to-group: attach windowId to targetWindowId's stack — creating
     * the stack around the target when it is ungrouped. */
    function joinGroup(windowId, targetWindowId) {
      const model = windows.get(windowId); const target = windows.get(targetWindowId);
      if (!model || !target || model === target) return null;
      if (model.locked || target.locked) return null;
      removeFromGroup(model);
      let group = target.groupId && groups.get(target.groupId);
      if (!group) {
        const groupId = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        group = { groupId, windowIds: [target.windowId], activeWindowId: target.windowId };
        groups.set(groupId, group);
        target.groupId = groupId;
        transition(target, 'tabbed');
      }
      group.windowIds.push(model.windowId);
      model.groupId = group.groupId;
      transition(model, 'tabbed');
      renderAll(); renderShelf();
      persist(model); persistStructure();
      bringToFront(group.activeWindowId);
      return groups.get(group.groupId);
    }

    /** Reorder a tab inside its strip: insertion index from the drop x
     * against sibling tab midpoints (strip renders on the active member). */
    function reorderTab(memberId, x) {
      const model = windows.get(memberId); if (!model || !model.groupId) return null;
      const group = groups.get(model.groupId); if (!group) return null;
      const activeModel = windows.get(group.activeWindowId);
      const stripHost = activeModel && activeModel.frame && activeModel.frame.querySelector
        ? activeModel.frame.querySelector('.freeform-window-tabs') : null;
      if (!stripHost) return null;
      let insertAt = 0;
      for (const id of group.windowIds) {
        if (id === memberId) continue;
        const tab = Array.from(stripHost.querySelectorAll('.freeform-window-tab')).find((t) => t.dataset && t.dataset.tabFor === id);
        const rect = tab ? rectOf(tab) : null;
        if (rect && (rect.left + (rect.right - rect.left) / 2) < x) insertAt += 1;
      }
      group.windowIds.splice(group.windowIds.indexOf(memberId), 1);
      group.windowIds.splice(insertAt, 0, memberId);
      renderFrame(activeModel); // re-render the strip in the new order
      persistStructure();
      return group;
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

    return { open, close, minimise, restore, restoreAt, maximise, unmaximise, bringToFront, focus, state, list, init, refreshAll,
      groupWindows, ungroup, switchTab, tearOut, joinGroup, groupIds, attachShelf,
      groups: () => [...groups.values()].map((g) => ({ ...g, windowIds: g.windowIds.slice() })) };

    /** Push external state changes (board edits, layer changes) into every
     * live surface controller (adversarial repair: stale surface lists). */
    function refreshAll() {
      for (const [windowId, controller] of controllers) {
        if (controller && typeof controller.render === 'function') {
          try { controller.render(); } catch (_e) { /* one damaged surface must not kill the desk */ }
        }
      }
    }
  }

  /** Windows persisted a v3 `type` + optional entityRef; map back to surfaces.
   * Surfaces may declare `matchesWindow(win)` for custom binding; the default
   * matches on entityType. */
  function surfaceIdForEntityType(type, entityRef) {
    for (const def of registry.values()) {
      if (def.entityType === type) {
        if (def.entityRefPrefix && entityRef && !String(entityRef).startsWith(`${def.entityRefPrefix}:`)) continue;
        return def.id;
      }
    }
    return null;
  }
  // Allow register() to carry an entityRefPrefix for binding.
  const baseRegister = CreativeSurfaces.register;
  CreativeSurfaces.register = function register(surface) {
    const def = baseRegister(surface);
    if (surface && typeof surface.entityRefPrefix === 'string') {
      const enriched = Object.create(def);
      enriched.entityRefPrefix = surface.entityRefPrefix;
      registry.set(def.id, Object.freeze(enriched));
      return registry.get(def.id);
    }
    return def;
  };

  function install(windowRoot) {
    // Auto-install hook reserved: surfaces register themselves at script load
    // (each module calls RaindeskSurfaces.register); the manager is created by
    // app.js once the desk root exists. Nothing to do here yet.
    return true;
  }

  return { CreativeSurfaces, WindowManager, surfaceIdForEntityType, install, DRAG_THRESHOLD_PX };
});



```

## public/js/freeform-surfaces.js — header/deps seam + registry tail

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
   *   getNotes() -> string, setNotes(text) -> void,
   *   getProposals() -> [{id,type,label,status,executable}] ,
   *   applyProposal(id) -> Promise<void>, cancelProposal(id) -> Promise<void>,
   *   refreshCast() -> void, refreshProposals() -> void
   */
  /** Contextual-tools strip (Phase 4): a per-surface row of quick actions
```

## app.js — freeform mount + deps wiring excerpt

```javascript
    try {
      if (new URLSearchParams(location.search).get('freeform') === '1' &&
          window.RaindeskWindowManager && window.RaindeskFreeformSurfaces) {
        window.RaindeskFreeformSurfaces.installSurfaces({
          surfaces: window.RaindeskWindowManager.CreativeSurfaces,
          deps: {
            getBoard: () => (state.board && Array.isArray(state.board.shots) ? state.board.shots : []),
            getActiveShotId: () => (state.shot && state.shot.id) || null,
            openShot: (id) => { openShot(id); },
            getLayers: () => core.layers,
            getActiveLayerId: () => core.activeLayerId,
            setActiveLayer: (id) => {
              try { core.setActiveLayer(id); } catch (_e) { return false; }
              markDirty(); scheduleShotSave('active layer'); return true;
            },
            addLayer: (spec) => {
              core.addLayer(spec); markDirty(); scheduleShotSave('add pen layer');
            },
            toggleLayerVisible: (layer) => {
              layer.visible = !layer.visible; markDirty(); scheduleShotSave('layer visibility');
            },
            getTakeState: () => {
              const s = core.session;
              return s && s.takes.length ? { count: s.takes.length, index: s.takeIndex } : { count: 0, index: -1 };
            },
            prevTake: () => { if (core.prevTake()) { markDirty(); } },
            nextTake: () => { if (core.nextTake()) { markDirty(); } },
            commitTake: () => { onCommit(); },
            discardTakes: () => { core.discardTakes(); state.takeMeta = []; markDirty(); },
            getNotes: () => {
              try { return window.localStorage.getItem('raindesk.notes.v1') || ''; } catch (_e) { return ''; }
            },
            setNotes: (text) => {
              try { window.localStorage.setItem('raindesk.notes.v1', String(text || '')); } catch (_e) { /* private mode */ }
            },
            getProposals: () => state.freeformProposals || [],
            refreshCast: () => { loadCast(); },
            refreshProposals: () => { loadProposals(); },
            applyProposal: async (id) => {
              if (!API.mutatePartnerAction) return;
              try {
                // Reversible chain: approve -> execute (stores inverse) -> accept.
                await API.mutatePartnerAction(id, 'approve');
                await API.mutatePartnerAction(id, 'execute');
                await API.mutatePartnerAction(id, 'accept');
                await loadProposals();
              } catch (_e) {
                // Partial failure must not strand the action invisible:
                // cancel recovers proposed/approved states (a completed
                // action keeps its inverse for artist-owned revert).
                try { await API.mutatePartnerAction(id, 'cancel'); } catch (_e2) { /* already final */ }
                await loadProposals();
                toast('proposal needs the local server');
              }
            },
            cancelProposal: async (id) => {
              if (!API.mutatePartnerAction) return;
              try {
                await API.mutatePartnerAction(id, 'cancel');
                await loadProposals();
              } catch (_e) { toast('proposal needs the local server'); }
            },
            getCastState: () => state.freeformCast || null,
            toggleBound: async (id) => {
              if (!state.shot || !API.setShotCharacters) return;
              const cur = state.freeformCast || { boundIds: [] };
              const next = cur.boundIds.includes(id) ? cur.boundIds.filter((x) => x !== id) : [...cur.boundIds, id];
              try {
                const ctx = await API.setShotCharacters(state.shot.id, next);
                state.freeformCast = { ...cur, shotId: state.shot.id, boundIds: (ctx && Array.isArray(ctx.characterIds) ? ctx.characterIds : next) };
                if (state.freeform) state.freeform.refreshAll();
              } catch (_e) { toast('cast binding needs the local server'); }
```

## lib/workspace.js — sanitizeWindow/validate/assertBaseRevision/read-migration excerpts

```javascript
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

/* ------------------------------------------------------------- migration */

```

## 25-step journey manifest (step labels only)

```
function step(n, label) {
step(1, 'default boot mounts no freeform windows');
step(2, 'freeform boot reaches ready');
step(3, 'scenes and layers windows mount');
step(4, 'window chrome completeness');
step(5, 'empty project stays empty');
step(6, 'focus raises z-order');
step(7, 'native drag moves scenes');
step(8, 'edge drag stays floating for non-docking surface');
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
step(24, 'no snap preview for non-docking surfaces');
step(25, 'zero console errors');
```
