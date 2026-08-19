/* Raindesk animatic API extension — reviewer-facing calls only. */
(function (root, factory) {
  const ext = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = ext;
  else if (root.RaindeskAPI) Object.assign(root.RaindeskAPI, ext);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function api() {
    const value = root && root.RaindeskAPI;
    if (!value || typeof value.GET !== 'function' || typeof value.POST !== 'function') {
      throw new Error('RaindeskAPI must load before animatic-api.js');
    }
    return value;
  }

  function createAnimaticPacingContext(parentRequestId) {
    return api().POST('/api/animatic/pacing-context', { parentRequestId });
  }
  function getAnimaticPacingContext(contextDigest) {
    return api().GET(`/api/animatic/pacing-context/${encodeURIComponent(contextDigest)}`);
  }
  function createAnimaticPacingProposal(contextDigest, proposal) {
    return api().POST('/api/animatic/pacing-proposal', { contextDigest, proposal });
  }
  function getAnimaticPacingProposal(proposalDigest) {
    return api().GET(`/api/animatic/pacing-proposal/${encodeURIComponent(proposalDigest)}`);
  }
  function prepareAnimatic(proposalDigest) {
    return api().POST('/api/animatic/prepare', { proposalDigest });
  }
  function executeAnimatic(invocationId, { retry = false } = {}) {
    return api().POST('/api/animatic/execute', { invocationId, retry: retry === true });
  }
  function getAnimaticExecution(executionId) {
    return api().GET(`/api/animatic/execution/${encodeURIComponent(executionId)}`);
  }
  function listAnimaticCandidates({ sequenceId = null, projectId = null, limit = 100 } = {}) {
    const qs = new URLSearchParams();
    if (sequenceId) qs.set('sequenceId', sequenceId);
    if (projectId) qs.set('projectId', projectId);
    qs.set('limit', String(limit));
    return api().GET(`/api/animatic/candidates?${qs.toString()}`);
  }
  function getAnimaticCandidate(candidateId) {
    return api().GET(`/api/animatic/candidate/${encodeURIComponent(candidateId)}`);
  }
  function reviewAnimaticCandidate(candidateId, decision, { note = null, idempotencyKey } = {}) {
    if (!idempotencyKey) return Promise.reject(new Error('idempotencyKey is required for animatic review'));
    return api().POST('/api/animatic/review', { candidateId, decision, note, idempotencyKey });
  }
  function getAnimaticReview({ candidateId = null, sequenceId = null } = {}) {
    const qs = new URLSearchParams();
    if (candidateId) qs.set('candidateId', candidateId);
    else if (sequenceId) qs.set('sequenceId', sequenceId);
    else return Promise.reject(new Error('candidateId or sequenceId is required'));
    return api().GET(`/api/animatic/review?${qs.toString()}`);
  }

  return {
    createAnimaticPacingContext,
    getAnimaticPacingContext,
    createAnimaticPacingProposal,
    getAnimaticPacingProposal,
    prepareAnimatic,
    executeAnimatic,
    getAnimaticExecution,
    listAnimaticCandidates,
    getAnimaticCandidate,
    reviewAnimaticCandidate,
    getAnimaticReview,
  };
});
