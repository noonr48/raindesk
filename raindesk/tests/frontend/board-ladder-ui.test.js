'use strict';

// Pins the lanes-sheet row rendering the ladder state next to the lane
// (public/js/app.js) so a refactor cannot silently drop the state label.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('lanes sheet row shows the ladder state next to the lane (queued fallback mirrors the server)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(src, /lane\.textContent = `\$\{String\(shot\.state \|\| 'queued'\)\} · \$\{String\(shot\.lane \|\| ''\)\.replace\('_', ' '\)\}`/);
});
