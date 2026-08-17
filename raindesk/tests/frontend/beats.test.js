'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BEATS = require('../../public/js/beats');

const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '../../public/js/chat.js'), 'utf8');
const beatsSource = fs.readFileSync(path.join(__dirname, '../../public/js/beats.js'), 'utf8');

test('beat helpers prefer artist wording, hide rejected beats, and reorder without mutating input', () => {
  const beat = { rawDirection: 'clicks tongue while shaking his fist', movement: { actor: 'Tom', timing: 'before the lunge' } };
  assert.equal(BEATS.beatLine(beat), 'clicks tongue while shaking his fist');
  assert.match(BEATS.beatMeta(beat), /Tom/);
  assert.match(BEATS.beatMeta(beat), /before the lunge/);
  const beats = [{ id: 'a', order: 1 }, { id: 'b', order: 2, status: 'rejected' }, { id: 'c', order: 3 }];
  assert.deepEqual(BEATS.visibleBeats({ beats }).map((b) => b.id), ['a', 'c']);
  const visible = BEATS.visibleBeats({ beats });
  assert.deepEqual(BEATS.reorderedIds(visible, 'c', -1), ['c', 'a']);
  assert.deepEqual(visible.map((b) => b.id), ['a', 'c'], 'helper does not mutate the visible beat array');
});

test('frame helper accepts immutable blob-backed visual references', () => {
  const sha = 'a'.repeat(64);
  assert.equal(BEATS.frameImage({ referenceId: sha }), `/api/blob/${sha}`);
  assert.equal(BEATS.frameImage({ imageUrl: '/api/blob/custom' }), '/api/blob/custom');
  assert.equal(BEATS.frameImage({ referenceId: 'not-a-blob-id' }), '');
});

test('Beat Trail is loaded as a minimizable creative panel with start/end and keep/change surfaces', () => {
  assert.match(html, /data-tool="beats"/);
  assert.match(html, /id="beatTrail"/);
  assert.match(html, /js\/beats\.js/);
  assert.match(app, /RaindeskBeats/);
  assert.match(app, /state\.beatTrail\.toggle/);
  assert.match(beatsSource, /shot-frame-strip/);
  assert.match(beatsSource, /constraint-row/);
  assert.match(beatsSource, /onCaptureFrame/);
  assert.match(beatsSource, /setDirectionShotConstraints/);
  assert.match(beatsSource, /active-beat-detail/);
  assert.doesNotMatch(beatsSource, /row\.appendChild\(renderBeatPoseRefs\(beat\)\)/);
});

test('ordinary Partner turns can refresh a visible Beat Trail', () => {
  assert.match(chat, /listeners = \{ open: \[\], close: \[\], turn: \[\], action: \[\] \}/);
  assert.match(chat, /listeners\.turn\.forEach/);
  assert.match(app, /state\.drawer\.on\(['"]turn['"]/);
});

test('Beat Trail pins raw artist wording before Partner enrichment and reuses that beat id', () => {
  const submitAt = beatsSource.indexOf('async function submit()');
  const submitEnd = beatsSource.indexOf('closeBtn.addEventListener', submitAt);
  const submit = beatsSource.slice(submitAt, submitEnd);
  const pinAt = submit.indexOf('await api.createDirectionBeat');
  const partnerAt = submit.indexOf('askPartner(v');
  assert.ok(pinAt !== -1 && partnerAt !== -1 && pinAt < partnerAt, 'raw beat save happens before Partner call');
  assert.match(submit, /precreatedBeatId: pinned\.id/);
  assert.match(submit, /source: \{ kind: 'user_beat_trail' \}/);
});

test('Beat Trail editing is non-destructive by default and exposes active beat context', () => {
  assert.match(beatsSource, /updateDirectionBeat\(beat\.id, \{ status: 'rejected' \}\)/);
  assert.doesNotMatch(beatsSource, /deleteDirectionBeat\(beat\.id/);
  assert.match(beatsSource, /activeBeatId:/);
  assert.match(beatsSource, /selectBeat/);
  assert.match(beatsSource, /reorderDirectionBeats/);
});


test('Partner enrichment stays in the background instead of freezing Beat edits', () => {
  const submitAt = beatsSource.indexOf('async function submit()');
  const submitEnd = beatsSource.indexOf('closeBtn.addEventListener', submitAt);
  const submit = beatsSource.slice(submitAt, submitEnd);
  assert.doesNotMatch(submit, /await askPartner\(v/);
  assert.match(submit, /askPartner\(v[\s\S]*?\.catch\(\(\) => \{\}\)/);
  assert.match(beatsSource, /partnerQueue = Promise\.resolve\(\)/);
  assert.match(beatsSource, /partner-busy/);
});
