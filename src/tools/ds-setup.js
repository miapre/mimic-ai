'use strict';

function register(server, context) {
  const { bridge, dsCache, dsResolver, session, advancePhase, registerTool } = context;

  // ── figma_preload_styles ──────────────────────────────────────
  registerTool(
    'figma_preload_styles',
    'Sends text style keys to the plugin for caching. Call during DS setup phase.',
    {
      type: 'object',
      properties: {
        styleKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of text style keys to preload.',
        },
        expectedCount: {
          type: 'number',
          description: 'Total number of styles expected (from Figma MCP search results). Used to detect partial loads.',
        },
      },
      required: ['styleKeys'],
    },
    async (args) => {
      const result = await bridge.send('preload_styles', { styleKeys: args.styleKeys });
      session.toolCallCount++;

      // Cache the styles returned by the plugin
      if (result && result.styles) {
        for (const style of result.styles) {
          dsCache.addTextStyle(style.key, style);
        }
      }

      const cached = result?.preloadedStyles || 0;
      const expectedCount = args.expectedCount || null;
      if (expectedCount) session.expectedStyleCount = expectedCount;
      const warning = expectedCount && cached < expectedCount * 0.8
        ? `Partial load: ${cached}/${expectedCount} styles cached. Some styles may be unavailable. Retry failed styles or proceed with available ones.`
        : null;

      return {
        cached,
        expectedStyles: expectedCount,
        warning,
        result,
        hint: 'Styles preloaded. Next: preload variables with figma_preload_variables.',
      };
    }
  );

  // ── figma_preload_variables ───────────────────────────────────
  registerTool(
    'figma_preload_variables',
    'Stores DS variables in the local cache for enforcement and resolution.',
    {
      type: 'object',
      properties: {
        variables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Variable path (e.g. "bg-primary").' },
              key: { type: 'string', description: 'Variable key from Figma.' },
              collection: { type: 'string', description: 'Collection name.' },
              category: { type: 'string', description: 'Category: text, background, border, foreground, spacing, radius, etc.' },
            },
            required: ['path', 'key'],
          },
          description: 'Array of variables to cache.',
        },
        expectedCount: {
          type: 'number',
          description: 'Total number of variables expected (from Figma MCP search results). Used to detect partial loads.',
        },
      },
      required: ['variables'],
    },
    async (args) => {
      for (const v of args.variables) {
        dsCache.addVariable(v.path, {
          key: v.key,
          collection: v.collection || null,
          category: v.category || null,
        });
      }

      // Send variable paths + keys to plugin for import
      const variableEntries = args.variables.map(v => ({ path: v.path, key: v.key }));
      const pluginResult = await bridge.send('preload_variables', { variables: variableEntries });
      session.toolCallCount++;

      const enforcement = dsCache.getEnforcementProfile();
      const cached = dsCache.variables.size;
      const expectedCount = args.expectedCount || null;
      const warning = expectedCount && cached < expectedCount * 0.8
        ? `Partial load: ${cached}/${expectedCount} variables cached. Some variables may be unavailable. Retry failed variables or proceed with available ones.`
        : null;

      return {
        cached,
        expectedVariables: expectedCount,
        warning,
        pluginImported: pluginResult?.preloadedVars || 0,
        enforcement,
        hint: 'Variables cached. Next: call figma_set_session_defaults to finalize the enforcement profile and advance to phase 2.',
      };
    }
  );

  // ── figma_set_session_defaults ────────────────────────────────
  registerTool(
    'figma_set_session_defaults',
    'Computes the enforcement profile from cached DS data and sends it to the plugin. Advances to Phase 2 (inventory ready).',
    {
      type: 'object',
      properties: {
        dsMode: {
          type: 'string',
          enum: ['strict', 'permissive'],
          description: 'DS enforcement mode. Defaults to strict when DS has tokens.',
        },
      },
      required: [],
    },
    async (args) => {
      const enforcement = dsCache.getEnforcementProfile();
      const dsMode = args.dsMode || (dsCache.variables.size > 0 ? 'strict' : 'permissive');

      if (dsMode === 'permissive' && dsCache.variables.size > 0) {
        return {
          error: 'DS_MODE_REJECTED',
          message: 'Cannot use permissive mode when DS has tokens. Strict mode is required.',
          enforcement,
        };
      }

      session.enforcementProfile = { ...enforcement, dsMode };

      const result = await bridge.send('set_session_defaults', {
        enforcementProfile: session.enforcementProfile,
      });

      advancePhase(2);
      session.toolCallCount++;

      return {
        phase: session.phase,
        enforcement: session.enforcementProfile,
        pluginResult: result,
        hint: 'Inventory complete. You can now build. Use figma_create_frame to start your artboard.',
      };
    }
  );

  // ── figma_list_text_styles ────────────────────────────────────
  registerTool(
    'figma_list_text_styles',
    'Returns all cached text styles from the DS.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const styles = [];
      for (const [key, style] of dsCache.textStyles) {
        styles.push({ key, ...style });
      }
      session.toolCallCount++;
      const totalExpected = session.expectedStyleCount || null;
      return {
        count: styles.length,
        totalExpected,
        partial: totalExpected ? styles.length < totalExpected * 0.8 : false,
        styles,
        hint: styles.length === 0
          ? 'No text styles cached. Call figma_preload_styles or figma_discover_library_styles first.'
          : totalExpected && styles.length < totalExpected * 0.8
            ? `Partial list: ${styles.length}/${totalExpected} styles. Some styles failed to load.`
            : 'Use the style key in figma_create_text or figma_set_text_style.',
      };
    }
  );

  // ── figma_discover_library_styles ─────────────────────────────
  registerTool(
    'figma_discover_library_styles',
    'Discovers and caches text styles from a Figma library file.',
    {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'Library file key.' },
      },
      required: ['fileKey'],
    },
    async (args) => {
      const result = await bridge.send('discover_library_styles', { fileKey: args.fileKey });
      session.toolCallCount++;

      if (result && result.styles) {
        for (const style of result.styles) {
          dsCache.addTextStyle(style.key, style);
        }
      }

      return {
        discovered: result?.styles?.length || 0,
        totalCached: dsCache.textStyles.size,
        result,
        hint: 'Styles discovered. Next: discover variables with figma_discover_library_variables.',
      };
    }
  );

  // ── figma_discover_library_variables ──────────────────────────
  registerTool(
    'figma_discover_library_variables',
    'Discovers and caches variables from a Figma library file.',
    {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'Library file key.' },
      },
      required: ['fileKey'],
    },
    async (args) => {
      const result = await bridge.send('discover_library_variables', { fileKey: args.fileKey });
      session.toolCallCount++;

      if (result && result.variables) {
        for (const v of result.variables) {
          dsCache.addVariable(v.path || v.name, {
            key: v.key,
            collection: v.collection || null,
            category: v.category || null,
          });
        }
      }

      const enforcement = dsCache.getEnforcementProfile();
      return {
        discovered: result?.variables?.length || 0,
        totalCached: dsCache.variables.size,
        enforcement,
        hint: 'Variables discovered. Call figma_set_session_defaults to finalize enforcement and advance to build phase.',
      };
    }
  );

  // ── figma_read_variable_values ────────────────────────────────
  registerTool(
    'figma_read_variable_values',
    'Returns cached variable values, optionally filtered by category.',
    {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category: text, background, border, foreground, spacing, radius. Omit for all.',
        },
      },
      required: [],
    },
    async (args) => {
      session.toolCallCount++;

      if (args.category) {
        const variables = dsResolver.listByCategory(args.category);
        return {
          category: args.category,
          count: variables.length,
          variables,
        };
      }

      const all = [];
      for (const [path, variable] of dsCache.variables) {
        all.push({ path, ...variable });
      }
      return {
        count: all.length,
        variables: all,
      };
    }
  );
}

module.exports = { register };
