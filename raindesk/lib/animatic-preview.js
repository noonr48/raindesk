'use strict';

/**
 * One-click exact-proposal preview boundary.
 *
 * Clicking Preview this is the artist's approval of one immutable pacing
 * proposal. The browser never approves/mints an invocation directly. The
 * server prepares the digest-bound child, advances that exact child to
 * approved, and invokes the review-only executor. Re-click after a technical
 * failure retries the same snapshot; it never invents a different creative cut.
 */

const { HttpError } = require('./errors');
const pacing = require('./animatic-pacing-proposals');
const preparation = require('./animatic-preparation');
const ledger = require('./partner-invocation-ledger');
const executionStore = require('./animatic-execution-store');
const executor = require('./animatic-executor');

function text(value, max = 256) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function createPreviewService({
  pacingImpl = pacing,
  preparationImpl = preparation,
  ledgerImpl = ledger,
  executionStoreImpl = executionStore,
  executorImpl = executor,
} = {}) {
  return {
    async preview({ proposalDigest, sourceRights, env = process.env } = {}) {
      const digest = text(proposalDigest, 64);
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new HttpError(400, 'proposalDigest must be one immutable sha256');
      const rights = text(sourceRights, 500);
      if (!rights) throw new HttpError(503, 'RAINDESK_SOURCE_RIGHTS is required before animatic preview');

      const proposal = pacingImpl.readByDigest(digest);
      if (pacingImpl.freshness(proposal).stale) {
        throw new HttpError(409, 'pacing proposal is stale because its source artwork or direction changed');
      }
      const prepared = preparationImpl.prepare({
        parentRequestId: proposal.parentRequestId,
        snapshotInput: pacingImpl.snapshotInput(proposal),
        sourceRights: rights,
      });
      let invocation = prepared.invocation;
      if (invocation.status === 'proposed') invocation = ledgerImpl.setStatus(invocation.id, 'approved');
      if (!invocation || !['approved', 'handed_off'].includes(invocation.status)) {
        throw new HttpError(409, 'exact animatic preview authority is no longer usable');
      }

      const previous = executionStoreImpl.latestForInvocation(invocation.id);
      const retry = Boolean(previous && ['failed', 'interrupted'].includes(previous.status));
      // Async preview: the authority prefix and durable run-begin complete
      // synchronously; the external render continues in the background. The
      // browser polls GET /api/animatic/execution/:id; a repeated click
      // returns the existing execution and never spawns twice.
      const started = executorImpl.start(invocation.id, { retry, env });
      return {
        proposal: pacingImpl.publicProposal(proposal),
        snapshot: prepared.snapshot,
        invocation,
        execution: started.execution,
        candidate: started.candidate || null,
        retried: retry,
        started: Boolean(started.started),
      };
    },
  };
}

const defaultService = createPreviewService();
module.exports = { text, createPreviewService, preview: defaultService.preview };
