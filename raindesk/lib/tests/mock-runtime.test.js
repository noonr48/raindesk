'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockRuntime } = require('../mock-runtime');

test('mock comfy cycles valid distinct PNG takes without external services', async () => {
  const runtime = createMockRuntime();

  const first = await runtime.comfy.runInpaint({ shotId: 'S01' });
  const second = await runtime.comfy.runInpaint({ shotId: 'S01' });
  const third = await runtime.comfy.runInpaint({ shotId: 'S01' });
  const fourth = await runtime.comfy.runInpaint({ shotId: 'S01' });

  const a = await runtime.comfy.fetchImageBytes(first.images[0]);
  const b = await runtime.comfy.fetchImageBytes(second.images[0]);
  const c = await runtime.comfy.fetchImageBytes(third.images[0]);
  const d = await runtime.comfy.fetchImageBytes(fourth.images[0]);

  for (const bytes of [a, b, c, d]) {
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }

  assert.notDeepEqual(a, b);
  assert.notDeepEqual(b, c);
  assert.deepEqual(a, d);
  assert.equal(first.seed, 41001);
  assert.equal(fourth.seed, 41004);
});

test('mock companion gives a deterministic visible acknowledgement', async () => {
  const runtime = createMockRuntime();
  const reply = await runtime.agent.chat('move Anna slightly farther into the frame');
  assert.match(reply, /move Anna slightly farther into the frame/);
  assert.match(reply, /preview/i);
});
