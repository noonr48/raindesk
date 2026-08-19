'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = require.resolve('../../public/js/animatic-pacing');

function loadModule() {
  delete require.cache[MODULE_PATH];
  const previous = global.self;
  global.self = {};
  const mod = require(MODULE_PATH);
  if (previous === undefined) delete global.self;
  else global.self = previous;
  return mod;
}

test('pacing rhythm helper speaks in beat labels and display seconds, not frame machinery', () => {
  const mod = loadModule();
  const label = mod.rhythmLabel({
    shots: [
      { shotId: 'S01', note: 'wide descent', durationSeconds: 3.25, durationFrames: 78 },
      { shotId: 'S02', note: 'hold on Lena', durationSeconds: 1.5, durationFrames: 36 },
      { shotId: 'S03', note: 'wheel slips', durationSeconds: 0.708, durationFrames: 17 },
    ],
  });
  assert.equal(label, 'wide descent 3.3 s → hold on Lena 1.5 s → wheel slips 0.71 s');
  assert.doesNotMatch(label, /frames|fps|revision|digest|adapter/i);
});

test('pacing surface is wired between chat and Takes so both patch one drawer before app boot', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const chat = html.indexOf('js/chat.js');
  const pacing = html.indexOf('js/animatic-pacing.js');
  const takes = html.indexOf('js/animatic-takes.js');
  const handoff = html.indexOf('js/surface-handoff.js');
  const app = html.indexOf('js/app.js');
  assert.ok(chat >= 0 && pacing > chat);
  assert.ok(takes > pacing);
  assert.ok(handoff > takes);
  assert.ok(app > handoff);
  assert.match(html, /css\/animatic-pacing\.css/);
});

test('Preview this sends only immutable proposal digest and keeps stale proposals inert', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'animatic-pacing.js'), 'utf8');
  assert.match(source, /api\.previewAnimatic\(proposal\.proposalDigest\)/);
  assert.match(source, /preview\.disabled = Boolean\(proposal\.stale\)/);
  assert.match(source, /source changed — ask for a fresh rhythm/);
  assert.match(source, /rough cut is ready in Takes/);
  assert.doesNotMatch(source, /revisionId|sourceRights|adapterId|executor|snapshotInput|invocationId/);
});
