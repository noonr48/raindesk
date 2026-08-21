'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Scratch data dir BEFORE requiring lib modules (they snapshot env at load).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-board-'));
process.env.RAINDESK_DATA_DIR = scratch;

const board = require('../../lib/board');

test('readBoard seeds S01-S07 with correct lanes on first access', () => {
  const b = board.readBoard();
  assert.deepEqual(b.lanes, ['set', 'in_dev', 'unplanned']);
  assert.equal(b.shots.length, 7);
  assert.deepEqual(b.shots.map((s) => s.id), ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07']);
  for (const s of b.shots.slice(0, 3)) assert.equal(s.lane, 'in_dev');
  for (const s of b.shots.slice(3)) assert.equal(s.lane, 'unplanned');
  // seeded to disk as valid JSON (atomic write happened)
  const raw = JSON.parse(fs.readFileSync(path.join(scratch, 'board.json'), 'utf8'));
  assert.equal(raw.shots[0].id, 'S01');
  assert.ok(raw.updatedAt);
});

test('moveShot round-trips: move persists across reads', () => {
  const after = board.moveShot('S01', 'set');
  assert.equal(after.shots.find((s) => s.id === 'S01').lane, 'set');
  // fresh read must see the same state (write went through tmp+rename)
  const reread = board.readBoard();
  assert.equal(reread.shots.find((s) => s.id === 'S01').lane, 'set');
  // move back
  board.moveShot('S01', 'in_dev');
  assert.equal(board.readBoard().shots.find((s) => s.id === 'S01').lane, 'in_dev');
  // no stray tmp files left behind
  const files = fs.readdirSync(scratch).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(files, []);
});

test('moveShot rejects unknown lane and unknown shot', () => {
  assert.throws(() => board.moveShot('S01', 'planned'), (e) => e.status === 400);
  assert.throws(() => board.moveShot('S99', 'set'), (e) => e.status === 404);
  // state unchanged after failures
  assert.equal(board.readBoard().shots.find((s) => s.id === 'S01').lane, 'in_dev');
});

test('empty-project mode: seed gate suppresses S01-S07 on fresh boards', () => {
  const emptyScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-board-empty-'));
  const savedDir = process.env.RAINDESK_DATA_DIR;
  try {
    process.env.RAINDESK_DATA_DIR = emptyScratch;
    // Fresh module instance bound to the new scratch dir; swap its BOARD_PATH
    // (the module reads it at call time through the exported binding).
    delete require.cache[require.resolve('../../lib/board')];
    const fresh = require('../../lib/board');
    const b = fresh.readBoard({ seed: false });
    assert.deepEqual(b.shots, [], 'fresh empty-project board has zero shots');
    assert.deepEqual(b.lanes, ['set', 'in_dev', 'unplanned'], 'lanes remain valid');
    const raw = JSON.parse(fs.readFileSync(fresh.BOARD_PATH, 'utf8'));
    assert.deepEqual(raw.shots, [], 'empty board persisted without the seed');
  } finally {
    process.env.RAINDESK_DATA_DIR = savedDir;
    delete require.cache[require.resolve('../../lib/board')];
    require('../../lib/board');
    fs.rmSync(emptyScratch, { recursive: true, force: true });
  }
});
