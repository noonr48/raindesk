/*
 * Raindesk drawer chat — agent bubbles + "my gens" history (localStorage).
 * Standalone module: builds its DOM inside a provided root element, talks to
 * the backend ONLY through the injected api object (public/js/api.js), so it
 * can be dropped into any container (overlay drawer <1024px, docked rail ≥1024px).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.RaindeskChat = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORE_KEY = 'raindesk.gens.v1';
  const MAX_GENS = 200;
  const CHAT_FALLBACK = 'still here with you — the line dropped for a second 🌧️ give it another go?';

  function loadGens() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (_e) { return []; }
  }
  function saveGens(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_GENS))); } catch (_e) { /* private mode */ }
  }
  function timeLabel(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * ChatDrawer(root, { api, shotLabel })
   *   .open('agent'|'gens')  .close()  .isOpen()
   *   .recordGen({ shotId, prompt, takeCount, imageUrl })
   */
  function ChatDrawer(root, opts) {
    const api = opts.api;
    const shotLabel = opts.shotLabel || (() => 'shot');
    const listeners = { open: [], close: [] };
    let tab = 'agent';
    let busy = false;

    root.classList.add('chat-drawer');
    root.innerHTML = '';

    const scrim = el('div', 'chat-scrim');
    const panel = el('div', 'chat-panel');
    root.appendChild(scrim);
    root.appendChild(panel);

    const tabs = el('div', 'chat-tabs');
    const tabAgent = el('div', 'dtab', '💬 agent');
    const tabGens = el('div', 'dtab', '⚡ my gens');
    tabAgent.dataset.tab = 'agent';
    tabGens.dataset.tab = 'gens';
    tabs.append(tabAgent, tabGens);

    const closeBtn = el('button', 'chat-close', '✕');
    closeBtn.setAttribute('aria-label', 'close drawer');
    tabs.appendChild(closeBtn);

    const chatList = el('div', 'chat-list');
    const gensList = el('div', 'gens-list');

    const typing = el('div', 'typing');
    typing.appendChild(el('i'));
    typing.appendChild(el('i'));
    typing.appendChild(el('i'));

    const composer = el('div', 'composer');
    const input = el('input', 'composer-input');
    input.type = 'text';
    input.placeholder = 'talk through the shot…';
    input.setAttribute('aria-label', 'message the agent');
    const send = el('button', 'composer-send', '➤');
    send.setAttribute('aria-label', 'send');
    composer.append(input, send);

    panel.append(tabs, chatList, gensList, typing, composer);
    chatList.appendChild(el('div', 'bubble agent',
      "i'm here when you want a second pair of eyes 🌧️ draw over the frame, lasso what feels off, or just tell me what you're reaching for"));

    function isOpen() { return root.classList.contains('open'); }
    function open(which) {
      tab = which === 'gens' ? 'gens' : 'agent';
      root.classList.add('open');
      sync();
      listeners.open.forEach((f) => f());
    }
    function close() {
      root.classList.remove('open');
      listeners.close.forEach((f) => f());
    }
    scrim.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    tabAgent.addEventListener('click', () => { tab = 'agent'; sync(); });
    tabGens.addEventListener('click', () => { tab = 'gens'; sync(); });

    function sync() {
      tabAgent.classList.toggle('active', tab === 'agent');
      tabGens.classList.toggle('active', tab === 'gens');
      chatList.style.display = tab === 'agent' ? 'flex' : 'none';
      gensList.style.display = tab === 'gens' ? 'flex' : 'none';
      if (tab === 'gens') renderGens();
    }

    function addBubble(who, text) {
      const b = el('div', `bubble ${who}`, text);
      chatList.appendChild(b);
      chatList.scrollTop = chatList.scrollHeight;
      return b;
    }

    async function submit() {
      const text = input.value.trim();
      if (!text || busy) return;
      input.value = '';
      addBubble('user', text);
      busy = true;
      typing.classList.add('on');
      let reply;
      try {
        const res = await api.sendChat(text);
        reply = (res && typeof res.reply === 'string' && res.reply.trim())
          ? res.reply.trim() : CHAT_FALLBACK;
      } catch (_e) {
        reply = CHAT_FALLBACK;
      }
      typing.classList.remove('on');
      busy = false;
      addBubble('agent', reply);
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    /* ------------------------------------------------- my gens history */

    function renderGens() {
      gensList.innerHTML = '';
      const gens = loadGens();
      if (!gens.length) {
        gensList.appendChild(el('div', 'gens-empty',
          'nothing here yet ⚡\u00A0— every GEN you run lands in this list with its prompt'));
        return;
      }
      for (const g of gens) {
        const row = el('div', 'gen-row');
        const meta = el('div', 'gen-meta');
        meta.appendChild(el('div', 'gen-shot', `${g.shotLabel || g.shotId || 'shot'} · take ${g.takeCount || 1}`));
        meta.appendChild(el('div', 'gen-prompt', g.prompt || ''));
        meta.appendChild(el('div', 'gen-time', `${timeLabel(g.ts)}${g.committed ? ' · committed ✅' : ''}`));
        row.appendChild(meta);
        if (g.imageUrl) {
          const img = el('img', 'gen-thumb');
          img.loading = 'lazy';
          img.alt = 'generated take';
          img.src = g.imageUrl;
          img.addEventListener('error', () => { img.remove(); });
          row.appendChild(img);
        }
        gensList.appendChild(row);
      }
    }

    function recordGen(entry) {
      const gens = loadGens();
      gens.unshift({
        ts: Date.now(),
        shotId: entry.shotId,
        shotLabel: entry.shotLabel || null,
        prompt: entry.prompt || '',
        takeCount: entry.takeCount || 1,
        committed: Boolean(entry.committed),
        imageUrl: entry.imageUrl || null,
      });
      saveGens(gens);
      if (tab === 'gens' && isOpen()) renderGens();
    }

    function markCommitted(shotId) {
      const gens = loadGens();
      for (const g of gens) {
        if (g.committed) break;
        if (g.shotId === shotId) { g.committed = true; }
      }
      saveGens(gens);
      if (tab === 'gens' && isOpen()) renderGens();
    }

    sync();
    return {
      open, close, isOpen,
      recordGen, markCommitted,
      on: (evt, fn) => { if (listeners[evt]) listeners[evt].push(fn); },
    };
  }

  return { ChatDrawer, STORE_KEY, loadGens, saveGens };
});
