'use strict';

/**
 * Character-aware Partner composition.
 *
 * partner-core.js remains the proven orchestration engine. This layer adds a
 * bounded, explicit character-identity authority block to the prompt while
 * preserving the core engine's public API and concurrency behaviour.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const core = require('./partner-core');

const MAX_CONTEXT_CHARS = 7000;
const MAX_CHARACTERS = 16;

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value, max = 400) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function compactCharacterAnchors(value) {
  if (!isObject(value)) return null;
  const characterIds = Array.isArray(value.characterIds)
    ? value.characterIds.slice(0, MAX_CHARACTERS).map((id) => text(id, 128)).filter(Boolean)
    : [];
  const characters = Array.isArray(value.characters) ? value.characters.slice(0, MAX_CHARACTERS).map((character) => {
    if (!isObject(character)) return null;
    return {
      id: text(character.id, 128),
      name: text(character.name, 200),
      aliases: Array.isArray(character.aliases) ? character.aliases.slice(0, 6).map((item) => text(item, 120)).filter(Boolean) : [],
      canonicalSheetId: text(character.canonicalSheetId, 160) || null,
      locked: Boolean(character.locked),
      identityRules: Array.isArray(character.identityRules)
        ? character.identityRules.slice(0, 8).map((item) => text(item, 180)).filter(Boolean)
        : [],
      anchors: Array.isArray(character.anchors) ? character.anchors.slice(0, 6).map((anchor) => {
        if (!isObject(anchor)) return null;
        return {
          id: text(anchor.id, 128),
          sha: text(anchor.sha, 64).toLowerCase(),
          sheetId: text(anchor.sheetId, 160) || null,
          mediaId: text(anchor.mediaId, 160) || null,
          view: text(anchor.view, 64) || 'other',
          label: text(anchor.label, 160),
        };
      }).filter((anchor) => anchor && /^[a-f0-9]{64}$/.test(anchor.sha)) : [],
    };
  }).filter((character) => character && character.id) : [];
  return { shotId: text(value.shotId, 128) || null, characterIds, characters };
}

function serializedLength(context) {
  return JSON.stringify(context).length;
}

function pruneCharacterEvidence(context) {
  const block = context && context.characterAnchors;
  if (!block || !Array.isArray(block.characters)) return false;
  let changed = false;
  // Character presence is never pruned. Nested evidence is deliberately
  // reduced before active directing context is sacrificed.
  for (const character of block.characters) {
    if (Array.isArray(character.anchors) && character.anchors.length > 4) {
      character.anchors.pop(); changed = true;
    }
  }
  if (changed) return true;
  for (const character of block.characters) {
    if (Array.isArray(character.identityRules) && character.identityRules.length > 4) {
      character.identityRules.pop(); changed = true;
    }
  }
  if (changed) return true;
  for (const character of block.characters) {
    if (Array.isArray(character.aliases) && character.aliases.length > 2) {
      character.aliases.pop(); changed = true;
    }
  }
  if (changed) return true;
  for (const character of block.characters) {
    const minimum = character.locked ? 1 : 0;
    if (Array.isArray(character.anchors) && character.anchors.length > minimum) {
      character.anchors.pop(); changed = true;
    }
  }
  if (changed) return true;
  for (const character of block.characters) {
    if (Array.isArray(character.identityRules) && character.identityRules.length) {
      character.identityRules.pop(); changed = true;
    }
  }
  return changed;
}

function pruneGenericContext(context) {
  const direction = context && context.direction || {};
  const workspace = context && context.workspace || {};
  const buckets = [
    context && context.nearbyNotes,
    context && context.recentConversation,
    direction.activeAnnotations,
    direction.activeBeats,
    direction.openQuestions,
    workspace.objects,
  ];
  const bucket = buckets.find((items) => Array.isArray(items) && items.length > 1);
  if (bucket) { bucket.shift(); return true; }
  return false;
}

function fitContext(context) {
  let guard = 0;
  while (serializedLength(context) > MAX_CONTEXT_CHARS && guard++ < 256) {
    if (pruneCharacterEvidence(context)) continue;
    if (pruneGenericContext(context)) continue;
    if (context.direction && context.direction.activeShot && context.direction.activeShot.description) {
      context.direction.activeShot.description = text(context.direction.activeShot.description, 220);
      context.direction.activeShot.purpose = text(context.direction.activeShot.purpose, 180);
      continue;
    }
    if (context.direction && context.direction.activeScene && context.direction.activeScene.description) {
      context.direction.activeScene.description = text(context.direction.activeScene.description, 180);
      context.direction.activeScene.purpose = text(context.direction.activeScene.purpose, 150);
      continue;
    }
    const chars = context.characterAnchors && context.characterAnchors.characters;
    const rich = Array.isArray(chars) && chars.find((character) =>
      character.label || character.canonicalSheetId || (character.anchors || []).some((anchor) => anchor.label || anchor.mediaId || anchor.sheetId));
    if (rich) {
      rich.canonicalSheetId = null;
      for (const anchor of rich.anchors || []) {
        anchor.label = '';
        anchor.mediaId = null;
        anchor.sheetId = null;
      }
      continue;
    }
    break;
  }
  return context;
}

const CHARACTER_GUIDANCE = '- Bound character context answers WHO is in the shot. locked=false means shot presence is real while visual identity remains provisional. locked=true means the listed immutable anchors and identity rules are the artist\'s current visual identity authority. An anchor SHA is only an asset reference; never pretend you visually inspected it unless a real vision/tool stage supplied visual evidence.\n';

function injectCharacterContext(prompt, value) {
  const block = compactCharacterAnchors(value);
  if (!block) return prompt;
  const marker = 'Current context (may be partial):\n';
  const start = String(prompt || '').indexOf(marker);
  if (start < 0) return `${CHARACTER_GUIDANCE}\n${prompt}`;
  const jsonStart = start + marker.length;
  const jsonEnd = String(prompt).indexOf('\n\n', jsonStart);
  if (jsonEnd < 0) return `${CHARACTER_GUIDANCE}\n${prompt}`;

  let context;
  try { context = JSON.parse(String(prompt).slice(jsonStart, jsonEnd)); }
  catch (_e) { return `${CHARACTER_GUIDANCE}\n${prompt}`; }
  context.characterAnchors = block;
  fitContext(context);
  const encoded = JSON.stringify(context);
  const withContext = `${String(prompt).slice(0, jsonStart)}${encoded}${String(prompt).slice(jsonEnd)}`;
  return `${withContext.slice(0, start)}${CHARACTER_GUIDANCE}${withContext.slice(start)}`;
}

function buildPrompt(args = {}) {
  const prompt = core.buildPrompt(args);
  const anchors = args && args.extraContext && args.extraContext.characterAnchors;
  return injectCharacterContext(prompt, anchors);
}

function createPartner(options = {}) {
  const agentImpl = options.agentImpl;
  if (!agentImpl || typeof agentImpl.chat !== 'function') return core.createPartner(options);

  const turnContext = new AsyncLocalStorage();
  const wrappedAgent = {
    async chat(prompt) {
      const anchors = turnContext.getStore();
      return agentImpl.chat.call(agentImpl, injectCharacterContext(prompt, anchors));
    },
  };
  const base = core.createPartner({ ...options, agentImpl: wrappedAgent });
  return {
    ...base,
    turn(input = {}) {
      const anchors = input && input.context && input.context.characterAnchors;
      return turnContext.run(anchors || null, () => base.turn(input));
    },
  };
}

module.exports = {
  ...core,
  buildPrompt,
  createPartner,
  compactCharacterAnchors,
  injectCharacterContext,
};
