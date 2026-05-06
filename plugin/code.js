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

  // Font loading + content setting must be async
  var fontFamily = payload.fontFamily || 'Inter';
  var fontStyle = payload.fontStyle || 'Regular';

  // Return a promise so the dispatcher waits for font loading
  return figma.loadFontAsync({ family: fontFamily, style: fontStyle }).then(function () {
    // Apply text style if provided
    if (payload.textStyleId) {
      try {
        var style = styleCache.get(payload.textStyleId) || figma.getStyleById(payload.textStyleId);
        if (style && style.type === 'TEXT') {
          text.textStyleId = style.id;
        }
      } catch (e) {
        // Style not available — font already loaded as fallback
      }
    }

    // Set content (font is now loaded)
    if (payload.characters || payload.content) {
      text.characters = payload.characters || payload.content || '';
    }

  // Typography variable bindings (fontSize, lineHeight, letterSpacing)
    // Typography variable bindings
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
    };
  });
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
  enforceColorFill(payload, 'RECTANGLE');
  var parent = getParent(payload.parentId);
  var rect = figma.createRectangle();

  rect.name = payload.name || 'Rectangle';

  // Sizing
  if (payload.width && payload.height) rect.resize(payload.width, payload.height);
  if (payload.layoutSizingHorizontal) rect.layoutSizingHorizontal = payload.layoutSizingHorizontal;
  if (payload.layoutSizingVertical) rect.layoutSizingVertical = payload.layoutSizingVertical;

  // Position
  if (typeof payload.x === 'number') rect.x = payload.x;
  if (typeof payload.y === 'number') rect.y = payload.y;

  // Fill
  if (payload.fillVariable) {
    bindFillVariable(rect, payload.fillVariable);
  } else if (payload.fill) {
    applySolidFill(rect, payload.fill);
  }

  // Stroke
  if (payload.strokeVariable) {
    bindStrokeVariable(rect, payload.strokeVariable);
    if (typeof payload.strokeWeight === 'number') rect.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) rect.strokeAlign = payload.strokeAlign;
  } else if (payload.stroke) {
    var strokeRgb = hexToRgb(payload.stroke);
    rect.strokes = [{ type: 'SOLID', color: strokeRgb }];
    if (typeof payload.strokeWeight === 'number') rect.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) rect.strokeAlign = payload.strokeAlign;
  }

  // Corner radius
  if (payload.cornerRadiusVariable) {
    bindVariable(rect, 'topLeftRadius', payload.cornerRadiusVariable);
    bindVariable(rect, 'topRightRadius', payload.cornerRadiusVariable);
    bindVariable(rect, 'bottomLeftRadius', payload.cornerRadiusVariable);
    bindVariable(rect, 'bottomRightRadius', payload.cornerRadiusVariable);
  } else if (typeof payload.cornerRadius === 'number') {
    rect.cornerRadius = payload.cornerRadius;
  }

  // Individual corner radii
  if (payload.topLeftRadiusVariable) bindVariable(rect, 'topLeftRadius', payload.topLeftRadiusVariable);
  if (payload.topRightRadiusVariable) bindVariable(rect, 'topRightRadius', payload.topRightRadiusVariable);
  if (payload.bottomLeftRadiusVariable) bindVariable(rect, 'bottomLeftRadius', payload.bottomLeftRadiusVariable);
  if (payload.bottomRightRadiusVariable) bindVariable(rect, 'bottomRightRadius', payload.bottomRightRadiusVariable);

  // Opacity
  if (typeof payload.opacity === 'number') rect.opacity = payload.opacity;

  parent.appendChild(rect);

  return {
    nodeId: rect.id,
    name: rect.name,
    type: 'RECTANGLE',
  };
};

handlers.create_ellipse = function (payload) {
  enforceColorFill(payload, 'ELLIPSE');
  var parent = getParent(payload.parentId);
  var ellipse = figma.createEllipse();

  ellipse.name = payload.name || 'Ellipse';

  // Sizing
  if (payload.width && payload.height) ellipse.resize(payload.width, payload.height);
  if (payload.layoutSizingHorizontal) ellipse.layoutSizingHorizontal = payload.layoutSizingHorizontal;
  if (payload.layoutSizingVertical) ellipse.layoutSizingVertical = payload.layoutSizingVertical;

  // Arc data (for donut segments)
  if (payload.arcData) {
    ellipse.arcData = {
      startingAngle: payload.arcData.startingAngle || 0,
      endingAngle: payload.arcData.endingAngle || 6.2831853,
      innerRadius: payload.arcData.innerRadius || 0,
    };
  }

  // Position
  if (typeof payload.x === 'number') ellipse.x = payload.x;
  if (typeof payload.y === 'number') ellipse.y = payload.y;

  // Fill
  if (payload.fillVariable) {
    bindFillVariable(ellipse, payload.fillVariable);
  } else if (payload.fill) {
    applySolidFill(ellipse, payload.fill);
  }

  // Stroke
  if (payload.strokeVariable) {
    bindStrokeVariable(ellipse, payload.strokeVariable);
    if (typeof payload.strokeWeight === 'number') ellipse.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) ellipse.strokeAlign = payload.strokeAlign;
  } else if (payload.stroke) {
    var strokeRgb = hexToRgb(payload.stroke);
    ellipse.strokes = [{ type: 'SOLID', color: strokeRgb }];
    if (typeof payload.strokeWeight === 'number') ellipse.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) ellipse.strokeAlign = payload.strokeAlign;
  }

  // Opacity
  if (typeof payload.opacity === 'number') ellipse.opacity = payload.opacity;

  parent.appendChild(ellipse);

  return {
    nodeId: ellipse.id,
    name: ellipse.name,
    type: 'ELLIPSE',
  };
};

handlers.create_svg = function (payload) {
  if (!payload.svgString && !payload.svg) {
    throw {
      error: 'MISSING_PARAM',
      property: 'svgString',
      message: 'svgString (or svg) is required to create an SVG node.',
      available: [],
      recovery: 'Provide the SVG markup as svgString.',
    };
  }

  var parent = getParent(payload.parentId);
  var svgNode = figma.createNodeFromSvg(payload.svgString || payload.svg);

  svgNode.name = payload.name || 'SVG';

  // Position
  if (typeof payload.x === 'number') svgNode.x = payload.x;
  if (typeof payload.y === 'number') svgNode.y = payload.y;

  // Sizing
  if (payload.width && payload.height) svgNode.resize(payload.width, payload.height);
  if (payload.layoutSizingHorizontal) svgNode.layoutSizingHorizontal = payload.layoutSizingHorizontal;
  if (payload.layoutSizingVertical) svgNode.layoutSizingVertical = payload.layoutSizingVertical;

  // Optionally apply fill/stroke variables to child vectors
  if (payload.fillVariable || payload.strokeVariable) {
    function walkVectors(node) {
      if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' || node.type === 'STAR' || node.type === 'LINE' || node.type === 'POLYGON') {
        if (payload.fillVariable) bindFillVariable(node, payload.fillVariable);
        if (payload.strokeVariable) bindStrokeVariable(node, payload.strokeVariable);
      }
      if ('children' in node) {
        for (var i = 0; i < node.children.length; i++) {
          walkVectors(node.children[i]);
        }
      }
    }
    walkVectors(svgNode);
  }

  parent.appendChild(svgNode);

  return {
    nodeId: svgNode.id,
    name: svgNode.name,
    type: 'FRAME',
  };
};

// ── Stubs for Task 9 — Edit handlers ───────────────────────────────────────────

handlers.set_component_text = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  var textNodeName = payload.textNodeName;
  var content = payload.content || payload.characters || '';
  var found = null;

  function walk(n) {
    if (found) return;
    if (n.type === 'TEXT' && n.name === textNodeName) {
      found = n;
      return;
    }
    if ('children' in n) {
      for (var i = 0; i < n.children.length; i++) {
        walk(n.children[i]);
      }
    }
  }
  walk(node);

  if (!found) {
    // Collect available text node names for recovery
    var available = [];
    function collectNames(n) {
      if (n.type === 'TEXT') available.push(n.name);
      if ('children' in n) {
        for (var i = 0; i < n.children.length; i++) collectNames(n.children[i]);
      }
    }
    collectNames(node);

    throw {
      error: 'TEXT_NODE_NOT_FOUND',
      property: 'textNodeName',
      message: 'Text node "' + textNodeName + '" not found inside node ' + payload.nodeId,
      available: available,
      recovery: 'Use one of the available text node names.',
    };
  }

  found.characters = content;

  // Optionally apply fill variable to the text
  if (payload.fillVariable) bindFillVariable(found, payload.fillVariable);

  return {
    nodeId: found.id,
    name: found.name,
    type: 'TEXT',
    characters: found.characters,
  };
};

handlers.set_variant = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (node.type !== 'INSTANCE') throw { error: 'INVALID_NODE_TYPE', property: 'nodeId', message: 'Node is not an instance: ' + node.type, available: [], recovery: 'Provide an instance nodeId.' };

  var properties = payload.properties || {};
  var keys = Object.keys(properties);
  var applied = {};

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    try {
      node.setProperties({ [key]: properties[key] });
      applied[key] = properties[key];
    } catch (e) {
      // Try via componentProperties path
      try {
        var cp = node.componentProperties;
        if (cp && cp[key] !== undefined) {
          node.setProperties({ [key]: properties[key] });
          applied[key] = properties[key];
        }
      } catch (e2) {
        applied[key] = { error: e.message || 'Failed to set property' };
      }
    }
  }

  return {
    nodeId: node.id,
    name: node.name,
    type: 'INSTANCE',
    appliedProperties: applied,
  };
};

handlers.set_text = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (node.type !== 'TEXT') throw { error: 'INVALID_NODE_TYPE', property: 'nodeId', message: 'Node is not a text node: ' + node.type, available: [], recovery: 'Provide a TEXT nodeId.' };

  var content = payload.content || payload.characters || '';
  node.characters = content;

  return {
    nodeId: node.id,
    name: node.name,
    type: 'TEXT',
    characters: node.characters,
  };
};

handlers.set_node_fill = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  if (payload.fillVariable) {
    bindFillVariable(node, payload.fillVariable);
  } else if (payload.fill) {
    applySolidFill(node, payload.fill);
  } else {
    // Clear fill
    node.fills = [];
  }

  return {
    nodeId: node.id,
    name: node.name,
    fillSet: !!(payload.fillVariable || payload.fill),
  };
};

handlers.set_layout_sizing = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  if (payload.layoutSizingHorizontal) node.layoutSizingHorizontal = payload.layoutSizingHorizontal;
  if (payload.layoutSizingVertical) node.layoutSizingVertical = payload.layoutSizingVertical;

  // Max/min constraints
  if (typeof payload.maxWidth === 'number') node.maxWidth = payload.maxWidth;
  if (typeof payload.minWidth === 'number') node.minWidth = payload.minWidth;
  if (typeof payload.maxHeight === 'number') node.maxHeight = payload.maxHeight;
  if (typeof payload.minHeight === 'number') node.minHeight = payload.minHeight;

  // Padding variables
  if (payload.paddingVariable) {
    bindVariable(node, 'paddingTop', payload.paddingVariable);
    bindVariable(node, 'paddingRight', payload.paddingVariable);
    bindVariable(node, 'paddingBottom', payload.paddingVariable);
    bindVariable(node, 'paddingLeft', payload.paddingVariable);
  }
  if (payload.paddingTopVariable) bindVariable(node, 'paddingTop', payload.paddingTopVariable);
  if (payload.paddingRightVariable) bindVariable(node, 'paddingRight', payload.paddingRightVariable);
  if (payload.paddingBottomVariable) bindVariable(node, 'paddingBottom', payload.paddingBottomVariable);
  if (payload.paddingLeftVariable) bindVariable(node, 'paddingLeft', payload.paddingLeftVariable);

  // Raw padding
  if (typeof payload.paddingTop === 'number') node.paddingTop = payload.paddingTop;
  if (typeof payload.paddingRight === 'number') node.paddingRight = payload.paddingRight;
  if (typeof payload.paddingBottom === 'number') node.paddingBottom = payload.paddingBottom;
  if (typeof payload.paddingLeft === 'number') node.paddingLeft = payload.paddingLeft;

  // Gap variable
  if (payload.gapVariable) {
    bindVariable(node, 'itemSpacing', payload.gapVariable);
  } else if (typeof payload.gap === 'number') {
    node.itemSpacing = payload.gap;
  }

  return {
    nodeId: node.id,
    name: node.name,
    layoutSizingHorizontal: node.layoutSizingHorizontal,
    layoutSizingVertical: node.layoutSizingVertical,
  };
};

handlers.set_visibility = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  node.visible = payload.visible !== false;

  return {
    nodeId: node.id,
    name: node.name,
    visible: node.visible,
  };
};

handlers.set_text_style = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (node.type !== 'TEXT') throw { error: 'INVALID_NODE_TYPE', property: 'nodeId', message: 'Node is not a text node: ' + node.type, available: [], recovery: 'Provide a TEXT nodeId.' };

  var styleId = payload.textStyleId;
  if (!styleId) throw { error: 'MISSING_PARAM', property: 'textStyleId', message: 'textStyleId is required.', available: [], recovery: 'Provide a valid text style ID.' };

  var style = styleCache.get(styleId) || figma.getStyleById(styleId);
  if (!style || style.type !== 'TEXT') {
    throw { error: 'STYLE_NOT_FOUND', property: 'textStyleId', message: 'Text style not found: ' + styleId, available: [], recovery: 'Check the style ID from figma_list_text_styles.' };
  }

  node.textStyleId = style.id;

  return {
    nodeId: node.id,
    name: node.name,
    type: 'TEXT',
    textStyleId: style.id,
    styleName: style.name,
  };
};

handlers.set_variable_mode = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  var collectionName = payload.collectionName;
  var modeIndex = payload.modeIndex || 0;

  // Find the collection by name
  var collections = figma.variables.getLocalVariableCollections();
  var targetCollection = null;
  for (var i = 0; i < collections.length; i++) {
    if (collections[i].name === collectionName) {
      targetCollection = collections[i];
      break;
    }
  }

  if (!targetCollection) {
    var availableNames = [];
    for (var i = 0; i < collections.length; i++) {
      availableNames.push(collections[i].name);
    }
    throw {
      error: 'COLLECTION_NOT_FOUND',
      property: 'collectionName',
      message: 'Variable collection "' + collectionName + '" not found.',
      available: availableNames,
      recovery: 'Use one of the available collection names.',
    };
  }

  if (modeIndex >= targetCollection.modes.length) {
    var availableModes = [];
    for (var i = 0; i < targetCollection.modes.length; i++) {
      availableModes.push(i + ': ' + targetCollection.modes[i].name);
    }
    throw {
      error: 'INVALID_MODE_INDEX',
      property: 'modeIndex',
      message: 'Mode index ' + modeIndex + ' is out of range.',
      available: availableModes,
      recovery: 'Use a valid mode index.',
    };
  }

  var modeId = targetCollection.modes[modeIndex].modeId;
  node.setExplicitVariableModeForCollection(targetCollection, modeId);

  return {
    nodeId: node.id,
    name: node.name,
    collectionName: targetCollection.name,
    modeName: targetCollection.modes[modeIndex].name,
    modeIndex: modeIndex,
  };
};

handlers.swap_main_component = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (node.type !== 'INSTANCE') throw { error: 'INVALID_NODE_TYPE', property: 'nodeId', message: 'Node is not an instance: ' + node.type, available: [], recovery: 'Provide an instance nodeId.' };

  if (!payload.newComponentKey) throw { error: 'MISSING_PARAM', property: 'newComponentKey', message: 'newComponentKey is required.', available: [], recovery: 'Provide the component key to swap to.' };

  return figma.importComponentByKeyAsync(payload.newComponentKey).then(function (imported) {
    node.swapComponent(imported);
    var hints = collectConfigurationHints(node);

    return {
      nodeId: node.id,
      name: node.name,
      type: 'INSTANCE',
      newComponentName: imported.name,
      newComponentKey: payload.newComponentKey,
      configurationHints: hints,
    };
  });
};

handlers.replace_component = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (node.type !== 'INSTANCE') throw { error: 'INVALID_NODE_TYPE', property: 'nodeId', message: 'Node is not an instance: ' + node.type, available: [], recovery: 'Provide an instance nodeId.' };

  if (!payload.newComponentKey) throw { error: 'MISSING_PARAM', property: 'newComponentKey', message: 'newComponentKey is required.', available: [], recovery: 'Provide the component key.' };

  var parentNode = node.parent;
  var nodeIndex = parentNode ? Array.prototype.indexOf.call(parentNode.children, node) : -1;
  var oldX = node.x;
  var oldY = node.y;
  var oldName = node.name;

  return figma.importComponentByKeyAsync(payload.newComponentKey).then(function (imported) {
    var instance = imported.createInstance();
    instance.name = payload.name || oldName;

    // Position at same location
    instance.x = oldX;
    instance.y = oldY;

    // Sizing
    instance.layoutSizingHorizontal = payload.layoutSizingHorizontal || node.layoutSizingHorizontal || 'HUG';
    instance.layoutSizingVertical = payload.layoutSizingVertical || node.layoutSizingVertical || 'HUG';

    // Insert at same position in parent
    if (parentNode && nodeIndex >= 0) {
      parentNode.insertChild(nodeIndex, instance);
    }

    // Remove old node
    node.remove();

    var hints = collectConfigurationHints(instance);

    return {
      nodeId: instance.id,
      name: instance.name,
      type: 'INSTANCE',
      componentName: imported.name,
      componentKey: payload.newComponentKey,
      configurationHints: hints,
      replacedNodeId: payload.nodeId,
    };
  });
};

handlers.restyle_artboard = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  // Name
  if (payload.name) node.name = payload.name;

  // Fill
  if (payload.fillVariable) {
    bindFillVariable(node, payload.fillVariable);
  } else if (payload.fill) {
    applySolidFill(node, payload.fill);
  }

  // Stroke
  if (payload.strokeVariable) {
    bindStrokeVariable(node, payload.strokeVariable);
    if (typeof payload.strokeWeight === 'number') node.strokeWeight = payload.strokeWeight;
  }

  // Corner radius
  if (payload.cornerRadiusVariable) {
    bindVariable(node, 'topLeftRadius', payload.cornerRadiusVariable);
    bindVariable(node, 'topRightRadius', payload.cornerRadiusVariable);
    bindVariable(node, 'bottomLeftRadius', payload.cornerRadiusVariable);
    bindVariable(node, 'bottomRightRadius', payload.cornerRadiusVariable);
  } else if (typeof payload.cornerRadius === 'number') {
    node.cornerRadius = payload.cornerRadius;
  }

  // Layout direction
  if (payload.direction) node.layoutMode = payload.direction;

  // Alignment
  if (payload.primaryAxisAlignItems) node.primaryAxisAlignItems = payload.primaryAxisAlignItems;
  if (payload.counterAxisAlignItems) node.counterAxisAlignItems = payload.counterAxisAlignItems;

  // Sizing
  if (payload.layoutSizingHorizontal) node.layoutSizingHorizontal = payload.layoutSizingHorizontal;
  if (payload.layoutSizingVertical) node.layoutSizingVertical = payload.layoutSizingVertical;
  if (payload.width && payload.height) node.resize(payload.width, payload.height);

  // Padding
  if (payload.paddingVariable) {
    bindVariable(node, 'paddingTop', payload.paddingVariable);
    bindVariable(node, 'paddingRight', payload.paddingVariable);
    bindVariable(node, 'paddingBottom', payload.paddingVariable);
    bindVariable(node, 'paddingLeft', payload.paddingVariable);
  }
  if (payload.paddingTopVariable) bindVariable(node, 'paddingTop', payload.paddingTopVariable);
  if (payload.paddingRightVariable) bindVariable(node, 'paddingRight', payload.paddingRightVariable);
  if (payload.paddingBottomVariable) bindVariable(node, 'paddingBottom', payload.paddingBottomVariable);
  if (payload.paddingLeftVariable) bindVariable(node, 'paddingLeft', payload.paddingLeftVariable);

  // Gap
  if (payload.gapVariable) {
    bindVariable(node, 'itemSpacing', payload.gapVariable);
  } else if (typeof payload.gap === 'number') {
    node.itemSpacing = payload.gap;
  }

  // Clip
  if (typeof payload.clipsContent === 'boolean') node.clipsContent = payload.clipsContent;

  return {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    restyled: true,
  };
};

handlers.move_node = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  var parent = getParent(payload.parentId);

  if (typeof payload.index === 'number') {
    parent.insertChild(payload.index, node);
  } else {
    parent.appendChild(node);
  }

  return {
    nodeId: node.id,
    name: node.name,
    newParentId: parent.id,
    newParentName: parent.name,
  };
};

handlers.delete_node = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  var name = node.name;
  var type = node.type;
  node.remove();

  return {
    deleted: true,
    nodeId: payload.nodeId,
    name: name,
    type: type,
  };
};

// ── Stubs for Task 9 — Inspect handlers ────────────────────────────────────────

handlers.get_node_props = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  var props = {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };

  // Dimensions
  if ('width' in node) props.width = node.width;
  if ('height' in node) props.height = node.height;
  if ('x' in node) props.x = node.x;
  if ('y' in node) props.y = node.y;

  // Auto-layout
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    props.layoutMode = node.layoutMode;
    props.layoutSizingHorizontal = node.layoutSizingHorizontal;
    props.layoutSizingVertical = node.layoutSizingVertical;
    props.primaryAxisAlignItems = node.primaryAxisAlignItems;
    props.counterAxisAlignItems = node.counterAxisAlignItems;
    props.itemSpacing = node.itemSpacing;
    props.paddingTop = node.paddingTop;
    props.paddingRight = node.paddingRight;
    props.paddingBottom = node.paddingBottom;
    props.paddingLeft = node.paddingLeft;
  }

  // Fills
  if ('fills' in node && Array.isArray(node.fills)) {
    props.fills = [];
    for (var i = 0; i < node.fills.length; i++) {
      var fill = node.fills[i];
      var fillInfo = { type: fill.type, visible: fill.visible !== false };
      if (fill.type === 'SOLID' && fill.color) {
        fillInfo.color = {
          r: Math.round(fill.color.r * 255),
          g: Math.round(fill.color.g * 255),
          b: Math.round(fill.color.b * 255),
        };
        fillInfo.opacity = fill.opacity;
      }
      props.fills.push(fillInfo);
    }
  }

  // Strokes
  if ('strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    props.strokes = [];
    for (var i = 0; i < node.strokes.length; i++) {
      var stroke = node.strokes[i];
      var strokeInfo = { type: stroke.type };
      if (stroke.type === 'SOLID' && stroke.color) {
        strokeInfo.color = {
          r: Math.round(stroke.color.r * 255),
          g: Math.round(stroke.color.g * 255),
          b: Math.round(stroke.color.b * 255),
        };
      }
      props.strokes.push(strokeInfo);
    }
    props.strokeWeight = node.strokeWeight;
  }

  // Corner radius
  if ('cornerRadius' in node) props.cornerRadius = node.cornerRadius;

  // Text style
  if (node.type === 'TEXT') {
    props.characters = node.characters;
    try { props.textStyleId = node.textStyleId; } catch (e) {}
    props.textAlignHorizontal = node.textAlignHorizontal;
    props.textAlignVertical = node.textAlignVertical;
    props.textAutoResize = node.textAutoResize;
  }

  // Component properties
  if (node.type === 'INSTANCE') {
    try {
      props.componentProperties = node.componentProperties;
    } catch (e) {}
    try {
      var mainComp = node.mainComponent;
      if (mainComp) {
        props.mainComponentName = mainComp.name;
        props.mainComponentKey = mainComp.key;
      }
    } catch (e) {}
  }

  // Children count
  if ('children' in node) {
    props.childrenCount = node.children.length;
  }

  return props;
};

handlers.get_node_children = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  if (!('children' in node)) {
    return { nodeId: node.id, name: node.name, children: [] };
  }

  var maxDepth = payload.depth || 1;
  var results = [];

  function collect(parent, currentDepth) {
    if (!('children' in parent)) return;
    for (var i = 0; i < parent.children.length; i++) {
      var child = parent.children[i];
      var entry = {
        id: child.id,
        name: child.name,
        type: child.type,
        visible: child.visible,
      };
      if (currentDepth < maxDepth && 'children' in child) {
        entry.children = [];
        // Recurse into children for deeper collection
        function collectNested(p, d, arr) {
          if (!('children' in p)) return;
          for (var j = 0; j < p.children.length; j++) {
            var c = p.children[j];
            var e = { id: c.id, name: c.name, type: c.type, visible: c.visible };
            if (d < maxDepth && 'children' in c) {
              e.children = [];
              collectNested(c, d + 1, e.children);
            }
            arr.push(e);
          }
        }
        collectNested(child, currentDepth + 1, entry.children);
      }
      results.push(entry);
    }
  }

  collect(node, 1);

  return {
    nodeId: node.id,
    name: node.name,
    children: results,
  };
};

handlers.get_node_parent = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  var parent = node.parent;
  if (!parent) {
    return { nodeId: node.id, name: node.name, parent: null };
  }

  return {
    nodeId: node.id,
    name: node.name,
    parent: {
      id: parent.id,
      name: parent.name,
      type: parent.type,
    },
  };
};

handlers.get_text_info = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (node.type !== 'TEXT') throw { error: 'INVALID_NODE_TYPE', property: 'nodeId', message: 'Node is not a text node: ' + node.type, available: [], recovery: 'Provide a TEXT nodeId.' };

  var info = {
    nodeId: node.id,
    name: node.name,
    type: 'TEXT',
    characters: node.characters,
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textAutoResize: node.textAutoResize,
    width: node.width,
    height: node.height,
  };

  // Text style
  try { info.textStyleId = node.textStyleId; } catch (e) {}

  // Font info
  try {
    var fontName = node.fontName;
    if (fontName && fontName !== figma.mixed) {
      info.fontFamily = fontName.family;
      info.fontStyle = fontName.style;
    }
  } catch (e) {}

  try {
    var fontSize = node.fontSize;
    if (fontSize !== figma.mixed) info.fontSize = fontSize;
  } catch (e) {}

  try {
    var lineHeight = node.lineHeight;
    if (lineHeight !== figma.mixed) info.lineHeight = lineHeight;
  } catch (e) {}

  // Fill info
  if (Array.isArray(node.fills) && node.fills.length > 0) {
    var fill = node.fills[0];
    if (fill.type === 'SOLID' && fill.color) {
      info.fillColor = {
        r: Math.round(fill.color.r * 255),
        g: Math.round(fill.color.g * 255),
        b: Math.round(fill.color.b * 255),
      };
    }
  }

  // Truncation
  try { info.textTruncation = node.textTruncation; } catch (e) {}
  try { info.maxLines = node.maxLines; } catch (e) {}

  return info;
};

handlers.get_component_variants = function (payload) {
  if (!payload.componentSetKey) {
    throw { error: 'MISSING_PARAM', property: 'componentSetKey', message: 'componentSetKey is required.', available: [], recovery: 'Provide a component set key.' };
  }

  return figma.importComponentSetByKeyAsync(payload.componentSetKey).then(function (componentSet) {
    var variants = [];

    if (componentSet && 'children' in componentSet) {
      for (var i = 0; i < componentSet.children.length; i++) {
        var child = componentSet.children[i];
        if (child.type === 'COMPONENT') {
          var variantProps = {};
          try { variantProps = child.variantProperties || {}; } catch (e) {}
          variants.push({
            name: child.name,
            key: child.key,
            variantProperties: variantProps,
          });
        }
      }
    }

    return {
      componentSetName: componentSet.name,
      componentSetKey: payload.componentSetKey,
      variants: variants,
    };
  });
};

handlers.get_selection = function (payload) {
  var selection = figma.currentPage.selection;
  var nodes = [];

  for (var i = 0; i < selection.length; i++) {
    var node = selection[i];
    nodes.push({
      id: node.id,
      name: node.name,
      type: node.type,
    });
  }

  return {
    count: nodes.length,
    nodes: nodes,
  };
};

handlers.select_node = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);

  return {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    selected: true,
  };
};

handlers.get_page_nodes = function (payload) {
  var page = figma.currentPage;
  var nodes = [];

  for (var i = 0; i < page.children.length; i++) {
    var child = page.children[i];
    nodes.push({
      id: child.id,
      name: child.name,
      type: child.type,
      x: child.x,
      y: child.y,
      width: child.width,
      height: child.height,
    });
  }

  return {
    pageId: page.id,
    pageName: page.name,
    nodes: nodes,
  };
};

handlers.get_pages = function (payload) {
  var root = figma.root;
  var pages = [];

  for (var i = 0; i < root.children.length; i++) {
    var page = root.children[i];
    pages.push({
      id: page.id,
      name: page.name,
      isCurrent: page.id === figma.currentPage.id,
    });
  }

  return {
    pages: pages,
    currentPageId: figma.currentPage.id,
  };
};

handlers.change_page = function (payload) {
  var root = figma.root;
  var target = null;

  // Find by ID first, then by name
  if (payload.pageId) {
    for (var i = 0; i < root.children.length; i++) {
      if (root.children[i].id === payload.pageId) {
        target = root.children[i];
        break;
      }
    }
  }

  if (!target && payload.pageName) {
    for (var i = 0; i < root.children.length; i++) {
      if (root.children[i].name === payload.pageName) {
        target = root.children[i];
        break;
      }
    }
  }

  if (!target) {
    var available = [];
    for (var i = 0; i < root.children.length; i++) {
      available.push(root.children[i].name);
    }
    throw {
      error: 'PAGE_NOT_FOUND',
      property: 'pageName',
      message: 'Page not found: ' + (payload.pageName || payload.pageId),
      available: available,
      recovery: 'Use one of the available page names.',
    };
  }

  figma.currentPage = target;

  return {
    pageId: target.id,
    pageName: target.name,
    switched: true,
  };
};

// ── Stubs for Task 9 — Validation & Batch ──────────────────────────────────────

handlers.validate_ds_compliance = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  var violations = [];
  var totalNodes = 0;
  var compliant = 0;

  var enforceText = payload.enforceTextStyles !== false;
  var enforceColor = payload.enforceColorVars !== false;

  function hasBoundVariable(node, prop) {
    try {
      var bindings = node.boundVariables;
      if (bindings && bindings[prop]) return true;
    } catch (e) {}
    return false;
  }

  function hasFillBinding(node) {
    try {
      var fills = node.fills;
      if (!Array.isArray(fills)) return true; // mixed or no fills
      for (var i = 0; i < fills.length; i++) {
        if (fills[i].type === 'SOLID') {
          // Check if fill has a bound variable
          var bindings = node.boundVariables;
          if (bindings && bindings.fills) return true;
          return false;
        }
      }
      return true; // No solid fills to check
    } catch (e) {
      return true;
    }
  }

  function walk(n) {
    totalNodes++;
    var nodeViolations = [];

    // Text style check
    if (enforceText && n.type === 'TEXT') {
      var hasStyle = false;
      try {
        if (n.textStyleId && n.textStyleId !== '' && n.textStyleId !== figma.mixed) hasStyle = true;
      } catch (e) {}
      if (!hasStyle) {
        nodeViolations.push({
          nodeId: n.id,
          nodeName: n.name,
          nodeType: n.type,
          violation: 'MISSING_TEXT_STYLE',
          message: 'Text node has no text style applied.',
        });
      }
    }

    // Fill variable check
    if (enforceColor && 'fills' in n) {
      if (!hasFillBinding(n) && Array.isArray(n.fills) && n.fills.length > 0) {
        var hasSolidFill = false;
        for (var i = 0; i < n.fills.length; i++) {
          if (n.fills[i].type === 'SOLID' && n.fills[i].visible !== false) hasSolidFill = true;
        }
        if (hasSolidFill) {
          nodeViolations.push({
            nodeId: n.id,
            nodeName: n.name,
            nodeType: n.type,
            violation: 'MISSING_FILL_VARIABLE',
            message: 'Node has a solid fill without a DS variable binding.',
          });
        }
      }
    }

    if (nodeViolations.length > 0) {
      for (var i = 0; i < nodeViolations.length; i++) {
        violations.push(nodeViolations[i]);
      }
    } else {
      compliant++;
    }

    // Walk children
    if ('children' in n) {
      for (var i = 0; i < n.children.length; i++) {
        walk(n.children[i]);
      }
    }
  }

  walk(node);

  return {
    violations: violations,
    summary: {
      totalNodes: totalNodes,
      compliant: compliant,
      violations: violations.length,
    },
  };
};

handlers.figma_batch = function (payload) {
  var operations = payload.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw { error: 'MISSING_PARAM', property: 'operations', message: 'operations array is required.', available: [], recovery: 'Provide an array of { type, payload } objects.' };
  }
  if (operations.length > 6) {
    throw { error: 'BATCH_LIMIT', property: 'operations', message: 'Maximum 6 operations per batch.', available: [], recovery: 'Split into multiple batches of 6 or fewer.' };
  }

  // Execute sequentially, collecting results
  // Handle both sync and async handlers by chaining promises
  function executeSequential(ops, index, results) {
    if (index >= ops.length) return results;

    var op = ops[index];
    var handler = handlers[op.type];
    if (!handler) {
      results.push({ index: index, type: op.type, error: 'Unknown handler: ' + op.type });
      return executeSequential(ops, index + 1, results);
    }

    try {
      var result = handler(op.payload || {});

      if (result && typeof result.then === 'function') {
        return result.then(function (resolved) {
          results.push({ index: index, type: op.type, result: resolved });
          return executeSequential(ops, index + 1, results);
        }).catch(function (err) {
          var errMsg = err instanceof Error ? err.message : (err.message || err.error || 'Unknown error');
          results.push({ index: index, type: op.type, error: errMsg });
          return executeSequential(ops, index + 1, results);
        });
      } else {
        results.push({ index: index, type: op.type, result: result });
        return executeSequential(ops, index + 1, results);
      }
    } catch (err) {
      var errMsg = err instanceof Error ? err.message : (err.message || err.error || 'Unknown error');
      results.push({ index: index, type: op.type, error: errMsg });
      return executeSequential(ops, index + 1, results);
    }
  }

  var initialResults = [];
  var outcome = executeSequential(operations, 0, initialResults);

  // If any async operations, outcome is a promise
  if (outcome && typeof outcome.then === 'function') {
    return outcome.then(function (results) {
      return { results: results, count: results.length };
    });
  }

  return { results: outcome, count: outcome.length };
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
