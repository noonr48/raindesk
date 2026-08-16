/*
 * Raindesk Partner drawer — casual co-creation chat + take history (localStorage).
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
    const contextProvider = typeof opts.contextProvider === 'function' ? opts.contextProvider : null;
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
    const tabAgent = el('div', 'dtab', 'partner');
    const tabGens = el('div', 'dtab', 'takes');
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
    input.placeholder = "tell me what you\'re seeing…";
    input.setAttribute('aria-label', 'message the agent');
    const send = el('button', 'composer-send', '➤');
    send.setAttribute('aria-label', 'send');
    composer.append(input, send);

    panel.append(tabs, chatList, gensList, typing, composer);
    chatList.appendChild(el('div', 'bubble agent',
      "i'm here. tell me what you're trying to make — half-formed is fine. if you're stuck, we can start tiny."));
    const startRow = el('div', 'partner-start');
    const startBtn = el('button', 'partner-start-btn', 'give me a starting point');
    startBtn.type = 'button';
    startRow.appendChild(startBtn);
    chatList.appendChild(startRow);

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

    function addPartnerNote(text, moves) {
      if (typeof text === 'string' && text.trim()) addBubble('agent', text.trim());
      if (Array.isArray(moves) && moves.length) addMoves(moves);
    }

    function clearMoves() {
      chatList.querySelectorAll('.partner-moves').forEach((n) => n.remove());
    }

    function partnerContext() {
      const base = {
        legacyShotId: shotLabel(),
        surface: 'storyboard_canvas',
      };
      if (!contextProvider) return base;
      try {
        const extra = contextProvider();
        return extra && typeof extra === 'object' ? { ...base, ...extra } : base;
      } catch (_e) { return base; }
    }

    function addMoves(moves) {
      clearMoves();
      if (!Array.isArray(moves) || !moves.length) return;
      const wrap = el('div', 'partner-moves');
      for (const move of moves.slice(0, 3)) {
        if (!move || !move.label) continue;
        const btn = el('button', 'partner-move', move.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          if (busy) return;
          input.value = move.prompt || move.label;
          submit();
        });
        wrap.appendChild(btn);
      }
      if (wrap.childNodes.length) chatList.appendChild(wrap);
      chatList.scrollTop = chatList.scrollHeight;
    }

    async function runPartner(message, mode = null) {
      if (busy) return;
      busy = true;
      typing.classList.add('on');
      clearMoves();
      let response = null;
      try {
        if (api.partnerTurn) {
          response = await api.partnerTurn(message, { mode, context: partnerContext() });
        } else {
          const legacy = await api.sendChat(message || 'give me a starting point');
          response = { message: legacy && legacy.reply };
        }
      } catch (_e) {
        response = { message: CHAT_FALLBACK };
      } finally {
        typing.classList.remove('on');
        busy = false;
      }
      const reply = response && typeof response.message === 'string' && response.message.trim()
        ? response.message.trim() : CHAT_FALLBACK;
      addBubble('agent', reply);
      addMoves(response && response.nextMoves);
    }

    async function submit() {
      const text = input.value.trim();
      if (!text || busy) return;
      input.value = '';
      addBubble('user', text);
      await runPartner(text);
    }

    async function requestKickstart() {
      if (busy) return;
      startRow.remove();
      await runPartner('', 'kickstart');
    }

    startBtn.addEventListener('click', requestKickstart);
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
        meta.appendChild(el('div', 'gen-shot', `${g.shotLabel || g.shotId || 'shot'} µ take ${g.takeCount || 1}`));
        meta.appendChild(el('div', 'gen-prompt', g.prompt || ''));
        meta.appendChild(el('div', 'gen-time', `${timeLabel(g.ts)}${g.committed ? ' µ committed ✅' : ''}`));
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
      recordGen, markCommitted, addPartnerNote,
      on: (evt, fn) => { if (listeners[evt]) listeners[evt].push(fn); },
    };
  }

  return { ChatDrawer, STORE_KEY, loadGens, saveGens };
});
