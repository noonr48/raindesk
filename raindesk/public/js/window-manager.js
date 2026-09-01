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

  // True recursive freeze for declarative policy data (GPT Pro round-6):
  // shallow clones left nested objects mutable through retained sources AND
  // through the exposed definition. Clone-and-freeze every level.
  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }
  function frozenClone(value) {
    return value && typeof value === 'object'
      ? deepFreeze(Array.isArray(value) ? value.slice() : { ...value })
      : value;
  }

  const CreativeSurfaces = {
    register(surface) {
      if (!surface || typeof surface !== 'object') throw new Error('surface definition is required');
      if (typeof surface.id !== 'string' || !/^[a-z0-9_]{1,48}$/.test(surface.id)) {
        throw new Error(`surface id must be a short slug: ${surface && surface.id}`);
      }
      if (registry.has(surface.id)) return registry.get(surface.id);
      // Stage-2 P1: the coordinate authority of this surface's persisted
      // geometry. Content surfaces default to WORLD (canonical units);
      // only explicitly classified application chrome stays 'screen'.
      if (surface.coordinateSpace !== undefined && surface.coordinateSpace !== 'world' && surface.coordinateSpace !== 'screen') {
        throw new Error(`surface coordinateSpace must be 'world' or 'screen': ${surface.coordinateSpace}`);
      }
      const def = Object.freeze({
        id: surface.id,
        title: String(surface.title || surface.id),
        entityType: surface.entityType || 'generic_panel',
        coordinateSpace: surface.coordinateSpace === 'screen' ? 'screen' : 'world',
        createController: typeof surface.createController === 'function' ? surface.createController : null,
        minimumSize: Object.freeze({
          width: Math.max(120, Number(surface.minimumSize && surface.minimumSize.width) || 280),
          height: Math.max(90, Number(surface.minimumSize && surface.minimumSize.height) || 180),
        }),
        defaultPlacement: frozenClone(surface.defaultPlacement || { width: 460, height: 360, dock: null }),
        // Every window snaps to the desk edges by default (owner reference:
        // all panels dock); a surface opts out by declaring its own list.
        // Frozen ARRAY, not a Set: a Set's contents are mutable through the
        // exposed reference, so any controller could silently rewrite the
        // declared policy (GPT Pro round-4). Call sites use .includes().
        supportedStates: Object.freeze(
          (Array.isArray(surface.supportedStates) ? surface.supportedStates : ['floating', 'docked', 'minimised', 'maximised'])
            .filter((state) => SUPPORTED_STATES.has(state)),
        ),
        // Which EDGES a dock-capable surface may dock to (GPT Pro round-3:
        // vertical list/editor surfaces get left/right rails; top/bottom need
        // horizontal layouts that do not exist yet). Default: left+right.
        dockEdges: Object.freeze(
          (Array.isArray(surface.dockEdges) ? surface.dockEdges : ['left', 'right'])
            .filter((edge) => SNAP_ZONE_EDGES.includes(edge)),
        ),
        contextualTools: Object.freeze(
          (Array.isArray(surface.contextualTools) ? surface.contextualTools : [])
            .map((tool) => frozenClone(tool)),
        ),
      });
      registry.set(def.id, def);
      return def;
    },
    get(id) { return registry.get(id) || null; },
    ids() { return [...registry.keys()]; },
    clear() { registry.clear(); },
  };

  /* ------------------------------------------------------------- utilities */

  function el(document, tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  const DRAG_THRESHOLD_PX = 3;

  /* 8-way resize: edge strips + corner pads, keyed by data-resize-dir. */
  const RESIZE_DIRECTIONS = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
  const SNAP_ZONE_EDGES = Object.freeze(['left', 'right', 'top', 'bottom']);

  /* ---------------------------------------------------------- window model */

  /**
   * WindowManager({ root, document, api, viewportMetrics, shelfHost })
   *   .open(surfaceId, { entityRef, windowId, rect, focus })  -> controller
   *   .minimise(windowId) / .restore(windowId)
   *   .maximise(windowId) / .unmaximise(windowId)
   *   .bringToFront(windowId) / .focus(windowId)
   *   .close(windowId)
   *   .state(windowId) / .list()
   *   .init() — restore persisted windows (workspace v3 windows[])
   */
  function WindowManager({ root, document, api, v4: v4Given, viewportMetrics, shelfHost, geometry, getViewport: getViewportGiven } = {}) {
    if (!root || !document) throw new Error('WindowManager requires root and document');
    // v4 client: injected in production (app.js shares the boot-replay
    // client); self-constructed as a memory-only fallback when the host
    // provides the v4 api surface (tests, embedded hosts).
    const v4lib = (typeof RaindeskV4Client !== 'undefined' && RaindeskV4Client) || (root && root.RaindeskV4Client) || null;
    const v4 = v4Given || (v4lib && api && typeof api.applyWorkspaceIntent === 'function'
      ? v4lib.V4Client({ api, storage: null, warn: () => {} }) : null);
    // Stage-2 P2: the world projection — the ONE world↔screen authority
    // (public/js/world-projection.js). World-classified surfaces keep their
    // canonical rect in WORLD units; placement renders through the
    // projection and pointer deltas unproject at the live worldScale.
    const WProj = (typeof RaindeskWorldProjection !== 'undefined' && RaindeskWorldProjection)
      || (root && root.RaindeskWorldProjection)
      || (typeof require === 'function' ? require('./world-projection.js') : null);
    if (!WProj) throw new Error('WindowManager requires RaindeskWorldProjection (script order: world-projection.js before window-manager.js)');
    const getViewport = getViewportGiven || (() => ({ x: 0, y: 0, zoom: 1 }));
    const geo = geometry || Geometry;
    const metrics = viewportMetrics || (() => ({ width: root.clientWidth || 1280, height: root.clientHeight || 800 }));
    const windows = new Map();        // windowId -> model
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
    function isWorld(model) {
      const surface = surfaceFor(model);
      return Boolean(surface && surface.coordinateSpace === 'world');
    }
    /** Screen-space rect for RENDERING a world surface: projected placement
     * when floating/tabbed; the dock-rail presentation when docked (docking
     * is a temporary presentation, never a coordinate authority — Round-6).
     * Maximise is handled by the fullscreen branch (metrics-owned). */
    function screenRectOf(model) {
      const vp = getViewport(); const m = metrics(); const s = WProj.worldScale(vp, m) || 1;
      if (model.state === 'docked' && geo.dockRect) {
        return geo.dockRect(model.dock, { x: model.rect.x, y: model.rect.y, width: model.rect.width * s, height: model.rect.height * s }, m);
      }
      const p = WProj.worldToScreen(model.rect, vp, m);
      return { x: p.x, y: p.y, width: model.rect.width * s, height: model.rect.height * s };
    }

    function clampRect(rect, surface) {
      const min = surface ? surface.minimumSize : { width: 200, height: 140 };
      if (surface && surface.coordinateSpace === 'world') {
        // World surfaces clamp to per-surface minimums in WORLD units only —
        // no metrics coupling (the desk is endless; there is no viewport
        // edge in world space).
        return {
          x: Number.isFinite(rect.x) ? rect.x : 0,
          y: Number.isFinite(rect.y) ? rect.y : 0,
          width: Math.max(rect.width || min.width, min.width),
          height: Math.max(rect.height || min.height, min.height),
        };
      }
      const m = metrics();
      return {
        x: Number.isFinite(rect.x) ? rect.x : 0,
        y: Number.isFinite(rect.y) ? rect.y : 0,
        width: Math.min(Math.max(rect.width || min.width, min.width), Math.max(min.width, m.width)),
        height: Math.min(Math.max(rect.height || min.height, min.height), Math.max(min.height, m.height)),
      };
    }

    function defaultRect(surface) {
      if (surface && surface.coordinateSpace === 'world') {
        // World surfaces default into world units around the origin, spread
        // wide enough that siblings do not stack onto each other (the
        // journey caught a 40-unit cascade stacking windows into an
        // accidental drop-to-group at release).
        const n = windows.size;
        return clampRect({
          x: -400 + (n % 4) * 520,
          y: -180 + (n % 3) * 60,
          width: 460, height: 360,
        }, surface);
      }
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

    /* v4 spatial persistence: geometry and z-order ride the mutationId-
     * deduped PATCH lane; structural facts never travel here. A 410/409 for
     * our own incarnation means the server closed/replaced it — drop the
     * local ghost instead of fighting; transient failures warn once and
     * keep the window usable (the next gesture re-commits latest truth). */
    let mutationSeq = 0;
    const mintMutationId = () => `mut_${Date.now().toString(36)}_${(mutationSeq++).toString(36)}`;
    function persist(model, extra) {
      if (!v4 || !model.ref) return Promise.resolve(model);
      // Commit ADOPTS the rounded canonical values into the model so the
      // live render and the post-reload render project from identical
      // numbers — sub-pixel drift across reload otherwise breaks exact
      // geometry witnesses (journey step 19, journey-caught).
      const patch = {
        x: Math.round(model.rect.x), y: Math.round(model.rect.y),
        width: Math.round(model.rect.width), height: Math.round(model.rect.height),
        zIndex: model.zIndex,
      };
      model.rect.x = patch.x; model.rect.y = patch.y;
      model.rect.width = patch.width; model.rect.height = patch.height;
      if (model.frame) {
        // Adoption re-renders (idempotent): the live frame and the post-
        // reload render must project from identical numbers — the smoke
        // caught a 0.377px drift when the last drag render kept the
        // unrounded projection while reload rendered the rounded one.
        renderFrame(model);
      }
      const next = writeChain.then(() => v4.spatial(model.ref, patch, mintMutationId(), extra)).then((res) => {
        model.persisted = true; model.persistFailed = false;
        const row = res && res.window;
        if (row && row.ref) { model.ref = { ...row.ref }; if (row.spatialVersion) model.spatialVersion = row.spatialVersion; }
        return model;
      }).catch((error) => {
        const code = error && (error.code || (error.detail && error.detail.code));
        if (code === 'WINDOW_GENERATION_GONE' || code === 'INCARNATION_REPLACED') {
          dropModel(model.windowId, `window ${model.windowId} closed elsewhere (${code})`);
          return null;
        }
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

    /* ------------------------------------------------ v4 intent plumbing */

    const intentWarned = new Set();

    /** Serialize a v4 intent behind every pending write. The op is BUILT
     * AT SEND TIME (makeOp thunk): UI-event-time snapshots of model.ref
     * carried generation 0 whenever an op landed inside the create-response
     * window — the writeChain serializes ops AFTER the create link adopts
     * the canonical ref, so deferred construction always carries the
     * adopted generation (implementation-lens F2). Typed-terminal conflicts
     * (our incarnation gone/replaced) settle by dropping the local ghost;
     * transient failures warn once per kind — the outbox holds the op. */
    function queueIntent(makeOp) {
      if (!v4) return Promise.resolve(null);
      const run = () => {
        const op = typeof makeOp === 'function' ? makeOp() : makeOp;
        if (!op) return Promise.resolve(null);
        return v4.intent(op).then((response) => {
          if (response && response.changed) adoptResponse(response);
          return response;
        }).catch((error) => {
          const code = error && (error.code || (error.detail && error.detail.code));
          const target = (op.window || op.member || (op.target && op.target.window) || {}).windowId;
          if ((code === 'WINDOW_GENERATION_GONE' || code === 'INCARNATION_REPLACED') && target) {
            dropModel(target, `window ${target} closed elsewhere (${code})`);
          } else if (!intentWarned.has(op.kind)) {
            intentWarned.add(op.kind);
            console.warn('[freeform]', op.kind, 'not persisting:', error && error.message || error);
          }
          return null;
        });
      };
      writeChain = writeChain.then(run, run);
      return writeChain;
    }

    /** Server responses are canonical: adopt refs, derived presentation,
     * group membership and shelf state for every affected row. */
    function adoptResponse(response) {
      const changed = response && response.changed;
      if (!changed) return;
      if (Number.isFinite(response.structuralRevision)) lastRevision = Math.max(lastRevision, response.structuralRevision);
      for (const row of changed.windows || []) {
        if (!row || !row.ref) continue;
        const model = windows.get(row.ref.windowId);
        if (!model) continue;
        model.ref = { ...row.ref };
        const kind = row.presentation && row.presentation.kind;
        if (kind && model.state !== 'minimised' && model.state !== 'tabbed') {
          model.dock = kind === 'docked' ? row.presentation.edge : null;
          const next = kind === 'docked' ? 'docked' : kind === 'maximised' ? 'maximised' : 'floating';
          if (model.state !== next) {
            model.state = next;
            if (next === 'maximised' && !model.restoreRect) model.restoreRect = { ...model.rect };
            if (next !== 'maximised') model.restoreRect = null;
          }
        }
        renderFrame(model);
      }
      for (const group of changed.groups || []) {
        if (!group || !group.groupId) continue;
        if (Array.isArray(group.members) && group.members.length === 0) groups.delete(group.groupId);
        else if (Array.isArray(group.members)) {
          // Echoes reflect intent time: never REGRESS a newer local active
          // (the create/swap race class — journey-caught).
          const existing = groups.get(group.groupId);
          const activeId = existing && group.members.some((m) => m.windowId === existing.activeWindowId)
            ? existing.activeWindowId
            : (group.active && group.active.windowId);
          groups.set(group.groupId, {
            groupId: group.groupId, version: group.version,
            windowIds: group.members.map((m) => m.windowId),
            activeWindowId: activeId,
          });
          for (const m of group.members) { const win = windows.get(m.windowId); if (win) win.groupId = group.groupId; }
        }
      }
      if (changed.shelf && Array.isArray(changed.shelf.members)) {
        const shelved = new Set(changed.shelf.members.map((m) => m.windowId));
        for (const model of windows.values()) {
          if (model.state === 'minimised' && !shelved.has(model.windowId)) {
            model.state = 'floating';
            renderFrame(model);
          }
        }
        renderShelf();
      }
    }

    /** Remove a local model whose server incarnation is gone. */
    function dropModel(windowId, reason) {
      const model = windows.get(windowId);
      if (!model) return;
      console.warn(`[freeform] ${reason}`);
      abortGesturesFor(windowId);
      removeFromGroup(model);
      const controller = controllers.get(windowId);
      if (controller && typeof controller.destroy === 'function') { try { controller.destroy(); } catch (_e) {} }
      if (model.frame && model.frame.parentNode) model.frame.parentNode.removeChild(model.frame);
      windows.delete(windowId); controllers.delete(windowId); saves.delete(windowId);
      if (focusedId === windowId) focusedId = null;
      renderShelf();
    }

    /* ---------------------------------------------------------- rendering */

    function ensureFrame(model) {
      if (model.frame) return model.frame;
      const surface = surfaceFor(model);
      const frame = el(document, 'section', 'freeform-window');
      frame.dataset.windowId = model.windowId;
      frame.dataset.surface = model.surfaceId;
      const head = el(document, 'header', 'freeform-window-head');
      const tabsSlot = el(document, 'nav', 'freeform-window-tabs');
      tabsSlot.setAttribute('aria-label', 'window tabs');
      const title = el(document, 'span', 'freeform-window-title', model.title);
      const actions = el(document, 'span', 'freeform-window-actions');
      const btnMin = el(document, 'button', 'freeform-window-btn minimise', '—');
      btnMin.type = 'button'; btnMin.setAttribute('aria-label', 'minimise window');
      if (!shelfHostEl) {
        // No shelf yet: minimising would strand the window — keep
        // the affordance honest by disabling it with a reason instead of
        // letting a click lose the window for the session (adversarial repair).
        // attachShelf() re-enables these buttons.
        btnMin.disabled = true;
        btnMin.title = 'the shelf arrives with tab grouping — minimise comes with it';
      }
      const btnMax = el(document, 'button', 'freeform-window-btn maximise', '□');
      btnMax.type = 'button'; btnMax.setAttribute('aria-label', 'maximise window');
      const btnClose = el(document, 'button', 'freeform-window-btn close', '✕');
      btnClose.type = 'button'; btnClose.setAttribute('aria-label', 'close window');
      actions.append(btnMin, btnMax, btnClose);
      head.append(title, actions);
      const body = el(document, 'div', 'freeform-window-body');
      const resizeHandles = RESIZE_DIRECTIONS.map((dir) => {
        const handle = el(document, 'div', `freeform-window-resize ${dir}`);
        handle.setAttribute('aria-hidden', 'true');
        handle.dataset.resizeDir = dir;
        return handle;
      });
      frame.append(tabsSlot, head, body, ...resizeHandles);
      root.appendChild(frame);
      model.frame = frame; model.body = body; model.head = head; model.titleEl = title; model.tabsSlot = tabsSlot;
      installDrag(model); installResize(model, resizeHandles);
      btnMin.addEventListener('click', () => minimise(model.windowId));
      btnMax.addEventListener('click', () => (model.state === 'maximised' ? unmaximise(model.windowId) : maximise(model.windowId)));
      btnClose.addEventListener('click', () => close(model.windowId));
      frame.addEventListener('pointerdown', () => bringToFront(model.windowId), true);
      title.addEventListener('dblclick', () => {
        if (!model.onRename) return;
        title.setAttribute('contenteditable', 'true'); title.focus();
      });
      title.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); title.textContent = model.title; title.blur(); }
      });
      title.addEventListener('blur', () => {
        title.removeAttribute('contenteditable');
        const next = String(title.textContent || '').trim().slice(0, 120);
        if (!next || next === model.title) { title.textContent = model.title; return; }
        model.title = next;
        if (typeof model.onRename === 'function') model.onRename(next);
      });
      return frame;
    }

    function renderFrame(model) {
      const frame = ensureFrame(model);
      // Title SSOT: model.title is ALWAYS the string; the span is a projection
      // (S0 — kills the duplicate-key null-out and the span-overwrites-string
      // collision that left title bars empty until a manual rename).
      if (model.titleEl && model.titleEl.textContent !== String(model.title)) model.titleEl.textContent = String(model.title);
      const group = groupFor(model.windowId);
      const isHiddenMember = model.state === 'tabbed' && group && group.activeWindowId !== model.windowId;
      if (model.state === 'minimised' || isHiddenMember) { frame.hidden = true; return; }
      frame.hidden = false;
      if (model.state === 'maximised' && model.restoreRect) {
        const m = metrics();
        frame.classList.add('freeform-window-maximised');
        frame.style.left = '0px'; frame.style.top = '0px';
        frame.style.width = `${m.width}px`; frame.style.height = `${m.height}px`;
      } else {
        frame.classList.remove('freeform-window-maximised');
        // Stage-2 P2: world surfaces render through the projection (screen
        // placement is DERIVED; the canonical world rect is untouched).
        const r = isWorld(model) ? screenRectOf(model) : model.rect;
        frame.style.left = `${r.x}px`;
        frame.style.top = `${r.y}px`;
        frame.style.width = `${r.width}px`;
        frame.style.height = `${r.height}px`;
      }
      frame.classList.toggle('freeform-window-collapsed', Boolean(model.collapsed));
      frame.classList.toggle('freeform-window-locked', Boolean(model.locked));
      frame.classList.toggle('freeform-window-focused', model.windowId === focusedId);
      frame.classList.toggle('freeform-window-grouped', Boolean(group));
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
      if (surface && !ALWAYS_ALLOWED.has(next) && !surface.supportedStates.includes(next)) {
        throw new Error(`surface ${model.surfaceId} does not support state ${next}`);
      }
      const prev = model.state;
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
      // Dock lifecycle invariant (GPT Pro round-5): a stored edge means
      // "this window is docked" — EXCEPT on the way to the shelf, which
      // legitimately keeps it for the restore round trip. Any other exit
      // from docked clears it, so {floating/tabbed, dock} rows cannot exist
      // and a later minimise/restore can never surprise-redock.
      if (prev === 'docked' && next !== 'minimised' && next !== 'docked') model.dock = null;
    }

    /* ------------------------------------------------------ gesture logic */

    /* Gesture-session kernel (GPT Pro round-3 TOP-3 #2, gesture half).
     * ONE gesture per window: a second contact on the same window is
     * refused — it must never steer or commit another contact's gesture.
     * Environment interruption — pointercancel, lostpointercapture, window
     * blur, tab hidden — is a TERMINAL that cancels, never commits.
     * close() revokes any live gesture before destroying the window. */
    const activeGestures = new Map(); // windowId -> { onCancel, onHidden, cancel }
    function beginGesture(windowId, pointerId, cancel) {
      if (activeGestures.has(windowId)) return null; // busy: another gesture owns this window
      const samePointer = (ev) => !ev || ev.pointerId === undefined || ev.pointerId === pointerId;
      const onCancel = (ev) => {
        if (!samePointer(ev) || activeGestures.get(windowId) !== bundle) return;
        endGesture(windowId);
        try { cancel(); } catch (_e) {}
      };
      const onHidden = () => { if (document.hidden) onCancel(); };
      const bundle = { onCancel, onHidden, cancel };
      document.addEventListener('pointercancel', onCancel, true);
      document.addEventListener('visibilitychange', onHidden);
      activeGestures.set(windowId, bundle);
      return {
        end() { if (activeGestures.get(windowId) === bundle) endGesture(windowId); },
      };
    }
    // NOTE (deliberate scope cuts, evidence-dated 2026-08-23):
    // - `lostpointercapture` is NOT wired: it is dispatched asynchronously
    //   with a recycled pointerId, so a stale release from the PREVIOUS
    //   gesture is indistinguishable from genuine mid-gesture capture loss
    //   (intermittently cancelled healthy drags — journey step-8 race).
    // - window `blur` is NOT wired: probe-witnessed spurious blur events
    //   fire mid-gesture (focus churn / CDP attachment) and rolled back
    //   healthy drags. pointercancel covers real capture takeovers; a blur
    //   mid-gesture leaves the gesture alive to complete or cancel on its
    //   own terminals.
    // - `visibilitychange` cancels only when the document is actually
    //   hidden (it also fires on becoming visible).
    function endGesture(windowId) {
      const bundle = activeGestures.get(windowId);
      if (!bundle) return;
      document.removeEventListener('pointercancel', bundle.onCancel, true);
      document.removeEventListener('visibilitychange', bundle.onHidden);
      activeGestures.delete(windowId);
    }
    function abortGesturesFor(windowId) {
      const bundle = activeGestures.get(windowId);
      if (!bundle) return;
      endGesture(windowId);
      try { bundle.cancel(); } catch (_e) {}
    }

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
    function showSnapZones(activeDock, allowedEdges) {
      ensureSnapZones();
      snapZoneHost.classList.add('on');
      for (const [edge, zone] of snapZoneEls) {
        zone.classList.toggle('active', edge === activeDock);
        // Dock-policy honesty (GPT Pro round-3): an edge the surface may not
        // dock to never offers a target — the visible set equals the
        // dockable set.
        zone.classList.toggle('blocked', Array.isArray(allowedEdges) && !allowedEdges.includes(edge));
      }
    }
    function clearSnapZones() {
      if (!snapZoneHost) return;
      snapZoneHost.classList.remove('on');
      for (const [, zone] of snapZoneEls) zone.classList.remove('active');
    }

    function installDrag(model) {
      const head = model.head;
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button,input,textarea,a,[contenteditable="true"],[data-no-drag]')) return;
        const current = windows.get(model.windowId); if (!current || current.locked) return;
        if (current.state === 'maximised') return; // maximised windows do not drag; restore first
        e.preventDefault();
        const surface = surfaceFor(current);
        const canDock = Boolean(surface && surface.supportedStates.includes('docked'));
        const start = { x: e.clientX, y: e.clientY, ox: current.rect.x, oy: current.rect.y, pointerId: e.pointerId };
        // Deferred capture (>3px) so dblclick-to-rename survives; threshold
        // listeners live at DOCUMENT capture level because a steep drag can
        // leave the head rect on its first interpolated step (proven v1).
        let captured = false;
        let session = null;
        const moved = (ev) => Math.abs(ev.clientX - start.x) > DRAG_THRESHOLD_PX || Math.abs(ev.clientY - start.y) > DRAG_THRESHOLD_PX;
        const onKeyDown = (ev) => {
          if (ev.key !== 'Escape') return;
          // Escape cancels a pending drop: pre-gesture geometry, overlays
          // gone, listeners detached — the gesture never commits.
          if (session) session.end();
          current.rect.x = start.ox; current.rect.y = start.oy;
          renderFrame(current);
          try { if (captured) head.releasePointerCapture(start.pointerId); } catch (_e) {}
          clearSnapPreview();
          clearSnapZones();
          teardown();
        };
        const cancel = () => {
          // pointercancel / blur / hidden tab is a TERMINAL, never a commit
          // (GPT Pro round-3): restore the pre-gesture snapshot, clear
          // overlays, and persist nothing. The gesture kernel already
          // filtered to the initiating pointer and ended the session before
          // invoking this.
          teardown();
          try { if (captured) head.releasePointerCapture(start.pointerId); } catch (_e) {}
          clearSnapPreview();
          clearSnapZones();
          if (!captured) return;
          current.rect.x = start.ox; current.rect.y = start.oy;
          renderFrame(current);
        };
        const teardown = () => {
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', up, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
        // One gesture per window, for the whole down->up lifecycle: a second
        // contact on this window is refused (kernel lock, GPT Pro round-3).
        session = beginGesture(current.windowId, start.pointerId, cancel);
        if (!session) return; // another gesture owns this window
        const move = (ev) => {
          if (ev.pointerId !== start.pointerId) return; // foreign pointer: never steer another gesture
          if (!ev.buttons) {
            // Severed gesture (buttons lost) is a cancel terminal too: the
            // mutated rect is rolled back, never left half-way (GPT Pro r3).
            session.end();
            teardown();
            clearSnapPreview();
            clearSnapZones();
            try { if (captured) head.releasePointerCapture(start.pointerId); } catch (_e) {}
            if (captured) { current.rect.x = start.ox; current.rect.y = start.oy; renderFrame(current); }
            return;
          }
          if (!captured) {
            if (!moved(ev)) return;
            captured = true;
            try { head.setPointerCapture(ev.pointerId); } catch (_e) {}
            bringToFront(current.windowId);
          }
          if (isWorld(current)) {
            // Pointer deltas unproject at the live worldScale (P2).
            const s = WProj.worldScale(getViewport(), metrics()) || 1;
            current.rect.x = start.ox + (ev.clientX - start.x) / s;
            current.rect.y = start.oy + (ev.clientY - start.y) / s;
          } else {
            current.rect.x = start.ox + (ev.clientX - start.x);
            current.rect.y = start.oy + (ev.clientY - start.y);
          }
          renderFrame(current);
          // Phase 5: preview the dock the drag would settle into.
          // Phase 6: light up the four edge zones, emphasizing the one
          // snapPlace() would choose. Alt disables snapping entirely —
          // zones included.
          const preview = snapPlace(current, ev.altKey);
          if (canDock && !ev.altKey) showSnapZones(preview ? preview.dock : null, surface && surface.dockEdges);
          else clearSnapZones();
          showSnapPreview(preview ? preview.rect : null);
        };
        const up = async (ev) => {
          if (ev.pointerId !== start.pointerId) return; // foreign pointer cannot commit or tear down
          session.end();
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
          else if (current.state === 'docked') { // dragged off the edge re-floats
            current.dock = null; transition(current, 'floating');
            if (v4 && current.ref) queueIntent(() => ({ kind: 'window.setPresentation', window: { ...current.ref }, mode: 'floating', floatingAt: { x: Math.round(current.rect.x), y: Math.round(current.rect.y) } }));
          }
          renderFrame(current);
          await persist(current);
        };
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', up, true);
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
          const surface = surfaceFor(current);
          const min = surface ? surface.minimumSize : { width: 200, height: 140 };
          const start = { x: e.clientX, y: e.clientY, rect: { ...current.rect }, state: current.state, dock: current.dock, collapsed: current.collapsed, pointerId: e.pointerId };
          // One gesture per window (kernel lock): a second contact on this
          // window must never steer or commit another contact's resize.
          // The lock is acquired BEFORE pointer capture so a refused second
          // pointer is never left captured without an owning session
          // (GPT Pro round-4).
          const session = beginGesture(model.windowId, e.pointerId, () => cancel({ pointerId: start.pointerId }));
          if (!session) return; // another gesture owns this window
          try { grip.setPointerCapture(e.pointerId); } catch (_e) {}
          const move = (ev) => {
            if (ev.pointerId !== start.pointerId) return; // foreign pointer
            if (ev.buttons === 0) { cancel(ev); return; } // severed buttons: cancel terminal, never half-commit (GPT Pro r3)
            // Docked invariant (GPT Pro round-4): pulling the ANCHORED edge
            // of a docked window explicitly undocks it instead of dragging
            // the dock edge along with the resize.
            if (current.state === 'docked' && current.dock) {
              const pull = { left: 'w', right: 'e', top: 'n', bottom: 's' }[current.dock];
              if (dir.includes(pull)) { current.dock = null; transition(current, 'floating'); }
            }
            const r = start.rect;
            let left = r.x; let top = r.y;
            let right = r.x + r.width; let bottom = r.y + r.height;
            // Moving edges clamp against the opposite (anchored) edge so the
            // per-surface minimum size holds; free edges simply grow/shrink.
            // World surfaces unproject pointer deltas at the live scale (P2).
            const ws = isWorld(current) ? (WProj.worldScale(getViewport(), metrics()) || 1) : 1;
            const dx = (ev.clientX - start.x) / ws;
            const dy = (ev.clientY - start.y) / ws;
            if (dir.includes('e')) right = Math.max(right + dx, left + min.width);
            if (dir.includes('w')) left = Math.min(left + dx, right - min.width);
            if (dir.includes('s')) bottom = Math.max(bottom + dy, top + min.height);
            if (dir.includes('n')) top = Math.min(top + dy, bottom - min.height);
            current.rect = { x: left, y: top, width: right - left, height: bottom - top };
            renderFrame(current);
          };
          const detach = () => {
            grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', cancel);
          };
          const up = async (ev) => {
            if (ev.pointerId !== start.pointerId) return; // foreign pointer
            session.end();
            try { grip.releasePointerCapture(ev.pointerId); } catch (_e) {}
            detach();
            await persist(current);
          };
          // Interrupted resize reverts to the pre-gesture rect instead of
          // committing half a gesture (GPT Pro round-4 finding). The kernel
          // routes pointercancel/lostpointercapture/blur/visibility here too.
          const cancel = (ev) => {
            if (ev && ev.pointerId !== undefined && ev.pointerId !== start.pointerId) return; // foreign pointer
            session.end();
            try { grip.releasePointerCapture(start.pointerId); } catch (_e) {}
            // Full-lifecycle rollback (GPT Pro round-5): a cancel after a
            // mid-resize anchored-edge undock must restore state and dock
            // too — rect alone left a floating model with the docked row on
            // the server, visibly flipping again on reload.
            current.rect = { ...start.rect };
            if (current.state !== start.state || current.dock !== start.dock || current.collapsed !== start.collapsed) {
              current.dock = start.dock;
              current.collapsed = start.collapsed;
              transition(current, start.state);
            }
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
      if (!surface || !surface.supportedStates.includes('docked')) return null;
      const m = metrics();
      // Stage-2 P2: edge detection runs in SCREEN space. World surfaces
      // project the canonical rect first (no dock branch — a docked model
      // being dragged must detect from where its latent rect projects, not
      // from the rail it is leaving).
      let rect;
      if (isWorld(model)) {
        const vp = getViewport(); const s = WProj.worldScale(vp, m) || 1;
        const p = WProj.worldToScreen(model.rect, vp, m);
        rect = { x: p.x, y: p.y, width: model.rect.width * s, height: model.rect.height * s };
      } else {
        rect = { ...model.rect, width: model.rect.width, height: model.rect.height };
      }
      if (geo.edgeSnap) {
        const edge = geo.edgeSnap(rect, m, 18);
        // Dock-policy honesty (GPT Pro round-3): an edge outside the
        // surface's allowed dockEdges never offers a dock or a preview.
        if (edge && edge.dock && surface.dockEdges.includes(edge.dock)) return { kind: 'dock', dock: edge.dock, rect: edge.rect };
      }
      return null;
    }
    function applySnap(model, snapped) {
      if (snapped.kind === 'dock') {
        // Stage-2 P2: a docked WORLD surface keeps its canonical world rect
        // LATENT (docking is a temporary presentation, never a coordinate
        // authority — Round-6); screen surfaces keep the baked rail rect.
        if (!isWorld(model)) model.rect = { ...snapped.rect };
        model.dock = snapped.dock; // durable edge: docking must survive reload (GPT Pro round-3)
        transition(model, 'docked');
        if (v4 && model.ref) queueIntent(() => ({ kind: 'window.setPresentation', window: { ...model.ref }, mode: 'docked', edge: snapped.dock }));
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
        dock: null,
        collapsed: false, pinned: false, locked: false,
        restoreRect: null,
        ref: { windowId, generation: 0, incarnationId: v4 ? v4.mintIncarnation(windowId) : `inc_${windowId}` },
        onRename: options.onRename || null,
        frame: null, body: null, head: null, titleEl: null,
      };
      windows.set(windowId, model);
      if (options.state && surface.supportedStates.includes(options.state)) model.state = options.state;
      renderFrame(model);
      let controller = null;
      if (surface.createController) {
        controller = surface.createController({
          windowId, body: model.body, api, document, root,
          setTitle(title) { model.title = String(title || '').slice(0, 120); renderFrame(model); },
          close: () => close(windowId),
        }) || null;
      }
      controllers.set(windowId, controller);
      bringToFront(windowId);
      if (options.focus !== false) focus(windowId);
      // v4 create: identity-safe birth. The outbox holds the intent durably
      // until the server confirms; the response adopts the canonical ref
      // (generation becomes server truth). Transient failure warns once per
      // window — geometry re-commits on the next gesture.
      if (v4) {
        writeChain = writeChain.then(() => v4.intent({
          kind: 'window.create', windowId, incarnationId: model.ref.incarnationId,
          type: model.entityType, entityRef: model.entityRef || undefined,
          space: surface.coordinateSpace || undefined,
          x: Math.round(model.rect.x), y: Math.round(model.rect.y),
          width: Math.round(model.rect.width), height: Math.round(model.rect.height),
        }).then((response) => {
          const row = response && response.changed && response.changed.windows && response.changed.windows[0];
          if (row && row.ref) model.ref = { ...row.ref };
          model.persisted = true; model.persistFailed = false;
        }).catch((error) => {
          if (!model.persistFailed) {
            model.persistFailed = true;
            console.warn(`[freeform] window ${windowId} create not persisting:`, error && error.message || error);
          }
        }));
      }
      return controller;
    }

    function bringToFront(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      model.zIndex = ++zTop;
      renderFrame(model);
      return model;
    }
    function focus(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      focusedId = windowId;
      model.zIndex = ++zTop;
      renderAll();
      return model;
    }

    function minimise(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      removeFromGroup(model); // a shelf window is not a tab member
      transition(model, 'minimised');
      renderFrame(model);
      renderShelf();
      if (v4 && model.ref) queueIntent(() => ({ kind: 'shelf.minimise', window: { ...model.ref } }));
      return model;
    }
    function restore(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      if (model.state !== 'minimised' && model.state !== 'tabbed') return model;
      // Dock durability through the shelf (GPT Pro round-4): a window that
      // was docked before minimising returns to its stored edge when the
      // surface policy still allows it.
      const surface = surfaceFor(model);
      const dockOk = Boolean(model.dock && surface && surface.supportedStates.includes('docked') && surface.dockEdges.includes(model.dock));
      transition(model, dockOk ? 'docked' : 'floating');
      if (dockOk) model.collapsed = false; // shelf restore must show content, not a header-only rail (GPT Pro round-5)
      if (dockOk && geo.dockRect && !isWorld(model)) model.rect = geo.dockRect(model.dock, model.rect, metrics()); // world surfaces render the rail from the edge; the world rect stays latent (P2)
      renderFrame(model);
      renderShelf();
      bringToFront(windowId);
      if (v4 && model.ref) queueIntent(() => ({
        kind: 'shelf.restore', window: { ...model.ref },
        mode: dockOk ? 'resume' : 'floating',
        ...(dockOk ? {} : { floatingAt: { x: Math.round(model.rect.x), y: Math.round(model.rect.y) } }),
      }));
      persist(model);
      return model;
    }
    function restoreAt(windowId, x, y) {
      const model = restore(windowId);
      if (model && Number.isFinite(x) && Number.isFinite(y)) {
        if (model.state === 'docked') { // explicit placement wins over the stored dock
          model.dock = null; transition(model, 'floating');
          if (v4 && model.ref) queueIntent(() => ({ kind: 'window.setPresentation', window: { ...model.ref }, mode: 'floating', floatingAt: { x: Math.round(x), y: Math.round(y) } }));
        }
        model.rect.x = x; model.rect.y = y;
        renderFrame(model);
        persist(model);
      }
      return model;
    }

    /* ---------------------------------------------------------- shelf */

    /** Bind (or rebind) the shelf host: calm chip strip for minimised
     * windows. Re-enables any disabled minimise buttons. */
    function attachShelf(host) {
      shelfHostEl = host || null;
      for (const model of windows.values()) {
        const btn = model.frame && model.frame.querySelector && model.frame.querySelector('.freeform-window-btn.minimise');
        if (btn) { btn.disabled = false; btn.title = ''; }
      }
      renderShelf();
      return shelfHostEl;
    }

    function renderShelf() {
      if (!shelfHostEl) return;
      shelfHostEl.innerHTML = '';
      for (const model of windows.values()) {
        if (model.state !== 'minimised') continue;
        const chip = el(document, 'button', 'freeform-shelf-chip', model.title);
        chip.type = 'button';
        chip.dataset.windowId = model.windowId;
        chip.setAttribute('aria-label', `restore ${model.title}`);
        chip.addEventListener('click', () => restore(model.windowId));
        installShelfChipDrag(chip, model.windowId);
        shelfHostEl.appendChild(chip);
      }
    }

    /** Drag a shelf chip out (>10px) to re-float the window at the drop
     * point — the shelf twin of tab tear-out. */
    function installShelfChipDrag(chip, windowId) {
      chip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const pid = e.pointerId;
        const sx = e.clientX; const sy = e.clientY; let dragged = false;
        const detach = () => {
          try { chip.releasePointerCapture(pid); } catch (_e) {}
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', up, true);
        };
        // Kernel: one gesture per window; interruption cancels (chip drag
        // mutates only at up, so cancel = detach).
        const session = beginGesture(windowId, pid, detach);
        if (!session) return; // another gesture owns this window
        // Pointer capture — same rationale as tab tear (GPT Pro round-5):
        // a release outside the viewport must still terminate the session.
        try { chip.setPointerCapture(pid); } catch (_e) {}
        const move = (ev) => {
          if (ev.pointerId !== pid) return;
          if (ev.buttons === 0) { session.end(); detach(); return; } // severed: never restore from a dead pointer (GPT Pro round-4)
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) dragged = true;
        };
        const up = (ev) => {
          if (ev.pointerId !== pid) return;
          session.end();
          detach();
          if (!dragged) return; // a click is not a drag; the click handler restores
          if (e.preventDefault) e.preventDefault();
          const rect = (root.getBoundingClientRect && root.getBoundingClientRect()) || { left: 0, top: 0 };
          restoreAt(windowId, ev.clientX - rect.left, ev.clientY - rect.top);
        };
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', up, true);
      });
    }

    /* (v3 whole-collection persistence removed by the v4 cutover: groups,
     * shelf and delete now travel as identity-exact intents — see
     * queueIntent. Criterion: zero v3 workspace writes in this module.) */
    function maximise(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      if (model.state === 'maximised') return model;
      transition(model, 'maximised');
      renderFrame(model);
      if (v4 && model.ref) queueIntent(() => ({ kind: 'window.setPresentation', window: { ...model.ref }, mode: 'maximised' }));
      return model;
    }
    function unmaximise(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      if (model.state !== 'maximised') return model;
      transition(model, 'floating');
      renderFrame(model);
      // v4 restore re-applies the typed beforeMaximise presentation (the
      // server remembers the dock edge the old state machine lost).
      if (v4 && model.ref) queueIntent(() => ({ kind: 'window.setPresentation', window: { ...model.ref }, mode: 'restore' }));
      return model;
    }
    function close(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      abortGesturesFor(windowId); // a live gesture must not outlive its window (GPT Pro round-3)
      removeFromGroup(model); // group membership must never dangle past close (mission: closing one tab never destroys the others)
      const controller = controllers.get(windowId);
      if (controller && typeof controller.destroy === 'function') { try { controller.destroy(); } catch (_e) {} }
      if (model.frame && model.frame.parentNode) model.frame.parentNode.removeChild(model.frame);
      windows.delete(windowId); controllers.delete(windowId); saves.delete(windowId);
      if (focusedId === windowId) focusedId = null;
      if (v4 && model.ref) {
        // v4 close: identity-exact and durable — the outbox holds the intent
        // until the server confirms THIS incarnation tombstoned; boot replay
        // precedes restore, so a dropped response can never resurrect the
        // row (the race this protocol exists to kill).
        writeChain = writeChain.then(() => v4.intent({ kind: 'window.close', window: { ...model.ref } }))
          .catch((error) => {
            const code = error && (error.code || (error.detail && error.detail.code));
            if (code === 'WINDOW_GENERATION_GONE' || code === 'INCARNATION_REPLACED') return null; // already settled server-side
            console.warn(`[freeform] window ${windowId} close not confirmed:`, error && error.message || error);
            return null;
          });
      }
      return model;
    }

    function state(windowId) {
      const model = windows.get(windowId);
      if (!model) return null;
      return { windowId, surfaceId: model.surfaceId, state: model.state, title: model.title, ref: model.ref ? { ...model.ref } : null,
        rect: { ...model.rect }, zIndex: model.zIndex, collapsed: model.collapsed, dock: model.dock || null,
        pinned: model.pinned, locked: model.locked, focused: model.windowId === focusedId };
    }
    function list() { return [...windows.keys()].map(state); }

    /** Restore persisted windows from the canonical v4 document. */
    async function init() {
      if (!api || typeof api.getWorkspaceV4 !== 'function') return list();
      let ws = null;
      try { ws = await api.getWorkspaceV4(); } catch (_e) { return list(); }
      // The structural revision is a sync cursor (advisory), never a gate.
      if (ws && Number.isFinite(ws.structuralRevision)) lastRevision = Math.max(lastRevision || 0, ws.structuralRevision);
      // v4 derives lifecycle from canonical ownership: shelf members are
      // minimised, group members tabbed, presentation speaks for the rest.
      const shelfIds = new Set((ws && ws.shelf && Array.isArray(ws.shelf.members) ? ws.shelf.members : []).map((m) => m.windowId));
      const groupOf = new Map();
      for (const g of (ws && Array.isArray(ws.groups) ? ws.groups : [])) {
        if (!g || !g.groupId || !Array.isArray(g.members)) continue;
        for (const m of g.members) groupOf.set(m.windowId, g);
      }
      const freeformWindows = (ws && Array.isArray(ws.windows) ? ws.windows : [])
        .filter((win) => win && win.ref && String(win.ref.windowId).startsWith('window_'));
      for (const win of freeformWindows) {
        const surfaceId = surfaceIdForEntityType(win.type, win.entityRef);
        if (!surfaceId || !CreativeSurfaces.get(surfaceId)) continue;
        if (windows.has(win.ref.windowId)) continue;
        const group = groupOf.get(win.ref.windowId);
        const onShelf = shelfIds.has(win.ref.windowId);
        const kind = win.presentation && win.presentation.kind;
        const model = {
          windowId: win.ref.windowId, surfaceId,
          ref: { ...win.ref },
          title: win.ref.windowId, entityType: win.type,
          entityRef: win.entityRef || null,
          rect: clampRect({ x: win.spatial.x, y: win.spatial.y, width: win.spatial.width, height: win.spatial.height }, CreativeSurfaces.get(surfaceId)),
          zIndex: Number(win.spatial.zIndex) || 1,
          state: onShelf ? 'minimised' : group ? 'tabbed' : (kind === 'docked' ? 'docked' : kind === 'maximised' ? 'maximised' : 'floating'),
          collapsed: Boolean(win.collapsed), pinned: Boolean(win.pinned), locked: Boolean(win.locked),
          groupId: group ? group.groupId : null,
          dock: kind === 'docked' ? win.presentation.edge : null,
          restoreRect: null, onRename: null, frame: null, body: null, head: null, titleEl: null, tabsSlot: null,
        };
        if (onShelf) continue; // restored below as shelf-backed models
        // Stage-2 P3: legacy rows persisted by the pre-world client carry
        // SCREEN-unit geometry flagged space:'screen' — convert through the
        // LIVE viewport+metrics (exact; the server lacks stage metrics —
        // LEDGER L-4) and re-persist the canonical world rect.
        if (v4 && win.space !== 'world') {
          const legacySurface = CreativeSurfaces.get(surfaceId);
          if (legacySurface && legacySurface.coordinateSpace === 'world') {
            const vp = getViewport(); const m = metrics();
            const s = WProj.worldScale(vp, m) || 1;
            const world = WProj.screenToWorld(model.rect, vp, m);
            model.rect = clampRect({ ...model.rect, x: world.x, y: world.y, width: model.rect.width / s, height: model.rect.height / s }, legacySurface);
            persist(model, { space: 'world' }); // true-up: the flag rides the conversion — no future reload re-converts
          }
        }
        if (model.state === 'maximised') model.restoreRect = { ...model.rect };
        // Docked windows stay docked durably: the stored edge re-derives
        // geometry against current metrics. Per-SURFACE dock policy is a
        // client registry fact the server cannot know — an edge the surface
        // no longer allows downgrades honestly (durable repair intent,
        // GPT Pro round-4).
        if (model.state === 'docked') {
          const surface = surfaceFor(model);
          const edgeAllowed = surface && surface.supportedStates.includes('docked') && surface.dockEdges.includes(model.dock);
          if (model.dock && edgeAllowed) {
            // Stage-2 B2 repair (implementation-lens): a docked WORLD surface
            // keeps its canonical world rect LATENT here too — the rail is a
            // presentation rendered from the edge (screenRectOf), never a
            // coordinate authority. Every other dock site already guards;
            // this one clobbered the latent rect on every boot.
            if (!isWorld(model)) model.rect = geo.dockRect ? geo.dockRect(model.dock, model.rect, metrics()) : model.rect;
          } else {
            model.state = 'floating';
            model.dock = null;
            if (v4) queueIntent(() => ({ kind: 'window.setPresentation', window: { ...model.ref }, mode: 'floating', floatingAt: { x: Math.round(model.rect.x), y: Math.round(model.rect.y) } }));
          }
        }
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
        if (!win || !win.ref || !shelfIds.has(win.ref.windowId)) continue;
        if (windows.has(win.ref.windowId)) continue;
        const surfaceId = surfaceIdForEntityType(win.type, win.entityRef);
        if (!surfaceId || !CreativeSurfaces.get(surfaceId)) continue;
        const kind = win.presentation && win.presentation.kind;
        const model = {
          windowId: win.ref.windowId, surfaceId,
          ref: { ...win.ref },
          title: win.ref.windowId, entityType: win.type,
          entityRef: win.entityRef || null,
          rect: clampRect({ x: win.spatial.x, y: win.spatial.y, width: win.spatial.width, height: win.spatial.height }, CreativeSurfaces.get(surfaceId)),
          zIndex: Number(win.spatial.zIndex) || 1,
          state: 'minimised',
          dock: kind === 'docked' ? win.presentation.edge : null,
          collapsed: true, pinned: Boolean(win.pinned), locked: Boolean(win.locked),
          restoreRect: null, onRename: null, frame: null, body: null, head: null, titleEl: null, tabsSlot: null,
        };
        // Stage-2 P3: legacy shelf-backed rows convert too (same live-viewport
        // math as the floating path).
        if (v4 && win.space !== 'world') {
          const legacySurface = CreativeSurfaces.get(surfaceId);
          if (legacySurface && legacySurface.coordinateSpace === 'world') {
            const vp = getViewport(); const m = metrics();
            const s = WProj.worldScale(vp, m) || 1;
            const world = WProj.screenToWorld(model.rect, vp, m);
            model.rect = clampRect({ ...model.rect, x: world.x, y: world.y, width: model.rect.width / s, height: model.rect.height / s }, legacySurface);
            persist(model, { space: 'world' }); // true-up rides the conversion here too
          }
        }
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
        if (!group || !group.groupId || !Array.isArray(group.members)) continue;
        const windowIds = group.members.map((m) => m.windowId).filter((id) => windows.has(id) && !shelfIds.has(id));
        if (windowIds.length < 2) continue;
        const activeId = group.active && group.active.windowId;
        const activeWindowId = windowIds.includes(activeId) ? activeId : windowIds[0];
        groups.set(group.groupId, { groupId: group.groupId, version: group.version, windowIds, activeWindowId });
      }
      if (ws && ws.focus && windows.has(ws.focus.windowId)) focusedId = ws.focus.windowId;
      for (const model of windows.values()) {
        if (model.state === 'tabbed' && (!model.groupId || !groups.has(model.groupId))) {
          // Loudness parity (GPT Pro round-6 adversarial finding): silent
          // drift between this singleton gate (<2 live members) and the
          // server's keep-alive policy let the next whole-array write erase
          // surviving groups unnoticed. Full reconciliation lands with the
          // Stage-1 intent protocol; until then this stays VISIBLE.
          console.warn('[freeform] stranded tabbed window re-floated:', model.windowId);
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
    }

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
        const pid = e.pointerId;
        const sx = e.clientX; const sy = e.clientY; let torn = false;
        const detach = () => {
          try { tab.releasePointerCapture(pid); } catch (_e) {}
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', up, true);
        };
        // Kernel: one gesture per window; environment interruption cancels
        // cleanly (tab tear mutates only at up, so cancel = detach).
        const session = beginGesture(memberId, pid, detach);
        if (!session) return; // another gesture owns this window
        // Pointer capture (GPT Pro round-5): without it, a release OUTSIDE
        // the viewport never delivers pointerup to the document, stranding
        // this session's listeners — a later same-pointerId gesture then
        // feeds the stale session (and the per-window lock refuses the new
        // one), tearing a tab at unrelated coordinates. Capture makes the
        // terminal always-delivered.
        try { tab.setPointerCapture(pid); } catch (_e) {}
        const move = (ev) => {
          if (ev.pointerId !== pid) return;
          if (ev.buttons === 0) { session.end(); detach(); return; } // severed: never tear from a dead pointer (GPT Pro round-4)
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) torn = true;
        };
        const up = (ev) => {
          if (ev.pointerId !== pid) return;
          session.end();
          detach();
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
      renderFrame(model);
      if (v4 && model.ref && model.groupId === null) queueIntent(() => ({
        kind: 'group.leave', member: { ...model.ref }, mode: 'floating',
        floatingAt: { x: Math.round(model.rect.x), y: Math.round(model.rect.y) },
      }));
      persist(model);
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
      }
      bringToFront(activeWindowId);
      if (v4) {
        queueIntent(() => {
          const refs = ids.map((id) => windows.get(id)).filter(Boolean).map((m) => ({ ...m.ref }));
          return { kind: 'group.create', members: refs, active: { ...(windows.get(activeWindowId) || { ref: refs[0] }).ref } };
        })
          .then((response) => {
            const created = response && response.changed && response.changed.createdGroup;
            if (created && created.groupId !== groupId) {
              // Read the LIVE provisional record at swap time — a switchTab
              // may have advanced its active while the create response was
              // in flight (journey-caught race); never regress it.
              const provisional = groups.get(groupId);
              const activeStillMember = provisional && provisional.windowIds.includes(provisional.activeWindowId)
                ? provisional.activeWindowId
                : (created.active && created.active.windowId);
              groups.delete(groupId); // provisional local id yields to the server's canonical one
              groups.set(created.groupId, { groupId: created.groupId, version: created.version, windowIds: created.members.map((m) => m.windowId), activeWindowId: activeStillMember });
              for (const m of created.members) { const win = windows.get(m.windowId); if (win) win.groupId = created.groupId; }
              renderAll();
            }
          });
      }
      return groups.get(groupId);
    }

    function ungroup(groupIdOrWindowId) {
      const group = groups.get(groupIdOrWindowId) || groupFor(groupIdOrWindowId);
      if (!group) return null;
      // Identity-exact dissolve (F1 class): capture a member ref BEFORE the
      // local teardown — the server resolves the group from the member, so
      // no id race exists even inside the create-response swap window.
      const firstModel = group.windowIds.length ? windows.get(group.windowIds[0]) : null;
      const dissolveMember = firstModel && firstModel.ref ? { ...firstModel.ref } : null;
      for (const id of group.windowIds.slice()) {
        const model = windows.get(id);
        if (!model) continue;
        model.groupId = null;
        transition(model, 'floating');
        renderFrame(model);
        persist(model);
      }
      groups.delete(group.groupId);
      if (v4 && dissolveMember) queueIntent(() => ({ kind: 'group.dissolve', member: { ...dissolveMember } }));
      return group;
    }

    function switchTab(memberId) {
      const group = groupFor(memberId);
      if (!group) return null;
      group.activeWindowId = memberId;
      for (const id of group.windowIds) renderFrame(windows.get(id));
      bringToFront(memberId);
      if (v4) queueIntent(() => {
        const live = groupFor(memberId) || group; // re-resolve at SEND time: the provisional record may have been swapped for the server's
        return {
          kind: 'group.activate',
          groupId: live.groupId,
          member: { ...(windows.get(memberId) || {}).ref },
        };
      });
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
      let madeGroup = false;
      if (!group) {
        const groupId = `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        group = { groupId, windowIds: [target.windowId], activeWindowId: target.windowId };
        groups.set(groupId, group);
        target.groupId = groupId;
        transition(target, 'tabbed');
        madeGroup = true;
      }
      group.windowIds.push(model.windowId);
      model.groupId = group.groupId;
      transition(model, 'tabbed');
      renderAll(); renderShelf();
      if (v4) {
        if (madeGroup) {
          queueIntent(() => ({ kind: 'group.create', members: [{ ...target.ref }, { ...model.ref }], active: { ...target.ref } }))
            .then((response) => {
              const created = response && response.changed && response.changed.createdGroup;
              if (created && created.groupId !== group.groupId) {
                groups.delete(group.groupId);
                const activeStillMember = group.windowIds.includes(group.activeWindowId)
                  ? group.activeWindowId
                  : (created.active && created.active.windowId);
                groups.set(created.groupId, { groupId: created.groupId, version: created.version, windowIds: created.members.map((m) => m.windowId), activeWindowId: activeStillMember });
                for (const m of created.members) { const win = windows.get(m.windowId); if (win) win.groupId = created.groupId; }
                renderAll();
              }
            });
        } else {
          queueIntent(() => ({ kind: 'group.join', member: { ...model.ref }, target: { groupId: (groupFor(model.windowId) || group).groupId } })); // re-resolve at SEND time (F1 class)
        }
      }
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
      if (v4 && model.ref) {
        // Express the settled local order as ONE server reorder: insert the
        // member before the member that now follows it (null = append).
        const idx = group.windowIds.indexOf(memberId);
        const beforeId = idx + 1 < group.windowIds.length ? group.windowIds[idx + 1] : null;
        const beforeModel = beforeId ? windows.get(beforeId) : null;
        queueIntent(() => {
          const idx2 = group.windowIds.indexOf(memberId);
          const beforeId2 = idx2 + 1 < group.windowIds.length ? group.windowIds[idx2 + 1] : null;
          const beforeModel2 = beforeId2 ? windows.get(beforeId2) : null;
          const liveGroup = groupFor(memberId) || group; // re-resolve at SEND time (F1 class)
          return {
            kind: 'group.reorder', groupId: liveGroup.groupId, member: { ...model.ref },
            ...(beforeModel2 && beforeModel2.ref ? { before: { ...beforeModel2.ref } } : {}),
          };
        });
      }
      return group;
    }

    return { open, close, minimise, restore, restoreAt, maximise, unmaximise, bringToFront, focus, state, list, init, refreshAll, renderAll,
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
