/* Raindesk Surface Hand-off v1 — approved Partner requests prepare existing UI only. */
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

  // Live-surface fingerprints: the request froze approval-time creative scope;
  // preparing must refuse when the surface has since changed (criterion 6 —
  // stale revision or selection fails closed instead of silently editing new state).
  // The live values come from app.js's own partner context via a single seam:
  // window.RaindeskSurfaceState.liveScope() (installed by app.js at boot) —
  // never a parallel copy of app state here.
  function liveScope(root) {
    const seam = root && root.RaindeskSurfaceState;
    if (!seam || typeof seam.liveScope !== 'function') return null;
    try { return seam.liveScope(); } catch (_e) { return null; }
  }

  // Byte-parity mirror of the server's stableSelection (lib/adapter-invocations.js):
  // identical field order (type, region, points, geometry) so frozen canonical
  // forms compare structurally — JSON.stringify equality across both sides.
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

  // Structural comparison against the frozen canonical form (scope.selectionStable).
  // No digests: plain http means no SubtleCrypto on the client, so hash equality
  // across contexts is unprovable — comparing the bounded canonical form is exact.
  function sameScope(request, root, document) {
    if (!sameShot(request, document)) return false;
    const scope = request && request.scope;
    if (!scope) return false;
    const expectedRevision = text(scope.artRevisionId, 160) || null;
    const frozenSelection = scope.selectionStable && typeof scope.selectionStable === 'object'
      ? scope.selectionStable : null;
    const live = liveScope(root);
    if (expectedRevision && live && live.artRevisionId && expectedRevision !== live.artRevisionId) return false;
    if (frozenSelection && live && live.selection) {
      const mirror = stableSelection(live.selection);
      if (mirror && JSON.stringify(mirror) !== JSON.stringify(frozenSelection)) return false;
    }
    return true;
  }

  function createElement(document, tag, cls, copy) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (copy != null) node.textContent = copy;
    return node;
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

    // Durable approval ledger (server: /api/invocations). Approval records a
  // proposal durably so a reload can restore it; a GEN click marks handed_off;
  // failures never block the artist (ledger is persistence, not permission).
  function recordApproval(root, request) {
    if (!root || !root.fetch || !request) return;
    const scope = request.scope || {};
    root.fetch('/api/invocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: request.id, requestId: request.id, turnId: request.turnId || null,
        shotId: scope.shotId || null, adapterId: request.adapterId || null,
        capabilityId: request.capabilityId || null, status: 'approved', supersede: true,
        requestId_: undefined,
      }),
    }).catch(() => { /* approval is still valid in-page if the ledger is down */ });
  }

  function markHandedOff(root, invocationId) {
    if (!root || !root.fetch || !invocationId) return;
    root.fetch('/api/invocations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: invocationId, status: 'handed_off' }),
    }).catch(() => { /* the artist pressed GEN; the ledger catches up or the entry stays approved */ });
  }

  function restorePendingApproval(root, document) {
    if (!root || !root.fetch || !document) return;
    root.fetch('/api/invocations?status=approved').then((res) => res.ok ? res.json() : null)
      .then((body) => {
        const rows = body && Array.isArray(body.invocations) ? body.invocations : [];
        const shotId = currentShotId(document);
        const match = rows.find((row) => row && row.shotId && row.shotId === shotId && row.adapterId === 'bounded_image_region_v1');
        if (!match) return;
        // Only restore as an in-page chip; the artist re-approves by pressing set up GEN again.
        const list = document.querySelector && document.querySelector('.chat-list');
        if (!list || list.querySelector('.surface-handoff-proposal')) return;
        const row = createElement(document, 'div', 'surface-handoff-proposal');
        row.dataset.invocationId = match.id;
        row.appendChild(createElement(document, 'span', 'surface-handoff-copy', 'you approved a local edit here before the reload — set it up again?'));
        const approve = createElement(document, 'button', 'surface-handoff-btn', 'set up GEN');
        approve.type = 'button';
        const decline = createElement(document, 'button', 'surface-handoff-btn quiet', 'not now');
        decline.type = 'button';
        approve.addEventListener('click', () => {
          const request = {
            schemaVersion: 1, id: match.id, turnId: match.turnId,
            adapterId: 'bounded_image_region_v1', capabilityId: 'local_image_take',
            invocationBoundary: 'surface', status: 'awaiting_approval', disposition: 'proposal',
            reviewRequired: true, creativeMutation: true, scope: { shotId: match.shotId },
          };
          prepare(request, row);
        });
        decline.addEventListener('click', () => {
          row.remove();
          markHandedOff(root, match.id);
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
        row.appendChild(createElement(document, 'span', 'surface-handoff-copy', 'that request belongs to another shot — ask me again here'));
        return false;
      }
      const wrap = document.querySelector('.genbar-wrap');
      const prompt = document.getElementById('prompt');
      const gen = document.getElementById('genBtn');
      if (!wrap || !prompt || !gen) return false;
      clearPrepared();
      pending = request;
      recordApproval(root, request);
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
          if (pending) markHandedOff(root, pending.id);
          clearPrepared();
        }
      }, true);
    }
    if (root && root.addEventListener) {
      root.addEventListener('raindesk:shot-change', clearPrepared);
    }
    if (document) {
      try { restorePendingApproval(root, document); } catch (_e) { /* restore is best-effort */ }
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

  return { currentShotId, isSupportedRequest, sameShot, sameScope, stableSelection, SurfaceHandoff, install };
});
