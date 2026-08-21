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
  function WindowManager({ root, document, api, viewportMetrics, shelfHost, geometry } = {}) {
    if (!root || !document) throw new Error('WindowManager requires root and document');
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
    let structuralWarned = false;

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
      const prev = saves.get(model.windowId) || Promise.resolve();
      const next = prev.then(() => api.upsertWorkspaceObject({
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
      })).then(() => { model.persistFailed = false; return model; }).catch((error) => {
        // Bounded failure signal: persistence must not break the creative
        // flow, but a window that never reaches disk deserves one visible
        // warning per window, not silence (adversarial-review repair).
        if (!model.persistFailed) {
          model.persistFailed = true;
          console.warn(`[freeform] window ${model.windowId} is not persisting:`, error && error.message || error);
        }
        return model;
      });
      saves.set(model.windowId, next);
      return next;
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
      const grip = el(document, 'div', 'freeform-window-resize');
      grip.setAttribute('aria-hidden', 'true');
      frame.append(tabsSlot, head, body, grip);
      root.appendChild(frame);
      model.frame = frame; model.body = body; model.head = head; model.title = title; model.tabsSlot = tabsSlot;
      installDrag(model); installResize(model, grip);
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
        frame.style.left = `${model.rect.x}px`;
        frame.style.top = `${model.rect.y}px`;
        frame.style.width = `${model.rect.width}px`;
        frame.style.height = `${model.rect.height}px`;
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
        };
        const up = async (ev) => {
          teardown();
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
      persist(model);
      persistShelfMembership();
      return model;
    }
    function restore(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      if (model.state !== 'minimised' && model.state !== 'tabbed') return model;
      transition(model, 'floating');
      renderFrame(model);
      renderShelf();
      bringToFront(windowId);
      persist(model);
      persistShelfMembership();
      return model;
    }
    function restoreAt(windowId, x, y) {
      const model = restore(windowId);
      if (model && Number.isFinite(x) && Number.isFinite(y)) {
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
        const sx = e.clientX; const sy = e.clientY; let dragged = false;
        const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) dragged = true; };
        const up = (ev) => {
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', up, true);
          if (!dragged) return; // a click is not a drag; the click handler restores
          if (e.preventDefault) e.preventDefault();
          const rect = (root.getBoundingClientRect && root.getBoundingClientRect()) || { left: 0, top: 0 };
          restoreAt(windowId, ev.clientX - rect.left, ev.clientY - rect.top);
        };
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', up, true);
      });
    }

    /** Shelf membership persists through the revision-gated shelf route. */
    function persistShelfMembership() {
      if (!api || typeof api.setWorkspaceShelf !== 'function') return Promise.resolve();
      const ids = [...windows.values()].filter((m) => m.state === 'minimised').map((m) => m.windowId);
      return api.setWorkspaceShelf(ids, { baseRevision: lastRevision }).then((res) => {
        const ws = res && res.workspace;
        if (ws && Number.isFinite(ws.revision)) lastRevision = ws.revision;
      }).catch((error) => {
        if (!structuralWarned) {
          structuralWarned = true;
          console.warn('[freeform] shelf is not persisting:', error && error.message || error);
        }
      });
    }
    function maximise(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      if (model.state === 'maximised') return model;
      transition(model, 'maximised');
      renderFrame(model);
      persist(model);
      return model;
    }
    function unmaximise(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      if (model.state !== 'maximised') return model;
      transition(model, 'floating');
      renderFrame(model);
      persist(model);
      return model;
    }
    function close(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      removeFromGroup(model); // group membership must never dangle past close (mission: closing one tab never destroys the others)
      const controller = controllers.get(windowId);
      if (controller && typeof controller.destroy === 'function') { try { controller.destroy(); } catch (_e) {} }
      if (model.frame && model.frame.parentNode) model.frame.parentNode.removeChild(model.frame);
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
        if (ws && Number.isFinite(ws.revision)) lastRevision = ws.revision;
        structuralWarned = false;
      }).catch((error) => {
        const ws = error && error.workspace;
        if (ws && Number.isFinite(ws.revision) && baseRevision !== null && !structuralWarned) {
          // Adopt the server's revision and retry once; further conflicts warn.
          structuralWarned = true;
          lastRevision = ws.revision;
          return attempt(ws.revision);
        }
        if (!structuralWarned) {
          structuralWarned = true;
          console.warn('[freeform] window groups are not persisting:', error && error.message || error);
        }
      });
      return attempt(lastRevision);
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
