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

/**
 * Resolve the pi binary absolutely. Non-interactive server environments may
 * lack ~/.local/bin on PATH (managed processes get a bare env), which would
 * make spawn('pi') ENOENT. Prefer the well-known user-local install, then
 * system paths, then fall back to PATH lookup for interactive shells.
 */
function resolvePiBinary() {
  const home = process.env.HOME || '/home/studio';
  const candidates = [
    path.join(home, '.local', 'share', 'pi-studio-runtime', 'bin', 'pi'),
    path.join(home, '.local', 'bin', 'pi'),
    '/usr/local/bin/pi',
    '/usr/bin/pi',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_e) { /* next */ }
  }
  return 'pi';
}
const PI_BINARY = resolvePiBinary();

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
/**
 * Build the pi argv for one companion turn. Message rides as the positional
 * argv (spawn has no shell — no injection surface; cap length defensively).
 */
const MESSAGE_MAX = 16000; // aligned with server CHAT_MESSAGE_LIMIT (16*1024) minus slack

function buildArgv(message, systemPromptArg) {
  let msg = String(message ?? '').slice(0, MESSAGE_MAX);
  // never split a surrogate pair at the cap (emoji-safe truncation)
  if (msg.length && /[\uD800-\uDBFF]$/.test(msg)) msg = msg.slice(0, -1);
  return ['-p', '--mode', 'json', '--no-session', '--no-extensions', '--no-skills',
    '--append-system-prompt', systemPromptArg, msg];
}

/**
 * Parse the last assistant text reply from a --mode json NDJSON event stream.
 * Returns null when no assistant text was produced.
 */
function parseReply(jsonStreamText) {
  let last = null;
  for (const line of String(jsonStreamText).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch (_err) { continue; }
    if (e && e.type === 'message_end' && e.message && e.message.role === 'assistant') {
      try {
        const content = Array.isArray(e.message.content) ? e.message.content : [];
        const texts = content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text);
        if (texts.length) last = texts.join(' ');
      } catch (_err) { /* malformed entry — keep scanning; never throw from close() */ }
    }
  }
  return last;
}

function chat(message, opts = {}) {
  const timeoutMs = opts.timeoutMs || CHAT_TIMEOUT_MS;
  const binary = opts.binary || PI_BINARY;
  const preset = loadPreset();
  // With a preset FILE we pass its path; otherwise the preset text inline.
  // Either way no user text ever touches a shell.
  const systemPromptArg = preset.fromFile ? preset.path : preset.text;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, buildArgv(message, systemPromptArg),
        { stdio: ['pipe', 'pipe', 'pipe'] });
      // Message rides argv; end stdin immediately so a piped-stdin reader
      // (pi auto-reads piped stdin) sees EOF instead of blocking.
      child.stdin.end();
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
    // --mode json streams NDJSON; the reply is the last assistant message_end
    child.on('close', () => finish(parseReply(out) || FALLBACK_REPLY));
    child.stdin.on('error', () => { /* EPIPE after early exit; close() follows */ });
  });
}

module.exports = {
  chat, loadPreset, buildArgv, parseReply, PRESET_PATH, PRESET_CANDIDATES,
  FALLBACK_REPLY, FALLBACK_PRESET, CHAT_TIMEOUT_MS, MESSAGE_MAX,
};
