'use strict';

const MAX_BATCH_SIZE = 6;
const { checkComponentFirstGate } = require('./build');

/**
 * For insert_component results, build the same configurationChecklist
 * that the standalone figma_insert_component tool returns.
 */
function buildConfigurationChecklist(result) {
  const configHints = result?.configurationHints || {};
  const checklist = [];

  // Boolean properties — auto-disabled at insertion by the plugin.
  // Report which ones were disabled so the builder knows what to re-enable if needed.
  const disabledBools = result?.disabledBooleans || [];
  const boolProps = configHints.booleanProperties || {};
  const boolKeys = Object.keys(boolProps);
  if (disabledBools.length > 0) {
    const boolList = disabledBools.map(k => {
      const displayName = k.includes('#') ? k.split('#')[0].trim() : k;
      return displayName;
    });
    checklist.push({
      action: 'ENABLE_BOOLEANS_IF_NEEDED',
      message: `${disabledBools.length} boolean(s) were auto-disabled: ${boolList.join(', ')}. Only re-enable those the source HTML explicitly shows.`,
      properties: disabledBools,
    });
  } else if (boolKeys.length > 0) {
    const boolList = boolKeys.map(k => {
      const displayName = k.includes('#') ? k.split('#')[0].trim() : k;
      return displayName;
    });
    checklist.push({
      action: 'DISABLE_BOOLEANS',
      message: `Toggle OFF these boolean properties unless the source HTML explicitly shows them: ${boolList.join(', ')}`,
      properties: boolKeys,
    });
  }

  // Text nodes that need overrides
  const textNodes = configHints.textNodes || [];
  if (textNodes.length > 0) {
    const placeholders = textNodes.map(t => `"${t.name}" (current: "${t.characters}")`);
    checklist.push({
      action: 'OVERRIDE_ALL_TEXT',
      message: `Override ALL ${textNodes.length} text node(s) with content from the source HTML. No placeholder text allowed.`,
      textNodes: placeholders,
    });
  }

  // Variant properties
  const variantProps = configHints.variantProperties || {};
  if (Object.keys(variantProps).length > 0) {
    const variantSummary = Object.entries(variantProps).map(([key, val]) =>
      `${key}: "${val.current}" (options: ${val.values.join(', ')})`
    );
    checklist.push({
      action: 'SET_VARIANTS',
      message: 'Review and set variant properties to match the source HTML.',
      variants: variantSummary,
    });
  }

  return checklist.length > 0 ? checklist : undefined;
}

function register(server, context) {
  const { bridge, dsCache, session, requirePhase, registerTool } = context;

  registerTool(
    'figma_batch',
    `Executes up to ${MAX_BATCH_SIZE} operations sequentially via the Figma plugin bridge. Each operation specifies a type (bridge handler name) and payload. Returns an array of results in order.`,
    {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          maxItems: MAX_BATCH_SIZE,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Bridge handler name (e.g. "create_frame", "set_text").' },
              payload: { type: 'object', description: 'Parameters for the handler.' },
            },
            required: ['type', 'payload'],
          },
          description: `Array of operations to execute (max ${MAX_BATCH_SIZE}).`,
        },
      },
      required: ['operations'],
    },
    async (args) => {
      requirePhase(2, 'Complete DS Discovery and Style Inventory before batch operations.');

      if (!args.operations || args.operations.length === 0) {
        return { error: 'EMPTY_BATCH', message: 'No operations provided.' };
      }

      if (args.operations.length > MAX_BATCH_SIZE) {
        return {
          error: 'BATCH_TOO_LARGE',
          message: `Max ${MAX_BATCH_SIZE} operations per batch. Got ${args.operations.length}.`,
        };
      }

      const results = [];
      for (const op of args.operations) {
        try {
          if (op.type === 'create_frame') {
            const componentGate = checkComponentFirstGate(op.payload || {});
            if (componentGate && !componentGate.allowed) {
              results.push({
                ok: false,
                type: op.type,
                error: componentGate.error,
                message: componentGate.message,
                recovery: componentGate.recovery,
              });
              session.toolCallCount++;
              continue;
            }
          }

          const payload = { ...(op.payload || {}) };
          if (op.type === 'insert_component' && payload.componentKey && !payload.importMode && dsCache) {
            const componentMeta = dsCache.getComponent(payload.componentKey);
            if (componentMeta && typeof componentMeta.isComponentSet === 'boolean') {
              payload.importMode = componentMeta.isComponentSet ? 'componentSet' : 'component';
            }
          }

          const result = await bridge.send(op.type, payload);

          if (op.type === 'create_frame' && result) {
            const componentGate = checkComponentFirstGate(op.payload || {});
            if (componentGate?.allowed) {
              result._componentCheck = componentGate.warning;
            }
          }

          // For insert_component ops, generate the same configurationChecklist
          // that the standalone figma_insert_component tool returns
          if (op.type === 'insert_component' && result) {
            result.configurationChecklist = buildConfigurationChecklist(result);
          }

          results.push({ ok: true, type: op.type, result });
        } catch (err) {
          results.push({
            ok: false,
            type: op.type,
            error: err.message,
          });
        }
        session.toolCallCount++;
      }

      const failed = results.filter(r => !r.ok).length;
      return {
        total: results.length,
        succeeded: results.length - failed,
        failed,
        results,
        hint: failed > 0
          ? `${failed} operation(s) failed. Check individual results for error details.`
          : 'All operations succeeded.',
      };
    }
  );
}

module.exports = { register };
