'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agent = require('../../lib/agent');

test('chat resolves to the friendly fallback when the binary is absent (pi missing)', async () => {
  const reply = await agent.chat('I feel stuck on S02', {
    binary: '/nonexistent/raindesk-test-no-such-binary',
    timeoutMs: 3000,
  });
  assert.equal(reply, agent.FALLBACK_REPLY);
  assert.match(reply, /here with you/);
});

test('chat falls back when the binary exists but exits without output', async () => {
  // 'true' exists everywhere, ignores stdin, prints nothing, exits 0
  const reply = await agent.chat('hello', { binary: 'true', timeoutMs: 3000 });
  assert.equal(reply, agent.FALLBACK_REPLY);
});

test('chat never rejects and never leaves the user alone (timeout path)', async () => {
  // node with pi-style argv exits with "bad option" -> empty stdout -> fallback
  const reply = await agent.chat('stay with me', { binary: 'node', timeoutMs: 5000 });
  assert.equal(typeof reply, 'string');
  assert.ok(reply.length > 0);
});

test('loadPreset returns the embedded preset with no candidates', () => {
  const p = agent.loadPreset([]);
  assert.equal(p.fromFile, false);
  assert.match(p.text, /Anna/);
  assert.match(p.text, /15/);
  assert.match(p.text, /two arms, two eyes/i);
});

test('loadPreset prefers a preset file when one exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-preset-'));
  const p1 = path.join(dir, 'creative.txt');
  fs.writeFileSync(p1, 'TEST PRESET: lantern light\n');
  const p = agent.loadPreset([p1]);
  assert.equal(p.fromFile, true);
  assert.equal(p.path, p1);
  assert.match(p.text, /lantern light/);
  // first candidate missing -> falls to second
  const p2 = agent.loadPreset([path.join(dir, 'missing.txt'), p1]);
  assert.equal(p2.fromFile, true);
  assert.equal(p2.path, p1);
});

test('embedded fallback preset knows the film constraints from BOARD.md', () => {
  assert.match(agent.FALLBACK_PRESET, /Anna is 15/);
  assert.match(agent.FALLBACK_PRESET, /two arms/);
  assert.match(agent.FALLBACK_PRESET, /two eyes/);
  assert.match(agent.FALLBACK_PRESET, /emerald eyes/);
  assert.match(agent.FALLBACK_PRESET, /Hethrn/);
  assert.match(agent.FALLBACK_PRESET, /gore stays out/i);
});

test('buildArgv keeps creative message out of the process list', () => {
  const argv = agent.buildArgv('private creative direction', '/tmp/preset.txt');
  assert.deepEqual(argv, [
    '-p', '--mode', 'json', '--no-session', '--no-extensions', '--no-skills',
    '--append-system-prompt', '/tmp/preset.txt',
  ]);
  assert.equal(argv.includes('private creative direction'), false);
});

test('prepareMessage caps stdin payload defensively (emoji-safe truncation)', () => {
  const long = 'x'.repeat(20000);
  assert.equal(agent.prepareMessage(long).length, agent.MESSAGE_MAX);
  const lone = 'a'.repeat(agent.MESSAGE_MAX - 1) + '\uD83D';
  assert.equal(agent.prepareMessage(lone).length, agent.MESSAGE_MAX - 1);
});

test('chat sends the creative prompt through stdin, not argv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-agent-stdin-'));
  const fake = path.join(dir, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nlet s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'saw:'+s}]}}));});\n`);
  fs.chmodSync(fake, 0o755);
  const reply = await agent.chat('camera spirals behind her face', { binary: fake, timeoutMs: 3000 });
  assert.equal(reply, 'saw:camera spirals behind her face');
});

test('parseReply extracts the LAST assistant text from an NDJSON stream', () => {
  const stream = [
    JSON.stringify({ type: 'session', id: 's1' }),
    JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'first draft' }] } }),
    'not-json-garbage-line',
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'rain hissing on black water' }] } }),
    JSON.stringify({ type: 'agent_end' }),
  ].join('\n');
  assert.equal(agent.parseReply(stream), 'rain hissing on black water');
  // assistant with only thinking blocks yields no reply
  const onlyThinking = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] } });
  assert.equal(agent.parseReply(onlyThinking), null);
  assert.equal(agent.parseReply(''), null);
});
