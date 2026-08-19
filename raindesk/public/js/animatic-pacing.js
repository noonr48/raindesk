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
    return copy ? copy.split('·')[0].trim() || null : null;
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
          status.textContent = response && response.execution && response.execution.status === 'running'
            ? 'rough cut is still rendering…' : 'preview started';
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
        if (next !== lastShotId) { removeOffers(); lastShotId = next; }
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
      if (drawer) drawer.animaticPacing = controller;
      return drawer;
    };
    chat.__animaticPacingInstalled = true;
    return true;
  }

  return { PacingOffers, install, currentShotId, seconds, rhythmLabel };
});
