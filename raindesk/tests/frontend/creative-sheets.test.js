'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const desk = require('../../public/js/creative-desk');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/creative-desk.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../public/css/creative-desk.css'), 'utf8');

test('Creative Sheets use sheet: entity refs without replacing stable world object ids', () => {
  assert.equal(desk.sheetIdFromEntityRef('sheet:sheet_character_primary'), 'sheet_character_primary');
  assert.equal(desk.sheetIdFromEntityRef('character:primary'), null);
  assert.equal(desk.worldObjectIdForSheet('sheet_character_primary'), 'world_character_primary');
  assert.equal(desk.worldObjectIdForSheet('sheet_random_1'), 'world_sheet_sheet_random_1');
  const seed = desk.sheetObjectSeed({ sheetId: 'sheet_random_1', kind: 'sketch' }, { x: 5, y: 8, visible: true });
  assert.equal(seed.space, 'world');
  assert.equal(seed.entityRef, 'sheet:sheet_random_1');
  assert.equal(seed.x, 5);
  assert.equal(seed.y, 8);
});

test('Creative Desk exposes raw drawing, dynamic plus tab, rename/undo and tab round-trip contracts', () => {
  assert.match(source, /class="creative-sheet-canvas"/);
  assert.match(source, /dataset\.creativeNewSheet = '1'/);
  assert.match(source, /createLooseSheet/);
  assert.match(source, /overTabs\(ev\.clientX, ev\.clientY\)/);
  assert.match(source, /queueSheetSave\(state\.sheetId, 'draw sheet stroke'\)/);
  assert.match(source, /reason = 'edit sheet'/);
  assert.match(source, /contenteditable/);
  assert.match(source, /classList\.contains\('desk-panning'\)/);
  assert.match(source, /catch \(_e\) \{ \/\* keep the desk usable offline/);
  assert.match(css, /\.creative-sheet-canvas/);
  assert.match(css, /desk-panning \.creative-sheet-canvas/);
});

test('Partner Creative Desk context is bounded to sheet summary rather than stroke point payloads', () => {
  assert.match(source, /strokeCount: state\.document\.strokes\.length/);
  assert.match(source, /revisionId: state\.revisionId/);
  assert.doesNotMatch(source, /sheet:\s*state\.document/);
});
