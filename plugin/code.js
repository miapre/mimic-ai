// Mimic AI — Figma Plugin (v2)
// Thin execution layer. Receives messages via WebSocket (relayed through ui.html),
// executes Figma Plugin API calls, returns results.
// Runs inside Figma's sandbox — no require(), no import, no Node.js APIs.

// ── State ──────────────────────────────────────────────────────────────────────

var enforcementProfile = {
  enforceTextStyles: false,
  enforceColorVars: false,
  enforceSpacingVars: false,
  enforceRadiusVars: false,
};

/** @type {Map<string, TextStyle>} key → imported TextStyle */
var styleCache = new Map();

/** @type {Map<string, Variable>} variable path → Variable object */
var variableCache = new Map();

// ── Enforcement Gate ───────────────────────────────────────────────────────────

function enforceText(params) {
  if (!enforcementProfile.enforceTextStyles) return;
  if (params.textStyleId || params.fontSizeVariable) return;

  // Collect available style names for recovery hint
  var available = [];
  styleCache.forEach(function (style, key) {
    available.push(style.name);
  });

  throw {
    error: 'DS_REQUIRED',
    property: 'textStyle',
    message: 'Text style or typography variable required when enforceTextStyles is active.',
    available: available.slice(0, 20),
    recovery: 'Provide textStyleId (from figma_list_text_styles) or fontSizeVariable (DS typography variable path).',
  };
}

function enforceColorFill(params, nodeType) {
  if (!enforcementProfile.enforceColorVars) return;
  // Only enforce if a fill was explicitly requested
  var hasFillRequest = params.fill || params.fillHex || params.fillColor;
  if (!hasFillRequest) return;
  if (params.fillVariable) return;

  throw {
    error: 'DS_REQUIRED',
    property: 'fill',
    message: 'DS color variable required for fills when enforceColorVars is active. Node type: ' + nodeType,
    available: [],
    recovery: 'Provide fillVariable (DS color variable path) instead of raw fill/fillHex.',
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getVariableByPath(path) {
  if (!path) return null;

  // Check cache first
  var cached = variableCache.get(path);
  if (cached) return cached;

  // Search local collections
  var collections = figma.variables.getLocalVariableCollections();
  for (var c = 0; c < collections.length; c++) {
    var col = collections[c];
    var varIds = col.variableIds;
    for (var v = 0; v < varIds.length; v++) {
      var variable = figma.variables.getVariableById(varIds[v]);
      if (variable && variable.name === path) {
        variableCache.set(path, variable);
        return variable;
      }
    }
  }

  return null;
}

function bindVariable(node, prop, varPath) {
  if (!varPath) return false;
  var variable = getVariableByPath(varPath);
  if (!variable) return false;

  try {
    node.setBoundVariable(prop, variable);
    return true;
  } catch (e) {
    return false;
  }
}

function bindFillVariable(node, varPath) {
  if (!varPath) return false;
  var variable = getVariableByPath(varPath);
  if (!variable) return false;

  try {
    var solidPaint = figma.variables.setBoundVariableForPaint(
      { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 },
      'color',
      variable
    );
    node.fills = [solidPaint];
    return true;
  } catch (e) {
    return false;
  }
}

function bindStrokeVariable(node, varPath) {
  if (!varPath) return false;
  var variable = getVariableByPath(varPath);
  if (!variable) return false;

  try {
    var solidPaint = figma.variables.setBoundVariableForPaint(
      { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 },
      'color',
      variable
    );
    node.strokes = [solidPaint];
    return true;
  } catch (e) {
    return false;
  }
}

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  var r = parseInt(hex.substring(0, 2), 16) / 255;
  var g = parseInt(hex.substring(2, 4), 16) / 255;
  var b = parseInt(hex.substring(4, 6), 16) / 255;
  return { r: r, g: g, b: b };
}

function applySolidFill(node, hex) {
  var rgb = hexToRgb(hex);
  node.fills = [{ type: 'SOLID', color: rgb }];
}

function normalizeNodeId(id) {
  if (typeof id === 'string') {
    return id.replace(/-/g, ':');
  }
  return id;
}

function getParent(parentId) {
  if (!parentId) return figma.currentPage;
  var parent = figma.getNodeById(normalizeNodeId(parentId));
  if (!parent) {
    throw {
      error: 'NODE_NOT_FOUND',
      property: 'parentId',
      message: 'Parent node not found: ' + parentId,
      available: [],
      recovery: 'Check that parentId is valid and the node exists on the current page.',
    };
  }
  return parent;
}

// Walk an instance tree and collect text nodes + boolean properties for configuration hints
function collectConfigurationHints(instance) {
  var textNodes = [];
  var booleanProperties = {};
  var iconSlots = [];

  // Walk the instance to find overridable text and boolean props
  function walk(node) {
    if (node.type === 'TEXT') {
      textNodes.push({
        nodeId: node.id,
        name: node.name,
        characters: node.characters || '',
      });
    }
    if (node.type === 'INSTANCE' && node.name.toLowerCase().indexOf('icon') !== -1) {
      iconSlots.push({
        nodeId: node.id,
        name: node.name,
        visible: node.visible,
      });
    }
    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) {
        walk(node.children[i]);
      }
    }
  }

  walk(instance);

  // Collect boolean properties from component properties
  try {
    var props = instance.componentProperties;
    if (props) {
      var keys = Object.keys(props);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var prop = props[key];
        if (prop.type === 'BOOLEAN') {
          booleanProperties[key] = prop.value;
        }
      }
    }
  } catch (e) {
    // Not all instances expose componentProperties
  }

  return {
    textNodes: textNodes,
    booleanProperties: booleanProperties,
    iconSlots: iconSlots,
  };
}

// ── Handlers ───────────────────────────────────────────────────────────────────

var handlers = {};

// ── Core (Task 8) ──────────────────────────────────────────────────────────────

handlers.ping = function (payload) {
  return { status: 'ok' };
};

handlers.get_plugin_status = function (payload) {
  var page = figma.currentPage;
  var root = figma.root;
  return {
    fileName: root.name,
    currentPage: {
      id: page.id,
      name: page.name,
    },
    enforcementProfile: enforcementProfile,
  };
};

handlers.set_session_defaults = function (payload) {
  // Update enforcement profile
  if (payload.enforcementProfile) {
    var ep = payload.enforcementProfile;
    if (typeof ep.enforceTextStyles === 'boolean') enforcementProfile.enforceTextStyles = ep.enforceTextStyles;
    if (typeof ep.enforceColorVars === 'boolean') enforcementProfile.enforceColorVars = ep.enforceColorVars;
    if (typeof ep.enforceSpacingVars === 'boolean') enforcementProfile.enforceSpacingVars = ep.enforceSpacingVars;
    if (typeof ep.enforceRadiusVars === 'boolean') enforcementProfile.enforceRadiusVars = ep.enforceRadiusVars;
  }

  // Preload text styles if requested
  var preloadedStyles = 0;
  if (payload.textStyleKeys && Array.isArray(payload.textStyleKeys)) {
    for (var i = 0; i < payload.textStyleKeys.length; i++) {
      var key = payload.textStyleKeys[i];
      try {
        var style = figma.getStyleById(key);
        if (style && style.type === 'TEXT') {
          styleCache.set(key, style);
          preloadedStyles++;
        }
      } catch (e) {
        // Style not found, skip
      }
    }
  }

  // Preload variables if paths provided
  var preloadedVars = 0;
  if (payload.variablePaths && Array.isArray(payload.variablePaths)) {
    for (var i = 0; i < payload.variablePaths.length; i++) {
      var v = getVariableByPath(payload.variablePaths[i]);
      if (v) preloadedVars++;
    }
  }

  return {
    enforcementProfile: enforcementProfile,
    preloadedStyles: preloadedStyles,
    preloadedVars: preloadedVars,
    styleCacheSize: styleCache.size,
    variableCacheSize: variableCache.size,
  };
};

handlers.create_frame = function (payload) {
  var parent = getParent(payload.parentId);
  var frame = figma.createFrame();

  // Name
  frame.name = payload.name || 'Frame';

  // Auto-layout is ALWAYS on
  frame.layoutMode = payload.direction || 'VERTICAL';

  // Alignment
  if (payload.primaryAxisAlignItems) frame.primaryAxisAlignItems = payload.primaryAxisAlignItems;
  if (payload.counterAxisAlignItems) frame.counterAxisAlignItems = payload.counterAxisAlignItems;

  // Sizing
  frame.layoutSizingHorizontal = payload.layoutSizingHorizontal || 'HUG';
  frame.layoutSizingVertical = payload.layoutSizingVertical || 'HUG';

  // Fixed dimensions (for artboards)
  if (payload.width) frame.resize(payload.width, payload.height || 100);
  if (payload.minWidth) frame.minWidth = payload.minWidth;
  if (payload.maxWidth) frame.maxWidth = payload.maxWidth;
  if (payload.minHeight) frame.minHeight = payload.minHeight;
  if (payload.maxHeight) frame.maxHeight = payload.maxHeight;

  // Clip
  if (typeof payload.clipsContent === 'boolean') frame.clipsContent = payload.clipsContent;

  // Position
  if (typeof payload.x === 'number') frame.x = payload.x;
  if (typeof payload.y === 'number') frame.y = payload.y;

  // ── DS Variable Bindings ──

  // Gap (spacing)
  if (payload.gapVariable) {
    bindVariable(frame, 'itemSpacing', payload.gapVariable);
  } else if (typeof payload.gap === 'number') {
    frame.itemSpacing = payload.gap;
  }

  // Padding (spacing variables)
  if (payload.paddingTopVariable) {
    bindVariable(frame, 'paddingTop', payload.paddingTopVariable);
  } else if (typeof payload.paddingTop === 'number') {
    frame.paddingTop = payload.paddingTop;
  }

  if (payload.paddingRightVariable) {
    bindVariable(frame, 'paddingRight', payload.paddingRightVariable);
  } else if (typeof payload.paddingRight === 'number') {
    frame.paddingRight = payload.paddingRight;
  }

  if (payload.paddingBottomVariable) {
    bindVariable(frame, 'paddingBottom', payload.paddingBottomVariable);
  } else if (typeof payload.paddingBottom === 'number') {
    frame.paddingBottom = payload.paddingBottom;
  }

  if (payload.paddingLeftVariable) {
    bindVariable(frame, 'paddingLeft', payload.paddingLeftVariable);
  } else if (typeof payload.paddingLeft === 'number') {
    frame.paddingLeft = payload.paddingLeft;
  }

  // Shorthand padding (all sides same)
  if (payload.paddingVariable) {
    bindVariable(frame, 'paddingTop', payload.paddingVariable);
    bindVariable(frame, 'paddingRight', payload.paddingVariable);
    bindVariable(frame, 'paddingBottom', payload.paddingVariable);
    bindVariable(frame, 'paddingLeft', payload.paddingVariable);
  } else if (typeof payload.padding === 'number') {
    frame.paddingTop = payload.padding;
    frame.paddingRight = payload.padding;
    frame.paddingBottom = payload.padding;
    frame.paddingLeft = payload.padding;
  }

  // Fill (color variable)
  if (payload.fillVariable) {
    bindFillVariable(frame, payload.fillVariable);
  } else if (payload.fill) {
    applySolidFill(frame, payload.fill);
  } else {
    // Default: no fill (transparent)
    frame.fills = [];
  }

  // Stroke
  if (payload.strokeVariable) {
    bindStrokeVariable(frame, payload.strokeVariable);
    if (typeof payload.strokeWeight === 'number') frame.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) frame.strokeAlign = payload.strokeAlign;
  } else if (payload.stroke) {
    var strokeRgb = hexToRgb(payload.stroke);
    frame.strokes = [{ type: 'SOLID', color: strokeRgb }];
    if (typeof payload.strokeWeight === 'number') frame.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) frame.strokeAlign = payload.strokeAlign;
  }

  // Corner radius (radius variable)
  if (payload.cornerRadiusVariable) {
    bindVariable(frame, 'topLeftRadius', payload.cornerRadiusVariable);
    bindVariable(frame, 'topRightRadius', payload.cornerRadiusVariable);
    bindVariable(frame, 'bottomLeftRadius', payload.cornerRadiusVariable);
    bindVariable(frame, 'bottomRightRadius', payload.cornerRadiusVariable);
  } else if (typeof payload.cornerRadius === 'number') {
    frame.cornerRadius = payload.cornerRadius;
  }

  // Individual corner radii
  if (payload.topLeftRadiusVariable) bindVariable(frame, 'topLeftRadius', payload.topLeftRadiusVariable);
  if (payload.topRightRadiusVariable) bindVariable(frame, 'topRightRadius', payload.topRightRadiusVariable);
  if (payload.bottomLeftRadiusVariable) bindVariable(frame, 'bottomLeftRadius', payload.bottomLeftRadiusVariable);
  if (payload.bottomRightRadiusVariable) bindVariable(frame, 'bottomRightRadius', payload.bottomRightRadiusVariable);

  // Wrap
  if (payload.layoutWrap) frame.layoutWrap = payload.layoutWrap;

  // Append to parent
  parent.appendChild(frame);

  return {
    nodeId: frame.id,
    name: frame.name,
    type: 'FRAME',
  };
};

handlers.create_text = function (payload) {
  // Enforcement gates
  enforceText(payload);
  enforceColorFill(payload, 'TEXT');

  var parent = getParent(payload.parentId);
  var text = figma.createText();

  text.name = payload.name || 'Text';

  // Apply text style if provided (must happen before setting content)
  var styleApplied = false;
  if (payload.textStyleId) {
    try {
      var style = styleCache.get(payload.textStyleId) || figma.getStyleById(payload.textStyleId);
      if (style && style.type === 'TEXT') {
        text.textStyleId = style.id;
        styleApplied = true;
      }
    } catch (e) {
      // Style not available
    }
  }

  // If no text style, try loading font for manual typography
  if (!styleApplied) {
    // Load the font before setting characters
    var fontFamily = payload.fontFamily || 'Inter';
    var fontStyle = payload.fontStyle || 'Regular';
    try {
      figma.loadFontAsync({ family: fontFamily, style: fontStyle }).then(function () {
        // Font loaded — this is async but we handle it synchronously in the plugin context
      });
    } catch (e) {
      // If font loading fails, try Inter Regular as fallback
    }
  }

  // Set content
  if (payload.characters || payload.content) {
    text.characters = payload.characters || payload.content || '';
  }

  // Typography variable bindings (fontSize, lineHeight, letterSpacing)
  if (payload.fontSizeVariable) bindVariable(text, 'fontSize', payload.fontSizeVariable);
  if (payload.lineHeightVariable) bindVariable(text, 'lineHeight', payload.lineHeightVariable);
  if (payload.letterSpacingVariable) bindVariable(text, 'letterSpacing', payload.letterSpacingVariable);

  // Fill (text color)
  if (payload.fillVariable) {
    bindFillVariable(text, payload.fillVariable);
  } else if (payload.fill) {
    applySolidFill(text, payload.fill);
  }

  // Sizing
  text.layoutSizingHorizontal = payload.layoutSizingHorizontal || 'HUG';
  text.layoutSizingVertical = payload.layoutSizingVertical || 'HUG';

  // Text auto-resize
  if (payload.textAutoResize) text.textAutoResize = payload.textAutoResize;

  // Truncation
  if (payload.textTruncation) text.textTruncation = payload.textTruncation;
  if (typeof payload.maxLines === 'number') text.maxLines = payload.maxLines;

  // Alignment
  if (payload.textAlignHorizontal) text.textAlignHorizontal = payload.textAlignHorizontal;
  if (payload.textAlignVertical) text.textAlignVertical = payload.textAlignVertical;

  // Append to parent
  parent.appendChild(text);

  return {
    nodeId: text.id,
    name: text.name,
    type: 'TEXT',
    characters: text.characters,
    styleApplied: styleApplied,
  };
};

handlers.insert_component = function (payload) {
  if (!payload.componentKey) {
    throw {
      error: 'MISSING_PARAM',
      property: 'componentKey',
      message: 'componentKey is required to insert a component.',
      available: [],
      recovery: 'Provide the component key from DS discovery.',
    };
  }

  var parent = getParent(payload.parentId);

  // Import by key (async in Figma API)
  var component = figma.importComponentByKeyAsync(payload.componentKey);

  // importComponentByKeyAsync returns a promise — Figma plugin sandbox supports top-level await style
  // but we handle it via the async dispatcher below
  return component.then(function (imported) {
    var instance = imported.createInstance();
    instance.name = payload.name || imported.name;

    // Set to HUG by default
    instance.layoutSizingHorizontal = payload.layoutSizingHorizontal || 'HUG';
    instance.layoutSizingVertical = payload.layoutSizingVertical || 'HUG';

    // Position
    if (typeof payload.x === 'number') instance.x = payload.x;
    if (typeof payload.y === 'number') instance.y = payload.y;

    // Append to parent
    parent.appendChild(instance);

    // Collect configuration hints
    var hints = collectConfigurationHints(instance);

    return {
      nodeId: instance.id,
      name: instance.name,
      type: 'INSTANCE',
      componentName: imported.name,
      componentKey: payload.componentKey,
      configurationHints: hints,
    };
  });
};

// ── Stubs for Task 9 — Shape creation ──────────────────────────────────────────

handlers.create_rectangle = function (payload) {
  // TODO: Task 9 — create rectangle with DS fill/stroke/radius variable bindings
  throw { error: 'NOT_IMPLEMENTED', property: 'create_rectangle', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.create_ellipse = function (payload) {
  // TODO: Task 9 — create ellipse with DS fill/stroke variable bindings
  throw { error: 'NOT_IMPLEMENTED', property: 'create_ellipse', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.create_svg = function (payload) {
  // TODO: Task 9 — create SVG node from string
  throw { error: 'NOT_IMPLEMENTED', property: 'create_svg', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

// ── Stubs for Task 9 — Edit handlers ───────────────────────────────────────────

handlers.set_component_text = function (payload) {
  // TODO: Task 9 — set text override on a component instance child
  throw { error: 'NOT_IMPLEMENTED', property: 'set_component_text', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.set_variant = function (payload) {
  // TODO: Task 9 — change variant property on an instance
  throw { error: 'NOT_IMPLEMENTED', property: 'set_variant', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.set_text = function (payload) {
  // TODO: Task 9 — set characters on an existing text node
  throw { error: 'NOT_IMPLEMENTED', property: 'set_text', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.set_node_fill = function (payload) {
  // TODO: Task 9 — set fill on existing node (DS variable or raw)
  throw { error: 'NOT_IMPLEMENTED', property: 'set_node_fill', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.set_layout_sizing = function (payload) {
  // TODO: Task 9 — change layoutSizingHorizontal/Vertical on a node
  throw { error: 'NOT_IMPLEMENTED', property: 'set_layout_sizing', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.set_visibility = function (payload) {
  // TODO: Task 9 — show/hide a node
  throw { error: 'NOT_IMPLEMENTED', property: 'set_visibility', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.set_text_style = function (payload) {
  // TODO: Task 9 — apply text style to existing text node
  throw { error: 'NOT_IMPLEMENTED', property: 'set_text_style', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.set_variable_mode = function (payload) {
  // TODO: Task 9 — set variable collection mode on a frame (light/dark)
  throw { error: 'NOT_IMPLEMENTED', property: 'set_variable_mode', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.swap_main_component = function (payload) {
  // TODO: Task 9 — swap the main component of an instance
  throw { error: 'NOT_IMPLEMENTED', property: 'swap_main_component', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.replace_component = function (payload) {
  // TODO: Task 9 — replace a component instance with a different component
  throw { error: 'NOT_IMPLEMENTED', property: 'replace_component', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.restyle_artboard = function (payload) {
  // TODO: Task 9 — restyle entire artboard (background, mode)
  throw { error: 'NOT_IMPLEMENTED', property: 'restyle_artboard', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.move_node = function (payload) {
  // TODO: Task 9 — reparent/reorder a node
  throw { error: 'NOT_IMPLEMENTED', property: 'move_node', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.delete_node = function (payload) {
  // TODO: Task 9 — remove a node
  throw { error: 'NOT_IMPLEMENTED', property: 'delete_node', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

// ── Stubs for Task 9 — Inspect handlers ────────────────────────────────────────

handlers.get_node_props = function (payload) {
  // TODO: Task 9 — return full property snapshot of a node
  throw { error: 'NOT_IMPLEMENTED', property: 'get_node_props', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.get_node_children = function (payload) {
  // TODO: Task 9 — return children summary of a container node
  throw { error: 'NOT_IMPLEMENTED', property: 'get_node_children', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.get_node_parent = function (payload) {
  // TODO: Task 9 — return parent info
  throw { error: 'NOT_IMPLEMENTED', property: 'get_node_parent', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.get_text_info = function (payload) {
  // TODO: Task 9 — return text properties, style, content
  throw { error: 'NOT_IMPLEMENTED', property: 'get_text_info', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.get_component_variants = function (payload) {
  // TODO: Task 9 — list available variants for a component set
  throw { error: 'NOT_IMPLEMENTED', property: 'get_component_variants', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.get_selection = function (payload) {
  // TODO: Task 9 — return current selection
  throw { error: 'NOT_IMPLEMENTED', property: 'get_selection', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.select_node = function (payload) {
  // TODO: Task 9 — set selection to a specific node
  throw { error: 'NOT_IMPLEMENTED', property: 'select_node', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.get_page_nodes = function (payload) {
  // TODO: Task 9 — list top-level nodes on current page
  throw { error: 'NOT_IMPLEMENTED', property: 'get_page_nodes', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.get_pages = function (payload) {
  // TODO: Task 9 — list all pages in the file
  throw { error: 'NOT_IMPLEMENTED', property: 'get_pages', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.change_page = function (payload) {
  // TODO: Task 9 — switch current page
  throw { error: 'NOT_IMPLEMENTED', property: 'change_page', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

// ── Stubs for Task 9 — Validation & Batch ──────────────────────────────────────

handlers.validate_ds_compliance = function (payload) {
  // TODO: Task 9 — walk a subtree and report DS violations
  throw { error: 'NOT_IMPLEMENTED', property: 'validate_ds_compliance', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

handlers.figma_batch = function (payload) {
  // TODO: Task 9 — execute multiple operations in sequence
  throw { error: 'NOT_IMPLEMENTED', property: 'figma_batch', message: 'Scheduled for Task 9.', available: [], recovery: 'Wait for Task 9 implementation.' };
};

// ── Message Dispatcher ─────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 120, height: 28, position: { x: 0, y: 0 } });

figma.ui.onmessage = function (msg) {
  // Ignore internal bridge status messages
  if (msg.type === '__bridge_connected' || msg.type === '__bridge_disconnected') return;

  var id = msg.id;
  var type = msg.type;
  var payload = msg.payload || {};

  // Normalize node IDs in payload (dash → colon)
  var idKeys = ['nodeId', 'parentId', 'targetId', 'instanceId', 'frameId'];
  for (var k = 0; k < idKeys.length; k++) {
    var key = idKeys[k];
    if (typeof payload[key] === 'string') {
      payload[key] = payload[key].replace(/-/g, ':');
    }
  }

  // Look up handler
  var handler = handlers[type];
  if (!handler) {
    figma.ui.postMessage({
      id: id,
      error: 'Unknown handler: ' + type,
    });
    return;
  }

  // Execute handler — may return a value or a Promise
  try {
    var result = handler(payload);

    // Handle Promise (from async operations like importComponentByKeyAsync)
    if (result && typeof result.then === 'function') {
      result.then(function (resolved) {
        figma.ui.postMessage({
          id: id,
          result: resolved,
        });
      }).catch(function (err) {
        var errObj = err;
        if (err instanceof Error) {
          errObj = {
            error: 'PLUGIN_ERROR',
            property: type,
            message: err.message,
            available: [],
            recovery: 'Check the error message and retry with corrected parameters.',
          };
        }
        figma.ui.postMessage({
          id: id,
          error: typeof errObj === 'string' ? errObj : errObj.error || errObj.message || 'Unknown error',
          result: typeof errObj === 'object' ? errObj : undefined,
        });
      });
    } else {
      figma.ui.postMessage({
        id: id,
        result: result,
      });
    }
  } catch (err) {
    var errObj = err;
    if (err instanceof Error) {
      errObj = {
        error: 'PLUGIN_ERROR',
        property: type,
        message: err.message,
        available: [],
        recovery: 'Check the error message and retry with corrected parameters.',
      };
    }
    figma.ui.postMessage({
      id: id,
      error: typeof errObj === 'string' ? errObj : errObj.error || errObj.message || 'Unknown error',
      result: typeof errObj === 'object' ? errObj : undefined,
    });
  }
};
