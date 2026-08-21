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
      if (!shelfHost) {
        // No shelf yet (Phase 2): minimising would strand the window — keep
        // the affordance honest by disabling it with a reason instead of
        // letting a click lose the window for the session (adversarial repair).
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
      transition(model, 'minimised');
      if (shelfHost) shelfHost.dispatchEvent(new (document.defaultView || root.ownerDocument.defaultView || root).CustomEvent('freeform:shelf-add', { detail: { windowId } }));
      renderFrame(model);
      persist(model);
      return model;
    }
    function restore(windowId) {
      const model = windows.get(windowId); if (!model) return null;
      if (model.state !== 'minimised' && model.state !== 'tabbed') return model;
      transition(model, 'floating');
      if (shelfHost) shelfHost.dispatchEvent(new (document.defaultView || root.ownerDocument.defaultView || root).CustomEvent('freeform:shelf-remove', { detail: { windowId } }));
      renderFrame(model);
      bringToFront(windowId);
      persist(model);
      return model;
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
      for (const win of persisted) {
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
          restoreRect: null, onRename: null, frame: null, body: null, head: null, title: null,
        };
        if (model.state === 'minimised') continue; // shelf restores these on demand (Phase 2)
        if (model.state === 'tabbed') continue;    // tab groups are Phase 2
        if (model.state === 'docked') model.state = 'floating'; // freeform windows re-derive dock geometry in Phase 2; stale persisted rects would render off-screen
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
      renderAll();
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
        tab.dataset.windowId = memberId;
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
          if (torn) {
            e.preventDefault && e.preventDefault();
            tearOut(memberId, ev.clientX, ev.clientY);
          }
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

    return { open, close, minimise, restore, maximise, unmaximise, bringToFront, focus, state, list, init, refreshAll,
      groupWindows, ungroup, switchTab, tearOut, groupIds,
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
