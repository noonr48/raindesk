/*
 * Raindesk Beat Trail - a lightweight, hideable view of the current shot's
 * micro-actions. It is deliberately not an animation timeline or inspector:
 * the artist speaks/draws naturally; the Partner captures structure underneath.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.RaindeskBeats = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function text(v) { return typeof v === 'string' ? v.trim() : ''; }

  function beatLine(beat) {
    if (!beat || typeof beat !== 'object') return '';
    return text(beat.rawDirection) || text(beat.description) ||
      text(beat.movement && beat.movement.action) || 'untitled beat';
  }

  function beatMeta(beat) {
    if (!beat || typeof beat !== 'object') return '';
    const bits = [];
    const movement = beat.movement && typeof beat.movement === 'object' ? beat.movement : {};
    const camera = beat.camera && typeof beat.camera === 'object' ? beat.camera : {};
    if (text(movement.actor)) bits.push(movement.actor);
    if (text(movement.timing)) bits.push(movement.timing);
    if (text(movement.quality)) bits.push(movement.quality);
    if (text(camera.path)) bits.push('camera: ' + camera.path);
    return bits.slice(0, 3).join(' / ');
  }

  /**
   * BeatTrail(root, { api, direction, shot, contextProvider, onPartnerMessage })
   * exposes open/close/toggle/refresh/setShot and stays inert while hidden.
   */
  function BeatTrail(root, opts = {}) {
    const api = opts.api;
    const direction = opts.direction;
    const contextProvider = typeof opts.contextProvider === 'function' ? opts.contextProvider : (() => ({}));
    const onPartnerMessage = typeof opts.onPartnerMessage === 'function' ? opts.onPartnerMessage : null;
    let shot = opts.shot || null;
    let open = false;
    let busy = false;
    let scope = null;

    root.classList.add('beat-trail');
    root.innerHTML = '';

    const head = el('div', 'beat-trail-head');
    const title = el('strong', '', 'Beats');
    const closeBtn = el('button', 'beat-trail-close', '-');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'hide beats');
    head.append(title, closeBtn);

    const list = el('div', 'beat-trail-list');
    const empty = el('div', 'beat-trail-empty', 'nothing pinned yet - rough is enough.');
    list.appendChild(empty);

    const form = el('div', 'beat-trail-form');
    const input = el('input', 'beat-trail-input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'what happens next?';
    input.setAttribute('aria-label', 'add a micro beat');
    const add = el('button', 'beat-trail-add', '+');
    add.type = 'button';
    add.setAttribute('aria-label', 'add beat through Partner');
    form.append(input, add);

    const stuck = el('button', 'beat-trail-stuck', 'help me find the next beat');
    stuck.type = 'button';

    root.append(head, list, form, stuck);

    function isOpen() { return open; }
    function setOpen(next) {
      open = Boolean(next);
      root.classList.toggle('open', open);
      root.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) refresh();
    }
    function openPanel() { setOpen(true); }
    function closePanel() { setOpen(false); }
    function toggle() { setOpen(!open); }

    function setShot(nextShot) {
      shot = nextShot || null;
      scope = null;
      if (open) refresh();
    }

    async function ensureScope() {
      if (scope && scope.shotId) return scope;
      if (!shot || !direction || !direction.ensureLegacyScope) return null;
      scope = await direction.ensureLegacyScope(api, shot);
      return scope;
    }

    function render(spec) {
      list.innerHTML = '';
      const beats = spec && Array.isArray(spec.beats) ? spec.beats : [];
      if (!beats.length) {
        list.appendChild(el('div', 'beat-trail-empty', 'nothing pinned yet - rough is enough.'));
        return;
      }
      for (const beat of beats) {
        const row = el('div', 'beat-row');
        const order = el('span', 'beat-order', String(beat.order || '-'));
        const body = el('div', 'beat-copy');
        body.appendChild(el('div', 'beat-main', beatLine(beat)));
        const meta = beatMeta(beat);
        if (meta) body.appendChild(el('div', 'beat-meta', meta));
        row.append(order, body);
        list.appendChild(row);
      }
    }

    async function refresh() {
      if (!open || !shot || !api || !api.getDirectionShotSpec) return null;
      try {
        const s = await ensureScope();
        if (!s || !s.shotId) return null;
        const spec = await api.getDirectionShotSpec(s.shotId);
        render(spec);
        return spec;
      } catch (_e) {
        list.innerHTML = '';
        list.appendChild(el('div', 'beat-trail-empty', 'beats will come back when the board reconnects.'));
        return null;
      }
    }

    function context() {
      let extra = {};
      try { extra = contextProvider() || {}; } catch (_e) { extra = {}; }
      return { ...extra, legacyShotId: shot && shot.id, surface: 'beat_trail' };
    }

    async function askPartner(message) {
      if (busy || !api || !api.partnerTurn || !shot) return null;
      busy = true;
      root.classList.add('busy');
      try {
        const response = await api.partnerTurn(message, { context: context() });
        if (response && onPartnerMessage) onPartnerMessage(response.message, response.nextMoves || []);
        await refresh();
        return response;
      } finally {
        busy = false;
        root.classList.remove('busy');
      }
    }

    async function submit() {
      const v = input.value.trim();
      if (!v || busy) return;
      input.value = '';
      await askPartner(v);
    }

    closeBtn.addEventListener('click', closePanel);
    add.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    stuck.addEventListener('click', () => askPartner(
      "i'm stuck on the next micro beat. give me two or three small options for what happens next in this shot",
    ));

    setOpen(false);
    return { open: openPanel, close: closePanel, toggle, isOpen, refresh, setShot, askPartner };
  }

  return { BeatTrail, beatLine, beatMeta };
});
