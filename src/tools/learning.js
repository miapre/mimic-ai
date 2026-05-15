'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ChartCalculator } = require('../charts/calculator');

function register(server, context) {
  const { registerTool, knowledgeStore, buildManifest, dsCache, session, advancePhase } = context;

  // ── mimic_ai_knowledge_read ────────────────────────────────────
  registerTool(
    'mimic_ai_knowledge_read',
    'Loads and returns the full knowledge store contents: components, patterns, gaps, and meta.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      knowledgeStore.load();
      return {
        components: knowledgeStore.data.components,
        patterns: knowledgeStore.data.patterns,
        gaps: knowledgeStore.data.gaps,
        meta: knowledgeStore.data.meta,
      };
    }
  );

  // ── mimic_ai_knowledge_write ───────────────────────────────────
  registerTool(
    'mimic_ai_knowledge_write',
    'Saves a pattern, component recipe, or DS gap to the knowledge store.',
    {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['component', 'pattern', 'gap'],
          description: 'Type of knowledge entry to save.',
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

      switch (type) {
        case 'component':
          knowledgeStore.setComponent(id, data);
          break;
        case 'pattern':
          knowledgeStore.setPattern(id, data);
          break;
        case 'gap':
          knowledgeStore.addGap(id, data);
          break;
        default:
          return { error: `Unknown type: ${type}. Use component, pattern, or gap.` };
      }

      knowledgeStore.save();
      return { ok: true, type, id };
    }
  );

  // ── mimic_generate_build_report ────────────────────────────────
  registerTool(
    'mimic_generate_build_report',
    'Compiles build session data into a structured report (markdown or HTML). Advances phase to 5.',
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
            },
          },
          description: 'DS components used in the build.',
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

      // Build markdown report
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

      // Binding failures (from session tracking)
      const bindingFailures = session.bindingFailures || [];
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
          lines.push('**Recovery:** Call `figma_read_variable_values` to verify cached variable paths. The variable may not be preloaded, or the path may be wrong.');
          lines.push('');
        }
      } else {
        lines.push('## DS Binding Quality: All bindings succeeded');
        lines.push('');
      }

      lines.push(`## Efficiency: ${toolCallCount} tool calls (${cacheHits} from cache)`);
      lines.push('');

      lines.push('## DS Gap Recommendations');
      lines.push('');
      if (gapEntries.length > 0) {
        gapEntries.forEach(([name, gap]) => {
          lines.push(`- **${name}**: ${gap.elements ? gap.elements.join(', ') : 'N/A'}`);
          if (gap.evidence) lines.push(`  - Evidence: ${gap.evidence}`);
          if (gap.estimatedSavings) lines.push(`  - Estimated savings: ${gap.estimatedSavings}`);
        });
      } else {
        lines.push('No DS gaps identified.');
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

      const reportContent = lines.join('\n');

      // Save report file
      const reportsDir = path.join(process.cwd(), 'mimic', 'reports');
      if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
      }
      const safeName = screenName.replace(/[^a-zA-Z0-9_-]/g, '-');
      const reportPath = path.join(reportsDir, `build-${date}-${safeName}.md`);
      fs.writeFileSync(reportPath, reportContent, 'utf-8');

      // Save build manifest
      const buildsDir = path.join(process.cwd(), 'mimic', 'builds');
      if (!fs.existsSync(buildsDir)) fs.mkdirSync(buildsDir, { recursive: true });
      buildManifest.save(path.join(buildsDir, 'last-build.json'));

      // Advance phase to 5 (report)
      advancePhase(5);

      // ── Persist learning data ──────────────────────────────────
      // Auto-save component usage as recipes (name + instances + keys if available)
      for (const comp of components) {
        const existing = knowledgeStore.getComponent(comp.name);
        const recipe = existing
          ? { ...existing, instances: (existing.instances || 0) + (comp.instances || 0), buildCount: (existing.buildCount || 0) + 1 }
          : { instances: comp.instances || 0, buildCount: 1, componentKey: comp.componentKey || null, variantConfig: comp.variantConfig || null };
        knowledgeStore.setComponent(comp.name, recipe);
      }

      // Auto-save primitives as DS gaps with evidence
      for (const prim of primitives) {
        if (prim.reason && prim.reason.length >= 10) {
          knowledgeStore.addGap(prim.element, {
            elements: [prim.element],
            evidence: `${prim.reason}. Screen: ${screenName}`,
            estimatedSavings: `~7 tool calls per instance if DS component existed`,
            searchTerms: prim.searchTerms || [],
          });
        }
      }

      // Increment build count
      knowledgeStore.incrementBuildCount();
      knowledgeStore.save();

      return {
        reportPath,
        bindingFailureCount: bindingFailures.length,
        componentUsagePercent,
        componentQualityGate,
        summary: `Build report for "${screenName}": ${totalInstances} DS component instances, ${primitives.length} primitives, ${componentUsagePercent}% component usage (${componentQualityGate}), ${toolCallCount} tool calls (${cacheHits} cached). ${gapEntries.length} DS gaps identified. ${bindingFailures.length > 0 ? `⚠ ${bindingFailures.length} nodes with binding failures.` : 'All DS bindings succeeded.'}`,
      };
    }
  );

  // ── mimic_generate_design_md ───────────────────────────────────
  registerTool(
    'mimic_generate_design_md',
    'Compiles current DS knowledge into DESIGN.md format. Returns the content as a string.',
    { type: 'object', properties: {}, required: [] },
    async () => {
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

      return { content: lines.join('\n') };
    }
  );

  // ── mimic_compute_chart ────────────────────────────────────────
  const calc = new ChartCalculator();

  registerTool(
    'mimic_compute_chart',
    'Takes chart data and returns pre-computed geometry for building in Figma. Supports bar, donut, line, radar, scatter, and heatmap.',
    {
      type: 'object',
      properties: {
        chartType: {
          type: 'string',
          enum: ['bar', 'donut', 'line', 'radar', 'scatter', 'heatmap'],
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
      result._chartColorHint = {
        message: 'After creating this chart with figma_create_svg, check the configurationChecklist in the response — it lists every unbound child node that MUST receive DS variable bindings. Pass layoutSizingHorizontal: "FILL" to figma_create_svg so the chart stretches to the container width.',
        suggestedPalette: [
          'Component colors/Utility/Brand/utility-brand-500',
          'Component colors/Utility/Success/utility-success-500',
          'Component colors/Utility/Warning/utility-warning-500',
          'Component colors/Utility/Error/utility-error-500',
          'Component colors/Utility/Indigo/utility-indigo-500',
          'Component colors/Utility/Purple/utility-purple-500',
          'Component colors/Utility/Blue/utility-blue-500',
          'Component colors/Utility/Orange/utility-orange-500',
        ],
        gridColor: 'Colors/Border/border-secondary',
        labelColor: 'Colors/Text/text-tertiary (600)',
        dataLabelStyle: 'Text xs/Medium',
      };

      result._chartBuildRules = {
        preferNative: [
          'PREFER native Figma primitives over SVGs for charts. Bar charts, horizontal bars, and stacked bars work perfectly with auto-layout frames + rectangles.',
          'Bar charts: HORIZONTAL chart area (FILL, FIXED height) → individual bar rects with layoutSizingHorizontal=FILL so they distribute evenly across the container width. Each bar gets a fixed height proportional to its value, DS fill, radius-xs. Labels row below with SPACE_BETWEEN alignment.',
          'Donut charts: NONE-direction frame (fixed WxH) with overlapping create_ellipse nodes using arcData (startingAngle, endingAngle, innerRadius 0-1 ratio). Legend as auto-layout below.',
          'Horizontal bars: per row HORIZONTAL frame (FILL, HUG) → label text (fixed width) + bar rectangle (fixed width proportional to value, 8px height, radius-full).',
          'Rectangles ALWAYS respect width/height params. Use them for spacers, bars, and tracks — not frames.',
        ],
        lineCharts: [
          'CRITICAL: Line charts CANNOT use SVG <path stroke="..."> — Figma converts stroked paths into filled shapes, producing thick blobs instead of thin lines.',
          'Build line charts natively: NONE-direction frame (fixed plotWidth × plotHeight) containing:',
          '1. Grid lines: horizontal create_rectangle nodes (FILL width × 1px height, border-secondary fill) positioned at each yAxis.ticks[].py',
          '2. Area fill (optional): a SINGLE SVG <path> using ONLY fill (rgba color, low opacity) — a closed polygon from data points down to the baseline. NO stroke attribute.',
          '3. Data line: a SINGLE SVG <path> with a THIN filled shape (2-3px thick ribbon) instead of stroke. Build the ribbon by offsetting the path ±1.5px vertically and closing it.',
          '4. Data points: create_ellipse at each point (6×6px, DS fill) positioned at px/py coordinates.',
          '5. Axis labels: native Figma text nodes OUTSIDE the chart frame (never inside SVGs).',
          'The area fill SVG must be a CLOSED path: trace all points left-to-right, then close via bottom-right corner → bottom-left corner → first point. Use fill="#hexcolor" opacity="0.15" and NO stroke.',
        ],
        donutLegend: [
          'CRITICAL: Donut/pie legends MUST use colored indicators — NEVER use ● characters in text nodes (they inherit text color, not segment color).',
          'Build each legend item as: HORIZONTAL frame (HUG, HUG, gap=spacing-xs, counterAxisAlignItems=CENTER) containing:',
          '1. Color dot: create_rectangle (8×8px, radius-full, fill bound to same DS color as the chart segment)',
          '2. Label text: native text node with DS text style and text-tertiary color',
          'Wrap all legend items in a HORIZONTAL frame with gap=spacing-xl.',
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
          'After creation, bind ALL vector children to DS variables via figma_set_node_fill.',
        ],
        antiPatterns: [
          'NEVER use stroke in SVGs — Figma renders stroked paths as thick filled outlines, not thin lines. This breaks line charts, radar grids, and any "outlined" shape.',
          'NEVER put text in SVGs — Figma renders them as stacked single characters with tiny widths.',
          'NEVER leave SVG vector children without DS fill bindings — breaks light/dark mode.',
          'NEVER use ● or other Unicode shapes in text nodes for chart legends — they cannot be individually colored. Use create_rectangle or create_ellipse for colored indicators.',
        ],
      };

      return result;
    }
  );
}

module.exports = { register };
