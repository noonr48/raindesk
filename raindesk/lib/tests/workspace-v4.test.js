'use strict';

/*
 * STAGE-1 v4 protocol discriminators (race-table from GPT_PRO_ROUND6_VERDICT.md
 * STAGE-1 DESIGN §7): each test fails on the pre-protocol world — plain
 * windowId-keyed upserts with a single global revision and no identity.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Own scratch dir: the v4 module seeds itself from whatever v3 store sits
// beside it on first access — here we control that file directly.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-workspace-v4-'));
process.env.RAINDESK_DATA_DIR = scratch;

// Seed a REAL v3 board before first v4 touch: the seeded v4 store must carry
// generations, typed presentations and canonical memberships derived from it.
fs.writeFileSync(path.join(scratch, 'workspace.json'), JSON.stringify({
  schemaVersion: 3,
  revision: 11,
  viewport: { x: 0, y: 0, zoom: 1 },
  activeWindowId: 'w_left',
  windows: [
    { windowId: 'w_left', type: 'note', space: 'world', entityRef: 'note:left', x: 0, y: 0, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 1, state: 'floating', groupId: 'g_pair', collapsed: false, pinned: false, locked: false, dock: null },
    { windowId: 'w_right', type: 'note', space: 'world', entityRef: 'note:right', x: 250, y: 0, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 2, state: 'tabbed', groupId: 'g_pair', collapsed: false, pinned: false, locked: false, dock: null },
    { windowId: 'w_rail', type: 'layers_panel', space: 'screen', entityRef: 'layers:main', x: 0, y: 0, width: 300, height: 400, rotation: 0, scale: 1, zIndex: 3, state: 'docked', groupId: null, collapsed: false, pinned: false, locked: false, dock: 'left' },
  ],
  groups: [{ groupId: 'g_pair', windowIds: ['w_left', 'w_right'], activeWindowId: 'w_right' }],
  shelf: { windowIds: [] },
}));

const MOD = require.resolve('../../lib/workspace-v4');
let v4 = require(MOD);

function freshIncarnation(tag) { return `inc-${tag}-${Math.random().toString(36).slice(2, 10)}`; }

test('seeding derives generations, typed presentations and canonical membership from v3', () => {
  const ws = v4.readV4();
  assert.equal(ws.schemaVersion, 4);
  assert.deepEqual(ws.groups.map((g) => g.groupId), ['g_pair']);
  assert.deepEqual(ws.groups[0].members.map((m) => m.windowId), ['w_left', 'w_right']);
  assert.equal(ws.groups[0].active.windowId, 'w_right');
  assert.equal(ws.focus.windowId, 'w_left');
  const rail = ws.windows.find((w) => w.ref.windowId === 'w_rail');
  assert.deepEqual(rail.presentation, { kind: 'docked', edge: 'left' }, 'dock edge preserved AS PRESENTATION, not a bare field');
  assert.ok(!('state' in rail) && !('groupId' in rail) && !('dock' in rail), 'canonical rows carry NO writable state/groupId/dock');
  for (const win of ws.windows) {
    assert.equal(win.ref.generation, 1);
    assert.ok(win.ref.incarnationId.length >= 8, 'seeded rows carry a durable client-shaped incarnation id');
    assert.ok(ws.identities[win.ref.windowId].lastGeneration >= 1);
  }
});

test('lost-create-response retry: same receipt key replays; different body reuses = 409 IDEMPOTENCY_KEY_REUSED', () => {
  const inc = freshIncarnation('retry');
  const op = { kind: 'window.create', windowId: 'w_retry', incarnationId: inc, type: 'note', x: 1, y: 2 };
  const first = v4.applyIntent({ actorId: 'desk-a', intentId: 'intent-r1', op });
  const replay = v4.applyIntent({ actorId: 'desk-a', intentId: 'intent-r1', op });
  assert.equal(replay.duplicate, true, 'same-body retry replays the receipt');
  assert.equal(replay.changed.windows.length, 1);
  assert.throws(() => v4.applyIntent({ actorId: 'desk-a', intentId: 'intent-r1', op: { kind: 'focus.set', window: null } }),
    (e) => e.status === 409 && e.code === 'IDEMPOTENCY_KEY_REUSED', 'reused key with a different body refuses loudly');
  // Receipts are durable: a FRESH module instance (simulated restart) still replays.
  delete require.cache[MOD];
  v4 = require(MOD);
  const replayAfterRestart = v4.applyIntent({ actorId: 'desk-a', intentId: 'intent-r1', op });
  assert.equal(replayAfterRestart.duplicate, true, 'receipt survives process reload (disk-backed ledger)');
});

test('open→immediate-close race: only the EXACT incarnation closes; reopen gets a NEW generation', () => {
  const incA = freshIncarnation('life');
  const created = v4.applyIntent({ actorId: 'desk-b', intentId: 'life-c', op: { kind: 'window.create', windowId: 'w_life', incarnationId: incA } });
  const ref = created.changed.windows[0].ref;
  assert.equal(ref.generation, 1);
  const closed = v4.applyIntent({ actorId: 'desk-b', intentId: 'life-x', op: { kind: 'window.close', window: ref } });
  assert.equal(closed.changed.tombstones[0].incarnationId, ref.incarnationId);
  // Stale tab re-issues a spatial write against the closed incarnation: 410, never create.
  assert.throws(() => v4.applySpatial('w_life', ref.generation, { incarnationId: ref.incarnationId, patch: { x: 9 } }),
    (e) => e.status === 410 && e.code === 'WINDOW_GENERATION_GONE');
  // Legacy tombstone guard fires while tombstoned AND dead: recreation through
  // current routes would resurrect the row.
  assert.throws(() => v4.assertLegacyWriteAllowed('w_life'), (e) => e.status === 410 && e.code === 'WINDOW_GENERATION_GONE');
  // Intentional reopen: NEW generation, OLD incarnation stays refused forever.
  const incB = freshIncarnation('life');
  const reopened = v4.applyIntent({ actorId: 'desk-b', intentId: 'life-r', op: { kind: 'window.create', windowId: 'w_life', incarnationId: incB } });
  assert.equal(reopened.changed.windows[0].ref.generation, 2, 'reopen carries server-monotonic generation++');
  assert.throws(() => v4.applyIntent({ actorId: 'desk-b', intentId: 'life-f', op: { kind: 'window.setFlags', window: ref, patch: { pinned: true } } }),
    (e) => e.status === 409 && e.code === 'INCARNATION_REPLACED', 'the old incarnation cannot steer the new one');
  // Once LIVE again the guard stops refusing: pure-v3 writers may address the
  // new incarnation, and unknown-to-v4 ids flow through untouched (neutrality).
  assert.doesNotThrow(() => v4.assertLegacyWriteAllowed('w_life'));
  assert.doesNotThrow(() => v4.assertLegacyWriteAllowed('never_heard_of_it'));
});

test('split revisions: spatial traffic never moves structuralRevision; mutationId dedupes lost responses', () => {
  const before = v4.readV4();
  const target = v4.readV4().windows.find((w) => w.ref.windowId === 'w_left');
  const mutationId = 'mut-split-1';
  const r1 = v4.applySpatial(target.ref.windowId, target.ref.generation, { incarnationId: target.ref.incarnationId, mutationId, patch: { x: 42, zIndex: 9 } });
  const mid = v4.readV4();
  assert.equal(mid.structuralRevision, before.structuralRevision, 'structural domain untouched by spatial traffic');
  assert.equal(mid.spatialRevision - before.spatialRevision, 1);
  assert.equal(r1.window.spatial.x, 42);
  const r2 = v4.applySpatial(target.ref.windowId, target.ref.generation, { incarnationId: target.ref.incarnationId, mutationId, patch: { x: 999 } });
  assert.equal(r2.duplicate, true, 'lost-response retry with same mutationId replays');
  assert.equal(r2.window.spatial.x, 42, 'the replayed body carries the ORIGINAL outcome');
  // Generation mismatch is a 410 (the world moved on), not a silent merge:
  assert.throws(() => v4.applySpatial(target.ref.windowId, target.ref.generation + 5, { incarnationId: target.ref.incarnationId, patch: { x: 1 } }),
    (e) => e.status === 410 || e.status === 409);
});

test('typed presentation chain: dock→maximise→restore returns the SAME edge; illegal kinds 422', () => {
  const rail = v4.readV4().windows.find((w) => w.ref.windowId === 'w_rail');
  const W = rail.ref;
  const setP = (intentId, mode, extra) => v4.applyIntent({ actorId: 'pres', intentId, op: { kind: 'window.setPresentation', window: W, mode, ...extra } });
  const maxed = setP('p-max', 'maximised').changed.windows[0];
  assert.equal(maxed.presentation.kind, 'maximised');
  assert.deepEqual(maxed.beforeMaximise, { kind: 'docked', edge: 'left' }, 'prior presentation STORED on maximise');
  const restored = setP('p-res', 'restore').changed.windows[0];
  assert.deepEqual(restored.presentation, { kind: 'docked', edge: 'left' });
  assert.equal(restored.beforeMaximise, null);
  // Dock→maximise→restore must NOT convert the rail to floating (round-5 regression class):
  setP('p-max2', 'maximised');
  const backAgain = setP('p-res2', 'restore').changed.windows[0];
  assert.deepEqual(backAgain.presentation, { kind: 'docked', edge: 'left' });
  assert.throws(() => setP('p-bad', 'sideways'), (e) => e.status === 422 && e.code === 'PRESENTATION_NOT_ALLOWED');
  assert.throws(() => setP('p-bad2', 'docked', { edge: 'diagonal' }), (e) => e.status === 422 && e.code === 'PRESENTATION_NOT_ALLOWED');
});

test('shelf/group exclusion family: shelf wins creation claims; joins of shelved refs refuse with canonical state', () => {
  const left = v4.readV4().windows.find((w) => w.ref.windowId === 'w_left');
  const right = v4.readV4().windows.find((w) => w.ref.windowId === 'w_right');
  v4.applyIntent({ actorId: 'excl', intentId: 'e-min', op: { kind: 'shelf.minimise', window: left.ref } });
  assert.throws(() => v4.applyIntent({ actorId: 'excl', intentId: 'e-gc', op: { kind: 'group.create', members: [left.ref, right.ref] } }),
    (e) => e.status === 409 && e.code === 'CONTAINER_CHANGED' && e.shelf.members.some((m) => m.windowId === 'w_left'),
    'creation claims CANNOT pull a shelved ref out of the shelf');
  let groupId = null;
  {
    const made = v4.applyIntent({ actorId: 'excl', intentId: 'e-solo', op: { kind: 'group.create', members: [right.ref], active: right.ref } });
    groupId = made.changed.createdGroup.groupId; // unambiguous: groups[] also carries stripped records
  }
  assert.throws(() => v4.applyIntent({ actorId: 'excl', intentId: 'e-j', op: { kind: 'group.join', member: left.ref, target: { groupId } } }),
    (e) => e.status === 409 && e.code === 'CONTAINER_CHANGED' && !!e.shelf, 'join of a shelved member carries the canonical shelf record');
  // Self-rejoin without directives = idempotent echo; WITH a directive = conflict.
  const echo = v4.applyIntent({ actorId: 'excl', intentId: 'e-echo', op: { kind: 'group.join', member: right.ref, target: { groupId } } });
  assert.equal(echo.ok, true);
  assert.throws(() => v4.applyIntent({ actorId: 'excl', intentId: 'e-echo2', op: { kind: 'group.join', member: right.ref, target: { groupId }, makeActive: true } }),
    (e) => e.status === 409 && e.code === 'GROUP_CHANGED');
  // Moving between groups via join refuses instead of silently stealing:
  const third = v4.applyIntent({ actorId: 'excl', intentId: 'e-third-c', op: { kind: 'window.create', windowId: 'w_third', incarnationId: freshIncarnation('third') } });
  const thirdRef = third.changed.windows[0].ref;
  const grpB = v4.applyIntent({ actorId: 'excl', intentId: 'e-grpb', op: { kind: 'group.create', members: [thirdRef] } });
  const bId = grpB.changed.createdGroup.groupId;
  assert.throws(() => v4.applyIntent({ actorId: 'excl', intentId: 'e-move', op: { kind: 'group.join', member: right.ref, target: { groupId: bId } } }),
    (e) => e.status === 409 && e.code === 'CONTAINER_CHANGED' && e.group && e.group.groupId === groupId,
    'a member join into ANOTHER group reports where it currently lives');
  void third;
});

test('group lifecycle arbitration: expectedGroupVersion serializes contested reorder/leave/dissolve', () => {
  const made = v4.applyIntent({ actorId: 'arb', intentId: 'a-make', op: { kind: 'window.create', windowId: 'w_arb_a', incarnationId: freshIncarnation('arba') } });
  const made2 = v4.applyIntent({ actorId: 'arb', intentId: 'a-make2', op: { kind: 'window.create', windowId: 'w_arb_b', incarnationId: freshIncarnation('arbb') } });
  const A = made.changed.windows[0].ref;
  const B = made2.changed.windows[0].ref;
  const grp = v4.applyIntent({ actorId: 'arb', intentId: 'a-grp', op: { kind: 'group.create', members: [A, B], active: A } }).changed.groups[0];
  const gid = grp.groupId;
  assert.deepEqual(grp.members.map((m) => m.windowId), ['w_arb_a', 'w_arb_b']);
  // reorder: move B BEFORE A
  const reordered = v4.applyIntent({ actorId: 'arb', intentId: 'a-ro', op: { kind: 'group.reorder', groupId: gid, member: B, before: A } }).changed.groups[0];
  assert.deepEqual(reordered.members.map((m) => m.windowId), ['w_arb_b', 'w_arb_a']);
  // contest: caller saw version BEFORE the reorder → GROUP_CHANGED carries current
  const staleVersion = grp.version;
  assert.throws(() => v4.applyIntent({ actorId: 'arb', intentId: 'a-ro2', op: { kind: 'group.reorder', groupId: gid, member: A, before: B, expectedGroupVersion: staleVersion } }),
    (e) => e.status === 409 && e.code === 'GROUP_CHANGED' && e.group.version > staleVersion);
  // activate last-write-wins while membership holds
  const act = v4.applyIntent({ actorId: 'arb', intentId: 'a-act', op: { kind: 'group.activate', groupId: gid, member: B } }).changed.groups[0];
  assert.equal(act.active.windowId, 'w_arb_b');
  // leave carries resume-mode; last member leaving dissolves implicitly handled by leave path
  const leftRow = v4.applyIntent({ actorId: 'arb', intentId: 'a-leave', op: { kind: 'group.leave', member: B, mode: 'resume' } });
  // Resume semantics: membership NEVER mutated the presentation, so leave
  // keeps it untouched — 'tabbed' derives from the ref alone, and the true
  // presentation re-emerges without a rewrite.
  assert.equal(leftRow.changed.windows[0].presentation.kind, 'floating');
  // Dissolve against the LIVE version (activate/leave bumped it past the
  // reorder snapshot — stale tokens MUST refuse):
  const liveVersion = v4.readV4().groups.find((x) => x.groupId === gid).version;
  assert.throws(() => v4.applyIntent({ actorId: 'arb', intentId: 'a-dis-stale', op: { kind: 'group.dissolve', groupId: gid, expectedGroupVersion: reordered.version } }),
    (e) => e.status === 409 && e.code === 'GROUP_CHANGED', 'stale versions cannot dissolve');
  const dissolved = v4.applyIntent({ actorId: 'arb', intentId: 'a-dis', op: { kind: 'group.dissolve', groupId: gid, expectedGroupVersion: liveVersion } });
  assert.equal(dissolved.changed.groups[0].members.length, 0);
  assert.equal(v4.readV4().groups.some((x) => x.groupId === gid), false);
});

test('advisory knownStructuralRevision NEVER blocks disjoint work (no compare-and-swap magnet)', () => {
  const base = v4.readV4().structuralRevision;
  const created = v4.applyIntent({
    actorId: 'adv', intentId: 'adv-1',
    knownStructuralRevision: base - 1000, // deliberately ancient sync context
    op: { kind: 'window.create', windowId: 'w_adv', incarnationId: freshIncarnation('adv') },
  });
  assert.equal(created.ok, true, 'advisory context must not gate correctness');
  // interleaving foreign structural writes does NOT invalidate queued intents either
  v4.applyIntent({ actorId: 'other', intentId: 'other-1', op: { kind: 'focus.set', window: null } });
  const second = v4.applyIntent({ actorId: 'adv', intentId: 'adv-2', knownStructuralRevision: base - 1000, op: { kind: 'window.setFlags', window: created.changed.windows[0].ref, patch: { locked: true } } });
  assert.equal(second.ok, true);
  assert.equal(second.changed.windows[0].locked, true);
});

test('focus and flag ops obey identity and arbitration rules', () => {
  const ghost = { windowId: 'w_ghosty', generation: 1, incarnationId: freshIncarnation('gh') };
  assert.throws(() => v4.applyIntent({ actorId: 'foc', intentId: 'f-ghost', op: { kind: 'window.setFlags', window: ghost, patch: { pinned: true } } }),
    (e) => e.status === 404, 'unknown logical id is 404 (distinct from superseded)');
  const cleared = v4.applyIntent({ actorId: 'foc', intentId: 'f-clear', op: { kind: 'focus.set', window: null } });
  assert.equal(cleared.ok, true);
  assert.equal(v4.readV4().focus, null);
});

test('create retries survive receipt compaction via incarnation echo (never double-insert)', () => {
  // GPT Pro round-6 STAGE-1 DESIGN §2: "The incarnation ID independently
  // protects window.create after an old receipt has been compacted."
  const inc = freshIncarnation('echo');
  const first = v4.applyIntent({ actorId: 'evict', intentId: 'evict-0', op: { kind: 'window.create', windowId: 'w_echo', incarnationId: inc, type: 'note' } });
  assert.equal(first.ok, true);
  // Drive > RECEIPT_LIMIT (500) intents so the create's own receipt ages out.
  for (let n = 1; n <= 505; n++) {
    v4.applyIntent({ actorId: 'evict', intentId: `evict-${n}`, op: { kind: 'focus.set', window: null } });
  }
  assert.equal(v4.getReceipt('evict', 'evict-0'), null, 'PRECONDITION: the receipt really was compacted (evictOldest must not be dead code)');
  const echo = v4.applyIntent({ actorId: 'evict', intentId: 'evict-0', op: { kind: 'window.create', windowId: 'w_echo', incarnationId: inc, type: 'note' } });
  assert.equal(echo.ok, true, 'compacted-receipt retry echoes SUCCESS, not a mint');
  assert.equal(echo.duplicate, false, 'echo path taken, not the receipt-replay path');
  const rows = v4.readV4().windows.filter((w) => w.ref.windowId === 'w_echo');
  assert.equal(rows.length, 1, 'exactly one live row despite the compacted receipt');
  assert.equal(echo.changed.windows[0].ref.incarnationId, inc);
  assert.equal(echo.changed.windows[0].ref.generation, rows[0].ref.generation);
  // Rival create at the same logical id while the incumbent lives: 409 with the live ref.
  assert.throws(() => v4.applyIntent({ actorId: 'evict', intentId: 'evict-rival', op: { kind: 'window.create', windowId: 'w_echo', incarnationId: inc + 'b' } }),
    (e) => e.status === 409 && e.code === 'INCARNATION_REPLACED' && e.live.incarnationId === inc);
});

test('create retry of an ALREADY-CLOSED incarnation cannot resurrect (410 even with a fresh intentId)', () => {
  const inc = freshIncarnation('dead');
  v4.applyIntent({ actorId: 'dead', intentId: 'dead-c', op: { kind: 'window.create', windowId: 'w_dead', incarnationId: inc, type: 'note' } });
  v4.applyIntent({ actorId: 'dead', intentId: 'dead-x', op: { kind: 'window.close', window: { windowId: 'w_dead', generation: 1, incarnationId: inc } } });
  // Fresh intentId (no receipt to replay) re-issuing the DEAD incarnation's create.
  assert.throws(() => v4.applyIntent({ actorId: 'dead', intentId: 'dead-c-retry', op: { kind: 'window.create', windowId: 'w_dead', incarnationId: inc, type: 'note' } }),
    (e) => e.status === 410 && e.code === 'WINDOW_GENERATION_GONE' && e.tombstone.incarnationId === inc,
    'retrying a dead incarnation must never resurrect or reopen it');
  // Deliberate reopen with a NEW incarnation remains legal.
  const reopened = v4.applyIntent({ actorId: 'dead', intentId: 'dead-c-new', op: { kind: 'window.create', windowId: 'w_dead', incarnationId: inc + 'x' } });
  assert.equal(reopened.changed.windows[0].ref.generation, 2);
});

test('spatial mutationId dedupe is scoped per window+generation (cross-window reuse cannot replay)', () => {
  const incA = freshIncarnation('mutA');
  const incB = freshIncarnation('mutB');
  v4.applyIntent({ actorId: 'mut', intentId: 'mA', op: { kind: 'window.create', windowId: 'w_mut_a', incarnationId: incA, type: 'note' } });
  v4.applyIntent({ actorId: 'mut', intentId: 'mB', op: { kind: 'window.create', windowId: 'w_mut_b', incarnationId: incB, type: 'note' } });
  const first = v4.applySpatial('w_mut_a', 1, { incarnationId: incA, mutationId: 'shared-mid', patch: { x: 11 } });
  assert.equal(first.window.ref.windowId, 'w_mut_a');
  // The SAME mutationId on a DIFFERENT window must NOT replay w_mut_a's success.
  const second = v4.applySpatial('w_mut_b', 1, { incarnationId: incB, mutationId: 'shared-mid', patch: { x: 22 } });
  assert.equal(second.window.ref.windowId, 'w_mut_b');
  assert.equal(second.window.spatial.x, 22);
  assert.ok(!('duplicate' in second));
  // Same window + generation + mutationId still dedupes (lost-response replay).
  const replay = v4.applySpatial('w_mut_a', 1, { incarnationId: incA, mutationId: 'shared-mid', patch: { x: 99 } });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.window.spatial.x, 11, 'replays the ORIGINAL outcome, not the new patch');
});

test('control characters in idempotency key components are refused (no receipt-slot collisions)', () => {
  assert.throws(() => v4.applyIntent({ actorId: 'a\u001fb', intentId: 'x', op: { kind: 'focus.set', window: null } }), (e) => e.status === 400);
  assert.throws(() => v4.applyIntent({ actorId: 'ok', intentId: 'x\u001fy', op: { kind: 'focus.set', window: null } }), (e) => e.status === 400);
});

test('viewport.set bumps only viewportRevision and persists', () => {
  const before = v4.readV4();
  const out = v4.applyIntent({ actorId: 'view', intentId: 'v1', op: { kind: 'viewport.set', viewport: { pan: { x: 30, y: -12 }, zoom: 1.25 } } });
  assert.equal(out.viewportRevision, before.viewportRevision + 1);
  assert.equal(out.structuralRevision, before.structuralRevision, 'viewport traffic never moves structuralRevision');
  const after = v4.readV4();
  assert.deepEqual(after.viewport, { pan: { x: 30, y: -12 }, zoom: 1.25 });
  assert.equal(after.viewportRevision, before.viewportRevision + 1);
});

test('a spatial patch with a late invalid key mutates NOTHING (validate-then-apply)', () => {
  const incC = freshIncarnation('mutC');
  v4.applyIntent({ actorId: 'mut', intentId: 'mC', op: { kind: 'window.create', windowId: 'w_mut_c', incarnationId: incC, type: 'note' } });
  assert.throws(() => v4.applySpatial('w_mut_c', 1, { incarnationId: incC, patch: { x: 77, y: 'bogus' } }), (e) => e.status === 400);
  const row = v4.readV4().windows.find((w) => w.ref.windowId === 'w_mut_c');
  assert.equal(row.spatial.x, 0, 'x never applied despite being valid');
  assert.equal(row.spatialVersion, 1, 'no phantom version bump from a failed patch');
});
