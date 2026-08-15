'use strict';

/**
 * Deterministic development adapters for Raindesk.
 *
 * These implement the same tiny interfaces server.js expects from lib/agent
 * and lib/comfy, but never spawn Pi or contact ComfyUI. They are intentionally
 * separate from production runtime code so local production remains unchanged.
 */

const realComfy = require('./comfy');

// Three small abstract PNG takes. The frontend resamples them to the active
// lasso region, which makes regenerate/previous/next/commit flows visible in a
// virtual environment without pretending to be a real image generator.
const MOCK_PNGS = [
  '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'
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockDelayMs() {
  const n = Number(process.env.RAINDESK_MOCK_DELAY_MS || 140);
  return Number.isFinite(n) ? Math.max(0, Math.min(5000, n)) : 140;
}

function createMockRuntime() {
  let takeSeq = 0;
  const bytesByFilename = new Map();

  const comfy = {
    normalizeSeed: realComfy.normalizeSeed,

    async runInpaint(params = {}) {
      await delay(mockDelayMs());
      const index = takeSeq % MOCK_PNGS.length;
      takeSeq += 1;
      const filename = `mock-take-${String(takeSeq).padStart(3, '0')}.png`;
      bytesByFilename.set(filename, Buffer.from(MOCK_PNGS[index], 'base64'));
      const seed = params.seed === undefined || params.seed === null || params.seed === ''
        ? 41000 + takeSeq
        : realComfy.normalizeSeed(params.seed);
      return {
        promptId: `mock-${takeSeq}`,
        seed,
        images: [{ filename, subfolder: '', type: 'output' }],
        imageUrl: `mock://${filename}`,
      };
    },

    async fetchImageBytes(img) {
      const filename = img && img.filename;
      const bytes = filename && bytesByFilename.get(filename);
      if (!bytes) throw new Error('mock generation asset not found');
      return Buffer.from(bytes);
    },
  };

  const agent = {
    async chat(message) {
      await delay(Math.min(mockDelayMs(), 220));
      const clean = String(message || '').trim().replace(/\s+/g, ' ');
      const excerpt = clean.length > 96 ? `${clean.slice(0, 93)}…` : clean;
      return `Mock companion here — I caught “${excerpt || 'your note'}”. ` +
        'For this preview I would keep the change focused and preserve the surrounding shot. 🌧️';
    },
  };

  return { mode: 'mock', comfy, agent };
}

module.exports = { createMockRuntime, MOCK_PNGS };
