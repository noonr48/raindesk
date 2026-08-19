'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-auth-'));
process.env.RAINDESK_DATA_DIR = scratch;
const { createServer, validateBindOptions } = require('../../server');

async function serve(t, authToken) {
  const server = createServer({ authToken, agentImpl: { chat: async () => 'ok' } });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    for (const s of sockets) s.destroy();
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('remote bind policy refuses unauthenticated and accidental wildcard exposure', () => {
  assert.equal(validateBindOptions({ host: '127.0.0.1', authToken: null }), true);
  assert.throws(() => validateBindOptions({ host: '100.80.1.2', authToken: null }), /REMOTE_TOKEN/);
  assert.throws(() => validateBindOptions({ host: '100.80.1.2', authToken: 'too-short' }), /24 characters/);
  assert.equal(validateBindOptions({ host: '100.80.1.2', authToken: 'a'.repeat(24) }), true);
  assert.throws(() => validateBindOptions({ host: '0.0.0.0', authToken: 'a'.repeat(24) }), /wildcard/);
  assert.equal(validateBindOptions({ host: '0.0.0.0', authToken: 'a'.repeat(24), allowWildcard: true }), true);
  // Owner-directed unprotected remote: env opt-out bypasses the token demand.
  const prevUnprotected = process.env.RAINDESK_REMOTE_UNPROTECTED;
  process.env.RAINDESK_REMOTE_UNPROTECTED = '1';
  try {
    assert.equal(validateBindOptions({ host: '0.0.0.0', authToken: null, allowWildcard: true }), true);
  } finally {
    if (prevUnprotected === undefined) delete process.env.RAINDESK_REMOTE_UNPROTECTED;
    else process.env.RAINDESK_REMOTE_UNPROTECTED = prevUnprotected;
  }
  // Default (no env) still demands the token.
  assert.throws(() => validateBindOptions({ host: '0.0.0.0', authToken: null, allowWildcard: true }), /REMOTE_TOKEN/);
});

test('remote auth supports unlock cookie and bearer access while APIs reject strangers', async (t) => {
  const token = 'correct-horse-raindesk-key-123456';
  const base = await serve(t, token);

  let res = await fetch(`${base}/api/board`);
  assert.equal(res.status, 401);

  res = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /remote desk is private/i);

  res = await fetch(`${base}/__unlock`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  assert.equal(res.status, 303);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^raindesk_auth=/);

  res = await fetch(`${base}/api/board`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(res.status, 200);

  res = await fetch(`${base}/api/board`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});
