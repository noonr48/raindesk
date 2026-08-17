/*
 * Raindesk Beat Trail — lightweight directing surface for the active shot.
 *
 * The artist sees their own words, rough start/landing references and a small
 * ordering surface.  Structure stays underneath: events, relations, camera
 * cues and Partner enrichment remain available without turning this into an
 * animation timeline or inspector.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.RaindeskBeats = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EVENT_GLYPHS = {
    action: '↝', performance: '◉', camera: '⌁', contact: '×', dialogue: '“', sound: '♪',
  };

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

  function visibleBeats(spec) {
    return (spec && Array.isArray(spec.beats) ? spec.beats : [])
      .filter((beat) => beat && beat.status !== 'rejected')
      .slice()
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  }

  function reorderedIds(beats, beatId, delta) {
    const ids = (beats || []).map((b) => b.id);
    const i = ids.indexOf(beatId);
    const j = i + Number(delta || 0);
    if (i < 0 || j < 0 || j >= ids.length) return ids;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return ids;
  }

  function frameImage(frame) {
    if (!frame || typeof frame !== 'object') return '';
    return text(frame.imageUrl) || (text(frame.referenceId) && /^[a-f0-9]{64}$/i.test(frame.referenceId)
      ? `/api/blob/${frame.referenceId}` : '');
  }

  /**
   * BeatTrail(root, opts)
   *
   * opts:
   *  - api / direction / shot / contextProvider / onPartnerMessage
   *  - onActiveBeatChange(beat|null)
   *  - onCaptureFrame(slot, { beatId|null }) -> frameRef or null
   */
  function BeatTrail(root, opts = {}) {
    const api = opts.api;
    const direction = opts.direction;
    const contextProvider = typeof opts.contextProvider === 'function' ? opts.contextProvider : (() => ({}));
    const onPartnerMessage = typeof opts.onPartnerMessage === 'function' ? opts.onPartnerMessage : null;
    const onActiveBeatChange = typeof opts.onActiveBeatChange === 'function' ? opts.onActiveBeatChange : null;
    const onCaptureFrame = typeof opts.onCaptureFrame === 'function' ? opts.onCaptureFrame : null;
    let shot = opts.shot || null;
    let open = false;
    let captureBusy = false;
    let partnerQueue = Promise.resolve();
    let partnerPending = 0;
    let scope = null;
    let lastSpec = null;
    let activeBeatId = null;
    let editingBeatId = null;

    root.classList.add('beat-trail');
    root.innerHTML = '';

    const head = el('div', 'beat-trail-head');
    const titleWrap = el('div', 'beat-title-wrap');
    const title = el('strong', '', 'Shot beats');
    const activeLabel = el('span', 'beat-active-label', '');
    titleWrap.append(title, activeLabel);
    const closeBtn = el('button', 'beat-trail-close', '−');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'hide shot beats');
    head.append(titleWrap, closeBtn);

    const frames = el('div', 'shot-frame-strip');
    const constraints = el('div', 'shot-constraints');
    const list = el('div', 'beat-trail-list');
    const detail = el('div', 'active-beat-detail');
    detail.setAttribute('aria-hidden', 'true');
    const body = el('div', 'beat-trail-body');
    body.append(list, detail);

    const form = el('div', 'beat-trail-form');
    const input = el('input', 'beat-trail-input');
    input.type = 'text'; input.maxLength = 500; input.placeholder = 'what happens next?';
    input.setAttribute('aria-label', 'add a micro beat');
    const add = el('button', 'beat-trail-add', '+');
    add.type = 'button'; add.setAttribute('aria-label', 'add beat through Partner');
    form.append(input, add);

    const stuck = el('button', 'beat-trail-stuck', 'help me find the next beat');
    stuck.type = 'button';

    root.append(head, frames, constraints, body, form, stuck);

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
      scope = null; lastSpec = null; activeBeatId = null; editingBeatId = null;
      notifyActive(null);
      if (open) refresh();
    }

    async function ensureScope() {
      if (scope && scope.shotId) return scope;
      if (!shot || !direction || !direction.ensureLegacyScope) return null;
      scope = await direction.ensureLegacyScope(api, shot);
      return scope;
    }

    function activeBeat() {
      return visibleBeats(lastSpec).find((b) => b.id === activeBeatId) || null;
    }

    function notifyActive(beat) {
      activeLabel.textContent = beat ? `beat ${beat.order || ''}`.trim() : '';
      if (onActiveBeatChange) {
        try { onActiveBeatChange(beat || null); } catch (_e) { /* observer only */ }
      }
    }

    function selectBeat(id) {
      activeBeatId = id || null;
      const beat = activeBeat();
      notifyActive(beat);
      render(lastSpec);
      return beat;
    }

    function renderFrameCard(slot, frame, label, context = {}) {
      const card = el('div', `shot-frame-card ${frame ? 'has-frame' : 'empty'}`);
      card.dataset.frameSlot = slot;
      if (context.beatId) card.dataset.beatId = context.beatId;
      const imgUrl = frameImage(frame);
      if (imgUrl) {
        const img = el('img', 'shot-frame-thumb');
        img.src = imgUrl; img.alt = `${label} frame`; img.loading = 'lazy';
        card.appendChild(img);
      } else {
        card.appendChild(el('div', 'shot-frame-blank', '+'));
      }
      const footer = el('div', 'shot-frame-footer');
      footer.appendChild(el('span', '', label));
      const set = el('button', 'shot-frame-set', frame ? 'replace' : 'set');
      set.type = 'button';
      set.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!onCaptureFrame || captureBusy) return;
        captureBusy = true; root.classList.add('busy');
        try { await onCaptureFrame(slot, context); await refresh(); }
        finally { captureBusy = false; root.classList.remove('busy'); }
      });
      footer.appendChild(set);
      if (frame) {
        const clear = el('button', 'shot-frame-clear', '×'); clear.type = 'button'; clear.title = 'clear reference';
        clear.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const s = await ensureScope();
            if (!s) return;
            if (context.beatId && api.setDirectionBeatFrameRef) await api.setDirectionBeatFrameRef(context.beatId, slot, null);
            else if (api.setDirectionShotFrameRef) await api.setDirectionShotFrameRef(s.shotId, slot, null);
            await refresh();
          } catch (_e) { /* leave current frame visible */ }
        });
        footer.appendChild(clear);
      }
      card.appendChild(footer);
      return card;
    }

    function renderFrames(spec) {
      frames.innerHTML = '';
      frames.appendChild(el('div', 'shot-frame-label', 'shot'));
      frames.appendChild(renderFrameCard('start', spec && spec.shot && spec.shot.startFrame, 'start'));
      frames.appendChild(el('div', 'shot-frame-arrow', '→'));
      frames.appendChild(renderFrameCard('end', spec && spec.shot && spec.shot.endFrame, 'landing'));
    }

    async function saveConstraints(kind, values) {
      const s = await ensureScope();
      if (!s || !api.setDirectionShotConstraints) return;
      const shotSpec = lastSpec && lastSpec.shot || {};
      const next = {
        preserve: kind === 'preserve' ? values : (shotSpec.preserve || []),
        change: kind === 'change' ? values : (shotSpec.change || []),
      };
      await api.setDirectionShotConstraints(s.shotId, next);
      await refresh();
    }

    function renderConstraintRow(kind, label, values, placeholder) {
      const row = el('div', `constraint-row ${kind}`);
      row.appendChild(el('span', 'constraint-label', label));
      const chips = el('div', 'constraint-chips');
      for (const value of values || []) {
        const chip = el('button', 'constraint-chip', value); chip.type = 'button'; chip.title = 'remove';
        chip.addEventListener('click', () => saveConstraints(kind, (values || []).filter((v) => v !== value)).catch(() => {}));
        chips.appendChild(chip);
      }
      const field = el('input', 'constraint-input'); field.type = 'text'; field.maxLength = 180; field.placeholder = placeholder;
      field.setAttribute('aria-label', `${label} constraint`);
      field.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = field.value.trim(); if (!v) return;
        field.value = '';
        saveConstraints(kind, [...(values || []), v]).catch(() => { field.value = v; });
      });
      row.append(chips, field);
      return row;
    }

    function renderConstraints(spec) {
      constraints.innerHTML = '';
      const shotSpec = spec && spec.shot || {};
      constraints.appendChild(renderConstraintRow('preserve', 'keep', shotSpec.preserve || [], 'face, framing, left hand…'));
      constraints.appendChild(renderConstraintRow('change', 'change', shotSpec.change || [], 'right hand, timing, expression…'));
    }

    function eventGlyphs(beat) {
      const wrap = el('div', 'beat-event-glyphs');
      const seen = new Set();
      for (const event of (beat && Array.isArray(beat.events) ? beat.events : [])) {
        const kind = event && event.kind;
        if (!EVENT_GLYPHS[kind] || seen.has(kind)) continue;
        seen.add(kind);
        const g = el('span', `beat-event-glyph ${kind}`, EVENT_GLYPHS[kind]);
        g.title = kind;
        wrap.appendChild(g);
      }
      return wrap;
    }

    function renderBeatPoseRefs(beat) {
      const pose = el('div', 'beat-pose-strip');
      pose.appendChild(renderFrameCard('start', beat.startFrame, 'start pose', { beatId: beat.id }));
      pose.appendChild(el('div', 'shot-frame-arrow', '→'));
      pose.appendChild(renderFrameCard('end', beat.endFrame, 'end pose', { beatId: beat.id }));
      return pose;
    }

    function renderActiveBeatDetail(beat) {
      detail.innerHTML = '';
      detail.classList.toggle('open', Boolean(beat));
      detail.setAttribute('aria-hidden', beat ? 'false' : 'true');
      if (!beat) {
        delete detail.dataset.beatId;
        return;
      }
      detail.dataset.beatId = beat.id;
      const heading = el('div', 'active-beat-detail-head');
      heading.appendChild(el('span', 'active-beat-kicker', `beat ${beat.order || ''}`.trim()));
      heading.appendChild(el('span', 'active-beat-summary', beatLine(beat)));
      detail.append(heading, renderBeatPoseRefs(beat));
    }

    async function editBeat(beat, value) {
      const v = text(value);
      if (!v || !api.updateDirectionBeat) return;
      await api.updateDirectionBeat(beat.id, { rawDirection: v, description: v });
      editingBeatId = null;
      await refresh();
      askPartner(v, { precreatedBeatId: beat.id, activeBeatId: beat.id }).catch(() => {});
    }

    async function moveBeat(beat, delta) {
      const beats = visibleBeats(lastSpec);
      const ids = reorderedIds(beats, beat.id, delta);
      if (ids.join('|') === beats.map((b) => b.id).join('|') || !api.reorderDirectionBeats) return;
      const s = await ensureScope();
      await api.reorderDirectionBeats(s.shotId, ids);
      await refresh();
    }

    async function removeBeat(beat) {
      if (!api.updateDirectionBeat) return;
      await api.updateDirectionBeat(beat.id, { status: 'rejected' });
      if (activeBeatId === beat.id) activeBeatId = null;
      await refresh();
    }

    function renderBeatRow(beat, index, beats) {
      const row = el('div', 'beat-row' + (beat.id === activeBeatId ? ' active' : ''));
      row.dataset.beatId = beat.id;
      row.tabIndex = 0;
      const order = el('span', 'beat-order', String(index + 1));
      const body = el('div', 'beat-copy');
      body.appendChild(el('div', 'beat-main', beatLine(beat)));
      const meta = beatMeta(beat);
      if (meta) body.appendChild(el('div', 'beat-meta', meta));
      body.appendChild(eventGlyphs(beat));
      const controls = el('div', 'beat-row-controls');
      const up = el('button', 'beat-row-btn', '↑'); up.type = 'button'; up.title = 'earlier'; up.disabled = index === 0;
      const down = el('button', 'beat-row-btn', '↓'); down.type = 'button'; down.title = 'later'; down.disabled = index === beats.length - 1;
      const edit = el('button', 'beat-row-btn', '✎'); edit.type = 'button'; edit.title = 'edit wording';
      const remove = el('button', 'beat-row-btn quiet', '×'); remove.type = 'button'; remove.title = 'remove from this pass';
      up.addEventListener('click', (e) => { e.stopPropagation(); moveBeat(beat, -1).catch(() => {}); });
      down.addEventListener('click', (e) => { e.stopPropagation(); moveBeat(beat, 1).catch(() => {}); });
      edit.addEventListener('click', (e) => { e.stopPropagation(); editingBeatId = beat.id; render(lastSpec); });
      remove.addEventListener('click', (e) => { e.stopPropagation(); removeBeat(beat).catch(() => {}); });
      controls.append(up, down, edit, remove);
      row.append(order, body, controls);
      row.addEventListener('click', () => selectBeat(beat.id));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBeat(beat.id); } });

      if (beat.id === editingBeatId) {
        const editor = el('div', 'beat-inline-edit');
        const field = el('input', 'beat-edit-input'); field.type = 'text'; field.maxLength = 500; field.value = beatLine(beat);
        const save = el('button', 'beat-edit-save', 'save'); save.type = 'button';
        const cancel = el('button', 'beat-edit-cancel', 'cancel'); cancel.type = 'button';
        save.addEventListener('click', () => editBeat(beat, field.value).catch(() => {}));
        cancel.addEventListener('click', () => { editingBeatId = null; render(lastSpec); });
        field.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); editBeat(beat, field.value).catch(() => {}); }
          if (e.key === 'Escape') { editingBeatId = null; render(lastSpec); }
        });
        editor.append(field, save, cancel); row.appendChild(editor);
        requestAnimationFrame(() => field.focus());
      }
      return row;
    }

    function revealBeatRow(beatId) {
      if (!beatId) return false;
      const row = list.querySelector(`.beat-row[data-beat-id="${beatId}"]`);
      if (!row || typeof row.getBoundingClientRect !== 'function' ||
          typeof body.getBoundingClientRect !== 'function') return false;

      // Measure the geometry the artist actually sees instead of composing
      // offsetTop values from different offset-parent chains.  The compact
      // Beat row and its reorder/edit controls are the visibility contract;
      // selected pose detail is allowed to continue below in a small panel.
      const viewport = list.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      if (!(viewport.height > 0) || !(rect.height > 0)) return false;
      const pad = 6;
      const topEdge = viewport.top + pad;
      const bottomEdge = viewport.bottom - pad;
      if (rect.top < topEdge) {
        list.scrollTop = Math.max(0, list.scrollTop - (topEdge - rect.top));
      } else if (rect.bottom > bottomEdge) {
        list.scrollTop = Math.max(0, list.scrollTop + (rect.bottom - bottomEdge));
      }
      return true;
    }

    function render(spec) {
      lastSpec = spec || null;
      renderFrames(spec);
      renderConstraints(spec);
      list.innerHTML = '';
      const beats = visibleBeats(spec);
      if (activeBeatId && !beats.some((b) => b.id === activeBeatId)) activeBeatId = null;
      if (!beats.length) {
        list.appendChild(el('div', 'beat-trail-empty', 'nothing pinned yet — rough is enough.'));
        renderActiveBeatDetail(null);
        notifyActive(null);
        return;
      }
      beats.forEach((beat, i) => list.appendChild(renderBeatRow(beat, i, beats)));
      const selected = activeBeat();
      renderActiveBeatDetail(selected);
      notifyActive(selected);
      if (activeBeatId) revealBeatRow(activeBeatId);
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
      const beat = activeBeat();
      return {
        ...extra,
        legacyShotId: shot && shot.id,
        shotId: scope && scope.shotId || extra.shotId || null,
        activeBeatId: beat && beat.id || null,
        activeBeat: beat ? {
          id: beat.id, order: beat.order, rawDirection: beat.rawDirection || beat.description || '',
          events: beat.events || [], relations: beat.relations || [], startFrame: beat.startFrame || null, endFrame: beat.endFrame || null,
        } : null,
        surface: 'beat_trail',
      };
    }

    function askPartner(message, contextExtra = {}) {
      if (!api || !api.partnerTurn || !shot) return Promise.resolve(null);
      const run = async () => {
        partnerPending += 1;
        root.classList.add('partner-busy');
        try {
          const response = await api.partnerTurn(message, { context: { ...context(), ...contextExtra } });
          if (response && onPartnerMessage) onPartnerMessage(response.message, response.nextMoves || []);
          await refresh();
          return response;
        } finally {
          partnerPending = Math.max(0, partnerPending - 1);
          if (!partnerPending) root.classList.remove('partner-busy');
        }
      };
      // Enrichment is serialized so several raw-first edits can happen without
      // racing Partner writes. The artist never waits for this queue to keep
      // sketching, reordering, or pinning visual direction.
      const task = partnerQueue.then(run, run);
      partnerQueue = task.catch(() => null);
      return task;
    }

    async function submit() {
      const v = input.value.trim();
      if (!v || captureBusy) return;
      input.value = '';
      let pinned = null;
      try {
        const s = await ensureScope();
        if (s && s.shotId && api.createDirectionBeat) {
          const created = await api.createDirectionBeat({
            shotId: s.shotId,
            description: v,
            rawDirection: v,
            movement: {}, camera: {}, status: 'provisional',
            source: { kind: 'user_beat_trail' },
          });
          pinned = created && created.beat ? created.beat : null;
          activeBeatId = pinned && pinned.id || activeBeatId;
          await refresh();
        }
      } catch (_e) {
        input.value = v;
        list.appendChild(el('div', 'beat-trail-empty', 'could not pin that beat yet — your words are still here.'));
        return;
      }
      askPartner(v, pinned ? { precreatedBeatId: pinned.id, activeBeatId: pinned.id } : {}).catch(() => {});
    }

    closeBtn.addEventListener('click', closePanel);
    add.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    stuck.addEventListener('click', () => askPartner(
      "i'm stuck on the next micro beat. give me two or three small options for what happens next in this shot",
    ));

    setOpen(false);
    return {
      open: openPanel, close: closePanel, toggle, isOpen, refresh, setShot, askPartner,
      selectBeat, getActiveBeatId: () => activeBeatId, getActiveBeat: activeBeat,
      beatOrderFor: (id) => { const b = visibleBeats(lastSpec).find((x) => x.id === id); return b ? b.order : null; },
      getSpec: () => lastSpec, context,
    };
  }

  return { EVENT_GLYPHS, BeatTrail, beatLine, beatMeta, visibleBeats, reorderedIds, frameImage };
});
