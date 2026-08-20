'use strict';

/** Read-only index over immutable pacing proposal documents for reload/UI restore. */

const fs = require('node:fs');
const pacing = require('./animatic-pacing-proposals');

function text(value, max = 256) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function list({ shotId = null, sequenceId = null, contextDigest = null, limit = 50 } = {}) {
  let names;
  try { names = fs.readdirSync(pacing.PROPOSAL_DIR); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const wantedShot = shotId == null ? null : text(shotId, 160);
  const wantedSequence = sequenceId == null ? null : text(sequenceId, 160);
  const wantedContext = contextDigest == null ? null : text(contextDigest, 64);
  const rows = [];
  for (const name of names) {
    const match = /^([a-f0-9]{64})\.json$/.exec(name);
    if (!match) continue;
    // Authority corruption is never hidden as an empty/missing proposal.
    const proposal = pacing.readByDigest(match[1]);
    if (!proposal.contextDigest) continue; // legacy/internal proposal, not public production advice.
    if (wantedShot && !(proposal.shots || []).some((shot) => shot.shotId === wantedShot)) continue;
    if (wantedSequence && proposal.sequenceId !== wantedSequence) continue;
    if (wantedContext && proposal.contextDigest !== wantedContext) continue;
    rows.push(proposal);
  }
  rows.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
    String(a.proposalDigest).localeCompare(String(b.proposalDigest)));
  const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
  return rows.slice(-bounded).map(pacing.publicProposal);
}

module.exports = { list };
