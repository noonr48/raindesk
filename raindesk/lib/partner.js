'use strict';

/**
 * Invocation-aware Partner composition.
 *
 * partner-plan-core.js owns conversation, character authority and capability
 * planning. This façade only translates the completed execution plan into
 * bounded adapter hand-off requests; it never invokes arbitrary adapters.
 */

const core = require('./partner-plan-core');
const invocations = require('./adapter-invocations');

function createPartner(options = {}) {
  const base = core.createPartner(options);
  return {
    ...base,
    async turn(input = {}) {
      const result = await base.turn(input);
      return {
        ...result,
        invocationRequests: invocations.requestsForPlan(result.executionPlan, {
          turnId: result.turnId || null,
        }),
      };
    },
  };
}

module.exports = {
  ...core,
  createPartner,
};
