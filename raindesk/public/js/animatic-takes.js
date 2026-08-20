/* Reviewer-first Animatic Takes inside the existing Takes drawer. */
(function (root, factory) {
  const mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else {
    root.RaindeskAnimaticTakes = mod;
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

  function candidateId(record) {
    return record && record.candidate && record.candidate.candidate_id || null;
  }

  function durationLabel(record) {
    const media = record && record.candidate && record.candidate.media;
    const duration = media && media.duration;
    if (duration && Number.isFinite(Number(duration.num)) && Number.isFinite(Number(duration.den)) && Number(duration.den) !== 0) {
      return `${(Number(duration.num) / Number(duration.den)).toFixed(1)} s`;
    }
    return 'rough preview';
  }

  function decisionLabel(record) {
    const review = record && record.review;
    if (review && review.isCurrentKeep) return 'kept';
    const latest = review && review.latestDecision;
    if (!latest) return 'candidate';
    if (latest.decision === 'another') return 'another requested';
    return latest.decision;
  }

  function makeIdempotencyKey(candidate, decision) {
    const cryptoObj = root && root.crypto;
    const nonce = cryptoObj && typeof cryptoObj.randomUUID === 'function'
      ? cryptoObj.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `animatic:${candidate}:${decision}:${nonce}`.slice(0, 160);
  }

  function AnimaticTakes({ root: windowRoot, document, api, drawer, gensList, host } = {}) {
    // The drawer builds one stable host per surface (chat.js owns the DOM):
    // animatic takes render only into their host, image takes only into
    // theirs. No component repairs another component's subtree.
    const section = host
      || (gensList && gensList.querySelector ? gensList.querySelector('.animatic-takes-host') : null)
      || el(document, 'section', 'animatic-takes-section');
    try { section.setAttribute('aria-label', 'animatic takes'); } catch (_e) {}
    const reviewKeys = new Map();
    let renderEpoch = 0;
    let destroyed = false;

    function queueRender() {
      if (destroyed) return;
      setTimeout(() => { render().catch(() => {}); }, 0);
    }

    async function submitDecision(record, decision, button) {
      const id = candidateId(record);
      if (!id || !api || typeof api.reviewAnimaticCandidate !== 'function') return;
      if (decision === 'combine') return;
      const keyName = `${id}|${decision}`;
      if (!reviewKeys.has(keyName)) reviewKeys.set(keyName, makeIdempotencyKey(id, decision));
      button.disabled = true;
      try {
        await api.reviewAnimaticCandidate(id, decision, { idempotencyKey: reviewKeys.get(keyName) });
        reviewKeys.delete(keyName);
        if (decision === 'another' && drawer && typeof drawer.addPartnerNote === 'function') {
          drawer.addPartnerNote("I'll treat that as a request for a different rhythm — not a rerun of the same cut.");
        }
        await render();
      } catch (_error) {
        button.disabled = false;
      }
    }

    function renderCard(record) {
      const id = candidateId(record);
      const card = el(document, 'article', 'animatic-take-card');
      if (id) card.dataset.candidateId = id;

      const top = el(document, 'div', 'animatic-take-head');
      top.appendChild(el(document, 'strong', '', 'Animatic take'));
      top.appendChild(el(document, 'span', 'animatic-take-status', `${durationLabel(record)} · ${decisionLabel(record)}`));
      card.appendChild(top);

      const artifact = record && Array.isArray(record.artifacts) ? record.artifacts[0] : null;
      if (artifact && artifact.url) {
        const video = document.createElement('video');
        video.className = 'animatic-take-video';
        video.controls = true;
        video.preload = 'metadata';
        video.src = artifact.url;
        video.setAttribute('playsinline', '');
        card.appendChild(video);
      } else {
        card.appendChild(el(document, 'div', 'animatic-take-missing', 'preview media is not available'));
      }

      const actions = el(document, 'div', 'animatic-take-actions');
      for (const choice of [
        ['keep', 'Keep'], ['another', 'Another'], ['reject', 'Reject'], ['combine', 'Combine'],
      ]) {
        const button = el(document, 'button', `animatic-review-btn ${choice[0]}`, choice[1]);
        button.type = 'button';
        if (choice[0] === 'combine') {
          button.disabled = true;
          button.title = 'Combine needs candidate-bound review notes first';
          button.setAttribute('aria-label', 'Combine unavailable until review notes are pinned');
        } else {
          button.addEventListener('click', () => submitDecision(record, choice[0], button));
        }
        actions.appendChild(button);
      }
      card.appendChild(actions);
      return card;
    }

    async function render() {
      if (destroyed || !api || typeof api.listAnimaticCandidates !== 'function') return;
      const epoch = ++renderEpoch;
      section.innerHTML = '';
      section.appendChild(el(document, 'div', 'animatic-takes-title', 'Animatic takes'));
      try {
        const response = await api.listAnimaticCandidates({ limit: 50 });
        if (destroyed || epoch !== renderEpoch) return; // superseded by a newer render
        const rows = response && Array.isArray(response.candidates) ? response.candidates.slice().reverse() : [];
        if (!rows.length) {
          section.appendChild(el(document, 'div', 'animatic-takes-empty', 'rough cuts will collect here when you preview a pacing idea'));
        } else {
          for (const record of rows) section.appendChild(renderCard(record));
        }
      } catch (_error) {
        if (epoch === renderEpoch) section.appendChild(el(document, 'div', 'animatic-takes-empty', 'animatic takes are temporarily unavailable'));
      }
    }

    // Lifecycle: the drawer broadcasts every tab activation on the 'tab'
    // channel. Rendering rides that single lifecycle surface — no tab-node
    // click hooks, no open() wrappers, no DOM-repair observers.
    if (drawer && typeof drawer.on === 'function') {
      drawer.on('tab', (activeTab) => {
        if (activeTab === 'gens') queueRender();
      });
    }
    return { section, render, renderCard, submitDecision, queueRender, destroy: () => { destroyed = true; } };
  }

  function install(windowRoot) {
    const chat = windowRoot && windowRoot.RaindeskChat;
    if (!chat || typeof chat.ChatDrawer !== 'function' || chat.__animaticTakesInstalled) return false;
    const Original = chat.ChatDrawer;
    chat.ChatDrawer = function patchedChatDrawer(drawerRoot, opts) {
      const drawer = Original(drawerRoot, opts);
      const document = windowRoot.document;
      const host = drawerRoot && drawerRoot.querySelector
        ? (drawerRoot.querySelector('.animatic-takes-host') || drawerRoot.querySelector('.animatic-takes-section'))
        : null;
      const controller = AnimaticTakes({ root: windowRoot, document, api: opts && opts.api || windowRoot.RaindeskAPI, drawer, host });
      if (drawer) drawer.animaticTakes = controller;
      return drawer;
    };
    chat.__animaticTakesInstalled = true;
    return true;
  }

  return { AnimaticTakes, install, candidateId, durationLabel, decisionLabel, makeIdempotencyKey };
});
