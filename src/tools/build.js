'use strict';

const PHASE_HINT = 'Complete DS Discovery and Style Inventory first (call mimic_discover_ds → preload → figma_set_session_defaults).';

function register(server, context) {
  const { bridge, buildManifest, session, requirePhase, advancePhase, registerTool } = context;

  // ── figma_create_frame ────────────────────────────────────────
  registerTool(
    'figma_create_frame',
    'Creates an auto-layout frame in Figma. All sizing uses DS variables when available. The name parameter should describe the HTML section or element role (e.g., "Header Section", "Metrics Row", "Card: Revenue"). Meaningful names enable iteration.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Semantic name describing the HTML role (e.g., "Header Section", "Metrics Row", "Card: Revenue"). Never use generic names like "Frame".' },
        parentId: { type: 'string', description: 'Parent node ID. Omit for page-level.' },
        direction: { type: 'string', enum: ['HORIZONTAL', 'VERTICAL', 'NONE'], description: 'Auto-layout direction.' },
        width: { type: 'number', description: 'Fixed width in pixels.' },
        height: { type: 'number', description: 'Fixed height in pixels.' },
        layoutSizingHorizontal: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'Horizontal sizing mode.' },
        layoutSizingVertical: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'Vertical sizing mode.' },
        fillVariable: { type: 'string', description: 'DS variable path for background fill.' },
        paddingVariable: { type: 'string', description: 'DS variable path for uniform padding.' },
        paddingTopVariable: { type: 'string', description: 'DS variable path for top padding.' },
        paddingBottomVariable: { type: 'string', description: 'DS variable path for bottom padding.' },
        paddingLeftVariable: { type: 'string', description: 'DS variable path for left padding.' },
        paddingRightVariable: { type: 'string', description: 'DS variable path for right padding.' },
        gapVariable: { type: 'string', description: 'DS variable path for item spacing.' },
        cornerRadiusVariable: { type: 'string', description: 'DS variable path for corner radius.' },
        primaryAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'], description: 'Primary axis alignment.' },
        counterAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'BASELINE'], description: 'Counter axis alignment.' },
        clipsContent: { type: 'boolean', description: 'Clip content to frame bounds.' },
        maxWidth: { type: 'number', description: 'Max width constraint.' },
        strokeVariable: { type: 'string', description: 'DS variable path for stroke color.' },
        strokeWeight: { type: 'number', description: 'Stroke weight in pixels.' },
      },
      required: ['name'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('create_frame', args);
      session.toolCallCount++;
      advancePhase(3);
      const nodeId = result?.nodeId || result?.id;
      // Record top-level sections (direct children of the artboard/content container)
      if (nodeId && args.parentId) {
        buildManifest.addSection(args.name || 'unnamed-frame', nodeId, 'frame');
      }
      return {
        nodeId,
        ...result,
        hint: 'Frame created. Add children with figma_create_text, figma_create_frame, or figma_insert_component.',
      };
    }
  );

  // ── figma_create_text ─────────────────────────────────────────
  registerTool(
    'figma_create_text',
    'Creates a text node in Figma with DS text style and color variable. The name parameter should describe the HTML element role (e.g., "Page Title", "Card: Revenue Label", "Subtitle"). Meaningful names enable iteration.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Semantic name describing the HTML element role (e.g., "Page Title", "Card: Revenue Label", "Subtitle"). Never use generic names like "Text".' },
        parentId: { type: 'string', description: 'Parent node ID.' },
        content: { type: 'string', description: 'Text content.' },
        textStyleId: { type: 'string', description: 'DS text style key to apply.' },
        fillVariable: { type: 'string', description: 'DS variable path for text color.' },
        fontSizeVariable: { type: 'string', description: 'DS variable path for font size (if no text style).' },
        lineHeightVariable: { type: 'string', description: 'DS variable path for line height.' },
        layoutSizingHorizontal: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'Horizontal sizing mode.' },
        width: { type: 'number', description: 'Fixed width for the text node.' },
        textAlignHorizontal: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'], description: 'Text alignment.' },
      },
      required: ['parentId', 'content'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('create_text', args);
      session.toolCallCount++;
      advancePhase(3);
      return {
        nodeId: result?.nodeId || result?.id,
        ...result,
        hint: 'Text created. Ensure it has a DS text style and color variable applied.',
      };
    }
  );

  // ── figma_create_rectangle ────────────────────────────────────
  registerTool(
    'figma_create_rectangle',
    'Creates a rectangle node in Figma.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Node name.' },
        parentId: { type: 'string', description: 'Parent node ID.' },
        width: { type: 'number', description: 'Width in pixels.' },
        height: { type: 'number', description: 'Height in pixels.' },
        fillVariable: { type: 'string', description: 'DS variable path for fill color.' },
        cornerRadiusVariable: { type: 'string', description: 'DS variable path for corner radius.' },
        strokeVariable: { type: 'string', description: 'DS variable path for stroke color.' },
        strokeWeight: { type: 'number', description: 'Stroke weight in pixels.' },
      },
      required: ['parentId'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('create_rectangle', args);
      session.toolCallCount++;
      advancePhase(3);
      return {
        nodeId: result?.nodeId || result?.id,
        ...result,
      };
    }
  );

  // ── figma_create_ellipse ──────────────────────────────────────
  registerTool(
    'figma_create_ellipse',
    'Creates an ellipse node in Figma. Supports arcData for donut charts.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Node name.' },
        parentId: { type: 'string', description: 'Parent node ID.' },
        width: { type: 'number', description: 'Width in pixels.' },
        height: { type: 'number', description: 'Height in pixels.' },
        fillVariable: { type: 'string', description: 'DS variable path for fill color.' },
        arcData: {
          type: 'object',
          description: 'Arc data for donut/pie segments.',
          properties: {
            startingAngle: { type: 'number' },
            endingAngle: { type: 'number' },
            innerRadius: { type: 'number' },
          },
        },
      },
      required: ['parentId'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('create_ellipse', args);
      session.toolCallCount++;
      advancePhase(3);
      return {
        nodeId: result?.nodeId || result?.id,
        ...result,
      };
    }
  );

  // ── figma_create_svg ──────────────────────────────────────────
  registerTool(
    'figma_create_svg',
    'Creates a node from an SVG string in Figma. Useful for icons and custom graphics.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Node name.' },
        parentId: { type: 'string', description: 'Parent node ID.' },
        svgString: { type: 'string', description: 'SVG markup string.' },
        fillVariable: { type: 'string', description: 'DS variable path for fill override.' },
        strokeVariable: { type: 'string', description: 'DS variable path for stroke override.' },
      },
      required: ['parentId', 'svgString'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const result = await bridge.send('create_svg', args);
      session.toolCallCount++;
      advancePhase(3);
      return {
        nodeId: result?.nodeId || result?.id,
        ...result,
      };
    }
  );
}

module.exports = { register };
