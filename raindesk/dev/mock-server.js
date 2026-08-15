'use strict';

/**
 * Raindesk development server with deterministic fake Pi + ComfyUI adapters.
 * Production server.js is not modified; this entry point only changes deps.
 */

const { createServer, PORT } = require('../server');
const { createMockRuntime } = require('../lib/mock-runtime');

const host = process.env.RAINDESK_HOST || '127.0.0.1';
const configuredPort = Number(process.env.RAINDESK_PORT || PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort : PORT;

function startMockServer() {
  return new Promise((resolve, reject) => {
    const runtime = createMockRuntime();
    const server = createServer({ comfyImpl: runtime.comfy, agentImpl: runtime.agent });
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      // eslint-disable-next-line no-console
      console.log(`[raindesk:mock] listening on http://${addr.address}:${addr.port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startMockServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[raindesk:mock] failed to start:', err);
    process.exit(1);
  });
}

module.exports = { startMockServer };
