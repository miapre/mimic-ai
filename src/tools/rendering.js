'use strict';

const fs = require('node:fs');
const path = require('node:path');

function register(server, context) {
  const { registerTool } = context;

  // ── mimic_pipeline_resolve ─────────────────────────────────────
  registerTool(
    'mimic_pipeline_resolve',
    'Classifies input as a URL, file path, or raw HTML and returns the resolved content.',
    {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'A URL, file path, or raw HTML string to classify and resolve.',
        },
      },
      required: ['input'],
    },
    async (args) => {
      const { input } = args;

      // URL detection
      if (/^https?:\/\//i.test(input)) {
        return { type: 'url', url: input };
      }

      // File path detection — check if it looks like a path and exists
      if (!input.includes('<') && !input.includes('>')) {
        const resolved = path.resolve(input);
        if (fs.existsSync(resolved)) {
          const content = fs.readFileSync(resolved, 'utf-8');
          return { type: 'file', content, path: resolved };
        }
      }

      // Default: treat as raw HTML
      return { type: 'html', content: input };
    }
  );

  // ── mimic_render_url ───────────────────────────────────────────
  registerTool(
    'mimic_render_url',
    'Placeholder for Puppeteer-based URL rendering. Currently returns instructions to provide HTML directly.',
    {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to render.',
        },
      },
      required: ['url'],
    },
    async (args) => {
      return {
        status: 'not_implemented',
        url: args.url,
        message: 'Puppeteer rendering is not yet implemented. Please provide the HTML content directly using mimic_pipeline_resolve with raw HTML or a local file path.',
      };
    }
  );
}

module.exports = { register };
