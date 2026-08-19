'use strict';

/** Attach immutable pacing offers to a completed, already-persisted Partner turn. */

const pacingContexts = require('./animatic-pacing-context');
const pacing = require('./animatic-pacing-proposals');

function isAnimaticRequest(request) {
  return Boolean(request && request.adapterId === 'animatic_timing_v1' &&
    request.capabilityId === 'animatic_timing' && request.invocationBoundary === 'external' &&
    request.disposition === 'proposal' && request.reviewRequired === true &&
    request.creativeMutation === true && request.id);
}

function firstAnimaticRequest(result) {
  const rows = result && Array.isArray(result.invocationRequests) ? result.invocationRequests : [];
  return rows.find(isAnimaticRequest) || null;
}

async function enrichTurn(result, {
  input = {},
  env = process.env,
  advisor = null,
  pacingContextImpl = pacingContexts,
  pacingImpl = pacing,
} = {}) {
  if (!result || !advisor || typeof advisor.suggest !== 'function') return result;
  const request = firstAnimaticRequest(result);
  if (!request) return result;

  try {
    const createdContext = pacingContextImpl.create({ parentRequestId: request.id, env });
    const context = createdContext.context;
    const advised = await advisor.suggest({
      context,
      artistMessage: input && input.message || '',
      partnerMessage: result.message || result.reply || '',
    });
    const proposals = [];
    for (const creative of Array.isArray(advised && advised.proposals) ? advised.proposals.slice(0, 3) : []) {
      const created = pacingImpl.createFromContext({ contextDigest: context.contextDigest, proposal: creative });
      proposals.push(pacingImpl.publicProposal(created.proposal));
    }
    return {
      ...result,
      animaticPacingContext: pacingContextImpl.publicContext(context),
      animaticPacingProposals: proposals,
    };
  } catch (_error) {
    // Pacing is an optional creative follow-on. A failed second pass must never
    // erase the conversational reply or the coarse server-persisted proposal.
    return { ...result, animaticPacingProposals: [], animaticPacingSuggestionError: true };
  }
}

module.exports = { isAnimaticRequest, firstAnimaticRequest, enrichTurn };
