'use strict';

function register(server, context) {
  const { registerTool, bridge } = context;

  // ── figma_validate_ds_compliance ───────────────────────────────
  registerTool(
    'figma_validate_ds_compliance',
    'Validates a Figma node against the current DS enforcement profile. Returns compliance results from the plugin.',
    {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'The Figma node ID to validate.',
        },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('validate', { nodeId: args.nodeId });
      return result;
    }
  );
}

module.exports = { register };
