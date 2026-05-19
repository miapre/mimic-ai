'use strict';

/**
 * Infer a variable's category from its path, resolved type, and collection name.
 * Categories: text, background, border, foreground, spacing, radius, etc.
 */
function inferCategory(path, resolvedType, collection) {
  const p = (path || '').toLowerCase();
  const col = (collection || '').toLowerCase();

  // Spacing / radius from collection name or path
  if (col.includes('spacing') || p.startsWith('sp-') || p.includes('spacing')) return 'spacing';
  if (col.includes('radius') || p.startsWith('radius') || p.includes('corner')) return 'radius';

  // Color categories from path prefix or any segment in the path
  if (resolvedType === 'COLOR') {
    if (p.startsWith('text-') || p.startsWith('fg-text') || p.includes('/text/') || p.includes('/text-')) return 'text';
    if (p.startsWith('bg-') || p.startsWith('background') || p.includes('/background/') || p.includes('/bg-')) return 'background';
    if (p.startsWith('border-') || p.startsWith('stroke') || p.includes('/border/') || p.includes('/border-')) return 'border';
    if (p.startsWith('fg-') || p.startsWith('foreground') || p.includes('/foreground/') || p.includes('/fg-') || p.startsWith('icon')) return 'foreground';
    return 'color';
  }

  if (resolvedType === 'FLOAT') {
    if (p.includes('spacing') || p.includes('gap') || p.includes('padding')) return 'spacing';
    if (p.includes('radius') || p.includes('corner')) return 'radius';
    if (p.includes('size') || p.includes('font')) return 'typography';
    return 'number';
  }

  return null;
}

function register(server, context) {
  const { bridge, dsCache, dsResolver, knowledgeStore, session, advancePhase, registerTool } = context;

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
        ? `Partial load: ${cached}/${expectedCount} styles cached. Proceed with available styles. Missing styles will be flagged in the report.`
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
      if (!args.variables || !Array.isArray(args.variables)) {
        return { error: 'MISSING_VARIABLES', message: 'variables array is required. Use figma_discover_library_variables first to get the variable list.' };
      }
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
        ? `Partial load: ${cached}/${expectedCount} variables cached. Proceed with available variables. Missing variables will be flagged in the report.`
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
            ? `Partial list: ${styles.length}/${totalExpected} styles. Proceed with available styles.`
            : 'Use the style key in figma_create_text or figma_set_text_style.',
      };
    }
  );

  // ── figma_preload_fill_styles ─────────────────────────────────
  registerTool(
    'figma_preload_fill_styles',
    'Preloads fill (color) styles into the DS cache from a library file key. Call when discovery missed fill styles (e.g. library variables not enumerable but fill styles exist in the REST API).',
    {
      type: 'object',
      properties: {
        libraryFileKey: { type: 'string', description: 'Library file key to fetch fill styles from.' },
      },
      required: ['libraryFileKey'],
    },
    async (args) => {
      const figmaRest = context.figmaRest;
      if (!figmaRest) {
        return { error: 'FIGMA_TOKEN_REQUIRED', message: 'FIGMA_TOKEN not configured.' };
      }
      let fillCount = 0;
      let effectCount = 0;
      const fillKeys = [];
      try {
        const allStyles = await figmaRest.getAllStyles(args.libraryFileKey);
        for (const s of allStyles.fillStyles) {
          dsCache.addFillStyle(s.key, { name: s.name, description: s.description, source: 'rest_api' });
          fillKeys.push(s.key);
          fillCount++;
        }
        for (const s of allStyles.effectStyles) {
          dsCache.addEffectStyle(s.key, { name: s.name, description: s.description, source: 'rest_api' });
          effectCount++;
        }
      } catch (e) {
        return { error: 'FETCH_FAILED', message: e.message || 'Failed to fetch styles.' };
      }

      // Pre-import fill styles into the Figma plugin's styleCache
      // This prevents timeout on first use during builds
      let pluginPreloaded = 0;
      if (fillKeys.length > 0) {
        try {
          const preloadResult = await bridge.send('preload_fill_styles', { styleKeys: fillKeys });
          pluginPreloaded = preloadResult?.preloadedFillStyles || 0;
        } catch (e) { /* non-fatal — styles will be imported on first use */ }
      }

      session.toolCallCount++;
      const enforcement = dsCache.getEnforcementProfile();
      return {
        fillStylesCached: fillCount,
        effectStylesCached: effectCount,
        pluginPreloaded,
        enforcement,
        hint: `${fillCount} fill styles + ${effectCount} effect styles cached. ${pluginPreloaded} pre-imported in plugin. Use fillStyleId in create_frame, create_text, create_rectangle, or set_node_fill. Call figma_list_fill_styles to browse them.`,
      };
    }
  );

  // ── figma_list_fill_styles ────────────────────────────────────
  registerTool(
    'figma_list_fill_styles',
    'Returns all cached fill (color) styles from the DS. Use the style key as fillStyleId in create_frame, create_text, create_rectangle, create_ellipse, or set_node_fill.',
    { type: 'object', properties: {
      filter: { type: 'string', description: 'Optional keyword filter (e.g. "Blue", "Gray", "Red").' },
    }, required: [] },
    async (args) => {
      const styles = [];
      const filter = args.filter ? args.filter.toLowerCase() : null;
      for (const [key, style] of dsCache.fillStyles) {
        if (filter && !(style.name || '').toLowerCase().includes(filter)) continue;
        styles.push({ key, ...style });
      }
      session.toolCallCount++;
      return {
        count: styles.length,
        totalCached: dsCache.fillStyles.size,
        styles,
        hint: styles.length === 0
          ? 'No fill styles cached. Run discovery with a library file key to fetch fill styles.'
          : 'Use the style key as fillStyleId in create_frame, create_text, create_rectangle, or set_node_fill.',
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
        // Cache in MCP-side dsCache
        for (const v of result.variables) {
          const path = v.path || v.name;
          const category = v.category || inferCategory(path, v.resolvedType, v.collection);
          dsCache.addVariable(path, {
            key: v.key,
            collection: v.collection || null,
            category,
            libraryName: v.libraryName || null,
          });
        }

        // Auto-preload into plugin cache so getVariableByPath() can resolve them.
        // Without this, bindFillVariable/bindVariable silently fail because
        // library variables aren't in local collections — they must be imported
        // via importVariableByKeyAsync and cached.
        const variableEntries = result.variables
          .filter(v => v.key)
          .map(v => ({ path: v.path || v.name, key: v.key }));
        if (variableEntries.length > 0) {
          try {
            await bridge.send('preload_variables', { variables: variableEntries });
          } catch (e) {
            // Non-fatal: variables will need manual preload via figma_preload_variables
          }
        }
      }

      const enforcement = dsCache.getEnforcementProfile();
      return {
        discovered: result?.variables?.length || 0,
        totalCached: dsCache.variables.size,
        libraries: result?.libraries || [],
        _rawCollections: result?._rawCollections || [],
        enforcement,
        hint: 'Variables discovered. Call figma_set_session_defaults to finalize enforcement and advance to build phase.',
      };
    }
  );

  // ── figma_discover_library_components ──────────────────────────
  registerTool(
    'figma_discover_library_components',
    'Scans existing component instances on the current page to discover available DS library components, their keys, and variant properties. Call during DS discovery phase.',
    {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'Figma file key.' },
      },
      required: ['fileKey'],
    },
    async (args) => {
      const result = await bridge.send('discover_library_components', { fileKey: args.fileKey });
      session.toolCallCount++;

      // Cache discovered components
      if (result && result.components) {
        for (const comp of result.components) {
          dsCache.addComponent(comp.key, {
            name: comp.name,
            isRemote: comp.isRemote,
            isComponentSet: comp.isComponentSet,
            variantCount: comp.variantCount,
            variantProperties: comp.variantProperties,
            description: comp.description,
          });
        }
      }

      return {
        discovered: result?.totalFound || 0,
        instancesScanned: result?.totalInstancesScanned || 0,
        totalCached: dsCache.components.size,
        components: (result?.components || []).map(c => ({
          key: c.key,
          name: c.name,
          variantCount: c.variantCount,
          variantProperties: c.variantProperties?.map(vp => vp.name) || [],
        })),
        selectedLibrary: session.selectedLibraryKey || null,
        hint: result?.totalFound > 0
          ? `${result.totalFound} components discovered. Use these keys with figma_insert_component. For components not found here, use Figma MCP search_design_system to find them by name.${session.selectedLibraryKey ? ` ONLY use components from "${session.selectedLibraryKey}".` : ''}`
          : `No component instances on this page. Use Figma MCP search_design_system to find library components by name (search: button, input, badge, table cell, tabs, avatar, dropdown, textarea).${session.selectedLibraryKey ? ` ONLY use components from "${session.selectedLibraryKey}".` : ''}`,
      };
    }
  );

  // ── mimic_map_components ──────────────────────────────────────
  registerTool(
    'mimic_map_components',
    'Maps HTML element types to DS component keys. Call once to get initial mapping. If FIGMA_TOKEN is configured (REST API discovery), all library components are already cached — missing types after the first call are confirmed gaps, proceed to build. If REST API is not available (no token), search the library via Figma MCP search_design_system for missing types, then call AGAIN with librarySearchResults to confirm gaps.',
    {
      type: 'object',
      properties: {
        elementTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of HTML element types to map (e.g. ["button", "input", "badge", "table", "tab", "avatar", "dropdown", "textarea"]).',
        },
        librarySearchResults: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Component name from search results.' },
              componentKey: { type: 'string', description: 'Component key from search results.' },
              libraryName: { type: 'string', description: 'Library name the component belongs to.' },
              assetType: { type: 'string', description: 'Component type: "component" or "component_set".' },
            },
          },
          description: 'Component search results from Figma MCP search_design_system. Pass ALL results from your searches (any library — they will be filtered). This completes the search loop: matched components get cached, unmatched types get confirmed as "no component exists".',
        },
      },
      required: ['elementTypes'],
    },
    async (args) => {
      const { DsDiscovery } = require('../ds/discovery');
      const discovery = new DsDiscovery(bridge, dsCache, knowledgeStore);
      if (session.selectedLibraryKey) {
        discovery.setLibrary(session.selectedLibraryKey);
      }

      // If library search results are provided, ingest them into the cache first.
      // This closes the feedback loop: search → ingest → re-map → done.
      let ingested = 0;
      const hasLibrarySearchResults = Array.isArray(args.librarySearchResults);
      if (hasLibrarySearchResults) {
        ingested = discovery.ingestLibrarySearchResults(args.librarySearchResults);
      }

      // REST API discovery caches ALL library components — if present,
      // the first call already has full coverage, so missing = confirmed gap.
      const hasRestComponents = [...dsCache.components.values()].some(c => c.source === 'rest_api');
      const searchComplete = hasLibrarySearchResults || hasRestComponents;

      const map = discovery.buildComponentMap(args.elementTypes, {
        librarySearchComplete: searchComplete,
      });

      // If multi-library prompt, return it
      if (map.multipleLibraries) return map;

      const found = [];
      const missing = [];
      for (const [type, result] of Object.entries(map)) {
        if (result.found) {
          found.push({
            elementType: type,
            componentKey: result.componentKey,
            componentName: result.componentName || result.recipe?.name,
            source: result.source,
            isComponentSet: result.isComponentSet,
          });
        } else {
          missing.push({
            elementType: type,
            searchTerms: result.searchTerms || [type],
            message: result.message,
            fallbackRequired: Boolean(result.fallbackRequired),
            fallbackHint: result.fallbackHint,
            searchComplete: Boolean(result.searchComplete),
          });
        }
      }

      session.componentMap = {
        generatedAt: new Date().toISOString(),
        requested: args.elementTypes,
        components: found,
        notFound: missing,
      };

      // Build library filter guidance for Figma MCP searches
      const selectedLib = session.selectedLibraryKey || null;
      const libFilter = selectedLib
        ? ` Filter results to ONLY "${selectedLib}" — ignore components from other libraries.`
        : '';
      const libSearchNote = selectedLib
        ? `IMPORTANT: Only use components from "${selectedLib}". When calling Figma MCP search_design_system, check libraryName in results and discard any that don't match.`
        : '';

      // After search is complete, all missing types are confirmed gaps — no more searching needed
      if (searchComplete) {
        const newlyFound = ingested > 0 ? found.filter(f => f.source === 'ds_cache') : [];

        // Shell component recommendations — these are structural chrome
        // that every DS should have. If missing, surface a recommendation.
        const shellTypes = ['sidebar', 'header', 'footer', 'navigation'];
        const missingShell = missing.filter(m =>
          shellTypes.some(s => m.elementType.toLowerCase().includes(s))
        );
        const shellRecommendations = missingShell.length > 0
          ? {
            _shellRecommendation: {
              missing: missingShell.map(m => m.elementType),
              message: `Your DS is missing shell components: ${missingShell.map(m => m.elementType).join(', ')}. These define your app's structural chrome (navigation, layout frame) and should be consistent across all screens.`,
              recommendation: 'Create these as component sets in your DS library. Shell components ensure every screen built with Mimic uses the same navigation, header, and footer — matching your production app. Once published, Mimic will use them automatically.',
            },
          }
          : {};

        return {
          mapped: found.length,
          missing: missing.length,
          selectedLibrary: selectedLib,
          searchComplete: true,
          componentsIngested: ingested,
          components: found,
          notFound: missing.map(m => ({
            ...m,
            // Override hints — search is done, proceed with primitives
            fallbackHint: `No DS component for "${m.elementType}". Build as primitive frame with DS variables. Use confirmedNoComponent: true, primitiveOverrideReason: "No ${m.elementType} component in ${selectedLib || 'DS'} library".`,
          })),
          ...(libSearchNote ? { _libraryConstraint: libSearchNote } : {}),
          ...shellRecommendations,
          hint: missing.length > 0
            ? `Library search complete. ${found.length} components mapped, ${missing.length} confirmed gaps: ${missing.map(m => m.elementType).join(', ')}. Build these as primitive frames with DS variables — use confirmedNoComponent: true and primitiveOverrideReason for each. Proceed to build.`
            : 'All element types mapped to DS components. Use the componentKey values with figma_insert_component.',
        };
      }

      // First call (no search results yet) — identify section-level elements that are missing
      const sectionTypes = ['header', 'footer', 'sidebar', 'navigation', 'nav'];
      const missingSections = missing.filter(m => sectionTypes.some(s => m.elementType.toLowerCase().includes(s)));

      return {
        mapped: found.length,
        missing: missing.length,
        selectedLibrary: selectedLib,
        searchComplete: false,
        components: found,
        notFound: missing.map(m => ({
          ...m,
          fallbackHint: (m.fallbackHint || `Search the library using Figma MCP search_design_system with terms: ${m.searchTerms.join(', ')}.`) + libFilter,
        })),
        _componentFirstReminder: missing.length > 0
          ? `${missing.length} element type(s) not found in page instances. Search the DS library ONE TIME via Figma MCP search_design_system for the missing types. Then call mimic_map_components AGAIN with the same elementTypes + librarySearchResults containing ALL component results. That second call will finalize the mapping and confirm any gaps.${libFilter}`
          : undefined,
        _missingSectionWarning: missingSections.length > 0
          ? `Section-level elements missing: ${missingSections.map(m => m.elementType).join(', ')}. Include these in your library search.${libFilter}`
          : undefined,
        ...(libSearchNote ? { _libraryConstraint: libSearchNote } : {}),
        hint: missing.length > 0
          ? `${missing.length} element types not found in page instances. NEXT STEP: Search the DS library via Figma MCP search_design_system for: ${missing.map(m => m.elementType).join(', ')}. Then call mimic_map_components again with librarySearchResults to close the loop.${libFilter}`
          : 'All element types mapped to DS components. Use the componentKey values with figma_insert_component.',
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

module.exports = { register, inferCategory };
