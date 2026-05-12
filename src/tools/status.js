'use strict';

const { DsDiscovery } = require('../ds/discovery');

const PHASE_LABELS = {
  0: 'idle',
  1: 'discovery',
  2: 'inventory',
  3: 'build',
  4: 'qa',
  5: 'report',
};

const PHASE_HINTS = {
  0: 'Call mimic_discover_ds with a fileKey to start DS discovery.',
  1: 'Discovery in progress. Preload styles and variables, then call figma_set_session_defaults to advance to inventory.',
  2: 'DS inventory ready. You can now create frames, insert components, and build.',
  3: 'Build in progress. Use build/component/edit tools. When done, call mimic_generate_build_report — the build is NOT complete until the report is generated.',
  4: 'QA phase. Inspect nodes, verify DS compliance, fix issues. Then call mimic_generate_build_report.',
  5: 'Build complete. Report generated.',
};

function register(server, context) {
  const { bridge, dsCache, knowledgeStore, session, advancePhase, resetSession, registerTool } = context;

  // ── mimic_status ──────────────────────────────────────────────
  registerTool(
    'mimic_status',
    'Returns plugin connection status, current build phase, enforcement profile, knowledge store summary, and a contextual hint for what to do next.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      let pluginConnected = false;
      try {
        pluginConnected = bridge.connected;
      } catch { /* ignore */ }

      const enforcement = dsCache.getEnforcementProfile();
      const knowledgeSummary = {
        components: Object.keys(knowledgeStore.data.components).length,
        patterns: Object.keys(knowledgeStore.data.patterns).length,
        gaps: Object.keys(knowledgeStore.data.gaps).length,
        buildCount: knowledgeStore.data.meta.buildCount,
      };

      // Report pending warning: if we're in Phase 3/4 and have done build ops, remind about the report
      const buildOps = session.phaseToolCalls[3] || 0;
      const reportPending = session.phase >= 3 && session.phase < 5 && buildOps > 0;

      return {
        pluginConnected,
        phase: session.phase,
        phaseLabel: PHASE_LABELS[session.phase] || 'unknown',
        hint: PHASE_HINTS[session.phase] || 'Unknown phase.',
        artboardId: session.artboardId,
        enforcementProfile: session.enforcementProfile || enforcement,
        toolCallCount: session.toolCallCount,
        cacheHits: session.cacheHits,
        dsCache: {
          textStyles: dsCache.textStyles.size,
          variables: dsCache.variables.size,
          components: dsCache.components.size,
          failedKeys: dsCache.failedKeys.size,
        },
        knowledge: knowledgeSummary,
        ...(reportPending ? {
          reportPending: true,
          reportWarning: `⚠ BUILD REPORT REQUIRED: ${buildOps} build operations completed but no report generated. The build is NOT complete until you call mimic_generate_build_report. This is the tool's key differentiator — it teaches users about their DS usage, gaps, and patterns.`,
        } : {}),
      };
    }
  );

  // ── mimic_discover_ds ─────────────────────────────────────────
  registerTool(
    'mimic_discover_ds',
    'Complete DS discovery in one call. Discovers variables, text styles, and components from the file\'s enabled libraries. Preloads everything into cache and plugin. Computes enforcement profile. Advances to Phase 2 (build-ready). If multiple DS libraries are detected, returns a prompt — re-call with libraryKey to select one.',
    {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'Figma file key to discover DS from.' },
        libraryKey: { type: 'string', description: 'Library key to use when multiple DS libraries are available. Returned from a previous call that detected multiple libraries.' },
      },
      required: ['fileKey'],
    },
    async (args) => {
      const discovery = new DsDiscovery(bridge, dsCache, knowledgeStore);

      // If a library key was provided (second call), store it
      if (args.libraryKey) {
        discovery.setLibrary(args.libraryKey);
        session.selectedLibraryKey = args.libraryKey;
      } else if (session.selectedLibraryKey) {
        discovery.setLibrary(session.selectedLibraryKey);
      }

      // Verify plugin connection
      const libraryInfo = await discovery.enumerateLibrary();

      // ── Step 1: Discover variables (also detects multi-library) ──
      let varDiscovery;
      try {
        varDiscovery = await bridge.send('discover_library_variables', {});
      } catch (e) {
        // teamLibrary API not available (community files) — proceed with empty
        varDiscovery = { libraries: [], variables: [], totalVariables: 0 };
      }

      // Multi-library gate: if >1 library and none selected, ask user
      if (!session.selectedLibraryKey && varDiscovery.libraries && varDiscovery.libraries.length > 1) {
        session.toolCallCount++;
        const libs = varDiscovery.libraries.map(l => l.name);
        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase] || 'idle',
          fileKey: args.fileKey,
          library: libraryInfo,
          multipleLibraries: true,
          libraries: varDiscovery.libraries,
          discoveredVariables: varDiscovery.totalVariables,
          hint: `Multiple DS libraries detected: ${libs.join(', ')}. Ask the user which one is their design system, then re-call mimic_discover_ds with the chosen libraryKey set to the library name.`,
        };
      }

      // ── Step 2: Cache variables in MCP + preload in plugin ──
      const { inferCategory } = require('./ds-setup');
      let variablesCached = 0;
      let variablesPreloaded = 0;
      if (varDiscovery.variables && varDiscovery.variables.length > 0) {
        const variableEntries = [];
        for (const v of varDiscovery.variables) {
          const path = v.path || v.name;
          const category = v.category || inferCategory(path, v.resolvedType, v.collection);
          dsCache.addVariable(path, {
            key: v.key,
            collection: v.collection || null,
            category,
            libraryName: v.libraryName || null,
          });
          variablesCached++;
          if (v.key) variableEntries.push({ path, key: v.key });
        }
        // Preload into plugin
        if (variableEntries.length > 0) {
          try {
            const preloadResult = await bridge.send('preload_variables', { variables: variableEntries });
            variablesPreloaded = preloadResult?.preloadedVars || 0;
          } catch (e) { /* non-fatal */ }
        }
      }

      // ── Step 3: Discover text styles ──
      let stylesCached = 0;
      try {
        const styleResult = await bridge.send('discover_library_styles', { fileKey: args.fileKey });
        if (styleResult && styleResult.styles) {
          for (const style of styleResult.styles) {
            dsCache.addTextStyle(style.key, style);
            stylesCached++;
          }
        }
      } catch (e) { /* non-fatal */ }

      // ── Step 4: Discover components on page ──
      let componentsCached = 0;
      try {
        const compResult = await bridge.send('discover_library_components', { fileKey: args.fileKey });
        if (compResult && compResult.components) {
          for (const comp of compResult.components) {
            dsCache.addComponent(comp.key, {
              name: comp.name,
              isRemote: comp.isRemote,
              isComponentSet: comp.isComponentSet,
              variantCount: comp.variantCount,
              variantProperties: comp.variantProperties,
              description: comp.description,
            });
            componentsCached++;
          }
        }
      } catch (e) { /* non-fatal */ }

      // ── Step 5: Compute and set enforcement profile ──
      const enforcement = dsCache.getEnforcementProfile();
      const dsMode = dsCache.variables.size > 0 ? 'strict' : 'permissive';
      session.enforcementProfile = { ...enforcement, dsMode };

      try {
        await bridge.send('set_session_defaults', {
          enforcementProfile: session.enforcementProfile,
        });
      } catch (e) { /* non-fatal */ }

      // Advance to Phase 2 (build-ready)
      advancePhase(2);
      session.toolCallCount++;

      // Completeness warnings
      const completenessWarnings = [];
      if (variablesCached > 0 && variablesPreloaded < variablesCached * 0.8) {
        completenessWarnings.push(`Variables: only ${variablesPreloaded}/${variablesCached} preloaded into plugin. Some bindings may fail.`);
      }
      if (stylesCached === 0 && enforcement.enforceTextStyles) {
        completenessWarnings.push('No text styles found. Text style enforcement is ON but has no styles to offer.');
      }
      if (componentsCached === 0) {
        completenessWarnings.push('No components found on page. Use Figma MCP search_design_system to find them (search: button, input, badge, table cell, tabs, avatar, dropdown, textarea).');
      }

      return {
        phase: session.phase,
        phaseLabel: PHASE_LABELS[session.phase],
        fileKey: args.fileKey,
        library: libraryInfo,
        selectedLibraryKey: session.selectedLibraryKey || null,
        discoveredLibraries: varDiscovery.libraries || [],
        discovery: {
          variables: { cached: variablesCached, preloaded: variablesPreloaded },
          textStyles: { cached: stylesCached },
          components: { cached: componentsCached },
        },
        enforcement: session.enforcementProfile,
        completenessWarnings,
        hint: completenessWarnings.length > 0
          ? `Discovery complete with ${completenessWarnings.length} warning(s). Review completenessWarnings. NEXT: Call mimic_map_components with ALL section-level elements in your design (header, footer, sidebar, etc.) to find DS components BEFORE building. Target ~90% component usage.`
          : `Discovery complete. ${variablesCached} variables, ${stylesCached} text styles, ${componentsCached} components. Enforcement: ${dsMode}. NEXT: Call mimic_map_components with ALL section-level elements in your design (header, footer, sidebar, etc.) to find DS components BEFORE building. Target ~90% component usage.`,
      };
    }
  );
}

module.exports = { register };
