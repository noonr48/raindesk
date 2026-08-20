'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = require.resolve('../../public/js/animatic-takes');

function loadModule() {
  delete require.cache[MODULE_PATH];
  const previous = global.self;
  global.self = { crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' } };
  const mod = require(MODULE_PATH);
  if (previous === undefined) delete global.self;
  else global.self = previous;
  return mod;
}

test('animatic take helpers present duration and derived review state in artist language', () => {
  const mod = loadModule();
  const record = {
    candidate: {
      candidate_id: 'candidate_a',
      media: { duration: { num: 14, den: 3 } },
    },
    review: { latestDecision: { decision: 'another' }, isCurrentKeep: false },
  };
  assert.equal(mod.candidateId(record), 'candidate_a');
  assert.equal(mod.durationLabel(record), '4.7 s');
  assert.equal(mod.decisionLabel(record), 'another requested');
  assert.equal(mod.decisionLabel({ ...record, review: { isCurrentKeep: true } }), 'kept');
  const key = mod.makeIdempotencyKey('candidate_a', 'keep');
  assert.match(key, /^animatic:candidate_a:keep:/);
  assert.ok(key.length <= 160);
});

test('animatic reviewer surface loads after chat and before surface handoff/app boot', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const api = html.indexOf('js/api.js');
  const animaticApi = html.indexOf('js/animatic-api.js');
  const chat = html.indexOf('js/chat.js');
  const takes = html.indexOf('js/animatic-takes.js');
  const handoff = html.indexOf('js/surface-handoff.js');
  const app = html.indexOf('js/app.js');
  assert.ok(api >= 0 && animaticApi > api, 'animatic API extension loads after base API');
  assert.ok(chat >= 0 && takes > chat, 'take surface patches an existing ChatDrawer');
  assert.ok(handoff > takes, 'surface handoff wraps the already animatic-aware ChatDrawer');
  assert.ok(app > handoff, 'all drawer composition completes before app boot');
  assert.match(html, /css\/animatic-takes\.css/);
});

test('animatic take cards use native video and keep review choices honest', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'animatic-takes.js'), 'utf8');
  assert.match(source, /createElement\('video'\)/);
  assert.match(source, /\['keep', 'Keep'\]/);
  assert.match(source, /\['another', 'Another'\]/);
  assert.match(source, /\['reject', 'Reject'\]/);
  assert.match(source, /\['combine', 'Combine'\]/);
  assert.match(source, /Combine needs candidate-bound review notes first/);
  assert.match(source, /button\.disabled = true/);
  assert.match(source, /different rhythm/);
  assert.doesNotMatch(source, /run_dir|RAINDESK_ANIMATIC_EXECUTOR|implementationRef/);
});

test('ordinary image-Take redraw cannot strand durable animatic review state', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'animatic-takes.js'), 'utf8');
  const chatSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
  // One stable host per surface replaces the old MutationObserver repair
  // loop: the animatic surface renders only into its drawer-owned host, so
  // image-Take redraws physically cannot remove it. Behavioral interleaving
  // proofs live in tests/frontend/drawer-dom-ownership.test.js; the native
  // acceptance journey is dev/browser-animatic-reload-smoke.js.
  assert.doesNotMatch(source, /new MutationObserver/);
  assert.doesNotMatch(source, /keepSectionAttached/);
  assert.match(chatSource, /animatic-takes-host/);
  assert.match(chatSource, /image-takes-host/);
  assert.match(chatSource, /listeners\.tab\.forEach\(\(f\) => f\(tab\)\)/);
  assert.match(source, /api\.listAnimaticCandidates\(\{ limit: 50 \}\)/);
});
