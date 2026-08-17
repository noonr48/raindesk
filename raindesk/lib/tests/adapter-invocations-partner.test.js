'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-adapter-invocation-partner-'));
process.env.RAINDESK_DATA_DIR = scratch;

const direction = require('../direction');
const partnerModule = require('../partner');

test('Partner returns a bounded surface invocation request for a ready local refinement', async () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'invoke_scene', title: 'Hand fix' });
  direction.createShot({ id: 'invoke_shot', sceneId: scene.id, title: 'Local correction' });
  const partner = partnerModule.createPartner({
    agentImpl: { async chat() { return JSON.stringify({
      message: 'I will keep the rest fixed and change only the selected hand.',
      interpretation: { kind: 'edit', editScope: 'selected hand', preserve: ['face', 'framing'], confidence: 0.9 },
      nextMoves: [], workflowHints: ['local_refinement'], boardActions: [],
    }); } },
    directionImpl: direction,
  });

  const turn = await partner.turn({
    message: 'only fix this hand',
    context: {
      sceneId: scene.id, shotId: 'invoke_shot',
      selection: { type: 'lasso', region: { x: 20, y: 30, width: 100, height: 80 } },
    },
  });
  assert.ok(turn.executionPlan);
  assert.equal(turn.invocationRequests.length, 1);
  const request = turn.invocationRequests[0];
  assert.equal(request.adapterId, 'bounded_image_region_v1');
  assert.equal(request.invocationBoundary, 'surface');
  assert.equal(request.status, 'awaiting_approval');
  assert.equal(request.reviewRequired, true);
  assert.equal(request.turnId, turn.turnId);
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'implementationRef'), false);
});

test('Partner Watch mode remains non-actionable even when a production adapter is available', async () => {
  direction.writeGraph(direction.emptyGraph());
  direction.setProject({ partnerMode: 'watch' });
  const partner = partnerModule.createPartner({
    agentImpl: { async chat() { return JSON.stringify({
      message: 'I can describe the local correction.',
      interpretation: { kind: 'edit', editScope: 'selected hand', confidence: 0.8 },
      nextMoves: [], workflowHints: ['local_refinement'], boardActions: [],
    }); } },
    directionImpl: direction,
  });
  const turn = await partner.turn({
    message: 'only fix this hand',
    context: { shotId: 'S01', selection: { type: 'lasso', region: { x: 1, y: 1, width: 10, height: 10 } } },
  });
  assert.equal(turn.permissionMode, 'watch');
  assert.equal(turn.executionPlan.canProceed, false);
  assert.deepEqual(turn.invocationRequests, []);
});
