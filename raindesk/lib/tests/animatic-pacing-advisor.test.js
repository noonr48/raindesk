'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const advisor = require('../animatic-pacing-advisor');

function context() {
  return {
    schemaVersion: 1,
    contextDigest: 'a'.repeat(64),
    parentRequestId: 'invoke_private_parent',
    sourceTurnId: 'turn_private',
    projectId: 'project-private',
    sequenceId: 'scene-private',
    fpsNum: 24,
    fpsDen: 1,
    activeShotId: 'S01',
    eligibleShots: [
      {
        shotId: 'S01', title: 'Wide descent', description: 'Cart rolls down the slope.', beats: ['Lena notices the wheel slipping.'],
        artworkRevisionId: 'rev_secret_1', creativeStateDigest: 'b'.repeat(64),
      },
      {
        shotId: 'S02', title: 'Reaction', description: 'Hold on Lena.', beats: ['A small breath before she reacts.'],
        artworkRevisionId: 'rev_secret_2', creativeStateDigest: 'c'.repeat(64),
      },
    ],
    unavailableShots: [],
  };
}

test('advisor prompt projects creative pacing evidence without source/executor authority', () => {
  const prompt = advisor.buildPrompt({ context: context(), artistMessage: 'let this breathe longer', partnerMessage: 'I can try two rhythms.' });
  assert.match(prompt, /S01/);
  assert.match(prompt, /Wide descent/);
  assert.match(prompt, /24/);
  assert.match(prompt, /let this breathe longer/);
  assert.doesNotMatch(prompt, /rev_secret/);
  assert.doesNotMatch(prompt, /project-private|scene-private|invoke_private_parent/);
  assert.doesNotMatch(prompt, /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.doesNotMatch(prompt, /RAINDESK_ANIMATIC_EXECUTOR|source_rights|panel_path/);
});

test('advisor accepts only bounded creative fields and ignores forged authority', () => {
  const raw = {
    proposals: [
      {
        label: 'Restrained', rationale: 'Let the reaction land.', fidelity: 'draft',
        shots: [{ shotId: 'S01', durationFrames: 72, note: 'wide descent' }, { shotId: 'S02', durationFrames: 36, note: 'hold on Lena' }],
      },
      {
        label: 'Forged', projectId: 'model-project', rationale: '', fidelity: 'draft',
        shots: [{ shotId: 'S01', durationFrames: 12, note: 'bad' }],
      },
      {
        label: 'Unknown shot', rationale: '', fidelity: 'draft',
        shots: [{ shotId: 'S01', durationFrames: 12, note: 'start' }, { shotId: 'S99', durationFrames: 12, note: 'invented' }],
      },
      {
        label: 'Missing active', rationale: '', fidelity: 'draft',
        shots: [{ shotId: 'S02', durationFrames: 12, note: 'reaction only' }],
      },
    ],
  };
  const proposals = advisor.normalizeProposals(raw, context());
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].label, 'Restrained');
  assert.equal(proposals[0].projectId, undefined);
  assert.deepEqual(proposals[0].shots.map((shot) => shot.shotId), ['S01', 'S02']);
});

test('advisor parses fenced agent JSON, deduplicates equal rhythms, and caps alternatives', async () => {
  const rows = [
    { label: 'A', rationale: '', fidelity: 'draft', shots: [{ shotId: 'S01', durationFrames: 24, note: 'hold' }] },
    { label: 'A duplicate', rationale: 'same timing', fidelity: 'draft', shots: [{ shotId: 'S01', durationFrames: 24, note: 'hold' }] },
    { label: 'B', rationale: '', fidelity: 'draft', shots: [{ shotId: 'S01', durationFrames: 36, note: 'longer' }] },
    { label: 'C', rationale: '', fidelity: 'draft', shots: [{ shotId: 'S01', durationFrames: 48, note: 'longest' }] },
    { label: 'D', rationale: '', fidelity: 'draft', shots: [{ shotId: 'S01', durationFrames: 60, note: 'too many options' }] },
  ];
  const fake = {
    async chat(prompt) {
      assert.match(prompt, /RAINDESK PACING PASS/);
      return `\`\`\`json\n${JSON.stringify({ proposals: rows })}\n\`\`\``;
    },
  };
  const result = await advisor.createAdvisor({ agentImpl: fake }).suggest({ context: context(), artistMessage: 'show me alternatives' });
  assert.equal(result.proposals.length, 3);
  assert.deepEqual(result.proposals.map((item) => item.label), ['A', 'B', 'C']);
});

test('malformed pacing output becomes no creative proposal rather than invented fallback', () => {
  assert.deepEqual(advisor.normalizeProposals('not json', context()), []);
});
