'use strict';

/*
 * STAGE-1 identity-safe intent protocol (GPT Pro round-6 STAGE-1 DESIGN,
 * docs/reviews/GPT_PRO_ROUND6_VERDICT.md) — implemented as its OWN store so
 * the heavily test-pinned v3 chain is untouched until client cutover.
 *
 * Mechanisms shipped here:
 *   - Server-monotonic generations + client incarnation ids (WindowRef)
 *   - Durable tombstones: a closed incarnation can never be resurrected;
 *     intentional reopen gets a NEW generation
 *   - Idempotent intent receipts keyed (actorId, intentId): same-body replay
 *     returns the original response; reused key with a different body is 409
 *   - Split structural / spatial / viewport revisions — spatial traffic can
 *     never invalidate structural operations again
 *   - Intent ops over typed presentations (no writable state/groupId/dock on
 *     canonical rows; those are DERIVED for the legacy projection)
 *   - Machine-readable conflict taxonomy: 410 WINDOW_GENERATION_GONE,
 *     409 INCARNATION_REPLACED / CONTAINER_CHANGED / GROUP_CHANGED /
 *     IDEMPOTENCY_KEY_REUSED, 422 PRESENTATION_NOT_ALLOWED
 *
 * Deliberately NOT yet (next increment per the design's migration order):
 * v3 route replacement/adapters on these semantics, WindowManager cutover,
 * durable IndexedDB-style client outboxes.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const V4_PATH = path.join(DATA_DIR, 'workspace-v4.json');

const SPACES = new Set(['world', 'screen']);
const DOCK_EDGES = new Set(['left', 'right', 'top', 'bottom']);
const PRESENTATION_KINDS = new Set(['floating', 'docked', 'maximised']);
const WINDOW_TYPES = new Set(['note', 'layers_panel', 'partner_panel', 'generic_panel', 'reference_board', 'character_canvas', 'take_stack', 'character_registry', 'notes_panel', 'partner_proposals', 'sheet', 'sequence_strip', 'beat_trail']);
const ID_RE = /^[a-z0-9_]{1,64}$/;

function now() { return new Date().toISOString(); }
function httpError(status, message, extra) {
  return Object.assign(new HttpError(status, message), extra || {});
}
function assertValidId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw httpError(400, `${label} must match ${ID_RE}`);
  }
  return value;
}

/* ------------------------------------------------------------ persistence */

let cache = null;

function seedFromV3() {
  let v3 = null;
  try {
    v3 = require('./workspace').read();
  } catch (_e) { v3 = null; }
  const windows = [];
  const identities = {};
  const groups = [];
  const shelfMembers = [];
  const groupOf = new Map();
  if (v3 && Array.isArray(v3.groups)) {
    for (const g of v3.groups) {
      for (const id of Array.isArray(g.windowIds) ? g.windowIds : []) groupOf.set(id, g);
    }
  }
  const shelved = new Set(v3 && Array.isArray(v3.shelf && v3.shelf.windowIds) ? v3.shelf.windowIds : []);
  if (v3 && Array.isArray(v3.windows)) {
    for (const win of v3.windows) {
      const incarnationId = crypto.randomUUID();
      const generation = 1;
      identities[win.windowId] = { lastGeneration: generation, latestIncarnationId: incarnationId };
      const isMinimised = win.state === 'minimised';
      const presentation = win.state === 'docked'
        ? { kind: 'docked', edge: win.dock }
        : (isMinimised && win.space === 'screen' && win.dock)
          ? { kind: 'docked', edge: win.dock } // recoverable dock under shelf membership
          : { kind: 'floating' };
      const g = groupOf.get(win.windowId);
      windows.push({
        ref: { windowId: win.windowId, generation, incarnationId },
        type: win.type,
        space: win.space,
        entityRef: win.entityRef || null,
        presentation,
        beforeMaximise: null,
        collapsed: Boolean(win.collapsed) && !isMinimised,
        pinned: Boolean(win.pinned),
        locked: Boolean(win.locked),
        spatial: { x: win.x, y: win.y, width: win.width, height: win.height, rotation: win.rotation || 0, scale: win.scale || 1, zIndex: win.zIndex || 0 },
        structureVersion: 1,
        spatialVersion: 1,
        _groupMembership: g ? g.groupId : null, // consumed below, stripped before persist
        _shelved: isMinimised,
      });
    }
  }
  // Canonical groups keep stored order; members reference generation-1 rows.
  if (v3 && Array.isArray(v3.groups)) {
    for (const g of v3.groups) {
      const members = (Array.isArray(g.windowIds) ? g.windowIds : [])
        .map((id) => windows.find((w) => w.ref.windowId === id))
        .filter(Boolean)
        .filter((w) => !w._shelved) // shelf owns minimised membership (canonical exclusion)
        .map((w) => ({ ...w.ref }));
      if (!members.length) continue;
      groups.push({
        groupId: g.groupId,
        version: 1,
        members,
        active: members.some((m) => m.windowId === g.activeWindowId)
          ? members.find((m) => m.windowId === g.activeWindowId)
          : members[0],
      });
    }
  }
  if (v3 && Array.isArray(v3.shelf && v3.shelf.windowIds)) {
    for (const id of v3.shelf.windowIds) {
      const w = windows.find((row) => row.ref.windowId === id);
      if (w) shelfMembers.push({ ...w.ref });
    }
  }
  for (const row of windows) { delete row._groupMembership; delete row._shelved; }
  return {
    schemaVersion: 4,
    seededAt: now(),
    seededFromV3Revision: v3 ? v3.revision : null,
    identities,
    tombstones: {},
    receipts: {},
    mutations: {},
    windows,
    groups,
    shelf: { version: 1, members: shelfMembers },
    focus: (v3 && v3.activeWindowId) ? findIn(windows, v3.activeWindowId) : null,
    viewport: { pan: { x: 0, y: 0 }, zoom: 1 },
    structuralRevision: 1,
    spatialRevision: 1,
    viewportRevision: 1,
    legacyRevision: v3 ? v3.revision : 1,
  };
}

function findIn(rows, windowId) {
  const hit = rows.find((r) => r.ref.windowId === windowId);
  return hit ? { ...hit.ref } : null;
}

function read() {
  if (cache) return cache;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let raw = null;
  try { raw = fs.readFileSync(V4_PATH, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') { cache = seedFromV3(); atomicWrite(cache); return cache; }
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_e) { throw new HttpError(500, 'workspace-v4 state is corrupt'); }
  if (!parsed || parsed.schemaVersion !== 4 || !Array.isArray(parsed.windows)) {
    throw new HttpError(500, 'workspace-v4 state is malformed');
  }
  cache = parsed;
  return cache;
}

function atomicWrite(state) {
  const tmp = `${V4_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, V4_PATH);
}

function save() { atomicWrite(cache); }

/* ---------------------------------------------------------------- helpers */

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
function bodyHash(body) { return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex'); }

function refEq(a, b) {
  return !!a && !!b && a.windowId === b.windowId && a.generation === b.generation && a.incarnationId === b.incarnationId;
}

/** Resolve an op-carried WindowRef against live state. This function IS the
 * race killer: anything not exactly the live incarnation refuses with the
 * machine-readable code the design names. */
function resolveLive(ws, ref, label) {
  if (!ref || typeof ref !== 'object' || typeof ref.windowId !== 'string'
    || !Number.isInteger(ref.generation) || typeof ref.incarnationId !== 'string') {
    throw httpError(400, `${label || 'window'} must be a full WindowRef {windowId, generation, incarnationId}`);
  }
  const tomb = ws.tombstones[ref.windowId];
  const liveRow = ws.windows.find((w) => w.ref.windowId === ref.windowId);
  if (!liveRow) {
    if (tomb) throw httpError(410, `WINDOW_GENERATION_GONE ${ref.windowId}`, { code: 'WINDOW_GENERATION_GONE', tombstone: tomb });
    throw httpError(404, `unknown window "${ref.windowId}"`);
  }
  if (liveRow.ref.generation !== ref.generation) {
    // Older or future generation named while another one is live.
    throw httpError(409, `INCARNATION_REPLACED ${ref.windowId}`, { code: 'INCARNATION_REPLACed'.toUpperCase(), live: { ...liveRow.ref } });
  }
  if (liveRow.ref.incarnationId !== ref.incarnationId) {
    throw httpError(409, `INCARNATION_REPLACED ${ref.windowId}`, { code: 'INCARNATION_REPLACED', live: { ...liveRow.ref } });
  }
  return liveRow;
}

function assertPresentation(mode, edge) {
  // 'restore' is an operation VERB on setPresentation (beforeMaximise
  // swap-back), not a presentation kind — pass the gate and let the handler
  // enforce its own preconditions.
  if (mode === 'restore') return;
  if (!PRESENTATION_KINDS.has(mode)) {
    throw httpError(422, `PRESENTATION_NOT_ALLOWED: ${String(mode)}`, { code: 'PRESENTATION_NOT_ALLOWED' });
  }
  if (mode === 'docked') {
    if (!DOCK_EDGES.has(edge)) {
      throw httpError(422, 'PRESENTATION_NOT_ALLOWED: docked requires edge left|right|top|bottom', { code: 'PRESENTATION_NOT_ALLOWED' });
    }
  }
}

/* ------------------------------------------------------ intent machinery */

const RECEIPT_LIMIT = 500;
const MUTATION_LIMIT = 200;

function receiptKey(actorId, intentId) { return `${actorId}\u001f${intentId}`; }

/** Receipt/mutation keys join components with \u001f — a component carrying
 * that separator (or any control char) could collide two logical keys into
 * one slot. Refuse control characters outright. */
function assertSafeKeyComponent(kind, value) {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) throw httpError(400, `${kind} must not contain control characters`);
  }
  return value;
}

function evictOldest(map, limit) {
  // Plain-object ledger: string keys preserve insertion order, so drop the
  // first (oldest) entries once over the cap. The old `while (map.size >
  // limit)` was Map-thinking — `size` is undefined on plain objects, the
  // loop never ran, and both caps were silently dead.
  const keys = Object.keys(map);
  const overflow = keys.length - limit;
  for (let i = 0; i < overflow; i++) delete map[keys[i]];
}

/** Group-level helpers shared by several ops. */
function stripFromAllGroups(ws, ref, touchedGroups) {
  for (const group of ws.groups) {
    const before = group.members.length;
    group.members = group.members.filter((m) => !refEq(m, ref));
    if (group.members.length !== before) {
      if (group.active && refEq(group.active, ref)) group.active = group.members[0] || null;
      group.version += 1;
      touchedGroups.push(group);
    }
  }
  ws.groups = ws.groups.filter((g) => g.members.length > 0);
}
function stripFromShelf(ws, ref, touched) {
  const before = ws.shelf.members.length;
  ws.shelf.members = ws.shelf.members.filter((m) => !refEq(m, ref));
  if (ws.shelf.members.length !== before) { ws.shelf.version += 1; touched.push(ws.shelf); }
}
function touchStructural(ws, row) { row.structureVersion += 1; ws.structuralRevision += 1; }

/** Response assembly mirrors the design: only canonical AFFECTED entities. */
function buildResponse(ws, actorId, intentId, duplicate, affected) {
  return {
    ok: true,
    actorId,
    intentId,
    duplicate,
    structuralRevision: ws.structuralRevision,
    spatialRevision: ws.spatialRevision,
    viewportRevision: ws.viewportRevision,
    changed: affected,
    receipt: { kind: affected.kind, appliedAt: now() },
  };
}

/* --------------------------------------------------------------- ops */

const OPS = {
  'window.create'(ws, op, affected) {
    const windowId = assertValidId(op.windowId, 'windowId');
    if (typeof op.incarnationId !== 'string' || op.incarnationId.length < 8 || op.incarnationId.length > 64) {
      throw httpError(400, 'incarnationId must be an 8..64 char client-generated id');
    }
    if (op.type !== undefined && !WINDOW_TYPES.has(op.type)) throw httpError(400, `unknown window type ${op.type}`);
    if (op.space !== undefined && !SPACES.has(op.space)) throw httpError(400, 'space must be world|screen');
    const identity = ws.identities[windowId] || { lastGeneration: 0 };
    // Intentional reopen AFTER a tombstone is legal WITH a new generation +
    // new incarnation; the tombstone keeps refusing OLD incarnations forever.
    const generation = identity.lastGeneration + 1;
    // Receipt-compaction fallback (design §2: "The incarnation ID
    // independently protects window.create after an old receipt has been
    // compacted"). Keyed on INCARNATION — never the recomputed generation,
    // which advances past a committed row whose receipt has since aged out:
    const liveRow = ws.windows.find((w) => w.ref.windowId === windowId);
    const tombstone = ws.tombstones[windowId];
    if (liveRow && liveRow.ref.incarnationId === op.incarnationId) {
      affected.kind = 'window.create';
      affected.windows.push({ ...liveRow }); // lost-response echo: success WITHOUT a second row
      return liveRow;
    }
    if (liveRow) {
      throw httpError(409, `INCARNATION_REPLACED ${windowId}`, { code: 'INCARNATION_REPLACED', live: { ...liveRow.ref } });
    }
    if (tombstone && tombstone.incarnationId === op.incarnationId) {
      // Retrying the create of an ALREADY-CLOSED incarnation must neither
      // resurrect nor reopen — deliberate reopen carries a NEW incarnation.
      throw httpError(410, `WINDOW_GENERATION_GONE ${windowId} (that incarnation was created and closed)`, { code: 'WINDOW_GENERATION_GONE', tombstone });
    }
    const row = {
      ref: { windowId, generation, incarnationId: op.incarnationId },
      type: op.type || 'generic_panel',
      space: op.space || 'screen',
      entityRef: op.entityRef || null,
      presentation: op.presentation || { kind: 'floating' },
      beforeMaximise: null,
      collapsed: false,
      pinned: false,
      locked: false,
      spatial: {
        x: Number.isFinite(op.x) ? op.x : 0, y: Number.isFinite(op.y) ? op.y : 0,
        width: Number.isFinite(op.width) ? op.width : 360, height: Number.isFinite(op.height) ? op.height : 260,
        rotation: 0, scale: 1, zIndex: 0,
      },
      structureVersion: 1,
      spatialVersion: 1,
    };
    assertPresentation(row.presentation.kind, row.presentation.edge);
    ws.identities[windowId] = { lastGeneration: generation, latestIncarnationId: op.incarnationId };
    delete ws.tombstones[windowId]; // reopened intentionally; old incarnation still refused via ref checks
    ws.windows.push(row);
    ws.structuralRevision += 1;
    affected.kind = 'window.create';
    affected.windows.push({ ...row });
    return row;
  },

  'window.close'(ws, op, affected) {
    const row = resolveLive(ws, op.window, 'window');
    const tgs = [];
    stripFromAllGroups(ws, row.ref, tgs); affected.groups.push(...tgs.map((g) => ({ ...g })));
    const shelfWas = ws.shelf.members.length;
    stripFromShelf(ws, row.ref, []);
    if (ws.shelf.members.length !== shelfWas) {
      affected.shelf = { version: ws.shelf.version, members: ws.shelf.members.map((m) => ({ ...m })) };
    }
    ws.windows = ws.windows.filter((w) => w !== row);
    ws.tombstones[row.ref.windowId] = {
      generation: row.ref.generation,
      incarnationId: row.ref.incarnationId,
      closedAt: now(),
      structuralRevision: ws.structuralRevision + 1,
    };
    if (ws.focus && refEq(ws.focus, row.ref)) ws.focus = null;
    ws.structuralRevision += 1;
    affected.kind = 'window.close';
    affected.tombstones.push({ ...ws.tombstones[row.ref.windowId] });
    return row;
  },

  'window.setPresentation'(ws, op, affected) {
    const row = resolveLive(ws, op.window, 'window');
    const mode = op.mode;
    assertPresentation(mode, op.edge);
    if (mode === 'maximised') {
      if (!row.beforeMaximise) row.beforeMaximise = { ...row.presentation };
      row.presentation = { kind: 'maximised' };
    } else if (mode === 'restore') {
      if (!row.beforeMaximise) throw httpError(409, 'nothing to restore: not maximised', { code: 'NOT_MAXIMISED' });
      row.presentation = { ...row.beforeMaximise };
      row.beforeMaximise = null;
    } else if (mode === 'docked') {
      row.presentation = { kind: 'docked', edge: op.edge };
      row.beforeMaximise = null;
    } else {
      row.presentation = { kind: 'floating', ...(op.floatingAt ? { at: { x: op.floatingAt.x, y: op.floatingAt.y } } : {}) };
      row.beforeMaximise = null;
    }
    touchStructural(ws, row);
    affected.kind = 'window.setPresentation';
    affected.windows.push({ ...row });
    return row;
  },

  'window.setFlags'(ws, op, affected) {
    const row = resolveLive(ws, op.window, 'window');
    const patch = op.patch || {};
    for (const key of ['collapsed', 'pinned', 'locked']) {
      if (patch[key] !== undefined) row[key] = Boolean(patch[key]);
    }
    touchStructural(ws, row);
    affected.kind = 'window.setFlags';
    affected.windows.push({ ...row });
    return row;
  },

  'shelf.minimise'(ws, op, affected) {
    const row = resolveLive(ws, op.window, 'window');
    if (!ws.shelf.members.some((m) => refEq(m, row.ref))) {
      const tgs = [];
      stripFromAllGroups(ws, row.ref, tgs); // canonical exclusion enforced in ONE commit
      affected.groups.push(...tgs.map((g) => ({ ...g })));
      ws.shelf.members.push({ ...row.ref });
      ws.shelf.version += 1;
      touchStructural(ws, row); // presentation + collapsed deliberately PRESERVED
    }
    affected.kind = 'shelf.minimise';
    affected.shelf = { version: ws.shelf.version, members: ws.shelf.members.map((m) => ({ ...m })) };
    return row;
  },

  'shelf.restore'(ws, op, affected) {
    const row = resolveLive(ws, op.window, 'window');
    const present = ws.shelf.members.some((m) => refEq(m, row.ref));
    if (present) {
      const touched = [];
      stripFromShelf(ws, row.ref, touched);
      if (touched.length) affected.shelf = { version: ws.shelf.version, members: ws.shelf.members.map((m) => ({ ...m })) };
    }
    if (op.mode === 'floating' || !row.presentation || row.presentation.kind === 'floating') {
      row.presentation = { kind: 'floating', ...(op.floatingAt ? { at: { x: op.floatingAt.x, y: op.floatingAt.y } } : {}) };
    } // mode 'resume': keep the latent presentation exactly (dock edge etc.)
    touchStructural(ws, row);
    affected.kind = 'shelf.restore';
    affected.windows.push({ ...row });
    return row;
  },

  'group.create'(ws, op, affected) {
    if (!Array.isArray(op.members) || op.members.length < 1) throw httpError(400, 'group.create needs members[]');
    const seen = new Set();
    const members = [];
    for (const m of op.members) {
      const row = resolveLive(ws, m, 'member');
      if (seen.has(row.ref.windowId)) throw httpError(400, 'duplicate member in group.create');
      // Shelf ownership WINS over creation claims too (design migration rule;
      // same family as group.join): a shelved ref cannot be pulled into a new
      // group — the caller adopts the canonical shelf instead.
      if (ws.shelf.members.some((sh) => refEq(sh, row.ref))) {
        throw httpError(409, `CONTAINER_CHANGED ${row.ref.windowId}`, {
          code: 'CONTAINER_CHANGED',
          shelf: { version: ws.shelf.version, members: ws.shelf.members.map((x) => ({ ...x })) },
        });
      }
      seen.add(row.ref.windowId);
      members.push({ ...row.ref });
    }
    let groupId = op.groupId;
    if (groupId !== undefined) {
      assertValidId(groupId, 'groupId');
      if (ws.groups.some((g) => g.groupId === groupId)) throw httpError(409, 'groupId already exists', { code: 'GROUP_CHANGED' });
    } else {
      groupId = `grp_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    }
    const tgs = [];
    for (const ref of members) {
      stripFromAllGroups(ws, ref, tgs);
    }
    affected.groups.push(...tgs.map((g) => ({ ...g })));
    const group = { groupId, version: 1, members, active: members.find((m) => m.windowId === (op.active && op.active.windowId)) || members[0] };
    ws.groups.push(group);
    ws.structuralRevision += 1;
    affected.kind = 'group.create';
    affected.groups.push({ ...group });
    affected.createdGroup = { ...group }; // unambiguous selector when prior groups were stripped into affected.groups
    return group;
  },

  'group.join'(ws, op, affected) {
    const row = resolveLive(ws, op.member, 'member');
    let group = null;
    if (op.target && op.target.groupId) {
      group = ws.groups.find((g) => g.groupId === op.target.groupId);
      if (!group) throw httpError(404, `unknown group "${op.target.groupId}"`);
    } else if (op.target && op.target.window) {
      const targetRow = resolveLive(ws, op.target.window, 'target');
      group = ws.groups.find((g) => g.members.some((m) => refEq(m, targetRow.ref)));
      if (!group) throw httpError(409, 'CONTAINER_CHANGED: target window is not grouped', { code: 'CONTAINER_CHANGED' });
    } else {
      throw httpError(400, 'group.join needs target.groupId or target.window');
    }
    const shelved = ws.shelf.members.some((m) => refEq(m, row.ref));
    const here = group.members.some((m) => refEq(m, row.ref));
    if (here) {
      // Re-join of a current member: an idempotent no-op ONLY without
      // ordering/activation directives; with them, the request conflicts
      // with the group's current state.
      if (op.position !== undefined || op.makeActive) {
        throw httpError(409, 'GROUP_CHANGED', { code: 'GROUP_CHANGED', group: { ...group } });
      }
      affected.kind = 'group.join';
      affected.groups.push({ ...group });
      return group;
    }
    const alreadyElsewhere = ws.groups.find((g) => g !== group && g.members.some((m) => refEq(m, row.ref)));
    if (shelved || alreadyElsewhere) {
      throw httpError(409, `CONTAINER_CHANGED ${row.ref.windowId}`, {
        code: 'CONTAINER_CHANGED',
        ...(shelved ? { shelf: { version: ws.shelf.version, members: ws.shelf.members.map((m) => ({ ...m })) } } : {}),
        ...(alreadyElsewhere ? { group: { ...alreadyElsewhere } } : {}),
      });
    }
    if (op.expectedGroupVersion !== undefined && op.expectedGroupVersion !== group.version) {
      throw httpError(409, 'GROUP_CHANGED', { code: 'GROUP_CHANGED', group: { ...group } });
    }
    if (op.position === 'start') group.members.unshift({ ...row.ref });
    else if (Number.isInteger(op.position)) group.members.splice(Math.max(0, Math.min(op.position, group.members.length)), 0, { ...row.ref });
    else group.members.push({ ...row.ref }); // default: end (commutes with other appends)
    if (op.makeActive) group.active = { ...row.ref };
    group.version += 1;
    ws.structuralRevision += 1;
    affected.kind = 'group.join';
    affected.groups.push({ ...group });
    return group;
  },

  'group.leave'(ws, op, affected) {
    const row = resolveLive(ws, op.member, 'member');
    const group = ws.groups.find((g) => g.members.some((m) => refEq(m, row.ref)));
    if (!group) throw httpError(409, `CONTAINER_CHANGED ${row.ref.windowId}`, { code: 'CONTAINER_CHANGED' });
    if (op.expectedGroupId !== undefined && op.expectedGroupId !== group.groupId) {
      throw httpError(409, 'GROUP_CHANGED', { code: 'GROUP_CHANGED', group: { ...group } });
    }
    group.members = group.members.filter((m) => !refEq(m, row.ref));
    if (group.active && refEq(group.active, row.ref)) group.active = group.members[0] || null;
    group.version += 1;
    ws.groups = ws.groups.filter((g) => g.members.length > 0);
    if (op.mode === 'floating' || !row.presentation || row.presentation.kind === 'floating') {
      row.presentation = { kind: 'floating', ...(op.floatingAt ? { at: { x: op.floatingAt.x, y: op.floatingAt.y } } : {}) };
    } // mode 'resume': latent presentation reapplies implicitly
    touchStructural(ws, row);
    ws.structuralRevision += 1;
    affected.kind = 'group.leave';
    affected.windows.push({ ...row });
    affected.groups.push({ ...group });
    return row;
  },

  'group.activate'(ws, op, affected) {
    const group = ws.groups.find((g) => g.groupId === op.groupId);
    if (!group) throw httpError(404, `unknown group "${op.groupId}"`);
    const row = resolveLive(ws, op.member, 'member');
    if (!group.members.some((m) => refEq(m, row.ref))) {
      throw httpError(409, 'CONTAINER_CHANGED', { code: 'CONTAINER_CHANGED', group: { ...group } });
    }
    group.active = { ...row.ref }; // last-write-wins WHILE membership holds
    group.version += 1;
    ws.structuralRevision += 1;
    affected.kind = 'group.activate';
    affected.groups.push({ ...group });
    return group;
  },

  'group.reorder'(ws, op, affected) {
    const group = ws.groups.find((g) => g.groupId === op.groupId);
    if (!group) throw httpError(404, `unknown group "${op.groupId}"`);
    if (op.expectedGroupVersion !== undefined && op.expectedGroupVersion !== group.version) {
      throw httpError(409, 'GROUP_CHANGED', { code: 'GROUP_CHANGED', group: { ...group } });
    }
    const idx = group.members.findIndex((m) => refEq(m, op.member));
    if (idx < 0) throw httpError(409, 'CONTAINER_CHANGED', { code: 'CONTAINER_CHANGED', group: { ...group } });
    const [moved] = group.members.splice(idx, 1);
    if (op.before == null) group.members.push(moved);
    else {
      const bIdx = group.members.findIndex((m) => refEq(m, op.before));
      if (bIdx < 0) { group.members.splice(idx, 0, moved); throw httpError(409, 'CONTAINER_CHANGED: before-member left the group', { code: 'CONTAINER_CHANGED', group: { ...group } }); }
      group.members.splice(bIdx, 0, moved);
    }
    group.version += 1;
    ws.structuralRevision += 1;
    affected.kind = 'group.reorder';
    affected.groups.push({ ...group });
    return group;
  },

  'group.dissolve'(ws, op, affected) {
    let group = null;
    if (op.member) {
      // Member locator (Stage-2 F1 class): identity-exact like every other
      // op — a client dissolving a group whose server id it may never have
      // observed (the create-response swap window) needs no groupId guess.
      const row = resolveLive(ws, op.member, 'member');
      group = ws.groups.find((g) => g.members.some((m) => refEq(m, row.ref)));
      if (!group) throw httpError(409, `CONTAINER_CHANGED ${row.ref.windowId} (member is not grouped)`, { code: 'CONTAINER_CHANGED' });
    } else {
      group = ws.groups.find((g) => g.groupId === op.groupId);
    }
    if (!group) throw httpError(404, `unknown group "${op.groupId}"`);
    if (op.expectedGroupVersion !== undefined && op.expectedGroupVersion !== group.version) {
      throw httpError(409, 'GROUP_CHANGED', { code: 'GROUP_CHANGED', group: { ...group } });
    }
    ws.groups = ws.groups.filter((g) => g !== group); // members keep latent presentations; they simply stop deriving tabbed
    ws.structuralRevision += 1;
    affected.kind = 'group.dissolve';
    affected.groups.push({ ...group, members: [], active: null });
    return group;
  },

  'viewport.set'(ws, op, affected) {
    if (!op.viewport || typeof op.viewport !== 'object' || Array.isArray(op.viewport)) throw httpError(400, 'viewport.set requires a viewport object');
    const finiteOr = (name, value, fallback) => {
      if (value === undefined) return fallback;
      if (!Number.isFinite(value)) throw httpError(400, `viewport.${name} must be finite`);
      return value;
    };
    const pan = op.viewport.pan && typeof op.viewport.pan === 'object' && !Array.isArray(op.viewport.pan)
      ? { x: finiteOr('pan.x', op.viewport.pan.x, ws.viewport.pan.x), y: finiteOr('pan.y', op.viewport.pan.y, ws.viewport.pan.y) }
      : { ...ws.viewport.pan };
    const zoom = finiteOr('zoom', op.viewport.zoom, ws.viewport.zoom);
    if (zoom <= 0) throw httpError(400, 'viewport.zoom must be > 0');
    ws.viewport = { pan, zoom };
    ws.viewportRevision += 1; // viewport traffic never moves structural/spatial revisions
    affected.kind = 'viewport.set';
    affected.viewport = { pan: { ...pan }, zoom }; // echo exactly what applied
  },

  'focus.set'(ws, op, affected) {
    if (op.window == null) { ws.focus = null; }
    else { const row = resolveLive(ws, op.window, 'window'); ws.focus = { ...row.ref }; }
    ws.structuralRevision += 1;
    affected.kind = 'focus.set';
    return null;
  },
};

/* ------------------------------------------------------------- entrypoint */

function applyIntent(input) {
  const actorId = input && typeof input.actorId === 'string' && input.actorId.length <= 64 ? input.actorId : null;
  const intentId = input && typeof input.intentId === 'string' && input.intentId.length <= 64 ? input.intentId : null;
  if (!actorId || !intentId) throw httpError(400, 'actorId and intentId are required (<=64 chars each)');
  assertSafeKeyComponent('actorId', actorId);
  assertSafeKeyComponent('intentId', intentId);
  const op = input.op;
  if (!op || typeof op.kind !== 'string') throw httpError(400, 'op.kind is required');
  const handler = OPS[op.kind];
  if (!handler) throw httpError(400, `unsupported intent "${op.kind}"`);

  const ws = read();
  const key = receiptKey(actorId, intentId);

  // Receipt gate BEFORE any mutation: retries after transport loss replay
  // the original outcome; a different body under a used key refuses loudly.
  const existing = ws.receipts[key];
  const hash = bodyHash({ op });
  if (existing) {
    if (existing.bodyHash !== hash) {
      throw httpError(409, 'IDEMPOTENCY_KEY_REUSED', { code: 'IDEMPOTENCY_KEY_REUSED', intentId });
    }
    const response = JSON.parse(existing.responseJson);
    response.duplicate = true;
    return response;
  }

  const known = input.knownStructuralRevision;
  if (known !== undefined && !Number.isInteger(known)) throw httpError(400, 'knownStructuralRevision must be an integer');

  // Transactional handler execution: a throw mid-mutation must leave NO
  // partial state in the shared cached workspace (disk was always safe —
  // save() runs only after success — but process-local cache would drift).
  const snapshot = JSON.stringify(ws);
  let affected;
  try {
    affected = { kind: op.kind, windows: [], groups: [], tombstones: [], shelf: undefined };
    handler(ws, op, affected);
  } catch (error) {
    cache = JSON.parse(snapshot);
    throw error;
  }

  // Advisory sync context never blocks disjoint work (per-entity codes above
  // carry the real arbitration) — recorded into the receipt for auditing.
  const response = buildResponse(ws, actorId, intentId, false, affected);
  ws.receipts[key] = {
    actorId, intentId, kind: op.kind, bodyHash: hash,
    knownStructuralRevision: known === undefined ? null : known,
    structuralRevision: ws.structuralRevision,
    responseJson: JSON.stringify(response),
    createdAt: now(),
  };
  evictOldest(ws.receipts, RECEIPT_LIMIT);
  save();
  return response;
}

function getReceipt(actorId, intentId) {
  const ws = read();
  const hit = ws.receipts[receiptKey(actorId, intentId)];
  return hit ? JSON.parse(hit.responseJson) : null;
}

/* -------------------------------------------------------- spatial surface */

function applySpatial(windowId, generation, body) {
  const ws = read();
  assertValidId(windowId, 'windowId');
  if (!Number.isInteger(generation)) throw httpError(400, 'generation path segment must be an integer');
  const mutationId = body && typeof body.mutationId === 'string' && body.mutationId.length <= 64 ? body.mutationId : null;
  if (mutationId) assertSafeKeyComponent('mutationId', mutationId);
  // Dedupe scope is (windowId, generation, mutationId): a bare mutationId is
  // global — one window's retry could replay ANOTHER window's cached success.
  const mutationKey = mutationId ? `${windowId}\u001f${generation}\u001f${mutationId}` : null;
  const mutationHash = bodyHash({ incarnationId: body && body.incarnationId, patch: body && body.patch });
  if (mutationKey && ws.mutations[mutationKey]) {
    if (ws.mutations[mutationKey].bodyHash !== mutationHash) {
      // Same discipline as receipts: a used key with a DIFFERENT body is a
      // client bug — refuse loudly instead of acking a patch never applied.
      throw httpError(409, 'MUTATION_ID_REUSED', { code: 'MUTATION_ID_REUSED', mutationId });
    }
    const cached = JSON.parse(ws.mutations[mutationKey].responseJson);
    cached.duplicate = true;
    return cached;
  }
  const tomb = ws.tombstones[windowId];
  const row = ws.windows.find((w) => w.ref.windowId === windowId);
  if (!row) {
    if (tomb) throw httpError(410, `WINDOW_GENERATION_GONE ${windowId}`, { code: 'WINDOW_GENERATION_GONE', tombstone: tomb });
    throw httpError(404, `unknown window "${windowId}"`); // spatial traffic NEVER creates rows
  }
  if (row.ref.generation !== generation) {
    throw httpError(410, `WINDOW_GENERATION_GONE ${windowId}`, { code: 'WINDOW_GENERATION_GONE', tombstone: tomb || undefined, live: { ...row.ref } });
  }
  if (!body || typeof body.incarnationId !== 'string' || body.incarnationId !== row.ref.incarnationId) {
    throw httpError(409, `INCARNATION_REPLACED ${windowId}`, { code: 'INCARNATION_REPLACED', live: { ...row.ref } });
  }
  // Migration true-up (Stage-2 P3): the ONE writer of a row's declarative
  // space — a legacy conversion rides the same PATCH that corrects the
  // geometry, so the flag trues up once and no future reload ever
  // re-converts already-world geometry (compounding-drift guard). Space
  // changes ride FRESH mutationIds by design (the hash stays scoped to
  // {incarnationId, patch} for stored-retry compatibility).
  if (body && body.space !== undefined) {
    if (!SPACES.has(body.space)) throw httpError(400, 'body.space must be world|screen');
    row.space = body.space;
  }
  const patch = body.patch || {};
  const SPATIAL_KEYS = ['x', 'y', 'width', 'height', 'rotation', 'scale', 'zIndex'];
  for (const key of SPATIAL_KEYS) { // pass 1: validate ALL keys before ANY mutation
    if (patch[key] !== undefined && !Number.isFinite(patch[key])) throw httpError(400, `patch.${key} must be finite`);
  }
  for (const key of SPATIAL_KEYS) { // pass 2: apply — a late invalid key can never half-apply
    if (patch[key] !== undefined) row.spatial[key] = patch[key];
  }
  row.spatialVersion += 1;
  ws.spatialRevision += 1; // STRUCTURAL revision deliberately untouched
  const response = {
    ok: true,
    spatialRevision: ws.spatialRevision,
    spatialVersion: row.spatialVersion,
    structuralRevision: ws.structuralRevision,
    window: { ...row },
  };
  if (mutationKey) {
    ws.mutations[mutationKey] = { windowId, generation, mutationId, bodyHash: mutationHash, responseJson: JSON.stringify(response), createdAt: now() };
    evictOldest(ws.mutations, MUTATION_LIMIT);
  }
  save();
  return response;
}

/* --------------------------------------------- partner action routing */

/** Partner workspace executor for `window_*` targets (design: receipts and
 * inverses store WindowRef; a revert of a closed-and-reopened window must
 * fail with the identity codes rather than moving the new incarnation).
 * Every verb routes through the SAME intent/spatial lanes any client uses —
 * there is no side door. Legacy panel-namespace and world-namespace targets
 * stay on the v3 executor (Stage 2/3 boundary). */
function applyAction(action = {}) {
  const type = action.type;
  const targetId = action.targetId ? assertValidId(action.targetId, 'targetId') : null;
  if (!targetId || !targetId.startsWith('window_')) {
    throw httpError(400, `v4 applyAction serves window_* targets only (got "${targetId || ''}")`);
  }
  const payload = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload) ? action.payload : {};
  const base = action.actionId ? `act_${String(action.actionId).slice(0, 50)}` : `act_${crypto.randomBytes(6).toString('hex')}`;
  assertSafeKeyComponent('actionId', base);
  let seq = 0;
  const P = (op) => applyIntent({ actorId: 'partner', intentId: `${base}_${seq++}`, op });
  const ws0 = read();
  const row = ws0.windows.find((w) => w.ref.windowId === targetId) || null;
  const onShelf = row && ws0.shelf.members.some((m) => refEq(m, row.ref));
  const ref = action.ref || (row ? { ...row.ref } : null);

  if (type === 'focus') {
    if (!row) throw httpError(404, `unknown workspace object "${targetId}"`);
    const prevFocus = ws0.focus ? { ...ws0.focus } : null;
    P({ kind: 'focus.set', window: ref });
    return { object: { id: targetId }, ref: { ...row.ref }, inverse: { type: 'focus', targetId: prevFocus ? prevFocus.windowId : targetId, ref: prevFocus, payload: {} } };
  }
  if (type === 'move_panel') {
    if (!row) throw httpError(404, `unknown workspace object "${targetId}"`);
    if (row.locked) throw httpError(409, 'workspace object is locked');
    const pre = { x: row.spatial.x, y: row.spatial.y, width: row.spatial.width, height: row.spatial.height, rotation: row.spatial.rotation || 0, scale: row.spatial.scale || 1 };
    const patch = {};
    for (const key of ['x', 'y', 'width', 'height', 'rotation', 'scale']) {
      if (payload[key] !== undefined) {
        if (!Number.isFinite(payload[key])) throw httpError(400, `payload.${key} must be finite`);
        patch[key] = payload[key];
      }
    }
    if (!Object.keys(patch).length) throw httpError(400, 'move_panel needs at least one spatial field');
    const res = applySpatial(targetId, ref.generation, { incarnationId: ref.incarnationId, mutationId: `${base}_${seq++}`, patch });
    return { object: { id: targetId }, ref: { ...res.window.ref }, inverse: { type: 'move_panel', targetId, ref: { ...row.ref }, payload: pre } };
  }
  if (type === 'dock_panel') {
    if (!row) throw httpError(404, `unknown workspace object "${targetId}"`);
    // No row.space guard here (Stage-2 spec review): this lane serves only
    // `window_*` desk windows (the partner-actions prefix gate routes
    // world_* artwork to the v3 executor, which keeps its own guard) — and
    // desk windows with world-unit geometry dock BY DESIGN (docking is a
    // presentation, never a coordinate authority). The old guard blocked
    // exactly the legitimate case: partner-docking a birth-flagged
    // space:'world' freeform surface.
    const pre = row.presentation ? { ...row.presentation } : { kind: 'floating' };
    const edge = payload.dock == null ? null : payload.dock;
    if (edge !== null && !DOCK_EDGES.has(edge)) throw httpError(400, 'invalid dock position');
    P(edge ? { kind: 'window.setPresentation', window: ref, mode: 'docked', edge } : { kind: 'window.setPresentation', window: ref, mode: 'floating' });
    return { object: { id: targetId }, ref: { ...row.ref }, inverse: { type: 'dock_panel', targetId, ref: { ...row.ref }, payload: { dock: pre.kind === 'docked' ? pre.edge : null } } };
  }
  if (type === 'open_panel') {
    if (row && onShelf) {
      P({ kind: 'shelf.restore', window: ref, mode: 'resume' });
      return { object: { id: targetId }, ref: { ...row.ref }, inverse: { type: 'close_panel', targetId, ref: { ...row.ref }, payload: {} } };
    }
    if (row) {
      if (payload.collapsed !== undefined) P({ kind: 'window.setFlags', window: ref, patch: { collapsed: Boolean(payload.collapsed) } });
      P({ kind: 'focus.set', window: ref });
      return { object: { id: targetId }, ref: { ...row.ref }, inverse: { type: 'close_panel', targetId, ref: { ...row.ref }, payload: {} } };
    }
    // Absent or tombstoned: intentional reopen with a NEW incarnation — old
    // incarnations stay dead (the protocol's reopen semantics).
    const incarnationId = `inc_${crypto.randomBytes(8).toString('hex')}`;
    const rowType = payload.type && WINDOW_TYPES.has(payload.type) ? payload.type : 'generic_panel';
    const created = P({ kind: 'window.create', windowId: targetId, incarnationId, type: rowType, x: payload.x, y: payload.y, width: payload.width, height: payload.height });
    const newRef = created.changed.windows[0].ref;
    return { object: { id: targetId }, ref: { ...newRef }, inverse: { type: 'close_panel', targetId, ref: { ...newRef }, payload: {} } };
  }
  if (type === 'close_panel') {
    if (!row) throw httpError(404, `unknown workspace object "${targetId}"`);
    if (!onShelf) P({ kind: 'shelf.minimise', window: ref });
    return { object: { id: targetId }, ref: { ...row.ref }, inverse: { type: 'open_panel', targetId, ref: { ...row.ref }, payload: {} } };
  }
  throw httpError(400, `workspace cannot execute action "${type}"`);
}

/* ------------------------------------------------- legacy writer guarding */

/** Tombstone guard for the CURRENT v3 routes: once an id has a v4 tombstone
 * and no live v4 row, ungated legacy upserts must NOT resurrect it — the
 * stale-tab resurrection race the protocol exists to kill. Ids v4 has never
 * heard of flow through unchanged, so pure-v3 behavior is untouched. */
function assertLegacyWriteAllowed(windowId) {
  const ws = read();
  const tomb = ws.tombstones[windowId];
  const live = ws.windows.some((w) => w.ref.windowId === windowId);
  if (tomb && !live) {
    throw httpError(410, `WINDOW_GENERATION_GONE ${windowId} (tombstoned by the identity protocol)`, { code: 'WINDOW_GENERATION_GONE', tombstone: tomb });
  }
}

/* -------------------------------------------------------------- projection */

/** Canonical v4 read (no receipts/mutations internals). */
function readV4() {
  const ws = read();
  return {
    schemaVersion: 4,
    seededFromV3Revision: ws.seededFromV3Revision,
    windows: ws.windows.map(({ ref, type, space, entityRef, presentation, beforeMaximise, collapsed, pinned, locked, spatial, structureVersion, spatialVersion }) => (
      { ref: { ...ref }, type, space, entityRef, presentation: { ...presentation }, beforeMaximise: beforeMaximise ? { ...beforeMaximise } : null, collapsed, pinned, locked, spatial: { ...spatial }, structureVersion, spatialVersion }
    )),
    groups: ws.groups.map((g) => ({ groupId: g.groupId, version: g.version, members: g.members.map((m) => ({ ...m })), active: g.active ? { ...g.active } : null })),
    shelf: { version: ws.shelf.version, members: ws.shelf.members.map((m) => ({ ...m })) },
    focus: ws.focus ? { ...ws.focus } : null,
    viewport: ws.viewport ? JSON.parse(JSON.stringify(ws.viewport)) : null,
    identities: JSON.parse(JSON.stringify(ws.identities)),
    tombstones: JSON.parse(JSON.stringify(ws.tombstones)),
    structuralRevision: ws.structuralRevision,
    spatialRevision: ws.spatialRevision,
    viewportRevision: ws.viewportRevision,
    legacyRevision: ws.legacyRevision,
  };
}

/** Derived legacy semantics for ONE v4 row (mirror of v3 meanings): a ref in
 * the shelf derives minimised, a group member derives tabbed, otherwise the
 * typed presentation speaks — including its latent dock edge. */
function deriveLegacyState(row, ctx) {
  if (ctx.shelved.has(row.ref.windowId)) return 'minimised';
  if (ctx.grouped.has(row.ref.windowId)) return 'tabbed';
  return row.presentation.kind === 'maximised' ? 'maximised' : row.presentation.kind === 'docked' ? 'docked' : 'floating';
}

module.exports = {
  V4_PATH,
  read,
  readV4,
  applyIntent,
  getReceipt,
  applySpatial,
  applyAction,
  assertLegacyWriteAllowed,
  deriveLegacyState,
};
