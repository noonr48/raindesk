'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'refinements.css'), 'utf8');

test('workspace refinement layer is loaded after base app styles', () => {
  const base = html.indexOf('css/app.css');
  const refined = html.indexOf('css/refinements.css');
  assert.ok(base >= 0 && refined > base, 'refinements.css must load after app.css');
});

test('mobile workspace reserves vertical room without cropping the square artboard', () => {
  assert.match(css, /@media \(max-width: 1023\.98px\)[\s\S]*#stage\s*\{[\s\S]*bottom:\s*clamp\(/);
  assert.match(css, /\.toolbar\s*\{[\s\S]*top:\s*calc\(var\(--art-b/);
  assert.match(css, /\.genbar-wrap\s*\{[\s\S]*left:\s*12px;[\s\S]*right:\s*12px;/);
});

test('docked desktop controls account for companion width', () => {
  for (const selector of ['.topbar', '.toolbar', '.penpop', '.genbar-wrap', '.panel']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`body\\.drawer-open ${escaped}\\s*\\{[\\s\\S]*?--drawer-w`);
    assert.match(css, rule, `${selector} must account for --drawer-w while companion is docked`);
  }
});
