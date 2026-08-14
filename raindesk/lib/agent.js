'use strict';

/**
 * Agent bridge: one-shot `pi -p` headless runs for the Raindesk chat drawer.
 *
 * Spawn (no shell, no interpolation — the user message travels via stdin):
 *   pi -p --mode text --no-session --append-system-prompt <preset>
 *
 * <preset> is the creative companion preset, loaded from the first existing
 * candidate: raindesk/presets/creative.txt (canonical landing spot) then
 * raindesk/lib/presets/creative.txt (lease-workable copy); if neither is
 * present, an embedded fallback preset is passed inline so the companion
 * never goes silent. 120 s timeout (or spawn failure / empty output) ->
 * friendly fallback line; this promise NEVER rejects.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PRESET_CANDIDATES = [
  path.join(__dirname, '..', 'presets', 'creative.txt'),
  path.join(__dirname, 'presets', 'creative.txt'),
];
const PRESET_PATH = PRESET_CANDIDATES[0];
const CHAT_TIMEOUT_MS = 120000;
const FALLBACK_REPLY =
  "I'm still here with you 🌧️ — my thoughts drifted for a moment. Tell me again? ✨";

const FALLBACK_PRESET = `You are the Raindesk companion: the friend sitting beside the artist in the
studio while "After the Last Rain" gets made. Warm, playful, concise; emojis
in moderation; never mention tools/servers/models/files; always answer and
never leave the user alone. Film constraints: Anna is 15, two arms, two eyes,
blue hair, emerald eyes; Hethrn is a sinewy middle-aged man with many golden
skeletal arms 2-3x his scale like a rib cage; gore stays out in favour of
psychology, scale, implication; the 13-beat collapse order is fixed.
`;

/** Load the creative preset from the first candidate file that exists. */
function loadPreset(candidates = PRESET_CANDIDATES) {
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      if (text.trim()) return { text, fromFile: true, path: p };
    } catch (_e) {
      /* try next candidate */
    }
  }
  return { text: FALLBACK_PRESET, fromFile: false, path: null };
}

/**
 * Send one message to the companion; resolves with the reply string.
 * opts: { binary (default 'pi'), timeoutMs (default 120000) } — seams for tests.
 */
function chat(message, opts = {}) {
  const timeoutMs = opts.timeoutMs || CHAT_TIMEOUT_MS;
  const binary = opts.binary || 'pi';
  const preset = loadPreset();
  // With a preset FILE we pass its path; otherwise the preset text inline.
  // Either way no user text ever touches argv.
  const systemPromptArg = preset.fromFile ? preset.path : preset.text;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, ['-p', '--mode', 'text', '--no-session',
        '--append-system-prompt', systemPromptArg], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (_e) {
      resolve(FALLBACK_REPLY);
      return;
    }

    let out = '';
    let settled = false;
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reply);
    };
    const timer = setTimeout(() => {
      finish(FALLBACK_REPLY);
      try { child.kill('SIGKILL'); } catch (_e) { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => { /* diagnostics intentionally ignored */ });
    child.on('error', () => finish(FALLBACK_REPLY)); // e.g. ENOENT when pi absent
    child.on('close', () => finish(out.trim() || FALLBACK_REPLY));
    child.stdin.on('error', () => { /* EPIPE after early exit; close() follows */ });
    child.stdin.end(String(message ?? ''), 'utf8');
  });
}

module.exports = {
  chat, loadPreset, PRESET_PATH, PRESET_CANDIDATES,
  FALLBACK_REPLY, FALLBACK_PRESET, CHAT_TIMEOUT_MS,
};
