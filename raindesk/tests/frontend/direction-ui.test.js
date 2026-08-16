'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');

test('DIRECT is one ordinary canvas tool with a caption handoff', () => {
  assert.equal((html.match(/data-tool="direction"/g) || []).length, 1);
  for (const id of ['directionCaption', 'directionCaptionInput', 'directionCaptionSave', 'directionCaptionCancel']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
});

test('semantic direction bridge loads before app and app persists raw paths through it', () => {
  const dirIdx = html.indexOf('src="js/direction.js"');
  const appIdx = html.indexOf('src="js/app.js"');
  assert.ok(dirIdx !== -1 && appIdx !== -1 && dirIdx < appIdx, 'direction.js loads before app.js');
  assert.match(app, /window\.RaindeskDirection/);
  assert.match(app, /DIR\.interpretAndSavePath/);
  assert.match(app, /DIR\.loadShotMarks/);
  assert.match(app, /kind === 'direction'/);
});

test('Partner can push its interpretation back into the casual drawer', () => {
  assert.match(chat, /function addPartnerNote\(/);
  assert.match(chat, /addPartnerNote,/);
  assert.match(chat, /forEach\(\(n\) => n\.remove\(\)\)/, 'partner suggestion chips clean up without runtime error');
});

test('direction caption is a lightweight overlay rather than a permanent inspector', () => {
  assert.match(css, /\.direction-caption\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.direction-caption\.open\s*\{\s*display:\s*flex/);
  assert.doesNotMatch(css, /direction-caption[^}]*position:\s*fixed/s);
});


test('Partner receives current shot beat + nearby visual directions without a setup form', () => {
  assert.match(chat, /contextProvider/);
  assert.match(app, /function partnerCanvasContext\(/);
  assert.match(app, /legacyBeat:/);
  assert.match(app, /nearbyNotes:/);
});

test('app publishes a real browser boot marker for acceptance screenshots', () => {
  assert.match(app, /dataset\.raindeskBoot\s*=\s*['"]ready['"]/);
});
