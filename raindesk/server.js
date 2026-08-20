'use strict';

/**
 * Raindesk server composition layer.
 *
 * The inherited server remains byte-for-byte in server-core.js. Server-owned
 * creative authority is composed here: character identity comes from the
 * registry, artwork revision identity comes from ShotDocument rather than
 * browser assertions, actionable Partner requests are durably registered
 * before browser exposure, and the animatic path binds pacing context,
 * proposals, preview execution and review to server-owned authority.
 */

const core = require('./server-core');
const characters = require('./lib/characters');
const invocationLedger = require('./lib/partner-invocation-ledger');
const shotDocuments = require('./lib/shot-documents');
const animaticPreparation = require('./lib/animatic-preparation');
const animaticPacingContext = require('./lib/animatic-pacing-context');
const animaticPacing = require('./lib/animatic-pacing-proposals');
const animaticPacingAdvisor = require('./lib/animatic-pacing-advisor');
const animaticPartnerPacing = require('./lib/animatic-partner-pacing');
const animaticPacingIndex = require('./lib/animatic-pacing-index');
const animaticPreview = require('./lib/animatic-preview');
const animaticExecutor = require('./lib/animatic-executor');
const animaticExecutionStore = require('./lib/animatic-execution-store');
const animaticCandidates = require('./lib/animatic-candidates');
const animaticReview = require('./lib/animatic-review-decisions');
const videoArtifacts = require('./lib/video-artifacts');
const direction = require('./lib/direction');
const partner = require('./lib/partner');
const agent = require('./lib/agent');
const jobStore = require('./lib/job-store');
const { HttpError } = require('./lib/errors');

const CHARACTER_BODY_LIMIT = 512 * 1024;
const SAFE_ID_SEGMENT = '[A-Za-z0-9._-]+';
const DIGEST_SEGMENT = '[a-f0-9]{64}';

function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function resolveCharacterShotId(context = {}) {
  if (typeof context.shotId === 'string' && context.shotId.trim()) return context.shotId.trim();
  if (typeof context.legacyShotId === 'string' && context.legacyShotId.trim()) return context.legacyShotId.trim();
  try {
    const graph = direction.readGraph();
    const id = graph && graph.project && graph.project.activeShotId;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch (_e) { return null; }
}
function resolveArtworkShotId(context = {}, resolvedShotId = null) {
  if (typeof context.legacyShotId === 'string' && context.legacyShotId.trim()) return context.legacyShotId.trim();
  if (typeof resolvedShotId === 'string' && resolvedShotId.trim()) return resolvedShotId.trim();
  return null;
}
function authoritativeArtRevision(context = {}, resolvedShotId = null) {
  const shotId = resolveArtworkShotId(context, resolvedShotId);
  if (!shotId) return null;
  try {
    const current = shotDocuments.readCurrent(shotId);
    return current && typeof current.revisionId === 'string' ? current.revisionId : null;
  } catch (_e) { return null; }
}
function persistInvocationProposals(result) {
  if (!isObject(result) || !Array.isArray(result.invocationRequests) || !result.invocationRequests.length) return result;
  try {
    for (const request of result.invocationRequests) {
      const recorded = invocationLedger.recordFromRequest(request);
      if (recorded.entry.shotId) invocationLedger.markStaleSuperseded({
        shotId: recorded.entry.shotId,
        requestId: recorded.entry.requestId,
        adapterId: recorded.entry.adapterId,
      });
    }
    return result;
  } catch (error) {
    console.error('[raindesk] invocation proposal persistence failed:', error && error.message ? error.message : error); // eslint-disable-line no-console
    return { ...result, invocationRequests: [], invocationPersistenceError: true };
  }
}
function withAuthoritativeContext(basePartner, { pacingAdvisor = null, animaticEnv = process.env } = {}) {
  if (!basePartner || typeof basePartner.turn !== 'function') throw new Error('partnerImpl.turn is required');
  return {
    ...basePartner,
    async turn(input = {}) {
      const context = isObject(input.context) ? { ...input.context } : {};
      const shotId = resolveCharacterShotId(context);
      if (shotId) {
        try { context.characterAnchors = characters.contextForShot(shotId); } catch (_e) { /* keep conversation live */ }
      }
      context.artRevisionId = authoritativeArtRevision(context, shotId);
      const persisted = persistInvocationProposals(await basePartner.turn({ ...input, context }));
      return animaticPartnerPacing.enrichTurn(persisted, {
        input: { ...input, context },
        env: animaticEnv,
        advisor: pacingAdvisor,
      });
    },
  };
}
const withCharacterContext = withAuthoritativeContext;

function readBody(req, limit = CHARACTER_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { settled = true; reject(new HttpError(413, `request body exceeds ${limit} bytes`)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
  });
}
async function readJson(req, limit = CHARACTER_BODY_LIMIT) {
  const bytes = await readBody(req, limit);
  if (!bytes.length) throw new HttpError(400, 'empty request body');
  try { return JSON.parse(bytes.toString('utf8')); } catch (_e) { throw new HttpError(400, 'request body is not valid JSON'); }
}

function characterRoute(pathname) { return pathname === '/api/characters' || pathname === '/api/character' || pathname === '/api/character/shot-binding'; }
function invocationRoute(pathname) { return pathname === '/api/invocations'; }
function animaticRoute(pathname) {
  return pathname === '/api/animatic/pacing-context' ||
    new RegExp(`^/api/animatic/pacing-context/${DIGEST_SEGMENT}$`).test(pathname) ||
    pathname === '/api/animatic/pacing-proposal' ||
    pathname === '/api/animatic/pacing-proposals' ||
    new RegExp(`^/api/animatic/pacing-proposal/${DIGEST_SEGMENT}$`).test(pathname) ||
    pathname === '/api/animatic/prepare' || pathname === '/api/animatic/preview' || pathname === '/api/animatic/execute' ||
    pathname === '/api/animatic/candidates' || pathname === '/api/animatic/review' ||
    /^\/api\/animatic\/snapshot\/[a-f0-9]{64}$/.test(pathname) ||
    new RegExp(`^/api/animatic/execution/${SAFE_ID_SEGMENT}$`).test(pathname) ||
    new RegExp(`^/api/animatic/candidate/${SAFE_ID_SEGMENT}$`).test(pathname) ||
    /^\/api\/animatic\/artifact\/[a-f0-9]{64}$/.test(pathname);
}
function asBadRequest(error) { return error instanceof HttpError ? error : new HttpError(400, error && error.message ? error.message : 'invalid request data'); }

async function handleCharacterApi(req, res, url) {
  const route = url.pathname; const method = req.method;
  if (method === 'GET' && route === '/api/characters') return core.sendJson(res, 200, { characters: characters.list() });
  if (method === 'POST' && route === '/api/character') {
    const body = await readJson(req); let character;
    try { character = characters.upsert(body || {}); } catch (error) { throw asBadRequest(error); }
    return core.sendJson(res, 200, { ok: true, character });
  }
  if (route === '/api/character/shot-binding') {
    if (method === 'GET') {
      const shotId = String(url.searchParams.get('shotId') || '').trim();
      if (!shotId) throw new HttpError(400, 'shotId is required');
      return core.sendJson(res, 200, characters.contextForShot(shotId));
    }
    if (method === 'POST') {
      const body = await readJson(req, 256 * 1024);
      if (!body || typeof body.shotId !== 'string' || !body.shotId.trim()) throw new HttpError(400, 'shotId is required');
      let binding;
      try { binding = characters.bindShot(body.shotId.trim(), body.characterIds); } catch (error) { throw asBadRequest(error); }
      return core.sendJson(res, 200, binding);
    }
  }
  throw new HttpError(404, 'not found');
}

async function handleInvocationApi(req, res, url) {
  if (url.pathname !== '/api/invocations') throw new HttpError(404, 'not found');
  if (req.method === 'GET') {
    const shotId = String(url.searchParams.get('shotId') || '').trim() || null;
    const status = String(url.searchParams.get('status') || '').trim() || null;
    return core.sendJson(res, 200, { ok: true, invocations: invocationLedger.list({ shotId, status }) });
  }
  if (req.method === 'POST') {
    const body = await readJson(req, 256 * 1024);
    if (!isObject(body)) throw new HttpError(400, 'invocation record is required');
    let recorded;
    try { recorded = invocationLedger.record({ ...body, origin: 'http_legacy', status: 'proposed' }); } catch (error) { throw asBadRequest(error); }
    if (body.supersede && recorded.entry.shotId) invocationLedger.markStaleSuperseded({
      shotId: recorded.entry.shotId, requestId: recorded.entry.requestId || recorded.entry.id, adapterId: recorded.entry.adapterId,
    });
    return core.sendJson(res, 201, { ok: true, invocation: recorded.entry, created: recorded.created });
  }
  if (req.method === 'PATCH') {
    const body = await readJson(req, 64 * 1024);
    const id = body && typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) throw new HttpError(400, 'id is required');
    const status = body && typeof body.status === 'string' ? body.status.trim() : '';
    if (!invocationLedger.STATUSES.has(status)) throw new HttpError(400, 'unknown invocation status');
    // Capability-specific approval authority: a server-prepared animatic
    // child is approved only through its own capability path (Preview this on
    // a stored proposal digest). The generic ledger endpoint must not become
    // an alternate approval route for exact server-prepared invocations.
    const existing = invocationLedger.find(invocationLedger.read(), id);
    if (existing && existing.origin === 'server_prepared' && status === 'approved') {
      throw new HttpError(409, 'server-prepared invocations are approved only through their capability path');
    }
    const entry = invocationLedger.setStatus(id, status);
    if (!entry) throw new HttpError(404, 'no such invocation');
    return core.sendJson(res, 200, { ok: true, invocation: entry });
  }
  throw new HttpError(404, 'not found');
}

function candidateView(record) {
  const view = animaticCandidates.publicRecord(record);
  const id = record && record.candidate && record.candidate.candidate_id;
  return { ...view, review: id ? animaticReview.summaryForCandidate(id) : null };
}

async function handleAnimaticApi(req, res, url, { sourceRights = null, animaticEnv = process.env } = {}) {
  if (req.method === 'POST' && url.pathname === '/api/animatic/pacing-context') {
    const body = await readJson(req, 64 * 1024);
    if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.parentRequestId !== 'string') throw new HttpError(400, 'pacing context accepts only parentRequestId');
    let created;
    try { created = animaticPacingContext.create({ parentRequestId: body.parentRequestId, env: animaticEnv }); } catch (error) { throw asBadRequest(error); }
    return core.sendJson(res, created.created ? 201 : 200, { ok: true, created: created.created, context: animaticPacingContext.publicContext(created.context) });
  }
  const contextMatch = url.pathname.match(/^\/api\/animatic\/pacing-context\/([a-f0-9]{64})$/);
  if (req.method === 'GET' && contextMatch) {
    const context = animaticPacingContext.readByDigest(contextMatch[1]);
    return core.sendJson(res, 200, { ok: true, context: animaticPacingContext.publicContext(context) });
  }
  if (req.method === 'POST' && url.pathname === '/api/animatic/pacing-proposal') {
    const body = await readJson(req, 512 * 1024);
    if (!isObject(body) || !isObject(body.proposal) || typeof body.contextDigest !== 'string' || Object.keys(body).some((key) => !['contextDigest', 'proposal'].includes(key))) {
      throw new HttpError(400, 'pacing proposal requires one stored contextDigest and creative proposal');
    }
    let created;
    try { created = animaticPacing.createFromContext({ contextDigest: body.contextDigest, proposal: body.proposal }); } catch (error) { throw asBadRequest(error); }
    return core.sendJson(res, created.created ? 201 : 200, { ok: true, created: created.created, proposal: animaticPacing.publicProposal(created.proposal) });
  }
  if (req.method === 'GET' && url.pathname === '/api/animatic/pacing-proposals') {
    const shotId = String(url.searchParams.get('shotId') || '').trim() || null;
    const sequenceId = String(url.searchParams.get('sequenceId') || '').trim() || null;
    const contextDigest = String(url.searchParams.get('contextDigest') || '').trim() || null;
    const limit = Number(url.searchParams.get('limit') || 50);
    return core.sendJson(res, 200, { ok: true, proposals: animaticPacingIndex.list({ shotId, sequenceId, contextDigest, limit }) });
  }
  const pacingMatch = url.pathname.match(/^\/api\/animatic\/pacing-proposal\/([a-f0-9]{64})$/);
  if (req.method === 'GET' && pacingMatch) {
    const proposal = animaticPacing.readByDigest(pacingMatch[1]);
    return core.sendJson(res, 200, { ok: true, proposal: animaticPacing.publicProposal(proposal) });
  }
  if (req.method === 'POST' && url.pathname === '/api/animatic/prepare') {
    if (!sourceRights) throw new HttpError(503, 'RAINDESK_SOURCE_RIGHTS is required before animatic preparation');
    const body = await readJson(req, 64 * 1024);
    if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.proposalDigest !== 'string') throw new HttpError(400, 'animatic preparation accepts only one stored proposalDigest');
    let proposal;
    try { proposal = animaticPacing.readByDigest(body.proposalDigest.trim()); } catch (error) { throw asBadRequest(error); }
    if (animaticPacing.freshness(proposal).stale) throw new HttpError(409, 'pacing proposal is stale because its source artwork or direction changed');
    let prepared;
    try { prepared = animaticPreparation.prepare({ parentRequestId: proposal.parentRequestId, snapshotInput: animaticPacing.snapshotInput(proposal), sourceRights }); }
    catch (error) { throw asBadRequest(error); }
    return core.sendJson(res, prepared.created ? 201 : 200, { ok: true, proposal: animaticPacing.publicProposal(proposal), ...prepared });
  }
  if (req.method === 'POST' && url.pathname === '/api/animatic/preview') {
    if (!sourceRights) throw new HttpError(503, 'RAINDESK_SOURCE_RIGHTS is required before animatic preview');
    const body = await readJson(req, 64 * 1024);
    if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.proposalDigest !== 'string') throw new HttpError(400, 'animatic preview accepts only one stored proposalDigest');
    let result;
    try { result = await animaticPreview.preview({ proposalDigest: body.proposalDigest, sourceRights, env: animaticEnv }); }
    catch (error) {
      if (error instanceof HttpError && error.execution) return core.sendJson(res, error.status, { error: error.message, execution: error.execution });
      throw error;
    }
    return core.sendJson(res, result.execution && result.execution.status === 'running' ? 202 : 200, {
      ok: true,
      proposal: result.proposal,
      execution: result.execution,
      candidate: result.candidate,
      retried: result.retried,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/animatic/execute') {
    const body = await readJson(req, 64 * 1024);
    const invocationId = body && typeof body.invocationId === 'string' ? body.invocationId.trim() : '';
    if (!invocationId) throw new HttpError(400, 'invocationId is required');
    try {
      const result = await animaticExecutor.execute(invocationId, { retry: body.retry === true, env: animaticEnv });
      return core.sendJson(res, result.execution.status === 'running' ? 202 : 200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof HttpError && error.execution) return core.sendJson(res, error.status, { error: error.message, execution: error.execution });
      throw error;
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/animatic/candidates') {
    const sequenceId = String(url.searchParams.get('sequenceId') || '').trim() || null;
    const projectId = String(url.searchParams.get('projectId') || '').trim() || null;
    const limit = Number(url.searchParams.get('limit') || 100);
    return core.sendJson(res, 200, { ok: true, candidates: animaticCandidates.list({ sequenceId, projectId, limit }).map(candidateView) });
  }
  if (url.pathname === '/api/animatic/review') {
    if (req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      if (!isObject(body) || Object.keys(body).some((key) => !['candidateId', 'decision', 'note', 'idempotencyKey'].includes(key))) {
        throw new HttpError(400, 'animatic review accepts candidateId, decision, note and idempotencyKey only');
      }
      let result;
      try { result = animaticReview.append(body); } catch (error) { throw asBadRequest(error); }
      return core.sendJson(res, result.created ? 201 : 200, { ok: true, ...result });
    }
    if (req.method === 'GET') {
      const candidateId = String(url.searchParams.get('candidateId') || '').trim() || null;
      const sequenceId = String(url.searchParams.get('sequenceId') || '').trim() || null;
      if (candidateId) return core.sendJson(res, 200, { ok: true, review: animaticReview.summaryForCandidate(candidateId), decisions: animaticReview.list({ candidateId }) });
      if (sequenceId) return core.sendJson(res, 200, { ok: true, review: animaticReview.summaryForSequence(sequenceId), decisions: animaticReview.list({ sequenceId }) });
      throw new HttpError(400, 'candidateId or sequenceId is required');
    }
  }
  if (req.method === 'GET' && /^\/api\/animatic\/snapshot\/[a-f0-9]{64}$/.test(url.pathname)) {
    const digest = url.pathname.slice('/api/animatic/snapshot/'.length);
    return core.sendJson(res, 200, { ok: true, snapshot: animaticPreparation.readPreparedSnapshot(digest) });
  }
  if (req.method === 'GET' && new RegExp(`^/api/animatic/execution/${SAFE_ID_SEGMENT}$`).test(url.pathname)) {
    const id = url.pathname.slice('/api/animatic/execution/'.length);
    const row = animaticExecutionStore.get(id);
    if (!row) throw new HttpError(404, 'no such animatic execution attempt');
    let candidate = null;
    if (row.candidateId) candidate = candidateView(animaticCandidates.read(row.candidateId));
    return core.sendJson(res, 200, { ok: true, execution: animaticExecutionStore.publicRow(row), candidate });
  }
  if (req.method === 'GET' && new RegExp(`^/api/animatic/candidate/${SAFE_ID_SEGMENT}$`).test(url.pathname)) {
    const id = url.pathname.slice('/api/animatic/candidate/'.length);
    return core.sendJson(res, 200, { ok: true, candidate: candidateView(animaticCandidates.read(id)) });
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && /^\/api\/animatic\/artifact\/[a-f0-9]{64}$/.test(url.pathname)) {
    const sha = url.pathname.slice('/api/animatic/artifact/'.length);
    if (req.method === 'HEAD') {
      const item = videoArtifacts.stat(sha);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': item.bytes, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable' });
      res.end(); return;
    }
    videoArtifacts.serve(req, res, sha); return;
  }
  throw new HttpError(404, 'not found');
}

function createServer(deps = {}) {
  const agentImpl = deps.agentImpl || deps.agent || agent;
  const basePartner = deps.partnerImpl || partner.createPartner({ agentImpl });
  const animaticEnv = deps.animaticEnv || process.env;
  const pacingAdvisor = Object.prototype.hasOwnProperty.call(deps, 'pacingAdvisor')
    ? deps.pacingAdvisor
    : (deps.partnerImpl ? null : animaticPacingAdvisor.createAdvisor({ agentImpl }));
  const composedPartner = withAuthoritativeContext(basePartner, { pacingAdvisor, animaticEnv });
  const authToken = deps.authToken || null;
  const sourceRights = deps.sourceRights || animaticEnv.RAINDESK_SOURCE_RIGHTS || null;
  const server = core.createServer({ ...deps, agentImpl, partnerImpl: composedPartner });
  const inherited = server.listeners('request')[0];
  if (typeof inherited !== 'function') throw new Error('inherited Raindesk request listener missing');
  server.removeListener('request', inherited);
  server.on('request', (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || `${core.HOST}:${core.PORT}`}`); } catch (_e) { return inherited(req, res); }
    const composed = characterRoute(url.pathname) || invocationRoute(url.pathname) || animaticRoute(url.pathname);
    if (!composed) return inherited(req, res);
    if (authToken && !core.requestAuthorized(req, authToken)) return inherited(req, res);
    // Same mutation boundary as the core API: composed animatic/character/
    // invocation routes accept only JSON mutations from this origin.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const rawType = String(req.headers['content-type'] || '').trim().toLowerCase();
      if (rawType && !rawType.startsWith('application/json')) {
        return core.sendJson(res, 415, { error: 'JSON APIs accept application/json bodies only' });
      }
    }
    const originHeader = String(req.headers.origin || '').trim();
    if (originHeader) {
      let originParsed;
      try { originParsed = new URL(originHeader); } catch (_e) { originParsed = null; }
      if (!originParsed || originParsed.host !== String(req.headers.host || '')) {
        return core.sendJson(res, 403, { error: 'cross-origin API mutations are not accepted' });
      }
    }
    if (String(req.headers['sec-fetch-site'] || '').trim().toLowerCase() === 'cross-site') {
      return core.sendJson(res, 403, { error: 'cross-site API mutations are not accepted' });
    }
    let promise;
    if (animaticRoute(url.pathname)) promise = handleAnimaticApi(req, res, url, { sourceRights, animaticEnv });
    else if (invocationRoute(url.pathname)) promise = handleInvocationApi(req, res, url);
    else promise = handleCharacterApi(req, res, url);
    return Promise.resolve(promise).catch((error) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'internal error';
      if (!(error instanceof HttpError)) console.error('[raindesk] composed route error:', error); // eslint-disable-line no-console
      try { core.sendJson(res, status, { error: message }); } catch (_e) { res.destroy(); }
    });
  });
  server.raindesk = { ...server.raindesk, partnerImpl: composedPartner, characters, sourceRightsConfigured: Boolean(sourceRights) };
  return server;
}

function start({ host = core.HOST, port = core.PORT, authToken = process.env.RAINDESK_REMOTE_TOKEN || null, allowWildcard = process.env.RAINDESK_ALLOW_WILDCARD === '1' } = {}) {
  return new Promise((resolve, reject) => {
    try { core.validateBindOptions({ host, authToken, allowWildcard }); jobStore.recoverInterrupted(); animaticExecutionStore.recoverInterrupted(); }
    catch (error) { reject(error); return; }
    const server = createServer({ authToken: core.isLoopbackHost(host) ? null : authToken });
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      console.log(`[raindesk] listening on http://${addr.address}:${addr.port}`); // eslint-disable-line no-console
      resolve(server);
    });
  });
}
if (require.main === module) start().catch((error) => { console.error('[raindesk] failed to start:', error); process.exit(1); }); // eslint-disable-line no-console

module.exports = {
  ...core,
  createServer, start,
  resolveCharacterShotId, resolveArtworkShotId, authoritativeArtRevision,
  persistInvocationProposals, withAuthoritativeContext, withCharacterContext,
  handleCharacterApi, handleInvocationApi, handleAnimaticApi, animaticRoute, candidateView,
};
