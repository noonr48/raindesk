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

/** Read (seeding on first access). Always returns a validated board object. */
function readBoard() {
  let raw;
  try {
    raw = fs.readFileSync(BOARD_PATH, 'utf8');
  } catch (_e) {
    writeBoard({ ...SEED_BOARD, updatedAt: new Date().toISOString() });
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

/** Move a shot to a lane; validates both ids; returns the updated board. */
function moveShot(shotId, lane) {
  if (!LANES.includes(lane)) {
    throw new HttpError(400, `unknown lane "${lane}" (expected one of: ${LANES.join(', ')})`);
  }
  const board = readBoard();
  const shot = board.shots.find((s) => s.id === shotId);
  if (!shot) throw new HttpError(404, `unknown shot "${shotId}"`);
  shot.lane = lane;
  board.updatedAt = new Date().toISOString();
  writeBoard(board);
  return board;
}

module.exports = { LANES, SEED_BOARD, BOARD_PATH, readBoard, writeBoard, moveShot, getShot };
