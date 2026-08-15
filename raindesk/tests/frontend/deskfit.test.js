'use strict';

/**
 * Desktop-fit tripwire: the artboard-anchoring mechanism must stay wired.
 *
 * Vision-verified at 1366/1920 (commit d65721d); this static check is the
 * cheap regression net — it fails if anyone removes the --art-x publishing
 * (app.js) or the anchored overlay rules (app.css), which is what brought
 * the controls back from the dead side pillars.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');

test('render() publishes the artboard rect as CSS vars', () => {
  assert.match(appJs, /--art-x/, 'app.js must publish --art-x');
  assert.match(appJs, /--art-w/, 'app.js must publish --art-w');
  assert.match(appJs, /--art-b/, 'app.js must publish --art-b');
});

test('desktop overlays anchor to the artboard rect, not the viewport', () => {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  for (const sel of ['.topbar', '.toolbar', '.penpop', '.genbar-wrap', '.panel']) {
    const anchored = new RegExp(esc(sel) + String.raw` \{[^\}]*--art-x`);
    assert.match(appCss, anchored, `${sel} must reference --art-x in the ≥1024px block`);
  }
});

test('drawer docks open by default on desktop (matchMedia gate present)', () => {
  assert.match(appJs, /matchMedia\('\(min-width: 1024px\)'\)/, 'auto-open gate present');
});

test('backdrop is a scene-matched gradient (no flat void)', () => {
  assert.match(appCss, /#stage \{[^\}]*linear-gradient/, '#stage must keep the gradient backdrop');
});
