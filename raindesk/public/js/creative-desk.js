/* Raindesk Creative Desk + Creative Sheets — world-space art documents. */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RaindeskCreativeDesk = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_ZOOM = 0.22;
  const MAX_ZOOM = 3.5;
  const WORLD_SIZE = 1024;
  const BUILTIN_SHEETS = [
    { sheetId: 'sheet_character_primary', title: 'Character', kind: 'character', objectId: 'world_character_primary', type: 'character_canvas', x: 650, y: -420, width: 430, height: 560, zIndex: 10 },
    { sheetId: 'sheet_references_main', title: 'References', kind: 'references', objectId: 'world_references_main', type: 'reference_board', x: -1110, y: -360, width: 500, height: 520, rotation: -1.2, zIndex: 9 },
  ];

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
  function safeId(value) { return String(value || 'sheet').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'sheet'; }
  function sheetIdFromEntityRef(ref) {
    const text = String(ref || '');
    return text.startsWith('sheet:') && text.length > 6 ? text.slice(6) : null;
  }
  function worldObjectIdForSheet(sheetId) {
    const builtin = BUILTIN_SHEETS.find((s) => s.sheetId === sheetId);
    return builtin ? builtin.objectId : `world_sheet_${safeId(sheetId)}`;
  }
  function sheetObjectSeed(sheet, options = {}) {
    const builtin = BUILTIN_SHEETS.find((s) => s.sheetId === sheet.sheetId);
    if (builtin) return {
      id: builtin.objectId, type: builtin.type, space: 'world', entityRef: `sheet:${builtin.sheetId}`,
      x: builtin.x, y: builtin.y, width: builtin.width, height: builtin.height,
      rotation: Number(builtin.rotation) || 0, scale: 1, zIndex: builtin.zIndex,
      visible: false, collapsed: true, locked: false,
    };
    return {
      id: worldObjectIdForSheet(sheet.sheetId), type: 'sheet', space: 'world', entityRef: `sheet:${sheet.sheetId}`,
      x: Number(options.x) || -200, y: Number(options.y) || -250,
      width: Number(options.width) || 440, height: Number(options.height) || 560,
      rotation: 0, scale: 1, zIndex: Number(options.zIndex) || 11,
      visible: options.visible !== false, collapsed: options.visible === false, locked: false,
    };
  }
  function defaultWorldObjects(shotId) {
    const sid = safeId(shotId || 'shot');
    return [
      { id: `world_shot_${sid}`, type: 'shot', space: 'world', entityRef: `shot:${shotId || sid}`,
        x: -512, y: -512, width: 1024, height: 1024, rotation: 0, scale: 1, zIndex: 1, visible: true, collapsed: false, locked: true },
      ...BUILTIN_SHEETS.map((sheet) => sheetObjectSeed(sheet)),
    ];
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function localRevision(seed) {
    const canvas = seed.kind === 'references' ? { width: 900, height: 700 } : { width: 700, height: 900 };
    return {
      sheetId: seed.sheetId,
      revisionId: `local_${seed.sheetId}`,
      createdAt: new Date().toISOString(),
      document: { schemaVersion: 1, sheetId: seed.sheetId, title: seed.title || 'Loose sketch', kind: seed.kind || 'sketch', canvas, strokes: [], meta: {} },
    };
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
    const sheetStates = new Map();
    const sheetSaveQueues = new Map();
    let looseIndex = 1;

    function metrics() { return getMetrics(); }
    function worldObjects() { return Array.from(objects.values()).filter((o) => o.space === 'world'); }
    function getObject(id) { return objects.get(id) || null; }
    function stateForSheet(sheetId) { return sheetStates.get(sheetId) || null; }
    function sheetIdForObject(obj) { return obj ? sheetIdFromEntityRef(obj.entityRef) : null; }
    function stateForObject(obj) { return stateForSheet(sheetIdForObject(obj)); }

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

    function installState(revision) {
      if (!revision || !revision.sheetId || !revision.document) return null;
      const state = {
        sheetId: revision.sheetId,
        revisionId: revision.revisionId || null,
        document: clone(revision.document),
        localVersion: 0,
        unsynced: false,
      };
      sheetStates.set(state.sheetId, state);
      return state;
    }
    async function ensureRemoteSheet(seed) {
      let revision = null;
      if (api && api.getSheet) {
        try { revision = await api.getSheet(seed.sheetId); }
        catch (_e) {
          if (api.createSheet) {
            try {
              const made = await api.createSheet({ sheetId: seed.sheetId, title: seed.title, kind: seed.kind });
              revision = made && made.revision;
            } catch (_createErr) {
              try { revision = await api.getSheet(seed.sheetId); } catch (_getErr) { /* offline */ }
            }
          }
        }
      }
      return installState(revision || localRevision(seed));
    }
    async function loadSheets() {
      for (const builtin of BUILTIN_SHEETS) await ensureRemoteSheet(builtin);
      if (api && api.listSheets && api.getSheet) {
        try {
          const result = await api.listSheets();
          for (const summary of result.sheets || []) {
            if (sheetStates.has(summary.sheetId)) continue;
            try { installState(await api.getSheet(summary.sheetId)); } catch (_e) { /* leave one damaged sheet isolated */ }
          }
        } catch (_e) { /* offline sheets remain local */ }
      }
      looseIndex = 1 + Array.from(sheetStates.values()).filter((s) => s.document.kind === 'sketch').length;
    }

    function queueSheetSave(sheetId, reason = 'edit sheet') {
      const state = sheetStates.get(sheetId);
      if (!state || !api || !api.saveSheet || String(state.revisionId || '').startsWith('local_')) {
        if (state) state.unsynced = Boolean(api);
        onContextChange(); return Promise.resolve(state);
      }
      state.localVersion += 1;
      const version = state.localVersion;
      const snapshot = clone(state.document);
      const prev = sheetSaveQueues.get(sheetId) || Promise.resolve();
      const next = prev.then(async () => {
        const result = await api.saveSheet(sheetId, snapshot, { baseRevisionId: state.revisionId, reason });
        const revision = result && result.revision;
        if (!revision) throw new Error('sheet save returned no revision');
        state.revisionId = revision.revisionId;
        state.unsynced = false;
        if (state.localVersion === version) state.document = clone(revision.document);
        renderSheetById(sheetId); renderTabs(); onContextChange();
        return state;
      }).catch(async (err) => {
        state.unsynced = true;
        // A stale write is recoverable: keep the local artwork visible rather
        // than replacing it. The next explicit edit remains available to the
        // artist and the unsynced marker makes the degraded state honest.
        renderSheetById(sheetId); onContextChange();
        return { state, error: err };
      });
      sheetSaveQueues.set(sheetId, next); return next;
    }
    function mutateSheet(sheetId, mutator, reason) {
      const state = sheetStates.get(sheetId); if (!state) return Promise.resolve(null);
      mutator(state.document); renderSheetById(sheetId); renderTabs(); onContextChange();
      return queueSheetSave(sheetId, reason);
    }

    function titleFor(obj) {
      const state = stateForObject(obj);
      if (state) return state.document.title;
      if (obj.type === 'shot') return shot ? `Shot ${shot.id}` : 'Shot';
      return 'Canvas';
    }
    function subtitleFor(obj) {
      const state = stateForObject(obj);
      if (!state) return '';
      if (state.document.kind === 'character') return 'draw poses, expressions, silhouettes';
      if (state.document.kind === 'references') return 'drop references here next — sketch over this sheet now';
      if (state.document.kind === 'notes') return 'loose notes and visual thinking';
      return 'draw anywhere';
    }

    function sheetPoint(canvas, state, e) {
      const r = canvas.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return null;
      return {
        x: clamp((e.clientX - r.left) * state.document.canvas.width / r.width, 0, state.document.canvas.width),
        y: clamp((e.clientY - r.top) * state.document.canvas.height / r.height, 0, state.document.canvas.height),
      };
    }
    function drawStroke(ctx, stroke) {
      if (!stroke || !stroke.points || !stroke.points.length) return;
      ctx.strokeStyle = stroke.color || '#2d3233'; ctx.lineWidth = Number(stroke.width) || 2.2;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y + 0.01);
      ctx.stroke();
    }
    function renderSheetCanvas(el, state) {
      if (!el || !state) return;
      const canvas = el.querySelector('.creative-sheet-canvas'); if (!canvas) return;
      const { width, height } = state.document.canvas;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, width, height);
      for (const stroke of state.document.strokes || []) drawStroke(ctx, stroke);
      const empty = el.querySelector('.creative-sheet-empty-note');
      if (empty) empty.hidden = Boolean(state.document.strokes && state.document.strokes.length);
      const unsynced = el.querySelector('.creative-sheet-unsynced');
      if (unsynced) unsynced.hidden = !state.unsynced;
      const undo = el.querySelector('.creative-sheet-undo');
      if (undo) undo.disabled = !(state.document.strokes && state.document.strokes.length);
      const title = el.querySelector('.creative-sheet-title');
      if (title && title.getAttribute('contenteditable') !== 'true') title.textContent = state.document.title;
    }
    function renderSheetById(sheetId) {
      for (const obj of worldObjects()) {
        if (sheetIdForObject(obj) === sheetId) {
          const el = els.get(obj.id); if (el) renderSheetCanvas(el, sheetStates.get(sheetId));
        }
      }
    }

    function installSheetDrawing(canvas, objectId) {
      canvas.addEventListener('pointerdown', (e) => {
        const wantsPan = e.button === 1 || (e.button === 0 && document.body && document.body.classList.contains('desk-panning'));
        if (wantsPan) {
          e.preventDefault(); e.stopPropagation(); canvas.setPointerCapture(e.pointerId);
          const start = { x: e.clientX, y: e.clientY, viewport: { ...vp } };
          document.body.classList.add('desk-dragging');
          const movePan = (ev) => {
            setViewport({
              x: start.viewport.x + ev.clientX - start.x,
              y: start.viewport.y + ev.clientY - start.y,
              zoom: start.viewport.zoom,
            }, { persist: false });
          };
          const finishPan = (ev) => {
            try { canvas.releasePointerCapture(ev.pointerId); } catch (_e) {}
            canvas.removeEventListener('pointermove', movePan);
            canvas.removeEventListener('pointerup', finishPan);
            canvas.removeEventListener('pointercancel', finishPan);
            document.body.classList.remove('desk-dragging');
            setViewport(vp);
          };
          canvas.addEventListener('pointermove', movePan);
          canvas.addEventListener('pointerup', finishPan);
          canvas.addEventListener('pointercancel', finishPan);
          return;
        }
        if (e.button !== 0) return;
        const obj = objects.get(objectId); const state = stateForObject(obj);
        if (!state || obj.locked) return;
        const first = sheetPoint(canvas, state, e); if (!first) return;
        e.preventDefault(); e.stopPropagation(); canvas.setPointerCapture(e.pointerId);
        const stroke = {
          id: `stroke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          color: '#303536', width: 2.2, points: [first],
        };
        const ctx = canvas.getContext('2d');
        const move = (ev) => {
          const point = sheetPoint(canvas, state, ev); if (!point) return;
          const prev = stroke.points[stroke.points.length - 1];
          if (Math.hypot(point.x - prev.x, point.y - prev.y) < 0.65) return;
          stroke.points.push(point);
          ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(point.x, point.y); ctx.stroke();
        };
        const finish = () => {
          try { canvas.releasePointerCapture(e.pointerId); } catch (_e) {}
          canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel);
        };
        const up = () => {
          finish();
          if (stroke.points.length === 1) stroke.points.push({ x: stroke.points[0].x + 0.01, y: stroke.points[0].y + 0.01 });
          state.document.strokes.push(stroke); renderSheetCanvas(els.get(objectId), state);
          queueSheetSave(state.sheetId, 'draw sheet stroke'); renderTabs(); onContextChange();
        };
        const cancel = () => { finish(); renderSheetCanvas(els.get(objectId), state); };
        canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', cancel);
      });
    }

    function ensureElement(obj) {
      if (!world || obj.type === 'shot') return null;
      if (els.has(obj.id)) return els.get(obj.id);
      const el = document.createElement('section');
      el.className = 'creative-sheet'; el.dataset.worldId = obj.id;
      const state = stateForObject(obj);
      if (state) {
        el.classList.add('creative-sheet-editable');
        el.innerHTML = `<header class="creative-sheet-head"><strong class="creative-sheet-title" title="double-click to rename"></strong><span class="creative-sheet-actions"><span class="creative-sheet-unsynced" hidden title="not synced yet">•</span><button type="button" class="creative-sheet-undo" aria-label="undo last sheet stroke">↶</button><button type="button" class="creative-sheet-hide" aria-label="put away">—</button></span></header><div class="creative-sheet-body"><canvas class="creative-sheet-canvas"></canvas><div class="creative-sheet-empty-note"></div></div><div class="creative-sheet-resize" aria-hidden="true"></div>`;
        const title = el.querySelector('.creative-sheet-title'); title.textContent = state.document.title;
        const empty = el.querySelector('.creative-sheet-empty-note'); empty.textContent = subtitleFor(obj);
        title.addEventListener('dblclick', (e) => {
          e.stopPropagation(); title.setAttribute('contenteditable', 'true'); title.focus();
          const sel = window.getSelection && window.getSelection(); if (sel && document.createRange) { const range = document.createRange(); range.selectNodeContents(title); sel.removeAllRanges(); sel.addRange(range); }
        });
        title.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
          if (e.key === 'Escape') { e.preventDefault(); title.textContent = state.document.title; title.blur(); }
        });
        title.addEventListener('blur', () => {
          title.removeAttribute('contenteditable'); const next = String(title.textContent || '').trim().slice(0, 200);
          if (!next || next === state.document.title) { title.textContent = state.document.title; return; }
          mutateSheet(state.sheetId, (doc) => { doc.title = next; }, 'rename sheet');
        });
        el.querySelector('.creative-sheet-undo').addEventListener('click', (e) => {
          e.stopPropagation(); if (!state.document.strokes.length) return;
          mutateSheet(state.sheetId, (doc) => { doc.strokes.pop(); }, 'undo sheet stroke');
        });
        installSheetDrawing(el.querySelector('.creative-sheet-canvas'), obj.id);
      } else {
        el.innerHTML = `<header class="creative-sheet-head"><strong></strong><button type="button" class="creative-sheet-hide" aria-label="put away">—</button></header><div class="creative-sheet-body"><div class="creative-sheet-placeholder"></div></div><div class="creative-sheet-resize" aria-hidden="true"></div>`;
        el.querySelector('strong').textContent = titleFor(obj);
        el.querySelector('.creative-sheet-placeholder').textContent = subtitleFor(obj);
      }
      el.querySelector('.creative-sheet-hide').addEventListener('click', async (e) => {
        e.stopPropagation(); const current = objects.get(obj.id); if (!current) return;
        current.visible = false; current.collapsed = true; await persistObject(current); render(); renderTabs(); onContextChange();
      });
      installDrag(el, obj.id); installResize(el, obj.id);
      world.appendChild(el); els.set(obj.id, el);
      if (state) renderSheetCanvas(el, state);
      return el;
    }

    function overTabs(clientX, clientY) {
      if (!tabs) return false; const r = tabs.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    }
    function installDrag(el, id) {
      const head = el.querySelector('.creative-sheet-head');
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button,input,textarea,[contenteditable="true"]')) return;
        const obj = objects.get(id); if (!obj || obj.locked) return;
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY, ox: obj.x, oy: obj.y };
        // Defer pointer capture until real movement: capturing at pointerdown
        // retargets click/dblclick to the header, which would break rename's
        // dblclick on the title. A stationary press never captures; a real drag
        // captures on its first >3px move and keeps the drag robust.
        // The threshold listeners live at DOCUMENT capture level: a long steep
        // drag can leave the head's own rect on its first interpolated step
        // (head-only listeners then never fire and the gesture dead-ends —
        // proven live on the creative-sheets put-away drag).
        let captured = false;
        const moved = (ev) => Math.abs(ev.clientX - start.x) > 3 || Math.abs(ev.clientY - start.y) > 3;
        const teardown = () => {
          document.removeEventListener('pointermove', move, true);
          document.removeEventListener('pointerup', up, true);
          document.removeEventListener('pointercancel', up, true);
        };
        const move = (ev) => {
          // Severed-gesture guard: a hover (buttons===0) after a press that
          // never received up/cancel must not ghost-drag — tear down and stop.
          if (!ev.buttons) { teardown(); return; }
          if (!captured) {
            if (!moved(ev)) return;
            captured = true;
            try { head.setPointerCapture(ev.pointerId); } catch (_e) {}
          }
          const scale = worldScale(vp, metrics()) || 1;
          obj.x = start.ox + (ev.clientX - start.x) / scale;
          obj.y = start.oy + (ev.clientY - start.y) / scale;
          renderObject(obj);
        };
        const up = async (ev) => {
          teardown();
          try { if (captured) head.releasePointerCapture(ev.pointerId); } catch (_e) {}
          // A click is not a drag: nothing persisted without a real drag
          // (captured), and the re-render would replace the title between
          // the clicks of a rename dblclick. A stale up from a severed
          // gesture cannot collapse or persist from unrelated coordinates.
          if (!captured || !moved(ev)) return;
          if (overTabs(ev.clientX, ev.clientY)) { obj.visible = false; obj.collapsed = true; }
          await persistObject(obj); render(); renderTabs(); onContextChange();
        };
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', up, true);
        document.addEventListener('pointercancel', up, true);
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
          try { grip.releasePointerCapture(ev.pointerId); } catch (_e) {}
          grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
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
      const state = stateForObject(obj); if (state) renderSheetCanvas(el, state);
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

    function objectForSheet(sheetId) {
      return worldObjects().find((o) => sheetIdForObject(o) === sheetId) || null;
    }
    function tabDefs() {
      const shotId = shot ? `world_shot_${safeId(shot.id)}` : null;
      const builtinOrder = new Map(BUILTIN_SHEETS.map((s, i) => [s.sheetId, i]));
      const sheetDefs = Array.from(sheetStates.values()).sort((a, b) => {
        const ai = builtinOrder.has(a.sheetId) ? builtinOrder.get(a.sheetId) : 100;
        const bi = builtinOrder.has(b.sheetId) ? builtinOrder.get(b.sheetId) : 100;
        return ai - bi || String(a.document.title).localeCompare(String(b.document.title));
      }).map((state) => {
        const obj = objectForSheet(state.sheetId);
        return obj ? { id: obj.id, label: state.document.title, kind: 'object', tear: true, sheetId: state.sheetId } : null;
      }).filter(Boolean);
      return [
        { id: 'wall', label: 'Wall', kind: 'wall' },
        ...(shotId ? [{ id: shotId, label: shot.id, kind: 'object' }] : []),
        ...sheetDefs,
      ];
    }
    function renderTabs() {
      if (!tabs) return;
      tabs.innerHTML = '';
      for (const def of tabDefs()) {
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'creative-tab';
        btn.textContent = def.label; btn.dataset.creativeTarget = def.id;
        if (def.sheetId) btn.dataset.sheetId = def.sheetId;
        const obj = objects.get(def.id); if (obj && obj.visible !== false) btn.classList.add('present');
        btn.addEventListener('click', (e) => {
          if (btn.dataset.justTore === '1') { delete btn.dataset.justTore; e.preventDefault(); return; }
          if (def.kind === 'wall') showWall(); else focusObject(def.id);
        });
        if (def.tear) installTabTear(btn, def.id);
        tabs.appendChild(btn);
      }
      const plus = document.createElement('button'); plus.type = 'button'; plus.className = 'creative-tab creative-tab-add';
      plus.textContent = '+'; plus.title = 'new loose sketch'; plus.dataset.creativeNewSheet = '1';
      plus.addEventListener('click', () => { createLooseSheet().catch(() => {}); });
      tabs.appendChild(plus);
    }
    function installTabTear(btn, id) {
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY; let moved = false;
        btn.setPointerCapture(e.pointerId);
        const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) moved = true; };
        const up = async (ev) => {
          try { btn.releasePointerCapture(ev.pointerId); } catch (_e) {}
          btn.removeEventListener('pointermove', move); btn.removeEventListener('pointerup', up);
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

    async function createLooseSheet() {
      let revision = null;
      const title = `Loose sketch ${looseIndex++}`;
      if (api && api.createSheet) {
        try {
          const result = await api.createSheet({ title, kind: 'sketch' }); revision = result && result.revision;
        } catch (_e) { /* keep the desk usable offline; local state is marked unsynced on edit */ }
      }
      if (!revision) revision = localRevision({ sheetId: `sheet_local_${Date.now().toString(36)}`, title, kind: 'sketch' });
      const state = installState(revision);
      const centre = screenToWorld({ x: metrics().width / 2, y: metrics().height / 2 }, vp, metrics());
      const seed = sheetObjectSeed(state, { x: centre.x - 220, y: centre.y - 280, visible: true, zIndex: 20 + sheetStates.size });
      const obj = await ensureObject(seed);
      obj.entityRef = `sheet:${state.sheetId}`; obj.visible = true; obj.collapsed = false;
      await persistObject(obj); render(); renderTabs(); onContextChange(); return { state, object: obj };
    }

    async function ensureObject(seed) {
      let obj = objects.get(seed.id);
      if (obj) {
        // Built-in Creative Desk v1 objects used character:/references: refs.
        // Upgrade them in place so existing projects gain sheet documents
        // without changing the spatial identity the Partner already knows.
        if (seed.entityRef && obj.entityRef !== seed.entityRef) {
          obj.entityRef = seed.entityRef; obj.type = seed.type; obj.space = 'world'; await persistObject(obj);
        }
        return obj;
      }
      obj = { ...seed };
      if (api && api.upsertWorkspaceObject) {
        try { const res = await api.upsertWorkspaceObject(obj); if (res && res.object) obj = res.object; } catch (_e) { /* usable locally */ }
      }
      objects.set(obj.id, obj); return obj;
    }
    async function ensureSheetObjects() {
      for (const state of sheetStates.values()) {
        const seed = sheetObjectSeed(state);
        await ensureObject(seed);
      }
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
      await loadSheets();
      if (shot) await ensureObject(defaultWorldObjects(shot.id)[0]);
      await ensureSheetObjects();
      render(); renderTabs(); onViewportChange(vp); onContextChange();
      return context();
    }
    function context() {
      return {
        viewport: { ...vp },
        objects: worldObjects().map((o) => {
          const state = stateForObject(o);
          return {
            id: o.id, type: o.type, space: o.space, entityRef: o.entityRef || null,
            x: o.x, y: o.y, width: o.width, height: o.height, rotation: o.rotation || 0,
            scale: o.scale || 1, visible: o.visible !== false, locked: Boolean(o.locked),
            sheet: state ? {
              sheetId: state.sheetId, title: state.document.title, kind: state.document.kind,
              revisionId: state.revisionId, strokeCount: state.document.strokes.length,
              unsynced: Boolean(state.unsynced),
            } : null,
          };
        }),
      };
    }
    function destroy() { clearTimeout(saveViewportTimer); }

    return { init, setShot, viewport: () => ({ ...vp }), setViewport, panBy, zoomAt, focusObject, showWall,
      refreshLayout: render, context, getObject, createLooseSheet, getSheet: (id) => stateForSheet(id),
      worldToScreen: (p) => worldToScreen(p, vp, metrics()), screenToWorld: (p) => screenToWorld(p, vp, metrics()), destroy };
  }

  return { MIN_ZOOM, MAX_ZOOM, WORLD_SIZE, BUILTIN_SHEETS, clampZoom, cleanViewport, baseScale, worldScale,
    worldToScreen, screenToWorld, zoomAround, focusViewport, sheetIdFromEntityRef, worldObjectIdForSheet,
    sheetObjectSeed, defaultWorldObjects, CreativeDesk };
});
