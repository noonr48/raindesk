'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GenQueue, MAX_PENDING } = require('../../lib/queue');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(q, id, statuses, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = q.get(id);
    if (job && statuses.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} never reached ${statuses}`);
    await delay(5);
  }
}

test('pending depth is capped: the (MAX_PENDING+1)th job settles as a friendly error immediately', async () => {
  const q = new GenQueue();
  let release;
  const gate = new Promise((r) => { release = r; });
  const ids = [];
  for (let i = 0; i < MAX_PENDING + 1; i++) {
    ids.push(q.submit(() => gate.then(() => ({}))));
  }
  const overflow = q.view(q.get(ids[MAX_PENDING]));
  assert.equal(overflow.status, 'error');
  assert.match(overflow.error, /queue is full/);
  for (let i = 0; i < MAX_PENDING; i++) {
    assert.equal(q.view(q.get(ids[i])).status, 'pending');
  }
  release();
  for (let i = 0; i < MAX_PENDING; i++) {
    await waitFor(q, ids[i], ['done']);
  }
});

test('two jobs run sequentially on one chain (never interleaved)', async () => {
  const q = new GenQueue();
  const order = [];

  const id1 = q.submit(async () => {
    order.push('start1');
    await delay(30);
    order.push('end1');
    return { imageUrl: 'http://127.0.0.1:8188/view?filename=one.png' };
  });
  const id2 = q.submit(async () => {
    order.push('start2');
    await delay(30);
    order.push('end2');
    return { imageUrl: 'http://127.0.0.1:8188/view?filename=two.png' };
  });

  // both pending immediately after submit (job 2 must not start before job 1 ends)
  assert.equal(q.view(q.get(id1)).status, 'pending');
  assert.equal(q.view(q.get(id2)).status, 'pending');

  const j1 = await waitFor(q, id1, ['done']);
  const j2 = await waitFor(q, id2, ['done']);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
  assert.equal(j1.status, 'done');
  assert.equal(q.view(j1).imageUrl, 'http://127.0.0.1:8188/view?filename=one.png');
  assert.equal(q.view(j2).imageUrl, 'http://127.0.0.1:8188/view?filename=two.png');
});

test('a failing job does not break the chain; status becomes error', async () => {
  const q = new GenQueue();
  q.submit(async () => { throw new Error('comfy exploded'); });
  const id2 = q.submit(async () => ({ imageUrl: 'x' }));

  const j1 = await waitFor(q, '1', ['error']);
  assert.equal(j1.status, 'error');
  assert.match(j1.error, /comfy exploded/);
  const v = q.view(j1);
  assert.equal(v.status, 'error');
  assert.equal(v.imageUrl, undefined);

  const j2 = await waitFor(q, id2, ['done']);
  assert.equal(j2.status, 'done');
});

test('get/view handle unknown ids', () => {
  const q = new GenQueue();
  assert.equal(q.get('404'), null);
  assert.equal(q.view(null), null);
});
