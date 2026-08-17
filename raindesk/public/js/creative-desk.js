/* Raindesk Creative Desk v1 — world-space creative sheets + persistent viewport. */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RaindeskCreativeDesk = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_ZOOM = 0.22;
  const MAX_ZOOM = 3.5;
  const WORLD_SIZE = 1024;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v) || 0)); }
  function clampZoom(z) { return clamp(z, MIN_ZOOM, MAX_ZOOM); }
  function cleanViewport(v = {}) {
    return { x: Number(v.x) || 0, y: Number(v.y) || 0, zoom: clampZoom(v.zoom == null ? 1 : v.zoom) };
  }
  function baseScale(metrics = {}) {
    const w = Math.max(1, Number(metrics.width) || 1);
    const h = Math.max(1, Number(metrics.height) || 1);
    return Math.min(w / WORLD_SIZE, h / WORLD_SIZE);
  }
  function worldScale(viewport, metrics) { return baseScale(metrics) * cleanViewport(viewport).zoom; }
  function worldToScreen(point, viewport, metrics) {
    const vp = cleanViewport(viewport); const s = worldScale(vp, metrics);
    return { x: (Number(metrics.width) || 0) / 2 + vp.x + (Number(point.x) || 0) * s,
      y: (Number(metrics.height) || 0) / 2 + vp.y + (Number(point.y) || 0) * s };
  }
  function screenToWorld(point, viewport, metrics) {
    const vp = cleanViewport(viewport); const s = worldScale(vp, metrics) || 1;
    return { x: ((Number(point.x) || 0) - (Number(metrics.width) || 0) / 2 - vp.x) / s,
      y: ((Number(point.y) || 0) - (Number(metrics.height) || 0) / 2 - vp.y) / s };
  }
  function zoomAround(screenPoint, nextZoom, viewport, metrics) {
    const vp = cleanViewport(viewport);
    const anchor = screenToWorld(screenPoint, vp, metrics);
    const zoom = clampZoom(nextZoom);
    const s = baseScale(metrics) * zoom;
    return {
      x: (Number(screenPoint.x) || 0) - (Number(metrics.width) || 0) / 2 - anchor.x * s,
      y: (Number(screenPoint.y) || 0) - (Number(metrics.height) || 0) / 2 - anchor.y * s,
      zoom,
    };
  }
  function focusViewport(obj, viewport, metrics, opts = {}) {
    if (!obj) return cleanViewport(viewport);
    const zoom = clampZoom(opts.zoom == null ? cleanViewport(viewport).zoom : opts.zoom);
    const s = baseScale(metrics) * zoom;
    const cx = (Number(obj.x) || 0) + (Number(obj.width) || 0) * (Number(obj.scale) || 1) / 2;
    const cy = (Number(obj.y) || 0) + (Number(obj.height) || 0) * (Number(obj.scale) || 1) / 2;
    return { x: -cx * s, y: -cy * s, zoom };
  }
  function safeId(value) { return String(value || 'shot').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'shot'; }
  function defaultWorldObjects(shotId) {
    const sid = safeId(shotId || 'shot');
    return [
      { id: `world_shot_${sid}`, type: 'shot', space: 'world', entityRef: `shot:${shotId || sid}`,
        x: -512, y: -512, width: 1024, height: 1024, rotation: 0, scale: 1, zIndex: 1, visible: true, collapsed: false, locked: true },
      { id: 'world_character_primary', type: 'character_canvas', space: 'world', entityRef: 'character:primary',
        x: 650, y: -420, width: 430, height: 560, rotation: 0, scale: 1, zIndex: 10, visible: false, collapsed: true, locked: false },
      { id: 'world_references_main', type: 'reference_board', space: 'world', entityRef: 'references:main',
        x: -1110, y: -360, width: 500, height: 520, rotation: -1.2, scale: 1, zIndex: 9, visible: false, collapsed: true, locked: false },
    ];
  }

  function CreativeDesk(opts = {}) {
    const api = opts.api;
    const stage = opts.stage;
    const world = opts.world;
    const tabs = opts.tabs;
    const getMetrics = opts.getMetrics || (() => ({ width: stage ? stage.clientWidth : 1, height: stage ? stage.clientHeight : 1 }));
    const onViewportChange = opts.onViewportChange || (() => {});
    const onContextChange = opts.onContextChange || (() => {});
    let vp = cleanViewport();
    let shot = null;
    let objects = new Map();
    let saveViewportTimer = null;
    const saves = new Map();
    const els = new Map();

    function metrics() { return getMetrics(); }
    function worldObjects() { return Array.from(objects.values()).filter((o) => o.space === 'world'); }
    function getObject(id) { return objects.get(id) || null; }

    function persistViewport() {
      clearTimeout(saveViewportTimer);
      saveViewportTimer = setTimeout(() => {
        if (api && api.setWorkspaceViewport) api.setWorkspaceViewport(vp).catch(() => {});
      }, 120);
    }
    function setViewport(next, options = {}) {
      vp = cleanViewport({ ...vp, ...(next || {}) });
      render(); onViewportChange(vp); onContextChange();
      if (options.persist !== false) persistViewport();
      return { ...vp };
    }
    function panBy(dx, dy, options = {}) { return setViewport({ x: vp.x + Number(dx || 0), y: vp.y + Number(dy || 0) }, options); }
    function zoomAt(screenPoint, factor, options = {}) {
      return setViewport(zoomAround(screenPoint, vp.zoom * Number(factor || 1), vp, metrics()), options);
    }

    function persistObject(obj) {
      if (!api || !api.upsertWorkspaceObject || !obj) return Promise.resolve(obj);
      const prev = saves.get(obj.id) || Promise.resolve();
      const next = prev.then(() => api.upsertWorkspaceObject(obj)).then((res) => {
        const saved = res && res.object || obj; objects.set(saved.id, saved); return saved;
      }).catch(() => obj);
      saves.set(obj.id, next); return next;
    }

    function titleFor(obj) {
      if (obj.type === 'character_canvas') return 'Character';
      if (obj.type === 'reference_board') return 'References';
      if (obj.type === 'shot') return shot ? `Shot ${shot.id}` : 'Shot';
      return 'Canvas';
    }
    function subtitleFor(obj) {
      if (obj.type === 'character_canvas') return 'poses · expressions · notes';
      if (obj.type === 'reference_board') return 'drop ideas here · draw over later';
      return '';
    }

    function ensureElement(obj) {
      if (!world || obj.type === 'shot') return null;
      if (els.has(obj.id)) return els.get(obj.id);
      const el = document.createElement('section');
      el.className = 'creative-sheet'; el.dataset.worldId = obj.id;
      el.innerHTML = `<header class="creative-sheet-head"><strong></strong><button type="button" class="creative-sheet-hide" aria-label="put away">—</button></header><div class="creative-sheet-body"><div class="creative-sheet-placeholder"></div></div><div class="creative-sheet-resize" aria-hidden="true"></div>`;
      el.querySelector('strong').textContent = titleFor(obj);
      el.querySelector('.creative-sheet-placeholder').textContent = subtitleFor(obj);
      el.querySelector('.creative-sheet-hide').addEventListener('click', async (e) => {
        e.stopPropagation(); const current = objects.get(obj.id); if (!current) return;
        current.visible = false; current.collapsed = true; await persistObject(current); render(); renderTabs();
      });
      installDrag(el, obj.id); installResize(el, obj.id);
      world.appendChild(el); els.set(obj.id, el); return el;
    }

    function installDrag(el, id) {
      const head = el.querySelector('.creative-sheet-head');
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button,input,textarea')) return;
        const obj = objects.get(id); if (!obj || obj.locked) return;
        e.preventDefault(); head.setPointerCapture(e.pointerId);
        const start = { x: e.clientX, y: e.clientY, ox: obj.x, oy: obj.y };
        const move = (ev) => {
          const scale = worldScale(vp, metrics()) || 1;
          obj.x = start.ox + (ev.clientX - start.x) / scale;
          obj.y = start.oy + (ev.clientY - start.y) / scale;
          renderObject(obj);
        };
        const up = async (ev) => {
          head.releasePointerCapture(ev.pointerId); head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up);
          await persistObject(obj); onContextChange();
        };
        head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
      });
    }
    function installResize(el, id) {
      const grip = el.querySelector('.creative-sheet-resize');
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const obj = objects.get(id); if (!obj || obj.locked) return;
        e.preventDefault(); e.stopPropagation(); grip.setPointerCapture(e.pointerId);
        const start = { x: e.clientX, y: e.clientY, w: obj.width, h: obj.height };
        const move = (ev) => {
          const scale = worldScale(vp, metrics()) || 1;
          obj.width = clamp(start.w + (ev.clientX - start.x) / scale, 220, 1800);
          obj.height = clamp(start.h + (ev.clientY - start.y) / scale, 180, 1800);
          renderObject(obj);
        };
        const up = async (ev) => {
          grip.releasePointerCapture(ev.pointerId); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
          await persistObject(obj); onContextChange();
        };
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
      });
    }

    function renderObject(obj) {
      if (obj.type === 'shot') return;
      const el = ensureElement(obj); if (!el) return;
      if (obj.visible === false) { el.hidden = true; return; }
      el.hidden = false;
      const m = metrics(); const s = worldScale(vp, m); const p = worldToScreen(obj, vp, m);
      el.style.left = `${p.x}px`; el.style.top = `${p.y}px`;
      el.style.width = `${obj.width * s * (obj.scale || 1)}px`;
      el.style.height = `${obj.height * s * (obj.scale || 1)}px`;
      el.style.transform = `rotate(${Number(obj.rotation) || 0}deg)`;
      el.style.zIndex = String(100 + (Number(obj.zIndex) || 0));
    }
    function render() {
      if (world) world.dataset.zoom = String(vp.zoom);
      for (const obj of worldObjects()) renderObject(obj);
      if (tabs) renderTabs();
    }

    function focusObject(id, options = {}) {
      const obj = objects.get(id); if (!obj) return null;
      if (obj.visible === false) { obj.visible = true; obj.collapsed = false; persistObject(obj); }
      const next = focusViewport(obj, vp, metrics(), { zoom: options.zoom == null ? (obj.type === 'shot' ? 1 : 0.9) : options.zoom });
      setViewport(next); renderTabs(); return obj;
    }
    function showWall() { return setViewport({ x: 0, y: 0, zoom: 0.58 }); }

    function tabDefs() {
      const shotId = shot ? `world_shot_${safeId(shot.id)}` : null;
      return [
        { id: 'wall', label: 'Wall', kind: 'wall' },
        ...(shotId ? [{ id: shotId, label: shot.id, kind: 'object' }] : []),
        { id: 'world_character_primary', label: 'Character', kind: 'object', tear: true },
        { id: 'world_references_main', label: 'References', kind: 'object', tear: true },
      ];
    }
    function renderTabs() {
      if (!tabs) return;
      tabs.innerHTML = '';
      for (const def of tabDefs()) {
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'creative-tab';
        btn.textContent = def.label; btn.dataset.creativeTarget = def.id;
        const obj = objects.get(def.id); if (obj && obj.visible !== false) btn.classList.add('present');
        btn.addEventListener('click', (e) => {
          if (btn.dataset.justTore === '1') { delete btn.dataset.justTore; e.preventDefault(); return; }
          if (def.kind === 'wall') showWall(); else focusObject(def.id);
        });
        if (def.tear) installTabTear(btn, def.id);
        tabs.appendChild(btn);
      }
    }
    function installTabTear(btn, id) {
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY; let moved = false;
        btn.setPointerCapture(e.pointerId);
        const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) moved = true; };
        const up = async (ev) => {
          btn.releasePointerCapture(ev.pointerId); btn.removeEventListener('pointermove', move); btn.removeEventListener('pointerup', up);
          if (!moved || !stage) return;
          const r = stage.getBoundingClientRect();
          if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
          const obj = objects.get(id); if (!obj) return;
          const p = screenToWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top }, vp, metrics());
          obj.x = p.x - obj.width / 2; obj.y = p.y - 36; obj.visible = true; obj.collapsed = false;
          btn.dataset.justTore = '1';
          await persistObject(obj); render(); onContextChange();
        };
        btn.addEventListener('pointermove', move); btn.addEventListener('pointerup', up);
      });
    }

    async function ensureObject(seed) {
      let obj = objects.get(seed.id);
      if (obj) return obj;
      obj = { ...seed };
      if (api && api.upsertWorkspaceObject) {
        try { const res = await api.upsertWorkspaceObject(obj); if (res && res.object) obj = res.object; } catch (_e) { /* usable locally */ }
      }
      objects.set(obj.id, obj); return obj;
    }
    async function setShot(nextShot) {
      shot = nextShot || null;
      if (shot) await ensureObject(defaultWorldObjects(shot.id)[0]);
      renderTabs(); render(); onContextChange();
    }
    async function init(initialShot) {
      let ws = { viewport: cleanViewport(), objects: [] };
      if (api && api.getWorkspace) { try { ws = await api.getWorkspace(); } catch (_e) { /* local defaults */ } }
      vp = cleanViewport(ws.viewport);
      objects = new Map((ws.objects || []).filter((o) => o && o.id).map((o) => [o.id, o]));
      shot = initialShot || null;
      for (const seed of defaultWorldObjects(shot && shot.id)) await ensureObject(seed);
      render(); renderTabs(); onViewportChange(vp); onContextChange();
      return context();
    }
    function context() {
      return { viewport: { ...vp }, objects: worldObjects().map((o) => ({ id: o.id, type: o.type, space: o.space,
        entityRef: o.entityRef || null, x: o.x, y: o.y, width: o.width, height: o.height,
        rotation: o.rotation || 0, scale: o.scale || 1, visible: o.visible !== false, locked: Boolean(o.locked) })) };
    }
    function destroy() { clearTimeout(saveViewportTimer); }

    return { init, setShot, viewport: () => ({ ...vp }), setViewport, panBy, zoomAt, focusObject, showWall,
      refreshLayout: render, context, getObject, worldToScreen: (p) => worldToScreen(p, vp, metrics()),
      screenToWorld: (p) => screenToWorld(p, vp, metrics()), destroy };
  }

  return { MIN_ZOOM, MAX_ZOOM, WORLD_SIZE, clampZoom, cleanViewport, baseScale, worldScale,
    worldToScreen, screenToWorld, zoomAround, focusViewport, defaultWorldObjects, CreativeDesk };
});
