/*
 * Raindesk visual direction bridge.
 *
 * The artist draws a path and writes ordinary directing language. This module
 * preserves both, gives the Partner the mark as context, then stores the
 * Partner's provisional interpretation in the Direction Graph. No model/tool
 * names belong here: this is artist intent, not pipeline configuration.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.RaindeskDirection = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VALID_KINDS = new Set([
    'camera_path', 'actor_motion', 'framing', 'attention', 'timing',
    'dialogue_anchor', 'contact', 'preserve', 'branch', 'note', 'unknown',
  ]);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

  function safeIdPart(value) {
    return String(value || 'shot').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 72) || 'shot';
  }

  function simplifyPoints(points, minDistance = 3) {
    if (!Array.isArray(points) || !points.length) return [];
    const out = [];
    for (const p of points) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const q = { x: Number(p.x), y: Number(p.y) };
      const prev = out[out.length - 1];
      if (!prev || Math.hypot(q.x - prev.x, q.y - prev.y) >= minDistance) out.push(q);
    }
    const last = points[points.length - 1];
    const tail = out[out.length - 1];
    if (last && Number.isFinite(last.x) && Number.isFinite(last.y) &&
        (!tail || tail.x !== last.x || tail.y !== last.y)) {
      out.push({ x: Number(last.x), y: Number(last.y) });
    }
    return out;
  }

  function pathGeometry(points, width = 1024, height = 1024) {
    const clean = simplifyPoints(points);
    return {
      type: 'path',
      coordinateSpace: 'canvas',
      width,
      height,
      arrow: true,
      points: clean.map((p) => ({
        x: clamp(p.x, 0, width),
        y: clamp(p.y, 0, height),
      })),
    };
  }

  function kindFromInterpretation(interpretation) {
    if (!interpretation || typeof interpretation !== 'object') return 'unknown';
    if (VALID_KINDS.has(interpretation.annotationKind)) return interpretation.annotationKind;
    switch (interpretation.kind) {
      case 'camera': return 'camera_path';
      case 'movement': return 'actor_motion';
      case 'performance': return 'actor_motion';
      case 'edit': return 'note';
      case 'review': return 'attention';
      default: return 'unknown';
    }
  }

  function findLegacyScope(graph, legacyShotId) {
    if (!graph || !Array.isArray(graph.shots)) return null;
    const match = graph.shots.find((shot) => shot && shot.source &&
      shot.source.kind === 'legacy_board_bridge' && shot.source.legacyShotId === legacyShotId);
    if (!match) return null;
    return { sceneId: match.sceneId, shotId: match.id };
  }

  async function ensureLegacyScope(api, legacyShot) {
    if (!api || !legacyShot || !legacyShot.id) throw new Error('direction scope needs a shot');
    let graph = await api.getDirection();
    let scope = findLegacyScope(graph, legacyShot.id);
    if (scope) return scope;

    const sceneId = 'legacy_board';
    if (!Array.isArray(graph.scenes) || !graph.scenes.some((scene) => scene.id === sceneId)) {
      try {
        await api.createDirectionScene({
          id: sceneId,
          title: 'Working board',
          description: 'Bridge for the current Raindesk storyboard surface.',
          status: 'provisional',
          source: { kind: 'legacy_board_bridge' },
        });
      } catch (e) {
        if (!e || e.status !== 409) throw e;
      }
    }

    const shotId = `legacy_${safeIdPart(legacyShot.id)}`;
    try {
      await api.createDirectionShot({
        id: shotId,
        sceneId,
        title: legacyShot.id,
        description: legacyShot.beat || '',
        status: 'provisional',
        source: { kind: 'legacy_board_bridge', legacyShotId: legacyShot.id },
      });
    } catch (e) {
      if (!e || e.status !== 409) throw e;
    }

    graph = await api.getDirection();
    scope = findLegacyScope(graph, legacyShot.id);
    return scope || { sceneId, shotId };
  }

  async function loadShotMarks(api, legacyShotId) {
    const graph = await api.getDirection();
    const scope = findLegacyScope(graph, legacyShotId);
    if (!scope) return { scope: null, marks: [] };
    const marks = (graph.annotations || []).filter((ann) => ann &&
      ann.scopeType === 'shot' && ann.scopeId === scope.shotId &&
      ann.geometry && ann.geometry.type === 'path');
    return { scope, marks };
  }

  async function interpretAndSavePath(api, {
    legacyShot,
    points,
    caption = '',
    width = 1024,
    height = 1024,
    extraContext = {},
  }) {
    const scope = await ensureLegacyScope(api, legacyShot);
    const geometry = pathGeometry(points, width, height);
    const rawText = String(caption || '').trim();
    let turn = null;
    let partnerError = null;

    try {
      turn = await api.partnerTurn(
        rawText
          ? `I drew this direction on ${legacyShot.id}: ${rawText}`
          : `I drew an unlabelled direction arrow on ${legacyShot.id}.`,
        {
          context: {
            ...extraContext,
            sceneId: scope.sceneId,
            shotId: scope.shotId,
            surface: 'direction_annotation',
            selection: {
              type: 'direction_annotation',
              rawText,
              geometry,
              legacyShotId: legacyShot.id,
            },
          },
        },
      );
    } catch (e) {
      partnerError = e;
    }

    const interpretation = turn && turn.interpretation && typeof turn.interpretation === 'object'
      ? turn.interpretation : null;
    const kind = kindFromInterpretation(interpretation);
    const confidence = interpretation && Number.isFinite(Number(interpretation.confidence))
      ? clamp(Number(interpretation.confidence), 0, 1) : null;
    const saved = await api.addDirectionAnnotation({
      scopeType: 'shot',
      scopeId: scope.shotId,
      kind,
      rawText,
      geometry,
      interpretation,
      confidence,
      status: 'provisional',
      source: {
        kind: 'direction_pen',
        legacyShotId: legacyShot.id,
        intentId: turn && turn.intentId || null,
        partnerAvailable: !partnerError,
      },
    });

    return {
      scope,
      annotation: saved && saved.annotation ? saved.annotation : null,
      turn,
      partnerError,
    };
  }

  return {
    VALID_KINDS,
    safeIdPart,
    simplifyPoints,
    pathGeometry,
    kindFromInterpretation,
    findLegacyScope,
    ensureLegacyScope,
    loadShotMarks,
    interpretAndSavePath,
  };
});
