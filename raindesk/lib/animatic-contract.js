'use strict';

/** Shared Raindesk-side limits for the SequenceSourceSnapshot@0.2.0 animatic slice. */

const CONTRACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const FIDELITIES = new Set(['draft', 'preview']);
const MAX_SHOTS = 256;
const MAX_DURATION_FRAMES = 60 * 60 * 24;
const MAX_FPS_NUM = 240000;
const MAX_FPS_DEN = 1001;

module.exports = {
  CONTRACT_ID_RE,
  FIDELITIES,
  MAX_SHOTS,
  MAX_DURATION_FRAMES,
  MAX_FPS_NUM,
  MAX_FPS_DEN,
};
