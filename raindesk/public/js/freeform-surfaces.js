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
   * installSurfaces({ surfaces, deps }) — registers Layers + Scenes on the
   * shared registry. deps carries app-level seams:
   *   getBoard() -> board shots array
   *   getActiveShotId() -> string | null
   *   openShot(id), getLayers(), setActiveLayer(id), addLayer(spec),
   *   toggleLayerVisible(layer), laneCounts(), lanesMeta(), moveShot(lane)
   */
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

    return true;
  }

  return { installSurfaces };
});
