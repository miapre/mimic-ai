'use strict';

const { DsDiscovery } = require('../ds/discovery');
const { computeLibraryId } = require('../knowledge/store');
const { buildStructuredFingerprint, diffFingerprints } = require('../ds/fingerprint');
const { wordBoundaryMatch } = require('../utils/text-match');

/**
 * React to fingerprint diff classifications that require a store mutation
 * (spec §4.3): a rename (same key) updates recipe.names — appends the new
 * name, keeps the old as an alias — and NEVER marks the recipe stale. A
 * token rename (same variable key, new path) updates any auto-compiled rule
 * text that cites the old path.
 */
function applyFingerprintDiffReactions(knowledgeStore, fpDiff) {
  for (const d of fpDiff.componentDiffs) {
    if (d.type !== 'renamed') continue;
    for (const recipe of Object.values(knowledgeStore.data.components || {})) {
      if (recipe.componentKey !== d.key) continue;
      const names = recipe.names || [];
      if (d.newName && !names.includes(d.newName)) names.unshift(d.newName);
      if (d.oldName && !names.includes(d.oldName)) names.push(d.oldName);
      recipe.names = names;
    }
  }
  for (const d of fpDiff.variableDiffs) {
    if (d.type !== 'token_renamed') continue;
    for (const [ruleId, rule] of Object.entries(knowledgeStore.data.rules || {})) {
      if (rule.rule && d.oldPath && rule.rule.includes(d.oldPath)) {
        knowledgeStore.setRule(ruleId, { ...rule, rule: rule.rule.split(d.oldPath).join(d.newPath) });
      }
    }
  }
}

/**
 * Gap lifecycle (spec §4.5/§5.4, defect L): a `component_added` diff entry
 * matched against an OPEN gap's searchTerms/name (word-boundary) marks that
 * gap `resolved-pending` — the report leads with this as the payoff moment.
 * Full `resolved` status is set on the first successful insert of the
 * resolving component (components.js, figma_insert_component).
 */
function resolveGapsFromDiff(knowledgeStore, fpDiff) {
  const added = (fpDiff.componentDiffs || []).filter(d => d.type === 'component_added' && d.name);
  if (added.length === 0) return [];
  const resolved = [];
  for (const [gapName, gap] of Object.entries(knowledgeStore.data.gaps || {})) {
    if (gap.status !== 'open') continue;
    const searchTerms = gap.searchTerms && gap.searchTerms.length > 0 ? gap.searchTerms : [gapName];
    const match = added.find(d => searchTerms.some(t => wordBoundaryMatch(t, d.name)) || wordBoundaryMatch(gapName, d.name));
    if (match) {
      knowledgeStore.markGapResolvedPending(gapName, match.key);
      resolved.push({ gapName, componentKey: match.key, componentName: match.name });
    }
  }
  return resolved;
}

/**
 * Staleness extension (spec §4.4): per recipe with defaultVariants/
 * variantStats, compare against the live variant schema.
 *   - component missing from the live cache -> stale (component_removed);
 *     3 consecutive discoveries still missing -> archived.
 *   - a stored property no longer present live -> stale (variant_property_removed).
 *   - a stored DEFAULT VALUE no longer among the live values for that
 *     property -> stale (variant_value_removed, NEW — closes finding 4:
 *     replay of a nonexistent value becomes impossible).
 *   - a live value with zero observations in variantStats (a value was
 *     ADDED) -> needsReverify + demote (verified -> confirmed), not stale.
 * `default_changed` (the DS's own declared default changing to an
 * already-known value) is NOT detected here — neither the plugin's
 * page-scan discovery nor the REST API surfaces a canonical "default value"
 * per variant property through the existing discovery handlers (only the
 * set of legal values), so there is nothing to compare against. Documented
 * limitation, not a silent gap — see the worker report.
 */
function applyStalenessV3(knowledgeStore, dsComponentKeys, dsVariantProperties) {
  const results = [];
  for (const [key, recipe] of Object.entries(knowledgeStore.data.components || {})) {
    if (!recipe.componentKey || recipe.archived) continue;

    const isLive = dsComponentKeys.has(recipe.componentKey);
    if (!isLive) {
      if (!recipe.stale) {
        knowledgeStore.markRecipeStale(key, 'component_removed');
        results.push({ key, names: recipe.names || [], reason: 'component_removed' });
      }
      recipe._missingStreak = (recipe._missingStreak || 0) + 1;
      if (recipe._missingStreak >= 3) recipe.archived = true;
      continue;
    }
    if (recipe._missingStreak) recipe._missingStreak = 0;
    if (recipe.stale) continue; // already flagged — clears only via self-heal (components.js)

    const liveSchema = dsVariantProperties[recipe.componentKey];
    if (!liveSchema) continue; // no variant schema data from this source (defect I)

    const liveValuesByProp = {};
    if (Array.isArray(liveSchema)) {
      for (const vp of liveSchema) liveValuesByProp[vp.name] = (vp.values || []).map(String);
    } else {
      for (const [propName, vp] of Object.entries(liveSchema)) liveValuesByProp[propName] = (vp.values || []).map(String);
    }
    const currentProps = new Set(Object.keys(liveValuesByProp));
    const checkedProps = new Set([
      ...Object.keys(recipe.defaultVariants || {}),
      ...Object.keys(recipe.variantStats || {}),
    ]);

    let stale = false;
    let needsReverify = false;
    for (const prop of checkedProps) {
      if (!currentProps.has(prop)) {
        knowledgeStore.markRecipeStale(key, 'variant_property_removed');
        results.push({ key, names: recipe.names || [], reason: 'variant_property_removed' });
        stale = true;
        break;
      }
      const liveValues = liveValuesByProp[prop] || [];
      const storedValue = recipe.defaultVariants && recipe.defaultVariants[prop];
      if (storedValue && !liveValues.includes(String(storedValue))) {
        knowledgeStore.markRecipeStale(key, 'variant_value_removed');
        results.push({ key, names: recipe.names || [], reason: 'variant_value_removed' });
        stale = true;
        break;
      }
      const observedValues = recipe.variantStats && recipe.variantStats[prop] ? Object.keys(recipe.variantStats[prop]) : [];
      if (liveValues.some(v => !observedValues.includes(v))) needsReverify = true;
    }

    if (!stale && needsReverify && !recipe.needsReverify) {
      knowledgeStore.demoteRecipe(key, 'variant_schema_changed');
      results.push({ key, names: recipe.names || [], reason: 'needs_reverify' });
    }
  }
  return results;
}

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
  1: 'Discovery in progress. Preload styles and variables via mimic_ds_assets, then call mimic_ds_assets (action: "set_defaults") to advance to inventory.',
  2: 'DS inventory ready. You can now create frames, insert components, and build.',
  3: 'Build in progress. Use build/component/edit tools. When done, call mimic_generate_build_report — the build is NOT complete until the report is generated.',
  4: 'QA phase. Inspect nodes, verify DS compliance, fix issues. Then call mimic_generate_build_report.',
  5: 'Build complete. Report generated.',
};

function register(server, context) {
  const { bridge, dsCache, knowledgeStore, session, advancePhase, resetSession, registerTool, figmaRest } = context;

  // ── mimic_status ──────────────────────────────────────────────
  registerTool(
    'mimic_status',
    'START EVERY SESSION HERE. Returns Figma plugin connection status, the current build phase (0=idle through 5=report), enforcement profile, cached DS counts, knowledge store summary (learned components/patterns/gaps/rules), and a contextual `hint` telling you exactly what to call next. Also clears build-interrupt state after a plugin reconnect and warns if a completed build is missing its mandatory report. No params — call with no arguments.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      let pluginConnected = false;
      try {
        pluginConnected = bridge.connected;
      } catch { /* ignore */ }

      // Clear build interruption when plugin has reconnected.
      // The user called mimic_status after reconnecting — safe to resume.
      if (session.buildInterrupted && pluginConnected) {
        session.buildInterrupted = false;
      }

      const enforcement = dsCache.getEnforcementProfile();
      const rules = knowledgeStore.getActiveRules();
      const ruleCount = Object.keys(rules).length;
      const knowledgeSummary = {
        components: Object.keys(knowledgeStore.data.components).length,
        patterns: Object.keys(knowledgeStore.data.patterns).length,
        gaps: Object.keys(knowledgeStore.data.gaps).length,
        rules: ruleCount,
        buildCount: knowledgeStore.data.meta.buildCount,
      };

      // Report pending warning: if we're in Phase 3/4 and have done build ops, remind about the report
      const buildOps = session.phaseToolCalls[3] || 0;
      const reportPending = session.phase >= 3 && session.phase < 5 && buildOps > 0;

      // Build interruption recovery info
      const interruptInfo = session.buildInterrupted
        ? {
          buildInterrupted: true,
          buildInterruptedWarning: pluginConnected
            ? 'Build was interrupted by a plugin disconnect but the plugin is now reconnected. Session resumed — you can continue building.'
            : '⚠ BUILD INTERRUPTED: Plugin disconnected during an active build. STOP ALL BUILDING. Do NOT use other Figma tools as a fallback. Reconnect the plugin and call mimic_status again.',
        }
        : {};

      return {
        pluginConnected,
        phase: session.phase,
        phaseLabel: PHASE_LABELS[session.phase] || 'unknown',
        hint: session.buildInterrupted && !pluginConnected
          ? 'Plugin disconnected during build. Reconnect the plugin, then call mimic_status to resume.'
          : PHASE_HINTS[session.phase] || 'Unknown phase.',
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
        // Inject user-defined design rules so they're visible at build start.
        // These are persistent rules the user defined during previous builds.
        ...(ruleCount > 0 ? {
          _designRules: Object.entries(rules).map(([id, r]) => ({
            id,
            category: r.category,
            rule: r.rule,
            reason: r.reason || undefined,
          })),
          _designRulesNote: `${ruleCount} user-defined design rule(s) loaded from knowledge store. Follow ALL of these during the build — they override default behavior.`,
        } : {}),
        // Surface stale recipes so the LLM knows which components may have changed
        ...((() => {
          const staleRecipes = Object.entries(knowledgeStore.data.components)
            .filter(([, r]) => r.stale)
            .map(([key, r]) => ({
              key,
              names: r.names || [],
              reason: r.staleReason,
              lastUsed: r.lastUsed,
              action: 'Will skip auto-replay until used successfully. No action needed.',
            }));
          if (staleRecipes.length === 0) return {};
          return {
            _staleRecipes: staleRecipes,
            _staleRecipesNote: `${staleRecipes.length} recipe(s) may be outdated since DS changed. They won't auto-apply until re-validated by a successful build.`,
          };
        })()),
        ...interruptInfo,
        ...(reportPending ? {
          reportPending: true,
          reportWarning: `⚠ BUILD REPORT REQUIRED: ${buildOps} build operations completed but no report generated. The build is NOT complete until you call mimic_generate_build_report. This is the tool's key differentiator — it teaches users about their DS usage, gaps, and patterns.`,
        } : {}),
      };
    },
    {
      annotations: { title: 'Get build status (start here)', readOnlyHint: true, idempotentHint: true },
      outputSchema: {
        type: 'object',
        properties: {
          pluginConnected: { type: 'boolean' },
          phase: { type: 'number', description: '0=idle, 1=discovery, 2=inventory, 3=build, 4=qa, 5=report.' },
          phaseLabel: { type: 'string' },
          hint: { type: 'string', description: 'What to call next.' },
          toolCallCount: { type: 'number' },
          cacheHits: { type: 'number' },
          dsCache: {
            type: 'object',
            properties: {
              textStyles: { type: 'number' },
              variables: { type: 'number' },
              components: { type: 'number' },
              failedKeys: { type: 'number' },
            },
          },
          knowledge: {
            type: 'object',
            properties: {
              components: { type: 'number' },
              patterns: { type: 'number' },
              gaps: { type: 'number' },
              rules: { type: 'number' },
              buildCount: { type: 'number' },
            },
          },
        },
        required: ['pluginConnected', 'phase', 'hint'],
      },
    }
  );

  // ── mimic_discover_ds ─────────────────────────────────────────
  registerTool(
    'mimic_discover_ds',
    'Complete DS discovery in two steps. Step 1: call with fileKey — discovers variables, text styles, components via plugin API, caches everything, stays at Phase 1. Step 2: call again with communitySearchResults (library names from Figma MCP search_design_system) — verifies no community libraries were missed, then advances to Phase 2 (build-ready). Build tools are BLOCKED until Step 2 completes. If a community library\'s variables are not discoverable via the plugin API (communityVariablesRequired response), fetch them via Figma MCP search_design_system and pass as externalVariables.',
    {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'Figma file key to discover DS from.' },
        libraryKey: { type: 'string', description: 'Library key to use when multiple DS libraries are available. Returned from a previous call that detected multiple libraries.' },
        communitySearchResults: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unique library names found via Figma MCP search_design_system (query "color", includeVariables: true). Required after initial discovery to verify no community libraries were missed. Pass only non-null libraryName values.',
        },
        communitySearchVariableKeys: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Map of libraryName → one sample variable key from search results. Used to validate which libraries are actually enabled in the file. Extract one key per library from the color search results.',
        },
        libraryFileKey: {
          type: 'string',
          description: 'Library file key (alphanumeric string from the Figma URL of the library file). Prompted once per library, cached permanently.',
        },
        skipRestApi: {
          type: 'boolean',
          description: 'Skip REST API component discovery (e.g. for community libraries where the file key is unavailable). Discovery proceeds with plugin-only data; use Figma MCP search_design_system + mimic_map_components to find components.',
        },
        externalVariables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Variable name/path (e.g. "colors/content/content1").' },
              key: { type: 'string', description: 'Variable key from Figma MCP search results.' },
              resolvedType: { type: 'string', description: 'Variable type: COLOR, FLOAT, STRING, BOOLEAN.' },
              collection: { type: 'string', description: 'Collection name (e.g. "palette", "spacing").' },
              libraryName: { type: 'string', description: 'Library name the variable belongs to.' },
            },
          },
          description: 'Variables fetched via Figma MCP search_design_system for community libraries whose variables are not discoverable via the plugin API. Pass after receiving a communityVariablesRequired response.',
        },
        identityDriftChoice: {
          type: 'string',
          enum: ['same', 'different'],
          description: 'Answer to a library-identity-drift prompt (name-keyed community library where most previously-known components vanished). "same" keeps learning under the existing history; "different" starts a fresh bucket for this library.',
        },
      },
      required: ['fileKey'],
    },
    async (args) => {
      // Block new discovery if a previous build has no report
      if (context.requireReportIfPending) {
        context.requireReportIfPending();
      }
      const discovery = new DsDiscovery(bridge, dsCache, knowledgeStore);

      // ── Token gate ──
      if (!figmaRest) {
        return {
          phase: 0,
          phaseLabel: 'idle',
          _stopBuild: true,
          error: 'FIGMA_TOKEN_REQUIRED',
          _userPrompt:
            'Mimic needs a Figma access token to read your design system. ' +
            'This is a one-time setup that takes about 30 seconds. ' +
            'Once configured, Mimic will automatically discover your components, text styles, and variables on every build.\n\n' +
            '## Generate the token\n\n' +
            '1. Open Figma \u2192 click your profile avatar (top-left) \u2192 **Settings**\n' +
            '2. Go to **Security** \u2192 **Personal access tokens**\n' +
            '3. Click **Generate new token**\n' +
            '4. Token name: `Mimic AI`\n' +
            '5. Expiration: **90 days** (the maximum)\n' +
            '6. Scopes \u2014 check these five (in the order they appear):\n\n' +
            '   \u2611 `current_user:read` \u2014 lets Mimic verify the token is valid\n' +
            '   \u2611 `file_content:read` \u2014 lets Mimic read your file structure\n' +
            '   \u2611 `file_metadata:read` \u2014 lets Mimic check file access\n' +
            '   \u2611 `library_assets:read` \u2014 lets Mimic read published component data\n' +
            '   \u2611 `library_content:read` \u2014 lets Mimic read published styles and variables\n\n' +
            '   All five are read-only. Mimic never modifies your library files.\n\n' +
            '7. Click **Generate token** and copy it immediately (starts with `figd_`)\n\n' +
            '## Add the token\n\n' +
            'Add FIGMA_TOKEN to your MCP server config:\n\n' +
            '```json\n' +
            '{\n' +
            '  "mcpServers": {\n' +
            '    "mimic-ai": {\n' +
            '      "command": "npx",\n' +
            '      "args": ["-y", "@miapre/mimic-ai"],\n' +
            '      "env": {\n' +
            '        "FIGMA_TOKEN": "figd_your-token-here"\n' +
            '      }\n' +
            '    }\n' +
            '  }\n' +
            '}\n' +
            '```\n\n' +
            'If your MCP client doesn\'t pass env vars through, create `~/.mimic-ai.json` instead:\n\n' +
            '```json\n' +
            '{ "figmaToken": "figd_your-token-here" }\n' +
            '```\n\n' +
            'Then restart the MCP connection and run discovery again. You\'re all set.',
          hint: 'STOP \u2014 present _userPrompt to the user. Build cannot proceed without FIGMA_TOKEN.',
        };
      }

      // ── Token validation (every discovery call) ──
      try {
        await figmaRest.validateToken();
      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('FIGMA_TOKEN_INVALID') || msg.includes('401')) {
          return {
            phase: 0,
            phaseLabel: 'idle',
            _stopBuild: true,
            error: 'FIGMA_TOKEN_EXPIRED',
            _userPrompt:
              'Your Figma access token has expired or is invalid. Tokens last 90 days \u2014 time to generate a fresh one.\n\n' +
              '1. Figma \u2192 profile avatar (top-left) \u2192 **Settings** \u2192 **Security** \u2192 **Personal access tokens**\n' +
              '2. **Generate new token** \u2014 name: `Mimic AI`, expiration: 90 days\n' +
              '3. Scopes \u2014 check these five:\n' +
              '   \u2611 `current_user:read`\n' +
              '   \u2611 `file_content:read`\n' +
              '   \u2611 `file_metadata:read`\n' +
              '   \u2611 `library_assets:read`\n' +
              '   \u2611 `library_content:read`\n' +
              '4. Copy the new token and update FIGMA_TOKEN in your MCP config (or `~/.mimic-ai.json`)\n' +
              '5. Restart the MCP connection',
            hint: 'STOP \u2014 token expired. Present _userPrompt to the user.',
          };
        }
        // Network error — non-fatal, proceed with cached data if available
        if (!msg.includes('FIGMA_NETWORK')) {
          return {
            phase: 0, _stopBuild: true,
            error: msg.split(':')[0],
            _userPrompt: msg.split(': ').slice(1).join(': '),
            hint: 'STOP \u2014 present error to user.',
          };
        }
      }

      // ── Variable mismatch confirmation flow ─────────────────────
      // If we're waiting for the user to confirm the variable source mismatch,
      // handle their choice before anything else.
      if (session.pendingVariableMismatchConfirmation && args.libraryKey) {
        session.toolCallCount++;
        const choice = args.libraryKey.trim().toUpperCase();
        const sourceLibs = session.variableMismatchSourceLibs || [];

        if (choice === 'A' || choice.startsWith('A)') || choice.toLowerCase().includes('continue') || choice.toLowerCase().includes('mixed')) {
          // Accept mixed sources — advance to Phase 2 with current selection
          session.pendingVariableMismatchConfirmation = false;
          session.variableMismatchSourceLibs = null;
          session.variableSourceConfirmed = 'mixed';
          advancePhase(2);

          const variablesCached = dsCache.variables.size;
          const stylesCached = dsCache.textStyles.size;
          const componentsCached = dsCache.components.size;

          return {
            phase: session.phase,
            phaseLabel: PHASE_LABELS[session.phase],
            fileKey: session.discoveryFileKey || args.fileKey,
            selectedLibraryKey: session.selectedLibraryKey || null,
            variableSourceConfirmed: 'mixed',
            variableSourceLibraries: sourceLibs,
            discovery: {
              variables: { cached: variablesCached },
              textStyles: { cached: stylesCached },
              components: { cached: componentsCached },
            },
            enforcement: session.enforcementProfile,
            _libraryConstraint: `Components from "${session.selectedLibraryKey}". Variables/text styles from ${sourceLibs.join(', ')}. User confirmed mixed-source build.`,
            hint: `Variable mismatch confirmed — mixed-source build. Components from "${session.selectedLibraryKey}", variables from ${sourceLibs.join(', ')}. NEXT: Call mimic_map_components with ALL section-level elements in your design.`,
          };
        } else if (choice === 'B' || choice.startsWith('B)') || (sourceLibs.length > 0 && choice.toLowerCase().includes(sourceLibs[0].toLowerCase()))) {
          // Switch to the variable source library for everything
          session.pendingVariableMismatchConfirmation = false;
          session.variableMismatchSourceLibs = null;
          const switchTo = sourceLibs[0];
          // Reset and re-run discovery with the new library
          session.selectedLibraryKey = null;
          session.phase = 0;
          // Trigger fresh discovery with the variable source library
          return {
            phase: 0,
            phaseLabel: 'idle',
            switchingLibrary: switchTo,
            _instruction: `Re-call mimic_discover_ds with libraryKey set to "${switchTo}" to switch to this library for components AND variables.`,
            hint: `User chose to switch to "${switchTo}". Re-call mimic_discover_ds with fileKey and libraryKey: "${switchTo}".`,
          };
        } else if (choice === 'C' || choice.startsWith('C)') || choice.toLowerCase().includes('different')) {
          // User wants to pick a different library — go back to multi-library prompt
          session.pendingVariableMismatchConfirmation = false;
          session.variableMismatchSourceLibs = null;
          session.selectedLibraryKey = null;
          session.phase = 0;
          return {
            phase: 0,
            phaseLabel: 'idle',
            _instruction: 'Re-call mimic_discover_ds with fileKey to restart discovery and pick a different library.',
            hint: 'User wants a different library. Re-call mimic_discover_ds with fileKey (no libraryKey) to restart discovery.',
          };
        }
        // Unrecognized choice — repeat the prompt
        return {
          phase: 1,
          phaseLabel: 'discovery',
          _stopBuild: true,
          _userPrompt:
            `I didn't understand that choice. Please reply with:\n` +
            `A) Continue with mixed sources\n` +
            `B) Switch to ${sourceLibs[0]} for everything\n` +
            `C) Pick a different library`,
          hint: 'User response not recognized. Present _userPrompt again.',
        };
      }

      // If mismatch confirmation is pending but no libraryKey provided, remind
      if (session.pendingVariableMismatchConfirmation && !args.libraryKey) {
        session.toolCallCount++;
        const sourceLibs = session.variableMismatchSourceLibs || [];
        return {
          phase: 1,
          phaseLabel: 'discovery',
          _stopBuild: true,
          _userPrompt:
            `⚠ Variable source mismatch still needs your decision:\n\n` +
            `A) Continue with mixed sources (${session.selectedLibraryKey} components + ${sourceLibs.join(', ')} variables)\n` +
            `B) Switch to ${sourceLibs[0]} for everything\n` +
            `C) Pick a different library`,
          hint: 'Variable mismatch confirmation still pending. Present _userPrompt and wait for user choice. Pass their choice as libraryKey.',
        };
      }

      // ── External variables flow (community library variable injection) ──
      // When a community library's variables can't be enumerated by the plugin
      // API, Claude fetches them via Figma MCP and passes them here.
      if (session.pendingExternalVariables && args.externalVariables && args.externalVariables.length > 0) {
        session.toolCallCount++;
        session.pendingExternalVariables = false;

        // The selected library is a community library whose variables weren't
        // discoverable by the plugin. The text styles cached during Step 1 came
        // from OTHER libraries (whatever was on the page) — they do NOT belong
        // to the selected library. Clear them so the enforcement profile won't
        // force usage of another library's text styles.
        if (dsCache.textStyles.size > 0) {
          dsCache.textStyles.clear();
          // Also clear the plugin-side style cache
          try {
            await bridge.send('clear_style_cache');
          } catch (e) { /* non-fatal — plugin may not support this yet */ }
        }

        const { inferCategory } = require('./ds-setup');
        let injectedCount = 0;
        const variableEntries = [];
        for (const v of args.externalVariables) {
          const path = v.name;
          const category = inferCategory(path, v.resolvedType, v.collection);
          dsCache.addVariable(path, {
            key: v.key,
            collection: v.collection || null,
            category,
            libraryName: v.libraryName || session.selectedLibraryKey || null,
          });
          injectedCount++;
          if (v.key) variableEntries.push({ path, key: v.key });
        }

        // Preload into plugin so importVariableByKeyAsync can resolve them
        if (variableEntries.length > 0) {
          try {
            await bridge.send('preload_variables', { variables: variableEntries });
          } catch (e) { /* non-fatal */ }
        }

        // Recompute enforcement profile with new variables
        const enforcement = dsCache.getEnforcementProfile();
        const dsMode = dsCache.variables.size > 0 ? 'strict' : 'permissive';
        session.enforcementProfile = { ...enforcement, dsMode };

        try {
          await bridge.send('set_session_defaults', {
            enforcementProfile: session.enforcementProfile,
          });
        } catch (e) { /* non-fatal */ }

        // Advance to Phase 2 — build-ready
        advancePhase(2);

        const variablesCached = dsCache.variables.size;
        const stylesCached = dsCache.textStyles.size;
        const componentsCached = dsCache.components.size;

        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase],
          fileKey: session.discoveryFileKey || args.fileKey,
          selectedLibraryKey: session.selectedLibraryKey || null,
          externalVariablesInjected: injectedCount,
          discovery: {
            variables: { cached: variablesCached },
            textStyles: { cached: stylesCached },
            components: { cached: componentsCached },
          },
          enforcement: session.enforcementProfile,
          hint: `External variables injected: ${injectedCount} from "${session.selectedLibraryKey}". Total cached: ${variablesCached} variables, ${stylesCached} text styles, ${componentsCached} components. Enforcement: ${dsMode}. NEXT: Call mimic_map_components with ALL section-level elements in your design.`,
        };
      }

      // If external variables are pending but none provided, remind
      if (session.pendingExternalVariables && !args.externalVariables) {
        session.toolCallCount++;
        const libName = session.selectedLibraryKey;
        const libKey = session.externalVariablesLibraryKey;
        return {
          phase: 1,
          phaseLabel: 'discovery',
          _stopBuild: true,
          communityVariablesRequired: true,
          targetLibrary: libName,
          targetLibraryKey: libKey,
          hint: `External variables still needed. Search for variables from "${libName}" using Figma MCP search_design_system with includeLibraryKeys: ["${libKey}"], includeVariables: true, includeComponents: false, includeStyles: false. Run multiple queries to cover all variable types (e.g. "color", "spacing", "shape", "typography", "breakpoint"). Collect all results and re-call mimic_discover_ds with externalVariables array containing: name, key, resolvedType, collection, libraryName for each variable.`,
        };
      }

      // ── Community check confirmation flow ──────────────────────
      // If plugin discovery already completed and we're waiting for the
      // community library check, handle that before re-running discovery.
      if (session.pendingCommunityCheck && args.communitySearchResults) {
        const pluginNames = (session.discoveredLibraries || []).map(l => l.name);
        const searchNames = args.communitySearchResults;
        const newLibraries = searchNames.filter(n => n && !pluginNames.includes(n));

        // Store variable keys for later use (external variable fetch, validation)
        if (args.communitySearchVariableKeys) {
          session.communityLibraryVariableKeys = args.communitySearchVariableKeys;
        }

        if (newLibraries.length > 0) {
          // Validate which new libraries are actually enabled in the file
          // by asking the plugin to try importing a variable from each.
          const varKeys = args.communitySearchVariableKeys || {};
          const candidates = [];
          for (const libName of newLibraries) {
            const varKey = varKeys[libName];
            if (varKey) {
              candidates.push({ name: libName, variableKey: varKey });
            }
          }

          // Ask plugin to validate library access against
          // getAvailableLibraryVariableCollectionsAsync (authoritative).
          // Fallback: reject all — phantom libraries must never leak through.
          let validatedNames = [];
          if (candidates.length > 0) {
            try {
              const validation = await bridge.send('validate_library_access', { candidates });
              if (validation && validation.results) {
                const accessible = new Set(
                  validation.results.filter(r => r.accessible).map(r => r.name)
                );
                // Only keep libraries confirmed accessible by the plugin.
                // Libraries without a variable key are rejected (no way to validate).
                validatedNames = newLibraries.filter(n => accessible.has(n));
              }
            } catch (e) { /* validation failed — validatedNames stays empty */ }
          }

          if (validatedNames.length > 0) {
            // Build option list from plugin-discovered + validated search libraries
            const allNames = [...new Set([...pluginNames, ...validatedNames])];

            // If only 1 library total after filtering, auto-select — don't bother the user
            if (allNames.length === 1) {
              session.pendingCommunityCheck = false;
              session.selectedLibraryKey = allNames[0];
              advancePhase(2);
              session.toolCallCount++;
              return {
                phase: session.phase,
                phaseLabel: PHASE_LABELS[session.phase],
                fileKey: session.discoveryFileKey,
                autoSelected: true,
                selectedLibraryKey: allNames[0],
                discovery: session.discoveryResults,
                enforcement: session.enforcementProfile,
                hint: `Only one library found in file: "${allNames[0]}". Auto-selected. NEXT: Call mimic_map_components with ALL section-level elements in your design.`,
              };
            }

            const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            const options = allNames.map((name, i) => ({
              letter: letters[i] || String(i + 1),
              name,
              libraryKey: name,
              source: pluginNames.includes(name) ? 'plugin' : 'search',
            }));
            const optionsList = options.map(o =>
              `${o.letter}) ${o.name}`
            ).join('\n');

            // Reset pending so re-call with libraryKey triggers fresh discovery
            session.pendingCommunityCheck = false;
            session.toolCallCount++;

            return {
              phase: session.phase,
              phaseLabel: PHASE_LABELS[session.phase],
              fileKey: session.discoveryFileKey,
              multipleLibraries: true,
              options,
              _stopBuild: true,
              _userPrompt: `Multiple design system libraries detected on this file.\nWhich one should I use for this build?\n\n${optionsList}\n\nReply with the letter (e.g. "use A").`,
              hint: 'STOP — multiple libraries found. Present _userPrompt to the user EXACTLY as written and wait for their choice. Then re-call mimic_discover_ds with libraryKey set to the chosen library name.',
            };
          }
          // All new libraries were phantoms — fall through to "no new libraries"
        }

        // No new libraries — safe to advance to Phase 2
        session.pendingCommunityCheck = false;
        advancePhase(2);
        session.toolCallCount++;

        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase],
          fileKey: session.discoveryFileKey,
          communityCheckPassed: true,
          selectedLibraryKey: session.selectedLibraryKey || null,
          discoveredLibraries: session.discoveredLibraries || [],
          discovery: session.discoveryResults,
          enforcement: session.enforcementProfile,
          completenessWarnings: session.completenessWarnings || [],
          hint: `Community library check passed. ${session.discoveryResults?.variables?.cached || 0} variables, ${session.discoveryResults?.textStyles?.cached || 0} text styles, ${session.discoveryResults?.components?.cached || 0} components. Enforcement: ${session.enforcementProfile?.dsMode || 'unknown'}.${session.selectedLibraryKey ? ` Selected library: "${session.selectedLibraryKey}" — ALL components and Figma MCP searches must use ONLY this library.` : ''} NEXT: Call mimic_map_components with ALL section-level elements in your design (header, footer, sidebar, etc.) to find DS components BEFORE building. Target ~90% component usage.`,
        };
      }

      // If community check is pending but no search results provided, remind
      if (session.pendingCommunityCheck && !args.libraryKey && !args.communitySearchResults) {
        session.toolCallCount++;
        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase],
          fileKey: session.discoveryFileKey,
          communityLibraryCheckRequired: true,
          _stopBuild: true,
          discoveredLibraries: session.discoveredLibraries || [],
          hint: `Community library check still pending. You MUST call Figma MCP search_design_system with query "color", includeVariables: true, includeComponents: false, includeStyles: false on fileKey "${session.discoveryFileKey}". Then re-call mimic_discover_ds with communitySearchResults set to the array of unique non-null libraryName values from the results.`,
        };
      }

      // ── Normal discovery flow ─────────────────────────────────

      // If a library key was provided (after multi-library prompt), store it
      // and reset pending state so fresh discovery runs
      if (args.libraryKey) {
        discovery.setLibrary(args.libraryKey);
        session.selectedLibraryKey = args.libraryKey;
        session.pendingCommunityCheck = false;
      } else if (session.selectedLibraryKey) {
        discovery.setLibrary(session.selectedLibraryKey);
      }

      // ── Auto-reset when switching files ──
      // If the fileKey changed since last discovery, clear all cached DS data
      // so the new file gets a fresh discovery. Without this, stale styles/components
      // from the previous file bleed into the new one.
      if (session.discoveryFileKey && session.discoveryFileKey !== args.fileKey) {
        resetSession();
        dsCache.clear();
        try { await bridge.send('clear_style_cache'); } catch (_) {}
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
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const options = varDiscovery.libraries.map((lib, i) => ({
          letter: letters[i] || String(i + 1),
          name: lib.name,
          libraryKey: lib.name,
          collections: lib.collections || [],
        }));
        const optionsList = options.map(o => `${o.letter}) ${o.name}${o.collections.length ? ` (${o.collections.length} collections)` : ''}`).join('\n');
        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase] || 'idle',
          fileKey: args.fileKey,
          library: libraryInfo,
          multipleLibraries: true,
          options,
          libraries: varDiscovery.libraries,
          discoveredVariables: varDiscovery.totalVariables,
          _stopBuild: true,
          _userPrompt: `Multiple design system libraries detected on this file. Which one should I use for this build?\n\n${optionsList}\n\nReply with the letter (e.g. "use A").`,
          hint: 'STOP — do NOT proceed with the build. Present the _userPrompt to the user EXACTLY as written and wait for their choice. Then re-call mimic_discover_ds with libraryKey set to the chosen library name from the options array.',
        };
      }

      // ── Single-library auto-select ──
      // When exactly one DS library is enabled on the file, select it
      // automatically so the library-file-key + REST discovery path runs —
      // the SAME path the multi-library flow takes after the user picks a
      // library. Without this, a single-library file silently skips file-key
      // capture, which skips REST discovery of the library's published text /
      // fill / effect styles and its full published component set, leaving the
      // build with variables only. DS-agnostic: applies to any single enabled
      // library (private or public); community libraries the plugin cannot
      // enumerate return 0 libraries here and are handled by the
      // externalVariables / skipRestApi paths instead.
      if (!session.selectedLibraryKey && varDiscovery.libraries && varDiscovery.libraries.length === 1) {
        session.selectedLibraryKey = varDiscovery.libraries[0].name;
        discovery.setLibrary(session.selectedLibraryKey);
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
            // Extended variable collections (Enterprise theming, 2026):
            // collectionKey/rootVariableCollectionId come from the plugin's
            // discover_library_variables handler (feature-detected there —
            // absent entirely on Figma versions/plans without the field).
            // Consumed by src/ds/fingerprint.js to classify a variable whose
            // root collection differs from its own as an override, not a
            // new root variable.
            collectionKey: v.collectionKey || null,
            rootVariableCollectionId: v.rootVariableCollectionId || null,
            category,
            libraryName: v.libraryName || null,
          });
          variablesCached++;
          if (v.key) variableEntries.push({ path, key: v.key });
        }
        // Preload into plugin in chunks — 808 sequential importVariableByKeyAsync
        // calls can exceed the default bridge timeout (~150ms each = ~121s for 808).
        if (variableEntries.length > 0) {
          const PRELOAD_CHUNK = 200;
          const PRELOAD_TIMEOUT = 120000; // 120s per chunk of 200 vars
          for (let i = 0; i < variableEntries.length; i += PRELOAD_CHUNK) {
            const chunk = variableEntries.slice(i, i + PRELOAD_CHUNK);
            try {
              const preloadResult = await bridge.send('preload_variables', { variables: chunk }, PRELOAD_TIMEOUT);
              variablesPreloaded += preloadResult?.preloadedVars || 0;
            } catch (e) { /* non-fatal — continue with next chunk */ }
          }
        }
      }

      // ── Step 3: Library file key + REST API discovery ──
      let componentsCached = 0;
      let stylesCached = 0;

      const selectedLib = session.selectedLibraryKey;
      let libraryFileKey = selectedLib ? knowledgeStore.getLibraryFileKey(selectedLib) : null;

      // If libraryFileKey was provided as a parameter (user responding to prompt), cache it
      if (args.libraryFileKey && selectedLib) {
        libraryFileKey = args.libraryFileKey;
        knowledgeStore.setLibraryFileKey(selectedLib, libraryFileKey);
        knowledgeStore.save();
      }

      // Auto-derive the library file key from a published key already on the
      // page, so a single-library file doesn't have to prompt for it. Any
      // remote component instance carries a published key whose source file
      // (meta.file_key) IS the library's file key. If the page happens to hold
      // instances from a different enabled library, the downstream
      // variable-source-mismatch check still catches it. Falls back to the
      // prompt below on any failure (empty page, local-only keys, API error).
      if (selectedLib && !libraryFileKey && !args.skipRestApi && figmaRest
          && typeof figmaRest.resolveLibraryFileKey === 'function') {
        try {
          const scan = await bridge.send('discover_library_components', { fileKey: args.fileKey });
          const remote = ((scan && scan.components) || []).find(c => c && c.isRemote && c.key);
          if (remote) {
            const derivedKey = await figmaRest.resolveLibraryFileKey(remote.key);
            if (derivedKey) {
              libraryFileKey = derivedKey;
              knowledgeStore.setLibraryFileKey(selectedLib, derivedKey);
              knowledgeStore.save();
            }
          }
        } catch (_) { /* fall through to the file-key prompt below */ }
      }

      // If no library file key and we have a selected library, prompt the user
      // (unless skipRestApi is set — e.g. community libraries with no accessible file key)
      if (selectedLib && !libraryFileKey && !args.skipRestApi) {
        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase] || 'discovery',
          fileKey: args.fileKey,
          selectedLibraryKey: selectedLib,
          _stopBuild: true,
          _needsLibraryFileKey: true,
          _userPrompt:
            `Selected library: "${selectedLib}"\n\n` +
            `To discover all published components and text styles, Mimic needs the library's file key.\n\n` +
            `Open "${selectedLib}" in Figma. The URL looks like:\n` +
            `figma.com/design/ [copy this part] /${selectedLib.replace(/\s+/g, '-')}\n\n` +
            `Paste the file key:\n\n` +
            `(If this is a community library and you don't have the file key, re-call with skipRestApi: true to proceed without REST API discovery.)`,
          hint: `STOP \u2014 present _userPrompt to the user. They need to provide the library file key. Then re-call mimic_discover_ds with fileKey and libraryFileKey set to the pasted value. If the library is a community file and the user can't provide the key, re-call with skipRestApi: true.`,
        };
      }

      // ── Library identity + active bucket (schema v3 §3.2/§3.4) ──
      // libraryId := libraryFileKey (stable, canonical) | "name:"+normalize(name) | "__default__".
      // Compute it BEFORE the component fetch so setActiveLibrary scopes every
      // knowledgeStore.data.* read/write below (checkStaleness, claimByEvidence,
      // and — critically — every OTHER tool's recipe lookups for the rest of
      // this build session, since knowledgeStore is a session-long singleton).
      let libraryId = computeLibraryId({ libraryFileKey, libraryName: selectedLib });
      if (libraryFileKey && selectedLib) {
        // A file key just became known for a library that may have been
        // tracked under its name before — rename the bucket in place,
        // preserving stats (spec §3.2/§3.4 step 4, acceptance criterion 6).
        const nameId = computeLibraryId({ libraryName: selectedLib });
        if (nameId !== libraryId && knowledgeStore.getLibraryBucket(nameId)) {
          knowledgeStore.renameLibraryBucket(nameId, libraryId);
        }
      }
      knowledgeStore.setActiveLibrary(libraryId, {
        libraryName: selectedLib || null,
        libraryFileKey: libraryFileKey || null,
        idSource: libraryFileKey ? 'fileKey' : (selectedLib ? 'name' : null),
      });

      // ── REST freshness fast path (spec §4.2) ──
      // Cheap "did anything change" probe via file metadata (version +
      // lastModified) instead of re-fetching the full component/style lists.
      // Figma's REST API doesn't expose a separate cheap "published-variables
      // updatedAt" endpoint distinct from full file data, so version+
      // lastModified from GET /files/:key?depth=1 is the freshness proxy —
      // both change whenever anything in the file (including its published
      // variables/components) changes. Only skips the fetch when the
      // in-memory dsCache is already warm for this library (same long-lived
      // session, second+ discovery call) — a cold process always does the
      // full fetch regardless of a freshness match, so a first-ever
      // discovery is never starved of data.
      let fingerprintFreshRest = false;
      let restFreshnessNow = null;
      if (libraryFileKey && figmaRest && typeof figmaRest.getFileFreshness === 'function') {
        try {
          restFreshnessNow = await figmaRest.getFileFreshness(libraryFileKey);
          const priorFp = knowledgeStore.getStructuredFingerprint();
          const priorFreshness = priorFp && priorFp.restFreshness;
          const warmCache = [...dsCache.components.values()].some(c => c.source === 'rest_api');
          if (warmCache && priorFreshness
              && restFreshnessNow.version != null && priorFreshness.version === restFreshnessNow.version
              && restFreshnessNow.lastModified != null && priorFreshness.lastModified === restFreshnessNow.lastModified) {
            fingerprintFreshRest = true;
          }
        } catch (e) { /* non-fatal — fall through to full fetch */ }
      }

      // Fetch components + text styles via REST API
      if (libraryFileKey && figmaRest && !fingerprintFreshRest) {
        // Components
        try {
          const restComponents = await figmaRest.getFileComponents(libraryFileKey);
          for (const comp of restComponents) {
            dsCache.addComponent(comp.key, {
              name: comp.name,
              description: comp.description,
              containingFrame: comp.containingFrame,
              libraryKey: selectedLib,
              isRemote: true,
              source: 'rest_api',
            });
            componentsCached++;
          }
        } catch (e) {
          if (e.message.includes('FIGMA_ACCESS_DENIED') || e.message.includes('FIGMA_NOT_FOUND')) {
            // Community library — fall back to page scan
            try {
              const compResult = await bridge.send('discover_library_components', { fileKey: args.fileKey });
              if (compResult && compResult.components) {
                for (const comp of compResult.components) {
                  dsCache.addComponent(comp.key, {
                    name: comp.name, isRemote: comp.isRemote, isComponentSet: comp.isComponentSet,
                    variantCount: comp.variantCount, variantProperties: comp.variantProperties,
                    description: comp.description, source: 'page_scan',
                  });
                  componentsCached++;
                }
              }
            } catch (e2) { /* non-fatal */ }
          } else {
            return {
              phase: 0, _stopBuild: true,
              error: e.message.split(':')[0],
              _userPrompt: e.message.split(': ').slice(1).join(': '),
              hint: 'STOP \u2014 present error to user. Fix the issue and retry.',
            };
          }
        }

        // Text styles. Fall back to the working file (args.fileKey) when the
        // library file publishes none — text styles commonly live in the
        // working file itself, and skipping them leaves enforceTextStyles:true
        // with zero styles cached (no textStyleId for the plugin to bind).
        try {
          const restStyles = await figmaRest.getTextStylesWithFallback(libraryFileKey, args.fileKey);
          if (restStyles.length > 0) {
            const styleKeys = restStyles.map(s => s.key);
            try {
              const preloadResult = await bridge.send('preload_styles', { styleKeys });
              if (preloadResult && preloadResult.styles) {
                for (const style of preloadResult.styles) {
                  dsCache.addTextStyle(style.key, style);
                  stylesCached++;
                }
              }
            } catch (e2) { /* styles discovered but not all importable */ }
            // Cache any REST styles not yet in dsCache
            for (const s of restStyles) {
              if (!dsCache.textStyles.has(s.key)) {
                dsCache.addTextStyle(s.key, { name: s.name, description: s.description, source: 'rest_api' });
                stylesCached++;
              }
            }
          }
        } catch (e) { /* non-fatal */ }

        // Fill styles (color styles)
        let fillStylesCached = 0;
        try {
          const restFillStyles = await figmaRest.getFileFillStyles(libraryFileKey);
          for (const s of restFillStyles) {
            dsCache.addFillStyle(s.key, { name: s.name, description: s.description, source: 'rest_api' });
            fillStylesCached++;
          }
        } catch (e) { /* non-fatal */ }

        // Effect styles
        let effectStylesCached = 0;
        try {
          const restEffectStyles = await figmaRest.getFileTextStyles(libraryFileKey); // reuse endpoint
          // Actually use getAllStyles or parseEffectStyles
        } catch (e) { /* non-fatal */ }
        // For effect styles, re-fetch with the raw response
        try {
          const raw = await figmaRest._get(`/files/${libraryFileKey}/styles`);
          const effectStyles = figmaRest.parseEffectStylesResponse(raw);
          for (const s of effectStyles) {
            dsCache.addEffectStyle(s.key, { name: s.name, description: s.description, source: 'rest_api' });
            effectStylesCached++;
          }
        } catch (e) { /* non-fatal */ }
      } else if (fingerprintFreshRest) {
        // Fast path: nothing changed since last discovery (spec §4.2) — the
        // already-warm dsCache from earlier in this session IS the current
        // state. Reflect its existing counts instead of re-fetching.
        componentsCached = [...dsCache.components.values()].filter(c => c.source === 'rest_api').length;
        stylesCached = dsCache.textStyles.size;
      }

      // Supplemental: scan current page for local components
      try {
        const compResult = await bridge.send('discover_library_components', { fileKey: args.fileKey });
        if (compResult && compResult.components) {
          for (const comp of compResult.components) {
            if (!dsCache.components.has(comp.key)) {
              dsCache.addComponent(comp.key, {
                name: comp.name, isRemote: comp.isRemote, isComponentSet: comp.isComponentSet,
                variantCount: comp.variantCount, variantProperties: comp.variantProperties,
                description: comp.description, source: 'page_scan',
              });
              componentsCached++;
            }
          }
        }
      } catch (e) { /* non-fatal */ }

      // ── DS-copilot guardrail: refuse to build without a design system ──
      // Mimic only ever builds from DS components/styles/variables. If this
      // file surfaced no DS at all — no enabled library, and zero variables,
      // components and styles discovered — there is nothing to build FROM.
      // Stop and tell the user instead of silently proceeding into a
      // variable-less, component-less build. Community libraries the plugin
      // can't enumerate, and the explicit skipRestApi / externalVariables
      // flows, are exempt — those reach their DS through other routes.
      if (variablesCached === 0 && componentsCached === 0 && stylesCached === 0
          && (!varDiscovery.libraries || varDiscovery.libraries.length === 0)
          && !session.selectedLibraryKey
          && !args.skipRestApi && !args.externalVariables) {
        session.toolCallCount++;
        return {
          phase: session.phase,
          phaseLabel: PHASE_LABELS[session.phase] || 'discovery',
          fileKey: args.fileKey,
          _stopBuild: true,
          _noDesignSystem: true,
          discovery: { variables: { cached: 0 }, textStyles: { cached: 0 }, components: { cached: 0 } },
          _userPrompt:
            `No design system found on this file.\n\n` +
            `Mimic builds only from a design system's components, styles, and variables — ` +
            `it never falls back to raw values or hand-built elements. Before building:\n` +
            `• Enable the design-system library on this file (Assets panel → Libraries), or\n` +
            `• Open the file that has the DS enabled, or\n` +
            `• If this is a community library the plugin can't read, re-call with skipRestApi: true ` +
            `and supply components/variables via Figma MCP search_design_system.\n\n` +
            `Then re-run discovery.`,
          hint: 'STOP — no design system discovered on this file. Present _userPrompt to the user. Mimic cannot build without a DS.',
        };
      }

      // ── Library identity drift + claim-by-evidence (spec §3.2/§3.4) ──
      // Runs once component discovery has populated the live cache, so
      // checkLibraryIdentityDrift/claimByEvidence have real data to compare
      // against. Cold start (build 1, unknown DS): if this is a migrated v2
      // user, claimByEvidence makes it warm (spec §5.5).
      const liveComponentKeysSet = new Set(dsCache.components.keys());
      let claimNote = null;
      if (libraryId !== '__default__') {
        const idSource = libraryFileKey ? 'fileKey' : 'name';
        if (idSource === 'name') {
          if (!session.identityDriftConfirmedFor) session.identityDriftConfirmedFor = new Set();
          if (!session.identityDriftConfirmedFor.has(libraryId)) {
            const drift = knowledgeStore.checkLibraryIdentityDrift(libraryId, liveComponentKeysSet);
            if (drift.possiblyDifferentLibrary) {
              if (args.identityDriftChoice === 'same') {
                session.identityDriftConfirmedFor.add(libraryId);
              } else if (args.identityDriftChoice === 'different') {
                // Fork to a disambiguated bucket rather than mass-staling the
                // existing one (product decision P2 — prompt, never silent).
                let suffix = 2;
                let forkedId = `${libraryId} (${suffix})`;
                while (knowledgeStore.getLibraryBucket(forkedId)) { suffix++; forkedId = `${libraryId} (${suffix})`; }
                knowledgeStore.setActiveLibrary(forkedId, { libraryName: selectedLib, libraryFileKey: null, idSource: 'name' });
                libraryId = forkedId;
                session.identityDriftConfirmedFor.add(libraryId);
              } else {
                return {
                  phase: session.phase,
                  phaseLabel: PHASE_LABELS[session.phase] || 'discovery',
                  fileKey: args.fileKey,
                  selectedLibraryKey: selectedLib,
                  _stopBuild: true,
                  _libraryIdentityDrift: {
                    vanishedRatio: drift.vanishedRatio, vanishedCount: drift.vanishedCount, totalStoredKeys: drift.totalStoredKeys,
                  },
                  _userPrompt:
                    `"${selectedLib}" looks different from what Mimic learned before: ` +
                    `${drift.vanishedCount} of ${drift.totalStoredKeys} previously-known components ` +
                    `(${Math.round(drift.vanishedRatio * 100)}%) are no longer present.\n\n` +
                    `Is this the SAME "${selectedLib}" library (just updated) — or a DIFFERENT library that ` +
                    `happens to share the name?\n\n` +
                    `Reply with identityDriftChoice: "same" to keep learning under the existing history, ` +
                    `or "different" to start a fresh learning history for this library.`,
                  hint: 'STOP — library identity ambiguous (>60% of previously-known components vanished ' +
                    'under a name-keyed library ID). Present _userPrompt to the user and re-call ' +
                    'mimic_discover_ds with the SAME args plus identityDriftChoice: "same" or "different".',
                };
              }
            }
          }
        }
        const claimResult = knowledgeStore.claimByEvidence(libraryId, liveComponentKeysSet);
        if (claimResult.claimed > 0) {
          claimNote = `${claimResult.claimed} previously-learned recipe(s) claimed into "${selectedLib || libraryId}" from earlier (unscoped) learning.`;
        }
      }

      // ── Step 5: Compute and set enforcement profile ──
      const enforcement = dsCache.getEnforcementProfile();
      const dsMode = dsCache.variables.size > 0 ? 'strict' : 'permissive';
      session.enforcementProfile = { ...enforcement, dsMode };

      try {
        await bridge.send('set_session_defaults', {
          enforcementProfile: session.enforcementProfile,
        });
      } catch (e) { /* non-fatal */ }

      // ── Structured fingerprint capture + diff (spec §4.1-4.3) ──
      // Written on EVERY discovery, including skipRestApi/community paths
      // (fixes defect N — previously guarded by `componentsCached > 0 ||
      // stylesCached > 0`, which is exactly false on a from-scratch
      // community discovery). Only diffs fingerprints of the same `source`
      // class — a source change is an informational note, not staleness
      // (fixes acceptance 12).
      const fingerprintSource = (libraryFileKey && figmaRest) ? 'rest' : 'page_scan';
      const newFingerprint = buildStructuredFingerprint({
        dsCache, knowledgeStore, source: fingerprintSource,
        restFreshness: restFreshnessNow || knowledgeStore.getStructuredFingerprint()?.restFreshness || null,
      });
      const priorFingerprint = knowledgeStore.getStructuredFingerprint();
      const fpDiff = diffFingerprints(priorFingerprint, newFingerprint);
      const dsChanges = [];
      const fingerprintFresh = fpDiff.unchanged === true;

      if (fpDiff.sourceChanged) {
        dsChanges.push(`DS discovery source changed (${fpDiff.prevSource} -> ${fpDiff.currSource}) — informational only, no staleness applied.`);
      } else if (!fpDiff.firstCapture && !fpDiff.unchanged) {
        for (const d of fpDiff.componentDiffs) {
          if (d.type === 'component_added') dsChanges.push(`New component: ${d.name || d.key}`);
          if (d.type === 'component_removed') dsChanges.push(`Removed component: ${d.name || d.key}`);
          if (d.type === 'renamed') dsChanges.push(`Renamed: "${d.oldName}" -> "${d.newName}" (same key — recipes keep working, not stale)`);
          if (d.type === 'variant_schema_changed') dsChanges.push(`Variant schema changed: ${d.name}`);
        }
        for (const d of fpDiff.styleDiffs) {
          if (d.type === 'style_added') dsChanges.push(`New style: ${d.name}`);
          if (d.type === 'style_removed') dsChanges.push(`Removed style: ${d.name}`);
          if (d.type === 'renamed') dsChanges.push(`Style renamed: "${d.oldName}" -> "${d.newName}"`);
        }
        for (const d of fpDiff.variableDiffs) {
          if (d.type === 'token_renamed') dsChanges.push(`Token renamed: "${d.oldPath}" -> "${d.newPath}" (same key)`);
          if (d.type === 'variable_removed') dsChanges.push(`Removed variable: ${d.path}`);
          if (d.type === 'variable_added') dsChanges.push(`New variable: ${d.path}`);
          if (d.type === 'variable_override_added') dsChanges.push(`Variable override added: ${d.path}`);
        }

        applyFingerprintDiffReactions(knowledgeStore, fpDiff);
        const gapResolutions = resolveGapsFromDiff(knowledgeStore, fpDiff);

        // Stash this discovery's classified diff on the session so the NEXT
        // mimic_generate_build_report can restructure the DS Changes section
        // into the spec §4.5 four ordered blocks (gap resolutions first,
        // renames, variant changes, removals) instead of re-deriving a
        // coarser view from persisted staleness alone.
        session.lastDsChangesReport = {
          capturedAt: newFingerprint.capturedAt,
          gapResolutions,
          renames: fpDiff.componentDiffs.filter(d => d.type === 'renamed'),
          styleRenames: fpDiff.styleDiffs.filter(d => d.type === 'renamed'),
          tokenRenames: fpDiff.variableDiffs.filter(d => d.type === 'token_renamed'),
          variantSchemaChanges: fpDiff.componentDiffs.filter(d => d.type === 'variant_schema_changed'),
          removedComponents: fpDiff.componentDiffs.filter(d => d.type === 'component_removed'),
        };
      }
      knowledgeStore.setStructuredFingerprint(newFingerprint);
      knowledgeStore.save();

      // ── Staleness detection (spec §4.4) ──
      // Compare stored recipes against live DS cache to detect orphaned/drifted recipes.
      const dsComponentKeys = new Set(dsCache.components.keys());
      const dsVariantProperties = {};
      for (const [key, comp] of dsCache.components) {
        if (comp.variantProperties) {
          dsVariantProperties[key] = comp.variantProperties;
        }
      }
      const staleResults = applyStalenessV3(knowledgeStore, dsComponentKeys, dsVariantProperties);
      if (staleResults.length > 0) {
        knowledgeStore.save();
        dsChanges.push(`${staleResults.length} recipe(s) affected: ${staleResults.map(r => `${r.names[0] || r.key} (${r.reason})`).join(', ')}`);
      }
      if (claimNote) dsChanges.unshift(claimNote);

      // ── Cold start messaging (spec §5.5) ──
      // A migrated v2 user (__default__ claim-by-evidence just ran) is
      // "warm" even on their first v3 discovery of this library — say so
      // instead of implying zero prior learning. A genuinely new
      // library/bucket says plainly that learning starts now.
      const bucketComponentCount = Object.keys(knowledgeStore.data.components || {}).length;
      const bucketBuildCount = knowledgeStore.data.meta?.buildCount || 0;
      const learningStatus = claimNote
        || (bucketComponentCount === 0 && bucketBuildCount === 0
          ? `First build with "${selectedLib || libraryId}" — no recipes yet. Learning begins with this build's report.`
          : undefined);

      // Completeness warnings
      const completenessWarnings = [];
      if (variablesCached > 0 && variablesPreloaded < variablesCached * 0.8) {
        completenessWarnings.push(`Variables: only ${variablesPreloaded}/${variablesCached} preloaded into plugin. Some bindings may fail.`);
      }
      if (stylesCached === 0 && enforcement.enforceTextStyles) {
        completenessWarnings.push('No text styles found in the library. Check that text styles are published.');
      }
      if (componentsCached === 0 && libraryFileKey) {
        completenessWarnings.push('No published components found in the library. Check that components are published (not just local).');
      } else if (componentsCached === 0 && !libraryFileKey) {
        completenessWarnings.push('No components discovered \u2014 library file key not provided.');
      }

      // Component enumeration health. When no components were read via the REST
      // API (no FIGMA_TOKEN / library file key) the only components Mimic knows
      // are the ones already instantiated on this file (page-scan) plus learned
      // recipes \u2014 the full component library was never enumerated. That is a
      // DEGRADED state: mimic_map_components will report false gaps and a build
      // can silently end up using few or zero DS components. Surface it loudly
      // (agents are instructed to read completenessWarnings) and flag the
      // session so the build report can name it as the confirmed cause of a
      // zero-component build. Non-fatal: the documented no-token \u2192 primitives
      // fallback still works, it just must be an informed choice.
      const componentEnumerationDegraded = dsCache.componentEnumerationDegraded(libraryFileKey);
      session.componentEnumerationDegraded = componentEnumerationDegraded;
      if (componentEnumerationDegraded) {
        completenessWarnings.push(
          'Component enumeration is PAGE-SCAN ONLY \u2014 the full component library was not read '
          + '(no FIGMA_TOKEN / library file key for REST discovery). Only components already placed '
          + 'on this file are known, so mimic_map_components may report false gaps and a build can '
          + 'end up using few or no DS components. Provide a library file key / FIGMA_TOKEN, or run a '
          + 'Figma search_design_system library search, before building \u2014 a zero-component build '
          + 'fails the component-first quality gate.'
        );
      }

      session.toolCallCount++;

      // If libraryKey was provided, the user already resolved the multi-library
      // question (from plugin detection OR community check). Skip the community
      // check and advance directly to Phase 2.
      if (args.libraryKey) {
        session.pendingCommunityCheck = false;
        advancePhase(2);

        // Check if the selected library has variables/styles in the file.
        // Variables and text styles come from whatever libraries are enabled
        // in the file, NOT necessarily from the selected library. If the
        // selected library contributed no variables, the build will use
        // another library's tokens — warn about the mismatch.
        let selectedLibVarCount = 0;
        const varSourceLibs = new Set();
        for (const [, v] of dsCache.variables) {
          if (v.libraryName) varSourceLibs.add(v.libraryName);
          if (v.libraryName === session.selectedLibraryKey) selectedLibVarCount++;
        }
        if (selectedLibVarCount === 0 && variablesCached > 0) {
          const sourceList = [...varSourceLibs].join(', ');
          const sourceLibs = [...varSourceLibs];

          // Check if the selected library was NOT discovered by the plugin.
          // Community libraries often have published variables that the plugin
          // API (getAvailableLibraryVariableCollectionsAsync) can't enumerate,
          // even though Figma's REST API and library panel show them.
          const pluginDiscoveredNames = (varDiscovery.libraries || []).map(l => l.name);
          const isPluginDiscovered = pluginDiscoveredNames.includes(session.selectedLibraryKey);

          if (!isPluginDiscovered) {
            // ── Community library — variables need external fetch ──
            // The plugin can't enumerate this library's variables, but they
            // exist (visible in Manage Libraries). Redirect to external
            // variables flow: Claude fetches them via Figma MCP search and
            // passes them back as externalVariables.
            session.phase = 1;
            session.pendingExternalVariables = true;
            // Try to find the library key from the community check options
            session.externalVariablesLibraryKey = session.communityLibraryVariableKeys?.[session.selectedLibraryKey] || null;

            return {
              phase: 1,
              phaseLabel: 'discovery',
              fileKey: args.fileKey,
              library: libraryInfo,
              selectedLibraryKey: session.selectedLibraryKey || null,
              communityVariablesRequired: true,
              _stopBuild: true,
              hint: `"${session.selectedLibraryKey}" has published variables but the plugin API cannot enumerate them (community library limitation). Fetch variables via Figma MCP search_design_system with includeLibraryKeys to restrict to this library. Run multiple queries to cover all variable types: "color", "spacing", "shape", "typography", "breakpoint". Collect ALL results and re-call mimic_discover_ds with externalVariables array (each entry: name, key, resolvedType, collection, libraryName).`,
            };
          }

          // ── STOP BUILD — genuine variable source mismatch ──
          // The selected library WAS discovered by the plugin but contributed
          // no variables. This is a real mismatch — the user must decide.
          session.phase = 1;
          session.pendingVariableMismatchConfirmation = true;
          session.variableMismatchSourceLibs = sourceLibs;

          return {
            phase: 1,
            phaseLabel: 'discovery',
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
            variableSourceMismatch: {
              selectedLibrary: session.selectedLibraryKey,
              selectedLibraryVariableCount: 0,
              variableSourceLibraries: sourceLibs,
              totalCachedVariables: variablesCached,
            },
            _stopBuild: true,
            _userPrompt:
              `⚠ VARIABLE SOURCE MISMATCH\n\n` +
              `"${session.selectedLibraryKey}" has NO variables (colors, spacing, radius) in this file.\n` +
              `All ${variablesCached} cached variables come from: ${sourceList}.\n\n` +
              `This means:\n` +
              `• Components → imported from "${session.selectedLibraryKey}"\n` +
              `• Colors, spacing, radius → bound from ${sourceList}\n\n` +
              `Options:\n` +
              `A) Continue with mixed sources (${session.selectedLibraryKey} components + ${sourceList} variables)\n` +
              `B) Switch to ${sourceLibs[0]} for everything (components + variables from same library)\n` +
              `C) Pick a different library\n\n` +
              `Reply with A, B, or C.`,
            hint: `STOP — variable source mismatch detected. Present _userPrompt to the user EXACTLY as written and wait for their choice.`,
          };
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
          dsChanges: dsChanges.length > 0 ? dsChanges : undefined,
          fingerprintFresh,
          _restFetchSkipped: fingerprintFreshRest || undefined,
          _learningStatus: learningStatus,
          _libraryConstraint: `ALL components and Figma MCP searches must use ONLY "${session.selectedLibraryKey}". Never mix design systems.`,
          hint: (dsChanges.length > 0 ? `DS UPDATED: ${dsChanges.join(' | ')}. ` : '') +
            (completenessWarnings.length > 0
            ? `Discovery complete with ${completenessWarnings.length} warning(s). Review completenessWarnings. Selected library: "${session.selectedLibraryKey}" — use ONLY this library for all components and searches. NEXT: Call mimic_map_components with ALL section-level elements in your design (header, footer, sidebar, etc.) to find DS components BEFORE building. Target ~90% component usage.`
            : `Discovery complete. ${variablesCached} variables, ${stylesCached} text styles, ${componentsCached} components. Enforcement: ${dsMode}. Selected library: "${session.selectedLibraryKey}" — use ONLY this library for all components and searches. NEXT: Call mimic_map_components with ALL section-level elements in your design (header, footer, sidebar, etc.) to find DS components BEFORE building. Target ~90% component usage.`),
        };
      }

      // ── Stay at Phase 1 — community library check required ──
      advancePhase(1);

      // Store intermediate results for community check confirmation
      session.discoveryFileKey = args.fileKey;
      session.discoveredLibraries = varDiscovery.libraries || [];
      session.discoveryResults = {
        variables: { cached: variablesCached, preloaded: variablesPreloaded },
        textStyles: { cached: stylesCached },
        components: { cached: componentsCached },
      };
      session.completenessWarnings = completenessWarnings;
      session.pendingCommunityCheck = true;

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
        dsChanges: dsChanges.length > 0 ? dsChanges : undefined,
        fingerprintFresh,
        _restFetchSkipped: fingerprintFreshRest || undefined,
        _learningStatus: learningStatus,
        communityLibraryCheckRequired: true,
        _stopBuild: true,
        hint: `Plugin discovery complete — ${variablesCached} variables, ${stylesCached} text styles, ${componentsCached} components cached. MANDATORY NEXT STEP: Call Figma MCP search_design_system with query "color", includeVariables: true, includeComponents: false, includeStyles: false on fileKey "${args.fileKey}". Collect all unique non-null libraryName values from the results, then re-call mimic_discover_ds with communitySearchResults set to that array. Build tools are BLOCKED until this check completes.`,
      };
    },
    {
      annotations: { title: 'Discover the design system', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      outputSchema: {
        type: 'object',
        properties: {
          phase: { type: 'number' },
          phaseLabel: { type: 'string' },
          hint: { type: 'string' },
          enforcement: { type: 'object' },
          _stopBuild: { type: 'boolean', description: 'True when the build must not proceed until the returned instructions are followed.' },
          _userPrompt: { type: 'string', description: 'Present this to the user verbatim when a decision is required.' },
          communityLibraryCheckRequired: { type: 'boolean' },
          completenessWarnings: { type: 'array', items: { type: 'object' } },
        },
      },
    }
  );
}

module.exports = { register, applyFingerprintDiffReactions, resolveGapsFromDiff, applyStalenessV3 };
