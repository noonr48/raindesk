'use strict';

/*
 * The film's shot ladder (BOARD.md): breakdown -> candidates -> picked ->
 * polish -> fl2va-test -> locked, `queued` before it; owner verbs PICK /
 * RED-LINE / SKIP; agent advances. Lanes are derived from state.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-board-ladder-'));
process.env.RAINDESK_DATA_DIR = scratch;

const board = require('../../lib/board');
const { createServer } = require('../../server');

let server; let port;
test.before(async () => {
  server = createServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

async function post(route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('seed carries the BOARD.md ladder states and lanes derive from them', () => {
  const b = board.readBoard();
  assert.deepEqual(board.LADDER, ['breakdown', 'candidates', 'picked', 'polish', 'fl2va-test', 'locked']);
  assert.equal(b.shots.find((s) => s.id === 'S01').state, 'breakdown');
  assert.equal(b.shots.find((s) => s.id === 'S04').state, 'queued');
  assert.equal(board.laneForState('locked'), 'set');
  assert.equal(board.laneForState('queued'), 'unplanned');
  assert.equal(board.laneForState('candidates'), 'in_dev');
});

test('agent advances follow the ladder exactly; jumps are refused with 409', () => {
  assert.throws(() => board.advanceShot('S01', 'picked'), (e) => e.status === 409);
  const b = board.advanceShot('S01', 'candidates', { note: 'mill: 3 keyframe compositions' });
  const s01 = b.shots.find((s) => s.id === 'S01');
  assert.equal(s01.state, 'candidates');
  assert.equal(s01.lane, 'in_dev');
  assert.equal(s01.history.at(-1).from, 'breakdown');
  assert.equal(s01.history.at(-1).to, 'candidates');
  assert.equal(s01.history.at(-1).actor, 'agent');
  assert.throws(() => board.advanceShot('S01', 'nowhere'), (e) => e.status === 400);
  assert.throws(() => board.advanceShot('S99', 'breakdown'), (e) => e.status === 404);
});

test('owner PICK advances only where there is something to pick; RED-LINE counts a round; SKIP is free and recorded', () => {
  // S01 is at candidates now -> PICK -> picked
  let b = board.applyVerb('S01', 'PICK', { note: 'take 2' });
  assert.equal(b.shots.find((s) => s.id === 'S01').state, 'picked');
  // picked -> nothing for the owner to pick until the agent polishes
  assert.throws(() => board.applyVerb('S01', 'PICK'), (e) => e.status === 409);
  b = board.advanceShot('S01', 'polish');
  b = board.applyVerb('S01', 'RED-LINE', { note: 'hand pose' });
  let s01 = b.shots.find((s) => s.id === 'S01');
  assert.equal(s01.state, 'polish', 'red-line keeps the state');
  assert.equal(s01.redlines, 1);
  b = board.applyVerb('S01', 'SKIP');
  s01 = b.shots.find((s) => s.id === 'S01');
  assert.equal(s01.state, 'polish', 'skip changes nothing');
  assert.equal(s01.skips, 1);
  assert.ok(s01.lastSkippedAt);
  b = board.applyVerb('S01', 'PICK');
  assert.equal(b.shots.find((s) => s.id === 'S01').state, 'fl2va-test');
  b = board.applyVerb('S01', 'PICK');
  s01 = b.shots.find((s) => s.id === 'S01');
  assert.equal(s01.state, 'locked');
  assert.equal(s01.lane, 'set', 'locked derives the set lane');
  assert.throws(() => board.applyVerb('S01', 'RED-LINE'), (e) => e.status === 409, 'nothing to red-line once locked');
  assert.throws(() => board.applyVerb('S02', 'DANCE'), (e) => e.status === 400);
  assert.throws(() => board.applyVerb('S04', 'PICK'), (e) => e.status === 409, 'queued shots have nothing to pick');
  const counts = board.ladderCounts();
  assert.equal(counts.locked, 1);
  assert.equal(counts.queued, 4);
  assert.equal(counts.breakdown, 2);
});

test('routes: /api/board/verb, /api/board/advance, /api/board/ladder', async () => {
  const ladder = await (await fetch(`http://127.0.0.1:${port}/api/board/ladder`)).json();
  assert.deepEqual(ladder.verbs, ['PICK', 'RED-LINE', 'SKIP']);
  assert.equal(ladder.shots.find((s) => s.id === 'S01').state, 'locked');
  const adv = await post('/api/board/advance', { shotId: 'S02', to: 'candidates' });
  assert.equal(adv.status, 200, JSON.stringify(adv.json));
  assert.equal(adv.json.ladder.candidates, 1);
  const bad = await post('/api/board/advance', { shotId: 'S02', to: 'locked' });
  assert.equal(bad.status, 409);
  const verb = await post('/api/board/verb', { shotId: 'S02', verb: 'pick', note: 'composition B' });
  assert.equal(verb.status, 200, JSON.stringify(verb.json));
  assert.equal(verb.json.board.shots.find((s) => s.id === 'S02').state, 'picked');
  const missing = await post('/api/board/verb', { verb: 'PICK' });
  assert.equal(missing.status, 400);
  const unknown = await post('/api/board/verb', { shotId: 'S02', verb: 'DANCE' });
  assert.equal(unknown.status, 400);
});
