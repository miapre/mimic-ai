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
      const {
        screenName,
        format = 'markdown',
        components = [],
        primitives = [],
        toolCallCount = session.toolCallCount,
        cacheHits = session.cacheHits,
      } = args;

      const totalInstances = components.reduce((sum, c) => sum + (c.instances || 0), 0);
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

      // Increment build count
      knowledgeStore.incrementBuildCount();
      knowledgeStore.save();

      return {
        reportPath,
        summary: `Build report for "${screenName}": ${totalInstances} DS component instances, ${primitives.length} primitives, ${toolCallCount} tool calls (${cacheHits} cached). ${gapEntries.length} DS gaps identified.`,
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
          description: 'Chart dimensions. Keys depend on chartType: chartHeight (bar), outerRadius/innerRadius (donut), plotWidth/plotHeight (line/scatter), radius/cx/cy (radar), cellWidth/cellHeight (heatmap).',
        },
      },
      required: ['chartType', 'data', 'dimensions'],
    },
    async (args) => {
      const { chartType, data, dimensions } = args;

      switch (chartType) {
        case 'bar':
          return calc.bar({ data, chartHeight: dimensions.chartHeight });
        case 'donut':
          return calc.donut({ data, outerRadius: dimensions.outerRadius, innerRadius: dimensions.innerRadius });
        case 'line':
          return calc.line({ data, plotWidth: dimensions.plotWidth, plotHeight: dimensions.plotHeight });
        case 'radar':
          return calc.radar({
            data,
            maxValue: dimensions.maxValue,
            radius: dimensions.radius,
            cx: dimensions.cx,
            cy: dimensions.cy,
            gridLevels: dimensions.gridLevels,
          });
        case 'scatter':
          return calc.scatter({ data, plotWidth: dimensions.plotWidth, plotHeight: dimensions.plotHeight });
        case 'heatmap':
          return calc.heatmap({ data, cellWidth: dimensions.cellWidth, cellHeight: dimensions.cellHeight });
        default:
          return { error: `Unknown chartType: ${chartType}` };
      }
    }
  );
}

module.exports = { register };
