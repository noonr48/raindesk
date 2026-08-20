'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-artifact-route-'));
process.env.RAINDESK_DATA_DIR = scratch;

const videoArtifacts = require('../video-artifacts');
const ledger = require('../partner-invocation-ledger');
const { createServer } = require('../../server');

function fakeMp4() {
  // A genuinely valid, tiny MP4 (see fixtures/README.md): the artifact store
  // now structurally validates containers, so header-only fakes are rejected.
  return fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'animatic-tiny.mp4'));
}

async function withServer(t, fn) {
  const server = createServer({ partnerImpl: { turn: async () => ({ reply: 'unused', invocationRequests: [] }) } });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve());
    for (const socket of sockets) socket.destroy();
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fn(`http://127.0.0.1:${server.address().port}`);
}

test('MP4 artifact endpoint supports HEAD, immutable full reads, byte ranges and 416', async (t) => {
  const item = videoArtifacts.putMp4(fakeMp4());
  await withServer(t, async (base) => {
    let res = await fetch(`${base}/api/animatic/artifact/${item.sha}`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(Number(res.headers.get('content-length')), item.bytes);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(res.headers.get('content-type'), 'video/mp4');

    res = await fetch(`${base}/api/animatic/artifact/${item.sha}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fakeMp4());

    res = await fetch(`${base}/api/animatic/artifact/${item.sha}`, { headers: { Range: 'bytes=4-11' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 4-11/${item.bytes}`);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString('ascii'), 'ftypisom');

    res = await fetch(`${base}/api/animatic/artifact/${item.sha}`, { headers: { Range: `bytes=${item.bytes + 100}-${item.bytes + 200}` } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('content-range'), `bytes */${item.bytes}`);
  });
});

test('execute API refuses coarse or unapproved invocation authority before runtime launch', async (t) => {
  ledger.record({
    id: 'coarse_animatic_only', requestId: 'coarse_animatic_only', origin: 'partner_server',
    turnId: 'turn_coarse', shotId: 'S01', adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing',
    stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass', invocationBoundary: 'external',
    disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId: 'S01', artRevisionId: 'rev_any', selectionFingerprint: null, selectionStable: null },
    status: 'proposed',
  });
  await withServer(t, async (base) => {
    const res = await fetch(`${base}/api/animatic/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invocationId: 'coarse_animatic_only' }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /exact server-prepared|approved/i);
  });
});
