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
  const DIR = window.RaindeskDirection;
  const BEATS = window.RaindeskBeats;
  const WSPACE = window.RaindeskWorkspaceUI;
  const CDESK = window.RaindeskCreativeDesk;

  if (!RC || !API || !CHAT || !DIR || !BEATS || !WSPACE || !CDESK) {
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
    currentJobId: null,
    currentJobPhase: null,
    takeMeta: [], // aligned with core.session.takes; durable server take ids/provenance
    drawer: null,
    beatTrail: null,
    activeBeatId: null,
    workspaceUI: null,
    creativeDesk: null,
    spaceDown: false,
    dirty: true,
    gesture: null, // { kind:'lasso'|'pen'|'direction', points:[], ... }
    directionMarks: [],
    directionScope: null,
    pendingDirection: null,
    directionBusy: false,
    fit: { scale: 1, ox: 0, oy: 0, cssScale: 1, cssOx: 0, cssOy: 0 },
    persistence: {
      timer: null,
      queue: Promise.resolve(),
      revisionByShot: Object.create(null),
      assetRefsByShot: Object.create(null),
      unsyncedByShot: Object.create(null),
      pendingSnapshotByShot: Object.create(null),
    },
  };

  /* ------------------------------------------------------------- dom */

  const $ = (id) => document.getElementById(id);
  let disp; let dctx; let off; let octx;

  function boot() {
    // Acceptance/runtime health marker: set only after every required script
    // global exists and app.js has entered the real boot path. CI/browser
    // previews assert this so a pretty failure shell cannot pass unnoticed.
    document.documentElement.dataset.raindeskBoot = 'ready';
    disp = $('canvas');
    dctx = disp.getContext('2d');
    off = document.createElement('canvas');
    off.width = CANVAS_W; off.height = CANVAS_H;
    octx = off.getContext('2d', { willReadFrequently: true });

    bindChrome();
    bindDirectionCaption();
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('beforeunload', (e) => {
      if (!hasUnsyncedWork()) return;
      e.preventDefault();
      e.returnValue = '';
    });
    requestAnimationFrame(tick);
    init().catch((e) => toast('could not start raindesk 🌧️ ' + (e && e.message ? e.message : '')));
  }

  /* --------------------------------------------------------- init/board */

  // Single seam exposing the live creative scope for surface hand-off
  // staleness checks (criterion 6). Reads partnerCanvasContext — one source of
  // truth, no parallel state. Installed on window for surface-handoff.js.
  window.RaindeskSurfaceState = {
    liveScope: function () {
      const ctx = partnerCanvasContext();
      return {
        artRevisionId: ctx.artRevisionId || null,
        selection: ctx.selection || null,
      };
    },
  };

  function shotLabel() { return state.shot ? state.shot.id : 'shot'; }

  function partnerCanvasContext() {
    const lasso = core && core.lasso && core.lasso.closed ? core.lasso : null;
    const beat = state.beatTrail && state.beatTrail.getActiveBeat ? state.beatTrail.getActiveBeat() : null;
    const spec = state.beatTrail && state.beatTrail.getSpec ? state.beatTrail.getSpec() : null;
    const shotSpec = spec && spec.shot || null;
    const lassoPoints = lasso
      ? lasso.points.filter((_p, i) => i % Math.max(1, Math.floor(lasso.points.length / 48)) === 0)
        .slice(0, 48).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
      : [];
    return {
      legacyShotId: state.shot ? state.shot.id : null,
      legacyBeat: state.shot && state.shot.beat ? state.shot.beat : '',
      surface: 'storyboard_canvas',
      activeTool: state.tool,
      canvas: {
        width: CANVAS_W,
        height: CANVAS_H,
        activeLayerId: core ? core.activeLayerId : null,
        pendingTakes: core && core.session ? core.session.takes.length : 0,
      },
      selection: lasso ? { type: 'lasso', points: lassoPoints } : null,
      activeBeatId: beat && beat.id || state.activeBeatId || null,
      activeBeat: beat ? {
        id: beat.id, order: beat.order, rawDirection: beat.rawDirection || beat.description || '',
        events: beat.events || [], relations: beat.relations || [],
        startFrame: beat.startFrame || null, endFrame: beat.endFrame || null,
      } : null,
      directingConstraints: shotSpec ? {
        preserve: Array.isArray(shotSpec.preserve) ? shotSpec.preserve.slice(0, 24) : [],
        change: Array.isArray(shotSpec.change) ? shotSpec.change.slice(0, 24) : [],
        startFrame: shotSpec.startFrame || null, endFrame: shotSpec.endFrame || null,
      } : null,
      artRevisionId: state.shot ? (state.persistence.revisionByShot[state.shot.id] || null) : null,
      visibleLayers: core ? core.layers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        kind: layer.kind,
        visible: layer.visible !== false,
        active: layer.id === core.activeLayerId,
      })) : [],
      nearbyNotes: state.directionMarks
        .filter((m) => m && m.rawText)
        .slice(-8)
        .map((m) => m.rawText),
      workspace: state.workspaceUI && state.workspaceUI.context ? state.workspaceUI.context() : null,
      creativeDesk: state.creativeDesk && state.creativeDesk.context ? state.creativeDesk.context() : null,
    };
  }

  /* ----------------------------------------- editable shot persistence */

  function rasterLayerRefsFromDocument(doc) {
    const refs = Object.create(null);
    if (!doc || !Array.isArray(doc.layers)) return refs;
    for (const layer of doc.layers) {
      if (layer && layer.id && layer.assetSha) refs[layer.id] = layer.assetSha;
    }
    return refs;
  }

  function persistenceSnapshot(reason = 'edit') {
    if (state.offline || !state.shot || !API.saveShotDocument || !API.uploadBlob) return null;
    const shotId = state.shot.id;
    const knownRefs = { ...(state.persistence.assetRefsByShot[shotId] || {}) };
    const doc = core.toDocument({ shotId, assetRefsByLayerId: knownRefs });
    doc.meta = {
      legacyShotId: shotId,
      directionShotId: state.directionScope && state.directionScope.shotId || null,
      directionSceneId: state.directionScope && state.directionScope.sceneId || null,
    };
    const pendingRaster = [];
    for (const layer of core.layers) {
      if (!RC.isRasterKind(layer.kind) || knownRefs[layer.id]) continue;
      pendingRaster.push({
        layerId: layer.id,
        png: RC.encodePNG(CANVAS_W, CANVAS_H, new Uint8ClampedArray(layer.data)),
      });
    }
    return { shotId, reason, doc, knownRefs, pendingRaster };
  }

  function enqueueShotSave(snapshot) {
    if (!snapshot) return Promise.resolve(null);
    state.persistence.unsyncedByShot[snapshot.shotId] = true;
    state.persistence.pendingSnapshotByShot[snapshot.shotId] = snapshot;
    state.persistence.queue = state.persistence.queue.then(async () => {
      const refs = {
        ...(state.persistence.assetRefsByShot[snapshot.shotId] || {}),
        ...snapshot.knownRefs,
      };
      for (const item of snapshot.pendingRaster) {
        if (refs[item.layerId]) continue;
        const stored = await API.uploadBlob(item.png);
        refs[item.layerId] = stored.sha;
      }
      for (const layer of snapshot.doc.layers) {
        if (RC.isRasterKind(layer.kind)) layer.assetSha = refs[layer.id] || null;
      }
      const baseRevisionId = state.persistence.revisionByShot[snapshot.shotId] || null;
      const saved = await API.saveShotDocument(snapshot.shotId, {
        document: snapshot.doc,
        baseRevisionId,
        reason: snapshot.reason,
      });
      state.persistence.revisionByShot[snapshot.shotId] = saved.revisionId;
      state.persistence.assetRefsByShot[snapshot.shotId] = refs;
      state.persistence.unsyncedByShot[snapshot.shotId] = false;
      delete state.persistence.pendingSnapshotByShot[snapshot.shotId];
      return saved;
    }).catch((e) => {
      state.persistence.unsyncedByShot[snapshot.shotId] = true;
      // Keep the artwork in the live document and tell the truth: it has not
      // been durably synced yet. Never claim "saved locally" when it is not.
      toast(e && e.status === 409
        ? 'this shot changed elsewhere — keeping your work unsynced for review'
        : 'work is still on this screen, but it has not synced yet 🌧️');
      return null;
    });
    return state.persistence.queue;
  }

  function scheduleShotSave(reason = 'edit', delay = 450) {
    if (state.offline || !state.shot) return;
    state.persistence.unsyncedByShot[state.shot.id] = true;
    clearTimeout(state.persistence.timer);
    state.persistence.timer = setTimeout(() => {
      state.persistence.timer = null;
      enqueueShotSave(persistenceSnapshot(reason));
    }, delay);
  }

  async function flushShotSave(reason = 'edit') {
    clearTimeout(state.persistence.timer);
    state.persistence.timer = null;
    const snap = persistenceSnapshot(reason);
    if (snap) await enqueueShotSave(snap);
    else await state.persistence.queue;
    return state.shot ? !state.persistence.unsyncedByShot[state.shot.id] : true;
  }

  async function retryPendingShotSave(shotId) {
    const snapshot = state.persistence.pendingSnapshotByShot[shotId];
    if (!snapshot) return !state.persistence.unsyncedByShot[shotId];
    await enqueueShotSave(snapshot);
    return !state.persistence.unsyncedByShot[shotId];
  }

  function hasUnsyncedWork() {
    return Object.values(state.persistence.unsyncedByShot).some(Boolean);
  }

  /** Rebuild the canvas core for a shot: editable document first, legacy preview second. */
  async function loadShotIntoCore(shot) {
    core = new RC.RainCanvasCore({ width: CANVAS_W, height: CANVAS_H });
    state.takeMeta = [];
    state.serverLayerFile = null;

    if (!state.offline && shot && API.getShotDocument) {
      try {
        const current = await API.getShotDocument(shot.id);
        const doc = current && current.document;
        if (doc) {
          const buffers = Object.create(null);
          const refs = rasterLayerRefsFromDocument(doc);
          for (const layer of doc.layers || []) {
            if (!layer.assetSha) continue;
            const rgba = await API.fetchImageRGBA(API.blobUrl(layer.assetSha));
            if (rgba.width !== CANVAS_W || rgba.height !== CANVAS_H) {
              throw new Error(`editable layer ${layer.id} has unexpected dimensions`);
            }
            buffers[layer.id] = rgba.data;
          }
          core.loadDocument(doc, buffers);
          state.persistence.revisionByShot[shot.id] = current.revisionId;
          state.persistence.assetRefsByShot[shot.id] = refs;
          state.persistence.unsyncedByShot[shot.id] = false;
          delete state.persistence.pendingSnapshotByShot[shot.id];
          return;
        }
      } catch (e) {
        if (!e || e.status !== 404) {
          toast('editable state could not be restored — opening the last preview instead 🌧️');
        }
      }
    }

    core.ensureBase('base · ref plate');
    state.persistence.revisionByShot[shot && shot.id] = null;
    state.persistence.assetRefsByShot[shot && shot.id] = Object.create(null);

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
    } else if (!shot && !state.offline) {
      // Empty project: no stock artwork, no fake storyboard. A calm blank
      // paper base the artist can draw over immediately (acceptance journey
      // steps 1-2).
      paintBlankBase();
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
    if (state.shot) {
      const currentId = state.shot.id;
      await flushShotSave('switch shot');
      if (state.persistence.unsyncedByShot[currentId]) {
        toast('staying on this shot until its edits are safely synced');
        return;
      }
    }
    state.shot = shot;
    state.activeBeatId = null;
    try { localStorage.setItem('raindesk.lastShot', id); } catch (_e) { /* ignore */ }
    await loadShotIntoCore(shot);
    await hydrateDirectionMarks(shot);
    if (state.beatTrail) state.beatTrail.setShot(shot);
    renderScenesPanel();
    if (state.workspaceUI) state.workspaceUI.refresh().catch(() => {});
    if (state.creativeDesk) await state.creativeDesk.setShot(shot);
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
    await hydrateDirectionMarks(state.shot);
    // First open of a legacy/blank shot is migrated lazily into the editable
    // document store without blocking the creative surface.
    if (state.shot && !state.offline && !state.persistence.revisionByShot[state.shot.id]) {
      scheduleShotSave('initial editable import', 800);
    }

    state.drawer = CHAT.ChatDrawer($('drawer'), {
      api: API,
      shotLabel,
      contextProvider: partnerCanvasContext,
    });
    state.beatTrail = BEATS.BeatTrail($('beatTrail'), {
      api: API,
      direction: DIR,
      shot: state.shot,
      contextProvider: partnerCanvasContext,
      onPartnerMessage: (message, moves) => {
        if (state.drawer && state.drawer.addPartnerNote) state.drawer.addPartnerNote(message, moves);
      },
      onActiveBeatChange: (beat) => {
        state.activeBeatId = beat && beat.id || null;
        markDirty();
      },
      onCaptureFrame: (slot, context) => captureDirectionFrame(slot, context),
    });
    state.drawer.on('turn', () => {
      if (state.beatTrail && state.beatTrail.isOpen()) state.beatTrail.refresh();
      if (state.workspaceUI) state.workspaceUI.refresh().catch(() => {});
    });
    state.drawer.on('action', () => {
      if (state.workspaceUI) state.workspaceUI.refresh().catch(() => {});
    });

    renderScenesPanel();
    $('scenesClose').addEventListener('click', () => $('scenesPanel').classList.remove('open'));

    state.workspaceUI = WSPACE.WorkspaceShell({ api: API, shelf: $('panelShelf') });
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
    state.workspaceUI.registerPanel({
      id: 'panel_partner', key: 'partner', type: 'partner_panel', label: 'Partner',
      element: $('drawer').querySelector('.chat-panel'), handle: $('drawer').querySelector('.chat-tabs'),
      visibilityTarget: $('drawer'), visibleClass: 'open',
      isOpen: () => state.drawer && state.drawer.isOpen(),
      open: () => state.drawer && state.drawer.open('agent'),
      close: () => state.drawer && state.drawer.close(),
    });
    await state.workspaceUI.init();

    state.creativeDesk = CDESK.CreativeDesk({
      api: API,
      stage: $('stage'),
      world: $('creativeWorld'),
      tabs: $('creativeTabs'),
      seedBuiltinSheets: Boolean(state.shot),
      getMetrics: () => ({ width: $('stage').clientWidth, height: $('stage').clientHeight }),
      onViewportChange: () => { markDirty(); if (state.freeform && typeof state.freeform.renderAll === 'function') state.freeform.renderAll(); },
      onContextChange: () => {},
    });
    await state.creativeDesk.init(state.shot);

    // Freeform Creative Desk v2 (flag-gated): mount the shared window
    // manager over the stage when the page runs with ?freeform=1. The
    // default experience is unchanged until the freeform desk is proven;
    // the registry surfaces own only their window content.
    try {
      if (useFreeformDesk) {
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
            // Registry hosting of the EXISTING trail (Phase 3 unit 2):
            // beats.js keeps owning rendering; this seam only mounts a fresh
            // BeatTrail into the window body and hands its lifecycle to the
            // window controller contract.
            mountBeatTrail: (host) => {
              const trailRoot = document.createElement('div');
              host.appendChild(trailRoot);
              const trail = BEATS.BeatTrail(trailRoot, {
                api: API,
                direction: DIR,
                shot: state.shot,
                contextProvider: partnerCanvasContext,
                onPartnerMessage: (message, moves) => {
                  if (state.drawer && state.drawer.addPartnerNote) state.drawer.addPartnerNote(message, moves);
                },
                onActiveBeatChange: (beat) => {
                  state.activeBeatId = beat && beat.id || null;
                  markDirty();
                },
                onCaptureFrame: (slot, context) => captureDirectionFrame(slot, context),
              });
              trail.open();
              // The floating window chrome owns closing; leaving the inline
              // minimiser would freeze refreshes inside a visible window.
              const inlineClose = typeof trailRoot.querySelector === 'function'
                ? trailRoot.querySelector('.beat-trail-close') : null;
              if (inlineClose && inlineClose.style) inlineClose.style.display = 'none';
              // One live trail at a time: Partner canvas context, shot
              // switches and drawer-turn refreshes all read state.beatTrail.
              state.beatTrail = trail;
              return {
                render() { if (trail.isOpen()) trail.refresh(); },
                destroy() {
                  if (state.beatTrail === trail) state.beatTrail = null;
                  trail.close();
                  trailRoot.innerHTML = '';
                  host.innerHTML = '';
                },
              };
            },
            getNotes: () => {
              try { return window.localStorage.getItem(`raindesk.notes.v1.${(state.shot && state.shot.id) || 'project'}`) || ''; } catch (_e) { return ''; }
            },
            setNotes: (text) => {
              try { window.localStorage.setItem(`raindesk.notes.v1.${(state.shot && state.shot.id) || 'project'}`, String(text || '')); } catch (_e) {
                // Warn once per session: per-keystroke spam helps nobody.
                if (!state.notesStorageWarned) { state.notesStorageWarned = true; console.warn('[freeform] notes could not be saved (storage unavailable)'); }
              }
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
            },
          },
        });
        // v4 cutover (S7 implementation-lens F1): the DURABLE client is
        // constructed FIRST and shared by WindowManager AND boot replay —
        // one outbox, one actor. Constructing it after the manager left the
        // manager on its memory-only fallback and made replay() vacuous.
        state.v4 = window.RaindeskV4Client ? window.RaindeskV4Client.V4Client({ api: API }) : null;
        state.freeform = window.RaindeskWindowManager.WindowManager({
          root: $('stage'), document, api: API, v4: state.v4,
          viewportMetrics: () => ({ width: $('stage').clientWidth, height: $('stage').clientHeight }),
          geometry: window.RaindeskWorkspaceUI || {},
        });
        // The tab shelf: calm restore surface for minimised windows (Phase 2).
        const shelfEl = document.createElement('nav');
        shelfEl.className = 'freeform-shelf';
        shelfEl.setAttribute('aria-label', 'window shelf');
        $('stage').appendChild(shelfEl);
        state.freeform.attachShelf(shelfEl);
        // Dev-journey affordance: the native smokes drive the manager directly.
        window.raindeskFreeform = state.freeform;
        const loadCast = async () => {
          if (!API.listCharacters || !state.shot) return;
          try {
            const chars = await API.listCharacters();
            const ctx = await API.getShotCharacters(state.shot.id).catch(() => null);
            state.freeformCast = {
              shotId: state.shot.id,
              characters: (chars && Array.isArray(chars.characters) ? chars.characters : []),
              boundIds: (ctx && Array.isArray(ctx.characterIds) ? ctx.characterIds : []),
            };
            if (state.freeform) state.freeform.refreshAll();
          } catch (_e) { /* character registry needs the local server */ }
        };
        const loadProposals = async () => {
          if (!API.listPartnerActions) return;
          try {
            const res = await API.listPartnerActions(20);
            const items = (res && Array.isArray(res.actions) ? res.actions : []);
            // Only actionable-by-artist ones surface here: pending proposals.
            state.freeformProposals = items.filter((a) => a && a.status === 'proposed');
            if (state.freeform) state.freeform.refreshAll();
          } catch (_e) { /* proposals need the local server */ }
        };
        // v4 cutover S2: durable outbox reconciliation precedes restore — a
        // pending close from a previous session settles before auto-open can
        // resurrect anything (the design's boot-reconcile rule).
        (state.v4 ? state.v4.replay() : Promise.resolve()).catch(() => {})
          .then(() => state.freeform.init())
          .then(() => {
            if (!state.freeform.list().length) {
              state.freeform.open('scenes');
              state.freeform.open('layers');
            }
            loadCast();
            loadProposals();
          }).catch(() => {});
      }
    } catch (_freeformError) { /* the freeform desk is additive; never block boot */ }

    $('drawerHandle').addEventListener('click', () => {
      if (state.drawer.isOpen()) state.drawer.close();
      else state.drawer.open('agent');
    });
    // Mobile keeps the legacy overlay drawer. Desktop Partner placement is
    // owned by the persistent workspace object instead of shrinking the art.
    state.drawer.on('open', () => {
      document.body.classList.toggle('drawer-open', !(state.workspaceUI && state.workspaceUI.isDesktop()));
      resize();
    });
    state.drawer.on('close', () => { document.body.classList.remove('drawer-open'); resize(); });

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

  function paintBlankBase() {
    // Calm blank paper base for empty projects — the desk ivory tone so the
    // untouched desk reads as an open page, never as missing artwork.
    const base = core.ensureBase('base · blank page');
    const rgba = new Uint8ClampedArray(CANVAS_W * CANVAS_H * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 246; rgba[i + 1] = 242; rgba[i + 2] = 232; rgba[i + 3] = 255;
    }
    core.setLayerBuffer(base.id, rgba);
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

  /* --------------------------------------------------- visual direction */

  async function hydrateDirectionMarks(shot) {
    state.directionMarks = [];
    state.directionScope = null;
    state.pendingDirection = null;
    closeDirectionCaption();
    if (state.offline || !shot || !API.getDirection) { markDirty(); return; }
    try {
      const loaded = await DIR.loadShotMarks(API, shot.id);
      state.directionScope = loaded.scope;
      state.directionMarks = loaded.marks || [];
    } catch (_e) {
      // Direction memory is additive: never stop drawing because it is unavailable.
    }
    markDirty();
  }

  function bindDirectionCaption() {
    $('directionCaptionSave').addEventListener('click', savePendingDirection);
    $('directionCaptionCancel').addEventListener('click', cancelPendingDirection);
    $('directionCaptionInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); savePendingDirection(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelPendingDirection(); }
    });
  }

  function openDirectionCaption(points) {
    if (!points || points.length < 2) return;
    state.pendingDirection = { points: points.slice(), beatId: state.activeBeatId || null };
    const end = points[points.length - 1];
    const dpr = window.devicePixelRatio || 1;
    const px = (state.fit.ox + end.x * state.fit.scale) / dpr;
    const py = (state.fit.oy + end.y * state.fit.scale) / dpr;
    const box = $('directionCaption');
    box.style.left = Math.max(10, Math.min(window.innerWidth - 330, px + 14)) + 'px';
    box.style.top = Math.max(64, Math.min(window.innerHeight - 130, py + 12)) + 'px';
    box.classList.add('open');
    box.setAttribute('aria-hidden', 'false');
    $('directionCaptionInput').value = '';
    requestAnimationFrame(() => $('directionCaptionInput').focus());
  }

  function closeDirectionCaption() {
    const box = $('directionCaption');
    if (!box) return;
    box.classList.remove('open');
    box.setAttribute('aria-hidden', 'true');
  }

  function cancelPendingDirection() {
    state.pendingDirection = null;
    closeDirectionCaption();
    markDirty();
  }

  function shortDirectionReadback(turn, annotation) {
    const interp = turn && turn.interpretation;
    if (interp && interp.kind === 'camera') return 'partner read that as a camera move';
    if (interp && interp.kind === 'movement') return 'partner read that as character movement';
    if (interp && interp.kind === 'performance') return 'partner read that as an acting beat';
    if (annotation && annotation.kind && annotation.kind !== 'unknown') return `saved ${annotation.kind.replace('_', ' ')}`;
    return 'saved the direction exactly as drawn';
  }

  async function captureDirectionFrame(slot, { beatId = null } = {}) {
    if (state.offline || !state.shot || !API.uploadBlob) {
      toast('frame references need the local Raindesk server');
      return null;
    }
    const safeSlot = slot === 'start' ? 'start' : slot === 'end' ? 'end' : null;
    if (!safeSlot) return null;
    try {
      // Capture only the visible artwork/current take. Semantic arrows are drawn
      // later onto the display canvas, so they never contaminate the reference.
      const png = RC.encodePNG(CANVAS_W, CANVAS_H, new Uint8ClampedArray(frameBuffer()));
      const stored = await API.uploadBlob(png);
      const scope = state.directionScope || await DIR.ensureLegacyScope(API, state.shot);
      state.directionScope = scope;
      const frameRef = {
        kind: beatId ? 'beat_sketch_reference' : 'shot_sketch_reference',
        referenceId: stored.sha,
        imageUrl: API.blobUrl(stored.sha),
        sourceRevisionId: state.persistence.revisionByShot[state.shot.id] || null,
        capturedAt: new Date().toISOString(),
        description: beatId
          ? `${safeSlot} pose captured from ${state.shot.id}`
          : `${safeSlot} framing captured from ${state.shot.id}`,
      };
      if (beatId && API.setDirectionBeatFrameRef) await API.setDirectionBeatFrameRef(beatId, safeSlot, frameRef);
      else if (API.setDirectionShotFrameRef) await API.setDirectionShotFrameRef(scope.shotId, safeSlot, frameRef);
      toast(beatId ? `${safeSlot} pose pinned to the beat` : `${safeSlot} frame pinned to the shot`);
      return frameRef;
    } catch (e) {
      toast('could not pin that frame yet — the artwork is unchanged');
      throw e;
    }
  }

  async function savePendingDirection() {
    if (state.directionBusy || !state.pendingDirection || !state.shot) return;
    const pending = state.pendingDirection;
    const caption = $('directionCaptionInput').value.trim();
    state.directionBusy = true;
    closeDirectionCaption();
    // Optimistically keep the arrow visible while the Partner interprets it.
    const provisional = {
      id: `local_${Date.now()}`,
      kind: 'unknown',
      rawText: caption,
      geometry: DIR.pathGeometry(pending.points, CANVAS_W, CANVAS_H),
      scopeType: pending.beatId ? 'beat' : 'shot',
      scopeId: pending.beatId || (state.directionScope && state.directionScope.shotId) || null,
      shotId: (state.directionScope && state.directionScope.shotId) || null,
      source: { beatId: pending.beatId || null, legacyShotId: state.shot.id },
      status: 'provisional',
      local: true,
    };
    state.directionMarks.push(provisional);
    state.pendingDirection = null;
    markDirty();
    try {
      const result = await DIR.interpretAndSavePath(API, {
        legacyShot: state.shot,
        points: pending.points,
        caption,
        width: CANVAS_W,
        height: CANVAS_H,
        extraContext: { ...partnerCanvasContext(), canvas: { width: CANVAS_W, height: CANVAS_H } },
        beatId: pending.beatId || null,
      });
      const i = state.directionMarks.indexOf(provisional);
      if (i !== -1 && result.annotation) state.directionMarks[i] = result.annotation;
      state.directionScope = result.scope;
      toast(shortDirectionReadback(result.turn, result.annotation));
      if (result.turn && result.turn.message && state.drawer && state.drawer.addPartnerNote) {
        state.drawer.addPartnerNote(result.turn.message, result.turn.nextMoves || []);
      }
    } catch (_e) {
      provisional.local = false;
      toast('the arrow is still on this screen, but it has not synced yet');
    } finally {
      state.directionBusy = false;
      markDirty();
    }
  }

  function drawArrowPath(points, { color = '#e07856', alpha = 1, caption = '', live = false } = {}) {
    if (!points || points.length < 2) return;
    const { scale, ox, oy } = state.fit;
    const dpr = window.devicePixelRatio || 1;
    dctx.save();
    dctx.globalAlpha = alpha;
    dctx.strokeStyle = color;
    dctx.fillStyle = color;
    dctx.lineWidth = Math.max(2 * dpr, 2.2 * scale);
    dctx.lineJoin = 'round';
    dctx.lineCap = 'round';
    dctx.beginPath();
    dctx.moveTo(ox + points[0].x * scale, oy + points[0].y * scale);
    for (let i = 1; i < points.length; i++) dctx.lineTo(ox + points[i].x * scale, oy + points[i].y * scale);
    dctx.stroke();

    const end = points[points.length - 1];
    let prev = points[points.length - 2];
    for (let i = points.length - 2; i >= 0; i--) {
      if (Math.hypot(end.x - points[i].x, end.y - points[i].y) > 8) { prev = points[i]; break; }
    }
    const ex = ox + end.x * scale;
    const ey = oy + end.y * scale;
    const angle = Math.atan2(end.y - prev.y, end.x - prev.x);
    const size = 12 * dpr;
    dctx.beginPath();
    dctx.moveTo(ex, ey);
    dctx.lineTo(ex - Math.cos(angle - 0.55) * size, ey - Math.sin(angle - 0.55) * size);
    dctx.lineTo(ex - Math.cos(angle + 0.55) * size, ey - Math.sin(angle + 0.55) * size);
    dctx.closePath();
    dctx.fill();

    if (caption && !live) {
      const label = caption.length > 42 ? caption.slice(0, 39) + '...' : caption;
      dctx.font = `${11 * dpr}px ${getComputedStyle(document.body).fontFamily}`;
      const metrics = dctx.measureText(label);
      const pad = 6 * dpr;
      const lx = Math.min(disp.width - metrics.width - pad * 3, ex + 10 * dpr);
      const ly = Math.max(20 * dpr, ey - 10 * dpr);
      dctx.fillStyle = 'rgba(14,33,41,.88)';
      dctx.fillRect(lx - pad, ly - 13 * dpr, metrics.width + pad * 2, 18 * dpr);
      dctx.fillStyle = '#f3ead8';
      dctx.fillText(label, lx, ly);
    }
    dctx.restore();
  }

  /* ------------------------------------------------ beats surface routing */
  // Phase 3 migration: the freeform registry owns the desktop Beats window;
  // the bespoke beat-trail shell stays the fallback wherever the freeform
  // desk did not mount (default experience, no ?freeform=1).

  function beatsWindowId() { return 'window_beats'; }

  function beatsWindowState() {
    return state.freeform ? state.freeform.state(beatsWindowId()) : null;
  }

  /** Desktop Beats entry point: open / restore / minimise the registry
   * window (toggle parity with the old bespoke shell). Returns false when
   * the freeform desk is absent so callers fall back to the legacy path. */
  function toggleBeatsSurface() {
    const win = beatsWindowState();
    if (!win) {
      if (!state.freeform) return false;
      // Stable entityRef keeps Partner move_panel compatibility inside the
      // documented beats: namespace (workspace schema v3 ENTITY_REF_RE).
      state.freeform.open('beats', { entityRef: 'beats:active_shot' });
      return true;
    }
    if (win.state === 'minimised' || win.state === 'tabbed') state.freeform.restore(win.windowId);
    else state.freeform.minimise(win.windowId);
    return true;
  }

  /** Escape-style dismissal: minimise (never destroy) so the trail instance
   * keeps tracking shot changes while hidden. Returns false when there is
   * no registry window to dismiss. */
  function closeBeatsSurface() {
    const win = beatsWindowState();
    if (!win || win.state === 'minimised') return Boolean(win);
    state.freeform.minimise(win.windowId);
    return true;
  }

  /* ------------------------------------------------------------ chrome */

  function bindChrome() {
    // tools
    document.querySelectorAll('.tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tool;
        if (t === 'layers') { togglePanel(); return; }
        if (t === 'beats') { if (!toggleBeatsSurface() && state.beatTrail) state.beatTrail.toggle(); return; }
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
    $('stage').addEventListener('wheel', (e) => {
      if (!state.creativeDesk || e.target.closest('.workspace-floating-panel,input,textarea')) return;
      e.preventDefault();
      const r = $('stage').getBoundingClientRect();
      const factor = Math.exp(-Number(e.deltaY || 0) * 0.0012);
      state.creativeDesk.zoomAt({ x: e.clientX - r.left, y: e.clientY - r.top }, factor);
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      const inText = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if (e.key === 'Escape') {
        cancelPendingDirection();
        closeSheet();
        $('penpop').classList.remove('open');
        $('layersPanel').classList.remove('open');
        $('scenesPanel').classList.remove('open');
        if (!closeBeatsSurface() && state.beatTrail) state.beatTrail.close();
        if (state.drawer) state.drawer.close();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); onUndo(); }
      if (!inText && e.code === 'Space') {
        state.spaceDown = true; document.body.classList.add('desk-panning'); e.preventDefault();
      }
      if (!inText && (e.key === '[' || e.key === ']')) cycleShot(e.key === ']' ? 1 : -1);
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { state.spaceDown = false; document.body.classList.remove('desk-panning'); }
    });
  }

  function setTool(t) {
    state.tool = t;
    document.querySelectorAll('.tool').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === t);
    });
    if (t !== 'pen') $('penpop').classList.remove('open');
    disp.classList.toggle('crosshair', t === 'select' || t === 'direction');
    disp.classList.toggle('direction-cursor', t === 'direction');
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
    const x = (e.clientX - r.left - state.fit.cssOx) / state.fit.cssScale;
    const y = (e.clientY - r.top - state.fit.cssOy) / state.fit.cssScale;
    return { x, y };
  }

  function onDown(e) {
    if (state.gesture) return;
    disp.setPointerCapture(e.pointerId);
    if (state.creativeDesk && (e.button === 1 || (e.button === 0 && state.spaceDown))) {
      state.gesture = { kind: 'pan', clientX: e.clientX, clientY: e.clientY, viewport: state.creativeDesk.viewport() };
      document.body.classList.add('desk-dragging');
      return;
    }
    const p = toCanvas(e);
    if (state.tool === 'select') {
      state.gesture = { kind: 'lasso', points: [p] };
    } else if (state.tool === 'direction') {
      cancelPendingDirection();
      state.gesture = { kind: 'direction', points: [p] };
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
    if (state.gesture.kind === 'pan') {
      const g = state.gesture;
      state.creativeDesk.setViewport({
        x: g.viewport.x + e.clientX - g.clientX,
        y: g.viewport.y + e.clientY - g.clientY,
        zoom: g.viewport.zoom,
      }, { persist: false });
      return;
    }
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
    if (g.kind === 'pan') {
      document.body.classList.remove('desk-dragging');
      if (state.creativeDesk) state.creativeDesk.setViewport(state.creativeDesk.viewport());
      markDirty(); return;
    }
    if (g.kind === 'lasso') {
      core.beginLasso();
      for (const p of g.points) core.extendLasso(p);
      if (core.closeLasso()) syncGenBar();
      else core.clearLasso();
    } else if (g.kind === 'direction') {
      if (g.points.length > 1) openDirectionCaption(g.points);
    } else if (g.kind === 'pen') {
      try {
        core.addStroke(core.activeLayer().id, {
          points: g.points, color: state.pen.color, width: state.pen.width,
        });
        scheduleShotSave('draw stroke');
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
    if (!on) {
      state.currentJobId = null;
      state.currentJobPhase = null;
      btn.disabled = false;
      btn.textContent = core.session && core.session.takes.length ? '⟳ GEN' : 'GEN';
    } else {
      btn.disabled = true;
      btn.textContent = 'starting…';
    }
    btn.classList.toggle('making', on);
  }

  function updateGenerationPhase(view) {
    if (!state.making) return;
    const phase = view && view.phase || state.currentJobPhase || 'queued';
    state.currentJobPhase = phase;
    const btn = $('genBtn');
    if (phase === 'queued') {
      btn.disabled = false;
      btn.textContent = 'CANCEL · waiting';
    } else if (phase === 'mirroring') {
      btn.disabled = true;
      btn.textContent = 'finishing…';
    } else {
      btn.disabled = true;
      btn.textContent = 'making…';
    }
  }

  function syncGenBar() {
    if (!state.making) {
      $('genBtn').textContent = core.session && core.session.takes.length ? '⟳ GEN' : 'GEN';
    }
  }

  async function onGen() {
    if (state.making) {
      if (state.currentJobId && state.currentJobPhase === 'queued' && API.cancelGen) {
        try {
          await API.cancelGen(state.currentJobId);
          toast('cancelled before it started');
        } catch (e) {
          toast((e && (e.friendly || e.message)) || 'could not cancel this stage');
        }
      } else {
        toast('already working on it — this stage cannot be safely stopped yet');
      }
      return;
    }
    if (state.offline || !state.shot) { toast('gen needs the raindesk server 🌧️'); return; }
    // Pin the exact editable artwork revision before asking the generator to
    // branch from it. A take is only trustworthy when its parent is durable.
    const synced = await flushShotSave('prepare generation');
    if (!synced) {
      toast('I’m keeping this take on hold until the current shot syncs safely');
      return;
    }
    const assets = core.exportGenAssets({ feather: 24 });
    const prompt = $('prompt').value.trim() || DEFAULT_PROMPT;
    core.beginTakeSession(assets);
    if (core.session && core.session.takes.length === 0) state.takeMeta = [];
    setMaking(true);
    markDirty();
    try {
      const { jobId } = await API.submitGen({
        shotId: state.shot.id,
        layerId: state.serverLayerFile || undefined,
        prompt,
        negative: undefined,
        seed: undefined,
        baseRevisionId: state.persistence.revisionByShot[state.shot.id] || null,
        region: assets.region,
        lasso: core.effectiveLassoPoints ? core.effectiveLassoPoints() : [],
        regionPng: assets.regionPng,
        maskPng: assets.maskPng,
      });
      state.currentJobId = jobId;
      state.currentJobPhase = 'queued';
      updateGenerationPhase({ phase: 'queued' });
      const view = await API.pollGen(jobId, { onPoll: updateGenerationPhase });
      const raw = await API.fetchImageRGBA(view.imageUrl);
      const take = resample(raw, assets.region.w, assets.region.h);
      const takeIndex = core.pushTake(take);
      state.takeMeta[takeIndex] = {
        takeId: view.takeId || null,
        resultAssetSha: view.resultAssetSha || null,
        imageUrl: view.imageUrl || null,
      };
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
    // Phase 3: the freeform Takes window refreshes from the same seam the
    // bespoke dock uses — every take-changing site already calls syncDock.
    if (state.freeform && typeof state.freeform.refreshAll === 'function') state.freeform.refreshAll();
  }

  async function onCommit() {
    if (!core.currentTake()) { toast('nothing to commit yet'); return; }
    const selectedIndex = core.session ? core.session.takeIndex : -1;
    const acceptedMeta = selectedIndex >= 0 ? state.takeMeta[selectedIndex] || null : null;
    try {
      core.commitTake({
        name: `accepted take ${Date.now().toString(36).slice(-4)}`,
        sourceTakeId: acceptedMeta && acceptedMeta.takeId || null,
      });
    } catch (e) {
      toast(e.message);
      return;
    }
    core.clearLasso();
    if (state.drawer) state.drawer.markCommitted(state.shot ? state.shot.id : null);
    syncGenBar();
    syncDock();
    markDirty();
    toast('accepted — saving as its own take layer…');
    const saved = await flushShotSave('accept generated take');
    if (saved && acceptedMeta && acceptedMeta.takeId && API.acceptTake && state.shot) {
      try {
        await API.acceptTake(acceptedMeta.takeId, state.persistence.revisionByShot[state.shot.id] || null);
      } catch (_e) {
        // The artwork revision is already safe. Keep take metadata candidate
        // rather than lying about acceptance; it can be reconciled later.
        toast('artwork is safe; take history still needs to sync');
      }
    }
    state.takeMeta = [];
    if (!state.shot || !state.persistence.unsyncedByShot[state.shot.id]) {
      toast('take saved safely ✅');
    }
  }

  function onDiscard() {
    const rejected = state.takeMeta.slice();
    if (API.rejectTake) {
      for (const meta of rejected) {
        if (meta && meta.takeId) API.rejectTake(meta.takeId).catch(() => {});
      }
    }
    state.takeMeta = [];
    core.discardTakes();
    syncGenBar();
    syncDock();
    markDirty();
    toast('dropped it, no shame ✨');
  }

  async function onUndo() {
    const rec = core.undo();
    if (!rec) {
      toast('nothing to undo');
      return;
    }
    syncGenBar();
    syncDock();
    markDirty();
    if (rec.type === 'commitLayer' && rec.sourceTakeId) {
      const saved = await flushShotSave('undo accepted take');
      if (saved && API.reopenTake) {
        try { await API.reopenTake(rec.sourceTakeId); }
        catch (_e) { toast('artwork undo is safe; take history still needs to sync'); }
      }
      return;
    }
    scheduleShotSave('undo');
  }

  /* --------------------------------------------------------- scenes panel */

  function renderScenesPanel() {
    const wrap = $('sceneRows');
    if (!wrap) return;
    wrap.innerHTML = '';
    const shots = state.board && Array.isArray(state.board.shots) ? state.board.shots : [];
    for (const shot of shots) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'workspace-scene-row' + (state.shot && state.shot.id === shot.id ? ' active' : '');
      const id = document.createElement('strong'); id.textContent = shot.id;
      const copy = document.createElement('span');
      const beat = shot.beat || 'untitled scene'; copy.textContent = beat.length > 58 ? beat.slice(0, 57) + '…' : beat;
      const lane = document.createElement('small'); lane.textContent = String(shot.lane || '').replace('_', ' ');
      row.append(id, copy, lane);
      row.addEventListener('click', () => openShot(shot.id));
      wrap.appendChild(row);
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
        scheduleShotSave('layer visibility');
      });
      row.append(sw, nm, tag, eye);
      row.addEventListener('click', () => {
        try { core.setActiveLayer(layer.id); } catch (_e) { return; }
        renderPanel();
        markDirty();
        scheduleShotSave('active layer');
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
      scheduleShotSave('add pen layer');
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
    if (state.creativeDesk) state.creativeDesk.refreshLayout();
    markDirty();
  }

  function markDirty() {
    state.dirty = true;
    // Freeform surfaces ride the same invalidation: board/layer edits must
    // reach the registry windows, not just the shot canvas (adversarial
    // repair: stale surface lists).
    if (state.freeform && typeof state.freeform.refreshAll === 'function') state.freeform.refreshAll();
  }

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

  function directionCaptionForMark(mark) {
    const raw = mark && mark.rawText || '';
    if (!mark || mark.scopeType !== 'beat' || !state.beatTrail || !state.beatTrail.beatOrderFor) return raw;
    const order = state.beatTrail.beatOrderFor(mark.scopeId);
    return order == null ? raw : `B${order}${raw ? ' · ' + raw : ''}`;
  }

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const W = disp.width;
    const H = disp.height;
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, W, H);

    // Creative Desk fit is calculated in CSS pixels first so pointer input
    // and persistent viewport pan use the same coordinate space regardless of
    // devicePixelRatio. Device pixels are only used for the raster draw.
    const cssW = Math.max(1, disp.clientWidth || W / dpr);
    const cssH = Math.max(1, disp.clientHeight || H / dpr);
    const viewport = state.creativeDesk ? state.creativeDesk.viewport() : { x: 0, y: 0, zoom: 1 };
    const baseCssScale = Math.min(cssW / CANVAS_W, cssH / CANVAS_H);
    const cssScale = baseCssScale * viewport.zoom;
    const cssCw = CANVAS_W * cssScale;
    const cssCh = CANVAS_H * cssScale;
    const cssOx = (cssW - cssCw) / 2 + viewport.x;
    const cssOy = (cssH - cssCh) / 2 + viewport.y;
    const scale = cssScale * dpr;
    const cw = cssCw * dpr;
    const ch = cssCh * dpr;
    const ox = cssOx * dpr;
    const oy = cssOy * dpr;
    state.fit = { scale, ox, oy, cssScale, cssOx, cssOy };

    // publish the visible shot-sheet rect for screen-space helpers.
    const app = $('app');
    app.style.setProperty('--art-x', cssOx + 'px');
    app.style.setProperty('--art-w', cssCw + 'px');
    app.style.setProperty('--art-b', (cssOy + cssCh) + 'px');

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

    // semantic direction arrows live above the art but outside raster layers.
    for (const mark of state.directionMarks) {
      if (!mark || !mark.geometry || !Array.isArray(mark.geometry.points)) continue;
      const color = mark.kind === 'camera_path' ? '#e8b04b' :
        (mark.kind === 'actor_motion' ? '#e07856' : '#6f97a3');
      drawArrowPath(mark.geometry.points, {
        color,
        alpha: mark.local ? 0.72 : 0.95,
        caption: directionCaptionForMark(mark),
      });
    }
    if (state.gesture && state.gesture.kind === 'direction') {
      drawArrowPath(state.gesture.points, { color: '#e07856', alpha: 0.85, live: true });
    }
    if (state.pendingDirection) {
      drawArrowPath(state.pendingDirection.points, { color: '#e07856', alpha: 0.85, live: true });
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
