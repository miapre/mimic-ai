'use strict';

const { surfaceBindingFeedback } = require('../utils/binding-feedback');

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
        importMode: { type: 'string', enum: ['component', 'componentSet'], description: 'Optional import hint. Usually inferred from DS discovery cache.' },
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

      // ── No retry on timeout ──────────────────────────────────────
      // insert_component is NOT idempotent — the plugin creates the
      // instance before responding. If the bridge times out but the
      // plugin succeeded, retrying creates duplicate instances (issue #4).
      // Use a generous 180s timeout instead (cold library imports can
      // take 60-90s).

      // ── Dedup guard ─────────────────────────────────────────────
      // Track pending/timed-out inserts by parentId+componentKey.
      // If the same insert is attempted while one already timed out,
      // warn instead of inserting again — prevents duplicates.
      if (!session._pendingInserts) session._pendingInserts = new Map();
      const dedupKey = `${args.parentId}:${args.componentKey}`;
      if (session._pendingInserts.has(dedupKey)) {
        return {
          error: 'INSERT_ALREADY_ATTEMPTED',
          componentKey: args.componentKey,
          parentId: args.parentId,
          previousAttempt: session._pendingInserts.get(dedupKey),
          hint: 'A previous insert for this component+parent timed out. The component likely EXISTS in Figma already. Call figma_get_node_children on the parent to check. Do NOT retry — duplicates are hard to detect and fix.',
        };
      }

      const componentMeta = dsCache.getComponent(args.componentKey);
      const insertArgs = { ...args };
      if (!insertArgs.importMode && componentMeta && typeof componentMeta.isComponentSet === 'boolean') {
        insertArgs.importMode = componentMeta.isComponentSet ? 'componentSet' : 'component';
      }

      let result;
      try {
        result = await bridge.send('insert_component', insertArgs, 180000);
        // Success — remove from pending if it was there
        session._pendingInserts.delete(dedupKey);
      } catch (err) {
        const isTimeout = err.message && err.message.includes('timeout');
        if (!isTimeout) {
          // Only mark permanent failures — timeouts may have succeeded in the plugin
          dsCache.markFailed(args.componentKey);
        }
        if (isTimeout) {
          // Track the timed-out insert so retries are blocked
          session._pendingInserts.set(dedupKey, {
            timestamp: Date.now(),
            componentKey: args.componentKey,
            parentId: args.parentId,
          });
          return {
            error: 'INSERT_TIMEOUT',
            componentKey: args.componentKey,
            hint: 'Component insertion timed out. The component MAY have been created in Figma — check the canvas before retrying. If it exists, use figma_get_node_children on the parent to find it. Do NOT call insert again for this component+parent — a dedup guard will block it.',
          };
        }
        throw err;
      }

      session.toolCallCount++;
      advancePhase(3);

      // Cache the component info
      if (result?.componentKey) {
        dsCache.addComponent(result.componentKey, {
          name: result.name || args.name,
          variants: result.variants || null,
          isComponentSet: componentMeta?.isComponentSet,
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

      // ── Build explicit configuration checklist from configurationHints ──
      const configHints = result?.configurationHints || {};
      const checklist = [];

      // Boolean properties — auto-disabled at insertion time by the plugin.
      // The builder only needs to RE-ENABLE booleans the HTML explicitly shows.
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
          message: `${disabledBools.length} boolean(s) were auto-disabled: ${boolList.join(', ')}. Only re-enable those the source HTML explicitly shows (e.g. an icon that is visible in the HTML). Most components work correctly with all booleans OFF.`,
          properties: disabledBools,
        });
      } else if (boolKeys.length > 0) {
        // Fallback for components where auto-disable didn't run
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

      // Text nodes that need overrides — list ALL of them
      const textNodes = configHints.textNodes || [];
      if (textNodes.length > 0) {
        const placeholders = textNodes.map(t => `"${t.name}" (current: "${t.characters}")`);
        checklist.push({
          action: 'OVERRIDE_ALL_TEXT',
          message: `Override ALL ${textNodes.length} text node(s) with content from the source HTML. No placeholder text allowed.`,
          textNodes: placeholders,
        });
      }

      // Variant properties — list current values so Claude can decide what to change
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

      return {
        nodeId,
        ...result,
        configurationChecklist: checklist.length > 0 ? checklist : undefined,
        hints,
      };
    }
  );

  // ── figma_set_component_text ──────────────────────────────────
  registerTool(
    'figma_set_component_text',
    'Sets text on a component instance by finding a text node with the given name. Prefer figma_set_component_text_by_id when configurationHints include text node IDs, because many components contain repeated text node names.',
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
      surfaceBindingFeedback(result, 'set_component_text');
      return {
        ...result,
        hint: result?.bindingFailures
          ? 'Text set but fill variable binding FAILED — check warnings.'
          : 'Text set. Remember to override ALL text nodes — no placeholder content allowed.',
      };
    }
  );

  // ── figma_set_component_text_by_id ────────────────────────────
  registerTool(
    'figma_set_component_text_by_id',
    'Sets text on a component instance using an exact text node ID from configurationHints.textNodes. Use this instead of name-based text overrides when available.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Component instance node ID that should contain the text node.' },
        textNodeId: { type: 'string', description: 'Exact TEXT node ID from configurationHints.textNodes.' },
        content: { type: 'string', description: 'New text content.' },
        fillVariable: { type: 'string', description: 'Optional DS text color variable path.' },
      },
      required: ['nodeId', 'textNodeId', 'content'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('set_component_text_by_id', args);
      session.toolCallCount++;
      surfaceBindingFeedback(result, 'set_component_text_by_id');
      return {
        ...result,
        hint: result?.bindingFailures
          ? 'Text set by ID but fill variable binding FAILED — check warnings.'
          : 'Text set by exact node ID.',
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
