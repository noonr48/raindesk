'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-partner-turns-'));
process.env.RAINDESK_DATA_DIR = scratch;
const turns = require('../../lib/partner-turns');

test('Partner turn memory persists compact conversation by shot', () => {
  const a = turns.record({ shotId: 'S01', userMessage: 'try three', partnerMessage: 'I made three rough directions.', permissionMode: 'suggest' });
  const b = turns.record({ shotId: 'S01', userMessage: 'use the second one', partnerMessage: 'Keeping the second direction.', permissionMode: 'suggest' });
  turns.record({ shotId: 'S02', userMessage: 'different shot', partnerMessage: 'Got it.' });
  const recent = turns.recent({ shotId: 'S01', limit: 8 });
  assert.deepEqual(recent.map((t) => t.id), [a.id, b.id]);
  assert.equal(recent[1].userMessage, 'use the second one');
  assert.ok(fs.existsSync(turns.TURNS_PATH));
});

test('Partner turn memory is bounded and rejects giant nested payloads instead of bloating project memory', () => {
  const saved = turns.record({
    userMessage: 'small', partnerMessage: 'small',
    interpretation: { huge: 'x'.repeat(20000) },
    boardActions: [{ type: 'arrange', payload: { huge: 'x'.repeat(10000) } }],
  });
  assert.equal(saved.interpretation, null);
  assert.deepEqual(saved.boardActions, []);
});
