'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('drawer tabs are exempt from the workspace drag handle', () => {
  const chat = fs.readFileSync(path.join(root, 'public', 'js', 'chat.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'public', 'js', 'workspace-ui.js'), 'utf8');
  // The tab row doubles as the desktop drag handle; its pointerdown handler
  // starts a drag (pointer capture + preventDefault) unless the target opts
  // out. Tabs are interactive controls and must opt out, or the tab-switch
  // click is swallowed on desktop (observed natively: click retargets to the
  // handle, tab listeners never fire — see dev/browser-animatic-reload-smoke.js
  // fresh-page phase, which is driven by a native tab click).
  assert.match(chat, /tabAgent\.dataset\.noDrag\s*=\s*''/);
  assert.match(chat, /tabGens\.dataset\.noDrag\s*=\s*''/);
  // The drag handler must keep honoring the data-no-drag escape hatch.
  assert.match(ui, /data-no-drag/);
});
