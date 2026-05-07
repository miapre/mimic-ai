'use strict';

const PHASE_HINT = 'Complete DS Discovery and Style Inventory first (call mimic_discover_ds → preload → figma_set_session_defaults).';

function register(server, context) {
  const { bridge, buildManifest, dsCache, knowledgeStore, session, requirePhase, advancePhase, registerTool } = context;

  // ── figma_insert_component ────────────────────────────────────
  registerTool(
    'figma_insert_component',
    'Imports and inserts a DS component instance. Returns component info and configuration hints from the knowledge store.',
    {
      type: 'object',
      properties: {
        componentKey: { type: 'string', description: 'Component key from the DS library.' },
        name: { type: 'string', description: 'Instance name override.' },
        parentId: { type: 'string', description: 'Parent node ID to insert into.' },
      },
      required: ['componentKey', 'parentId'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);

      if (dsCache.hasFailed(args.componentKey)) {
        return {
          error: 'COMPONENT_PREVIOUSLY_FAILED',
          componentKey: args.componentKey,
          hint: 'This component key failed before. Verify the key is correct and the library is enabled in the file.',
        };
      }

      let result;
      try {
        result = await bridge.send('insert_component', args);
      } catch (err) {
        dsCache.markFailed(args.componentKey);
        throw err;
      }

      session.toolCallCount++;
      advancePhase(3);

      // Cache the component info
      if (result?.componentKey) {
        dsCache.addComponent(result.componentKey, {
          name: result.name || args.name,
          variants: result.variants || null,
        });
      }

      // Check knowledge store for recipes
      const recipe = knowledgeStore.getComponent(args.name || result?.name);
      const hints = [];
      if (recipe) {
        hints.push(`Known recipe: ${JSON.stringify(recipe)}`);
      }
      hints.push('After inserting: override ALL text with figma_set_component_text, set semantic properties, configure icons, hide unused slots.');

      const nodeId = result?.nodeId || result?.id;
      // Record component in build manifest
      if (nodeId) {
        buildManifest.addSection(
          args.name || result?.name || 'unnamed-component',
          nodeId,
          'component',
          result?.name || args.name
        );
      }

      return {
        nodeId,
        ...result,
        hints,
      };
    }
  );

  // ── figma_set_component_text ──────────────────────────────────
  registerTool(
    'figma_set_component_text',
    'Sets text on a component instance by finding a text node with the given name.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Component instance node ID.' },
        textNodeName: { type: 'string', description: 'Name of the text node within the component.' },
        content: { type: 'string', description: 'New text content.' },
      },
      required: ['nodeId', 'textNodeName', 'content'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('set_component_text', args);
      session.toolCallCount++;
      return {
        ...result,
        hint: 'Text set. Remember to override ALL text nodes — no placeholder content allowed.',
      };
    }
  );

  // ── figma_set_variant ─────────────────────────────────────────
  registerTool(
    'figma_set_variant',
    'Sets variant properties on a component instance.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Component instance node ID.' },
        properties: {
          type: 'object',
          description: 'Variant property key-value pairs (e.g. { "Size": "Large", "State": "Default" }).',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['nodeId', 'properties'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('set_variant', args);
      session.toolCallCount++;
      return {
        ...result,
        hint: 'Variant set. Use figma_get_component_variants to see all available variants for this component set.',
      };
    }
  );

  // ── figma_swap_main_component ─────────────────────────────────
  registerTool(
    'figma_swap_main_component',
    'Swaps the main component of an instance to a different component.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Instance node ID.' },
        newComponentKey: { type: 'string', description: 'New component key to swap to.' },
      },
      required: ['nodeId', 'newComponentKey'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('swap_main_component', args);
      session.toolCallCount++;
      return {
        ...result,
        hint: 'Component swapped. Re-apply any text overrides and variant settings.',
      };
    }
  );

  // ── figma_replace_component ───────────────────────────────────
  registerTool(
    'figma_replace_component',
    'Replaces an instance node with a new component instance at the same position.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Instance node ID to replace.' },
        newComponentKey: { type: 'string', description: 'New component key.' },
      },
      required: ['nodeId', 'newComponentKey'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('replace_component', args);
      session.toolCallCount++;
      return {
        ...result,
        hint: 'Component replaced. Set all text overrides and properties on the new instance.',
      };
    }
  );
}

module.exports = { register };
