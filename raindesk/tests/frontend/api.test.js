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
  assert.equal(typeof API.getWorkspace, 'function');
  assert.equal(typeof API.upsertWorkspaceObject, 'function');
  assert.equal(typeof API.mutatePartnerAction, 'function');
  assert.equal(typeof API.listJobs, 'function');
  assert.equal(typeof API.cancelGen, 'function');
  assert.equal(typeof API.listTakes, 'function');
  assert.equal(typeof API.acceptTake, 'function');
  assert.equal(typeof API.rejectTake, 'function');
  assert.equal(typeof API.reopenTake, 'function');
  assert.equal(typeof API.getShotRevision, 'function');
  assert.equal(typeof API.restoreShotRevision, 'function');
});
