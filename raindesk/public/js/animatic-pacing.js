/* Reviewer-first pacing offers inside the Partner conversation. */
(function (root, factory) {
  const mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else {
    root.RaindeskAnimaticPacing = mod;
    if (root.document && root.RaindeskChat) mod.install(root);
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function el(document, tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function currentShotId(windowRoot, document) {
    const state = windowRoot && windowRoot.RaindeskSurfaceState;
    if (state && typeof state.liveScope === 'function') {
      try {
        const live = state.liveScope();
        if (live && live.shotId) return String(live.shotId).trim() || null;
      } catch (_e) { /* fall through */ }
    }
    const published = document && document.documentElement && document.documentElement.dataset
      ? String(document.documentElement.dataset.raindeskShotId || '').trim() : '';
    if (published) return published;
    const title = document && document.getElementById ? document.getElementById('shotTitle') : null;
    const copy = String(title && title.textContent || '').trim();
    const candidate = copy ? copy.split('·')[0].trim() : '';
    return candidate && candidate !== 'raindesk' ? candidate : null;
  }

  function seconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return number < 1 ? `${number.toFixed(2)} s` : `${number.toFixed(1)} s`;
  }

  function rhythmLabel(proposal) {
    const shots = proposal && Array.isArray(proposal.shots) ? proposal.shots : [];
    return shots.slice(0, 8).map((shot) => {
      const name = String(shot && (shot.note || shot.shotId) || 'beat').trim();
      const duration = seconds(shot && shot.durationSeconds);
      return duration ? `${name} ${duration}` : name;
    }).filter(Boolean).join(' → ');
  }

  function PacingOffers({ root: windowRoot, document, api, drawer, chatList } = {}) {
    let busy = false;
    let lastShotId = null;

    function removeOffers() {
      if (!chatList || !chatList.querySelectorAll) return;
      chatList.querySelectorAll('.animatic-pacing-offers').forEach((node) => node.remove());
    }

    async function previewProposal(proposal, button, status) {
      if (busy || !proposal || !proposal.proposalDigest || !api || typeof api.previewAnimatic !== 'function') return;
      busy = true;
      button.disabled = true;
      status.textContent = 'building rough cut…';
      try {
        const response = await api.previewAnimatic(proposal.proposalDigest);
        const candidate = response && response.candidate;
        if (!candidate) {
          // Async preview: the render continues in the background. Poll the
          // durable execution until a terminal state, with bounded backoff.
          await pollExecution(proposal, button, status, response && response.execution && response.execution.executionId);
          return;
        }
        status.textContent = 'rough cut ready';
        if (drawer && typeof drawer.addPartnerNote === 'function') {
          drawer.addPartnerNote('The rough cut is ready in Takes — react to the rhythm, not the polish.');
        }
        if (drawer && typeof drawer.open === 'function') drawer.open('gens');
        if (drawer && drawer.animaticTakes && typeof drawer.animaticTakes.render === 'function') {
          await drawer.animaticTakes.render();
        }
      } catch (error) {
        status.textContent = error && error.friendly ? error.friendly : 'preview could not be built — ask me for a fresh rhythm';
        button.disabled = false;
      } finally {
        busy = false;
      }
    }

    async function pollExecution(proposal, button, status, executionId) {
      const phaseLabel = (state) => ({
        running: 'building rough cut…', succeeded: 'rough cut ready',
        failed: 'preview could not be built — ask me for a fresh rhythm',
        interrupted: 'preview was interrupted — try again',
      }[state] || 'building rough cut…');
      // Poll the durable execution: by id when we started it, by proposal
      // digest otherwise (reload reconnect). Bounded backoff, stop when the
      // surface is gone.
      const started = Date.now();
      let delay = 400;
      for (;;) {
        if (!document.body || !document.body.contains(status)) return; // surface gone
        let response;
        try {
          response = (executionId && api.getAnimaticExecution)
            ? await api.getAnimaticExecution(executionId)
            : (api.getAnimaticPacingExecution ? await api.getAnimaticPacingExecution(proposal.proposalDigest) : null);
        } catch (_error) { response = null; }
        const execution = response && response.execution;
        const state = execution && execution.status;
        if (state === 'succeeded' && response.candidate) {
          if (!document.body || !document.body.contains(status)) return; // surface gone mid-fetch
          status.textContent = 'rough cut ready';
          if (drawer && typeof drawer.addPartnerNote === 'function') {
            drawer.addPartnerNote('The rough cut is ready in Takes — react to the rhythm, not the polish.');
          }
          if (drawer && typeof drawer.open === 'function') drawer.open('gens');
          if (drawer && drawer.animaticTakes && typeof drawer.animaticTakes.render === 'function') {
            await drawer.animaticTakes.render();
          }
          return;
        }
        if (state === 'failed' || state === 'interrupted') {
          status.textContent = phaseLabel(state);
          button.disabled = false; // retry stays free, same snapshot
          return;
        }
        status.textContent = phaseLabel(state || 'running');
        if (Date.now() - started > 30 * 60 * 1000) { // bounded: max render window
          status.textContent = 'still rendering — check Takes in a moment';
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(2500, Math.round(delay * 1.5));
      }
    }

    async function reconnect(proposal, button, status) {
      // Reload reconnect: surface the durable state of an already-running or
      // finished render without starting anything new.
      if (!api || typeof api.getAnimaticPacingExecution !== 'function') return;
      let response;
      try { response = await api.getAnimaticPacingExecution(proposal.proposalDigest); } catch (_error) { return; }
      const execution = response && response.execution;
      if (!execution || !status) return;
      if (execution.status === 'running') {
        status.textContent = 'building rough cut…';
        button.disabled = true;
        await pollExecution(proposal, button, status, null);
      } else if (execution.status === 'succeeded' && response.candidate) {
        status.textContent = 'rough cut ready';
      }
    }

    function render(proposals, { replace = true } = {}) {
      if (!chatList || !Array.isArray(proposals) || !proposals.length) return null;
      if (replace) removeOffers();
      const wrap = el(document, 'section', 'animatic-pacing-offers');
      wrap.setAttribute('aria-label', 'pacing ideas');
      wrap.appendChild(el(document, 'div', 'animatic-pacing-kicker', 'rough pacing ideas'));

      for (const proposal of proposals.slice(0, 6)) {
        if (!proposal || !proposal.proposalDigest) continue;
        const card = el(document, 'article', `animatic-pacing-card${proposal.stale ? ' stale' : ''}`);
        card.appendChild(el(document, 'strong', 'animatic-pacing-title', proposal.label || 'Pacing idea'));
        const rhythm = rhythmLabel(proposal);
        if (rhythm) card.appendChild(el(document, 'div', 'animatic-pacing-rhythm', rhythm));
        if (proposal.rationale) card.appendChild(el(document, 'div', 'animatic-pacing-rationale', proposal.rationale));
        const controls = el(document, 'div', 'animatic-pacing-controls');
        const status = el(document, 'span', 'animatic-pacing-status', proposal.stale ? 'source changed — ask for a fresh rhythm' : '');
        const preview = el(document, 'button', 'animatic-preview-btn', 'Preview this');
        preview.type = 'button';
        preview.disabled = Boolean(proposal.stale);
        if (!proposal.stale) preview.addEventListener('click', () => previewProposal(proposal, preview, status));
        controls.append(preview, status);
        card.appendChild(controls);
        // After a reload, a render may already be running or finished: surface
        // its durable state without starting anything new.
        if (!proposal.stale && typeof reconnect === 'function') setTimeout(() => reconnect(proposal, preview, status), 0);
        wrap.appendChild(card);
      }
      if (wrap.childNodes.length <= 1) return null;
      chatList.appendChild(wrap);
      chatList.scrollTop = chatList.scrollHeight;
      return wrap;
    }

    async function restore() {
      if (!api || typeof api.listAnimaticPacingProposals !== 'function') return;
      const shotId = currentShotId(windowRoot, document);
      if (!shotId) return;
      lastShotId = shotId;
      try {
        const response = await api.listAnimaticPacingProposals({ shotId, limit: 12 });
        const rows = response && Array.isArray(response.proposals) ? response.proposals : [];
        if (!rows.length) return;
        render(rows.slice(-6), { replace: true });
      } catch (_error) { /* restoring optional creative suggestions must stay quiet */ }
    }

    function handleTurn(response) {
      const rows = response && Array.isArray(response.animaticPacingProposals) ? response.animaticPacingProposals : [];
      if (rows.length) render(rows, { replace: true });
    }

    if (windowRoot && windowRoot.addEventListener) {
      windowRoot.addEventListener('raindesk:shot-change', () => {
        const next = currentShotId(windowRoot, document);
        if (next === lastShotId) return;
        removeOffers();
        lastShotId = next;
        // Initial desktop workspace opening can precede shot-title publication.
        // The shot-context bridge is the authoritative signal that a concrete
        // shot is now visible, so rehydrate its persisted pacing suggestions.
        if (next) setTimeout(() => restore(), 0);
      });
    }

    return { render, restore, handleTurn, removeOffers, previewProposal, rhythmLabel: (proposal) => rhythmLabel(proposal) };
  }

  function install(windowRoot) {
    const chat = windowRoot && windowRoot.RaindeskChat;
    if (!chat || typeof chat.ChatDrawer !== 'function' || chat.__animaticPacingInstalled) return false;
    const Original = chat.ChatDrawer;
    chat.ChatDrawer = function patchedChatDrawer(drawerRoot, opts) {
      const drawer = Original(drawerRoot, opts);
      const document = windowRoot.document;
      const chatList = drawerRoot && drawerRoot.querySelector ? drawerRoot.querySelector('.chat-list') : null;
      const controller = PacingOffers({ root: windowRoot, document, api: opts && opts.api || windowRoot.RaindeskAPI, drawer, chatList });
      if (drawer && typeof drawer.on === 'function') {
        drawer.on('turn', (response) => controller.handleTurn(response));
        drawer.on('open', () => controller.restore());
      }
      const partnerTab = drawerRoot && drawerRoot.querySelector ? drawerRoot.querySelector('[data-tab="agent"]') : null;
      if (partnerTab) partnerTab.addEventListener('click', () => setTimeout(() => controller.restore(), 0));
      if (drawer) drawer.animaticPacing = controller;
      return drawer;
    };
    chat.__animaticPacingInstalled = true;
    return true;
  }

  return { PacingOffers, install, currentShotId, seconds, rhythmLabel };
});
