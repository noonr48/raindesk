'use strict';

/**
 * Freeform Creative Desk v2 — first registry surfaces (Phase 1).
 *
 * Layers + Scenes extracted from the bespoke app.js panels into
 * CreativeSurfaces registrations. Flag-gated: app.js only mounts the
 * WindowManager when the page runs with ?freeform=1, so the default
 * experience is unchanged until the freeform desk is proven (the mission's
 * incremental-migration rule). The bespoke renderers remain until Phase 3
 * retires them — these controllers own their window body only.
 */

(function (root, factory) {
  const mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.RaindeskFreeformSurfaces = mod;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function el(document, tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * installSurfaces({ surfaces, deps }) — registers Layers + Scenes (Phase 1)
   * and Takes (Phase 3 unit 1) on the shared registry. deps carries
   * app-level seams:
   *   getBoard() -> board shots array
   *   getActiveShotId() -> string | null
   *   openShot(id), getLayers(), setActiveLayer(id), addLayer(spec),
   *   toggleLayerVisible(layer), laneCounts(), lanesMeta(), moveShot(lane),
   *   getTakeState() -> { count, index } | null,
   *   prevTake() -> boolean, nextTake() -> boolean,
   *   commitTake() -> void, discardTakes() -> void,
   *   getCastState() -> { shotId, characters: [{id,name,locked,anchors}], boundIds } | null,
   *   toggleBound(characterId) -> void,
   *   getNotes() -> string, setNotes(text) -> void,
   *   getProposals() -> [{id,type,label,status,executable}] ,
   *   applyProposal(id) -> Promise<void>, cancelProposal(id) -> Promise<void>,
   *   refreshCast() -> void, refreshProposals() -> void
   */
  /** Contextual-tools strip (Phase 4): a per-surface row of quick actions
   * rendered inside the surface body it belongs to. Surfaces own their
   * bodies, so surface-contextual actions live with the surface — the
   * shared window chrome stays window-level only. */
  function contextStrip(doc, body, actions) {
    const strip = el(doc, 'nav', 'freeform-context-actions');
    strip.setAttribute('aria-label', 'surface quick actions');
    for (const action of actions || []) {
      const btn = el(doc, 'button', 'freeform-context-action', action.label);
      btn.type = 'button';
      btn.addEventListener('click', () => { if (action.run) action.run(); });
      strip.appendChild(btn);
    }
    body.appendChild(strip);
    return strip;
  }

  function installSurfaces({ surfaces, deps } = {}) {
    if (!surfaces || typeof surfaces.register !== 'function') throw new Error('CreativeSurfaces registry is required');
    if (!deps) throw new Error('surface deps are required');

    surfaces.register({
      id: 'scenes',
      title: 'Scenes',
      entityType: 'sequence_strip',
      entityRefPrefix: 'scenes',
      minimumSize: { width: 260, height: 200 },
      defaultPlacement: { width: 340, height: 420, x: 24, y: 96 },
      supportedStates: ['floating', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        const list = el(doc, 'div', 'freeform-scene-rows');
        body.appendChild(list);
        const render = () => {
          list.innerHTML = '';
          const shots = deps.getBoard ? deps.getBoard() : [];
          const active = deps.getActiveShotId ? deps.getActiveShotId() : null;
          for (const shot of shots) {
            const row = el(doc, 'button', 'freeform-scene-row' + (shot && shot.id === active ? ' active' : ''));
            row.type = 'button';
            row.append(
              el(doc, 'strong', '', shot && shot.id || ''),
              el(doc, 'span', '', String(shot && shot.beat || 'untitled scene').slice(0, 58)),
              el(doc, 'small', '', String(shot && shot.lane || '').replace('_', ' ')),
            );
            row.addEventListener('click', () => deps.openShot && deps.openShot(shot.id));
            list.appendChild(row);
          }
        };
        render();
        return { render, destroy() { list.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'layers',
      title: 'Layers',
      entityType: 'layers_panel',
      entityRefPrefix: 'layers',
      minimumSize: { width: 240, height: 180 },
      defaultPlacement: { width: 300, height: 380, x: null, y: 96 },
      supportedStates: ['floating', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        const list = el(doc, 'div', 'freeform-layer-rows');
        body.appendChild(list);
        const render = () => {
          list.innerHTML = '';
          const layers = deps.getLayers ? deps.getLayers() : [];
          const activeId = deps.getActiveLayerId ? deps.getActiveLayerId() : null;
          for (const layer of layers) {
            const row = el(doc, 'div', 'freeform-layer' + (layer.id === activeId ? ' on' : ''));
            const sw = el(doc, 'div', 'sw sw-' + layer.kind);
            const nm = el(doc, 'span', 'nm', layer.name);
            const tag = el(doc, 'span', 'tag', layer.kind === 'base' ? 'LOCK' : String(layer.kind).toUpperCase());
            const eye = el(doc, 'button', 'eye', layer.visible ? '👁' : '—');
            eye.type = 'button';
            eye.setAttribute('aria-label', 'toggle layer visibility');
            eye.addEventListener('click', (e) => {
              e.stopPropagation();
              if (deps.toggleLayerVisible) deps.toggleLayerVisible(layer);
              render();
            });
            row.append(sw, nm, tag, eye);
            row.addEventListener('click', () => {
              if (deps.setActiveLayer && deps.setActiveLayer(layer.id)) render();
            });
            list.appendChild(row);
          }
          const add = el(doc, 'button', 'freeform-add-layer', '+ pen layer');
          add.type = 'button';
          add.addEventListener('click', () => {
            if (deps.addLayer) deps.addLayer({ name: 'notes ' + (layers.filter((l) => l.kind === 'pen').length), kind: 'pen' });
            render();
          });
          list.appendChild(add);
        };
        render();
        return { render, destroy() { list.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'takes',
      title: 'Takes',
      entityType: 'take_stack',
      entityRefPrefix: 'takes',
      minimumSize: { width: 220, height: 120 },
      defaultPlacement: { width: 260, height: 150, x: null, y: 96 },
      supportedStates: ['floating', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        const label = el(doc, 'span', 'freeform-take-label', '');
        const prev = el(doc, 'button', 'freeform-take-prev', '◀');
        const next = el(doc, 'button', 'freeform-take-next', '▶');
        const commit = el(doc, 'button', 'freeform-take-commit', 'accept');
        const discard = el(doc, 'button', 'freeform-take-discard', 'clear');
        for (const b of [prev, next, commit, discard]) b.type = 'button';
        const row = el(doc, 'div', 'freeform-take-row');
        row.append(prev, label, next);
        body.append(row, commit, discard);
        const sync = () => {
          const s = deps.getTakeState ? deps.getTakeState() : null;
          const has = Boolean(s && s.count > 0);
          label.textContent = has ? `take ${s.index + 1}/${s.count}` : 'no takes yet';
          prev.disabled = !has || s.index <= 0;
          next.disabled = !has || s.index >= s.count - 1;
          commit.disabled = !has;
          discard.disabled = !has;
        };
        prev.addEventListener('click', () => { deps.prevTake && deps.prevTake(); sync(); });
        next.addEventListener('click', () => { deps.nextTake && deps.nextTake(); sync(); });
        commit.addEventListener('click', () => { if (deps.commitTake) deps.commitTake(); sync(); });
        discard.addEventListener('click', () => {
          if (deps.discardTakes) deps.discardTakes();
          sync();
        });
        sync();
        return { render: sync, destroy() { body.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'characters',
      title: 'Characters',
      entityType: 'character_registry',
      entityRefPrefix: 'characters',
      minimumSize: { width: 240, height: 160 },
      defaultPlacement: { width: 300, height: 340, x: null, y: 96 },
      supportedStates: ['floating', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        contextStrip(doc, body, [{
          label: 'refresh cast',
          run: () => { if (deps.refreshCast) deps.refreshCast(); },
        }]);
        const list = el(doc, 'div', 'freeform-character-rows');
        body.appendChild(list);
        const render = () => {
          list.innerHTML = '';
          const cast = deps.getCastState ? deps.getCastState() : null;
          if (!cast || !cast.characters.length) {
            list.appendChild(el(doc, 'p', 'freeform-character-empty',
              cast ? 'no characters yet — pin a Character sheet in the world' : 'character registry offline (local server needed)'));
            return;
          }
          const bound = new Set(cast.boundIds || []);
          for (const ch of cast.characters) {
            const row = el(doc, 'div', 'freeform-character' + (bound.has(ch.id) ? ' bound' : ''));
            const name = el(doc, 'span', 'nm', ch.name || ch.id);
            const meta = el(doc, 'small', 'meta',
              (ch.anchors && ch.anchors.length ? `${ch.anchors.length} anchors` : 'no anchors'));
            const lock = el(doc, 'span', 'lock', ch.locked ? '🔒' : '');
            const castBtn = el(doc, 'button', 'cast', bound.has(ch.id) ? 'in cast' : 'add to cast');
            castBtn.type = 'button';
            castBtn.addEventListener('click', () => {
              if (deps.toggleBound) deps.toggleBound(ch.id);
            });
            row.append(name, meta, lock, castBtn);
            list.appendChild(row);
          }
        };
        render();
        return { render, destroy() { list.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'notes',
      title: 'Notes',
      entityType: 'notes_panel',
      entityRefPrefix: 'notes',
      minimumSize: { width: 200, height: 140 },
      defaultPlacement: { width: 280, height: 220, x: null, y: 96 },
      supportedStates: ['floating', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        const ta = el(doc, 'textarea', 'freeform-notes-area');
        ta.rows = 6;
        ta.placeholder = 'scratch thoughts, cues, reminders — saved as you type';
        body.appendChild(ta);
        ta.addEventListener('input', () => {
          if (deps.setNotes) deps.setNotes(String(ta.value || ''));
        });
        const render = () => {
          const v = deps.getNotes ? String(deps.getNotes() || '') : '';
          // Never clobber in-progress typing: only sync when the stored
          // text genuinely diverges from what the artist sees.
          if (String(ta.value || '') !== v) ta.value = v;
        };
        render();
        return { render, destroy() { body.innerHTML = ''; } };
      },
    });

    surfaces.register({
      id: 'proposals',
      title: 'Partner proposals',
      entityType: 'partner_proposals',
      entityRefPrefix: 'proposals',
      minimumSize: { width: 240, height: 140 },
      defaultPlacement: { width: 320, height: 240, x: null, y: 96 },
      supportedStates: ['floating', 'minimised', 'maximised'],
      createController: ({ body, document: doc }) => {
        contextStrip(doc, body, [{
          label: 'refresh',
          run: () => { if (deps.refreshProposals) deps.refreshProposals(); },
        }]);
        const list = el(doc, 'div', 'freeform-proposal-rows');
        body.appendChild(list);
        const render = () => {
          list.innerHTML = '';
          const proposals = (deps.getProposals ? deps.getProposals() : []) || [];
          const pending = proposals.filter((p) => p && p.status === 'proposed');
          if (!pending.length) {
            list.appendChild(el(doc, 'p', 'freeform-proposal-empty', 'no spatial suggestions right now'));
            return;
          }
          for (const p of pending) {
            const row = el(doc, 'div', 'freeform-proposal');
            const label = el(doc, 'span', 'nm', p.label || `${p.type} ${p.targetId || ''}`.trim());
            row.appendChild(label);
            if (p.executable) {
              const apply = el(doc, 'button', 'freeform-proposal-apply', 'apply');
              apply.type = 'button';
              apply.addEventListener('click', () => { if (deps.applyProposal) deps.applyProposal(p.id); });
              row.appendChild(apply);
            } else {
              const note = el(doc, 'small', 'meta', 'advisory');
              row.appendChild(note);
            }
            const dismiss = el(doc, 'button', 'freeform-proposal-dismiss', 'dismiss');
            dismiss.type = 'button';
            dismiss.addEventListener('click', () => { if (deps.cancelProposal) deps.cancelProposal(p.id); });
            row.appendChild(dismiss);
            list.appendChild(row);
          }
        };
        render();
        return { render, destroy() { list.innerHTML = ''; } };
      },
    });

    return true;
  }

  return { installSurfaces };
});
