/* Raindesk Reference Board v1 — immutable image cards inside revisioned reference sheets. */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else {
    root.RaindeskReferenceBoard = mod;
    if (root.document && root.RaindeskAPI) mod.autoStart(root, root.RaindeskAPI);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_IMPORT_DIM = 2048;
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v) || 0)); }
  function fitImageCard(imageWidth, imageHeight, canvasWidth, canvasHeight) {
    const iw = Math.max(1, Number(imageWidth) || 1); const ih = Math.max(1, Number(imageHeight) || 1);
    const cw = Math.max(128, Number(canvasWidth) || 900); const ch = Math.max(128, Number(canvasHeight) || 700);
    const scale = Math.min((cw * 0.62) / iw, (ch * 0.62) / ih, 1);
    const width = Math.max(40, iw * scale); const height = Math.max(40, ih * scale);
    return { x: (cw - width) / 2, y: (ch - height) / 2, width, height };
  }
  function mediaCss(media, canvas) {
    const cw = Math.max(1, Number(canvas && canvas.width) || 1); const ch = Math.max(1, Number(canvas && canvas.height) || 1);
    return {
      left: `${Number(media.x || 0) * 100 / cw}%`, top: `${Number(media.y || 0) * 100 / ch}%`,
      width: `${Number(media.width || 1) * 100 / cw}%`, height: `${Number(media.height || 1) * 100 / ch}%`,
      transform: `rotate(${Number(media.rotation) || 0}deg)`, opacity: String(clamp(media.opacity == null ? 1 : media.opacity, 0.05, 1)),
      zIndex: String(20 + (Number(media.zIndex) || 0)),
    };
  }
  function cardId() { return `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

  async function imageFileToPng(file, root = globalThis) {
    if (!file) throw new Error('image file is required');
    if (!root.createImageBitmap) throw new Error('browser cannot decode this image');
    const bitmap = await root.createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_IMPORT_DIM / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = root.document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('could not encode reference PNG')), 'image/png'));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
    } finally { if (bitmap.close) bitmap.close(); }
  }

  function ReferenceBoard(opts = {}) {
    const root = opts.root || (typeof window !== 'undefined' ? window : null);
    const document = opts.document || (root && root.document);
    const api = opts.api;
    const states = new Map();
    const mounts = new Map();
    const saveQueues = new Map();
    let activeSheetId = 'sheet_references_main';
    let observer = null;
    let input = null;
    let scanTimer = null;

    function sheetIdForElement(el) {
      if (!el || !document) return null;
      const worldId = el.dataset.worldId;
      if (!worldId) return null;
      for (const tab of document.querySelectorAll('[data-creative-target][data-sheet-id]')) {
        if (tab.dataset.creativeTarget === worldId) return tab.dataset.sheetId || null;
      }
      return worldId === 'world_references_main' ? 'sheet_references_main' : null;
    }
    function stateFor(sheetId) { return states.get(sheetId) || null; }
    function mounted(sheetId) { return mounts.get(sheetId) || null; }
    function setRevision(revision) {
      if (!revision || !revision.sheetId || !revision.document || !['references', 'character'].includes(revision.document.kind)) return null;
      if (!Array.isArray(revision.document.media)) revision.document.media = [];
      states.set(revision.sheetId, revision); render(revision.sheetId); return revision;
    }
    async function load(sheetId) {
      if (!api || !api.getSheet) return null;
      try { return setRevision(await api.getSheet(sheetId)); } catch (_e) { return null; }
    }

    function ensureInput() {
      if (input || !document) return input;
      input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.hidden = true;
      input.dataset.referenceImport = '1';
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0]; input.value = '';
        if (file) await addFile(activeSheetId, file).catch(() => {});
      });
      document.body.appendChild(input); return input;
    }
    function toolbar(sheetId, el) {
      const actions = el.querySelector('.creative-sheet-actions'); if (!actions || actions.querySelector('.reference-import')) return;
      const importBtn = document.createElement('button'); importBtn.type = 'button'; importBtn.className = 'reference-import'; importBtn.title = 'add reference image'; importBtn.textContent = '+';
      const arrange = document.createElement('button'); arrange.type = 'button'; arrange.className = 'reference-arrange-toggle'; arrange.title = 'arrange reference images'; arrange.textContent = '▧'; arrange.setAttribute('aria-pressed', 'false');
      importBtn.addEventListener('click', (e) => { e.stopPropagation(); activeSheetId = sheetId; ensureInput().click(); });
      arrange.addEventListener('click', (e) => {
        e.stopPropagation(); activeSheetId = sheetId;
        const next = !el.classList.contains('reference-arrange'); el.classList.toggle('reference-arrange', next); arrange.setAttribute('aria-pressed', next ? 'true' : 'false');
      });
      actions.prepend(arrange); actions.prepend(importBtn);
    }
    function mount(sheetId, el) {
      if (!el || mounts.has(sheetId)) return;
      const body = el.querySelector('.creative-sheet-body'); if (!body) return;
      const layer = document.createElement('div'); layer.className = 'reference-media-layer'; layer.dataset.referenceMediaLayer = sheetId;
      body.appendChild(layer);
      toolbar(sheetId, el);
      el.addEventListener('pointerdown', () => { activeSheetId = sheetId; }, true);
      mounts.set(sheetId, { el, layer }); render(sheetId);
    }

    function applyStyle(card, media, canvas) { Object.assign(card.style, mediaCss(media, canvas)); }
    function cardControls(sheetId, media) {
      const controls = document.createElement('div'); controls.className = 'reference-card-controls';
      const left = document.createElement('button'); left.type = 'button'; left.textContent = '↶'; left.title = 'rotate left';
      const right = document.createElement('button'); right.type = 'button'; right.textContent = '↷'; right.title = 'rotate right';
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'remove reference';
      for (const btn of [left, right, remove]) btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      left.addEventListener('click', () => mutateMedia(sheetId, media.id, (m) => { m.rotation = (Number(m.rotation) || 0) - 5; }, 'rotate reference').catch(() => {}));
      right.addEventListener('click', () => mutateMedia(sheetId, media.id, (m) => { m.rotation = (Number(m.rotation) || 0) + 5; }, 'rotate reference').catch(() => {}));
      remove.addEventListener('click', () => removeMedia(sheetId, media.id).catch(() => {}));
      controls.append(left, right, remove); return controls;
    }
    function installCardDrag(sheetId, card, media, canvas) {
      card.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button,.reference-card-resize')) return;
        const mountState = mounted(sheetId); if (!mountState || !mountState.el.classList.contains('reference-arrange')) return;
        e.preventDefault(); e.stopPropagation(); card.setPointerCapture(e.pointerId);
        const rect = mountState.layer.getBoundingClientRect(); const sx = e.clientX, sy = e.clientY; const ox = media.x, oy = media.y;
        const move = (ev) => {
          media.x = ox + (ev.clientX - sx) * canvas.width / Math.max(1, rect.width);
          media.y = oy + (ev.clientY - sy) * canvas.height / Math.max(1, rect.height);
          applyStyle(card, media, canvas);
        };
        const up = (ev) => {
          try { card.releasePointerCapture(ev.pointerId); } catch (_e) {}
          card.removeEventListener('pointermove', move); card.removeEventListener('pointerup', up);
          mutateMedia(sheetId, media.id, (m) => { m.x = media.x; m.y = media.y; }, 'move reference').catch(() => {});
        };
        card.addEventListener('pointermove', move); card.addEventListener('pointerup', up);
      });
      const resize = card.querySelector('.reference-card-resize');
      resize.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); resize.setPointerCapture(e.pointerId);
        const mountState = mounted(sheetId); const rect = mountState.layer.getBoundingClientRect(); const sx = e.clientX; const ow = media.width; const oh = media.height; const ratio = oh / Math.max(1, ow);
        const move = (ev) => {
          media.width = clamp(ow + (ev.clientX - sx) * canvas.width / Math.max(1, rect.width), 40, canvas.width * 1.5);
          media.height = Math.max(40, media.width * ratio); applyStyle(card, media, canvas);
        };
        const up = (ev) => {
          try { resize.releasePointerCapture(ev.pointerId); } catch (_e) {}
          resize.removeEventListener('pointermove', move); resize.removeEventListener('pointerup', up);
          mutateMedia(sheetId, media.id, (m) => { m.width = media.width; m.height = media.height; }, 'resize reference').catch(() => {});
        };
        resize.addEventListener('pointermove', move); resize.addEventListener('pointerup', up);
      });
    }
    function render(sheetId) {
      const mountState = mounted(sheetId); const revision = stateFor(sheetId); if (!mountState || !revision) return;
      const { layer } = mountState; const doc = revision.document; layer.innerHTML = '';
      const media = Array.isArray(doc.media) ? doc.media.slice().sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0)) : [];
      for (const item of media) {
        const card = document.createElement('div'); card.className = 'reference-card'; card.dataset.mediaId = item.id; applyStyle(card, item, doc.canvas);
        const img = document.createElement('img'); img.src = api && api.blobUrl ? api.blobUrl(item.sha) : `/api/blob/${encodeURIComponent(item.sha)}`; img.alt = item.caption || 'reference image'; img.draggable = false;
        const caption = document.createElement('div'); caption.className = 'reference-card-caption'; caption.textContent = item.caption || '';
        const resize = document.createElement('div'); resize.className = 'reference-card-resize';
        card.append(img, caption, cardControls(sheetId, item), resize); layer.appendChild(card); installCardDrag(sheetId, card, item, doc.canvas);
      }
      mountState.el.classList.toggle('has-reference-media', media.length > 0);
    }

    function saveDocument(sheetId, mutator, reason) {
      if (!api || !api.getSheet || !api.saveSheet) return Promise.resolve(null);
      const previous = saveQueues.get(sheetId) || Promise.resolve();
      const task = previous.then(async () => {
        const current = await api.getSheet(sheetId); const documentCopy = clone(current.document); if (!Array.isArray(documentCopy.media)) documentCopy.media = [];
        mutator(documentCopy);
        const result = await api.saveSheet(sheetId, documentCopy, { baseRevisionId: current.revisionId, reason });
        return setRevision(result && result.revision);
      });
      // Keep the queue alive after an isolated failed media action; the caller
      // still receives the rejection and can surface/ignore it deliberately.
      saveQueues.set(sheetId, task.catch(() => null));
      return task;
    }
    function mutateMedia(sheetId, mediaId, mutator, reason) {
      return saveDocument(sheetId, (doc) => { const item = doc.media.find((m) => m.id === mediaId); if (item) mutator(item); }, reason);
    }
    function removeMedia(sheetId, mediaId) { return saveDocument(sheetId, (doc) => { doc.media = doc.media.filter((m) => m.id !== mediaId); }, 'remove reference'); }
    async function addFile(sheetId, file) {
      activeSheetId = sheetId;
      const converted = await imageFileToPng(file, root); const asset = await api.uploadBlob(converted.bytes);
      return saveDocument(sheetId, (doc) => {
        const fit = fitImageCard(converted.width, converted.height, doc.canvas.width, doc.canvas.height);
        const offset = (doc.media.length % 5) * 18;
        doc.media.push({ id: cardId(), kind: 'image', sha: asset.sha, x: fit.x + offset, y: fit.y + offset, width: fit.width, height: fit.height, rotation: 0, opacity: 1, zIndex: doc.media.length, caption: String(file.name || '').slice(0, 120) });
      }, 'add reference image');
    }

    async function inspectElement(el) {
      const sheetId = sheetIdForElement(el); if (!sheetId || mounts.has(sheetId)) return;
      const revision = await load(sheetId); if (!revision || !['references', 'character'].includes(revision.document.kind)) return;
      mount(sheetId, el);
    }
    function scan() {
      clearTimeout(scanTimer); scanTimer = setTimeout(() => {
        for (const el of document.querySelectorAll('.creative-sheet[data-world-id]')) inspectElement(el).catch(() => {});
      }, 0);
    }
    function onPaste(event) {
      const active = document.activeElement; if (active && (active.matches('input,textarea') || active.getAttribute('contenteditable') === 'true')) return;
      const items = event.clipboardData && Array.from(event.clipboardData.items || []); const item = items && items.find((entry) => String(entry.type || '').startsWith('image/'));
      if (!item) return; const file = item.getAsFile && item.getAsFile(); if (!file) return;
      const target = stateFor(activeSheetId) ? activeSheetId : (stateFor('sheet_references_main') ? 'sheet_references_main' : null); if (!target) return;
      event.preventDefault(); addFile(target, file).catch(() => {});
    }
    function onRevision(event) { const revision = event && event.detail && event.detail.revision; if (revision) setRevision(revision); }
    function start() {
      if (!document || !api) return null;
      ensureInput(); observer = new root.MutationObserver(scan); observer.observe(document.body, { childList: true, subtree: true });
      root.addEventListener('paste', onPaste); root.addEventListener('raindesk:sheet-revision', onRevision); scan(); return api;
    }
    function destroy() {
      if (observer) observer.disconnect(); clearTimeout(scanTimer);
      if (root) { root.removeEventListener('paste', onPaste); root.removeEventListener('raindesk:sheet-revision', onRevision); }
      if (input && input.remove) input.remove();
    }
    return { start, destroy, scan, load, addFile, saveDocument, stateFor };
  }

  function autoStart(root, api) {
    if (root.__raindeskReferenceBoard) return root.__raindeskReferenceBoard;
    const board = ReferenceBoard({ root, document: root.document, api }); board.start(); root.__raindeskReferenceBoard = board; return board;
  }

  return { MAX_IMPORT_DIM, clone, fitImageCard, mediaCss, imageFileToPng, ReferenceBoard, autoStart };
});
