'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ChartCalculator } = require('../charts/calculator');
const { PatternMatcher } = require('../knowledge/patterns');
const { compileNoGoods } = require('../knowledge/compiler');
const { wordBoundaryMatch } = require('../utils/text-match');

// ── Invented example values for _chartColorHint ──────────────────────────
// Used ONLY when the DS cache has no match for a given field — i.e. before
// mimic_discover_ds has run, or when the discovered DS doesn't expose an
// equivalent variable/style. These paths are INVENTED placeholders that
// illustrate a plausible path shape (collection/variable naming) — they
// are NOT real paths from any actual design system, and every field they
// cover is clearly labeled as an example via _exampleFields below. Callers
// are told to verify with figma_list_ds (kind: "variables") / figma_list_ds (kind: "text_styles")
// before binding to them.
const EXAMPLE_PALETTE = [
  'Colors/Data/series-blue-500',
  'Colors/Data/series-purple-500',
  'Colors/Data/series-teal-500',
  'Colors/Data/series-cyan-500',
  'Colors/Data/series-pink-500',
  'Colors/Data/series-amber-500',
  'Colors/Data/series-indigo-500',
  'Colors/Data/series-lime-500',
];
const EXAMPLE_GRID_COLOR = 'Colors/Border/subtle';
const EXAMPLE_LABEL_COLOR = 'Colors/Text/muted';
const EXAMPLE_LABEL_STYLE = 'Text Small/Regular';

/**
 * Builds the `_chartColorHint` returned by mimic_compute_chart. Resolves
 * every field from the discovered DS cache when possible; falls back to
 * labeled, INVENTED example paths (illustrating shape only, not a real DS)
 * field-by-field when the cache has no match — never presenting an
 * example as if it were a real path in the user's file.
 */
function buildChartColorHint(dsCache) {
  const palette = dsCache && dsCache.findPalette ? dsCache.findPalette(8) : null;
  const gridColor = dsCache && dsCache.findVariable ? dsCache.findVariable('border', 'STROKE', 'secondary') : null;
  const labelColor = dsCache && dsCache.findVariable ? dsCache.findVariable('text', 'TEXT_FILL', 'tertiary') : null;
  const labelStyleKey = dsCache && dsCache.findTextStyle ? dsCache.findTextStyle('xs', 'Medium') : null;
  const labelStyleEntry = labelStyleKey && dsCache.getTextStyle ? dsCache.getTextStyle(labelStyleKey) : null;
  const labelStyleName = labelStyleEntry && labelStyleEntry.name ? labelStyleEntry.name : null;

  const usedExample = {
    suggestedPalette: !palette,
    gridColor: !gridColor,
    labelColor: !labelColor,
    dataLabelStyle: !labelStyleName,
  };
  const exampleFields = Object.keys(usedExample).filter((k) => usedExample[k]);
  const allExample = exampleFields.length === Object.keys(usedExample).length;

  const message = allExample
    ? 'No DS has been discovered yet (or the cache has no matching variables/styles). Every path below is an INVENTED EXAMPLE illustrating path shape only — NOT a path in your file and not from any real design system. Run mimic_discover_ds, then use figma_list_ds (kind: "variables") / figma_list_ds (kind: "text_styles") to find the real paths before binding anything.'
    : exampleFields.length > 0
      ? `After creating this chart with figma_create_svg, check the configurationChecklist in the response — it lists every unbound child node that MUST receive DS variable bindings. Pass layoutSizingHorizontal: "FILL" to figma_create_svg so the chart stretches to the container width. NOTE: ${exampleFields.join(', ')} had no match in your discovered DS cache and fall back to an INVENTED EXAMPLE path (see _exampleFields) — verify against figma_list_ds (kind: "variables") / figma_list_ds (kind: "text_styles") before binding those specific fields.`
      : 'After creating this chart with figma_create_svg, check the configurationChecklist in the response — it lists every unbound child node that MUST receive DS variable bindings. Pass layoutSizingHorizontal: "FILL" to figma_create_svg so the chart stretches to the container width. suggestedPalette/gridColor/labelColor/dataLabelStyle below were resolved from your discovered DS.';

  return {
    message,
    suggestedPalette: palette || EXAMPLE_PALETTE,
    colorRules: [
      'NEVER use Brand, Success, Warning, or Error colors for chart data — these are semantic and reserved.',
      'Brand is ONLY for links and brand-related elements.',
      'Success/Warning/Error are ONLY for status indicators, validation states, and alerts.',
      'For charts, use neutral/categorical utility colors from your DS that are distinct from its Brand/Success/Warning/Error hues.',
      'If you need more colors than suggestedPalette provides, extend with other non-semantic utility colors from your DS. Avoid hues that resemble Success (green), Error (red), and Warning (orange).',
    ],
    gridColor: gridColor || EXAMPLE_GRID_COLOR,
    labelColor: labelColor || EXAMPLE_LABEL_COLOR,
    dataLabelStyle: labelStyleName || EXAMPLE_LABEL_STYLE,
    ...(exampleFields.length > 0 ? { _exampleFields: exampleFields } : {}),
  };
}

// Monotonic per-process counter identifying a single mimic_generate_build_report
// invocation, used ONLY as recordComponentBuild's dedup token (fixes defect
// D: two report ENTRIES resolving to the same componentKey within one call
// must add +1 to buildCount, not +2). Deliberately independent of
// knowledgeStore.data.meta.buildCount, which only advances when Phase 3 had
// actual build tool calls (`phaseToolCalls[3] > 0`) — tying the dedup token
// to that gated counter meant every report() call in a build-op-free test
// session (or a report re-generated to clear a circuit breaker) collided on
// the same "buildNumber" and buildCount could never advance past 1.
let _reportInvocationCounter = 0;

function register(server, context) {
  const { registerTool, knowledgeStore, buildManifest, dsCache, session, advancePhase, bridge } = context;

  /**
   * v3.0.0 consolidation: mimic_generate_design_md folds into
   * mimic_ai_knowledge_read as format="design_md" — same underlying
   * knowledgeStore/dsCache read, just rendered as a DESIGN.md string
   * instead of raw JSON. Unchanged extraction of the former standalone
   * handler's body.
   */
  function buildDesignMd() {
    const lines = ['# Design System Reference', ''];

    // Text styles
    const textStyles = [...dsCache.textStyles.entries()];
    lines.push(`## Text Styles (${textStyles.length})`);
    lines.push('');
    if (textStyles.length > 0) {
      textStyles.forEach(([key, style]) => {
        lines.push(`- **${style.name || key}**: ${style.fontFamily || ''} ${style.fontSize || ''}px / ${style.lineHeight || 'auto'}`);
      });
    } else {
      lines.push('No text styles cached.');
    }
    lines.push('');

    // Variables
    const variables = [...dsCache.variables.entries()];
    lines.push(`## Variables (${variables.length})`);
    lines.push('');
    if (variables.length > 0) {
      variables.forEach(([key, variable]) => {
        lines.push(`- **${variable.name || key}**: ${variable.resolvedValue || variable.value || 'N/A'}`);
      });
    } else {
      lines.push('No variables cached.');
    }
    lines.push('');

    // Components
    const components = [...dsCache.components.entries()];
    lines.push(`## Components (${components.length})`);
    lines.push('');
    if (components.length > 0) {
      components.forEach(([key, comp]) => {
        lines.push(`- **${comp.name || key}**`);
      });
    } else {
      lines.push('No components cached.');
    }
    lines.push('');

    // Knowledge store components (recipes)
    const recipes = Object.entries(knowledgeStore.data.components);
    if (recipes.length > 0) {
      lines.push(`## Component Recipes (${recipes.length})`);
      lines.push('');
      recipes.forEach(([name, recipe]) => {
        lines.push(`### ${name}`);
        lines.push(`\`\`\`json`);
        lines.push(JSON.stringify(recipe, null, 2));
        lines.push(`\`\`\``);
        lines.push('');
      });
    }

    return lines.join('\n');
  }

  // ── mimic_ai_knowledge_read ────────────────────────────────────
  registerTool(
    'mimic_ai_knowledge_read',
    'Loads the knowledge store: learned component recipes, layout/pattern data, DS gaps, user-defined rules, and meta stats (build counts, replay savings). Call at the start of a session to see what Mimic has already learned about this DS. Params: format ("json" default — structured data; "design_md" — renders the current DS + recipes as a DESIGN.md-style markdown string for documentation/handoff).',
    {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'design_md'], description: '"json" (default) returns structured store contents. "design_md" returns a rendered DESIGN.md markdown string instead.' },
      },
      required: [],
    },
    async (args) => {
      knowledgeStore.load();

      if (args && args.format === 'design_md') {
        return { content: buildDesignMd() };
      }

      return {
        components: knowledgeStore.data.components,
        patterns: knowledgeStore.data.patterns,
        gaps: knowledgeStore.data.gaps,
        rules: knowledgeStore.data.rules || {},
        meta: knowledgeStore.data.meta,
        // Surfaced when a corrupt/unsupported-version knowledge file was
        // recovered (backed up + reset to fresh) at some point this session.
        // See KnowledgeStore._recoverFromCorruption in src/knowledge/store.js.
        _storeWarning: knowledgeStore.loadWarning || undefined,
      };
    },
    {
      annotations: { title: 'Read the knowledge store', readOnlyHint: true, idempotentHint: true },
    }
  );

  // ── mimic_ai_knowledge_write ───────────────────────────────────
  registerTool(
    'mimic_ai_knowledge_write',
    'Saves a component recipe, layout pattern, DS gap, or user-defined design rule to the persistent knowledge store — the mechanism that lets Mimic learn across builds. Use "rule" when the user corrects build behavior in a generalizable way (e.g. "cards always have a header + content frame"); other types are usually written automatically by the build pipeline. Params: type ("component"|"pattern"|"gap"|"rule", required), id (unique key, required), data (entry payload, required).',
    {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['component', 'pattern', 'gap', 'rule'],
          description: 'Type of knowledge entry to save. Use "rule" for user-defined design rules that should be followed on every build (e.g., color semantics, card structure, component usage patterns).',
        },
        id: {
          type: 'string',
          description: 'Unique identifier for the entry.',
        },
        data: {
          type: 'object',
          description: 'The entry data to store.',
        },
      },
      required: ['type', 'id', 'data'],
    },
    async (args) => {
      const { type, id, data } = args;

      // Shape validation (spec defect Q, acceptance 25) — rejects a recipe
      // payload with an unknown confidence tier or a non-object variantStats
      // BEFORE it reaches the store, with a message listing the full
      // four-type enum regardless of which branch rejected it.
      const VALID_TYPES = ['component', 'pattern', 'gap', 'rule'];
      if (!VALID_TYPES.includes(type)) {
        return { error: `Unknown type: ${type}. Use component, pattern, gap, or rule.` };
      }

      try {
        switch (type) {
          case 'component':
            // knowledgeStore.setComponent() itself throws on an invalid
            // confidence tier or non-object variantStats (src/knowledge/
            // store.js) — caught below and surfaced as a graceful error
            // response instead of an unhandled exception.
            knowledgeStore.setComponent(id, data);
            break;
          case 'pattern':
            knowledgeStore.setPattern(id, data);
            break;
          case 'gap':
            knowledgeStore.addGap(id, data);
            break;
          case 'rule': {
            const existingRule = knowledgeStore.getRule(id);
            if (existingRule && data.status && Object.keys(data).length === 1) {
              knowledgeStore.setRule(id, { ...existingRule, status: data.status });
            } else {
              knowledgeStore.setRule(id, data);
            }
            break;
          }
        }
      } catch (err) {
        return { error: err.message, type, id };
      }

      knowledgeStore.save();
      return { ok: true, type, id };
    },
    {
      annotations: { title: 'Write a knowledge store entry', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }
  );

  // ── mimic_generate_build_report ────────────────────────────────
  registerTool(
    'mimic_generate_build_report',
    'Compiles the current build session into a structured report — DS component usage, primitives with justifications, DS changes/staleness, gap recommendations, binding-quality failures, efficiency (tool calls, cache hits, replay savings), and design-rule compliance. MANDATORY at the end of every build, before responding to the user — advances phase to 5 and resets per-build counters. No params.',
    {
      type: 'object',
      properties: {
        screenName: {
          type: 'string',
          description: 'Name of the screen that was built.',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'html'],
          description: 'Report format. Defaults to markdown.',
        },
        components: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              instances: { type: 'number' },
              componentKey: { type: 'string', description: 'Component key used for insertion. If provided, persisted directly to knowledge store.' },
            },
          },
          description: 'DS components used in the build. Include componentKey from figma_insert_component responses for reliable learning.',
        },
        primitives: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              element: { type: 'string' },
              reason: { type: 'string' },
              searchTerms: { type: 'array', items: { type: 'string' } },
            },
          },
          description: 'Primitives used (elements not found in DS).',
        },
        toolCallCount: {
          type: 'number',
          description: 'Total tool calls in the build. Falls back to session count.',
        },
        cacheHits: {
          type: 'number',
          description: 'Number of cache hits during the build.',
        },
      },
      required: ['screenName', 'components', 'primitives'],
    },
    async (args) => {
      const manifestSections = buildManifest.sections || [];
      const inferredScreenName = buildManifest.artboardId
        ? `build-${buildManifest.artboardId}`
        : 'mimic-build';
      const inferredComponents = [];
      const componentCounts = new Map();
      for (const section of manifestSections) {
        if (section.type === 'component') {
          const name = section.componentName || section.htmlSection || 'Unnamed component';
          componentCounts.set(name, (componentCounts.get(name) || 0) + 1);
        }
      }
      for (const [name, instances] of componentCounts) {
        inferredComponents.push({ name, instances });
      }
      const inferredPrimitives = manifestSections
        .filter((section) => section.type === 'primitive' || section.type === 'frame')
        .map((section) => ({
          element: section.htmlSection || section.type,
          reason: section.type === 'frame' ? 'Custom frame created during build' : 'Primitive created during build',
        }));

      const {
        screenName = inferredScreenName,
        format = 'markdown',
        components = inferredComponents,
        primitives = inferredPrimitives,
        toolCallCount = session.toolCallCount,
        cacheHits = session.cacheHits,
      } = args;

      // ── Regression detection (spec §5.4, acceptance 21, product decision
      // P5 — report-only, never blocking) ──
      // Persist last 3 build manifests per library; compare THIS build's
      // primitive/frame sections against any PRIOR manifest's component
      // sections with the same normalized name/prefix. An element that was
      // a DS component before and is a primitive now is surfaced as a
      // question, not an error — the user may have had a good reason.
      const normalizeManifestPrefix = (name) => (name || '').split(':')[0].trim().toLowerCase();
      const currentManifestSections = manifestSections.map((s) => ({
        name: s.componentName || s.htmlSection || 'unnamed',
        type: s.type,
      }));
      const priorManifests = knowledgeStore.getManifests();
      const regressionQuestions = [];
      for (const section of currentManifestSections) {
        if (section.type !== 'primitive' && section.type !== 'frame') continue;
        const prefix = normalizeManifestPrefix(section.name);
        if (!prefix) continue;
        for (const manifest of priorManifests) {
          const priorMatch = (manifest.sections || []).find((s) => s.type === 'component' && normalizeManifestPrefix(s.name) === prefix);
          if (priorMatch) {
            regressionQuestions.push(
              `"${section.name}" was a DS component in build #${manifest.buildNumber ?? '?'} (as "${priorMatch.name}") but a primitive in this build — ` +
              `was that intentional? If the DS component no longer fits, say why; if not, this is a downgrade.`
            );
            break;
          }
        }
      }
      knowledgeStore.addManifest({
        buildNumber: (knowledgeStore.data.meta.buildCount || 0) + 1,
        screenName: args.screenName || 'mimic-build',
        sections: currentManifestSections,
      });

      const totalInstances = components.reduce((sum, c) => sum + (c.instances || 0), 0);
      // Primitives with a reason are intentional (no DS component exists) — don't penalize them
      const unjustifiedPrimitives = primitives.filter(p => !p.reason || p.reason.length < 10);
      const totalBuiltElements = totalInstances + primitives.length;
      const penalizedElements = totalInstances + unjustifiedPrimitives.length;
      const componentUsageRatio = penalizedElements > 0 ? totalInstances / penalizedElements : 1;
      const componentUsagePercent = Math.round(componentUsageRatio * 100);
      const componentQualityGate = componentUsageRatio >= 0.8 ? 'PASS' : 'FAIL';
      const componentNames = components.map((c) => c.name).join(', ');
      const gaps = knowledgeStore.getGaps();
      const gapEntries = Object.entries(gaps);
      const patterns = knowledgeStore.data.patterns;
      const patternEntries = Object.entries(patterns);

      const date = new Date().toISOString().slice(0, 10);

      // ── Persist learning data FIRST so report reflects promoted state ──
      const promoter = new PatternMatcher();
      const promotions = [];
      // Dedup token for this report invocation — see _reportInvocationCounter above.
      const buildToken = ++_reportInvocationCounter;
      for (const comp of components) {
        let resolvedKey = comp.componentKey || null;
        const compName = comp.name.toLowerCase();
        if (!resolvedKey && session._componentInsertions) {
          // Word-boundary, exact-preferred match (fixes defect R): a naive
          // bidirectional substring match let "Button" resolve to a "Radio
          // Button" insertion's key (".includes()" both ways), merging
          // recipes across genuinely distinct components.
          for (const [key, info] of session._componentInsertions) {
            const names = info.names || [];
            if (names.some(n => wordBoundaryMatch(compName, n))) {
              resolvedKey = key;
              break;
            }
          }
        }
        if (!resolvedKey && dsCache && dsCache.components) {
          const leafName = compName.split('/').pop().trim();
          for (const [key, cached] of dsCache.components) {
            const cachedName = (cached.name || '').toLowerCase();
            if (cachedName === compName) { resolvedKey = key; break; }
          }
          if (!resolvedKey) {
            for (const [key, cached] of dsCache.components) {
              const cachedName = (cached.name || '').toLowerCase();
              if (cachedName === leafName && cached.isComponentSet !== false) { resolvedKey = key; break; }
            }
          }
        }
        // Key by componentKey when available so "Badge: On track" and "Badge: Plateau"
        // (same componentKey) merge into one entry instead of fragmenting.
        const storeKey = resolvedKey || comp.name;
        const existing = knowledgeStore.getComponent(storeKey);
        // Track all display names seen for this component
        const existingNames = existing?.names || [];
        if (!existingNames.includes(comp.name)) existingNames.push(comp.name);
        let recipe = existing
          ? { ...existing, names: existingNames, instances: (existing.instances || 0) + (comp.instances || 0), componentKey: existing.componentKey || resolvedKey }
          : { names: [comp.name], instances: comp.instances || 0, buildCount: 0, componentKey: resolvedKey, variantConfig: comp.variantConfig || null, confidence: 'new' };
        if (!recipe.confidence) recipe.confidence = 'new';
        const before = recipe.confidence;
        // Persist BEFORE recordComponentBuild — it mutates the stored recipe
        // object directly (dedup bookkeeping lives on the recipe itself).
        knowledgeStore.setComponent(storeKey, recipe);
        knowledgeStore.recordComponentBuild(storeKey, buildToken);
        recipe = knowledgeStore.getComponent(storeKey);
        recipe = promoter.maybePromote(recipe);
        if (recipe.confidence !== before) {
          promotions.push(`${comp.name} (${before} → ${recipe.confidence})`);
        }
        // Persist learned text node structure for batch optimization
        if (session._textNodeStructures && resolvedKey) {
          const textStructure = session._textNodeStructures.get(resolvedKey);
          if (textStructure && textStructure.nodeNames.length > 0) {
            recipe.textNodes = textStructure.nodeNames;
          }
        }
        knowledgeStore.setComponent(storeKey, recipe);
      }

      // ── Majority-wins variant learning (spec §5.1, fixes finding 2) ──
      // Counting unit: final variant state per inserted instance at report
      // time (session._nodeVariantConfigs, keyed by nodeId — populated by
      // components.js on insert-time auto-apply AND manual figma_set_variant,
      // last-write-wins PER NODE so a correction sequence on one node counts
      // once), not per set_variant call. Aggregated into variantStats, then
      // defaultVariants is RE-DERIVED (majority-wins), replacing the old
      // last-write-wins session._variantConfigs assignment.
      if (session._nodeComponentKeys && session._nodeVariantConfigs) {
        const recomputedKeys = new Set();
        for (const [nodeId, componentKey] of session._nodeComponentKeys) {
          const finalProps = session._nodeVariantConfigs.get(nodeId);
          if (!finalProps || Object.keys(finalProps).length === 0) continue;
          // Recipes are usually stored under componentKey directly (storeKey
          // === resolvedKey in the loop above) — fall back to scanning for a
          // recipe whose .componentKey matches, for the rarer name-keyed case.
          let storeKey = knowledgeStore.getComponent(componentKey) ? componentKey : null;
          if (!storeKey) {
            for (const [key, r] of Object.entries(knowledgeStore.data.components || {})) {
              if (r.componentKey === componentKey) { storeKey = key; break; }
            }
          }
          if (!storeKey) continue;
          for (const [prop, value] of Object.entries(finalProps)) {
            knowledgeStore.addVariantObservation(storeKey, prop, value, 1);
          }
          recomputedKeys.add(storeKey);
        }
        for (const storeKey of recomputedKeys) {
          knowledgeStore.recomputeDefaultVariants(storeKey);
        }
      }
      for (const prim of primitives) {
        if (prim.reason && prim.reason.length >= 10) {
          // Skip layout containers and artboard-like names — they are structural
          // frames, not missing DS components. Only record gaps for elements that
          // look like they SHOULD be components (have search terms, or the reason
          // indicates a real gap rather than generic "Custom frame created").
          const name = (prim.element || '').toLowerCase();
          const isGenericContainer = /^(content|container|wrapper|row|list|section|actions?|grid|column|group)/i.test(name);
          const isArtboardName = /^(build|test|replay|lv build|minerva)/i.test(name);
          const hasSearchTerms = prim.searchTerms && prim.searchTerms.length > 0;
          const hasSpecificReason = prim.reason && !/^(Custom frame created|Primitive created)/i.test(prim.reason);
          if (isGenericContainer || isArtboardName) {
            if (!hasSearchTerms && !hasSpecificReason) continue; // Skip noise
          }
          knowledgeStore.addGap(prim.element, {
            elements: [prim.element],
            evidence: `${prim.reason}. Screen: ${screenName}`,
            estimatedSavings: `~7 tool calls per instance if DS component existed`,
            searchTerms: prim.searchTerms || [],
          });
        }
      }
      // ── Pattern extraction from recurring primitive frames ──
      // Detect repeated frame name patterns (e.g. "Card: Revenue", "Card: Users"
      // share the pattern "Card:") and store them so future builds can reuse the layout.
      const frameSections = manifestSections.filter(s => s.type === 'frame' || s.type === 'primitive');
      const namePatterns = new Map(); // pattern prefix → count
      for (const section of frameSections) {
        const name = section.htmlSection || '';
        // Extract prefix before ":" or before the last word (e.g. "Card: Revenue" → "Card")
        const colonIdx = name.indexOf(':');
        const prefix = colonIdx > 0 ? name.slice(0, colonIdx).trim() : null;
        if (prefix && prefix.length >= 3) {
          namePatterns.set(prefix, (namePatterns.get(prefix) || 0) + 1);
        }
      }
      // Captured layout configs from this build session (set by figma_create_frame)
      const frameLayoutConfigs = session._frameLayoutConfigs || new Map();

      for (const [prefix, count] of namePatterns) {
        if (count >= 2) {
          // This prefix appeared 2+ times in the current build — it's a layout pattern
          const existing = knowledgeStore.getPattern(prefix);
          const capturedConfig = frameLayoutConfigs.get(prefix) || null;
          const updated = existing
            ? { ...promoter.incrementUsage(existing), occurrences: (existing.occurrences || 0) + count }
            : { description: `Recurring frame structure "${prefix}: ..." (${count} instances in ${screenName})`, buildCount: 1, occurrences: count, confidence: 'new', screen: screenName };
          // Attach layout config from the first instance — only if not already stored
          // (existing patterns keep their config; new patterns get it from this build)
          if (capturedConfig && !updated.layoutConfig) {
            updated.layoutConfig = capturedConfig;
          }
          const promoted = promoter.maybePromote(updated);
          knowledgeStore.setPattern(prefix, promoted);
        }
      }

      // Only increment buildCount when there were actual build operations (Phase 3 tool calls).
      // This prevents drift when the report is called to clear a circuit breaker or other non-build scenarios.
      // Reset phase3Ops after incrementing so subsequent reports in the same session
      // (where advancePhase(3) can't move the phase back from 5) don't double-count.
      const phase3Ops = session.phaseToolCalls?.[3] || 0;
      if (phase3Ops > 0) {
        knowledgeStore.incrementBuildCount();
        session.phaseToolCalls[3] = 0;
      }
      // ── Pattern demotion from in-build corrections (spec acceptance
      // criterion 17) ── build.js's figma_create_frame tracked, per prefix,
      // every instance in THIS build that explicitly overrode a property a
      // confirmed/verified pattern would have replayed
      // (session._layoutReplayCorrections). >=2 such instances of the SAME
      // prefix is treated as a deliberate design change, not a one-off
      // exception: demote() drops verified -> confirmed, pushes the OLD
      // layoutConfig onto layoutConfigHistory (capped at 3), and re-captures
      // layoutConfig from the corrected values so the next replay reflects
      // the new intent.
      const layoutCorrections = session._layoutReplayCorrections || new Map();
      for (const [prefix, correction] of layoutCorrections) {
        if (!correction || correction.count < 2) continue;
        const existingPattern = knowledgeStore.getPattern(prefix);
        if (!existingPattern || !existingPattern.layoutConfig) continue;
        const correctedConfig = { ...existingPattern.layoutConfig, ...correction.config };
        // buildCount was already incremented above (if phase3Ops > 0), so
        // knowledgeStore.data.meta.buildCount here IS the build this
        // correction happened in — same value `currentBuildNumber` below
        // computes.
        const demoted = promoter.demote(existingPattern, correctedConfig, knowledgeStore.data.meta.buildCount || null);
        knowledgeStore.setPattern(prefix, demoted);
      }

      // ── Flush session signals to knowledge store ──
      const currentBuildNumber = knowledgeStore.data.meta.buildCount;
      if (session._signals && session._signals.size > 0) {
        for (const [, signal] of session._signals) {
          knowledgeStore.addSignal({ ...signal, buildNumber: currentBuildNumber });
        }
        session._signals.clear();
      }
      knowledgeStore.evictOldSignals(currentBuildNumber);

      // ── Compile no-goods ──
      const allSignals = knowledgeStore.getSignals();
      const allRules = knowledgeStore.getRules();
      // Inject dsCache.suggestVariable (spec §5.4, finding 5) so a compiled
      // no-good rule proposes a variable that ACTUALLY EXISTS in the active
      // DS cache instead of guessing a prefix via string surgery.
      const compiled = compileNoGoods(allSignals, allRules, {
        suggestVariable: (path, category) => (dsCache ? dsCache.suggestVariable(path, category) : []),
      });

      // Write new candidate rules
      for (const candidate of compiled.candidates) {
        knowledgeStore.setRule(candidate.id, {
          category: candidate.category,
          rule: candidate.rule,
          reason: candidate.reason,
          scope: '',
          source: candidate.source,
          status: candidate.status,
          compiledFrom: candidate.compiledFrom,
          compiledAt: candidate.compiledAt,
        });
      }

      // Auto-promote candidates
      for (const ruleId of compiled.promotions) {
        const rule = knowledgeStore.getRule(ruleId);
        if (rule) {
          knowledgeStore.setRule(ruleId, { ...rule, status: 'active' });
        }
      }

      // NOTE: a save() call used to happen here, followed by a second
      // save() after recordBuild() below with nothing in between that reads
      // from disk. That's harmless for last-writer-wins fields, but
      // KnowledgeStore.save()'s merge-with-disk step SUMS variantStats
      // (spec §3.1 — correct for genuinely concurrent sessions), so two
      // saves of the same unchanged in-memory recipe within one report()
      // call double-counted every variantStats observation added above
      // (disk already had this call's contribution from the first save;
      // merging it against the still-identical in-memory value summed it
      // again). Single save() at the end of the handler avoids this.

      // Build markdown report (after learning so confidence tiers are current)
      const lines = [
        `# Build Report — ${screenName}`,
        '',
        `## DS Components: ${totalInstances} instances (${componentNames || 'none'})`,
        '',
      ];

      if (components.length > 0) {
        components.forEach((c) => {
          lines.push(`- **${c.name}**: ${c.instances} instance${c.instances === 1 ? '' : 's'}`);
        });
        lines.push('');
      }

      const justifiedCount = primitives.length - unjustifiedPrimitives.length;
      lines.push(`## Component-First Quality: ${componentQualityGate} (${componentUsagePercent}% component usage)`);
      lines.push('');
      if (justifiedCount > 0) {
        lines.push(`${justifiedCount} of ${primitives.length} primitive(s) are justified (no DS component exists). Only ${unjustifiedPrimitives.length} unjustified primitive(s) counted against the quality gate.`);
        lines.push('');
      }
      if (componentQualityGate === 'FAIL') {
        lines.push('Component usage is below the 80% minimum quality gate. Future builds should resolve missing elements with `mimic_map_components`, library search, and `figma_insert_component` before using primitives.');
        lines.push('');
      }

      lines.push(`## Primitives: ${primitives.length} (${primitives.map((p) => `${p.element}: ${p.reason}`).join(', ') || 'none'})`);
      lines.push('');

      if (primitives.length > 0) {
        primitives.forEach((p) => {
          lines.push(`- **${p.element}**: ${p.reason}`);
          if (p.searchTerms && p.searchTerms.length > 0) {
            lines.push(`  - Search terms tried: ${p.searchTerms.join(', ')}`);
          }
        });
        lines.push('');
      }

      // ── Unused mapped components audit ──
      // Cross-reference mimic_map_components results with actual insertions.
      // Flag any component that was mapped (available in DS) but never inserted.
      const unusedMappedComponents = [];
      if (session?.componentMap?.components?.length) {
        const insertedKeys = session._componentInsertions
          ? new Set([...session._componentInsertions.keys()])
          : new Set();
        // Also check the caller-provided components list for name matches
        const reportedNames = new Set(components.map(c => c.name.toLowerCase()));
        for (const mapped of session.componentMap.components) {
          const wasInserted = insertedKeys.has(mapped.componentKey);
          const wasReported = reportedNames.has((mapped.componentName || '').toLowerCase())
            || reportedNames.has((mapped.elementType || '').toLowerCase());
          if (!wasInserted && !wasReported) {
            unusedMappedComponents.push(mapped);
          }
        }
      }

      // Binding failures (from session tracking)
      const bindingFailures = session.bindingFailures || [];

      // Record build snapshot for cross-build comparison (after all metrics are computed)
      knowledgeStore.recordBuild({
        screenName,
        toolCalls: toolCallCount,
        cacheHits,
        replaySavings: session.replaySavings || 0,
        componentCount: totalInstances,
        primitiveCount: primitives.length,
        bindingFailures: bindingFailures.length,
        componentUsagePercent,
      });
      knowledgeStore.save();

      if (bindingFailures.length > 0) {
        lines.push(`## ⚠ Binding Failures: ${bindingFailures.length} nodes with failed DS bindings`);
        lines.push('');
        const failedVarCounts = {};
        bindingFailures.forEach((bf) => {
          const nodeName = bf.nodeName || bf.nodeId || 'unknown';
          lines.push(`- **${nodeName}** (${bf.tool}): ${bf.failedBindings.join(', ')}`);
          bf.failedBindings.forEach((v) => { failedVarCounts[v] = (failedVarCounts[v] || 0) + 1; });
        });
        lines.push('');
        // Most-failed bindings summary
        const sorted = Object.entries(failedVarCounts).sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) {
          lines.push('**Most common failures:**');
          sorted.slice(0, 5).forEach(([name, count]) => {
            lines.push(`- \`${name}\`: failed ${count} time${count === 1 ? '' : 's'}`);
          });
          lines.push('');
          lines.push('**Recovery:** Call `figma_list_ds` (kind: "variables") to verify cached variable paths. The variable may not be preloaded, or the path may be wrong.');
          lines.push('');
        }
      } else {
        lines.push('## DS Binding Quality: All bindings succeeded');
        lines.push('');
      }

      // ── Unused mapped components section ──
      if (unusedMappedComponents.length > 0) {
        lines.push(`## Unused Mapped Components: ${unusedMappedComponents.length} mapped but never inserted`);
        lines.push('');
        lines.push('These components were found by `mimic_map_components` but were never used via `figma_insert_component`. Consider using them instead of primitives in future builds.');
        lines.push('');
        unusedMappedComponents.forEach(c => {
          lines.push(`- **${c.componentName}** (elementType: "${c.elementType}", componentKey: \`${c.componentKey}\`)`);
        });
        lines.push('');
      }

      // Text override completeness check
      const textTracker = session.componentTextTracker || new Map();
      const unoverriddenComponents = [];
      for (const [compNodeId, tracker] of textTracker) {
        const missing = tracker.expected.filter(t => {
          // Check if overridden by exact nodeId OR by text node name
          return !tracker.overridden.has(t.nodeId) && !tracker.overridden.has(t.name);
        });
        if (missing.length > 0) {
          unoverriddenComponents.push({
            name: tracker.name,
            nodeId: compNodeId,
            total: tracker.expected.length,
            overridden: tracker.expected.length - missing.length,
            missing: missing.map(t => `"${t.name}" (still: "${t.defaultText}")`),
          });
        }
      }
      const unoverriddenCount = unoverriddenComponents.reduce((sum, c) => sum + c.missing.length, 0);

      if (unoverriddenComponents.length > 0) {
        lines.push(`## ⚠ Unoverridden Text: ${unoverriddenCount} text node(s) in ${unoverriddenComponents.length} component(s) still have default content`);
        lines.push('');
        unoverriddenComponents.forEach(c => {
          lines.push(`- **${c.name}** (${c.overridden}/${c.total} overridden): ${c.missing.join(', ')}`);
        });
        lines.push('');
        lines.push('These text nodes were not set via figma_component_text. They likely still show DS placeholder content instead of HTML source text.');
        lines.push('');
      }

      const replaySavings = session.replaySavings || 0;
      const replayNote = replaySavings > 0 ? `, ${replaySavings} replayed` : '';
      lines.push(`## Efficiency: ${toolCallCount} tool calls (${cacheHits} from cache${replayNote})`);
      lines.push('');

      // Resolved gaps stop generating recommendations (spec §4.5/§5.4,
      // defect L) — they're covered by the DS Changes gap-resolution block
      // instead, so listing them here again (forever) would be noise.
      const openGapEntries = gapEntries.filter(([, gap]) => (gap.status || 'open') === 'open');

      lines.push('## DS Gap Recommendations');
      lines.push('');
      if (openGapEntries.length > 0) {
        openGapEntries.forEach(([name, gap]) => {
          const buildTrend = gap.buildNumbers && gap.buildNumbers.length > 0
            ? ` (appeared in ${gap.buildNumbers.length} build${gap.buildNumbers.length === 1 ? '' : 's'}: ${gap.buildNumbers.map(b => `#${b}`).join(', ')})`
            : '';
          lines.push(`- **${name}**: ${gap.elements ? gap.elements.join(', ') : 'N/A'}${buildTrend}`);
          if (gap.evidence) lines.push(`  - Evidence: ${gap.evidence}`);
          if (gap.estimatedSavings) lines.push(`  - Estimated savings: ${gap.estimatedSavings}`);
        });
      } else {
        lines.push('No open DS gaps identified.');
      }
      lines.push('');

      lines.push('## Component Confidence');
      lines.push('');
      const componentRecipes = Object.entries(knowledgeStore.data.components);
      if (componentRecipes.length > 0) {
        componentRecipes.forEach(([key, recipe]) => {
          const displayName = recipe.names?.length > 0 ? recipe.names.join(', ') : key;
          const tier = recipe.confidence || 'new';
          const badge = tier === 'verified' ? '🟢 verified' : tier === 'confirmed' ? '🟡 confirmed' : tier === 'strong' ? '🟡 confirmed' : '🔵 new';
          const staleTag = recipe.stale ? ` ⚠ STALE (${recipe.staleReason})` : '';
          lines.push(`- **${displayName}**: ${badge}${staleTag} (${recipe.buildCount || 0} builds, ${recipe.instances || 0} instances)`);
        });
      } else {
        lines.push('No component recipes stored.');
      }
      lines.push('');

      // Build history trend
      const history = knowledgeStore.getBuildHistory();
      if (history.length >= 2) {
        lines.push('## Learning Trend');
        lines.push('');
        lines.push('| Build | Screen | Tool Calls | Cache Hits | Replayed | Components | Primitives | DS Usage |');
        lines.push('|-------|--------|-----------|------------|----------|------------|------------|----------|');
        for (const h of history) {
          lines.push(`| #${h.buildNumber} | ${h.screenName} | ${h.toolCalls} | ${h.cacheHits} | ${h.replaySavings || 0} | ${h.componentCount} | ${h.primitiveCount} | ${h.componentUsagePercent}% |`);
        }
        lines.push('');
        const totalCacheHits = history.reduce((sum, h) => sum + (h.cacheHits || 0), 0);
        const totalReplaySavings = history.reduce((sum, h) => sum + (h.replaySavings || 0), 0);

        // ── Median tool-calls-per-element (spec §5.4) ──
        // Replaces the old first-vs-last-build tool-call percentage (finding
        // P: noise — compares unlike screens across a rolling window whose
        // baseline silently shifts once it rolls past the cap). This
        // like-for-like signal normalizes by element count per build
        // (toolCalls / (componentCount + primitiveCount)) so screen
        // complexity doesn't distort the comparison, and only claims
        // improvement when the metric itself actually improves.
        const perElement = (h) => {
          const elements = (h.componentCount || 0) + (h.primitiveCount || 0);
          return elements > 0 ? h.toolCalls / elements : null;
        };
        const median = (arr) => {
          const sorted = [...arr].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        };
        const last5 = history.slice(-5).map(perElement).filter((v) => v !== null);
        const previous5 = history.slice(-10, -5).map(perElement).filter((v) => v !== null);
        let trendLine = `**Learning signal:** ${totalCacheHits} cache hit(s) and ${totalReplaySavings} template/layout ` +
          `replay(s) saved across ${history.length} tracked build(s).`;
        if (last5.length > 0 && previous5.length > 0) {
          const medLast = median(last5);
          const medPrev = median(previous5);
          const delta = medPrev > 0 ? Math.round((1 - medLast / medPrev) * 100) : 0;
          trendLine += delta > 0
            ? ` Median tool calls per element: ${medPrev.toFixed(1)} → ${medLast.toFixed(1)} (${delta}% fewer) — learning is measurably reducing effort per element.`
            : delta < 0
              ? ` Median tool calls per element: ${medPrev.toFixed(1)} → ${medLast.toFixed(1)} (${Math.abs(delta)}% more) — no improvement yet on this like-for-like metric.`
              : ` Median tool calls per element: ${medLast.toFixed(1)} (unchanged vs. the previous 5 builds).`;
        } else {
          trendLine += ' Not enough build history yet for a like-for-like median tool-calls-per-element comparison (needs 5+ builds on each side).';
        }
        lines.push(trendLine);
        lines.push('');
      }

      // ── DS Changes (spec §4.5) — four ordered blocks: gap resolutions
      // FIRST (the payoff moment), then renames (reassurance), then variant/
      // schema changes, then removals. Gap resolutions/renames come from
      // the most recent discovery's classified diff (session.
      // lastDsChangesReport, stashed by status.js); variant changes and
      // removals are read from persisted recipe staleness/needsReverify,
      // which survives across sessions even without a fresh discovery this
      // build. ──
      const dsChangesReport = session.lastDsChangesReport || null;
      const staleRecipeEntries = Object.entries(knowledgeStore.data.components)
        .map(([key, recipe]) => ({ key, recipe }))
        .filter(({ recipe }) => recipe.stale || recipe.needsReverify);
      const removedEntries = staleRecipeEntries.filter(({ recipe }) => recipe.staleReason === 'component_removed');
      const variantEntries = staleRecipeEntries.filter(({ recipe }) =>
        recipe.staleReason === 'variant_property_removed' || recipe.staleReason === 'variant_value_removed' || (recipe.needsReverify && !recipe.stale));

      const hasAnyDsChanges = (dsChangesReport && (
        dsChangesReport.gapResolutions.length > 0 || dsChangesReport.renames.length > 0
        || dsChangesReport.styleRenames.length > 0 || dsChangesReport.tokenRenames.length > 0
      )) || removedEntries.length > 0 || variantEntries.length > 0;

      if (hasAnyDsChanges) {
        lines.push('## DS Changes');
        lines.push('');

        // Block 1 — Gap resolutions FIRST (the payoff moment).
        if (dsChangesReport && dsChangesReport.gapResolutions.length > 0) {
          lines.push('**New components resolve open gaps:**');
          for (const g of dsChangesReport.gapResolutions) {
            const gap = knowledgeStore.data.gaps?.[g.gapName];
            const builds = gap?.buildNumbers?.length > 0 ? gap.buildNumbers.map(b => `#${b}`).join(', ') : 'earlier builds';
            lines.push(`- You added **${g.componentName}** — this covers the gap recorded in builds ${builds}. Mimic will use it automatically next build.`);
          }
          lines.push('');
        }

        // Block 2 — Renames (reassurance: nothing to do).
        const renameLines = [
          ...(dsChangesReport?.renames || []).map(d => `- **${d.oldName}** → **${d.newName}**: nothing to do, Mimic tracks components by key; recipes updated.`),
          ...(dsChangesReport?.styleRenames || []).map(d => `- Style **${d.oldName}** → **${d.newName}**: nothing to do, tracked by key.`),
          ...(dsChangesReport?.tokenRenames || []).map(d => `- Token **${d.oldPath}** → **${d.newPath}**: nothing to do, rules citing the old path were updated automatically.`),
        ];
        if (renameLines.length > 0) {
          lines.push('**Renames:**');
          lines.push(...renameLines);
          lines.push('');
        }

        // Block 3 — Variant/schema changes.
        if (variantEntries.length > 0) {
          lines.push('**Variant/schema changes:**');
          for (const { recipe } of variantEntries) {
            const name = recipe.names?.[0] || 'unknown';
            if (recipe.stale) {
              lines.push(`- **${name}** — ${recipe.staleReason}. Replay is PAUSED until a validated build re-confirms it. One clean build restores it.`);
            } else {
              lines.push(`- **${name}** — new variant value(s) detected; confidence ${recipe.confidence} (re-verify mode). Replay still applies but is validated per-property at insert time.`);
            }
          }
          lines.push('');
        }

        // Block 4 — Removals (with usage stats).
        if (removedEntries.length > 0) {
          lines.push('**Removed components** (template replay disabled — will fall back to manual configuration):');
          for (const { recipe } of removedEntries) {
            const name = recipe.names?.[0] || 'unknown';
            lines.push(`- **${name}** — used ${recipe.instances || 0} time(s) across ${recipe.buildCount || 0} build(s).${recipe.confidence === 'verified' ? ' Was verified (high confidence).' : ''}`);
          }
          lines.push('');
        }
      }
      // This discovery's diff has now been reported — clear it so a later
      // report (no new discovery in between) doesn't re-show the same changes.
      session.lastDsChangesReport = null;

      // Kept for backward-compat callers reading `staleRecipes`/`dsChanges`
      // fields on the tool response below.
      const staleRecipes = staleRecipeEntries.map(({ key, recipe }) => ({
        name: recipe.names?.[0] || key,
        reason: recipe.staleReason || (recipe.needsReverify ? 'needs_reverify' : 'unknown'),
        instances: recipe.instances || 0,
        buildCount: recipe.buildCount || 0,
        confidence: recipe.confidence || 'new',
      }));

      // ── Regression Check (spec §5.4, acceptance 21) — report-only ──
      if (regressionQuestions.length > 0) {
        lines.push(`## Regression Check: ${regressionQuestions.length} question(s)`);
        lines.push('');
        regressionQuestions.forEach((q) => lines.push(`- ${q}`));
        lines.push('');
      }

      // ── User Recommendations ──
      // Actionable suggestions for the user to improve their DS.
      const recommendations = [];

      // 0. Component-first quality gate failure — always leads the list when
      // failing. A build with a failing gate is never "all good", regardless
      // of what else is (or isn't) in this array.
      if (componentQualityGate === 'FAIL') {
        recommendations.push(
          `**Component-first quality gate failed:** ${componentUsagePercent}% component usage ` +
          `(minimum is 80%). ${unjustifiedPrimitives.length} unjustified primitive(s) were used ` +
          `where a DS component should have been found first. Resolve missing elements with ` +
          `\`mimic_map_components\`, library search, and \`figma_insert_component\` before falling ` +
          `back to primitives in future builds.`
        );
      }

      // 1. Missing variable categories detected from binding failures
      const missingVarCategories = new Set();
      for (const bf of bindingFailures) {
        for (const varPath of bf.failedBindings) {
          const lower = varPath.toLowerCase();
          if (lower.includes('border') && lower.includes('success')) missingVarCategories.add('border-success');
          if (lower.includes('border') && lower.includes('warning')) missingVarCategories.add('border-warning');
          if (lower.includes('border') && lower.includes('error')) missingVarCategories.add('border-error');
          if (lower.includes('border') && lower.includes('brand')) missingVarCategories.add('border-brand');
        }
      }
      if (missingVarCategories.size > 0) {
        recommendations.push(
          `**Add missing DS variables:** ${[...missingVarCategories].join(', ')}. ` +
          `These were needed during the build but don't exist in the DS. ` +
          `Add them to your DS library so future builds can bind to them.`
        );
      }

      // 2. Category mismatches detected during build (from session tracking)
      const categoryMismatches = session.categoryMismatches || [];
      if (categoryMismatches.length > 0) {
        const uniqueMismatches = [...new Set(categoryMismatches)].slice(0, 5);
        recommendations.push(
          `**Variable category mismatches:** ${uniqueMismatches.length} instance(s) where a variable was used outside its semantic category (e.g., bg-* for strokes instead of border-*). ` +
          `This was auto-corrected during the build.`
        );
      }

      // 3. Top gap components to create — ranked by DISTINCT builds
      // (buildNumbers.length), not per-build element count (spec §5.4);
      // resolved gaps are excluded (defect L — they stop recommending once
      // closed). Shows the trend ("appeared in N of the last M builds").
      if (openGapEntries.length > 0) {
        // Group gaps by pattern (e.g., all "Card: *" gaps → "Metric Card")
        const gapsByType = {};
        for (const [name, gap] of openGapEntries) {
          const type = name.replace(/:.*/g, '').trim();
          if (!gapsByType[type]) gapsByType[type] = { buildNumbers: new Set(), names: [], savings: 0 };
          for (const b of (gap.buildNumbers || [])) gapsByType[type].buildNumbers.add(b);
          gapsByType[type].names.push(name);
          const savingsMatch = (gap.estimatedSavings || '').match(/~(\d+)/);
          if (savingsMatch) gapsByType[type].savings += parseInt(savingsMatch[1], 10);
        }
        const topGaps = Object.entries(gapsByType)
          .sort((a, b) => b[1].buildNumbers.size - a[1].buildNumbers.size)
          .slice(0, 5);
        if (topGaps.length > 0) {
          const gapList = topGaps.map(([type, data]) => {
            const distinctBuilds = data.buildNumbers.size;
            const trend = distinctBuilds > 0 ? `, appeared in ${distinctBuilds} build${distinctBuilds === 1 ? '' : 's'}` : '';
            return `${type} (~${data.savings} tool calls saved${trend})`;
          }).join(', ');
          recommendations.push(
            `**Create these DS components to improve future builds:** ${gapList}. ` +
            `These patterns appear repeatedly as primitives. Adding them to the DS would reduce build time and improve consistency.`
          );
        }
      }

      // 4. Stale recipe actions
      if (staleRecipes.length > 0) {
        const highImpactStale = staleRecipes
          .filter(r => r.confidence === 'verified' || r.instances >= 10)
          .map(r => r.name);
        if (highImpactStale.length > 0) {
          recommendations.push(
            `**Review DS library changes:** ${highImpactStale.join(', ')} ${highImpactStale.length === 1 ? 'is' : 'are'} ` +
            `high-usage component(s) now marked stale. Re-publish or update these in the DS library to restore template replay.`
          );
        }
      }

      // 5. Learning signal from this build's own valid, non-comparative metrics.
      // NOTE: this used to compare tool-call counts across builds ("N% fewer tool
      // calls than your first build") to claim learning was working. That
      // comparison was removed — screen complexity varies too much between
      // builds for a raw tool-call delta to mean anything. Cache hits and
      // template/layout replay savings are measured directly on this build and
      // don't depend on comparing unlike screens, so they're what's reported here.
      if (cacheHits > 0 || replaySavings > 0) {
        const parts = [];
        if (cacheHits > 0) parts.push(`${cacheHits} cache hit${cacheHits === 1 ? '' : 's'}`);
        if (replaySavings > 0) parts.push(`${replaySavings} tool call${replaySavings === 1 ? '' : 's'} saved via template/layout replay`);
        recommendations.push(
          `**Learning is active:** ${parts.join(' and ')} on this build, from confirmed/verified ` +
          `component recipes and layout patterns reused from prior builds.`
        );
      }

      // 6. Components approaching promotion
      const nearPromotion = Object.entries(knowledgeStore.data.components)
        .filter(([, r]) => !r.stale && r.confidence === 'confirmed' && (r.buildCount || 0) >= 5)
        .map(([, r]) => r.names?.[0] || 'unknown');
      if (nearPromotion.length > 0) {
        recommendations.push(
          `**Approaching verified status:** ${nearPromotion.join(', ')} — ${nearPromotion.length === 1 ? 'needs' : 'need'} ` +
          `${7 - 5} more build(s) with consistent usage to reach verified confidence. Template replay becomes more reliable at verified.`
        );
      }

      // Always include recommendations section (even if empty — shows the tool is checking)
      lines.push('## Recommendations');
      lines.push('');
      if (recommendations.length > 0) {
        recommendations.forEach(r => lines.push(`- ${r}`));
      } else {
        lines.push('No recommendations for this build. DS coverage and build quality are good.');
      }
      lines.push('');

      lines.push('## Patterns Learned');
      lines.push('');
      if (patternEntries.length > 0) {
        patternEntries.forEach(([name, pattern]) => {
          lines.push(`- **${name}**: ${pattern.description || JSON.stringify(pattern)}`);
        });
      } else {
        lines.push('No new patterns recorded.');
      }
      lines.push('');

      // ── Rule Compliance Audit ──
      // Check if the build followed stored design rules.
      const storedRules = Object.entries(knowledgeStore.data.rules || {});
      const ruleViolations = [];
      if (storedRules.length > 0) {
        const compNames = components.map(c => c.name.toLowerCase());
        const primNames = primitives.map(p => (p.element || '').toLowerCase());
        const allNames = [...compNames, ...primNames];

        for (const [ruleId, rule] of storedRules) {
          const ruleText = (rule.rule || '').toLowerCase();
          const ruleScope = (rule.scope || '').toLowerCase();

          // Structure rules: check if expected components were used
          if (rule.category === 'structure') {
            // Extract component names mentioned in the rule
            const mentionedComponents = [];
            const componentPatterns = ['card header', 'badge', 'button', 'input', 'tab', 'progress bar', 'divider', 'sidebar', 'footer', 'header', 'avatar', 'dropdown', 'table'];
            for (const cp of componentPatterns) {
              if (ruleText.includes(cp)) mentionedComponents.push(cp);
            }
            // Check if any mentioned components were built as primitives instead
            for (const mc of mentionedComponents) {
              const builtAsPrimitive = primNames.some(p => p.includes(mc));
              const builtAsComponent = compNames.some(c => c.toLowerCase().includes(mc));
              if (builtAsPrimitive && !builtAsComponent) {
                ruleViolations.push({
                  ruleId,
                  rule: rule.rule,
                  violation: `"${mc}" was built as a primitive but rule requires it as a DS component.`,
                  severity: 'WARN',
                });
              }
            }
          }

          // Component rules: check if mentioned component was used
          if (rule.category === 'component') {
            const scopeWords = ruleScope.split(/[\s,]+/).filter(w => w.length >= 3);
            const ruleApplies = scopeWords.length === 0 || scopeWords.some(w => allNames.some(n => n.includes(w)));
            // If rule scope matches built elements but element was a primitive, flag it
            if (ruleApplies && scopeWords.length > 0) {
              for (const sw of scopeWords) {
                const asPrimitive = primNames.some(p => p.includes(sw));
                if (asPrimitive) {
                  ruleViolations.push({
                    ruleId,
                    rule: rule.rule,
                    violation: `Element matching "${sw}" built as primitive. Rule suggests using a DS component with specific configuration.`,
                    severity: 'WARN',
                  });
                }
              }
            }
          }

          // Color rules: check if category mismatches involved semantic colors
          if (rule.category === 'color' && categoryMismatches.length > 0) {
            const semanticTerms = ['brand', 'success', 'warning', 'error'];
            const violatingMismatches = categoryMismatches.filter(m => {
              const lower = m.toLowerCase();
              return semanticTerms.some(t => lower.includes(t));
            });
            if (violatingMismatches.length > 0) {
              ruleViolations.push({
                ruleId,
                rule: rule.rule,
                violation: `${violatingMismatches.length} instance(s) of semantic color misuse detected.`,
                severity: 'WARN',
              });
            }
          }
        }
      }

      if (ruleViolations.length > 0) {
        lines.push(`## ⚠ Rule Compliance: ${ruleViolations.length} violation(s)`);
        lines.push('');
        for (const rv of ruleViolations) {
          lines.push(`- **${rv.ruleId}**: ${rv.violation}`);
          lines.push(`  - Rule: ${rv.rule}`);
        }
        lines.push('');
      } else if (storedRules.length > 0) {
        lines.push(`## ✓ Rule Compliance: All ${storedRules.length} rule(s) followed`);
        lines.push('');
      }

      // ── Rule Candidates (from no-good compilation) ──
      if (compiled.candidates.length > 0 || compiled.promotions.length > 0) {
        lines.push('## Rule Candidates (auto-compiled from repeated failures)');
        lines.push('');
        if (compiled.candidates.length > 0) {
          lines.push(`${compiled.candidates.length} new candidate(s) compiled from recurring build failures:`);
          lines.push('');
          for (const c of compiled.candidates) {
            lines.push(`- **${c.id}** (${c.compiledFrom[0]}, 3+ builds): ${c.rule}`);
            lines.push(`  Confirm: call mimic_ai_knowledge_write with id "${c.id}", type "rule", data { status: "active" }`);
            lines.push(`  Dismiss: call mimic_ai_knowledge_write with id "${c.id}", type "rule", data { status: "dismissed" }`);
          }
          lines.push('');
        }
        if (compiled.promotions.length > 0) {
          lines.push(`${compiled.promotions.length} candidate(s) auto-promoted to active (6+ occurrences without dismissal):`);
          lines.push('');
          for (const ruleId of compiled.promotions) {
            const rule = knowledgeStore.getRule(ruleId);
            lines.push(`- **${ruleId}**: ${rule?.rule || 'Unknown rule'}`);
          }
          lines.push('');
        }
      }

      // ── Post-Build Structural Validation ──
      // Runs automatically before report to catch broken layouts.
      const validationResults = [];
      // PASS | WARN | FAIL | UNAVAILABLE — starts as UNAVAILABLE so the
      // report never claims "Passed" unless checks actually executed. Only
      // flips to PASS once we've successfully reached the bridge and have an
      // artboard to inspect.
      let validationStatus = 'UNAVAILABLE';

      // Try to validate the artboard structure via the bridge
      try {
        const artboardId = buildManifest.artboardId || session.artboardId;
        if (artboardId) {
          const artboardProps = await bridge.send('get_node_props', { nodeId: artboardId });
          // We reached the bridge and got the artboard — validation is actually
          // running now. Downgrade to WARN/FAIL below if a check flags an issue.
          validationStatus = 'PASS';

          // 1. LAYOUT SANITY — height:width ratio check
          if (artboardProps && artboardProps.width > 0) {
            const ratio = artboardProps.height / artboardProps.width;
            if (ratio > 3) {
              validationResults.push({
                check: 'Layout Sanity',
                status: 'FAIL',
                detail: `Artboard ratio ${ratio.toFixed(1)}:1 (${artboardProps.width}×${artboardProps.height}px). Expected < 3:1 for a dashboard. Likely a layout issue — missing horizontal grid or everything stacked vertically.`,
              });
              validationStatus = 'FAIL';
            } else if (ratio > 2) {
              validationResults.push({
                check: 'Layout Sanity',
                status: 'WARN',
                detail: `Artboard ratio ${ratio.toFixed(1)}:1 (${artboardProps.width}×${artboardProps.height}px). Slightly tall — verify layout is correct.`,
              });
              if (validationStatus !== 'FAIL') validationStatus = 'WARN';
            } else {
              validationResults.push({
                check: 'Layout Sanity',
                status: 'PASS',
                detail: `Artboard ratio ${ratio.toFixed(1)}:1 (${artboardProps.width}×${artboardProps.height}px). Normal.`,
              });
            }
          }

          // 2. CONTENT DEDUPLICATION — scan text nodes for repeated strings
          try {
            const allChildren = await bridge.send('get_node_children', { nodeId: artboardId, depth: 10 });
            const textContents = [];
            const emptyFrames = [];
            function walkChildren(node) {
              if (!node) return;
              if (node.type === 'TEXT' && node.characters && node.characters.length > 10) {
                textContents.push(node.characters);
              }
              // Check for empty frames > 100px
              if ((node.type === 'FRAME' || node.type === 'GROUP') && node.childrenCount === 0 && (node.width > 100 || node.height > 100)) {
                emptyFrames.push({ name: node.name || node.id, width: node.width, height: node.height });
              }
              if (node.children) {
                node.children.forEach(walkChildren);
              }
            }
            if (allChildren && allChildren.children) {
              allChildren.children.forEach(walkChildren);
            }

            // Find duplicates
            const contentCounts = {};
            textContents.forEach(t => { contentCounts[t] = (contentCounts[t] || 0) + 1; });
            const duplicates = Object.entries(contentCounts).filter(([text, count]) => count > 1 && text.length > 15);
            if (duplicates.length > 0) {
              validationResults.push({
                check: 'Content Deduplication',
                status: 'WARN',
                detail: `${duplicates.length} repeated text string(s) found: ${duplicates.map(([t, c]) => `"${t.slice(0, 40)}..." (×${c})`).join(', ')}. May indicate duplicate content from a failed build.`,
              });
              if (validationStatus !== 'FAIL') validationStatus = 'WARN';
            } else {
              validationResults.push({
                check: 'Content Deduplication',
                status: 'PASS',
                detail: 'No unexpected duplicate text content found.',
              });
            }

            // 3. STRUCTURAL VALIDATION — empty frames, frames with no fill where expected
            if (emptyFrames.length > 0) {
              validationResults.push({
                check: 'Empty Frames',
                status: 'WARN',
                detail: `${emptyFrames.length} empty frame(s) > 100px found: ${emptyFrames.map(f => `"${f.name}" (${f.width}×${f.height})`).join(', ')}. May be missing content.`,
              });
              if (validationStatus !== 'FAIL') validationStatus = 'WARN';
            } else {
              validationResults.push({
                check: 'Empty Frames',
                status: 'PASS',
                detail: 'No empty oversized frames found.',
              });
            }
          } catch (e2) { /* deep scan failed — non-fatal */ }
        }
      } catch (e) {
        // Artboard not found, or the bridge call itself failed — validation
        // never ran. Only downgrade if nothing was actually checked yet; if
        // earlier checks already ran and pushed results, keep their status.
        if (validationResults.length === 0) validationStatus = 'UNAVAILABLE';
      }

      // Add validation section to report — the header must always match
      // validationStatus honestly. "Passed" is never shown unless checks
      // actually executed (validationStatus === 'PASS').
      const validationHeader = validationStatus === 'FAIL'
        ? '## ⚠ BUILD NEEDS REVIEW — Structural Validation'
        : validationStatus === 'WARN'
          ? '## ⚠ Build Warnings — Structural Validation'
          : validationStatus === 'UNAVAILABLE'
            ? '## ⚠ Structural Validation Skipped'
            : '## ✓ Structural Validation Passed';
      lines.push(validationHeader);
      lines.push('');
      if (validationResults.length > 0) {
        validationResults.forEach(v => {
          const icon = v.status === 'PASS' ? '✓' : v.status === 'WARN' ? '⚠' : '✗';
          lines.push(`- ${icon} **${v.check}**: ${v.detail}`);
        });
      } else {
        lines.push('Validation could not run (no artboard ID available, or the artboard could not be reached). This is NOT the same as passing — treat it as unverified.');
      }
      lines.push('');

      const reportContent = lines.join('\n');
      const safeName = screenName.replace(/[^a-zA-Z0-9_-]/g, '-');

      // ── Unblock the session BEFORE attempting any file writes ──
      // Learning has already been persisted (knowledgeStore.save() above).
      // If cwd is unwritable, the report/manifest writes below may fail —
      // that must degrade to a warning, never leave the user stuck in
      // REPORT_REQUIRED forever. The report content is returned inline
      // below regardless of whether either file write succeeds.
      advancePhase(5);
      session.buildsSinceReport = 0;

      // Save report file — fall back to ~/.mimic-ai/reports/ if cwd is unwritable.
      let reportPath = null;
      let reportWriteWarning = null;
      try {
        // Per-build folder named "<date> <build name>" so every build's
        // documents live together (report + any HTML export + future
        // artifacts). Written under the current working directory, never a
        // hardcoded location — keeps Mimic DS/host-agnostic for public use.
        const reportsDir = path.join(process.cwd(), 'mimic', 'builds', `${date} ${safeName}`);
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
        reportPath = path.join(reportsDir, 'build-report.md');
        fs.writeFileSync(reportPath, reportContent, 'utf-8');
      } catch (err) {
        try {
          const fallbackDir = path.join(os.homedir(), '.mimic-ai', 'builds', `${date} ${safeName}`);
          if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
          reportPath = path.join(fallbackDir, 'build-report.md');
          fs.writeFileSync(reportPath, reportContent, 'utf-8');
          reportWriteWarning = `Could not write the report to the project directory (${err.message}). Saved to ${reportPath} instead.`;
        } catch (fallbackErr) {
          reportPath = null;
          reportWriteWarning = `Could not save the build report to disk (project dir: ${err.message}; fallback: ${fallbackErr.message}). The report content in this response is the only copy — save it manually if you need it.`;
        }
      }

      // Save build manifest — same fallback strategy.
      let manifestWriteWarning = null;
      try {
        const buildsDir = path.join(process.cwd(), 'mimic', 'builds');
        if (!fs.existsSync(buildsDir)) fs.mkdirSync(buildsDir, { recursive: true });
        buildManifest.save(path.join(buildsDir, 'last-build.json'));
      } catch (err) {
        try {
          const fallbackBuildsDir = path.join(os.homedir(), '.mimic-ai', 'builds');
          buildManifest.save(path.join(fallbackBuildsDir, 'last-build.json'));
          manifestWriteWarning = `Could not write the build manifest to the project directory (${err.message}). Saved to ${fallbackBuildsDir} instead.`;
        } catch (fallbackErr) {
          manifestWriteWarning = `Could not save the build manifest to disk (project dir: ${err.message}; fallback: ${fallbackErr.message}).`;
        }
      }

      const promotionSummary = promotions.length > 0
        ? ` ${promotions.length} component(s) auto-promoted to strong: ${promotions.join(', ')}.`
        : '';

      const ruleComplianceSummary = ruleViolations.length > 0
        ? ` ⚠ ${ruleViolations.length} rule violation(s).`
        : storedRules.length > 0
          ? ` All ${storedRules.length} rule(s) followed.`
          : '';

      const unusedMappedSummary = unusedMappedComponents.length > 0
        ? ` ⚠ ${unusedMappedComponents.length} mapped component(s) never used.`
        : '';

      const dsChangesSummary = staleRecipes.length > 0
        ? ` ${staleRecipes.length} DS change(s) detected (${staleRecipes.filter(r => r.reason === 'component_removed').length} removed, ${staleRecipes.filter(r => r.reason === 'variant_property_removed' || r.reason === 'variant_value_removed' || r.reason === 'needs_reverify').length} variant changes).`
        : '';

      return {
        reportPath,
        reportWriteWarning: reportWriteWarning || undefined,
        manifestWriteWarning: manifestWriteWarning || undefined,
        bindingFailureCount: bindingFailures.length,
        unoverriddenTextCount: unoverriddenCount,
        unusedMappedComponentCount: unusedMappedComponents.length,
        unusedMappedComponents: unusedMappedComponents.length > 0
          ? unusedMappedComponents.map(c => ({ componentName: c.componentName, elementType: c.elementType, componentKey: c.componentKey }))
          : undefined,
        componentUsagePercent,
        componentQualityGate,
        validationStatus,
        validationResults,
        promotions,
        ruleViolations: ruleViolations.length > 0 ? ruleViolations : undefined,
        rulesChecked: storedRules.length,
        recommendations,
        dsChanges: staleRecipes.length > 0 ? staleRecipes : undefined,
        regressionQuestions: regressionQuestions.length > 0 ? regressionQuestions : undefined,
        _presentationRules: [
          'Present the FULL build report to the user — components, primitives, binding quality, efficiency, DS CHANGES (stale recipes + impact), RECOMMENDATIONS (all of them), rule compliance, and DS gaps.',
          'The Recommendations section is the MOST IMPORTANT part of the report. It contains actionable suggestions: gap components to create, stale recipes to review, learning insights, and DS improvements. NEVER skip it.',
          'After the summary, OFFER to generate an HTML version: "Would you like the full report as an HTML file?"',
          'The report file is for persistence — the user must SEE the results in the conversation.',
        ],
        summary: `Build report for "${screenName}": ${totalInstances} DS component instances, ${primitives.length} primitives, ${componentUsagePercent}% component usage (${componentQualityGate}), ${toolCallCount} tool calls (${cacheHits} cached${replaySavings > 0 ? `, ${replaySavings} replayed` : ''}). ${gapEntries.length} DS gaps identified. ${recommendations.length} recommendation(s).${dsChangesSummary}${ruleComplianceSummary} ${bindingFailures.length > 0 ? `⚠ ${bindingFailures.length} nodes with binding failures.` : 'All DS bindings succeeded.'}${unoverriddenCount > 0 ? ` ⚠ ${unoverriddenCount} text node(s) not overridden.` : ''}${unusedMappedSummary} Structural validation: ${validationStatus}.${promotionSummary}${reportWriteWarning ? ` ⚠ ${reportWriteWarning}` : ''}${manifestWriteWarning ? ` ⚠ ${manifestWriteWarning}` : ''}`,
      };
    },
    {
      annotations: { title: 'Generate the build report', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      outputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-line human-readable summary of the whole build.' },
          reportPath: { type: 'string' },
          componentUsagePercent: { type: 'number' },
          componentQualityGate: { type: 'string' },
          bindingFailureCount: { type: 'number' },
          unoverriddenTextCount: { type: 'number' },
          recommendations: { type: 'array', items: { type: 'object' } },
          dsChanges: { type: 'array', items: { type: 'object' } },
          ruleViolations: { type: 'array', items: { type: 'object' } },
        },
        required: ['summary'],
      },
    }
  );

  // ── mimic_compute_chart ────────────────────────────────────────
  const calc = new ChartCalculator();

  registerTool(
    'mimic_compute_chart',
    'Computes chart geometry (bar positions, SVG paths, arc angles, grid lines, axis labels) from raw data WITHOUT building anything in Figma — pure math, no bridge/Figma calls, usable at any phase. Use when you need coordinates/paths to hand-build a chart yourself; use mimic_build_chart instead when you just want the finished chart created in one call. Supports chartType: bar, horizontalBar, donut, line, radar, scatter, heatmap. Params: chartType (required), data (required, points), dimensions (chart-type-specific sizing).',
    {
      type: 'object',
      properties: {
        chartType: {
          type: 'string',
          enum: ['bar', 'horizontalBar', 'donut', 'line', 'radar', 'scatter', 'heatmap'],
          description: 'The type of chart to compute.',
        },
        data: {
          type: 'array',
          description: 'Chart data points. Shape depends on chartType.',
        },
        dimensions: {
          type: 'object',
          description: 'Chart dimensions. Keys depend on chartType: chartHeight + optional chartWidth (bar), outerRadius/innerRadius (donut), plotWidth/plotHeight (line/scatter), radius/cx/cy (radar), cellWidth/cellHeight (heatmap). Optional: yPrefix (e.g. "$"), ySuffix (e.g. "%") for axis label formatting.',
        },
      },
      required: ['chartType', 'data', 'dimensions'],
    },
    async (args) => {
      const { chartType, data, dimensions } = args;

      let result;
      switch (chartType) {
        case 'bar':
          result = calc.bar({ data, chartHeight: dimensions.chartHeight, chartWidth: dimensions.chartWidth, barWidthRatio: dimensions.barWidthRatio, yPrefix: dimensions.yPrefix, ySuffix: dimensions.ySuffix });
          break;
        case 'horizontalBar':
          result = calc.horizontalBar({ data, chartWidth: dimensions.chartWidth, barHeight: dimensions.barHeight, barGap: dimensions.barGap, xPrefix: dimensions.xPrefix, xSuffix: dimensions.xSuffix });
          break;
        case 'donut':
          result = calc.donut({ data, outerRadius: dimensions.outerRadius, innerRadius: dimensions.innerRadius });
          break;
        case 'line':
          result = calc.line({ data, plotWidth: dimensions.plotWidth, plotHeight: dimensions.plotHeight, yPrefix: dimensions.yPrefix, ySuffix: dimensions.ySuffix });
          break;
        case 'radar':
          result = calc.radar({
            data,
            maxValue: dimensions.maxValue,
            radius: dimensions.radius,
            cx: dimensions.cx,
            cy: dimensions.cy,
            gridLevels: dimensions.gridLevels,
          });
          break;
        case 'scatter':
          result = calc.scatter({ data, plotWidth: dimensions.plotWidth, plotHeight: dimensions.plotHeight });
          break;
        case 'heatmap':
          result = calc.heatmap({ data, cellWidth: dimensions.cellWidth, cellHeight: dimensions.cellHeight });
          break;
        default:
          return { error: `Unknown chartType: ${chartType}` };
      }

      // ── Chart build rules ────────────────────────────────────────
      // These rules are returned with EVERY chart computation so the LLM
      // always knows the correct build approach — no knowledge store needed.
      result._chartColorHint = buildChartColorHint(dsCache);

      result._chartBuildRules = {
        preferNative: [
          'PREFER native Figma primitives over SVGs for charts. Bar charts, horizontal bars, and stacked bars work perfectly with auto-layout frames + rectangles.',
          'Bar charts: HORIZONTAL chart area (FILL, FIXED height) → individual bar rects with layoutSizingHorizontal=FILL so they distribute evenly across the container width. Each bar gets a fixed height proportional to its value, DS fill, and your DS\'s smallest corner-radius token (or a small raw radius if the DS has none). Labels row below with SPACE_BETWEEN alignment.',
          'Donut charts: NONE-direction frame (fixed WxH) with overlapping create_ellipse nodes using arcData (startingAngle, endingAngle, innerRadius 0-1 ratio). Legend as auto-layout below.',
          'Horizontal bars: per row HORIZONTAL frame (FILL, HUG) → label text (fixed width) + bar rectangle (fixed width proportional to value, 8px height, full/pill corner radius from your DS or a large raw radius if none exists).',
          'Rectangles ALWAYS respect width/height params. Use them for spacers, bars, and tracks — not frames.',
        ],
        lineCharts: [
          'CRITICAL: Line charts CANNOT use SVG <path stroke="..."> — Figma converts stroked paths into filled shapes, producing thick blobs instead of thin lines.',
          'Build line charts natively: NONE-direction frame (fixed plotWidth × plotHeight) containing:',
          '1. Grid lines: horizontal create_rectangle nodes (FILL width × 1px height, filled with your DS\'s border/divider color variable) positioned at each yAxis.ticks[].py',
          '2. Area fill (optional): a SINGLE SVG <path> using ONLY fill (rgba color, low opacity) — a closed polygon from data points down to the baseline. NO stroke attribute.',
          '3. Data line: a SINGLE SVG <path> with a THIN filled shape (2-3px thick ribbon) instead of stroke. Build the ribbon by offsetting the path ±1.5px vertically and closing it.',
          '4. Data points: create_ellipse at each point (6×6px, DS fill) positioned at px/py coordinates.',
          '5. Axis labels: native Figma text nodes OUTSIDE the chart frame (never inside SVGs).',
          'The area fill SVG must be a CLOSED path: trace all points left-to-right, then close via bottom-right corner → bottom-left corner → first point. Use fill="#hexcolor" opacity="0.15" and NO stroke.',
        ],
        donutLegend: [
          'CRITICAL: Donut/pie legends MUST use colored indicators — NEVER use ● characters in text nodes (they inherit text color, not segment color).',
          'Build each legend item as: HORIZONTAL frame (HUG, HUG, a small DS spacing gap, counterAxisAlignItems=CENTER) containing:',
          '1. Color dot: create_rectangle (8×8px, full/pill corner radius, fill bound to same DS color as the chart segment)',
          '2. Label text: native text node with DS text style and a tertiary/muted DS text color',
          'Wrap all legend items in a HORIZONTAL frame with a larger DS spacing gap between entries.',
        ],
        radarCharts: [
          'Radar charts have LIMITED fidelity in Figma because SVG strokes become filled shapes.',
          'Best approach: use a single SVG with ONLY filled polygons (no stroke). For the grid, use concentric filled polygons with DECREASING opacity (outermost=0.15, innermost=0.03). For data polygons, use filled shapes with low opacity (0.12-0.20).',
          'DO NOT use stroke="..." on any element — it produces thick filled outlines.',
          'DO NOT expect thin grid lines — they will render as thick bands. Accept the visual limitation or skip radar charts in favor of bar/horizontal bar alternatives.',
          'Axis labels: native Figma text nodes positioned outside the SVG frame.',
        ],
        svgFallback: [
          'Use SVGs ONLY for geometry that cannot be built with primitives (area fills, radar polygons, scatter plots).',
          'NEVER include <text> in SVGs — Figma creates tiny fixed-width text nodes that break.',
          'NEVER use stroke="..." in SVGs — Figma converts strokes to filled shapes. Use filled rectangles (<rect>) for lines, or filled thin shapes for curves.',
          'Use <rect height="1" fill="..."> for grid lines — produces clean 1px lines.',
          'After creation, bind ALL vector children to DS variables via figma_update_node (op: "fill").',
        ],
        antiPatterns: [
          'NEVER use stroke in SVGs — Figma renders stroked paths as thick filled outlines, not thin lines. This breaks line charts, radar grids, and any "outlined" shape.',
          'NEVER put text in SVGs — Figma renders them as stacked single characters with tiny widths.',
          'NEVER leave SVG vector children without DS fill bindings — breaks light/dark mode.',
          'NEVER use ● or other Unicode shapes in text nodes for chart legends — they cannot be individually colored. Use figma_create_shape (shape: "rectangle") for colored indicators.',
        ],
      };

      return result;
    },
    {
      annotations: { title: 'Compute chart geometry', readOnlyHint: true, idempotentHint: true },
    }
  );
}

module.exports = { register };
