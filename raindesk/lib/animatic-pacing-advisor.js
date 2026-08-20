'use strict';

/**
 * Partner-facing pacing advisor for the first animatic vertical slice.
 *
 * The advisor is deliberately a creative-language boundary, not an authority
 * boundary. It receives a path/revision-free projection of an immutable
 * AnimaticPacingContext and may return only label/rationale/fidelity plus
 * ordered shot ids, durations and notes. The server later binds that advice
 * back to the stored context through animatic-pacing-proposals.
 */

const partnerCore = require('./partner-core');
const pacing = require('./animatic-pacing-proposals');

const MAX_PROPOSALS = 3;

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value, max = 1000) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function creativeContext(context) {
  if (!isObject(context)) return null;
  const eligibleShots = Array.isArray(context.eligibleShots)
    ? context.eligibleShots.slice(0, pacing.MAX_SHOTS).map((shot) => ({
      shotId: text(shot && shot.shotId, 160),
      title: text(shot && shot.title, 180),
      description: text(shot && shot.description, 520),
      beats: Array.isArray(shot && shot.beats)
        ? shot.beats.slice(0, 8).map((beat) => text(beat, 240)).filter(Boolean)
        : [],
    })).filter((shot) => pacing.ID_RE.test(shot.shotId))
    : [];
  if (!eligibleShots.length) return null;
  const activeShotId = text(context.activeShotId, 160);
  if (!eligibleShots.some((shot) => shot.shotId === activeShotId)) return null;
  const fpsNum = Number(context.fpsNum);
  const fpsDen = Number(context.fpsDen);
  if (!Number.isInteger(fpsNum) || !Number.isInteger(fpsDen) || fpsNum < 1 || fpsDen < 1) return null;
  return { fpsNum, fpsDen, activeShotId, eligibleShots };
}

function buildPrompt({ context, artistMessage = '', partnerMessage = '' } = {}) {
  const creative = creativeContext(context);
  if (!creative) throw new Error('pacing advisor requires a valid creative pacing context');
  return `RAINDESK PACING PASS\n\nYou are helping the same artist compare rough editorial rhythm. This is creative advice only: the server owns project identity, source revisions, rights, tools and execution authority.\n\nRules:\n- Offer 1-3 genuinely different pacing interpretations only when the differences are useful.\n- Use ONLY shotId values listed in the context. Every option must include activeShotId.\n- Keep the sequence small; do not add imaginary shots, camera moves or story events.\n- durationFrames must be a positive integer at the supplied rational frame rate.\n- Keep each shot note short and artist-facing (for example \"wide descent\", \"hold on Lena\", \"wheel slips\").\n- fidelity is draft unless there is a specific reason for preview.\n- Do not output project ids, sequence ids, revision ids, hashes, paths, rights, adapters, executor settings, approval state or candidate ids.\n- The visible labels should describe feel: for example Restrained, Tighter, Uneasy hold, Snap cut.\n\nPacing context:\n${JSON.stringify(creative)}\n\nArtist direction:\n${text(artistMessage, 4000) || '(no extra wording beyond the current directing context)'}\n\nPartner response already shown to the artist:\n${text(partnerMessage, 2400) || '(none)'}\n\nReturn JSON ONLY:\n{\n  \"proposals\": [\n    {\n      \"label\": \"short feel label\",\n      \"rationale\": \"one concise creative reason\",\n      \"fidelity\": \"draft\",\n      \"shots\": [\n        {\"shotId\": \"one listed id\", \"durationFrames\": 48, \"note\": \"human-facing beat label\"}\n      ]\n    }\n  ]\n}`;
}

function normalizeProposals(raw, context) {
  const creative = creativeContext(context);
  if (!creative) return [];
  const parsed = typeof raw === 'string' ? partnerCore.parseJsonObject(raw) : raw;
  const rows = isObject(parsed) && Array.isArray(parsed.proposals) ? parsed.proposals : [];
  const eligible = new Set(creative.eligibleShots.map((shot) => shot.shotId));
  const out = [];
  const fingerprints = new Set();

  for (const row of rows.slice(0, MAX_PROPOSALS * 2)) {
    if (!isObject(row)) continue;
    let proposal;
    try { proposal = pacing.normalizeContextCreative(row); }
    catch (_error) { continue; }
    if (!proposal.label || !proposal.shots.some((shot) => shot.shotId === creative.activeShotId)) continue;
    if (proposal.shots.some((shot) => !eligible.has(shot.shotId))) continue;
    const fingerprint = pacing.canonicalJson({
      fidelity: proposal.fidelity,
      shots: proposal.shots.map((shot) => ({ shotId: shot.shotId, durationFrames: shot.durationFrames, note: shot.note })),
    });
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    out.push(proposal);
    if (out.length >= MAX_PROPOSALS) break;
  }
  return out;
}

function createAdvisor({ agentImpl } = {}) {
  if (!agentImpl || typeof agentImpl.chat !== 'function') throw new Error('agentImpl.chat is required for animatic pacing advice');
  return {
    async suggest({ context, artistMessage = '', partnerMessage = '' } = {}) {
      const prompt = buildPrompt({ context, artistMessage, partnerMessage });
      const raw = await agentImpl.chat(prompt);
      return { proposals: normalizeProposals(raw, context) };
    },
  };
}

module.exports = {
  MAX_PROPOSALS,
  isObject,
  text,
  creativeContext,
  buildPrompt,
  normalizeProposals,
  createAdvisor,
};
