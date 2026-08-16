'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI = require('../../public/js/workspace-ui');

test('workspace rects are clamped to the usable viewport', () => {
  const r = UI.normalizedRect({ x: -900, y: -80, width: 9000, height: 9000 }, { width: 1200, height: 800 });
  assert.equal(r.x, 16);
  assert.equal(r.y, 66);
  assert.ok(r.width <= 1168);
  assert.ok(r.height <= 768);
});

test('edge snap produces stable dock geometry', () => {
  const right = UI.edgeSnap({ x: 879, y: 100, width: 300, height: 300 }, { width: 1200, height: 800 }, 24);
  assert.equal(right.dock, 'right');
  assert.equal(right.rect.x + right.rect.width, 1184);

  const bottom = UI.edgeSnap({ x: 300, y: 411, width: 300, height: 300 }, { width: 1200, height: 800 }, 24);
  assert.equal(bottom.dock, 'bottom');
  assert.equal(bottom.rect.y + bottom.rect.height, 716);
});

test('peer snap can align both axes without declaring an edge dock', () => {
  const got = UI.peerSnap(
    { x: 309, y: 201, width: 200, height: 180 },
    [{ x: 100, y: 200, width: 200, height: 180 }],
    12,
  );
  assert.equal(got.rect.x, 300);
  assert.equal(got.rect.y, 200);
  assert.equal(got.guideX, 300);
  assert.equal(got.guideY, 200);
});

test('workspace object preserves the stable semantic panel id and transform', () => {
  const obj = UI.toWorkspaceObject(
    { id: 'panel_partner', type: 'partner_panel', zIndex: 123 },
    { x: 900, y: 80, width: 330, height: 580 },
    { dock: 'right', visible: true, collapsed: false },
  );
  assert.deepEqual({ id: obj.id, type: obj.type, dock: obj.dock }, {
    id: 'panel_partner', type: 'partner_panel', dock: 'right',
  });
  assert.equal(obj.width, 330);
});

test('desktop shell is wired into app, scenes, shelf, and persistent Partner context', () => {
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
  const chat = fs.readFileSync(path.join(root, 'public', 'js', 'chat.js'), 'utf8');
  assert.match(html, /js\/workspace-ui\.js/);
  assert.match(html, /id="scenesPanel"/);
  assert.match(html, /id="panelShelf"/);
  assert.match(app, /RaindeskWorkspaceUI/);
  assert.match(app, /panel_partner/);
  assert.match(app, /workspace: state\.workspaceUI/);
  assert.match(css, /workspace-floating-panel/);
  assert.match(css, /workspace-snap-guide/);
  assert.match(chat, /mutatePartnerAction/);
  assert.match(chat, /processPartnerActions/);
});
