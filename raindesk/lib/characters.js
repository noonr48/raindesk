'use strict';

/** Stable character identity anchors and per-shot cast bindings. */
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CHARACTERS_PATH = path.join(DATA_DIR, 'characters.json');
const ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const VIEWS = new Set(['front', 'three_quarter', 'profile', 'expression', 'costume', 'detail', 'other']);
const MAX_ANCHORS = 24;
const MAX_CAST = 16;

function now() { return new Date().toISOString(); }
function emptyRegistry() {
  const ts = now();
  return { schemaVersion: 1, characters: [], bindings: [], createdAt: ts, updatedAt: ts };
}
function assertId(id, what = 'character id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, `bad ${what}`);
  return id;
}
function text(value, max = 500) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function textList(value, maxItems = 24, maxLen = 300) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const clean = text(item, maxLen);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}
function cleanAnchor(raw, index = 0) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'character anchor is malformed');
  const sha = String(raw.sha || '');
  if (!SHA_RE.test(sha)) throw new HttpError(400, 'character anchor has bad blob sha');
  const view = VIEWS.has(raw.view) ? raw.view : 'other';
  const sheetId = raw.sheetId == null ? null : assertId(raw.sheetId, 'anchor sheet id');
  const mediaId = raw.mediaId == null ? null : text(raw.mediaId, 128);
  return {
    id: text(raw.id, 128) || `anchor_${index}`,
    sha,
    sheetId,
    mediaId,
    view,
    label: text(raw.label, 160),
  };
}
function sanitizeCharacter(input = {}, existing = null) {
  const id = assertId(input.id || (existing && existing.id));
  const anchorsInput = input.anchors === undefined ? (existing ? existing.anchors : []) : input.anchors;
  if (!Array.isArray(anchorsInput) || anchorsInput.length > MAX_ANCHORS) throw new HttpError(400, `character anchors must be an array <=${MAX_ANCHORS}`);
  const anchors = anchorsInput.map(cleanAnchor);
  const seen = new Set();
  for (const anchor of anchors) {
    if (seen.has(anchor.id)) throw new HttpError(400, 'character anchor ids must be unique');
    seen.add(anchor.id);
  }
  const locked = input.locked === undefined ? Boolean(existing && existing.locked) : Boolean(input.locked);
  if (locked && anchors.length === 0) throw new HttpError(400, 'locked character identity requires at least one anchor');
  const name = text(input.name === undefined ? (existing && existing.name) : input.name, 200) || id;
  const canonicalSheetId = input.canonicalSheetId === undefined
    ? (existing && existing.canonicalSheetId) || null
    : (input.canonicalSheetId == null ? null : assertId(input.canonicalSheetId, 'canonical sheet id'));
  return {
    id,
    name,
    aliases: input.aliases === undefined ? textList(existing && existing.aliases) : textList(input.aliases),
    canonicalSheetId,
    anchors,
    identityRules: input.identityRules === undefined ? textList(existing && existing.identityRules) : textList(input.identityRules),
    locked,
    createdAt: existing && existing.createdAt || now(),
    updatedAt: now(),
  };
}
function atomicWrite(registry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  registry.updatedAt = now();
  const tmp = `${CHARACTERS_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CHARACTERS_PATH);
  return registry;
}
function read() {
  let raw;
  try { raw = fs.readFileSync(CHARACTERS_PATH, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return atomicWrite(emptyRegistry());
    throw e;
  }
  let registry;
  try { registry = JSON.parse(raw); } catch (_e) { throw new HttpError(500, 'character registry is corrupt'); }
  if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.characters) || !Array.isArray(registry.bindings)) {
    throw new HttpError(500, 'character registry is malformed');
  }
  return registry;
}
function get(id) { return read().characters.find((item) => item.id === assertId(id)) || null; }
function list() { return read().characters.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))); }
function upsert(input = {}) {
  const registry = read();
  const id = assertId(input.id);
  const index = registry.characters.findIndex((item) => item.id === id);
  const existing = index >= 0 ? registry.characters[index] : null;
  const character = sanitizeCharacter(input, existing);
  if (index >= 0) registry.characters[index] = character; else registry.characters.push(character);
  atomicWrite(registry);
  return character;
}
function bindShot(shotId, characterIds = []) {
  const registry = read();
  const cleanShot = assertId(shotId, 'shot id');
  if (!Array.isArray(characterIds) || characterIds.length > MAX_CAST) throw new HttpError(400, `shot cast must be an array <=${MAX_CAST}`);
  const ids = [];
  for (const value of characterIds) {
    const id = assertId(value, 'character id');
    if (!registry.characters.some((character) => character.id === id)) throw new HttpError(404, `unknown character "${id}"`);
    if (!ids.includes(id)) ids.push(id);
  }
  const existing = registry.bindings.find((binding) => binding.shotId === cleanShot);
  if (existing) { existing.characterIds = ids; existing.updatedAt = now(); }
  else registry.bindings.push({ shotId: cleanShot, characterIds: ids, updatedAt: now() });
  atomicWrite(registry);
  return contextForShot(cleanShot, registry);
}
function contextForShot(shotId, registry = null) {
  const cleanShot = assertId(shotId, 'shot id');
  const state = registry || read();
  const binding = state.bindings.find((item) => item.shotId === cleanShot);
  const ids = binding && Array.isArray(binding.characterIds) ? binding.characterIds : [];
  return {
    shotId: cleanShot,
    characterIds: ids.slice(0, MAX_CAST),
    characters: ids.map((id) => state.characters.find((item) => item.id === id)).filter(Boolean).map((character) => ({
      id: character.id,
      name: character.name,
      aliases: (character.aliases || []).slice(0, 12),
      canonicalSheetId: character.canonicalSheetId || null,
      locked: Boolean(character.locked),
      identityRules: (character.identityRules || []).slice(0, 24),
      anchors: (character.anchors || []).slice(0, MAX_ANCHORS).map((anchor) => ({
        id: anchor.id, sha: anchor.sha, sheetId: anchor.sheetId || null,
        mediaId: anchor.mediaId || null, view: anchor.view, label: anchor.label || '',
      })),
    })),
  };
}

module.exports = {
  DATA_DIR, CHARACTERS_PATH, ID_RE, SHA_RE, VIEWS, MAX_ANCHORS, MAX_CAST,
  emptyRegistry, assertId, cleanAnchor, sanitizeCharacter, read, get, list, upsert, bindShot, contextForShot,
};
