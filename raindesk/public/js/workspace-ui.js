/*
 * Raindesk floating workspace shell.
 *
 * This is deliberately content-agnostic: the server owns stable workspace
 * object IDs/world-ish transforms, while this module turns existing creative
 * panels into draggable/resizable/minimisable windows on desktop.  The same
 * IDs are visible to the Partner action executor, so a human drag and an
 * approved Partner `move_panel` update the same durable object.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.RaindeskWorkspaceUI = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EDGE = 16;
  const SNAP = 18;
  const MIN_W = 220;
  const MIN_H = 150;

  const DEFAULTS = {
    layers:  { id: 'panel_layers',  type: 'layers_panel',  x: 22,   y: 96,  width: 286, height: 430, zIndex: 120, visible: false, collapsed: true },
    scenes:  { id: 'panel_scenes',  type: 'sequence_strip', x: 28,   y: 535, width: 360, height: 285, zIndex: 121, visible: false, collapsed: true },
    beats:   { id: 'panel_beats',   type: 'beat_trail',     x: 372,  y: 420, width: 350, height: 430, zIndex: 122, visible: false, collapsed: true },
    partner: { id: 'panel_partner', type: 'partner_panel',  x: 1074, y: 92,  width: 330, height: 590, zIndex: 123, visible: true,  collapsed: false, dock: 'right' },
  };

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : lo));

  function normalizedRect(rect, viewport) {
    const vw = Math.max(320, Number(viewport && viewport.width) || 1280);
    const vh = Math.max(320, Number(viewport && viewport.height) || 800);
    const width = clamp(rect && rect.width, MIN_W, Math.max(MIN_W, vw - EDGE * 2));
    const height = clamp(rect && rect.height, MIN_H, Math.max(MIN_H, vh - EDGE * 2));
    return {
      x: clamp(rect && rect.x, EDGE, Math.max(EDGE, vw - width - EDGE)),
      y: clamp(rect && rect.y, 66, Math.max(66, vh - height - 84)),
      width, height,
    };
  }

  function dockRect(dock, rect, viewport) {
    const out = normalizedRect(rect, viewport);
    const vw = Number(viewport && viewport.width) || 1280;
    const vh = Number(viewport && viewport.height) || 800;
    if (dock === 'left') out.x = EDGE;
    if (dock === 'right') out.x = Math.max(EDGE, vw - out.width - EDGE);
    if (dock === 'top') out.y = 66;
    if (dock === 'bottom') out.y = Math.max(66, vh - out.height - 84);
    return out;
  }

  function edgeSnap(rect, viewport, threshold = SNAP) {
    const out = normalizedRect(rect, viewport);
    const vw = Number(viewport && viewport.width) || 1280;
    const vh = Number(viewport && viewport.height) || 800;
    const distances = [
      ['left', Math.abs(out.x - EDGE)],
      ['right', Math.abs((out.x + out.width) - (vw - EDGE))],
      ['top', Math.abs(out.y - 66)],
      ['bottom', Math.abs((out.y + out.height) - (vh - 84))],
    ].sort((a, b) => a[1] - b[1]);
    const dock = distances[0][1] <= threshold ? distances[0][0] : null;
    return { rect: dock ? dockRect(dock, out, viewport) : out, dock };
  }

  function peerSnap(rect, peers, threshold = 12) {
    const out = { ...rect };
    let guideX = null; let guideY = null;
    const xCandidates = [];
    const yCandidates = [];
    for (const p of peers || []) {
      if (!p) continue;
      const pLeft = p.x; const pRight = p.x + p.width;
      const rLeft = out.x; const rRight = out.x + out.width;
      xCandidates.push(
        { d: Math.abs(rLeft - pLeft), x: pLeft },
        { d: Math.abs(rLeft - pRight), x: pRight },
        { d: Math.abs(rRight - pLeft), x: pLeft - out.width },
        { d: Math.abs(rRight - pRight), x: pRight - out.width },
      );
      const pTop = p.y; const pBottom = p.y + p.height;
      const rTop = out.y; const rBottom = out.y + out.height;
      yCandidates.push(
        { d: Math.abs(rTop - pTop), y: pTop },
        { d: Math.abs(rTop - pBottom), y: pBottom },
        { d: Math.abs(rBottom - pTop), y: pTop - out.height },
        { d: Math.abs(rBottom - pBottom), y: pBottom - out.height },
      );
    }
    xCandidates.sort((a, b) => a.d - b.d);
    yCandidates.sort((a, b) => a.d - b.d);
    if (xCandidates[0] && xCandidates[0].d <= threshold) { out.x = xCandidates[0].x; guideX = out.x; }
    if (yCandidates[0] && yCandidates[0].d <= threshold) { out.y = yCandidates[0].y; guideY = out.y; }
    return { rect: out, guideX, guideY };
  }

  function toWorkspaceObject(def, rect, patch = {}) {
    return {
      id: def.id,
      type: def.type || 'generic_panel',
      entityRef: def.entityRef || null,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      rotation: 0, scale: 1,
      zIndex: Number(patch.zIndex == null ? def.zIndex || 100 : patch.zIndex),
      collapsed: Boolean(patch.collapsed),
      visible: patch.visible !== false,
      dock: patch.dock || null,
      locked: false,
    };
  }

  function WorkspaceShell(opts = {}) {
    const api = opts.api;
    const shelf = opts.shelf || null;
    const desktopQuery = opts.desktopQuery || '(min-width: 900px)';
    const media = typeof matchMedia === 'function' ? matchMedia(desktopQuery) : { matches: true, addEventListener() {} };
    const defs = new Map();
    const objects = new Map();
    const saves = new Map();
    let workspace = null;
    let zTop = 140;
    let ready = false;
    let guideX = null; let guideY = null;

    const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
    const desktop = () => Boolean(media.matches);

    function setDesktopClass() {
      document.body.classList.toggle('workspace-desktop', desktop());
      if (!desktop()) hideGuides();
    }

    function hideGuides() {
      if (guideX) guideX.classList.remove('on');
      if (guideY) guideY.classList.remove('on');
    }

    function ensureGuides() {
      if (!guideX) {
        guideX = document.createElement('div'); guideX.className = 'workspace-snap-guide vertical';
        document.body.appendChild(guideX);
      }
      if (!guideY) {
        guideY = document.createElement('div'); guideY.className = 'workspace-snap-guide horizontal';
        document.body.appendChild(guideY);
      }
    }

    function showGuides(x, y) {
      if (!desktop()) return;
      ensureGuides();
      if (x != null) { guideX.style.left = `${x}px`; guideX.classList.add('on'); } else guideX.classList.remove('on');
      if (y != null) { guideY.style.top = `${y}px`; guideY.classList.add('on'); } else guideY.classList.remove('on');
    }

    function storedFor(id) { return workspace && Array.isArray(workspace.objects) ? workspace.objects.find((o) => o.id === id) : null; }

    async function persist(def, obj) {
      objects.set(def.id, obj);
      if (!api || !api.upsertWorkspaceObject) return obj;
      // Last-write-wins per panel in this single-user local shell; serialize
      // writes for the same panel so rapid drag/resize releases stay ordered.
      const prev = saves.get(def.id) || Promise.resolve();
      const next = prev.then(() => api.upsertWorkspaceObject(obj)).catch(() => null);
      saves.set(def.id, next);
      const saved = await next;
      if (saved && saved.object) objects.set(def.id, saved.object);
      return saved && saved.object || obj;
    }

    function visible(def) {
      if (typeof def.isOpen === 'function') return Boolean(def.isOpen());
      return def.visibilityTarget ? def.visibilityTarget.classList.contains(def.visibleClass || 'open') : def.element.classList.contains('open');
    }

    function requestOpen(def) {
      if (typeof def.open === 'function') def.open();
      else (def.visibilityTarget || def.element).classList.add(def.visibleClass || 'open');
    }
    function requestClose(def) {
      if (typeof def.close === 'function') def.close();
      else (def.visibilityTarget || def.element).classList.remove(def.visibleClass || 'open');
    }

    function applyObject(def, obj) {
      const el = def.element;
      if (!el) return;
      const rect = obj.dock ? dockRect(obj.dock, obj, viewport()) : normalizedRect(obj, viewport());
      el.classList.add('workspace-floating-panel');
      el.dataset.workspaceId = def.id;
      el.style.left = `${rect.x}px`;
      el.style.top = `${rect.y}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      el.style.zIndex = String(obj.zIndex || def.zIndex || 120);
      el.dataset.workspaceDock = obj.dock || '';
      if (desktop()) {
        if (obj.visible === false) requestClose(def); else requestOpen(def);
      }
    }

    function currentRect(def) {
      const r = def.element.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }

    function peerRects(exceptId) {
      const out = [];
      for (const [id, def] of defs) {
        if (id === exceptId || !desktop() || !visible(def)) continue;
        const r = currentRect(def);
        if (r.width > 0 && r.height > 0) out.push(r);
      }
      return out;
    }

    function bringFront(def) {
      zTop += 1;
      def.element.style.zIndex = String(zTop);
      const base = objects.get(def.id) || toWorkspaceObject(def, currentRect(def), { visible: visible(def) });
      base.zIndex = zTop;
      objects.set(def.id, base);
    }

    function installMinimize(def) {
      const handle = def.handle;
      if (!handle || handle.querySelector('[data-workspace-minimize]')) return;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'workspace-minimize'; btn.dataset.workspaceMinimize = '1';
      btn.textContent = '—'; btn.title = 'minimise'; btn.setAttribute('aria-label', `minimise ${def.label}`);
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        requestClose(def);
        const base = objects.get(def.id) || toWorkspaceObject(def, currentRect(def));
        base.visible = false; base.collapsed = true;
        await persist(def, base); renderShelf();
      });
      const closeLike = handle.querySelector('button:last-of-type');
      if (closeLike) handle.insertBefore(btn, closeLike); else handle.appendChild(btn);
    }

    function installResize(def) {
      if (def.element.querySelector(':scope > .workspace-resize-grip')) return;
      const grip = document.createElement('div');
      grip.className = 'workspace-resize-grip'; grip.title = 'resize';
      def.element.appendChild(grip);
      grip.addEventListener('pointerdown', (e) => {
        if (!desktop()) return;
        e.preventDefault(); e.stopPropagation();
        bringFront(def);
        const start = currentRect(def);
        const sx = e.clientX; const sy = e.clientY;
        grip.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const rect = normalizedRect({ ...start, width: start.width + ev.clientX - sx, height: start.height + ev.clientY - sy }, viewport());
          def.element.style.width = `${rect.width}px`; def.element.style.height = `${rect.height}px`;
        };
        const up = async (ev) => {
          grip.releasePointerCapture(ev.pointerId); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
          const rect = currentRect(def);
          const base = objects.get(def.id) || toWorkspaceObject(def, rect);
          Object.assign(base, rect, { dock: null, visible: true, collapsed: false, zIndex: zTop });
          await persist(def, base);
        };
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
      });
    }

    function installDrag(def) {
      const handle = def.handle;
      if (!handle || handle.dataset.workspaceDragBound) return;
      handle.dataset.workspaceDragBound = '1';
      handle.classList.add('workspace-drag-handle');
      handle.addEventListener('pointerdown', (e) => {
        if (!desktop() || e.button !== 0) return;
        if (e.target.closest('button,input,textarea,a,[data-no-drag]')) return;
        e.preventDefault();
        bringFront(def);
        const start = currentRect(def);
        const sx = e.clientX; const sy = e.clientY;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          let rect = normalizedRect({ ...start, x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy }, viewport());
          const peer = peerSnap(rect, peerRects(def.id));
          rect = normalizedRect(peer.rect, viewport());
          def.element.style.left = `${rect.x}px`; def.element.style.top = `${rect.y}px`;
          def.element.dataset.workspaceDock = '';
          showGuides(peer.guideX, peer.guideY);
        };
        const up = async (ev) => {
          handle.releasePointerCapture(ev.pointerId); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
          hideGuides();
          const edge = edgeSnap(currentRect(def), viewport());
          const base = objects.get(def.id) || toWorkspaceObject(def, edge.rect);
          Object.assign(base, edge.rect, { dock: edge.dock, visible: true, collapsed: false, zIndex: zTop });
          applyObject(def, base);
          await persist(def, base); renderShelf();
        };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
      });
    }

    function installObserver(def) {
      const target = def.visibilityTarget || def.element;
      if (typeof MutationObserver !== 'function') return;
      const observer = new MutationObserver(() => {
        if (!ready || !desktop()) return;
        const base = objects.get(def.id) || toWorkspaceObject(def, currentRect(def));
        base.visible = visible(def); if (base.visible) base.collapsed = false;
        objects.set(def.id, base); renderShelf();
        persist(def, base).catch(() => {});
      });
      observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    }

    function registerPanel(defInput) {
      const def = { ...defInput };
      if (!def.id || !def.element) throw new Error('workspace panel requires id + element');
      def.label = def.label || def.id;
      defs.set(def.id, def);
      installDrag(def); installResize(def); installMinimize(def); installObserver(def);
      if (ready) hydrateOne(def);
      return def;
    }

    async function hydrateOne(def) {
      const seed = def.defaultObject || DEFAULTS[def.key] || { id: def.id, type: def.type || 'generic_panel', x: 40, y: 90, width: 320, height: 280, visible: false, collapsed: true };
      let obj = storedFor(def.id);
      if (!obj) {
        obj = toWorkspaceObject({ ...seed, id: def.id, type: def.type || seed.type, zIndex: seed.zIndex }, seed, seed);
        if (api && api.upsertWorkspaceObject) {
          try { const res = await api.upsertWorkspaceObject(obj); if (res && res.object) obj = res.object; } catch (_e) { /* usable locally */ }
        }
      }
      objects.set(def.id, obj); zTop = Math.max(zTop, Number(obj.zIndex) || 0);
      if (desktop()) applyObject(def, obj);
      renderShelf();
    }

    function renderShelf() {
      if (!shelf) return;
      shelf.innerHTML = '';
      for (const [, def] of defs) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'workspace-shelf-chip';
        const isVisible = visible(def);
        btn.classList.toggle('active', isVisible);
        btn.textContent = def.label;
        btn.dataset.workspaceTarget = def.id;
        btn.addEventListener('click', async () => {
          if (isVisible) requestClose(def); else requestOpen(def);
          const base = objects.get(def.id) || toWorkspaceObject(def, def.defaultObject || DEFAULTS[def.key] || {}, {});
          base.visible = !isVisible; base.collapsed = false;
          if (!isVisible) { bringFront(def); base.zIndex = zTop; applyObject(def, base); }
          await persist(def, base); renderShelf();
        });
        shelf.appendChild(btn);
      }
    }

    async function init() {
      setDesktopClass();
      if (api && api.getWorkspace) {
        try { workspace = await api.getWorkspace(); } catch (_e) { workspace = { objects: [], viewport: { x: 0, y: 0, zoom: 1 } }; }
      } else workspace = { objects: [], viewport: { x: 0, y: 0, zoom: 1 } };
      ready = true;
      for (const [, def] of defs) await hydrateOne(def);
      renderShelf();
      return workspace;
    }

    async function refresh() {
      if (!api || !api.getWorkspace) return workspace;
      try { workspace = await api.getWorkspace(); } catch (_e) { return workspace; }
      for (const [, def] of defs) {
        const obj = storedFor(def.id); if (!obj) continue;
        objects.set(def.id, obj); if (desktop()) applyObject(def, obj);
      }
      renderShelf(); return workspace;
    }

    function context() {
      return {
        viewport: workspace && workspace.viewport || { x: 0, y: 0, zoom: 1 },
        objects: [...defs.values()].map((def) => {
          const obj = objects.get(def.id) || null;
          return obj ? {
            id: obj.id, type: obj.type, entityRef: obj.entityRef || null,
            x: Math.round(obj.x), y: Math.round(obj.y), width: Math.round(obj.width), height: Math.round(obj.height),
            dock: obj.dock || null, visible: visible(def), collapsed: Boolean(obj.collapsed),
          } : null;
        }).filter(Boolean),
      };
    }

    window.addEventListener('resize', () => {
      setDesktopClass();
      if (!ready || !desktop()) return;
      for (const [, def] of defs) {
        const obj = objects.get(def.id); if (obj) applyObject(def, obj);
      }
    });
    if (media.addEventListener) media.addEventListener('change', () => { setDesktopClass(); if (ready) refresh(); });

    return { init, refresh, registerPanel, renderShelf, context, isDesktop: desktop };
  }

  return { DEFAULTS, normalizedRect, dockRect, edgeSnap, peerSnap, toWorkspaceObject, WorkspaceShell };
});
