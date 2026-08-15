/*
 * Raindesk app — full-screen layered canvas UI (vanilla, no build step).
 *
 * Layout (mockup companion-app-v1): full-screen canvas; top bar = lane chip +
 * shot title + undo; right rail = SELECT / PEN / LAYERS; bottom GEN bar with
 * prompt + gold GEN (⟳ re-gen while a temp take exists); COMMIT / ✕ dock when
 * a take is painted; three-line handle opens the agent drawer (overlay
 * <1024px, docked right rail ≥1024px); lanes sheet modal; toasts.
 *
 * All canvas logic lives in RaindeskCanvas.RainCanvasCore (DOM-free, tested);
 * this file only binds DOM events, renders, and talks to the API.
 */
(function () {
  'use strict';

  const RC = window.RaindeskCanvas;
  const API = window.RaindeskAPI;
  const CHAT = window.RaindeskChat;

  if (!RC || !API || !CHAT) {
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.createElement('div');
      el.className = 'boot-error';
      el.textContent = 'raindesk failed to load its scripts — refresh? 🌧️';
      document.body.appendChild(el);
    });
    return;
  }

  const CANVAS_W = 1024;
  const CANVAS_H = 1024;
  const LANES_META = [
    { id: 'set', label: '📌 set' },
    { id: 'in_dev', label: '🎨 in dev' },
    { id: 'unplanned', label: '👀 unplanned' },
  ];
  const DEFAULT_PROMPT = 'continue this shot seamlessly, keep the film style and lighting';
  const PEN_COLORS = ['#e07856', '#e8b04b', '#6f97a3', '#f3ead8'];

  let core = new RC.RainCanvasCore({ width: CANVAS_W, height: CANVAS_H });
  const state = {
    tool: 'pen', // must match the .tool.active button in index.html (deskfit test pins this)
    pen: { color: PEN_COLORS[0], width: 4 },
    board: null,
    shot: null,
    offline: false,
    serverLayerFile: null,
    making: false,
    drawer: null,
    dirty: true,
    gesture: null, // { kind:'lasso'|'pen', points:[], ... }
    fit: { scale: 1, ox: 0, oy: 0 },
  };

  /* ------------------------------------------------------------- dom */

  const $ = (id) => document.getElementById(id);
  let disp; let dctx; let off; let octx;

  function boot() {
    disp = $('canvas');
    dctx = disp.getContext('2d');
    off = document.createElement('canvas');
    off.width = CANVAS_W; off.height = CANVAS_H;
    octx = off.getContext('2d', { willReadFrequently: true });

    bindChrome();
    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(tick);
    init().catch((e) => toast('could not start raindesk 🌧️ ' + (e && e.message ? e.message : '')));
  }

  /* --------------------------------------------------------- init/board */

  function shotLabel() { return state.shot ? state.shot.id : 'shot'; }

  /** Rebuild the canvas core for a shot: server layer if present, else the demo plate. */
  async function loadShotIntoCore(shot) {
    core = new RC.RainCanvasCore({ width: CANVAS_W, height: CANVAS_H });
    core.ensureBase('base · ref plate');
    state.serverLayerFile = null;

    if (!state.offline && shot) {
      let loaded = false;
      try {
        const meta = await API.getShot(shot.id);
        if (meta && meta.activeLayer) {
          state.serverLayerFile = meta.activeLayer;
          const rgba = await API.fetchImageRGBA(API.shotImageUrl(shot.id, meta.activeLayer));
          setBaseFromRGBA(rgba);
          loaded = true;
        }
      } catch (_e) { /* fall through to painted base */ }
      if (!loaded) paintLocalBase();
    } else {
      paintLocalBase();
      if (state.offline) toast('offline — demo mode 🌧️ gen needs the server');
    }
  }

  /** Switch to another shot: fresh core, load its state, remember it. */
  async function openShot(id) {
    if (!state.board || !Array.isArray(state.board.shots)) return;
    if (state.shot && state.shot.id === id) return;
    if (state.making) { toast('wait for the take — switching mid-gen would drop it 🌧️'); return; }
    const shot = state.board.shots.find((s) => s.id === id);
    if (!shot) return;
    state.shot = shot;
    try { localStorage.setItem('raindesk.lastShot', id); } catch (_e) { /* ignore */ }
    await loadShotIntoCore(shot);
    updateTitle();
    updateHint();
    syncGenBar();
    closeSheet();
    markDirty();
  }

  /** Keyboard/step navigation between shots. */
  function cycleShot(dir) {
    if (!state.board || !Array.isArray(state.board.shots) || state.board.shots.length === 0) return;
    const idx = state.shot ? state.board.shots.findIndex((s) => s.id === state.shot.id) : -1;
    const next = state.board.shots[(idx + dir + state.board.shots.length) % state.board.shots.length];
    openShot(next.id);
  }

  async function init() {
    const { board, offline } = await API.getBoardOrDemo();
    state.board = board;
    state.offline = offline;
    // restore the last-opened shot when it still exists (return-to-work continuity)
    let lastId = null;
    try { lastId = localStorage.getItem('raindesk.lastShot'); } catch (_e) { /* private mode */ }
    const last = lastId && board.shots.find((s) => s.id === lastId);
    state.shot = last || (board.shots.find((s) => s.lane === 'in_dev') || board.shots[0] || null);

    await loadShotIntoCore(state.shot);

    state.drawer = CHAT.ChatDrawer($('drawer'), { api: API, shotLabel });
    $('drawerHandle').addEventListener('click', () => {
      if (state.drawer.isOpen()) state.drawer.close();
      else state.drawer.open('agent');
    });
    // ≥1024px the drawer docks right: shrink the stage instead of overlaying.
    state.drawer.on('open', () => { document.body.classList.add('drawer-open'); resize(); });
    state.drawer.on('close', () => { document.body.classList.remove('drawer-open'); resize(); });
    // desktop: the companion docks open by default — the artboard owns the layout
    if (window.matchMedia('(min-width: 1024px)').matches) state.drawer.open('agent');

    updateTitle();
    updateHint();
    syncGenBar();
    markDirty();
  }

  function setBaseFromRGBA(rgba) {
    const tmp = document.createElement('canvas');
    tmp.width = CANVAS_W; tmp.height = CANVAS_H;
    const t2 = tmp.getContext('2d', { willReadFrequently: true });
    const img = document.createElement('canvas');
    img.width = rgba.width; img.height = rgba.height;
    img.getContext('2d').putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
    t2.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
    const got = t2.getImageData(0, 0, CANVAS_W, CANVAS_H);
    core.setLayerBuffer(core.ensureBase().id, new Uint8ClampedArray(got.data));
  }

  function paintLocalBase() {
    const base = core.ensureBase();
    const t2 = octx; // reuse offscreen core-size canvas
    RC.paintRainCity(t2, CANVAS_W, CANVAS_H, 7);
    const got = t2.getImageData(0, 0, CANVAS_W, CANVAS_H);
    core.setLayerBuffer(base.id, new Uint8ClampedArray(got.data));
    t2.clearRect(0, 0, CANVAS_W, CANVAS_H);
  }

  function updateTitle() {
    const s = state.shot;
    const beat = s && s.beat ? s.beat : 'the page';
    const short = beat.length > 26 ? beat.slice(0, 25) + '…' : beat;
    $('shotTitle').textContent = s ? `${s.id} · ${short}` : 'raindesk';
  }

  function laneCounts() {
    const counts = { set: 0, in_dev: 0, unplanned: 0 };
    if (state.board && Array.isArray(state.board.shots)) {
      for (const s of state.board.shots) if (s.lane in counts) counts[s.lane] += 1;
    }
    return counts;
  }

  let hintTimer = null;
  function updateHint(sticky) {
    const c = laneCounts();
    const el = $('hint');
    el.textContent = `board: ${c.in_dev} in development · ${c.set} set · ${c.unplanned} unplanned 👀`;
    el.classList.remove('fade');
    clearTimeout(hintTimer);
    if (!sticky) hintTimer = setTimeout(() => el.classList.add('fade'), 4200);
  }

  /* ------------------------------------------------------------ chrome */

  function bindChrome() {
    // tools
    document.querySelectorAll('.tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tool;
        if (t === 'layers') { togglePanel(); return; }
        if (t === 'pen' && state.tool === 'pen') { togglePenPop(); return; }
        setTool(t);
      });
    });

    // pen popover
    document.querySelectorAll('#penpop .swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        state.pen.color = sw.dataset.color;
        syncPenPop();
      });
    });
    $('penWidth').addEventListener('input', (e) => {
      state.pen.width = Number(e.target.value) || 4;
      syncPenPop();
    });

    // gen bar + dock
    $('genBtn').addEventListener('click', onGen);
    $('commitBtn').addEventListener('click', onCommit);
    $('discardBtn').addEventListener('click', onDiscard);
    $('prevTake').addEventListener('click', () => { if (core.prevTake()) { syncDock(); markDirty(); } });
    $('nextTake').addEventListener('click', () => { if (core.nextTake()) { syncDock(); markDirty(); } });

    // top bar
    $('undoBtn').addEventListener('click', onUndo);
    $('laneChip').addEventListener('click', openSheet);
    $('shotTitle').addEventListener('click', openSheet);
    $('shotTitle').style.cursor = 'pointer';
    $('shotTitle').title = 'board / shots — click to switch';

    // sheet
    $('sheetScrim').addEventListener('click', closeSheet);
    $('sheetClose').addEventListener('click', closeSheet);

    // pointer input on the canvas
    disp.addEventListener('pointerdown', onDown);
    disp.addEventListener('pointermove', onMove);
    disp.addEventListener('pointerup', onUp);
    disp.addEventListener('pointercancel', onUp);

    document.addEventListener('keydown', (e) => {
      const inText = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if (e.key === 'Escape') {
        closeSheet();
        $('penpop').classList.remove('open');
        $('layersPanel').classList.remove('open');
        if (state.drawer) state.drawer.close();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); onUndo(); }
      if (!inText && (e.key === '[' || e.key === ']')) cycleShot(e.key === ']' ? 1 : -1);
    });
  }

  function setTool(t) {
    state.tool = t;
    document.querySelectorAll('.tool').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === t);
    });
    if (t !== 'pen') $('penpop').classList.remove('open');
    disp.classList.toggle('crosshair', t === 'select');
  }

  function togglePenPop() { $('penpop').classList.toggle('open'); syncPenPop(); }

  function syncPenPop() {
    document.querySelectorAll('#penpop .swatch').forEach((sw) => {
      sw.classList.toggle('on', sw.dataset.color === state.pen.color);
    });
    const slider = $('penWidth');
    slider.value = String(state.pen.width);
    $('penDotSize').style.width = $('penDotSize').style.height =
      Math.min(18, 4 + state.pen.width) + 'px';
    $('penDotSize').style.background = state.pen.color;
  }

  /* --------------------------------------------------------- pointer io */

  function toCanvas(e) {
    const r = disp.getBoundingClientRect();
    const x = (e.clientX - r.left - state.fit.ox) / state.fit.scale;
    const y = (e.clientY - r.top - state.fit.oy) / state.fit.scale;
    return { x, y };
  }

  function onDown(e) {
    if (state.gesture) return;
    disp.setPointerCapture(e.pointerId);
    const p = toCanvas(e);
    if (state.tool === 'select') {
      state.gesture = { kind: 'lasso', points: [p] };
    } else if (state.tool === 'pen') {
      const layer = core.activeLayer();
      if (!layer || layer.kind === 'base') {
        const pen = core.layers.slice().reverse().find((l) => l.kind === 'pen') ||
          core.addLayer({ name: 'your red-lines', kind: 'pen' });
        core.setActiveLayer(pen.id);
        toast('drawing on a new pen layer ✒️');
      }
      state.gesture = { kind: 'pen', points: [p] };
    }
    markDirty();
  }

  function onMove(e) {
    if (!state.gesture) return;
    const p = toCanvas(e);
    const pts = state.gesture.points;
    const last = pts[pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= 1.2) pts.push(p);
    markDirty();
  }

  function onUp() {
    const g = state.gesture;
    state.gesture = null;
    if (!g) { markDirty(); return; }
    if (g.kind === 'lasso') {
      core.beginLasso();
      for (const p of g.points) core.extendLasso(p);
      if (core.closeLasso()) syncGenBar();
      else core.clearLasso();
    } else if (g.kind === 'pen') {
      try {
        core.addStroke(core.activeLayer().id, {
          points: g.points, color: state.pen.color, width: state.pen.width,
        });
      } catch (err) {
        toast(err.message);
      }
    }
    markDirty();
  }

  /* ------------------------------------------------------------ gen flow */

  function setMaking(on) {
    state.making = on;
    const btn = $('genBtn');
    btn.disabled = on;
    btn.textContent = on ? 'making…' : (core.session && core.session.takes.length ? '⟳ GEN' : 'GEN');
    btn.classList.toggle('making', on);
  }

  function syncGenBar() {
    if (!state.making) {
      $('genBtn').textContent = core.session && core.session.takes.length ? '⟳ GEN' : 'GEN';
    }
  }

  async function onGen() {
    if (state.making) return;
    if (state.offline || !state.shot) { toast('gen needs the raindesk server 🌧️'); return; }
    const assets = core.exportGenAssets({ feather: 24 });
    const prompt = $('prompt').value.trim() || DEFAULT_PROMPT;
    core.beginTakeSession(assets);
    setMaking(true);
    markDirty();
    try {
      const { jobId } = await API.submitGen({
        shotId: state.shot.id,
        layerId: state.serverLayerFile || undefined,
        prompt,
        negative: undefined,
        seed: undefined,
        regionPng: assets.regionPng,
        maskPng: assets.maskPng,
      });
      const view = await API.pollGen(jobId);
      const raw = await API.fetchImageRGBA(view.imageUrl);
      const take = resample(raw, assets.region.w, assets.region.h);
      core.pushTake(take);
      if (state.drawer) {
        state.drawer.recordGen({
          shotId: state.shot.id,
          shotLabel: shotLabel(),
          prompt,
          takeCount: core.session.takes.length,
          imageUrl: view.imageUrl,
        });
      }
      toast(`take ${core.session.takes.length} painted ✨`);
    } catch (e) {
      toast((e && e.friendly) || 'gen didn\'t make it 🌧️');
    } finally {
      setMaking(false);
      syncGenBar();
      syncDock();
      markDirty();
    }
  }

  function resample(rgba, w, h) {
    if (rgba.width === w && rgba.height === h) return rgba.data;
    const src = document.createElement('canvas');
    src.width = rgba.width; src.height = rgba.height;
    src.getContext('2d').putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
    const dst = document.createElement('canvas');
    dst.width = w; dst.height = h;
    dst.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, w, h);
    return new Uint8ClampedArray(dst.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, w, h).data);
  }

  function syncDock() {
    const s = core.session;
    const has = Boolean(s && s.takes.length);
    $('dock').classList.toggle('open', has);
    if (has) {
      $('takeLabel').textContent = `take ${s.takeIndex + 1}/${s.takes.length}`;
      $('prevTake').disabled = s.takeIndex <= 0;
      $('nextTake').disabled = s.takeIndex >= s.takes.length - 1;
    }
  }

  async function onCommit() {
    if (!core.currentTake()) { toast('nothing to commit yet'); return; }
    // never paint onto the locked base without a work layer
    const active = core.activeLayer();
    if (!active || active.kind === 'base') {
      const pen = core.layers.slice().reverse().find((l) => l.kind === 'pen') ||
        core.addLayer({ name: 'gen pass', kind: 'pen' });
      core.setActiveLayer(pen.id);
    }
    try {
      core.commitTake();
    } catch (e) {
      toast(e.message);
      return;
    }
    core.clearLasso();
    if (state.drawer) state.drawer.markCommitted(state.shot ? state.shot.id : null);
    syncGenBar();
    syncDock();
    markDirty();
    toast('committed to layer ✅');
    if (!state.offline && state.shot) {
      try {
        const png = RC.encodePNG(CANVAS_W, CANVAS_H, core.compositeVisible().data);
        const saved = await API.uploadLayer(state.shot.id, png);
        state.serverLayerFile = saved.file;
      } catch (e) {
        toast('saved locally — server upload failed 🌧️');
      }
    }
  }

  function onDiscard() {
    core.discardTakes();
    syncGenBar();
    syncDock();
    markDirty();
    toast('dropped it, no shame ✨');
  }

  function onUndo() {
    const rec = core.undo();
    if (rec) {
      syncGenBar();
      syncDock();
      markDirty();
    } else {
      toast('nothing to undo');
    }
  }

  /* -------------------------------------------------------- layers panel */

  let panelOpen = false;
  function togglePanel() {
    panelOpen = !panelOpen;
    $('layersPanel').classList.toggle('open', panelOpen);
    if (panelOpen) renderPanel();
  }

  function renderPanel() {
    const wrap = $('layerRows');
    wrap.innerHTML = '';
    for (const layer of core.layers) {
      const row = document.createElement('div');
      row.className = 'layer' + (layer.id === core.activeLayerId ? ' on' : '');
      const sw = document.createElement('div');
      sw.className = 'sw sw-' + layer.kind;
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = layer.name;
      const tag = document.createElement('span');
      tag.className = 'tag' + (layer.kind === 'temp' || layer.kind === 'gen' ? ' temp' : '');
      tag.textContent = layer.kind === 'base' ? 'LOCK' : layer.kind.toUpperCase();
      const eye = document.createElement('button');
      eye.className = 'eye';
      eye.textContent = layer.visible ? '👁' : '—';
      eye.setAttribute('aria-label', 'toggle layer visibility');
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        renderPanel();
        markDirty();
      });
      row.append(sw, nm, tag, eye);
      row.addEventListener('click', () => {
        try { core.setActiveLayer(layer.id); } catch (_e) { return; }
        renderPanel();
        markDirty();
      });
      wrap.appendChild(row);
    }
    const add = document.createElement('button');
    add.className = 'add-layer';
    add.textContent = '+ pen layer';
    add.addEventListener('click', () => {
      core.addLayer({ name: 'notes ' + core.layers.filter((l) => l.kind === 'pen').length, kind: 'pen' });
      renderPanel();
      markDirty();
    });
    wrap.appendChild(add);

    const lanes = document.createElement('div');
    lanes.className = 'lanes';
    const c = laneCounts();
    for (const lane of LANES_META) {
      const d = document.createElement('div');
      const mine = state.shot && state.shot.lane === lane.id;
      d.className = 'lane' + (mine ? ' hot' : '');
      d.innerHTML = `${lane.label}<br>${c[lane.id] || 0}`;
      d.addEventListener('click', () => moveShot(lane.id));
      lanes.appendChild(d);
    }
    wrap.appendChild(lanes);
  }

  async function moveShot(lane) {
    if (!state.shot) return;
    if (state.shot.lane === lane) { toast(`already ${lane}`); return; }
    try {
      const res = await API.moveShot(state.shot.id, lane);
      if (res && res.board) state.board = res.board;
      state.shot.lane = lane;
      updateHint(true);
      renderPanel();
      toast(`moved ${state.shot.id} → ${lane} 🎬`);
    } catch (e) {
      toast((e && e.friendly) || 'move failed');
    }
  }

  /* ----------------------------------------------------------- lanes sheet */

  function openSheet() {
    const list = $('lanesList');
    list.innerHTML = '';
    const c = laneCounts();
    for (const lane of LANES_META) {
      const row = document.createElement('div');
      row.className = 'lane-row';
      const head = document.createElement('div');
      head.className = 'lane-head';
      head.innerHTML = `<span>${lane.label}</span><b>${c[lane.id] || 0}</b>`;
      row.appendChild(head);
      if (state.board && Array.isArray(state.board.shots)) {
        for (const s of state.board.shots.filter((x) => x.lane === lane.id)) {
          const chip = document.createElement('div');
          const mine = state.shot && s.id === state.shot.id;
          chip.className = 'shot-chip' + (mine ? ' mine' : '');
          chip.textContent = s.id;
          chip.title = s.beat || '';
          chip.style.cursor = 'pointer';
          chip.addEventListener('click', () => { openShot(s.id); });
          row.appendChild(chip);
        }
      }
      const mv = document.createElement('button');
      mv.className = 'lane-move';
      mv.textContent = state.shot && state.shot.lane === lane.id ? 'current lane' : `move ${shotLabel()} here`;
      mv.disabled = !state.shot || state.shot.lane === lane.id;
      mv.addEventListener('click', () => { moveShot(lane.id); });
      row.appendChild(mv);
      list.appendChild(row);
    }
    $('sheetScrim').classList.add('open');
  }

  function closeSheet() { $('sheetScrim').classList.remove('open'); }

  /* -------------------------------------------------------------- toasts */

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.classList.add('on'), 10);
    setTimeout(() => {
      t.classList.remove('on');
      setTimeout(() => t.remove(), 300);
    }, 2600);
  }

  /* -------------------------------------------------------------- render */

  function resize() {
    const stage = $('stage');
    const dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    disp.width = Math.max(1, Math.round(w * dpr));
    disp.height = Math.max(1, Math.round(h * dpr));
    disp.style.width = w + 'px';
    disp.style.height = h + 'px';
    markDirty();
  }

  function markDirty() { state.dirty = true; }

  function tick() {
    if (state.dirty) {
      state.dirty = false;
      render();
    }
    requestAnimationFrame(tick);
  }

  /** Composite + live take preview (exactly what COMMIT will produce). */
  function frameBuffer() {
    const comp = core.compositeVisible();
    const s = core.session;
    const take = core.currentTake();
    if (!s || !take) return comp.data;
    const out = new Uint8ClampedArray(comp.data); // copy
    const { x, y, w, h } = s.region;
    for (let ry = 0; ry < h; ry++) {
      const gy = y + ry;
      if (gy < 0 || gy >= core.height) continue;
      for (let rx = 0; rx < w; rx++) {
        const gx = x + rx;
        if (gx < 0 || gx >= core.width) continue;
        const a = s.cov[ry * w + rx];
        if (a <= 0) continue;
        const si = (ry * w + rx) * 4;
        const di = (gy * core.width + gx) * 4;
        const sa = (take[si + 3] / 255) * a;
        if (sa <= 0) continue;
        const da = out[di + 3] / 255;
        const ia = 1 - sa;
        out[di] = take[si] * sa + out[di] * da * ia;
        out[di + 1] = take[si + 1] * sa + out[di + 1] * da * ia;
        out[di + 2] = take[si + 2] * sa + out[di + 2] * da * ia;
        out[di + 3] = (sa + da * ia) * 255;
      }
    }
    return out;
  }

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const W = disp.width;
    const H = disp.height;
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, W, H);

    // contain-fit the square art board
    const scale = Math.min(W / CANVAS_W, H / CANVAS_H);
    const cw = CANVAS_W * scale;
    const ch = CANVAS_H * scale;
    const ox = (W - cw) / 2;
    const oy = (H - ch) / 2;
    state.fit = { scale, ox, oy };

    // publish the artboard rect so overlays can anchor to the ART, not the
    // viewport (desktop fit: no UI floating in dead side pillars). --art-x
    // already shrinks with the docked drawer, since it is computed from the
    // reduced stage rect.
    const app = $('app');
    app.style.setProperty('--art-x', (ox / dpr) + 'px');
    app.style.setProperty('--art-w', (cw / dpr) + 'px');
    app.style.setProperty('--art-b', ((oy + ch) / dpr) + 'px');

    // scene-matched backdrop gradient (reads as studio wall, not dead void)
    const bg = dctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#16333e');
    bg.addColorStop(1, '#081217');
    dctx.fillStyle = bg;
    dctx.fillRect(0, 0, W, H);

    octx.putImageData(new ImageData(frameBuffer(), CANVAS_W, CANVAS_H), 0, 0);
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(off, ox, oy, cw, ch);

    // lasso outline (active or in-progress)
    const pts = state.gesture && state.gesture.kind === 'lasso'
      ? state.gesture.points
      : (core.lasso && core.lasso.closed ? core.lasso.points : null);
    if (pts && pts.length > 1) {
      dctx.save();
      dctx.beginPath();
      dctx.moveTo(ox + pts[0].x * scale, oy + pts[0].y * scale);
      for (let i = 1; i < pts.length; i++) dctx.lineTo(ox + pts[i].x * scale, oy + pts[i].y * scale);
      dctx.closePath();
      dctx.strokeStyle = '#e8b04b';
      dctx.lineWidth = 2 * dpr;
      dctx.setLineDash([7 * dpr, 5 * dpr]);
      dctx.stroke();
      dctx.fillStyle = 'rgba(232,176,75,0.10)';
      dctx.fill();
      dctx.restore();
    }

    // live pen preview
    if (state.gesture && state.gesture.kind === 'pen' && state.gesture.points.length) {
      const g = state.gesture;
      dctx.save();
      dctx.beginPath();
      dctx.moveTo(ox + g.points[0].x * scale, oy + g.points[0].y * scale);
      for (let i = 1; i < g.points.length; i++) {
        dctx.lineTo(ox + g.points[i].x * scale, oy + g.points[i].y * scale);
      }
      dctx.strokeStyle = state.pen.color;
      dctx.lineWidth = Math.max(1, state.pen.width * scale);
      dctx.lineJoin = 'round';
      dctx.lineCap = 'round';
      dctx.stroke();
      dctx.restore();
    }

    // take chip over the region (CSS px: divide device-px coords by dpr)
    const s = core.session;
    if (s && s.takes.length) {
      const chip = $('takeChip');
      chip.classList.add('open');
      chip.textContent = `temp · take ${s.takeIndex + 1}/${s.takes.length}`;
      const px = (ox + (s.region.x + 4) * scale) / dpr;
      const py = Math.max(52, (oy + s.region.y * scale - 8) / dpr);
      chip.style.left = px + 'px';
      chip.style.top = py + 'px';
    } else {
      $('takeChip').classList.remove('open');
    }
    syncDock();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
