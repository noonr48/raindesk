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
const appHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('initial tool state matches the visually-active tool (UI honesty pin)', () => {
  // GPT Pro finding: HTML marked PEN active while state.tool began 'select'.
  // The initializer must agree with the active button in index.html.
  const activeBtn = appHtml.match(/class="tool active"[^>]*data-tool="([a-z]+)"/) ||
    appHtml.match(/data-tool="([a-z]+)"[^>]*class="tool active"/);
  assert.ok(activeBtn, 'index.html must mark exactly one tool active');
  const initTool = appJs.match(/tool:\s*'([a-z]+)',/);
  assert.ok(initTool, 'app.js state must declare an initial tool');
  assert.equal(initTool[1], activeBtn[1], 'state.tool must equal the visually-active tool');
});

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

test('desktop Partner placement is owned by the persistent workspace shell', () => {
  assert.match(appJs, /panel_partner/, 'Partner has a stable workspace object id');
  assert.match(appJs, /state\.workspaceUI\.isDesktop/, 'desktop drawer layout consults workspace shell');
  assert.doesNotMatch(appJs, /matchMedia\('\(min-width: 1024px\)'\).*drawer\.open/s, 'legacy forced desktop rail is removed');
});

test('backdrop is a scene-matched gradient (no flat void)', () => {
  assert.match(appCss, /#stage \{[^\}]*linear-gradient/, '#stage must keep the gradient backdrop');
});
