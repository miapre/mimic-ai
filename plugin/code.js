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

/** @type {Set<string>} "family::style" keys already loaded via loadFontAsync this session */
var loadedFontKeys = new Set();

// ── Font Loading ───────────────────────────────────────────────────────────────
// Startup only pre-warms Inter (see the figma.loadFontAsync calls near the
// message dispatcher below) — that's a safe cold-start default, but any DS
// whose components/text styles use a different font family fails on the
// FIRST text node that isn't Inter, because Figma requires a font to be
// loaded before you can set characters/fontName on a node that uses it.
// ensureFontLoaded() closes that gap generically: it loads whatever font(s)
// a given text node ACTUALLY needs (reading them off the node itself, so
// this works for any DS, not just Inter), tolerating individual failures.

function fontKey(fontName) {
  return (fontName && fontName.family || '') + '::' + (fontName && fontName.style || '');
}

/** Loads a font once per session (deduped). Returns true/false, never throws. */
async function loadFont(fontName) {
  if (!fontName || !fontName.family) return false;
  var key = fontKey(fontName);
  if (loadedFontKeys.has(key)) return true;
  try {
    await figma.loadFontAsync(fontName);
    loadedFontKeys.add(key);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Ensures every font a TEXT node's characters currently use is loaded
 * before the caller mutates .characters/.fontName on it. Text nodes can
 * carry more than one font across character ranges (mixed fontName) — all
 * distinct fonts in the range are loaded. Best-effort: a font that fails
 * to load (e.g. offline library) is skipped, not thrown — the subsequent
 * .characters assignment will surface Figma's own error in that case.
 */
async function ensureFontLoaded(node) {
  if (!node || node.type !== 'TEXT') return;
  var fontName = node.fontName;
  if (fontName === figma.mixed) {
    var len = node.characters.length;
    var seen = {};
    for (var i = 0; i < len; i++) {
      var fn = node.getRangeFontName(i, i + 1);
      var key = fontKey(fn);
      if (!seen[key]) {
        seen[key] = true;
        await loadFont(fn);
      }
    }
  } else if (fontName) {
    await loadFont(fontName);
  }
}

// ── Type Coercion Helpers ─────────────────────────────────────────────────────
// MCP protocol may deliver booleans as strings and arrays as JSON strings.

function coerceBool(val, fallback) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.toLowerCase() === 'true';
  return fallback !== undefined ? fallback : false;
}

function coerceArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { var parsed = JSON.parse(val); if (Array.isArray(parsed)) return parsed; } catch (e) {}
  }
  return null;
}

// Component property keys (instance.componentProperties, component-set
// componentPropertyDefinitions) carry a "#nodeId"-style uniqueness suffix
// (e.g. "Label#12:3") that isn't part of the human-meaningful property
// name and isn't present on variantGroupProperties keys. Strip it so a
// property can be matched by name across these two different Plugin API
// surfaces (needed for SLOT lookup and for merging property `type` onto
// variantGroupProperties-derived entries).
function stripPropSuffix(key) {
  var k = String(key);
  var idx = k.indexOf('#');
  return idx === -1 ? k : k.slice(0, idx);
}

// ── Enforcement Gate ───────────────────────────────────────────────────────────

function enforceText(params) {
  if (!enforcementProfile.enforceTextStyles) return;
  // textStyleId always satisfies the requirement
  if (params.textStyleId) return;

  // fontSizeVariable is only acceptable when NO text styles are cached.
  // When text styles exist, they carry font family, weight, and line height —
  // fontSizeVariable alone produces unstyled text at a raw pixel size.
  var hasTextStyles = styleCache.size > 0;
  if (params.fontSizeVariable && !hasTextStyles) return;

  // Collect available style names for recovery hint
  var available = [];
  styleCache.forEach(function (style, key) {
    available.push(style.name);
  });

  var msg = hasTextStyles
    ? 'textStyleId is required when DS text styles are available. fontSizeVariable alone only sets size — it does not set font family, weight, or line height. Use figma_list_text_styles to find the right style key.'
    : 'Text style or typography variable required when enforceTextStyles is active.';

  throw {
    error: 'DS_REQUIRED',
    property: 'textStyle',
    message: msg,
    available: available.slice(0, 20),
    recovery: hasTextStyles
      ? 'Provide textStyleId from figma_list_text_styles. fontSizeVariable is only a fallback when no text styles exist.'
      : 'Provide textStyleId (from figma_list_text_styles) or fontSizeVariable (DS typography variable path).',
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

  // Search local collections (includes library variables already in the file)
  // Two passes: exact match first, leaf fallback second — prevents ambiguous matches
  var collections = figma.variables.getLocalVariableCollections();
  var leafMatch = null;
  for (var c = 0; c < collections.length; c++) {
    var col = collections[c];
    var varIds = col.variableIds;
    for (var v = 0; v < varIds.length; v++) {
      var variable = figma.variables.getVariableById(varIds[v]);
      if (variable) {
        if (variable.name === path) {
          variableCache.set(path, variable);
          return variable;
        }
        // Track first leaf match as fallback
        if (!leafMatch) {
          var leafName = variable.name.split('/').pop();
          if (leafName === path) {
            leafMatch = variable;
          }
        }
      }
    }
  }

  // Only use leaf match if no exact match was found
  if (leafMatch) {
    variableCache.set(path, leafMatch);
    return leafMatch;
  }

  return null;
}

// Async version that can import library variables by key
async function getVariableByKey(key) {
  if (!key) return null;
  try {
    return await figma.variables.importVariableByKeyAsync(key);
  } catch (e) {
    return null;
  }
}

// ── Binding Tracker ───────────────────────────────────────────────────────────
// Every handler that binds DS values creates one of these to track what
// actually succeeded vs. silently failed.

function createBindingTracker() {
  var applied = {};
  var warnings = [];
  return {
    applied: applied,
    warnings: warnings,
    track: function (name, success, detail) {
      applied[name] = success;
      if (!success && detail) {
        warnings.push(name + ': ' + detail);
      }
    },
    result: function () {
      var hasFailures = false;
      for (var k in applied) {
        if (applied[k] === false) { hasFailures = true; break; }
      }
      return {
        applied: applied,
        warnings: warnings,
        bindingFailures: hasFailures,
      };
    },
  };
}

function bindVariable(node, prop, varPath) {
  if (!varPath) return false;
  var variable = getVariableByPath(varPath);
  if (!variable) {
    return false;
  }

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
  if (!variable) {
    return false;
  }

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
  if (!variable) {
    return false;
  }

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

/**
 * Normalize a color value to Figma RGB {r,g,b} (0-1 range).
 * Accepts:
 *   - hex string: "#ffffff", "fff", "ffffff"
 *   - RGB object (0-1): {r: 0.5, g: 0.5, b: 0.5}
 *   - RGB object (0-255): {r: 128, g: 128, b: 128} — auto-detected if any value > 1
 * Returns null if unrecognized.
 */
function normalizeColor(color) {
  if (typeof color === 'string') {
    return hexToRgb(color);
  }
  if (color && typeof color === 'object' && 'r' in color && 'g' in color && 'b' in color) {
    var r = color.r, g = color.g, b = color.b;
    // Auto-detect 0-255 range vs 0-1 range
    if (r > 1 || g > 1 || b > 1) {
      return { r: r / 255, g: g / 255, b: b / 255 };
    }
    return { r: r, g: g, b: b };
  }
  return null;
}

/**
 * Apply a fill style by key. Imports from library if needed.
 * Returns true if applied, false if not found.
 * Includes a 10s timeout to prevent hanging on unresolvable imports.
 */
async function applyFillStyle(node, styleKey) {
  try {
    var style = styleCache.get(styleKey);
    if (!style || style.type !== 'PAINT') {
      // Import with timeout — figma.importStyleByKeyAsync can hang indefinitely
      style = await Promise.race([
        figma.importStyleByKeyAsync(styleKey),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('FILL_STYLE_IMPORT_TIMEOUT')); }, 10000);
        })
      ]);
    }
    if (style && style.type === 'PAINT') {
      // Text nodes use range-based fill styles, not fillStyleId
      if (node.type === 'TEXT') {
        var len = (node.characters || '').length;
        if (len > 0) {
          node.setRangeFillStyleId(0, len, style.id);
        } else {
          // No characters yet — set fills directly from the style's paints
          node.fills = style.paints || [];
        }
      } else {
        node.fillStyleId = style.id;
      }
      styleCache.set(styleKey, style);
      return true;
    }
    // Style imported but wrong type — cache it anyway to avoid re-import
    if (style) styleCache.set(styleKey, style);
    return false;
  } catch (e) {
    if (e && e.message === 'FILL_STYLE_IMPORT_TIMEOUT') {
      console.error('[Mimic] Fill style import timed out for key: ' + styleKey);
    }
    return false;
  }
}

function applySolidFill(node, color) {
  var rgb = normalizeColor(color);
  if (!rgb) {
    throw { error: 'INVALID_COLOR', message: 'Cannot parse color: ' + JSON.stringify(color) + '. Use hex string ("#ff0000") or RGB object ({r,g,b}).', recovery: 'Pass a hex string like "#3b36f2" or an RGB object like {r:0.23, g:0.21, b:0.95}.' };
  }
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

// Walk an instance tree and collect text nodes, properties, and variant info for configuration hints
function collectConfigurationHints(instance) {
  var textNodes = [];
  var booleanProperties = {};
  var variantProperties = {};
  var slotProperties = [];
  var iconSlots = [];

  // Walk the instance to find overridable text and icon slots
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

  // Collect all component properties (booleans + variants with current values,
  // and — Figma Slots, GA June 2026 — SLOT-typed properties). instance.
  // componentProperties is feature-detected implicitly: on Figma versions
  // that predate Slots, no property in this object ever has type === 'SLOT',
  // so slotProperties simply stays empty rather than requiring a separate
  // capability check.
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
        if (prop.type === 'SLOT') {
          slotProperties.push({
            key: key,
            name: stripPropSuffix(key),
            current: prop.value !== undefined ? prop.value : null,
          });
        }
      }
    }
  } catch (e) {
    // Not all instances expose componentProperties
  }

  // Collect variant property names + available values from the component set
  try {
    var mainComp = instance.mainComponent;
    if (mainComp) {
      var compSet = mainComp.parent && mainComp.parent.type === 'COMPONENT_SET' ? mainComp.parent : null;
      if (compSet && compSet.variantGroupProperties) {
        var vgp = compSet.variantGroupProperties;
        for (var propName in vgp) {
          if (vgp.hasOwnProperty(propName)) {
            variantProperties[propName] = {
              values: vgp[propName].values || [],
              current: null,
            };
          }
        }
        // Get current values from the instance's resolved variant
        try {
          var variantProps = mainComp.variantProperties;
          if (variantProps) {
            for (var vp in variantProps) {
              if (variantProperties[vp]) {
                variantProperties[vp].current = variantProps[vp];
              }
            }
          }
        } catch (e2) { /* some components don't expose variantProperties */ }
      }
    }
  } catch (e) {
    // Not all instances have component sets
  }

  // Attach property TYPE (VARIANT|BOOLEAN|TEXT|INSTANCE_SWAP|SLOT) onto each
  // variantProperties entry, sourced from instance.componentProperties —
  // which already carries `type` per property, keyed with the "#nodeId"
  // suffix that variantGroupProperties keys lack (stripPropSuffix bridges
  // the two). This is the live-instance path fingerprint.js's variant-
  // schema hash relies on for VARIANT<->SLOT/BOOLEAN migration detection
  // (see src/ds/fingerprint.js computeVariantSchemaHash); it's best-effort
  // — a missing/unreadable componentProperties object just leaves `type`
  // unset on the affected entries, matching pre-existing behavior.
  try {
    var typedProps = instance.componentProperties;
    if (typedProps) {
      var typedKeys = Object.keys(typedProps);
      for (var ti = 0; ti < typedKeys.length; ti++) {
        var rawKey = typedKeys[ti];
        var baseName = stripPropSuffix(rawKey);
        if (variantProperties[baseName] && typedProps[rawKey].type) {
          variantProperties[baseName].type = typedProps[rawKey].type;
        }
      }
    }
  } catch (e3) { /* best-effort — type stays unset */ }

  return {
    textNodes: textNodes,
    booleanProperties: booleanProperties,
    variantProperties: variantProperties,
    slotProperties: slotProperties,
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
    enforcementProfile.enforceTextStyles = coerceBool(ep.enforceTextStyles, enforcementProfile.enforceTextStyles);
    enforcementProfile.enforceColorVars = coerceBool(ep.enforceColorVars, enforcementProfile.enforceColorVars);
    enforcementProfile.enforceSpacingVars = coerceBool(ep.enforceSpacingVars, enforcementProfile.enforceSpacingVars);
    enforcementProfile.enforceRadiusVars = coerceBool(ep.enforceRadiusVars, enforcementProfile.enforceRadiusVars);
  }

  // Preload text styles if requested
  var preloadedStyles = 0;
  var textStyleKeys = coerceArray(payload.textStyleKeys);
  if (textStyleKeys) {
    for (var i = 0; i < textStyleKeys.length; i++) {
      var key = textStyleKeys[i];
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
  var variablePaths = coerceArray(payload.variablePaths);
  if (variablePaths) {
    for (var i = 0; i < variablePaths.length; i++) {
      var v = getVariableByPath(variablePaths[i]);
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

handlers.preload_styles = async function (payload) {
  var preloadedStyles = 0;
  var loaded = [];
  var styleKeys = coerceArray(payload.styleKeys);
  if (styleKeys) {
    for (var i = 0; i < styleKeys.length; i++) {
      var key = styleKeys[i];
      try {
        // Import from library by key with timeout
        var style = await Promise.race([
          figma.importStyleByKeyAsync(key),
          new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('TEXT_STYLE_IMPORT_TIMEOUT')); }, 10000);
          })
        ]);
        if (style && style.type === 'TEXT') {
          styleCache.set(key, style);
          loaded.push({ key: key, name: style.name });
          preloadedStyles++;
        }
      } catch (e) {
        // Style not found in any enabled library, skip
      }
    }
  }
  return {
    preloadedStyles: preloadedStyles,
    styleCacheSize: styleCache.size,
    styles: loaded,
  };
};

handlers.preload_fill_styles = async function (payload) {
  var preloadedStyles = 0;
  var loaded = [];
  var failed = [];
  var styleKeys = coerceArray(payload.styleKeys);
  if (styleKeys) {
    for (var i = 0; i < styleKeys.length; i++) {
      var key = styleKeys[i];
      try {
        var style = await figma.importStyleByKeyAsync(key);
        if (style && style.type === 'PAINT') {
          styleCache.set(key, style);
          loaded.push({ key: key, name: style.name });
          preloadedStyles++;
        } else {
          failed.push({ key: key, reason: style ? 'type=' + style.type : 'null' });
        }
      } catch (e) {
        failed.push({ key: key, reason: e.message || 'import-error' });
      }
    }
  }
  return {
    preloadedFillStyles: preloadedStyles,
    failed: failed.length,
    failedDetails: failed,
    styleCacheSize: styleCache.size,
    styles: loaded,
  };
};

handlers.preload_variables = async function (payload) {
  var preloadedVars = 0;
  var variables = coerceArray(payload.variables);
  if (variables) {
    for (var i = 0; i < variables.length; i++) {
      var entry = variables[i];
      try {
        // Import library variable by key
        var variable = await figma.variables.importVariableByKeyAsync(entry.key);
        if (variable) {
          variableCache.set(entry.path, variable);
          preloadedVars++;
        }
      } catch (e) {
        // Variable not found, skip
      }
    }
  }
  return {
    preloadedVars: preloadedVars,
    variableCacheSize: variableCache.size,
  };
};

/**
 * handlers.preload_fonts — explicit, DS-agnostic font pre-warm.
 *
 * Accepts a list of { family, style } pairs (any font, not just Inter) and
 * loads each via figma.loadFontAsync, deduped against loadedFontKeys and
 * tolerating individual failures (a missing/uninstalled font is reported
 * in `failed`, not thrown). Intended call site: after DS discovery caches
 * text styles, the MCP server collects the distinct font families/styles
 * those styles actually use and sends them here so every font the DS
 * needs is warm before the first component text override — instead of
 * only ever pre-warming Inter at cold start.
 *
 * NOTE (for whoever wires the MCP-side call): as of this change, the
 * per-node ensureFontLoaded() helper above already loads whatever font an
 * existing text node needs at the point of use (set_component_text,
 * set_component_text_by_id, batch_set_component_text, set_text), so a
 * missing preload_fonts call is no longer a hard failure — this handler
 * is for shaving the latency of that first-use load, not correctness.
 */
handlers.preload_fonts = async function (payload) {
  var fonts = coerceArray(payload.fonts) || [];
  var loaded = [];
  var failed = [];
  var seen = {};

  for (var i = 0; i < fonts.length; i++) {
    var f = fonts[i] || {};
    var family = f.family || f.fontFamily;
    var style = f.style || f.fontStyle || 'Regular';
    if (!family) continue;
    var key = fontKey({ family: family, style: style });
    if (seen[key]) continue;
    seen[key] = true;

    var ok = await loadFont({ family: family, style: style });
    if (ok) {
      loaded.push({ family: family, style: style });
    } else {
      failed.push({ family: family, style: style });
    }
  }

  return {
    requested: fonts.length,
    loaded: loaded,
    failed: failed,
    loadedCount: loaded.length,
    failedCount: failed.length,
    loadedFontCacheSize: loadedFontKeys.size,
  };
};

// ── Library Discovery ─────────────────────────────────────────────────────────

handlers.discover_library_variables = async function (payload) {
  // Use teamLibrary API to enumerate variable collections from enabled libraries
  var collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  var libraries = {};
  var allVariables = [];

  // Raw collection metadata — used by MCP server for multi-library detection
  var _rawCollections = collections.map(function (col) {
    return { name: col.name, libraryName: col.libraryName, key: col.key };
  });

  for (var c = 0; c < collections.length; c++) {
    var col = collections[c];
    var libName = col.libraryName || 'Unknown';
    if (!libraries[libName]) {
      libraries[libName] = { name: libName, collections: [] };
    }
    libraries[libName].collections.push(col.name);

    // Extended variable collections (Enterprise theming, 2026): a collection
    // that extends another exposes rootVariableCollectionId pointing at the
    // base/root collection. Feature-detected — collections from Figma
    // versions/plans without this field simply don't have the property at
    // all, so `'rootVariableCollectionId' in col` is false and rc stays
    // null (an ordinary, non-extended collection — the common case).
    var rootCollectionId = ('rootVariableCollectionId' in col) ? (col.rootVariableCollectionId || null) : null;

    // Enumerate variables in this collection
    var vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
    for (var v = 0; v < vars.length; v++) {
      var libVar = vars[v];
      allVariables.push({
        name: libVar.name,
        key: libVar.key,
        resolvedType: libVar.resolvedType,
        collection: col.name,
        // collectionKey: stable identifier for the variable's OWN home
        // collection (col.key — library collections are addressed by key,
        // not id). Distinct from `collection` (a human display name that
        // can be renamed) so the fingerprint's override-detection can
        // compare like-for-like against rootVariableCollectionId.
        collectionKey: col.key || null,
        rootVariableCollectionId: rootCollectionId,
        libraryName: libName,
      });
    }
  }

  return {
    libraries: Object.values(libraries),
    variables: allVariables,
    totalCollections: collections.length,
    totalVariables: allVariables.length,
    _rawCollections: _rawCollections,
  };
};

handlers.discover_library_styles = async function (payload) {
  var styles = [];
  var seenKeys = {};

  // 1. Local text styles (file-level)
  var localTextStyles = figma.getLocalTextStyles();
  for (var i = 0; i < localTextStyles.length; i++) {
    var style = localTextStyles[i];
    if (!seenKeys[style.key]) {
      seenKeys[style.key] = true;
      styles.push({ key: style.key, name: style.name, description: style.description || '' });
      styleCache.set(style.key, style);
    }
  }

  // 2. Scan existing text nodes on the current page for local styles
  //    Library text styles are now discovered via REST API in the MCP server.
  //    This page scan catches file-local styles that supplement REST results.
  var page = figma.currentPage;
  var textNodes = page.findAll(function (n) { return n.type === 'TEXT'; });
  for (var i = 0; i < textNodes.length; i++) {
    var textNode = textNodes[i];
    try {
      var boundStyle = textNode.textStyleId;
      if (boundStyle && typeof boundStyle === 'string' && boundStyle !== '') {
        var resolved = figma.getStyleById(boundStyle);
        if (resolved && resolved.key && !seenKeys[resolved.key]) {
          seenKeys[resolved.key] = true;
          styles.push({ key: resolved.key, name: resolved.name, description: resolved.description || '' });
          styleCache.set(resolved.key, resolved);
        }
      }
    } catch (e) { /* skip unresolvable */ }
  }

  return {
    styles: styles,
    totalStyles: styles.length,
    hint: styles.length === 0
      ? 'No text styles found locally or on existing nodes. Use figma_preload_styles with keys from Figma MCP search_design_system to import library styles.'
      : styles.length + ' text styles discovered and cached.',
  };
};

handlers.discover_library_components = async function (payload) {
  // Scan component instances on the current page for local/non-library components.
  // Library components are enumerated via REST API in the MCP server.
  // This page scan catches file-local components and supplements the REST results.
  var page = figma.currentPage;
  var instances = page.findAll(function (n) { return n.type === 'INSTANCE'; });
  var seen = {};
  var components = [];

  for (var i = 0; i < instances.length; i++) {
    var inst = instances[i];
    try {
      var mainComp = inst.mainComponent;
      if (!mainComp) continue;

      // Get the component set (parent) if it exists
      var compSet = mainComp.parent && mainComp.parent.type === 'COMPONENT_SET' ? mainComp.parent : null;
      var key = compSet ? compSet.key : mainComp.key;
      var name = compSet ? compSet.name : mainComp.name;

      if (!key || seen[key]) continue;
      seen[key] = true;

      // Detect library origin
      var isRemote = mainComp.remote;
      var variantCount = compSet ? compSet.children.length : 1;

      // Collect variant property names if it's a set, plus property TYPE
      // (VARIANT|BOOLEAN|TEXT|INSTANCE_SWAP|SLOT) from componentPropertyDefinitions
      // when the host Figma version/component exposes it (feature-detected —
      // wrapped in its own try/catch so its absence never breaks the
      // variantGroupProperties-derived list below). Types let fingerprint.js
      // register VARIANT->SLOT/BOOLEAN migrations as variant_schema_changed
      // instead of silently missing them (see computeVariantSchemaHash).
      var propDefs = null;
      try { propDefs = compSet && compSet.componentPropertyDefinitions ? compSet.componentPropertyDefinitions : null; } catch (eDefs) { propDefs = null; }

      var variantProps = [];
      var seenPropNames = {};
      if (compSet && compSet.variantGroupProperties) {
        var props = compSet.variantGroupProperties;
        for (var propName in props) {
          if (props.hasOwnProperty(propName)) {
            var propType = 'VARIANT';
            if (propDefs) {
              for (var defKey in propDefs) {
                if (propDefs.hasOwnProperty(defKey) && stripPropSuffix(defKey) === propName) {
                  propType = propDefs[defKey].type || 'VARIANT';
                  break;
                }
              }
            }
            variantProps.push({
              name: propName,
              values: props[propName].values || [],
              type: propType,
            });
            seenPropNames[propName] = true;
          }
        }
      }
      // Non-VARIANT properties (BOOLEAN/TEXT/INSTANCE_SWAP/SLOT) never appear
      // in variantGroupProperties (they have no enumerable "values" set) —
      // componentPropertyDefinitions is the ONLY source for them, so surface
      // them here with an empty values list. This is what lets a component
      // gain/lose a SLOT (or any non-variant) property register as a schema
      // change, not just VARIANT property edits.
      if (propDefs) {
        for (var defKey2 in propDefs) {
          if (!propDefs.hasOwnProperty(defKey2)) continue;
          var baseName2 = stripPropSuffix(defKey2);
          if (seenPropNames[baseName2]) continue;
          var def = propDefs[defKey2];
          if (def.type === 'VARIANT') continue; // would already be captured above
          variantProps.push({
            name: baseName2,
            values: [],
            type: def.type || 'BOOLEAN',
          });
          seenPropNames[baseName2] = true;
        }
      }

      components.push({
        key: key,
        name: name,
        isRemote: isRemote,
        isComponentSet: !!compSet,
        variantCount: variantCount,
        variantProperties: variantProps,
        description: (compSet || mainComp).description || '',
      });
    } catch (e) { /* skip unresolvable */ }
  }

  return {
    components: components,
    totalFound: components.length,
    totalInstancesScanned: instances.length,
    hint: components.length === 0
      ? 'No component instances on this page. Library components are discovered via REST API.'
      : components.length + ' local component instances found on this page.',
  };
};

handlers.create_frame = async function (payload) {
  var parent = getParent(payload.parentId);
  var frame = figma.createFrame();
  var bt = createBindingTracker();

  // Name
  frame.name = payload.name || 'Frame';

  // Auto-layout is ALWAYS on — GRID is an alternative layoutMode (Grid
  // automation, May 2026) selected via the dedicated `layoutMode` param
  // rather than overloading `direction` (which is meaningless for GRID).
  // Feature-detected: older Figma versions don't accept 'GRID' as a
  // layoutMode value at all, so the assignment is guarded and surfaces a
  // clear, actionable error instead of an opaque plugin-sandbox throw.
  var requestedLayoutMode = payload.layoutMode === 'GRID' ? 'GRID' : (payload.direction || 'VERTICAL');
  if (requestedLayoutMode === 'GRID') {
    try {
      frame.layoutMode = 'GRID';
    } catch (eGrid) {
      throw {
        error: 'GRID_LAYOUT_UNSUPPORTED',
        property: 'layoutMode',
        message: 'This Figma version does not support GRID layoutMode (Grid automation, May 2026). Update the Figma desktop app, or use direction: "HORIZONTAL"/"VERTICAL" auto-layout instead.',
        available: [],
        recovery: 'Retry without layoutMode: "GRID" (use direction instead), or update Figma.',
      };
    }
    if (typeof payload.gridRowCount === 'number') {
      try { frame.gridRowCount = payload.gridRowCount; } catch (eRc) { /* older Grid API surface — non-fatal */ }
    }
    if (typeof payload.gridColumnCount === 'number') {
      try { frame.gridColumnCount = payload.gridColumnCount; } catch (eCc) { /* older Grid API surface — non-fatal */ }
    }
    if (payload.gridRowGapVariable) {
      bt.track('gridRowGapVariable', bindVariable(frame, 'gridRowGap', payload.gridRowGapVariable), 'variable "' + payload.gridRowGapVariable + '" not found, or this Figma version has no gridRowGap property');
    } else if (typeof payload.gridRowGap === 'number') {
      try { frame.gridRowGap = payload.gridRowGap; } catch (eRg) { /* non-fatal */ }
    }
    if (payload.gridColumnGapVariable) {
      bt.track('gridColumnGapVariable', bindVariable(frame, 'gridColumnGap', payload.gridColumnGapVariable), 'variable "' + payload.gridColumnGapVariable + '" not found, or this Figma version has no gridColumnGap property');
    } else if (typeof payload.gridColumnGap === 'number') {
      try { frame.gridColumnGap = payload.gridColumnGap; } catch (eCg) { /* non-fatal */ }
    }
  } else {
    frame.layoutMode = requestedLayoutMode;
  }

  // Alignment
  if (payload.primaryAxisAlignItems) frame.primaryAxisAlignItems = payload.primaryAxisAlignItems;
  if (payload.counterAxisAlignItems) frame.counterAxisAlignItems = payload.counterAxisAlignItems;

  // Sizing — deferred to after appendChild (FILL requires auto-layout parent).
  // Smart defaults: FILL width in AL parents with deterministic width (FIXED/FILL).
  // HUG parents → children stay HUG (FILL in HUG = collapse to 0).
  // Explicit width/height → FIXED. Explicit sizing params always win.
  var parentIsAL = parent && parent.layoutMode && parent.layoutMode !== 'NONE';
  var parentHasWidth = parentIsAL && (parent.layoutSizingHorizontal === 'FIXED' || parent.layoutSizingHorizontal === 'FILL' || !parent.parent);
  var deferSizingH = payload.layoutSizingHorizontal
    || (payload.width ? 'FIXED' : (parentHasWidth ? 'FILL' : 'HUG'));
  var deferSizingV = payload.layoutSizingVertical
    || (payload.height ? 'FIXED' : 'HUG');

  // Fixed dimensions (for artboards and sized frames)
  if (payload.width || payload.height) {
    var w = payload.width || frame.width || 100;
    var h = payload.height || frame.height || 100;
    frame.resize(w, h);
  }
  if (payload.minWidth) frame.minWidth = payload.minWidth;
  if (payload.maxWidth) frame.maxWidth = payload.maxWidth;
  if (payload.minHeight) frame.minHeight = payload.minHeight;
  if (payload.maxHeight) frame.maxHeight = payload.maxHeight;

  // Clip
  if (typeof payload.clipsContent === 'boolean') frame.clipsContent = payload.clipsContent;

  // Position — deferred to after appendChild
  var deferX = payload.x;
  var deferY = payload.y;

  // ── DS Variable Bindings (tracked) ──

  // Gap (spacing)
  if (payload.gapVariable) {
    bt.track('gapVariable', bindVariable(frame, 'itemSpacing', payload.gapVariable), 'variable "' + payload.gapVariable + '" not found in cache (' + variableCache.size + ' cached)');
  } else if (typeof payload.gap === 'number') {
    frame.itemSpacing = payload.gap;
  }

  // Padding (spacing variables)
  if (payload.paddingTopVariable) {
    bt.track('paddingTopVariable', bindVariable(frame, 'paddingTop', payload.paddingTopVariable), 'variable "' + payload.paddingTopVariable + '" not found');
  } else if (typeof payload.paddingTop === 'number') {
    frame.paddingTop = payload.paddingTop;
  }

  if (payload.paddingRightVariable) {
    bt.track('paddingRightVariable', bindVariable(frame, 'paddingRight', payload.paddingRightVariable), 'variable "' + payload.paddingRightVariable + '" not found');
  } else if (typeof payload.paddingRight === 'number') {
    frame.paddingRight = payload.paddingRight;
  }

  if (payload.paddingBottomVariable) {
    bt.track('paddingBottomVariable', bindVariable(frame, 'paddingBottom', payload.paddingBottomVariable), 'variable "' + payload.paddingBottomVariable + '" not found');
  } else if (typeof payload.paddingBottom === 'number') {
    frame.paddingBottom = payload.paddingBottom;
  }

  if (payload.paddingLeftVariable) {
    bt.track('paddingLeftVariable', bindVariable(frame, 'paddingLeft', payload.paddingLeftVariable), 'variable "' + payload.paddingLeftVariable + '" not found');
  } else if (typeof payload.paddingLeft === 'number') {
    frame.paddingLeft = payload.paddingLeft;
  }

  // Shorthand padding (all sides same)
  if (payload.paddingVariable) {
    var padOk = bindVariable(frame, 'paddingTop', payload.paddingVariable)
             && bindVariable(frame, 'paddingRight', payload.paddingVariable)
             && bindVariable(frame, 'paddingBottom', payload.paddingVariable)
             && bindVariable(frame, 'paddingLeft', payload.paddingVariable);
    bt.track('paddingVariable', padOk, 'variable "' + payload.paddingVariable + '" not found');
  } else if (typeof payload.padding === 'number') {
    frame.paddingTop = payload.padding;
    frame.paddingRight = payload.padding;
    frame.paddingBottom = payload.padding;
    frame.paddingLeft = payload.padding;
  }

  // Fill (style → variable → raw color → fills array — with fallback chain)
  var fillApplied = false;
  if (payload.fillStyleId) {
    fillApplied = await applyFillStyle(frame, payload.fillStyleId);
    bt.track('fillStyleId', fillApplied, fillApplied ? null : 'fill style "' + payload.fillStyleId + '" not importable — falling through to fill/rawColor');
  }
  if (!fillApplied && payload.fillVariable) {
    fillApplied = bindFillVariable(frame, payload.fillVariable);
    bt.track('fillVariable', fillApplied, 'variable "' + payload.fillVariable + '" not found in cache (' + variableCache.size + ' cached)');
  }
  if (!fillApplied && payload.fill) {
    applySolidFill(frame, payload.fill);
    fillApplied = true;
  }
  if (!fillApplied && payload.rawColor) {
    applySolidFill(frame, payload.rawColor);
    fillApplied = true;
  }
  if (!fillApplied && payload.fills && Array.isArray(payload.fills) && payload.fills.length > 0) {
    var firstFill = payload.fills[0];
    if (firstFill && firstFill.color) {
      applySolidFill(frame, firstFill.color);
      fillApplied = true;
    }
  }
  if (!fillApplied) {
    frame.fills = [];
  }

  // Stroke (variable, single color, or strokes array)
  if (payload.strokeVariable) {
    bt.track('strokeVariable', bindStrokeVariable(frame, payload.strokeVariable), 'variable "' + payload.strokeVariable + '" not found');
    if (typeof payload.strokeWeight === 'number') frame.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) frame.strokeAlign = payload.strokeAlign;
  } else if (payload.stroke) {
    var strokeRgb = normalizeColor(payload.stroke);
    if (!strokeRgb) throw { error: 'INVALID_COLOR', message: 'Cannot parse stroke color: ' + JSON.stringify(payload.stroke), recovery: 'Use hex string or RGB object.' };
    frame.strokes = [{ type: 'SOLID', color: strokeRgb }];
    if (typeof payload.strokeWeight === 'number') frame.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) frame.strokeAlign = payload.strokeAlign;
  } else if (payload.strokes && Array.isArray(payload.strokes) && payload.strokes.length > 0) {
    var firstStroke = payload.strokes[0];
    if (firstStroke && firstStroke.color) {
      var sRgb = normalizeColor(firstStroke.color);
      if (sRgb) {
        frame.strokes = [{ type: 'SOLID', color: sRgb }];
        if (typeof payload.strokeWeight === 'number') frame.strokeWeight = payload.strokeWeight;
        else frame.strokeWeight = 1;
        if (payload.strokeAlign) frame.strokeAlign = payload.strokeAlign;
      }
    }
  }

  // Corner radius (radius variable)
  if (payload.cornerRadiusVariable) {
    var radOk = bindVariable(frame, 'topLeftRadius', payload.cornerRadiusVariable)
             && bindVariable(frame, 'topRightRadius', payload.cornerRadiusVariable)
             && bindVariable(frame, 'bottomLeftRadius', payload.cornerRadiusVariable)
             && bindVariable(frame, 'bottomRightRadius', payload.cornerRadiusVariable);
    bt.track('cornerRadiusVariable', radOk, 'variable "' + payload.cornerRadiusVariable + '" not found');
  } else if (typeof payload.cornerRadius === 'number') {
    frame.cornerRadius = payload.cornerRadius;
  }

  // Individual corner radii
  if (payload.topLeftRadiusVariable) bt.track('topLeftRadiusVariable', bindVariable(frame, 'topLeftRadius', payload.topLeftRadiusVariable), 'not found');
  if (payload.topRightRadiusVariable) bt.track('topRightRadiusVariable', bindVariable(frame, 'topRightRadius', payload.topRightRadiusVariable), 'not found');
  if (payload.bottomLeftRadiusVariable) bt.track('bottomLeftRadiusVariable', bindVariable(frame, 'bottomLeftRadius', payload.bottomLeftRadiusVariable), 'not found');
  if (payload.bottomRightRadiusVariable) bt.track('bottomRightRadiusVariable', bindVariable(frame, 'bottomRightRadius', payload.bottomRightRadiusVariable), 'not found');

  // Wrap
  if (payload.layoutWrap) frame.layoutWrap = payload.layoutWrap;

  // Append to parent
  parent.appendChild(frame);

  // Apply sizing AFTER appendChild (FILL requires auto-layout parent)
  try {
    frame.layoutSizingHorizontal = deferSizingH;
    frame.layoutSizingVertical = deferSizingV;
  } catch (e) { /* Page root — sizing not applicable */ }

  // Absolute positioning within AL parent (opt-in overlay)
  if (payload.layoutPositioning === 'ABSOLUTE') {
    try { frame.layoutPositioning = 'ABSOLUTE'; } catch (e) { /* parent may not be AL */ }
  }

  // Grid-child placement — only meaningful when `parent` is a GRID-layoutMode
  // frame; feature-detected + tracked (not thrown) so placing a span on a
  // non-grid parent, or on a pre-Grid Figma version, degrades to a no-op
  // reported in `warnings` rather than failing the whole frame creation.
  if (typeof payload.gridRowSpan === 'number') {
    bt.track('gridRowSpan', (function () { try { frame.gridRowSpan = payload.gridRowSpan; return true; } catch (e) { return false; } })(), 'parent is not a GRID layout, or this Figma version has no gridRowSpan property');
  }
  if (typeof payload.gridColumnSpan === 'number') {
    bt.track('gridColumnSpan', (function () { try { frame.gridColumnSpan = payload.gridColumnSpan; return true; } catch (e) { return false; } })(), 'parent is not a GRID layout, or this Figma version has no gridColumnSpan property');
  }

  // Apply position AFTER appendChild
  // Auto-position: when parent is a SECTION or PAGE and no x/y provided,
  // place to the right of the rightmost sibling with 80px gap.
  if (typeof deferX !== 'number' && typeof deferY !== 'number') {
    var isSection = parent.type === 'SECTION';
    var isPage = parent.type === 'PAGE';
    if (isSection || isPage) {
      var rightmostX = 0;
      var rightmostW = 0;
      var siblings = parent.children;
      for (var si = 0; si < siblings.length; si++) {
        var sib = siblings[si];
        if (sib.id === frame.id) continue;
        var sibRight = sib.x + sib.width;
        if (sibRight > rightmostX + rightmostW) {
          rightmostX = sib.x;
          rightmostW = sib.width;
        }
      }
      if (siblings.length > 1) { // more than just the new frame
        frame.x = rightmostX + rightmostW + 80;
        frame.y = siblings[0].id !== frame.id ? siblings[0].y : 0;
      }
    }
  } else {
    if (typeof deferX === 'number') frame.x = deferX;
    if (typeof deferY === 'number') frame.y = deferY;
  }

  var bindingResult = bt.result();
  return {
    nodeId: frame.id,
    name: frame.name,
    type: 'FRAME',
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
  };
};

handlers.create_text = async function (payload) {
  // Enforcement gates
  enforceText(payload);
  enforceColorFill(payload, 'TEXT');

  var parent = getParent(payload.parentId);
  var bt = createBindingTracker();

  // Load font BEFORE creating text node — some Figma versions
  // require the font loaded even for the initial empty text
  var fontFamily = payload.fontFamily || 'Inter';
  var fontStyle = payload.fontStyle || 'Regular';
  await figma.loadFontAsync({ family: fontFamily, style: fontStyle });

  var text = figma.createText();
  text.name = payload.name || 'Text';

  // Apply text style if provided
  var textStyleApplied = false;
  var textStyleName = null;
  if (payload.textStyleId) {
    try {
      var style = styleCache.get(payload.textStyleId);
      if (!style) {
        // Try importing from library by key with timeout
        style = await Promise.race([
          figma.importStyleByKeyAsync(payload.textStyleId),
          new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('TEXT_STYLE_IMPORT_TIMEOUT')); }, 10000);
          })
        ]);
      }
      if (style && style.type === 'TEXT') {
        text.textStyleId = style.id;
        textStyleApplied = true;
        textStyleName = style.name;
      }
    } catch (e) { /* Style not available */ }
    bt.track('textStyle', textStyleApplied, textStyleApplied ? null : 'style "' + payload.textStyleId + '" not found or not importable (styleCache: ' + styleCache.size + ')');
  }

  // Set content (font is loaded)
  if (payload.characters || payload.content) {
    text.characters = payload.characters || payload.content || '';
  }

  // Font size (raw, when no DS text styles)
  if (payload.fontSize && !payload.textStyleId) text.fontSize = payload.fontSize;

  // Typography variable bindings
  if (payload.fontSizeVariable) bt.track('fontSizeVariable', bindVariable(text, 'fontSize', payload.fontSizeVariable), 'variable "' + payload.fontSizeVariable + '" not found');
  if (payload.lineHeightVariable) bt.track('lineHeightVariable', bindVariable(text, 'lineHeight', payload.lineHeightVariable), 'variable "' + payload.lineHeightVariable + '" not found');
  if (payload.letterSpacingVariable) bt.track('letterSpacingVariable', bindVariable(text, 'letterSpacing', payload.letterSpacingVariable), 'variable "' + payload.letterSpacingVariable + '" not found');

  // Fill (text color: style → variable → raw — with fallback)
  var textFillApplied = false;
  if (payload.fillStyleId) {
    textFillApplied = await applyFillStyle(text, payload.fillStyleId);
    bt.track('fillStyleId', textFillApplied, textFillApplied ? null : 'fill style not importable — falling through');
  }
  if (!textFillApplied && payload.fillVariable) {
    textFillApplied = bindFillVariable(text, payload.fillVariable);
    bt.track('fillVariable', textFillApplied, 'variable not found');
  }
  if (!textFillApplied && payload.fill) {
    applySolidFill(text, payload.fill);
  }
  if (!textFillApplied && !payload.fill && payload.rawColor) {
    applySolidFill(text, payload.rawColor);
  }

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

  // Apply sizing after appending (requires auto-layout parent).
  // Default: FILL width in AL parents with deterministic width, HUG otherwise.
  var parentIsAL = parent && parent.layoutMode && parent.layoutMode !== 'NONE';
  var parentHasWidth = parentIsAL && (parent.layoutSizingHorizontal === 'FIXED' || parent.layoutSizingHorizontal === 'FILL' || !parent.parent);
  try {
    text.layoutSizingHorizontal = payload.layoutSizingHorizontal
      || (payload.width ? 'FIXED' : (parentHasWidth ? 'FILL' : 'HUG'));
  } catch (e) { /* Parent isn't auto-layout */ }

  // Absolute positioning within AL parent (opt-in overlay)
  if (payload.layoutPositioning === 'ABSOLUTE') {
    try { text.layoutPositioning = 'ABSOLUTE'; } catch (e) {}
  }

  var bindingResult = bt.result();
  return {
    nodeId: text.id,
    name: text.name,
    type: 'TEXT',
    characters: text.characters,
    textStyleName: textStyleName,
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
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

  // Import by key. DS discovery knows whether a key belongs to a component set
  // or a single component, so honor that hint to avoid waiting on the wrong
  // Figma import API before falling back.
  function importComponent(key) {
    if (payload.importMode === 'component') {
      return figma.importComponentByKeyAsync(key).catch(function () {
        throw { error: 'COMPONENT_NOT_FOUND', message: 'Could not import component: ' + key };
      });
    }

    if (payload.importMode === 'componentSet') {
      return figma.importComponentSetByKeyAsync(key).then(function (componentSet) {
        if (!componentSet || !('children' in componentSet) || componentSet.children.length === 0) {
          throw { error: 'EMPTY_SET' };
        }
        return componentSet.children[0];
      }).catch(function () {
        throw { error: 'COMPONENT_SET_NOT_FOUND', message: 'Could not import component set: ' + key };
      });
    }

    return figma.importComponentSetByKeyAsync(key).then(function (componentSet) {
      if (!componentSet || !('children' in componentSet) || componentSet.children.length === 0) {
        throw { error: 'EMPTY_SET' };
      }
      return componentSet.children[0];
    }).catch(function (setErr) {
      // Not a set — try as single component
      return figma.importComponentByKeyAsync(key).catch(function () {
        throw { error: 'COMPONENT_NOT_FOUND', message: 'Could not import as component or component set: ' + key };
      });
    });
  }

  // ── B13 guard: timeout vs. late-import race ──────────────────────────
  // A slow importComponentByKeyAsync/importComponentSetByKeyAsync call
  // keeps running in the background even after the 15s timeout below has
  // already rejected and surfaced INSERT_TIMEOUT to the caller (per
  // CLAUDE.md's INSERT_TIMEOUT recovery protocol, the caller checks
  // figma_get_node_children and may retry). If that late import then
  // resolved and this code unconditionally called imported.createInstance()
  // on it, a retry could end up racing its own late-resolving predecessor —
  // two instances for one insert. `timedOut` tracks whether the timeout
  // already fired; the "create instance" branch below is gated on it, so
  // a late resolution after timeout is a no-op instead of a duplicate
  // instance. clearTimeout stops the pending rejection once the fast
  // path wins normally, so it never fires after a successful insert.
  var timedOut = false;
  var timeoutHandle = null;

  var timeoutPromise = new Promise(function (_, reject) {
    timeoutHandle = setTimeout(function () {
      timedOut = true;
      reject({ error: 'INSERT_TIMEOUT', message: 'Component import timed out after 15s for key: ' + payload.componentKey });
    }, 15000);
  });

  var importAndBuild = importComponent(payload.componentKey).then(function (imported) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut) {
      // The timeout already fired and INSERT_TIMEOUT was already surfaced
      // to the caller for this call — do not create an instance from this
      // late resolution (prevents the duplicate-instance race, audit B13).
      return null;
    }

    var instance = imported.createInstance();
    instance.name = payload.name || imported.name;

    // Defer sizing to after appendChild
    var deferInstSizingH = payload.layoutSizingHorizontal || 'HUG';
    var deferInstSizingV = payload.layoutSizingVertical || 'HUG';

    // Position
    if (typeof payload.x === 'number') instance.x = payload.x;
    if (typeof payload.y === 'number') instance.y = payload.y;

    // Append to parent
    parent.appendChild(instance);

    // Apply sizing after appendChild
    try {
      instance.layoutSizingHorizontal = deferInstSizingH;
      instance.layoutSizingVertical = deferInstSizingV;
    } catch (e) { /* not in auto-layout parent */ }

    // Grid-child placement (per-instance alternative to figma_set_layout_
    // sizing's gridRowSpan/gridColumnSpan) — only meaningful when `parent`
    // is a GRID-layoutMode frame; feature-detected, non-fatal on failure.
    var gridSpanWarnings = [];
    if (typeof payload.gridRowSpan === 'number') {
      try { instance.gridRowSpan = payload.gridRowSpan; } catch (eRs) { gridSpanWarnings.push('gridRowSpan: parent is not a GRID layout, or this Figma version has no gridRowSpan property'); }
    }
    if (typeof payload.gridColumnSpan === 'number') {
      try { instance.gridColumnSpan = payload.gridColumnSpan; } catch (eCs) { gridSpanWarnings.push('gridColumnSpan: parent is not a GRID layout, or this Figma version has no gridColumnSpan property'); }
    }

    // ── Auto-disable all boolean properties ──────────────────────
    // Booleans default ON in most DS components (hint text, help icons,
    // trailing icons, asterisks, etc.).  The builder should only re-enable
    // what the source HTML actually shows.  Disabling at insertion time
    // eliminates the most common configuration mistake: forgetting to
    // toggle off booleans that produce visual noise (issue #5/#6).
    var disabledBooleans = [];
    try {
      var props = instance.componentProperties;
      if (props) {
        var keys = Object.keys(props);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (props[key].type === 'BOOLEAN' && props[key].value === true) {
            var update = {};
            update[key] = false;
            instance.setProperties(update);
            disabledBooleans.push(key);
          }
        }
      }
    } catch (e) { /* some instances don't support setProperties */ }

    // Collect configuration hints
    var hints = collectConfigurationHints(instance);

    return {
      nodeId: instance.id,
      name: instance.name,
      type: 'INSTANCE',
      componentName: imported.name,
      componentKey: payload.componentKey,
      resolvedVariantKey: imported.key || payload.componentKey,
      configurationHints: hints,
      disabledBooleans: disabledBooleans,
      gridSpanWarnings: gridSpanWarnings.length > 0 ? gridSpanWarnings : undefined,
    };
  });

  return Promise.race([importAndBuild, timeoutPromise]);
};

// ── Slots (Figma Slots, GA June 2026) ───────────────────────────────────────────
//
// Finds the SLOT-typed component property on an instance matching `slotName`
// (by stripped base name — see stripPropSuffix). Returns { matchedKey, slotKeys }
// where slotKeys lists every SLOT property name found (for the "available"
// hint on a not-found error). Feature-detection is implicit: on a Figma
// version that predates Slots, no componentProperties entry ever has
// type === 'SLOT', so this simply reports SLOT_NOT_FOUND with an empty
// `available` list rather than crashing on an unknown API shape.
function findSlotProperty(node, slotName) {
  var props = node.componentProperties || {};
  var keys = Object.keys(props);
  var slotKeys = [];
  var matchedKey = null;
  for (var i = 0; i < keys.length; i++) {
    if (props[keys[i]].type === 'SLOT') {
      var baseName = stripPropSuffix(keys[i]);
      slotKeys.push(baseName);
      if (baseName === slotName) matchedKey = keys[i];
    }
  }
  return { matchedKey: matchedKey, slotKeys: slotKeys };
}

/**
 * handlers.fill_slot — inserts a DS component instance INTO a SLOT-type
 * component property on an existing instance.
 *
 * API SHAPE ASSUMED, NOT VERIFIED (flagged per the worker instructions —
 * no live Figma Slots-enabled file was available to confirm against real
 * docs/behavior): the Slots feature (SlotNode, createSlot()/resetSlot())
 * went GA June 2026, but its plugin-API write shape for "fill this slot
 * with an instance" has no confirmed public example as of this change.
 * SLOT is simply another entry in componentProperties/
 * componentPropertyDefinitions (same family as BOOLEAN/TEXT/INSTANCE_SWAP),
 * and this codebase's one existing mechanism for writing an INSTANCE_SWAP-
 * shaped property is `instance.setProperties({ [key]: value })` (see
 * handlers.set_variant) — so that is tried FIRST, passing the newly created
 * fill instance's node id as the value, mirroring INSTANCE_SWAP semantics.
 * A `node.fillSlot(key, instance)`-style method is tried as a fallback in
 * case the real API instead exposes a dedicated slot-write call. If neither
 * works, a structured SLOT_FILL_UNSUPPORTED error is returned (never thrown
 * as an opaque error) so the caller gets a clear "needs manual verification"
 * signal instead of a silent no-op or a crash. MANUAL VERIFICATION NEEDED.
 */
handlers.fill_slot = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (!payload.slotName) throw { error: 'MISSING_PARAM', property: 'slotName', message: 'slotName is required.', available: [], recovery: 'Provide the SLOT property name from configurationHints.slotProperties.' };
  if (!payload.componentKey) throw { error: 'MISSING_PARAM', property: 'componentKey', message: 'componentKey is required.', available: [], recovery: 'Provide the DS component key to insert into the slot.' };

  var found = findSlotProperty(node, payload.slotName);
  if (!found.matchedKey) {
    throw {
      error: 'SLOT_NOT_FOUND',
      property: 'slotName',
      message: 'No SLOT-type component property named "' + payload.slotName + '" found on this instance. Either this Figma version does not support Slots, or the component has no slot with that name.',
      available: found.slotKeys,
      recovery: 'Check configurationHints.slotProperties from figma_insert_component for the exact slot name.',
    };
  }

  return figma.importComponentByKeyAsync(payload.componentKey).then(function (imported) {
    var fillInstance = imported.createInstance();
    var matchedKey = found.matchedKey;
    var filled = false;
    try {
      var update = {};
      update[matchedKey] = fillInstance.id;
      node.setProperties(update);
      filled = true;
    } catch (eSetProps) {
      try {
        if (typeof node.fillSlot === 'function') {
          node.fillSlot(matchedKey, fillInstance);
          filled = true;
        }
      } catch (eFillSlot) { /* both attempts failed — handled below */ }
    }

    if (!filled) {
      throw {
        error: 'SLOT_FILL_UNSUPPORTED',
        property: 'slotName',
        message: 'Could not fill slot "' + payload.slotName + '" — the Slots plugin-API write shape this handler assumes (setProperties, then a fillSlot() fallback) did not work on this instance. Needs manual verification against a live Figma Slots-enabled file.',
        available: [],
        recovery: 'Report this for manual verification — the SLOT write API shape needs confirming against real Figma docs/behavior.',
      };
    }

    var hints = collectConfigurationHints(node);
    return {
      nodeId: node.id,
      slotName: payload.slotName,
      filledWithKey: payload.componentKey,
      filledInstanceId: fillInstance.id,
      configurationHints: hints,
    };
  });
};

/**
 * handlers.reset_slot — restores a SLOT-type component property to its
 * default content.
 *
 * API SHAPE ASSUMED, NOT VERIFIED (see handlers.fill_slot doc comment for
 * the same caveat). resetSlot() is the documented Slots-GA method name, but
 * which object it lives on (the instance? the SLOT node the property
 * currently points at?) has no confirmed public example. Both plausible
 * call sites are tried; if neither exists, a structured
 * SLOT_RESET_UNSUPPORTED error is returned. MANUAL VERIFICATION NEEDED.
 */
handlers.reset_slot = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (!payload.slotName) throw { error: 'MISSING_PARAM', property: 'slotName', message: 'slotName is required.', available: [], recovery: 'Provide the SLOT property name.' };

  var found = findSlotProperty(node, payload.slotName);
  if (!found.matchedKey) {
    throw {
      error: 'SLOT_NOT_FOUND',
      property: 'slotName',
      message: 'No SLOT-type component property named "' + payload.slotName + '" found on this instance.',
      available: found.slotKeys,
      recovery: 'Check configurationHints.slotProperties for the exact slot name.',
    };
  }

  var resetOk = false;
  try {
    if (typeof node.resetSlot === 'function') {
      node.resetSlot(found.matchedKey);
      resetOk = true;
    }
  } catch (eResetOnNode) { /* fall through to alternate call site */ }

  if (!resetOk) {
    try {
      var props = node.componentProperties || {};
      var current = props[found.matchedKey] && props[found.matchedKey].value;
      var currentNode = current ? figma.getNodeById(normalizeNodeId(current)) : null;
      if (currentNode && typeof currentNode.resetSlot === 'function') {
        currentNode.resetSlot();
        resetOk = true;
      }
    } catch (eResetOnSlotNode) { /* fall through */ }
  }

  if (!resetOk) {
    throw {
      error: 'SLOT_RESET_UNSUPPORTED',
      property: 'slotName',
      message: 'Could not reset slot "' + payload.slotName + '" — this Figma version may not support resetSlot(), or the API shape differs from what this handler assumes. Needs manual verification against a live Figma Slots-enabled file.',
      available: [],
      recovery: 'Report this for manual verification.',
    };
  }

  var hints = collectConfigurationHints(node);
  return {
    nodeId: node.id,
    slotName: payload.slotName,
    reset: true,
    configurationHints: hints,
  };
};

// ── Stubs for Task 9 — Shape creation ──────────────────────────────────────────

handlers.create_rectangle = async function (payload) {
  enforceColorFill(payload, 'RECTANGLE');
  var parent = getParent(payload.parentId);
  var rect = figma.createRectangle();
  var bt = createBindingTracker();

  rect.name = payload.name || 'Rectangle';

  // Sizing (defer FILL to after appendChild)
  // Handle partial dimensions: width-only, height-only, or both.
  // Figma's resize() requires both — use current dimension as fallback.
  var hasW = typeof payload.width === 'number';
  var hasH = typeof payload.height === 'number';
  if (hasW && hasH) {
    rect.resize(payload.width, payload.height);
  } else if (hasW) {
    rect.resize(payload.width, rect.height);
  } else if (hasH) {
    rect.resize(rect.width, payload.height);
  }
  // Auto-default: when dimensions are specified, default to FIXED so auto-layout
  // doesn't stretch the rectangle. Explicit layoutSizing overrides this.
  var deferRectSizingH = payload.layoutSizingHorizontal
    || (hasW ? 'FIXED' : undefined);
  var deferRectSizingV = payload.layoutSizingVertical
    || (hasH ? 'FIXED' : undefined);

  // Position
  if (typeof payload.x === 'number') rect.x = payload.x;
  if (typeof payload.y === 'number') rect.y = payload.y;

  // Fill (style → variable → raw — with fallback)
  var rectFillApplied = false;
  if (payload.fillStyleId) {
    rectFillApplied = await applyFillStyle(rect, payload.fillStyleId);
    bt.track('fillStyleId', rectFillApplied, rectFillApplied ? null : 'fill style not importable — falling through');
  }
  if (!rectFillApplied && payload.fillVariable) {
    rectFillApplied = bindFillVariable(rect, payload.fillVariable);
    bt.track('fillVariable', rectFillApplied, 'variable not found');
  }
  if (!rectFillApplied && payload.fill) { applySolidFill(rect, payload.fill); rectFillApplied = true; }
  if (!rectFillApplied && payload.rawColor) { applySolidFill(rect, payload.rawColor); rectFillApplied = true; }
  if (!rectFillApplied && payload.fills && Array.isArray(payload.fills) && payload.fills.length > 0) {
    var rectFirstFill = payload.fills[0];
    if (rectFirstFill && rectFirstFill.color) { applySolidFill(rect, rectFirstFill.color); rectFillApplied = true; }
  }

  // Stroke
  if (payload.strokeVariable) {
    bt.track('strokeVariable', bindStrokeVariable(rect, payload.strokeVariable), 'variable "' + payload.strokeVariable + '" not found');
    if (typeof payload.strokeWeight === 'number') rect.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) rect.strokeAlign = payload.strokeAlign;
  } else if (payload.stroke) {
    var strokeRgb = normalizeColor(payload.stroke);
    if (!strokeRgb) throw { error: 'INVALID_COLOR', message: 'Cannot parse stroke color: ' + JSON.stringify(payload.stroke), recovery: 'Use hex string or RGB object.' };
    rect.strokes = [{ type: 'SOLID', color: strokeRgb }];
    if (typeof payload.strokeWeight === 'number') rect.strokeWeight = payload.strokeWeight;
    if (payload.strokeAlign) rect.strokeAlign = payload.strokeAlign;
  } else if (payload.strokes && Array.isArray(payload.strokes) && payload.strokes.length > 0) {
    var firstStroke = payload.strokes[0];
    if (firstStroke && firstStroke.color) {
      var sRgb = normalizeColor(firstStroke.color);
      if (sRgb) {
        rect.strokes = [{ type: 'SOLID', color: sRgb }];
        if (typeof payload.strokeWeight === 'number') rect.strokeWeight = payload.strokeWeight;
      }
    }
  }

  // Corner radius
  if (payload.cornerRadiusVariable) {
    var radOk = bindVariable(rect, 'topLeftRadius', payload.cornerRadiusVariable)
             && bindVariable(rect, 'topRightRadius', payload.cornerRadiusVariable)
             && bindVariable(rect, 'bottomLeftRadius', payload.cornerRadiusVariable)
             && bindVariable(rect, 'bottomRightRadius', payload.cornerRadiusVariable);
    bt.track('cornerRadiusVariable', radOk, 'variable "' + payload.cornerRadiusVariable + '" not found');
  } else if (typeof payload.cornerRadius === 'number') {
    rect.cornerRadius = payload.cornerRadius;
  }

  // Individual corner radii
  if (payload.topLeftRadiusVariable) bt.track('topLeftRadiusVariable', bindVariable(rect, 'topLeftRadius', payload.topLeftRadiusVariable), 'not found');
  if (payload.topRightRadiusVariable) bt.track('topRightRadiusVariable', bindVariable(rect, 'topRightRadius', payload.topRightRadiusVariable), 'not found');
  if (payload.bottomLeftRadiusVariable) bt.track('bottomLeftRadiusVariable', bindVariable(rect, 'bottomLeftRadius', payload.bottomLeftRadiusVariable), 'not found');
  if (payload.bottomRightRadiusVariable) bt.track('bottomRightRadiusVariable', bindVariable(rect, 'bottomRightRadius', payload.bottomRightRadiusVariable), 'not found');

  // Opacity
  if (typeof payload.opacity === 'number') rect.opacity = payload.opacity;

  parent.appendChild(rect);
  if (payload.layoutPositioning === 'ABSOLUTE') {
    try { rect.layoutPositioning = 'ABSOLUTE'; } catch (e) {}
  }
  try {
    if (deferRectSizingH) rect.layoutSizingHorizontal = deferRectSizingH;
    if (deferRectSizingV) rect.layoutSizingVertical = deferRectSizingV;
  } catch (e) { /* not in auto-layout parent */ }

  var bindingResult = bt.result();
  return {
    nodeId: rect.id,
    name: rect.name,
    type: 'RECTANGLE',
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
  };
};

handlers.create_ellipse = async function (payload) {
  enforceColorFill(payload, 'ELLIPSE');
  var parent = getParent(payload.parentId);
  var ellipse = figma.createEllipse();
  var bt = createBindingTracker();

  ellipse.name = payload.name || 'Ellipse';

  // Sizing (defer FILL to after appendChild)
  var eHasW = typeof payload.width === 'number';
  var eHasH = typeof payload.height === 'number';
  if (eHasW && eHasH) ellipse.resize(payload.width, payload.height);
  else if (eHasW) ellipse.resize(payload.width, ellipse.height);
  else if (eHasH) ellipse.resize(ellipse.width, payload.height);
  var deferEllipseSizingH = payload.layoutSizingHorizontal || (eHasW ? 'FIXED' : undefined);
  var deferEllipseSizingV = payload.layoutSizingVertical || (eHasH ? 'FIXED' : undefined);

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

  // Fill (style → variable → raw — with fallback)
  var ellFillApplied = false;
  if (payload.fillStyleId) {
    ellFillApplied = await applyFillStyle(ellipse, payload.fillStyleId);
    bt.track('fillStyleId', ellFillApplied, ellFillApplied ? null : 'fill style not importable — falling through');
  }
  if (!ellFillApplied && payload.fillVariable) {
    ellFillApplied = bindFillVariable(ellipse, payload.fillVariable);
    bt.track('fillVariable', ellFillApplied, 'variable not found');
  }
  if (!ellFillApplied && payload.fill) { applySolidFill(ellipse, payload.fill); ellFillApplied = true; }
  if (!ellFillApplied && payload.rawColor) { applySolidFill(ellipse, payload.rawColor); ellFillApplied = true; }
  if (!ellFillApplied && payload.fills && Array.isArray(payload.fills) && payload.fills.length > 0) {
    var ellipseFirstFill = payload.fills[0];
    if (ellipseFirstFill && ellipseFirstFill.color) { applySolidFill(ellipse, ellipseFirstFill.color); ellFillApplied = true; }
  }

  // Stroke
  if (payload.strokeVariable) {
    bt.track('strokeVariable', bindStrokeVariable(ellipse, payload.strokeVariable), 'variable "' + payload.strokeVariable + '" not found');
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
  if (payload.layoutPositioning === 'ABSOLUTE') {
    try { ellipse.layoutPositioning = 'ABSOLUTE'; } catch (e) {}
  }
  try {
    if (deferEllipseSizingH) ellipse.layoutSizingHorizontal = deferEllipseSizingH;
    if (deferEllipseSizingV) ellipse.layoutSizingVertical = deferEllipseSizingV;
  } catch (e) { /* not in auto-layout parent */ }

  var bindingResult = bt.result();
  return {
    nodeId: ellipse.id,
    name: ellipse.name,
    type: 'ELLIPSE',
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
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

  // Sizing (defer FILL to after appendChild)
  var sHasW = typeof payload.width === 'number';
  var sHasH = typeof payload.height === 'number';
  if (sHasW && sHasH) svgNode.resize(payload.width, payload.height);
  else if (sHasW) svgNode.resize(payload.width, svgNode.height);
  else if (sHasH) svgNode.resize(svgNode.width, payload.height);
  var deferSvgSizingH = payload.layoutSizingHorizontal || (sHasW ? 'FIXED' : undefined);
  var deferSvgSizingV = payload.layoutSizingVertical || (sHasH ? 'FIXED' : undefined);

  // Optionally apply fill/stroke variables to child vectors
  var bt = createBindingTracker();
  if (payload.fillVariable || payload.strokeVariable) {
    var fillOk = true;
    var strokeOk = true;
    var vectorCount = 0;
    function walkVectors(node) {
      if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' || node.type === 'STAR' || node.type === 'LINE' || node.type === 'POLYGON') {
        vectorCount++;
        if (payload.fillVariable && !bindFillVariable(node, payload.fillVariable)) fillOk = false;
        if (payload.strokeVariable && !bindStrokeVariable(node, payload.strokeVariable)) strokeOk = false;
      }
      if ('children' in node) {
        for (var i = 0; i < node.children.length; i++) {
          walkVectors(node.children[i]);
        }
      }
    }
    walkVectors(svgNode);
    if (payload.fillVariable) bt.track('fillVariable', fillOk, fillOk ? null : 'variable "' + payload.fillVariable + '" not found (applied to ' + vectorCount + ' vectors)');
    if (payload.strokeVariable) bt.track('strokeVariable', strokeOk, strokeOk ? null : 'variable "' + payload.strokeVariable + '" not found');
  }

  parent.appendChild(svgNode);
  try {
    if (deferSvgSizingH) svgNode.layoutSizingHorizontal = deferSvgSizingH;
    if (deferSvgSizingV) svgNode.layoutSizingVertical = deferSvgSizingV;
  } catch (e) { /* not in auto-layout parent */ }

  // ── Enumerate unbound children for post-creation binding ──
  var unboundChildren = [];
  var childSummary = { vectors: 0, texts: 0, boundVectors: 0, boundTexts: 0 };
  function walkForUnbound(node) {
    if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' || node.type === 'STAR' || node.type === 'LINE' || node.type === 'POLYGON' || node.type === 'ELLIPSE') {
      childSummary.vectors++;
      // Check if fill is DS-bound (has boundVariables)
      var hasFillBinding = node.boundVariables && node.boundVariables.fills && node.boundVariables.fills.length > 0;
      if (hasFillBinding) {
        childSummary.boundVectors++;
      } else {
        unboundChildren.push({ nodeId: node.id, type: node.type, name: node.name });
      }
    } else if (node.type === 'TEXT') {
      childSummary.texts++;
      var hasTextFillBinding = node.boundVariables && node.boundVariables.fills && node.boundVariables.fills.length > 0;
      if (hasTextFillBinding) {
        childSummary.boundTexts++;
      } else {
        unboundChildren.push({ nodeId: node.id, type: 'TEXT', name: node.name, characters: node.characters ? node.characters.substring(0, 40) : '' });
      }
    }
    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) {
        walkForUnbound(node.children[i]);
      }
    }
  }
  walkForUnbound(svgNode);

  var bindingResult = bt.result();
  return {
    nodeId: svgNode.id,
    name: svgNode.name,
    type: 'FRAME',
    width: Math.round(svgNode.width),
    height: Math.round(svgNode.height),
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
    unboundChildren: unboundChildren,
    childSummary: childSummary,
  };
};

// ── Stubs for Task 9 — Edit handlers ───────────────────────────────────────────

handlers.set_component_text = async function (payload) {
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

  await ensureFontLoaded(found);
  found.characters = content;

  // Optionally apply fill variable to the text
  var bt = createBindingTracker();
  if (payload.fillVariable) {
    bt.track('fillVariable', bindFillVariable(found, payload.fillVariable), 'variable "' + payload.fillVariable + '" not found');
  }

  var bindingResult = bt.result();
  return {
    nodeId: found.id,
    name: found.name,
    type: 'TEXT',
    characters: found.characters,
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
  };
};

handlers.set_component_text_by_id = async function (payload) {
  var root = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!root) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check component instance nodeId.' };

  var found = figma.getNodeById(normalizeNodeId(payload.textNodeId));
  if (!found) throw { error: 'NODE_NOT_FOUND', property: 'textNodeId', message: 'Text node not found: ' + payload.textNodeId, available: [], recovery: 'Use a textNodeId returned in configurationHints.textNodes.' };
  if (found.type !== 'TEXT') throw { error: 'INVALID_NODE_TYPE', property: 'textNodeId', message: 'Node is not a text node: ' + found.type, available: [], recovery: 'Provide a TEXT node ID from configurationHints.textNodes.' };

  var belongsToRoot = false;
  function walk(n) {
    if (belongsToRoot) return;
    if (n.id === found.id) {
      belongsToRoot = true;
      return;
    }
    if ('children' in n) {
      for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
    }
  }
  walk(root);

  if (!belongsToRoot) {
    throw {
      error: 'TEXT_NODE_OUTSIDE_COMPONENT',
      property: 'textNodeId',
      message: 'Text node ' + payload.textNodeId + ' is not inside component node ' + payload.nodeId,
      available: [],
      recovery: 'Use a textNodeId from the same component instance configurationHints.',
    };
  }

  var content = payload.content || payload.characters || '';
  await ensureFontLoaded(found);
  found.characters = content;

  var bt = createBindingTracker();
  if (payload.fillVariable) {
    bt.track('fillVariable', bindFillVariable(found, payload.fillVariable), 'variable "' + payload.fillVariable + '" not found');
  }

  var bindingResult = bt.result();
  return {
    nodeId: found.id,
    parentNodeId: root.id,
    name: found.name,
    type: 'TEXT',
    characters: found.characters,
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
  };
};

handlers.batch_set_component_text = async function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  var overrides = payload.overrides || [];
  if (!Array.isArray(overrides) || overrides.length === 0) {
    throw { error: 'EMPTY_OVERRIDES', message: 'overrides array is required and must not be empty.', available: [], recovery: 'Provide [{textNodeName, content}] array.' };
  }

  // Collect all text nodes in one walk
  var textNodes = {};
  function walk(n) {
    if (n.type === 'TEXT') {
      // Store first match per name (same as set_component_text)
      if (!textNodes[n.name]) textNodes[n.name] = n;
    }
    if ('children' in n) {
      for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
    }
  }
  walk(node);

  var results = [];
  var bt = createBindingTracker();

  for (var i = 0; i < overrides.length; i++) {
    var ov = overrides[i];
    var textNodeName = ov.textNodeName;
    var content = ov.content || '';
    var found = textNodes[textNodeName] || null;

    if (!found) {
      results.push({
        textNodeName: textNodeName,
        ok: false,
        error: 'TEXT_NODE_NOT_FOUND',
        available: Object.keys(textNodes),
      });
      continue;
    }

    await ensureFontLoaded(found);
    found.characters = content;

    if (ov.fillVariable) {
      bt.track('fillVariable[' + textNodeName + ']', bindFillVariable(found, ov.fillVariable), 'variable "' + ov.fillVariable + '" not found');
    }

    results.push({
      textNodeName: textNodeName,
      nodeId: found.id,
      ok: true,
      characters: content,
    });
  }

  var bindingResult = bt.result();
  return {
    nodeId: node.id,
    total: overrides.length,
    succeeded: results.filter(function (r) { return r.ok; }).length,
    failed: results.filter(function (r) { return !r.ok; }).length,
    results: results,
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
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
    // Coerce string booleans to actual booleans for BOOLEAN component properties
    var value = properties[key];
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    try {
      node.setProperties({ [key]: value });
      applied[key] = value;
    } catch (e) {
      // Try via componentProperties path
      try {
        var cp = node.componentProperties;
        if (cp && cp[key] !== undefined) {
          node.setProperties({ [key]: value });
          applied[key] = value;
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

handlers.set_text = async function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (node.type !== 'TEXT') throw { error: 'INVALID_NODE_TYPE', property: 'nodeId', message: 'Node is not a text node: ' + node.type, available: [], recovery: 'Provide a TEXT nodeId.' };

  var content = payload.content || payload.characters || '';
  await ensureFontLoaded(node);
  node.characters = content;

  return {
    nodeId: node.id,
    name: node.name,
    type: 'TEXT',
    characters: node.characters,
  };
};

handlers.set_node_fill = async function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  var bt = createBindingTracker();

  var snfApplied = false;
  if (payload.fillStyleId) {
    snfApplied = await applyFillStyle(node, payload.fillStyleId);
    bt.track('fillStyleId', snfApplied, snfApplied ? null : 'fill style not importable — falling through');
  }
  if (!snfApplied && payload.fillVariable) {
    snfApplied = bindFillVariable(node, payload.fillVariable);
    bt.track('fillVariable', snfApplied, 'variable not found');
  }
  if (!snfApplied && payload.fill) { applySolidFill(node, payload.fill); snfApplied = true; }
  if (!snfApplied && payload.rawColor) { applySolidFill(node, payload.rawColor); snfApplied = true; }
  if (!snfApplied && payload.fills && Array.isArray(payload.fills) && payload.fills.length > 0) {
    var snfFirstFill = payload.fills[0];
    if (snfFirstFill && snfFirstFill.color) { applySolidFill(node, snfFirstFill.color); snfApplied = true; }
  }
  if (!snfApplied) { node.fills = []; }

  var bindingResult = bt.result();
  return {
    nodeId: node.id,
    name: node.name,
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
  };
};

handlers.set_layout_sizing = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  var bt = createBindingTracker();

  if (payload.layoutSizingHorizontal) node.layoutSizingHorizontal = payload.layoutSizingHorizontal;
  if (payload.layoutSizingVertical) node.layoutSizingVertical = payload.layoutSizingVertical;

  // Resize when explicit width/height provided
  if (typeof payload.width === 'number' || typeof payload.height === 'number') {
    var w = typeof payload.width === 'number' ? payload.width : node.width;
    var h = typeof payload.height === 'number' ? payload.height : node.height;
    node.resize(w, h);
  }

  // Max/min constraints
  if (typeof payload.maxWidth === 'number') node.maxWidth = payload.maxWidth;
  if (typeof payload.minWidth === 'number') node.minWidth = payload.minWidth;
  if (typeof payload.maxHeight === 'number') node.maxHeight = payload.maxHeight;
  if (typeof payload.minHeight === 'number') node.minHeight = payload.minHeight;

  // Padding variables
  if (payload.paddingVariable) {
    var padOk = bindVariable(node, 'paddingTop', payload.paddingVariable)
             && bindVariable(node, 'paddingRight', payload.paddingVariable)
             && bindVariable(node, 'paddingBottom', payload.paddingVariable)
             && bindVariable(node, 'paddingLeft', payload.paddingVariable);
    bt.track('paddingVariable', padOk, 'variable "' + payload.paddingVariable + '" not found');
  }
  if (payload.paddingTopVariable) bt.track('paddingTopVariable', bindVariable(node, 'paddingTop', payload.paddingTopVariable), 'not found');
  if (payload.paddingRightVariable) bt.track('paddingRightVariable', bindVariable(node, 'paddingRight', payload.paddingRightVariable), 'not found');
  if (payload.paddingBottomVariable) bt.track('paddingBottomVariable', bindVariable(node, 'paddingBottom', payload.paddingBottomVariable), 'not found');
  if (payload.paddingLeftVariable) bt.track('paddingLeftVariable', bindVariable(node, 'paddingLeft', payload.paddingLeftVariable), 'not found');

  // Raw padding
  if (typeof payload.paddingTop === 'number') node.paddingTop = payload.paddingTop;
  if (typeof payload.paddingRight === 'number') node.paddingRight = payload.paddingRight;
  if (typeof payload.paddingBottom === 'number') node.paddingBottom = payload.paddingBottom;
  if (typeof payload.paddingLeft === 'number') node.paddingLeft = payload.paddingLeft;

  // Gap variable
  if (payload.gapVariable) {
    bt.track('gapVariable', bindVariable(node, 'itemSpacing', payload.gapVariable), 'variable "' + payload.gapVariable + '" not found');
  } else if (typeof payload.gap === 'number') {
    node.itemSpacing = payload.gap;
  }

  // Grid-child placement (Grid automation, May 2026) — feature-detected +
  // tracked rather than thrown: meaningful only when this node's parent is
  // a GRID-layoutMode frame, so a mismatched/pre-Grid host just reports a
  // non-fatal warning instead of failing the whole sizing call.
  if (typeof payload.gridRowSpan === 'number') {
    bt.track('gridRowSpan', (function () { try { node.gridRowSpan = payload.gridRowSpan; return true; } catch (e) { return false; } })(), 'parent is not a GRID layout, or this Figma version has no gridRowSpan property');
  }
  if (typeof payload.gridColumnSpan === 'number') {
    bt.track('gridColumnSpan', (function () { try { node.gridColumnSpan = payload.gridColumnSpan; return true; } catch (e) { return false; } })(), 'parent is not a GRID layout, or this Figma version has no gridColumnSpan property');
  }

  var bindingResult = bt.result();
  return {
    nodeId: node.id,
    name: node.name,
    layoutSizingHorizontal: node.layoutSizingHorizontal,
    layoutSizingVertical: node.layoutSizingVertical,
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
  };
};

// Applies a subset of node properties that don't warrant their own handler.
// Currently used for card-inset table padding overrides (first/last column
// left/right padding) sent by src/tools/table.js. Mirrors the padding
// binding logic in set_layout_sizing above.
handlers.set_node_props = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  var bt = createBindingTracker();

  // Padding variables
  if (payload.paddingVariable) {
    var padOk = bindVariable(node, 'paddingTop', payload.paddingVariable)
             && bindVariable(node, 'paddingRight', payload.paddingVariable)
             && bindVariable(node, 'paddingBottom', payload.paddingVariable)
             && bindVariable(node, 'paddingLeft', payload.paddingVariable);
    bt.track('paddingVariable', padOk, 'variable "' + payload.paddingVariable + '" not found');
  }
  if (payload.paddingTopVariable) bt.track('paddingTopVariable', bindVariable(node, 'paddingTop', payload.paddingTopVariable), 'not found');
  if (payload.paddingRightVariable) bt.track('paddingRightVariable', bindVariable(node, 'paddingRight', payload.paddingRightVariable), 'not found');
  if (payload.paddingBottomVariable) bt.track('paddingBottomVariable', bindVariable(node, 'paddingBottom', payload.paddingBottomVariable), 'not found');
  if (payload.paddingLeftVariable) bt.track('paddingLeftVariable', bindVariable(node, 'paddingLeft', payload.paddingLeftVariable), 'not found');

  // Raw padding overrides
  if (typeof payload.paddingTop === 'number') node.paddingTop = payload.paddingTop;
  if (typeof payload.paddingRight === 'number') node.paddingRight = payload.paddingRight;
  if (typeof payload.paddingBottom === 'number') node.paddingBottom = payload.paddingBottom;
  if (typeof payload.paddingLeft === 'number') node.paddingLeft = payload.paddingLeft;

  var bindingResult = bt.result();
  return {
    nodeId: node.id,
    name: node.name,
    paddingTop: node.paddingTop,
    paddingRight: node.paddingRight,
    paddingBottom: node.paddingBottom,
    paddingLeft: node.paddingLeft,
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
  };
};

handlers.set_visibility = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  node.visible = coerceBool(payload.visible, true);

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

  // Find the collection by name — check both local and library (via cached variables)
  var collections = figma.variables.getLocalVariableCollections();

  // Also collect library collections from cached imported variables
  var seenIds = {};
  for (var i = 0; i < collections.length; i++) seenIds[collections[i].id] = true;
  variableCache.forEach(function (variable) {
    if (!variable || !variable.variableCollectionId) return;
    if (seenIds[variable.variableCollectionId]) return;
    seenIds[variable.variableCollectionId] = true;
    try {
      var col = figma.variables.getVariableCollectionById(variable.variableCollectionId);
      if (col) collections.push(col);
    } catch (e) { /* skip */ }
  });

  var targetCollection = null;
  var searchName = collectionName.toLowerCase().replace(/^\d+\.\s*/, '');

  for (var i = 0; i < collections.length; i++) {
    // Exact match
    if (collections[i].name === collectionName) {
      targetCollection = collections[i];
      break;
    }
    // Fuzzy match: strip leading "N. " prefix, case-insensitive
    var localName = collections[i].name.toLowerCase().replace(/^\d+\.\s*/, '');
    if (localName === searchName) {
      targetCollection = collections[i];
      break;
    }
    // Substring match: collection name contains the search term
    if (localName.indexOf(searchName) !== -1 || searchName.indexOf(localName) !== -1) {
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
      recovery: 'Use one of the available collection names listed above.',
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

handlers.set_all_variable_modes = async function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };

  var modeIndex = payload.modeIndex || 0;
  var applied = [];
  var seenCollections = {};

  // Approach 1: Local collections (own file variables)
  var localCollections = figma.variables.getLocalVariableCollections();
  for (var i = 0; i < localCollections.length; i++) {
    var col = localCollections[i];
    seenCollections[col.id] = true;
    var effectiveIndex = Math.min(modeIndex, col.modes.length - 1);
    var modeId = col.modes[effectiveIndex].modeId;
    try {
      node.setExplicitVariableModeForCollection(col, modeId);
      applied.push({ collection: col.name, mode: col.modes[effectiveIndex].name, modeIndex: effectiveIndex });
    } catch (e) { /* skip */ }
  }

  // Approach 2: Library collections (accessed via cached imported variables)
  // Collect unique collection IDs from the variable cache first
  var libraryColIds = [];
  variableCache.forEach(function (variable) {
    if (!variable || !variable.variableCollectionId) return;
    if (seenCollections[variable.variableCollectionId]) return;
    seenCollections[variable.variableCollectionId] = true;
    libraryColIds.push(variable.variableCollectionId);
  });

  // Resolve each library collection (use async API to avoid deprecation issues)
  for (var i = 0; i < libraryColIds.length; i++) {
    try {
      var col = await figma.variables.getVariableCollectionByIdAsync(libraryColIds[i]);
      if (!col) continue;
      var effectiveIndex = Math.min(modeIndex, col.modes.length - 1);
      var modeId = col.modes[effectiveIndex].modeId;
      node.setExplicitVariableModeForCollection(col, modeId);
      applied.push({ collection: col.name, mode: col.modes[effectiveIndex].name, modeIndex: effectiveIndex });
    } catch (e) { /* skip */ }
  }

  return {
    nodeId: node.id,
    name: node.name,
    collectionsApplied: applied.length,
    collections: applied,
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
  var bt = createBindingTracker();

  // Name
  if (payload.name) node.name = payload.name;

  // Fill — unlike figma_create_frame (a brand-new node with nothing to
  // preserve), this handler only ever touches node.fills when the caller
  // explicitly passes fillVariable/fill. No payload -> node.fills is left
  // completely untouched, so any existing paint the caller didn't ask to
  // change — including a SHADER paint, which this handler has no explicit
  // support for and never needs any, since it never rewrites what it
  // doesn't understand — survives a restyle call unmodified.
  if (payload.fillVariable) {
    bt.track('fillVariable', bindFillVariable(node, payload.fillVariable), 'variable "' + payload.fillVariable + '" not found');
  } else if (payload.fill) {
    applySolidFill(node, payload.fill);
  }

  // Stroke
  if (payload.strokeVariable) {
    bt.track('strokeVariable', bindStrokeVariable(node, payload.strokeVariable), 'variable "' + payload.strokeVariable + '" not found');
    if (typeof payload.strokeWeight === 'number') node.strokeWeight = payload.strokeWeight;
  }

  // Corner radius
  if (payload.cornerRadiusVariable) {
    var radOk = bindVariable(node, 'topLeftRadius', payload.cornerRadiusVariable)
             && bindVariable(node, 'topRightRadius', payload.cornerRadiusVariable)
             && bindVariable(node, 'bottomLeftRadius', payload.cornerRadiusVariable)
             && bindVariable(node, 'bottomRightRadius', payload.cornerRadiusVariable);
    bt.track('cornerRadiusVariable', radOk, 'variable "' + payload.cornerRadiusVariable + '" not found');
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
    var padOk = bindVariable(node, 'paddingTop', payload.paddingVariable)
             && bindVariable(node, 'paddingRight', payload.paddingVariable)
             && bindVariable(node, 'paddingBottom', payload.paddingVariable)
             && bindVariable(node, 'paddingLeft', payload.paddingVariable);
    bt.track('paddingVariable', padOk, 'variable "' + payload.paddingVariable + '" not found');
  }
  if (payload.paddingTopVariable) bt.track('paddingTopVariable', bindVariable(node, 'paddingTop', payload.paddingTopVariable), 'not found');
  if (payload.paddingRightVariable) bt.track('paddingRightVariable', bindVariable(node, 'paddingRight', payload.paddingRightVariable), 'not found');
  if (payload.paddingBottomVariable) bt.track('paddingBottomVariable', bindVariable(node, 'paddingBottom', payload.paddingBottomVariable), 'not found');
  if (payload.paddingLeftVariable) bt.track('paddingLeftVariable', bindVariable(node, 'paddingLeft', payload.paddingLeftVariable), 'not found');

  // Gap
  if (payload.gapVariable) {
    bt.track('gapVariable', bindVariable(node, 'itemSpacing', payload.gapVariable), 'variable "' + payload.gapVariable + '" not found');
  } else if (typeof payload.gap === 'number') {
    node.itemSpacing = payload.gap;
  }

  // Clip
  if (typeof payload.clipsContent === 'boolean') node.clipsContent = payload.clipsContent;

  var bindingResult = bt.result();
  return {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    restyled: true,
    applied: bindingResult.applied,
    warnings: bindingResult.warnings,
    bindingFailures: bindingResult.bindingFailures,
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

handlers.set_node_position = function (payload) {
  var node = figma.getNodeById(normalizeNodeId(payload.nodeId));
  if (!node) throw { error: 'NODE_NOT_FOUND', property: 'nodeId', message: 'Node not found: ' + payload.nodeId, available: [], recovery: 'Check nodeId.' };
  if (typeof payload.x !== 'number' || typeof payload.y !== 'number') {
    throw { error: 'INVALID_POSITION', property: 'x/y', message: 'Numeric x and y are required.', available: [], recovery: 'Provide numeric x and y values.' };
  }

  node.x = payload.x;
  node.y = payload.y;

  return {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    x: node.x,
    y: node.y,
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

  // Fills — every entry keeps its real `type` regardless of what that type
  // is (SOLID/GRADIENT_*/IMAGE/VIDEO/SHADER/anything future). Only SOLID
  // gets a decoded `color`; unknown/unhandled paint types (e.g. the SHADER
  // union member added alongside Grid/Slots in 2026) still get a fills[]
  // entry with their type and visibility intact — never dropped, never
  // thrown on. This is a read path (node.fills is inspected, not
  // reassigned), so no paint is ever stripped here.
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

handlers.validate_library_access = async function (payload) {
  var candidates = payload.candidates || [];
  if (candidates.length === 0) return { results: [] };

  // Authoritative check: getAvailableLibraryVariableCollectionsAsync returns
  // ONLY libraries actually added to the file. importVariableByKeyAsync is
  // unreliable — it succeeds for any team library, even phantom ones.
  var collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  var enabledLibraries = new Set();
  for (var i = 0; i < collections.length; i++) {
    if (collections[i].libraryName) {
      enabledLibraries.add(collections[i].libraryName);
    }
  }

  var results = [];
  for (var j = 0; j < candidates.length; j++) {
    results.push({
      name: candidates[j].name,
      accessible: enabledLibraries.has(candidates[j].name),
    });
  }
  return { results: results };
};

handlers.batch_execute = async function (payload) {
  var operations = payload.operations || [];
  if (operations.length === 0) return { results: [], totalOps: 0, succeeded: 0, failed: 0 };
  if (operations.length > 200) throw {
    error: 'BATCH_TOO_LARGE',
    message: 'Maximum 200 operations per batch. Got: ' + operations.length + '. The bridge auto-chunks larger batches.',
    recovery: 'Use bridge.sendBatch() which handles chunking automatically.'
  };

  var results = [];
  var REF_PATTERN = /^\$resultOf:(\d+)(?:\.(.+))?$/;

  function resolvePayloadRefs(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(resolvePayloadRefs);
    var out = {};
    for (var key in obj) {
      if (!obj.hasOwnProperty(key)) continue;
      var val = obj[key];
      if (typeof val === 'string') {
        var m = val.match(REF_PATTERN);
        if (m) {
          var idx = parseInt(m[1], 10);
          var field = m[2] || 'nodeId';
          var entry = results[idx];
          out[key] = (entry && entry.ok && entry.result) ? (entry.result[field] || null) : null;
        } else {
          out[key] = val;
        }
      } else if (typeof val === 'object' && val !== null) {
        out[key] = resolvePayloadRefs(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  // Group operations by parentId to yield between cross-parent writes.
  // Figma's auto-layout engine can drop nodes when children are rapidly
  // created across different auto-layout parents in the same execution frame.
  var groups = [];
  var currentGroup = [];
  var currentParent = null;

  for (var g = 0; g < operations.length; g++) {
    var gOp = operations[g];
    var gPayload = gOp.payload || {};
    // Determine the effective parent for grouping — use parentId if present,
    // fall back to nodeId (for mutations on existing nodes), or null.
    var effectiveParent = gPayload.parentId || gPayload.nodeId || null;
    // Don't resolve $resultOf refs for grouping — treat each ref string as its own key
    if (currentParent !== effectiveParent && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
    currentGroup.push({ originalIndex: g, op: gOp });
    currentParent = effectiveParent;
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  for (var gi = 0; gi < groups.length; gi++) {
    // Yield between parent groups so Figma's layout engine can settle
    if (gi > 0) {
      await new Promise(function (r) { setTimeout(r, 0); });
    }

    var group = groups[gi];
    for (var j = 0; j < group.length; j++) {
      var i = group[j].originalIndex;
      var op = group[j].op;
    var opType = op.type;
    var opPayload = op.payload || {};

    var resolved = resolvePayloadRefs(opPayload);

    // Normalize node IDs
    var idKeys = ['nodeId', 'parentId', 'targetId', 'instanceId', 'frameId'];
    for (var k = 0; k < idKeys.length; k++) {
      if (typeof resolved[idKeys[k]] === 'string') {
        resolved[idKeys[k]] = resolved[idKeys[k]].replace(/-/g, ':');
      }
    }

    // Skip if a required parent/node reference resolved to null
    if (resolved.parentId === null || resolved.nodeId === null) {
      results.push({
        ok: false, index: i, type: opType,
        error: 'SKIPPED_DEPENDENCY_FAILED',
        message: 'A $resultOf reference resolved to null (prior operation failed or out of bounds).',
      });
      continue;
    }

    var handler = handlers[opType];
    if (!handler) {
      results.push({ ok: false, index: i, type: opType, error: 'UNKNOWN_HANDLER', message: 'No handler: ' + opType });
      continue;
    }

    try {
      var result = handler(resolved);
      if (result && typeof result.then === 'function') {
        result = await result;
      }
      results.push({ ok: true, index: i, type: opType, result: result });
    } catch (err) {
      var errMsg = (err instanceof Error) ? err.message : (err.message || JSON.stringify(err));
      results.push({ ok: false, index: i, type: opType, error: errMsg });
    }
    }
  }

  var succeeded = results.filter(function (r) { return r.ok; }).length;
  return {
    results: results,
    totalOps: results.length,
    succeeded: succeeded,
    failed: results.length - succeeded,
  };
};

handlers.clear_style_cache = function () {
  styleCache.clear();
  return { cleared: true, message: 'Style cache cleared.' };
};

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
  var operations = coerceArray(payload.operations);
  if (!operations || operations.length === 0) {
    throw { error: 'MISSING_PARAM', property: 'operations', message: 'operations array is required.', available: [], recovery: 'Provide an array of { type, payload } objects.' };
  }
  if (operations.length > 6) {
    throw { error: 'BATCH_LIMIT', property: 'operations', message: 'Maximum 6 operations per batch.', available: [], recovery: 'Split into multiple batches of 6 or fewer.' };
  }

  // Execute sequentially, collecting results
  // Handle both sync and async handlers by chaining promises
  function packBatchEntry(index, type, resolved) {
    var entry = { index: index, type: type, result: resolved };
    // Surface binding feedback from sub-handlers
    if (resolved && resolved.bindingFailures) {
      entry.bindingFailures = true;
      entry.warnings = resolved.warnings;
      entry.applied = resolved.applied;
    }
    return entry;
  }

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
          results.push(packBatchEntry(index, op.type, resolved));
          return executeSequential(ops, index + 1, results);
        }).catch(function (err) {
          var errMsg = err instanceof Error ? err.message : (err.message || err.error || 'Unknown error');
          results.push({ index: index, type: op.type, error: errMsg });
          return executeSequential(ops, index + 1, results);
        });
      } else {
        results.push(packBatchEntry(index, op.type, result));
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

  function wrapBatchResults(results) {
    var hasBindingFailures = false;
    for (var i = 0; i < results.length; i++) {
      if (results[i].bindingFailures) { hasBindingFailures = true; break; }
    }
    return {
      results: results,
      count: results.length,
      bindingFailures: hasBindingFailures,
    };
  }

  // If any async operations, outcome is a promise
  if (outcome && typeof outcome.then === 'function') {
    return outcome.then(wrapBatchResults);
  }

  return wrapBatchResults(outcome);
};

// ── Message Dispatcher ─────────────────────────────────────────────────────────
//
// Everything below this point is runtime bootstrap: it calls the global
// `figma` API at load time (not just inside a handler body), so it must be
// guarded for the module to be require()-able in Node with no `figma`
// global at all (e.g. from a test that only wants the static exports, or
// from tooling that inspects this file without a plugin sandbox). When a
// test DOES provide a stubbed `global.figma` before requiring this file,
// this block runs exactly as it does in the real plugin sandbox — that's
// intentional, it exercises the same startup path.

if (typeof figma !== 'undefined') {
  // ── UI Position test: hardcoded bottom-right ──
  figma.showUI(__html__, { width: 120, height: 28 });

  // Pre-warm font cache on startup — prevents cold-start font loading failures
  figma.loadFontAsync({ family: 'Inter', style: 'Regular' }).catch(function () {});
  figma.loadFontAsync({ family: 'Inter', style: 'Bold' }).catch(function () {});
  figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' }).catch(function () {});
  figma.loadFontAsync({ family: 'Inter', style: 'Medium' }).catch(function () {});

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
          error: errObj,
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
      error: errObj,
    });
  }
  };
}

// ── Node/test exports ───────────────────────────────────────────────────────
//
// This file has no bundler and no module system at runtime — Figma loads it
// as a single sandboxed script with a global `figma`. The block below is the
// only concession to that: a UMD-style footer so internal/tests/*.test.js
// can `require('plugin/code.js')` in Node (with a stubbed global.figma set
// beforehand — see internal/tests/helpers/figma-stub.js) and exercise the
// REAL handlers, instead of a parallel reimplementation.
//
// `typeof module !== 'undefined'` is false inside Figma's plugin sandbox, so
// this never executes there — it's a Node-only code path. Nothing above this
// footer depends on `module`/`require`/`exports` existing, so this is purely
// additive and does not change plugin sandbox behavior.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    handlers: handlers,
    // Pure/near-pure helpers, exported for direct unit testing.
    fontKey: fontKey,
    loadFont: loadFont,
    ensureFontLoaded: ensureFontLoaded,
    coerceBool: coerceBool,
    coerceArray: coerceArray,
    enforceText: enforceText,
    enforceColorFill: enforceColorFill,
    createBindingTracker: createBindingTracker,
    getVariableByPath: getVariableByPath,
    getVariableByKey: getVariableByKey,
    bindVariable: bindVariable,
    bindFillVariable: bindFillVariable,
    bindStrokeVariable: bindStrokeVariable,
    hexToRgb: hexToRgb,
    normalizeColor: normalizeColor,
    normalizeNodeId: normalizeNodeId,
    getParent: getParent,
    collectConfigurationHints: collectConfigurationHints,
    // Module-scoped state, exposed BY REFERENCE so tests can inspect and
    // reset it between cases (e.g. `_state.styleCache.clear()`,
    // `_state.enforcementProfile.enforceTextStyles = true`). Every test that
    // requires this module gets a fresh copy of this state anyway, because
    // tests load the module via a fresh `require.cache` delete per stub
    // (see loadPlugin() in figma-stub.js) — `_state` is for within-file
    // resets between individual test cases, not cross-file isolation.
    _state: {
      enforcementProfile: enforcementProfile,
      styleCache: styleCache,
      variableCache: variableCache,
      loadedFontKeys: loadedFontKeys,
    },
  };
}
