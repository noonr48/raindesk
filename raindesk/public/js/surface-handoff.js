/* Raindesk Surface Hand-off v2 — approved Partner requests retain exact authority. */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else {
    root.RaindeskSurfaceHandoff = mod;
    if (root.document && root.RaindeskChat) mod.install(root);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function text(value, max = 256) {
    const out = value == null ? '' : String(value).trim();
    return out.length > max ? out.slice(0, max) : out;
  }

  function currentShotId(document) {
    const published = document && document.documentElement && document.documentElement.dataset
      ? text(document.documentElement.dataset.raindeskShotId, 96) : '';
    if (published) return published;
    const title = document && document.getElementById ? document.getElementById('shotTitle') : null;
    return text(title && title.textContent, 256).split('·')[0].trim() || null;
  }

  function isSupportedRequest(request) {
    return Boolean(request && request.schemaVersion === 1 &&
      request.adapterId === 'bounded_image_region_v1' &&
      request.capabilityId === 'local_image_take' &&
      request.invocationBoundary === 'surface' &&
      request.status === 'awaiting_approval' &&
      request.disposition === 'proposal' &&
      request.reviewRequired === true &&
      request.creativeMutation === true);
  }

  function sameShot(request, document) {
    const expected = request && request.scope && text(request.scope.shotId, 96);
    const current = currentShotId(document);
    return !expected || !current ? false : expected === current;
  }

  function liveScope(root) {
    const seam = root && root.RaindeskSurfaceState;
    if (!seam || typeof seam.liveScope !== 'function') return null;
    try { return seam.liveScope(); } catch (_e) { return null; }
  }

  // Byte-parity mirror of lib/adapter-invocations.js stableSelection.
  function stableSelection(selection) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
    const out = { type: text(selection.type, 64) || 'selection' };
    if (selection.region && typeof selection.region === 'object') {
      const r = selection.region;
      out.region = ['x', 'y', 'w', 'h', 'width', 'height'].reduce((acc, key) => {
        if (Number.isFinite(Number(r[key]))) acc[key] = Math.round(Number(r[key]) * 1000) / 1000;
        return acc;
      }, {});
    }
    const points = Array.isArray(selection.lasso) ? selection.lasso : (Array.isArray(selection.points) ? selection.points : null);
    if (points) {
      out.points = points.slice(0, 96).map((point) => {
        if (Array.isArray(point)) return point.slice(0, 2).map((value) => Math.round(Number(value) * 1000) / 1000);
        if (point && typeof point === 'object') return {
          x: Math.round(Number(point.x) * 1000) / 1000,
          y: Math.round(Number(point.y) * 1000) / 1000,
        };
        return null;
      }).filter(Boolean);
    }
    if (selection.geometry && typeof selection.geometry === 'object') out.geometry = selection.geometry;
    return out;
  }

  /**
   * Approval scope is fail-closed. If a request froze a revision or selection,
   * the live surface must positively prove the same value. A missing seam is
   * not evidence of sameness and a fingerprint without its canonical frozen
   * selection cannot be reconstructed after reload.
   */
  function sameScope(request, root, document) {
    if (!sameShot(request, document)) return false;
    const scope = request && request.scope;
    if (!scope || typeof scope !== 'object') return false;
    const expectedRevision = text(scope.artRevisionId, 160) || null;
    const selectionFingerprint = text(scope.selectionFingerprint, 96) || null;
    const frozenSelection = scope.selectionStable && typeof scope.selectionStable === 'object'
      ? scope.selectionStable : null;
    if (selectionFingerprint && !frozenSelection) return false;
    const live = liveScope(root);
    if (expectedRevision) {
      const actualRevision = live && text(live.artRevisionId, 160);
      if (!actualRevision || expectedRevision !== actualRevision) return false;
    }
    if (frozenSelection) {
      if (!live || !live.selection) return false;
      const mirror = stableSelection(live.selection);
      if (!mirror || JSON.stringify(mirror) !== JSON.stringify(frozenSelection)) return false;
    }
    return true;
  }

  function createElement(document, tag, cls, copy) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (copy != null) node.textContent = copy;
    return node;
  }

  function approvalRecord(request) {
    if (!request || typeof request !== 'object') return null;
    const scope = request.scope && typeof request.scope === 'object' ? request.scope : null;
    return {
      id: request.id,
      requestId: request.id,
      turnId: request.turnId || null,
      shotId: scope && scope.shotId ? scope.shotId : null,
      adapterId: request.adapterId || null,
      capabilityId: request.capabilityId || null,
      stageId: request.stageId || null,
      recipeId: request.recipeId || null,
      invocationBoundary: request.invocationBoundary || null,
      disposition: request.disposition || null,
      reviewRequired: request.reviewRequired === true,
      creativeMutation: request.creativeMutation === true,
      scope,
      requiredEvidence: Array.isArray(request.requiredEvidence) ? request.requiredEvidence : [],
      requiredInputs: Array.isArray(request.requiredInputs) ? request.requiredInputs : [],
      expectedOutputs: Array.isArray(request.expectedOutputs) ? request.expectedOutputs : [],
      preserves: Array.isArray(request.preserves) ? request.preserves : [],
      sideEffects: Array.isArray(request.sideEffects) ? request.sideEffects : [],
      status: 'approved',
      supersede: true,
    };
  }

  function requestFromLedger(row) {
    if (!row || row.adapterId !== 'bounded_image_region_v1' || row.capabilityId !== 'local_image_take') return null;
    // Schema-v1 rows are still readable history, but without their original
    // frozen scope/flags we cannot lawfully recreate an approval after reload.
    if (!row.scope || row.reviewRequired !== true || row.creativeMutation !== true) return null;
    return {
      schemaVersion: 1,
      id: row.id,
      turnId: row.turnId || null,
      stageId: row.stageId || null,
      recipeId: row.recipeId || null,
      adapterId: row.adapterId,
      capabilityId: row.capabilityId,
      invocationBoundary: row.invocationBoundary || 'surface',
      status: 'awaiting_approval',
      disposition: row.disposition || 'proposal',
      reviewRequired: true,
      creativeMutation: true,
      scope: row.scope,
      requiredEvidence: Array.isArray(row.requiredEvidence) ? row.requiredEvidence : [],
      requiredInputs: Array.isArray(row.requiredInputs) ? row.requiredInputs : [],
      expectedOutputs: Array.isArray(row.expectedOutputs) ? row.expectedOutputs : [],
      preserves: Array.isArray(row.preserves) ? row.preserves : [],
      sideEffects: Array.isArray(row.sideEffects) ? row.sideEffects : [],
    };
  }

  function SurfaceHandoff({ root, document } = {}) {
    const host = root;
    let pending = null;

    function clearPrepared() {
      const wrap = document && document.querySelector && document.querySelector('.genbar-wrap');
      if (wrap) {
        wrap.classList.remove('surface-handoff-ready');
        delete wrap.dataset.invocationId;
      }
      pending = null;
    }

    function recordApproval(request) {
      if (!root || !root.fetch || !request) return;
      const body = approvalRecord(request);
      if (!body) return;
      root.fetch('/api/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => { /* approval remains valid in-page if persistence is down */ });
    }

    function markHandedOff(invocationId) {
      if (!root || !root.fetch || !invocationId) return;
      root.fetch('/api/invocations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invocationId, status: 'handed_off' }),
      }).catch(() => { /* ledger can catch up later */ });
    }

    function restorePendingApproval() {
      if (!root || !root.fetch || !document) return;
      root.fetch('/api/invocations?status=approved').then((res) => res.ok ? res.json() : null)
        .then((body) => {
          const rows = body && Array.isArray(body.invocations) ? body.invocations : [];
          const shotId = currentShotId(document);
          const match = rows.find((row) => row && row.shotId === shotId && requestFromLedger(row));
          if (!match) return;
          const restoredRequest = requestFromLedger(match);
          if (!restoredRequest) return;
          const list = document.querySelector && document.querySelector('.chat-list');
          if (!list || list.querySelector('.surface-handoff-proposal')) return;
          const row = createElement(document, 'div', 'surface-handoff-proposal');
          row.dataset.invocationId = match.id;
          row.appendChild(createElement(document, 'span', 'surface-handoff-copy', 'you approved a local edit here before the reload — set it up again?'));
          const approve = createElement(document, 'button', 'surface-handoff-btn', 'set up GEN');
          approve.type = 'button';
          const decline = createElement(document, 'button', 'surface-handoff-btn quiet', 'not now');
          decline.type = 'button';
          approve.addEventListener('click', () => prepare(restoredRequest, row));
          decline.addEventListener('click', () => {
            row.remove();
            markHandedOff(match.id);
          });
          row.append(approve, decline);
          list.appendChild(row);
        })
        .catch(() => { /* offline/down ledger: no restore, no error */ });
    }

    function prepare(request, row) {
      if (!isSupportedRequest(request)) return false;
      if (!sameScope(request, root, document)) {
        row.classList.add('stale');
        row.innerHTML = '';
        row.appendChild(createElement(document, 'span', 'surface-handoff-copy', 'that approval no longer matches this exact edit — ask me again here'));
        return false;
      }
      const wrap = document.querySelector('.genbar-wrap');
      const prompt = document.getElementById('prompt');
      const gen = document.getElementById('genBtn');
      if (!wrap || !prompt || !gen) return false;
      clearPrepared();
      pending = request;
      recordApproval(request);
      wrap.classList.add('surface-handoff-ready');
      wrap.dataset.invocationId = request.id;
      if (!prompt.value.trim()) prompt.placeholder = 'describe this approved local change, then press GEN';
      if (typeof wrap.scrollIntoView === 'function') wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (typeof prompt.focus === 'function') prompt.focus();
      row.classList.add('prepared');
      row.innerHTML = '';
      row.appendChild(createElement(document, 'span', 'surface-handoff-copy', 'GEN is set up below — check the lasso, then press GEN when you want the take'));
      if (root && typeof root.CustomEvent === 'function' && typeof root.dispatchEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent('raindesk:surface-handoff-ready', { detail: { request } }));
      }
      return true;
    }

    function renderRequest(request) {
      if (!isSupportedRequest(request) || !document) return null;
      const list = host && host.querySelector ? host.querySelector('.chat-list') : null;
      if (!list) return null;
      list.querySelectorAll('.surface-handoff-proposal').forEach((node) => node.remove());
      const row = createElement(document, 'div', 'surface-handoff-proposal');
      row.dataset.invocationId = request.id;
      row.appendChild(createElement(document, 'span', 'surface-handoff-copy', 'I can set up the selected local edit in the existing GEN bar.'));
      const approve = createElement(document, 'button', 'surface-handoff-btn', 'set up GEN');
      approve.type = 'button';
      const decline = createElement(document, 'button', 'surface-handoff-btn quiet', 'not now');
      decline.type = 'button';
      approve.addEventListener('click', () => prepare(request, row));
      decline.addEventListener('click', () => row.remove());
      row.append(approve, decline);
      list.appendChild(row);
      list.scrollTop = list.scrollHeight;
      return row;
    }

    function handleTurn(response) {
      clearPrepared();
      const requests = response && Array.isArray(response.invocationRequests) ? response.invocationRequests : [];
      const request = requests.find(isSupportedRequest);
      return request ? renderRequest(request) : null;
    }

    if (document && document.addEventListener) {
      document.addEventListener('click', (event) => {
        if (event.target && event.target.id === 'genBtn') {
          if (pending) markHandedOff(pending.id);
          clearPrepared();
        }
      }, true);
    }
    if (root && root.addEventListener) root.addEventListener('raindesk:shot-change', clearPrepared);
    if (document) {
      try { restorePendingApproval(); } catch (_e) { /* restore is best-effort */ }
    }

    return { handleTurn, renderRequest, prepare, clearPrepared, pending: () => pending };
  }

  function install(root) {
    const chat = root && root.RaindeskChat;
    if (!chat || typeof chat.ChatDrawer !== 'function' || chat.__surfaceHandoffInstalled) return false;
    const Original = chat.ChatDrawer;
    chat.ChatDrawer = function patchedChatDrawer(drawerRoot, opts) {
      const drawer = Original(drawerRoot, opts);
      const controller = SurfaceHandoff({ root, document: root.document });
      if (drawer && typeof drawer.on === 'function') drawer.on('turn', (response) => controller.handleTurn(response));
      if (drawer) drawer.surfaceHandoff = controller;
      return drawer;
    };
    chat.__surfaceHandoffInstalled = true;
    return true;
  }

  return {
    currentShotId, isSupportedRequest, sameShot, sameScope, stableSelection,
    approvalRecord, requestFromLedger, SurfaceHandoff, install,
  };
});
