'use strict';

const { surfaceBindingFeedback } = require('../utils/binding-feedback');

const PHASE_HINT = 'Complete DS Discovery and Style Inventory first (call mimic_discover_ds → preload → figma_set_session_defaults).';

// Element names that likely have DS components.
// If create_frame is called with one of these, require an explicit primitive override.
const COMPONENT_FIRST_PATTERNS = [
  'header', 'footer', 'sidebar', 'sidenav', 'navigation', 'navbar',
  'top bar', 'bottom bar', 'nav bar', 'app bar',
  'button', 'input', 'textfield', 'text field',
  'tab', 'tabs', 'badge', 'chip', 'tag', 'pill',
];

function getComponentFirstMatch(name) {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return COMPONENT_FIRST_PATTERNS.find(p => lower.includes(p));
}

// Shell components — structural chrome that defines the app layout.
// These are NON-NEGOTIABLE: if the DS has them, use them. No primitive
// override allowed. The HTML layout for these is irrelevant — the DS
// component IS the canonical layout.
const SHELL_ELEMENTS = [
  'sidebar', 'sidenav',
];

// Section-level elements that MUST be searched via mimic_map_components
// before confirmedNoComponent is accepted. Generic layout names (like
// "header row" used as a simple alignment wrapper) are not section-level.
const SECTION_LEVEL_ELEMENTS = [
  ...SHELL_ELEMENTS,
  'footer', 'navigation', 'navbar',
  'top bar', 'bottom bar', 'nav bar', 'app bar', 'breadcrumb',
];

function isSectionLevel(match) {
  return SECTION_LEVEL_ELEMENTS.includes(match);
}

function checkComponentFirstGate(args, dsCache, session) {
  const match = getComponentFirstMatch(args?.name);
  if (!match) return null;

  // Auto-bypass when the selected library's components can't be imported (e.g. missing fonts).
  // Once a font error is detected, all component-first enforcement is moot — every insert will fail.
  if (dsCache && dsCache.libraryFontIncompatible) {
    return {
      allowed: true,
      match,
      warning: `Component-first gate auto-bypassed for "${args.name}" (${match}): library font incompatible — all components from this library fail to import.`,
    };
  }

  const confirmed = args.confirmedNoComponent === true;
  const reason = typeof args.primitiveOverrideReason === 'string'
    ? args.primitiveOverrideReason.trim()
    : '';

  if (confirmed && reason.length >= 12) {
    // Shell elements (sidebar, header, footer) are HARD-BLOCKED.
    // If the DS has them, use them. If not, mimic_map_components will
    // have returned a recommendation to create them. Either way,
    // building a primitive shell is never the right answer.
    const isShell = SHELL_ELEMENTS.includes(match);
    if (isShell) {
      const mapped = session?.componentMap?.requested || [];
      const wasSearched = mapped.some(t =>
        t.toLowerCase().includes(match) || match.includes(t.toLowerCase())
      );
      if (!wasSearched) {
        return {
          allowed: false,
          match,
          error: 'SHELL_COMPONENT_REQUIRED',
          message: `"${args?.name}" is a shell component ("${match}"). Shell components (sidebar, header, footer) must ALWAYS use DS components — the HTML layout is irrelevant. Call mimic_map_components with "${match}" first.`,
          recovery: {
            action: `Call mimic_map_components with elementTypes including "${match}". If the DS has a ${match} component, use it. If not, the tool will recommend creating one.`,
          },
        };
      }
      // Was searched and confirmed missing — allow with strong warning
      return {
        allowed: true,
        match,
        warning: `Shell component "${match}" not found in DS after search. Building as primitive. RECOMMENDATION: Create a ${match} component in your DS library for consistent app chrome across all screens.`,
        _shellMissing: true,
      };
    }

    // For other section-level elements, verify they were actually searched
    // via mimic_map_components before accepting the primitive override.
    if (isSectionLevel(match)) {
      const mapped = session?.componentMap?.requested || [];
      const wasSearched = mapped.some(t =>
        t.toLowerCase().includes(match) || match.includes(t.toLowerCase())
      );
      if (!wasSearched) {
        return {
          allowed: false,
          match,
          error: 'MAPPING_REQUIRED_FIRST',
          message: `"${args?.name}" is a section-level element ("${match}") that was never included in mimic_map_components. You must search for it before claiming no component exists.`,
          recovery: {
            action: `Call mimic_map_components with elementTypes including "${match}". If the search confirms no component exists, then retry with confirmedNoComponent: true.`,
          },
        };
      }
    }

    return {
      allowed: true,
      match,
      warning: `Primitive override accepted for "${args.name}" (${match}): ${reason}`,
    };
  }

  return {
    allowed: false,
    match,
    error: 'COMPONENT_FIRST_REQUIRED',
    message: `"${args?.name}" looks like a DS component candidate ("${match}"). Use mimic_map_components and figma_insert_component first. Only create a primitive frame if the DS/library search confirmed no component exists.`,
    recovery: {
      preferred: 'Use mimic_map_components with this element type, then figma_insert_component with the returned componentKey.',
      fallback: 'If no component exists after library search, retry figma_create_frame with confirmedNoComponent: true and primitiveOverrideReason explaining the gap.',
      minimumReasonLength: 12,
    },
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

async function resolvePageLevelPlacement(bridge, args) {
  if (args.parentId) return { args };

  const page = await bridge.send('get_page_nodes', {});
  const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
  const topLevelRects = nodes
    .filter(n => typeof n.x === 'number' && typeof n.y === 'number' && typeof n.width === 'number' && typeof n.height === 'number')
    .map(n => ({ ...n, right: n.x + n.width }));

  const rightmost = topLevelRects.length > 0
    ? Math.max(...topLevelRects.map(n => n.right))
    : -80;
  const suggestedX = rightmost + 80;
  const nextArgs = { ...args };
  if (typeof nextArgs.x !== 'number') {
    nextArgs.x = suggestedX;
  }
  if (typeof nextArgs.y !== 'number') {
    nextArgs.y = 0;
  }

  const proposed = {
    x: nextArgs.x,
    y: nextArgs.y,
    width: nextArgs.width || 100,
    height: nextArgs.height || 100,
  };
  const overlap = topLevelRects.find(n => rectsOverlap(proposed, n));
  if (overlap) {
    return {
      error: {
        error: 'ARTBOARD_OVERLAP',
        message: `"${args.name}" would overlap existing top-level node "${overlap.name}". Inspect page nodes and place new artboards to the right of the current canvas.`,
        overlappingNode: { id: overlap.id, name: overlap.name, x: overlap.x, y: overlap.y, width: overlap.width, height: overlap.height },
        suggestedX,
        suggestedY: 0,
        recovery: 'Retry figma_create_frame with x set to suggestedX, or omit x to auto-place to the right.',
      },
    };
  }

  return { args: nextArgs };
}

function register(server, context) {
  const { bridge, buildManifest, dsCache, session, requirePhase, advancePhase, registerTool } = context;

  // ── figma_create_frame ────────────────────────────────────────
  registerTool(
    'figma_create_frame',
    'Creates an auto-layout frame in Figma. All sizing uses DS variables when available. The name parameter should describe the HTML section or element role (e.g., "Header Section", "Metrics Row", "Card: Revenue"). Meaningful names enable iteration. IMPORTANT: Before creating frames for section-level elements (header, footer, sidebar), first check if the DS has a component for it via mimic_map_components or Figma MCP search_design_system.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Semantic name describing the HTML role (e.g., "Header Section", "Metrics Row", "Card: Revenue"). Never use generic names like "Frame".' },
        parentId: { type: 'string', description: 'Parent node ID. Omit for page-level.' },
        direction: { type: 'string', enum: ['HORIZONTAL', 'VERTICAL', 'NONE'], description: 'Auto-layout direction. Prefer HORIZONTAL or VERTICAL — NONE breaks portability. Use layoutPositioning ABSOLUTE for overlay children instead.' },
        layoutPositioning: { type: 'string', enum: ['AUTO', 'ABSOLUTE'], description: 'Set to ABSOLUTE to position this frame as an overlay inside an auto-layout parent (out of flow but still contained). Use for grid lines, positioned labels, etc.' },
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
        x: { type: 'number', description: 'X position in pixels. Required for page-level artboards. Use rightmost existing artboard x + width + 80.' },
        y: { type: 'number', description: 'Y position in pixels. Defaults to 0 for artboards.' },
        maxWidth: { type: 'number', description: 'Max width constraint.' },
        fillStyleId: { type: 'string', description: 'DS fill style key for background (from figma_list_fill_styles). Preferred over fillVariable when DS has fill styles but no variables.' },
        fill: { type: 'string', description: 'Raw hex color for background fill (e.g. "#ffffff"). Fallback when no DS styles/variables.' },
        stroke: { type: 'string', description: 'Raw hex color for stroke (e.g. "#e4e6ee"). Fallback when no DS stroke variables.' },
        strokeVariable: { type: 'string', description: 'DS variable path for stroke color.' },
        strokeWeight: { type: 'number', description: 'Stroke weight in pixels.' },
        cornerRadius: { type: 'number', description: 'Raw corner radius in pixels. Use cornerRadiusVariable when DS has radius variables.' },
        padding: { type: 'number', description: 'Raw uniform padding in pixels. Use paddingVariable when DS has spacing variables.' },
        paddingTop: { type: 'number', description: 'Raw top padding in pixels.' },
        paddingRight: { type: 'number', description: 'Raw right padding in pixels.' },
        paddingBottom: { type: 'number', description: 'Raw bottom padding in pixels.' },
        paddingLeft: { type: 'number', description: 'Raw left padding in pixels.' },
        gap: { type: 'number', description: 'Raw item spacing in pixels. Use gapVariable when DS has spacing variables.' },
        confirmedNoComponent: { type: 'boolean', description: 'Set true only after DS/library search confirms no component exists for this role.' },
        primitiveOverrideReason: { type: 'string', description: 'Required with confirmedNoComponent for component-like primitives. Explain why this frame must be custom.' },
      },
      required: ['name'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const componentGate = checkComponentFirstGate(args, dsCache, session);
      if (componentGate && !componentGate.allowed) {
        return componentGate;
      }

      // Warn on NONE direction — breaks auto-layout portability
      let noneWarning;
      if (args.direction === 'NONE') {
        noneWarning = 'direction: NONE breaks auto-layout portability. Use VERTICAL or HORIZONTAL with layoutPositioning: ABSOLUTE on overlay children instead.';
      }

      // Validate variable paths before sending to plugin
      const validation = dsCache.validateVariables(args);
      if (!validation.valid) {
        return {
          error: 'INVALID_VARIABLE_PATHS',
          warnings: validation.warnings,
          message: 'Fix the variable paths and try again. Do not proceed with invalid paths.',
        };
      }
      // Default page-level artboards (VERTICAL, no parent) to CENTER
      // counter-axis alignment so content containers center automatically.
      if (!args.parentId && (!args.counterAxisAlignItems) &&
          (!args.direction || args.direction === 'VERTICAL')) {
        args.counterAxisAlignItems = 'CENTER';
      }
      const placement = await resolvePageLevelPlacement(bridge, args);
      if (placement.error) return placement.error;
      const createArgs = placement.args;
      const result = await bridge.send('create_frame', createArgs);
      session.toolCallCount++;
      advancePhase(3);
      const nodeId = result?.nodeId || result?.id;
      // Record top-level sections (direct children of the artboard/content container)
      if (nodeId && createArgs.parentId) {
        buildManifest.addSection(createArgs.name || 'unnamed-frame', nodeId, 'frame');
      } else if (nodeId) {
        buildManifest.setArtboard(nodeId);
      }
      surfaceBindingFeedback(result, createArgs.name || 'create_frame');

      return {
        nodeId,
        ...result,
        _placement: !args.parentId ? { x: createArgs.x, y: createArgs.y } : undefined,
        _componentCheck: componentGate?.warning || undefined,
        _noneWarning: noneWarning || undefined,
        hint: noneWarning
          ? noneWarning
          : result?.bindingFailures
            ? 'Frame created but some DS bindings FAILED — check warnings above. Fix before continuing.'
            : 'Frame created. Add children with figma_create_text, figma_create_frame, or figma_insert_component.',
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
        textStyleId: { type: 'string', description: 'DS text style — accepts style name (e.g. "Text sm/Semibold") or style key. Names are resolved to keys automatically.' },
        fillStyleId: { type: 'string', description: 'DS fill style key for text color (from figma_list_fill_styles). Preferred over fillVariable when DS has fill styles but no variables.' },
        fillVariable: { type: 'string', description: 'DS variable path for text color.' },
        fontSizeVariable: { type: 'string', description: 'DS variable path for font size (if no text style).' },
        lineHeightVariable: { type: 'string', description: 'DS variable path for line height.' },
        layoutSizingHorizontal: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'Horizontal sizing mode.' },
        layoutPositioning: { type: 'string', enum: ['AUTO', 'ABSOLUTE'], description: 'Set to ABSOLUTE to overlay this text inside an auto-layout parent.' },
        width: { type: 'number', description: 'Fixed width for the text node.' },
        textAlignHorizontal: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'], description: 'Text alignment.' },
      },
      required: ['parentId', 'content'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      // Resolve text style name → key (accepts both "Text sm/Semibold" and raw key)
      if (args.textStyleId) {
        const resolvedKey = dsCache.resolveTextStyleKey(args.textStyleId);
        if (resolvedKey) {
          args.textStyleId = resolvedKey;
        }
        // If not resolved but cache has styles, it's likely a wrong name — warn but let plugin try
        // (the plugin may have it in its own styleCache from a previous preload)
      }
      // Validate variable paths before sending to plugin
      const validation = dsCache.validateVariables(args);
      if (!validation.valid) {
        return {
          error: 'INVALID_VARIABLE_PATHS',
          warnings: validation.warnings,
          message: 'Fix the variable paths and try again. Do not proceed with invalid paths.',
        };
      }
      const result = await bridge.send('create_text', args);
      session.toolCallCount++;
      advancePhase(3);
      surfaceBindingFeedback(result, args.name || 'create_text');
      return {
        nodeId: result?.nodeId || result?.id,
        ...result,
        hint: result?.bindingFailures
          ? 'Text node created but some DS bindings FAILED — check warnings. Text style or color variable may not be applied.'
          : 'Text node created.',
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
        fillStyleId: { type: 'string', description: 'DS fill style key (from figma_list_fill_styles).' },
        fillVariable: { type: 'string', description: 'DS variable path for fill color.' },
        fill: { type: 'string', description: 'Raw hex color for fill (e.g. "#e4e6ee"). Fallback when no DS styles/variables.' },
        cornerRadius: { type: 'number', description: 'Raw corner radius in pixels.' },
        cornerRadiusVariable: { type: 'string', description: 'DS variable path for corner radius.' },
        stroke: { type: 'string', description: 'Raw hex color for stroke. Fallback when no DS stroke variables.' },
        strokeVariable: { type: 'string', description: 'DS variable path for stroke color.' },
        strokeWeight: { type: 'number', description: 'Stroke weight in pixels.' },
        layoutPositioning: { type: 'string', enum: ['AUTO', 'ABSOLUTE'], description: 'Set to ABSOLUTE to overlay this rectangle inside an auto-layout parent (e.g., grid lines behind bars).' },
        layoutSizingHorizontal: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'Horizontal sizing mode. Auto-defaults to FIXED when width is specified.' },
        layoutSizingVertical: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'Vertical sizing mode. Auto-defaults to FIXED when height is specified.' },
      },
      required: ['parentId'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const validation = dsCache.validateVariables(args);
      if (!validation.valid) {
        return {
          error: 'INVALID_VARIABLE_PATHS',
          warnings: validation.warnings,
          message: 'Fix the variable paths and try again. Do not proceed with invalid paths.',
        };
      }
      const result = await bridge.send('create_rectangle', args);
      session.toolCallCount++;
      advancePhase(3);
      surfaceBindingFeedback(result, args.name || 'create_rectangle');
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
      const validation = dsCache.validateVariables(args);
      if (!validation.valid) {
        return {
          error: 'INVALID_VARIABLE_PATHS',
          warnings: validation.warnings,
          message: 'Fix the variable paths and try again. Do not proceed with invalid paths.',
        };
      }
      const result = await bridge.send('create_ellipse', args);
      session.toolCallCount++;
      advancePhase(3);
      surfaceBindingFeedback(result, args.name || 'create_ellipse');
      return {
        nodeId: result?.nodeId || result?.id,
        ...result,
      };
    }
  );

  // ── figma_create_svg ──────────────────────────────────────────
  registerTool(
    'figma_create_svg',
    'Creates a node from an SVG string in Figma. Useful for icons and custom graphics. Returns unboundChildren — a list of child nodes that need DS variable bindings. You MUST apply figma_set_node_fill to every unbound vector and figma_set_text_style + figma_set_node_fill to every unbound text. Leaving unbound children breaks DS compliance and light/dark mode.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Node name.' },
        parentId: { type: 'string', description: 'Parent node ID.' },
        svgString: { type: 'string', description: 'SVG markup string.' },
        fillVariable: { type: 'string', description: 'DS variable path for fill override (applied to ALL child vectors uniformly).' },
        strokeVariable: { type: 'string', description: 'DS variable path for stroke override.' },
        layoutSizingHorizontal: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'Horizontal sizing mode. Use FILL for charts inside auto-layout containers so they stretch to the container width.' },
        layoutSizingVertical: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'], description: 'Vertical sizing mode.' },
      },
      required: ['parentId', 'svgString'],
    },
    async (args) => {
      requirePhase(2, PHASE_HINT);
      const validation = dsCache.validateVariables(args);
      if (!validation.valid) {
        return {
          error: 'INVALID_VARIABLE_PATHS',
          warnings: validation.warnings,
          message: 'Fix the variable paths and try again. Do not proceed with invalid paths.',
        };
      }
      const result = await bridge.send('create_svg', args);
      session.toolCallCount++;
      advancePhase(3);
      surfaceBindingFeedback(result, args.name || 'create_svg');

      // ── Build mandatory binding checklist from unbound children ──
      const unboundChildren = result?.unboundChildren || [];
      const childSummary = result?.childSummary || {};
      const checklist = [];

      if (unboundChildren.length > 0) {
        const unboundVectors = unboundChildren.filter(c => c.type !== 'TEXT');
        const unboundTexts = unboundChildren.filter(c => c.type === 'TEXT');

        if (unboundVectors.length > 0) {
          checklist.push({
            action: 'BIND_VECTOR_FILLS',
            message: `${unboundVectors.length} vector node(s) have NO DS color variable. Apply figma_set_node_fill to each one. Grid lines → Colors/Border/border-secondary. Data elements → use palette from _chartColorHint.`,
            nodes: unboundVectors.map(v => ({ nodeId: v.nodeId, type: v.type, name: v.name })),
          });
        }

        if (unboundTexts.length > 0) {
          checklist.push({
            action: 'BIND_TEXT_STYLES',
            message: `${unboundTexts.length} text node(s) have NO DS bindings. Apply BOTH figma_set_node_fill (color variable) AND figma_set_text_style (DS text style) to each one. Fill alone is NOT enough — font properties are also hardcoded from SVG.`,
            nodes: unboundTexts.map(t => ({ nodeId: t.nodeId, name: t.name, characters: t.characters })),
          });
        }
      }

      return {
        nodeId: result?.nodeId || result?.id,
        ...result,
        configurationChecklist: checklist.length > 0 ? checklist : undefined,
        _bindingStatus: unboundChildren.length === 0
          ? '✓ All children have DS bindings.'
          : `⚠ ${unboundChildren.length} child node(s) need DS bindings. See configurationChecklist — this is MANDATORY.`,
      };
    }
  );
}

module.exports = { register, checkComponentFirstGate, getComponentFirstMatch };
