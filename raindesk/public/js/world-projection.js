/*
 * Raindesk world projection — the ONE world↔screen coordinate authority
 * (Stage-2, Round-6 critical finding). Pure functions: no DOM, no store.
 * Byte-identical semantics to the math extracted from creative-desk.js
 * (P0 is a pure move; CreativeDesk keeps its export surface by re-serving
 * these as its own module exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RaindeskWorldProjection = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_ZOOM = 0.22;
  const MAX_ZOOM = 3.5;
  const WORLD_SIZE = 1024;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v) || 0)); }
  function clampZoom(z) { return clamp(z, MIN_ZOOM, MAX_ZOOM); }
  function cleanViewport(v = {}) {
    return { x: Number(v.x) || 0, y: Number(v.y) || 0, zoom: clampZoom(v.zoom == null ? 1 : v.zoom) };
  }
  function baseScale(metrics = {}) {
    const w = Math.max(1, Number(metrics.width) || 1);
    const h = Math.max(1, Number(metrics.height) || 1);
    return Math.min(w / WORLD_SIZE, h / WORLD_SIZE);
  }
  function worldScale(viewport, metrics) { return baseScale(metrics) * cleanViewport(viewport).zoom; }
  function worldToScreen(point, viewport, metrics) {
    const vp = cleanViewport(viewport); const s = worldScale(vp, metrics);
    return { x: (Number(metrics.width) || 0) / 2 + vp.x + (Number(point.x) || 0) * s,
      y: (Number(metrics.height) || 0) / 2 + vp.y + (Number(point.y) || 0) * s };
  }
  function screenToWorld(point, viewport, metrics) {
    const vp = cleanViewport(viewport); const s = worldScale(vp, metrics) || 1;
    return { x: ((Number(point.x) || 0) - (Number(metrics.width) || 0) / 2 - vp.x) / s,
      y: ((Number(point.y) || 0) - (Number(metrics.height) || 0) / 2 - vp.y) / s };
  }
  function zoomAround(screenPoint, nextZoom, viewport, metrics) {
    const vp = cleanViewport(viewport);
    const anchor = screenToWorld(screenPoint, vp, metrics);
    const zoom = clampZoom(nextZoom);
    const s = baseScale(metrics) * zoom;
    return {
      x: (Number(screenPoint.x) || 0) - (Number(metrics.width) || 0) / 2 - anchor.x * s,
      y: (Number(screenPoint.y) || 0) - (Number(metrics.height) || 0) / 2 - anchor.y * s,
      zoom,
    };
  }
  function focusViewport(obj, viewport, metrics, opts = {}) {
    if (!obj) return cleanViewport(viewport);
    const zoom = clampZoom(opts.zoom == null ? cleanViewport(viewport).zoom : opts.zoom);
    const s = baseScale(metrics) * zoom;
    const cx = (Number(obj.x) || 0) + (Number(obj.width) || 0) * (Number(obj.scale) || 1) / 2;
    const cy = (Number(obj.y) || 0) + (Number(obj.height) || 0) * (Number(obj.scale) || 1) / 2;
    return { x: -cx * s, y: -cy * s, zoom };
  }

  return { MIN_ZOOM, MAX_ZOOM, WORLD_SIZE, clamp, clampZoom, cleanViewport, baseScale, worldScale,
    worldToScreen, screenToWorld, zoomAround, focusViewport };
});
