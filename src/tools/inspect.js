'use strict';

function register(server, context) {
  const { bridge, buildManifest, session, registerTool } = context;

  // ── figma_get_node_props ──────────────────────────────────────
  registerTool(
    'figma_get_node_props',
    'Returns comprehensive properties of a Figma node: type, size, layout, fills, strokes, text styles, variable bindings, and children count.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID to inspect.' },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('get_node_props', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_get_node_children ───────────────────────────────────
  registerTool(
    'figma_get_node_children',
    'Returns the children of a node up to the specified depth.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Parent node ID.' },
        depth: { type: 'number', description: 'How many levels deep to traverse. Default 1.' },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('get_node_children', { ...args, depth: args.depth ?? 1 });
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_get_node_parent ─────────────────────────────────────
  registerTool(
    'figma_get_node_parent',
    'Returns the parent node info for a given node.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID.' },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('get_node_parent', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_get_pages ───────────────────────────────────────────
  registerTool(
    'figma_get_pages',
    'Returns all pages in the current Figma file.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const result = await bridge.send('get_pages', {});
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_change_page ─────────────────────────────────────────
  registerTool(
    'figma_change_page',
    'Switches to a different page in the Figma file.',
    {
      type: 'object',
      properties: {
        pageName: { type: 'string', description: 'Page name to switch to.' },
        pageId: { type: 'string', description: 'Page ID to switch to. Takes precedence over pageName.' },
      },
      required: [],
    },
    async (args) => {
      const result = await bridge.send('change_page', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_get_page_nodes ──────────────────────────────────────
  registerTool(
    'figma_get_page_nodes',
    'Returns top-level nodes (artboards, frames) on the current page.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const result = await bridge.send('get_page_nodes', {});
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_get_component_variants ──────────────────────────────
  registerTool(
    'figma_get_component_variants',
    'Returns all variants for a component set.',
    {
      type: 'object',
      properties: {
        componentSetKey: { type: 'string', description: 'Component set key.' },
      },
      required: ['componentSetKey'],
    },
    async (args) => {
      const result = await bridge.send('get_component_variants', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_get_text_info ───────────────────────────────────────
  registerTool(
    'figma_get_text_info',
    'Returns detailed text information: content, style, font, color, variable bindings.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Text node ID.' },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('get_text_info', args);
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_get_selection ───────────────────────────────────────
  registerTool(
    'figma_get_selection',
    'Returns the currently selected nodes in Figma.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const result = await bridge.send('get_selection', {});
      session.toolCallCount++;
      return { ...result };
    }
  );

  // ── figma_select_node ─────────────────────────────────────────
  registerTool(
    'figma_select_node',
    'Selects a node in Figma and scrolls it into view.',
    {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID to select.' },
      },
      required: ['nodeId'],
    },
    async (args) => {
      const result = await bridge.send('select_node', args);
      session.toolCallCount++;
      return { ...result };
    }
  );
  // ── mimic_find_node ────────────────────────────────────────
  registerTool(
    'mimic_find_node',
    'Find a Figma node by its HTML section name from the last build. Returns the node ID and metadata if found, or lists available sections.',
    {
      type: 'object',
      properties: {
        sectionName: { type: 'string', description: 'The HTML section to find (e.g., "header", "metrics row", "table").' },
      },
      required: ['sectionName'],
    },
    async (args) => {
      const match = buildManifest.findBySection(args.sectionName);
      if (match) return { found: true, ...match };
      return { found: false, available: buildManifest.sections.map(s => s.htmlSection) };
    }
  );
}

module.exports = { register };
