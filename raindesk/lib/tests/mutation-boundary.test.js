'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-mutation-boundary-'));
process.env.RAINDESK_DATA_DIR = scratch;

const ledger = require('../partner-invocation-ledger');
const { createServer } = require('../../server');

const agentEcho = { chat: async (m) => `echo: ${m}` };

async function withServer(t, fn) {
  const server = createServer({ agentImpl: agentEcho });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  t.after(() => new Promise((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fn(`http://127.0.0.1:${server.address().port}`);
}

test('text/plain JSON mutations are refused before route logic (415)', async (t) => {
  await withServer(t, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 415);
    assert.match((await res.json()).error, /application\/json/);
  });
});

test('foreign Origin mutations are refused (403) on core and composed routes', async (t) => {
  await withServer(t, async (base) => {
    for (const route of ['/api/chat', '/api/invocations']) {
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify(route === '/api/chat' ? { message: 'hi' } : { id: 'inv_x', requestId: 'inv_x', origin: 'http_legacy', adapterId: 'a', capabilityId: 'c', disposition: 'proposal', status: 'proposed' }),
      });
      assert.equal(res.status, 403, `${route} must refuse foreign origins`);
      assert.match((await res.json()).error, /cross-origin/);
    }
  });
});

test('clearly cross-site Sec-Fetch-Site mutations are refused (403)', async (t) => {
  await withServer(t, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /cross-site/);
  });
});

test('rebound Host headers (same-port DNS rebinding) are refused (403)', async (t) => {
  await withServer(t, async (base) => {
    // fetch() cannot set a forged Host (forbidden header, silently rewritten),
    // so drive the socket directly — exactly what a rebound browser does.
    const { hostname, port } = new URL(base);
    const raw = await new Promise((resolve, reject) => {
      const req = require('node:http').request({
        host: hostname, port, method: 'POST', path: '/api/chat',
        headers: {
          'Content-Type': 'application/json',
          Origin: `http://evil.example:${port}`,
          Host: `evil.example:${port}`,
          'Sec-Fetch-Site': 'same-origin',
        },
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ message: 'hi' }));
    });
    assert.equal(raw.status, 403);
    assert.match(raw.body, /served address/);
  });
});

test('owner-configured hostnames (RAINDESK_ALLOWED_HOSTS) pass the Host allowlist', async (t) => {
  await withServer(t, async (base) => {
    const { hostname, port } = new URL(base);
    const saved = process.env.RAINDESK_ALLOWED_HOSTS;
    process.env.RAINDESK_ALLOWED_HOSTS = 'desk.local,studio.lan';
    const raw = await new Promise((resolve, reject) => {
      const req = require('node:http').request({
        host: hostname, port, method: 'POST', path: '/api/chat',
        headers: {
          'Content-Type': 'application/json',
          Origin: `http://desk.local:${port}`,
          Host: `desk.local:${port}`,
          'Sec-Fetch-Site': 'same-origin',
        },
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ message: 'hi' }));
    });
    if (saved === undefined) delete process.env.RAINDESK_ALLOWED_HOSTS; else process.env.RAINDESK_ALLOWED_HOSTS = saved;
    assert.equal(raw.status, 200, 'allowlisted hostname reaches route logic');
    assert.match(raw.body, /echo: hi/);
    // And an unlisted hostname is still refused.
    process.env.RAINDESK_ALLOWED_HOSTS = 'desk.local';
    const blocked = await new Promise((resolve, reject) => {
      const req = require('node:http').request({
        host: hostname, port, method: 'POST', path: '/api/chat',
        headers: {
          'Content-Type': 'application/json',
          Origin: `http://other.example:${port}`,
          Host: `other.example:${port}`,
          'Sec-Fetch-Site': 'same-origin',
        },
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ message: 'hi' }));
    });
    if (saved === undefined) delete process.env.RAINDESK_ALLOWED_HOSTS; else process.env.RAINDESK_ALLOWED_HOSTS = saved;
    assert.equal(blocked.status, 403);
    assert.match(blocked.body, /served address/);
  });
});

test('same-origin JSON mutations still reach route logic', async (t) => {
  await withServer(t, async (base) => {
    const host = new URL(base).host;
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Host: host, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reply, 'echo: hi');
  });
});

test('generic invocation PATCH cannot approve server-prepared animatic children', async (t) => {
  const id = 'inv_server_prepared_guard';
  ledger.record({
    id, requestId: id, origin: 'server_prepared', parentRequestId: `parent_${id}`,
    turnId: `turn_${id}`, shotId: 'S01', adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing',
    stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass', invocationBoundary: 'external',
    disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId: 'S01', artRevisionId: 'rev_any', selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'], requiredInputs: ['SequenceSourceSnapshot@0.2.0'],
    expectedOutputs: ['SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'], sideEffects: ['creates_animatic_candidate'], status: 'proposed',
  });
  await withServer(t, async (base) => {
    const res = await fetch(`${base}/api/invocations`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'approved' }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /capability path/);
    // The ledger entry itself is untouched — approval still belongs to the
    // capability path (Preview this on a stored proposal digest).
    assert.equal(ledger.find(ledger.read(), id).status, 'proposed');
  });
});

test('legacy/partner invocations remain approvable through the ledger endpoint', async (t) => {
  await withServer(t, async (base) => {
    const created = await (await fetch(`${base}/api/invocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'inv_legacy_ok', requestId: 'inv_legacy_ok', adapterId: 'local_image_take', capabilityId: 'image_gen', disposition: 'proposal', status: 'proposed' }),
    })).json();
    assert.equal(created.ok, true);
    const res = await fetch(`${base}/api/invocations`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'inv_legacy_ok', status: 'approved' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).invocation.status, 'approved');
  });
});
