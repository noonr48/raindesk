'use strict';

/**
 * Raindesk server composition layer.
 *
 * The inherited server remains byte-for-byte in server-core.js. Server-owned
 * creative authority is composed here: character identity comes from the
 * registry, artwork revision identity comes from ShotDocument rather than
 * browser assertions, actionable Partner requests are durably registered
 * before browser exposure, and animatic preparation binds review to one exact
 * source snapshot without exposing local panel paths.
 */

const core = require('./server-core');
const characters = require('./lib/characters');
const invocationLedger = require('./lib/partner-invocation-ledger');
const shotDocuments = require('./lib/shot-documents');
const animaticPreparation = require('./lib/animatic-preparation');
const direction = require('./lib/direction');
const partner = require('./lib/partner');
const agent = require('./lib/agent');
const jobStore = require('./lib/job-store');
const { HttpError } = require('./lib/errors');

const CHARACTER_BODY_LIMIT = 512 * 1024;

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function resolveCharacterShotId(context = {}) {
  if (typeof context.shotId === 'string' && context.shotId.trim()) return context.shotId.trim();
  if (typeof context.legacyShotId === 'string' && context.legacyShotId.trim()) return context.legacyShotId.trim();
  try {
    const graph = direction.readGraph();
    const id = graph && graph.project && graph.project.activeShotId;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch (_e) {
    return null;
  }
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
  } catch (_e) {
    return null;
  }
}

function persistInvocationProposals(result) {
  if (!isObject(result) || !Array.isArray(result.invocationRequests) || !result.invocationRequests.length) return result;
  try {
    for (const request of result.invocationRequests) {
      const recorded = invocationLedger.recordFromRequest(request);
      if (recorded.entry.shotId) {
        invocationLedger.markStaleSuperseded({
          shotId: recorded.entry.shotId,
          requestId: recorded.entry.requestId,
          adapterId: recorded.entry.adapterId,
        });
      }
    }
    return result;
  } catch (error) {
    console.error('[raindesk] invocation proposal persistence failed:', error && error.message ? error.message : error); // eslint-disable-line no-console
    return { ...result, invocationRequests: [], invocationPersistenceError: true };
  }
}

function withAuthoritativeContext(basePartner) {
  if (!basePartner || typeof basePartner.turn !== 'function') {
    throw new Error('partnerImpl.turn is required');
  }
  return {
    ...basePartner,
    async turn(input = {}) {
      const context = isObject(input.context) ? { ...input.context } : {};
      const shotId = resolveCharacterShotId(context);
      if (shotId) {
        try { context.characterAnchors = characters.contextForShot(shotId); }
        catch (_e) { /* identity context must not strand ordinary conversation */ }
      }
      context.artRevisionId = authoritativeArtRevision(context, shotId);
      const result = await basePartner.turn({ ...input, context });
      return persistInvocationProposals(result);
    },
  };
}

const withCharacterContext = withAuthoritativeContext;

function readBody(req, limit = CHARACTER_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new HttpError(413, `request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function readJson(req, limit = CHARACTER_BODY_LIMIT) {
  const bytes = await readBody(req, limit);
  if (!bytes.length) throw new HttpError(400, 'empty request body');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (_e) { throw new HttpError(400, 'request body is not valid JSON'); }
}

function characterRoute(pathname) {
  return pathname === '/api/characters' ||
    pathname === '/api/character' ||
    pathname === '/api/character/shot-binding';
}

function invocationRoute(pathname) {
  return pathname === '/api/invocations';
}

function animaticRoute(pathname) {
  return pathname === '/api/animatic/prepare' || /^\/api\/animatic\/snapshot\/[a-f0-9]{64}$/.test(pathname);
}

function asBadRequest(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(400, error && error.message ? error.message : 'invalid request data');
}

async function handleCharacterApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  if (method === 'GET' && route === '/api/characters') {
    return core.sendJson(res, 200, { characters: characters.list() });
  }

  if (method === 'POST' && route === '/api/character') {
    const body = await readJson(req);
    let character;
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
      if (!body || typeof body.shotId !== 'string' || !body.shotId.trim()) {
        throw new HttpError(400, 'shotId is required');
      }
      let binding;
      try { binding = characters.bindShot(body.shotId.trim(), body.characterIds); } catch (error) { throw asBadRequest(error); }
      return core.sendJson(res, 200, binding);
    }
  }

  throw new HttpError(404, 'not found');
}

async function handleInvocationApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  if (route === '/api/invocations') {
    if (method === 'GET') {
      const shotId = String(url.searchParams.get('shotId') || '').trim() || null;
      const status = String(url.searchParams.get('status') || '').trim() || null;
      return core.sendJson(res, 200, { ok: true, invocations: invocationLedger.list({ shotId, status }) });
    }
    if (method === 'POST') {
      const body = await readJson(req, 256 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'invocation record is required');
      }
      // HTTP POST is a compatibility/history intake only. It may never claim
      // the trusted origins used by Partner proposals or server-prepared work,
      // and it cannot create a pre-approved record. Those origins are minted
      // only by in-process server boundaries.
      let recorded;
      try {
        recorded = invocationLedger.record({ ...body, origin: 'http_legacy', status: 'proposed' });
      } catch (error) {
        throw asBadRequest(error);
      }
      if (body.supersede && recorded.entry.shotId) {
        invocationLedger.markStaleSuperseded({
          shotId: recorded.entry.shotId,
          requestId: recorded.entry.requestId || recorded.entry.id,
          adapterId: recorded.entry.adapterId,
        });
      }
      return core.sendJson(res, 201, { ok: true, invocation: recorded.entry, created: recorded.created });
    }
    if (method === 'PATCH') {
      const body = await readJson(req, 64 * 1024);
      const id = body && typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) throw new HttpError(400, 'id is required');
      const status = body && typeof body.status === 'string' ? body.status.trim() : '';
      if (!invocationLedger.STATUSES.has(status)) throw new HttpError(400, 'unknown invocation status');
      const entry = invocationLedger.setStatus(id, status);
      if (!entry) throw new HttpError(404, 'no such invocation');
      return core.sendJson(res, 200, { ok: true, invocation: entry });
    }
  }

  throw new HttpError(404, 'not found');
}

async function handleAnimaticApi(req, res, url, { sourceRights = null } = {}) {
  if (req.method === 'POST' && url.pathname === '/api/animatic/prepare') {
    if (!sourceRights) throw new HttpError(503, 'RAINDESK_SOURCE_RIGHTS is required before animatic preparation');
    const body = await readJson(req, 512 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'animatic preparation request is required');
    let prepared;
    try {
      prepared = animaticPreparation.prepare({
        parentRequestId: body.parentRequestId,
        snapshotInput: body.snapshot,
        sourceRights,
      });
    } catch (error) {
      throw asBadRequest(error);
    }
    return core.sendJson(res, prepared.created ? 201 : 200, { ok: true, ...prepared });
  }

  if (req.method === 'GET' && /^\/api\/animatic\/snapshot\/[a-f0-9]{64}$/.test(url.pathname)) {
    const digest = url.pathname.slice('/api/animatic/snapshot/'.length);
    return core.sendJson(res, 200, { ok: true, snapshot: animaticPreparation.readPreparedSnapshot(digest) });
  }

  throw new HttpError(404, 'not found');
}

function createServer(deps = {}) {
  const agentImpl = deps.agentImpl || deps.agent || agent;
  const basePartner = deps.partnerImpl || partner.createPartner({ agentImpl });
  const composedPartner = withAuthoritativeContext(basePartner);
  const authToken = deps.authToken || null;
  const sourceRights = deps.sourceRights || process.env.RAINDESK_SOURCE_RIGHTS || null;
  const server = core.createServer({ ...deps, agentImpl, partnerImpl: composedPartner });

  const inherited = server.listeners('request')[0];
  if (typeof inherited !== 'function') throw new Error('inherited Raindesk request listener missing');
  server.removeListener('request', inherited);
  server.on('request', (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || `${core.HOST}:${core.PORT}`}`); }
    catch (_e) { return inherited(req, res); }

    const composed = characterRoute(url.pathname) || invocationRoute(url.pathname) || animaticRoute(url.pathname);
    if (!composed) return inherited(req, res);
    if (authToken && !core.requestAuthorized(req, authToken)) return inherited(req, res);

    let promise;
    if (animaticRoute(url.pathname)) promise = handleAnimaticApi(req, res, url, { sourceRights });
    else if (invocationRoute(url.pathname)) promise = handleInvocationApi(req, res, url);
    else promise = handleCharacterApi(req, res, url);
    return promise.catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'internal error';
      if (!(error instanceof HttpError)) console.error('[raindesk] composed route error:', error); // eslint-disable-line no-console
      try { core.sendJson(res, status, { error: message }); } catch (_e) { res.destroy(); }
    });
  });

  server.raindesk = {
    ...server.raindesk,
    partnerImpl: composedPartner,
    characters,
    sourceRightsConfigured: Boolean(sourceRights),
  };
  return server;
}

function start({
  host = core.HOST,
  port = core.PORT,
  authToken = process.env.RAINDESK_REMOTE_TOKEN || null,
  allowWildcard = process.env.RAINDESK_ALLOW_WILDCARD === '1',
} = {}) {
  return new Promise((resolve, reject) => {
    try {
      core.validateBindOptions({ host, authToken, allowWildcard });
      jobStore.recoverInterrupted();
    } catch (error) {
      reject(error);
      return;
    }
    const server = createServer({ authToken: core.isLoopbackHost(host) ? null : authToken });
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      console.log(`[raindesk] listening on http://${addr.address}:${addr.port}`); // eslint-disable-line no-console
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[raindesk] failed to start:', error); // eslint-disable-line no-console
    process.exit(1);
  });
}

module.exports = {
  ...core,
  createServer,
  start,
  resolveCharacterShotId,
  resolveArtworkShotId,
  authoritativeArtRevision,
  persistInvocationProposals,
  withAuthoritativeContext,
  withCharacterContext,
  handleCharacterApi,
  handleInvocationApi,
  handleAnimaticApi,
  animaticRoute,
};
