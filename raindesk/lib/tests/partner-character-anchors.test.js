'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const partner = require('../partner');

const summary = {
  project: null, counts: {}, activeScene: null, activeShot: null,
  activeBeats: [], activeAnnotations: [], openQuestions: [],
};

test('Partner prompt receives compact bound character identity authority', () => {
  const sha = 'e'.repeat(64);
  const prompt = partner.buildPrompt({
    message: 'keep Anna consistent', summary, kickstart: false,
    extraContext: {
      characterAnchors: {
        shotId: 'S01', characterIds: ['anna'],
        characters: [{
          id: 'anna', name: 'Anna', aliases: ['Anna'], canonicalSheetId: 'sheet_character_primary', locked: true,
          identityRules: ['teenager', 'two arms'],
          anchors: [{ id: 'front', sha, sheetId: 'sheet_character_primary', mediaId: 'front_media', view: 'front', label: 'front model' }],
        }],
      },
    },
  });
  assert.match(prompt, /"characterAnchors"/);
  assert.match(prompt, /"identityRules":\["teenager","two arms"\]/);
  assert.match(prompt, new RegExp(sha));
  assert.doesNotMatch(prompt, /"points"/);
});

test('Partner distinguishes shot presence from locked identity authority', () => {
  const prompt = partner.buildPrompt({
    message: 'Mara is here but I am still figuring out her look', summary, kickstart: false,
    extraContext: { characterAnchors: { shotId: 'S02', characterIds: ['mara'], characters: [{ id: 'mara', name: 'Mara', locked: false, anchors: [] }] } },
  });
  assert.match(prompt, /answers WHO is in the shot/);
  assert.match(prompt, /locked=false/);
  assert.match(prompt, /provisional/);
  assert.match(prompt, /never pretend you visually inspected it/);
});

test('large character anchor sets are pruned without dropping bound character presence', () => {
  const anchors = Array.from({ length: 24 }, (_, i) => ({
    id: `a${i}`, sha: String(i % 10).repeat(64), view: 'other', label: `anchor ${i} ${'x'.repeat(120)}`,
  }));
  const rules = Array.from({ length: 24 }, (_, i) => `identity rule ${i} ${'y'.repeat(180)}`);
  const prompt = partner.buildPrompt({
    message: 'keep the acting but preserve who she is', summary, kickstart: false,
    extraContext: { characterAnchors: { shotId: 'S01', characterIds: ['anna'], characters: [{ id: 'anna', name: 'Anna', locked: true, anchors, identityRules: rules }] } },
  });
  const match = prompt.match(/Current context \(may be partial\):\n([\s\S]*?)\n\n/);
  assert.ok(match);
  const context = JSON.parse(match[1]);
  assert.equal(context.characterAnchors.characters[0].id, 'anna');
  assert.ok(context.characterAnchors.characters[0].anchors.length >= 4);
  assert.ok(match[1].length <= 7000);
});
