'use strict';

/**
 * Durable, lightweight Partner conversation memory.
 *
 * This is deliberately separate from the Direction Graph: Watch mode may
 * remember a conversation without mutating creative semantics. The store keeps
 * only compact conversational/project references, never rendered board images
 * or full context packets.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const TURNS_PATH = path.join(DATA_DIR, 'partner-turns.json');
const MAX_TURNS = 1200;

function now() { return new Date().toISOString(); }
function text(value, max = 12000) {
  const s = value == null ? '' : String(value).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function compactObject(value, maxChars = 12000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= maxChars) return JSON.parse(raw);
  } catch (_e) { return null; }
  return null;
}
function emptyStore() { return { schemaVersion: 1, turns: [], createdAt: now(), updatedAt: now() }; }
function atomicWrite(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${TURNS_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, TURNS_PATH);
}
function read() {
  let raw;
  try { raw = fs.readFileSync(TURNS_PATH, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') { const store = emptyStore(); atomicWrite(store); return store; }
    throw e;
  }
  let value;
  try { value = JSON.parse(raw); } catch (_e) { throw new HttpError(500, 'partner turn memory is corrupt'); }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.turns)) {
    throw new HttpError(500, 'partner turn memory is malformed');
  }
  return value;
}
function record(input = {}) {
  const store = read();
  const createdAt = now();
  const turn = {
    id: `turn_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
    projectId: text(input.projectId, 128) || 'project',
    sceneId: text(input.sceneId, 128) || null,
    shotId: text(input.shotId, 128) || null,
    userMessage: text(input.userMessage),
    partnerMessage: text(input.partnerMessage),
    permissionMode: ['watch', 'suggest', 'act'].includes(input.permissionMode) ? input.permissionMode : 'suggest',
    interpretation: compactObject(input.interpretation, 8000),
    nextMoves: Array.isArray(input.nextMoves) ? input.nextMoves.slice(0, 3).map((m) => ({
      label: text(m && m.label, 200), prompt: text(m && m.prompt, 1500), kind: text(m && m.kind, 64),
    })) : [],
    workflowIds: Array.isArray(input.workflow) ? input.workflow.map((w) => text(w && (w.id || w), 128)).filter(Boolean).slice(0, 8) : [],
    boardActions: Array.isArray(input.boardActions) ? input.boardActions.slice(0, 12).map((a) => compactObject(a, 3000)).filter(Boolean) : [],
    intentId: text(input.intentId, 128) || null,
    capturedBeatId: text(input.captured && input.captured.beatId, 128) || null,
    createdAt,
  };
  store.turns.push(turn);
  if (store.turns.length > MAX_TURNS) store.turns.splice(0, store.turns.length - MAX_TURNS);
  store.updatedAt = createdAt;
  atomicWrite(store);
  return turn;
}
function recent({ projectId = 'project', sceneId = null, shotId = null, limit = 8 } = {}) {
  const n = Math.max(1, Math.min(32, Number(limit) || 8));
  let turns = read().turns.filter((t) => t.projectId === projectId);
  // Prefer exact active-shot history, but retain project-level turns if no shot
  // conversation exists yet.
  if (shotId) {
    const scoped = turns.filter((t) => t.shotId === shotId);
    if (scoped.length) turns = scoped;
  } else if (sceneId) {
    const scoped = turns.filter((t) => t.sceneId === sceneId);
    if (scoped.length) turns = scoped;
  }
  return turns.slice(-n);
}

module.exports = { DATA_DIR, TURNS_PATH, MAX_TURNS, emptyStore, read, record, recent };
