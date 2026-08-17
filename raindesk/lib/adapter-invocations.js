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

function stageRequest(stage, { turnId = null, registry = adapters.defaultRegistry } = {}) {
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
    requiredEvidence,
    requiredInputs: Array.isArray(descriptor.inputContract) ? [...descriptor.inputContract] : [],
    expectedOutputs: Array.isArray(descriptor.outputContract) ? [...descriptor.outputContract] : [],
    preserves: Array.isArray(descriptor.preserves) ? [...descriptor.preserves] : [],
    sideEffects: Array.isArray(descriptor.sideEffects) ? [...descriptor.sideEffects] : [],
  });
}

function requestsForPlan(plan, { turnId = null, registry = adapters.defaultRegistry } = {}) {
  if (!plan || typeof plan !== 'object' || plan.permissionMode === 'watch') return [];
  const requests = [];
  const seen = new Set();
  for (const stage of Array.isArray(plan.stages) ? plan.stages : []) {
    const request = stageRequest(stage, { turnId, registry });
    if (!request || seen.has(request.id)) continue;
    seen.add(request.id);
    requests.push(request);
  }
  return requests;
}

module.exports = {
  ACTIONABLE_DISPOSITIONS, ACTIONABLE_STATES,
  requestId, boundaryStatus, stageRequest, requestsForPlan,
};
