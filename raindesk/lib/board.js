'use strict';

/**
 * Board state: data/board.json with atomic tmp+rename writes.
 * Seeds itself from ../BOARD.md (S01–S03 -> in_dev, S04–S07 -> unplanned)
 * on first read, so a fresh checkout needs no manual data setup.
 * Lanes: set / in_dev / unplanned.
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

// Tests may point the whole store at a scratch dir via RAINDESK_DATA_DIR.
const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const BOARD_PATH = path.join(DATA_DIR, 'board.json');

const LANES = ['set', 'in_dev', 'unplanned'];

/* ------------------------------------------------ the film's shot ladder
 * BOARD.md contract: `breakdown -> candidates -> picked -> polish ->
 * fl2va-test -> locked`; one owner verb per push: PICK / RED-LINE / SKIP
 * (skip is legal, free, and re-warms later). `queued` sits BEFORE the ladder
 * (a shot awaiting an upstream lock). Lanes are DERIVED from state so the
 * glanceable counters keep working: locked -> set, queued -> unplanned,
 * everything on the ladder -> in_dev. */
const LADDER = ['breakdown', 'candidates', 'picked', 'polish', 'fl2va-test', 'locked'];
const PRE_LADDER = 'queued';
const STATES = [PRE_LADDER, ...LADDER];
const VERBS = ['PICK', 'RED-LINE', 'SKIP'];
// Agent/mill moves (the machine produces; these are its lawful advances).
const AGENT_ADVANCES = {
  queued: 'breakdown',
  breakdown: 'candidates',
  picked: 'polish',
};
// Owner PICK advances (the owner reacts; picking a candidate / a polish / a test clip).
const PICK_ADVANCES = {
  candidates: 'picked',
  polish: 'fl2va-test',
  'fl2va-test': 'locked',
};

function laneForState(state) {
  if (state === 'locked') return 'set';
  if (state === PRE_LADDER) return 'unplanned';
  return 'in_dev';
}

const SEED_BOARD = {
  lanes: LANES,
  shots: [
    { id: 'S01', beat: "Beat 1 — Names: Anna's manifest, the blank forest-party lines", state: 'breakdown', lane: 'in_dev' },
    { id: 'S02', beat: 'Beat 2 — First crack: the narrow fracture + advance warnings (ears, papers, lantern flames, rain angle, Tate\u2019s coat pulled)', state: 'breakdown', lane: 'in_dev' },
    { id: 'S03', beat: 'Beat 3 — Tate acts: orders the sisters in, runs back, grips Anna\u2019s coat, Liroz catches at threshold', state: 'breakdown', lane: 'in_dev' },
    { id: 'S04', beat: 'Beat 4 — Full failure: the glass sphere breaks as the door closes', state: 'queued', lane: 'unplanned' },
    { id: 'S05', beat: 'Beat 5 — Ship swept away (water draws, surge, moorings tear; Zephrine aboard)', state: 'queued', lane: 'unplanned' },
    { id: 'S06', beat: 'Beats 6–8 — city uproots / Hethrn\u2019s arms manifest at the tower peak / king\u2019s-party cut', state: 'queued', lane: 'unplanned' },
    { id: 'S07', beat: 'Beats 9–13 — flood, tunnel, boats, the Rain Throat, forest-river exit', state: 'queued', lane: 'unplanned' },
  ],
};

function isValidBoard(board) {
  return Boolean(
    board && Array.isArray(board.lanes) && board.lanes.length &&
    Array.isArray(board.shots) &&
    board.shots.every((s) => s && typeof s.id === 'string' && typeof s.lane === 'string'),
  );
}

/** Atomic write: tmp file in the same dir, then rename over the target. */
function writeBoard(board) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${BOARD_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, BOARD_PATH);
}

/** Read (seeding on first access). Always returns a validated board object.
 * RAINDESK_SEED_BOARD=0 (or the emptyProject server option) suppresses the
 * S01-S07 seed so a fresh project opens into a calm blank workspace — the
 * freeform-desk acceptance journey's steps 1-2 require it. */
function readBoard({ seed = null } = {}) {
  const seedAllowed = seed != null ? Boolean(seed) : process.env.RAINDESK_SEED_BOARD !== '0';
  let raw;
  try {
    raw = fs.readFileSync(BOARD_PATH, 'utf8');
  } catch (_e) {
    writeBoard(seedAllowed
      ? { ...SEED_BOARD, updatedAt: new Date().toISOString() }
      : { lanes: LANES, shots: [], updatedAt: new Date().toISOString() });
    return readBoardFile();
  }
  let board;
  try {
    board = JSON.parse(raw);
  } catch (_e) {
    throw new HttpError(500, 'data/board.json is not valid JSON');
  }
  if (!isValidBoard(board)) throw new HttpError(500, 'data/board.json is malformed');
  return board;
}

function readBoardFile() {
  const board = JSON.parse(fs.readFileSync(BOARD_PATH, 'utf8'));
  if (!isValidBoard(board)) throw new HttpError(500, 'data/board.json is malformed');
  return board;
}

function getShot(shotId) {
  const board = readBoard();
  return board.shots.find((s) => s.id === shotId) || null;
}

/** Manual lane move (the v1 lanes-sheet buttons). Lanes are DERIVED from the
 * ladder state, so a manual move is an owner override that picks the state
 * the lane implies: set -> locked, unplanned -> queued, in_dev -> the shot's
 * current ladder state if it is already on the ladder, else breakdown.
 * Lane and state can therefore never disagree (reviewer finding, 2026-09-05). */
function moveShot(shotId, lane) {
  if (!LANES.includes(lane)) {
    throw new HttpError(400, `unknown lane "${lane}" (expected one of: ${LANES.join(', ')})`);
  }
  const board = readBoard();
  const shot = findShot(board, shotId);
  const state = shot.state || PRE_LADDER;
  let to;
  if (lane === 'set') to = 'locked';
  else if (lane === 'unplanned') to = PRE_LADDER;
  else to = (LADDER.includes(state) && state !== 'locked') ? state : 'breakdown';
  if (to !== state) transition(shot, to, { actor: 'owner', verb: 'MOVE', note: `lane ${lane}` });
  else shot.lane = laneForState(state);
  board.updatedAt = new Date().toISOString();
  writeBoard(board);
  return board;
}

function findShot(board, shotId) {
  const shot = board.shots.find((s) => s.id === shotId);
  if (!shot) throw new HttpError(404, `unknown shot "${shotId}"`);
  return shot;
}

function record(shot, entry) {
  if (!Array.isArray(shot.history)) shot.history = [];
  shot.history.push({ ts: new Date().toISOString(), ...entry });
  if (shot.history.length > 200) shot.history = shot.history.slice(-200);
}

function transition(shot, to, entry) {
  const from = shot.state || PRE_LADDER;
  shot.state = to;
  shot.lane = laneForState(to);
  record(shot, { ...entry, from, to });
}

/** Owner verb on a shot (one verb per push). PICK advances along the ladder
 * where the owner has something to pick; RED-LINE keeps the state and counts a
 * correction round (the mill re-runs on it); SKIP changes nothing but is
 * recorded — skipping is lawful and free. Returns the updated board. */
function applyVerb(shotId, verb, { note = '' } = {}) {
  if (!VERBS.includes(verb)) {
    throw new HttpError(400, `unknown verb "${verb}" (expected one of: ${VERBS.join(', ')})`);
  }
  const board = readBoard();
  const shot = findShot(board, shotId);
  const state = shot.state || PRE_LADDER;
  const cleanNote = typeof note === 'string' ? note.slice(0, 500) : '';
  if (verb === 'PICK') {
    const to = PICK_ADVANCES[state];
    if (!to) throw new HttpError(409, `nothing to pick on "${shotId}" while it is "${state}" (PICK applies to: ${Object.keys(PICK_ADVANCES).join(', ')})`);
    transition(shot, to, { actor: 'owner', verb, note: cleanNote });
  } else if (verb === 'RED-LINE') {
    if (!LADDER.includes(state) || state === 'locked') {
      throw new HttpError(409, `nothing to red-line on "${shotId}" while it is "${state}"`);
    }
    shot.redlines = (shot.redlines || 0) + 1;
    record(shot, { actor: 'owner', verb, note: cleanNote, from: state, to: state });
  } else {
    shot.skips = (shot.skips || 0) + 1;
    shot.lastSkippedAt = new Date().toISOString();
    record(shot, { actor: 'owner', verb, note: cleanNote, from: state, to: state });
  }
  board.updatedAt = new Date().toISOString();
  writeBoard(board);
  return board;
}

/** Agent/mill advance: the machine's lawful moves (queued -> breakdown,
 * breakdown -> candidates, picked -> polish). `to` must be the exact next
 * state; anything else is a 409 so the ladder can never be jumped. */
function advanceShot(shotId, to, { note = '', actor = 'agent' } = {}) {
  if (!STATES.includes(to)) {
    throw new HttpError(400, `unknown state "${to}" (expected one of: ${STATES.join(', ')})`);
  }
  const board = readBoard();
  const shot = findShot(board, shotId);
  const state = shot.state || PRE_LADDER;
  if (AGENT_ADVANCES[state] !== to) {
    throw new HttpError(409, `"${shotId}" cannot advance ${state} -> ${to} (agent moves: ${Object.entries(AGENT_ADVANCES).map(([f, t]) => `${f}->${t}`).join(', ')}; owner PICK moves the rest)`);
  }
  transition(shot, to, { actor, verb: 'ADVANCE', note: typeof note === 'string' ? note.slice(0, 500) : '' });
  board.updatedAt = new Date().toISOString();
  writeBoard(board);
  return board;
}

/** Counts per ladder state (for the glanceable chip / Partner context). */
function ladderCounts(board = readBoard()) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const s of board.shots) { const st = STATES.includes(s.state) ? s.state : PRE_LADDER; counts[st] += 1; }
  return counts;
}

module.exports = {
  LANES, LADDER, PRE_LADDER, STATES, VERBS, AGENT_ADVANCES, PICK_ADVANCES,
  SEED_BOARD, BOARD_PATH, readBoard, writeBoard, moveShot, getShot,
  laneForState, applyVerb, advanceShot, ladderCounts,
};
