'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Requiring the UMD module catches export-time ReferenceErrors that node
// --check cannot see (the browser boot regression this test was added for).
const API = require('../../public/js/api');

test('browser API module evaluates and exposes legacy chat + structured Partner routes', () => {
  assert.equal(typeof API.sendChat, 'function');
  assert.equal(typeof API.partnerTurn, 'function');
  assert.equal(typeof API.getDirection, 'function');
  assert.equal(typeof API.addDirectionAnnotation, 'function');
});
