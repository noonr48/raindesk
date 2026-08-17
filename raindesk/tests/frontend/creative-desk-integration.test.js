'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'creative-desk.css'), 'utf8');

test('Creative Desk loads before app and exposes world + tab surfaces', () => {
  assert.match(html, /id="creativeWorld"/);
  assert.match(html, /id="creativeTabs"/);
  assert.ok(html.indexOf('js/creative-desk.js') < html.indexOf('js/app.js'));
  assert.match(css, /\.creative-world/);
  assert.match(css, /\.creative-sheet/);
  assert.match(css, /\.creative-tabs/);
});

test('canvas fit keeps CSS pointer coordinates separate from device raster pixels', () => {
  assert.match(app, /cssScale/);
  assert.match(app, /cssOx/);
  assert.match(app, /cssOy/);
  assert.match(app, /state\.fit\.cssOx/);
  assert.match(app, /state\.fit\.cssScale/);
  assert.match(app, /viewport\.zoom/);
});

test('Space or middle mouse pans the world and wheel zooms around cursor', () => {
  assert.match(app, /e\.button === 1 \|\| \(e\.button === 0 && state\.spaceDown\)/);
  assert.match(app, /kind: 'pan'/);
  assert.match(app, /creativeDesk\.setViewport/);
  assert.match(app, /creativeDesk\.zoomAt/);
  assert.match(app, /addEventListener\('wheel'/);
});

test('Partner context includes the creative world separately from screen-space workspace panels', () => {
  assert.match(app, /creativeDesk: state\.creativeDesk/);
  assert.match(app, /workspace: state\.workspaceUI/);
});
