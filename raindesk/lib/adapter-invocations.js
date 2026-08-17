'use strict';

/**
 * Adapter Invocation Requests v1
 *
 * Converts a validated execution plan into bounded hand-off requests. This
 * module never invokes arbitrary code and never accepts creative output.
 */

const crypto = require('node:crypto');
const adapters = require('./production-adapters');

const ACTIONABLE_DISPOSITIONS = new Set(['proposal', 'auto']);
const ACTIONABLE_STATES = new Set(['operational', 'review_take']);

function text(value, max = 256) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function requestId(turnId, stageId) {
  const seed = `${text(turnId, 128) || 'turn'}|${text(stageId, 256)}`;
  return `invoke_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

function boundaryStatus(boundary, disposition) {
  if (disposition === 'proposal') return 'awaiting_approval';
  if (boundary === 'surface') return 'awaiting_surface';
  if (boundary === 'server') return 'ready_server';
  if (boundary === 'external') return 'awaiting_external';
  return 'blocked';
}

function stableSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
  const out = { type: text(selection.type, 64) || 'selection' };
  if (selection.region && typeof selection.region === 'object') {
    const r = selection.region;
    out.region = ['x', 'y', 'w', 'h', 'width', 'height'].reduce((acc, key) => {
      if (Number.isFinite(Number(r[key]))) acc[key] = Math.round(Number(r[key]) * 1000) / 1000;
      return acc;
    }, {});
  }
  const points = Array.isArray(selection.lasso) ? selection.lasso : (Array.isArray(selection.points) ? selection.points : null);
  if (points) {
    out.points = points.slice(0, 96).map((point) => {
      if (Array.isArray(point)) return point.slice(0, 2).map((value) => Math.round(Number(value) * 1000) / 1000);
      if (point && typeof point === 'object') return {
        x: Math.round(Number(point.x) * 1000) / 1000,
        y: Math.round(Number(point.y) * 1000) / 1000,
      };
      return null;
    }).filter(Boolean);
  }
  if (selection.geometry && typeof selection.geometry === 'object') out.geometry = selection.geometry;
  return out;
}

function selectionFingerprint(selection) {
  const stable = stableSelection(selection);
  if (!stable) return null;
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
}

function scopeSnapshot(context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  return Object.freeze({
    shotId: text(context.shotId || context.legacyShotId, 96) || null,
    artRevisionId: text(context.artRevisionId, 160) || null,
    selectionFingerprint: selectionFingerprint(context.selection),
  });
}

function stageRequest(stage, { turnId = null, registry = adapters.defaultRegistry, scope = null } = {}) {
  if (!stage || typeof stage !== 'object') return null;
  if (!ACTIONABLE_STATES.has(stage.state)) return null;
  if (!ACTIONABLE_DISPOSITIONS.has(stage.disposition)) return null;
  const adapterId = stage.adapter && text(stage.adapter.id, 96);
  if (!adapterId || !registry || typeof registry.get !== 'function') return null;
  const descriptor = registry.get(adapterId);
  if (!descriptor || descriptor.capabilityId !== stage.capabilityId) return null;
  if (descriptor.availability === 'disabled') return null;
  if (stage.adapter.capabilityId && stage.adapter.capabilityId !== descriptor.capabilityId) return null;
  if (descriptor.creativeMutation && !descriptor.reviewRequired) return null;

  const requiredEvidence = Array.from(new Set([
    ...(Array.isArray(stage.requiredEvidence) ? stage.requiredEvidence : []),
    ...(Array.isArray(descriptor.requiredEvidence) ? descriptor.requiredEvidence : []),
  ]));
  const missingEvidence = Array.isArray(stage.missingEvidence) ? stage.missingEvidence.filter(Boolean) : [];
  if (missingEvidence.length) return null;

  const disposition = stage.disposition;
  return Object.freeze({
    schemaVersion: 1,
    id: requestId(turnId, stage.id),
    turnId: text(turnId, 128) || null,
    stageId: text(stage.id, 256),
    recipeId: text(stage.recipeId, 96),
    capabilityId: descriptor.capabilityId,
    adapterId: descriptor.id,
    invocationBoundary: descriptor.invocationBoundary,
    disposition,
    status: boundaryStatus(descriptor.invocationBoundary, disposition),
    reviewRequired: Boolean(descriptor.reviewRequired),
    creativeMutation: Boolean(descriptor.creativeMutation),
    scope: scope && typeof scope === 'object' ? { ...scope } : null,
    requiredEvidence,
    requiredInputs: Array.isArray(descriptor.inputContract) ? [...descriptor.inputContract] : [],
    expectedOutputs: Array.isArray(descriptor.outputContract) ? [...descriptor.outputContract] : [],
    preserves: Array.isArray(descriptor.preserves) ? [...descriptor.preserves] : [],
    sideEffects: Array.isArray(descriptor.sideEffects) ? [...descriptor.sideEffects] : [],
  });
}

function requestsForPlan(plan, { turnId = null, registry = adapters.defaultRegistry, context = {} } = {}) {
  if (!plan || typeof plan !== 'object' || plan.permissionMode === 'watch') return [];
  const scope = scopeSnapshot(context);
  const requests = [];
  const seen = new Set();
  for (const stage of Array.isArray(plan.stages) ? plan.stages : []) {
    const request = stageRequest(stage, { turnId, registry, scope });
    if (!request || seen.has(request.id)) continue;
    seen.add(request.id);
    requests.push(request);
  }
  return requests;
}

module.exports = {
  ACTIONABLE_DISPOSITIONS, ACTIONABLE_STATES,
  requestId, boundaryStatus, stableSelection, selectionFingerprint, scopeSnapshot,
  stageRequest, requestsForPlan,
};
