'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

test('Character Anchors browser joinery loads API extension before the feature', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const api = html.indexOf('js/character-api.js');
  const anchors = html.indexOf('js/character-anchors.js');
  assert.ok(api >= 0, 'character API extension is loaded');
  assert.ok(anchors > api, 'Character Anchors loads after its API methods');
});

test('Character Anchors API extension exposes registry and shot-binding calls', () => {
  const api = require('../../public/js/character-api.js');
  for (const name of ['listCharacters', 'upsertCharacter', 'getShotCharacters', 'setShotCharacters']) {
    assert.equal(typeof api[name], 'function', `${name} is available`);
  }
});

test('server and Partner entrypoints compose character authority explicitly', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const partner = fs.readFileSync(path.join(ROOT, 'lib/partner.js'), 'utf8');
  assert.match(server, /server-core/);
  assert.match(server, /characters\.contextForShot/);
  assert.match(server, /\/api\/character\/shot-binding/);
  const planCore = fs.readFileSync(path.join(ROOT, 'lib/partner-plan-core.js'), 'utf8');
  assert.match(partner, /partner-plan-core/);
  assert.match(partner, /adapter-invocations/);
  assert.match(planCore, /require\('\.\/partner-core'\)/);
  assert.match(planCore, /characterAnchors/);
  assert.match(planCore, /never pretend you visually inspected it/);
});
