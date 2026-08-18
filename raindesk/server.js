'use strict';

/**
 * Raindesk server composition layer.
 *
 * The inherited server remains byte-for-byte in server-core.js. Character
 * Anchors is composed here so the feature can add authenticated registry
 * routes and authoritative shot-character context without widening the core
 * route surface or teaching the browser to forge Partner evidence.
 */

const core = require('./server-core');
const characters = require('./lib/characters');
const invocationLedger = require('./lib/partner-invocation-ledger');
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

function withCharacterContext(basePartner) {
  if (!basePartner || typeof basePartner.turn !== 'function') {
    throw new Error('partnerImpl.turn is required');
  }
  return {
    ...basePartner,
    async turn(input = {}) {
      const context = isObject(input.context) ? { ...input.context } : {};
      const shotId = resolveCharacterShotId(context);
      if (shotId) {
        try {
          // Server-side registry state is authoritative. Browser-supplied
          // characterAnchors is never allowed to override persisted identity.
          context.characterAnchors = characters.contextForShot(shotId);
        } catch (_e) {
          // Character context must not strand the creative conversation.
        }
      }
      return basePartner.turn({ ...input, context });
    },
  };
}

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
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (_e) {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

function characterRoute(pathname) {
  return pathname === '/api/characters' ||
    pathname === '/api/character' ||
    pathname === '/api/character/shot-binding';
}

function invocationRoute(pathname) {
  return pathname === '/api/invocations';
}

function asBadRequest(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(400, error && error.message ? error.message : 'invalid character data');
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
      // Recording a newer proposed/approved invocation for a shot supersedes
      // prior pending ones (stale-marking) so a reload never restores two
      // competing approvals for the same creative scope.
      if (body.supersede && typeof body.shotId === 'string' && body.shotId.trim()) {
        invocationLedger.markStaleSuperseded({ shotId: body.shotId, requestId: body.requestId || body.id || '' });
      }
      let recorded;
      try { recorded = invocationLedger.record(body); } catch (error) { throw asBadRequest(error); }
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

function createServer(deps = {}) {
  const agentImpl = deps.agentImpl || deps.agent || agent;
  const basePartner = deps.partnerImpl || partner.createPartner({ agentImpl });
  const composedPartner = withCharacterContext(basePartner);
  const authToken = deps.authToken || null;
  const server = core.createServer({ ...deps, agentImpl, partnerImpl: composedPartner });

  const inherited = server.listeners('request')[0];
  if (typeof inherited !== 'function') throw new Error('inherited Raindesk request listener missing');
  server.removeListener('request', inherited);
  server.on('request', (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || `${core.HOST}:${core.PORT}`}`); }
    catch (_e) { return inherited(req, res); }

    if (!characterRoute(url.pathname) && !invocationRoute(url.pathname)) return inherited(req, res);
    // Let the inherited server perform the normal remote unlock response for
    // unauthorized requests. Authorized character/invocation routes stay here.
    if (authToken && !core.requestAuthorized(req, authToken)) return inherited(req, res);

    const handler = invocationRoute(url.pathname) ? handleInvocationApi : handleCharacterApi;
    return handler(req, res, url).catch((error) => {
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

  server.raindesk = { ...server.raindesk, partnerImpl: composedPartner, characters };
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
  withCharacterContext,
  handleCharacterApi,
};
