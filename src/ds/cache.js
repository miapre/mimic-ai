class DsCache {
  constructor() {
    this.textStyles = new Map();
    this.fillStyles = new Map();
    this.effectStyles = new Map();
    this.variables = new Map();
    this.components = new Map();
    this.failedKeys = new Map(); // key → { timestamp, permanent }
    this.libraryFontIncompatible = false;
  }

  addTextStyle(key, style) { this.textStyles.set(key, style); }
  getTextStyle(key) { return this.textStyles.get(key) || null; }

  /**
   * Resolve a text style name (e.g. "Text sm/Semibold") to its Figma style key.
   * Returns the key if found, or null if no match.
   */
  resolveTextStyleKey(nameOrKey) {
    if (!nameOrKey) return null;
    // Already a key — check if it exists directly
    if (this.textStyles.has(nameOrKey)) return nameOrKey;
    // Search by name (case-insensitive)
    const lower = nameOrKey.toLowerCase();
    for (const [key, style] of this.textStyles) {
      if (style.name && style.name.toLowerCase() === lower) return key;
    }
    return null;
  }
  addFillStyle(key, style) { this.fillStyles.set(key, style); }
  getFillStyle(key) { return this.fillStyles.get(key) || null; }
  addEffectStyle(key, style) { this.effectStyles.set(key, style); }
  getEffectStyle(key) { return this.effectStyles.get(key) || null; }
  // `variable` is a free-form info object (key, collection, category,
  // libraryName, ...). Extended variable collections (Enterprise theming,
  // 2026) add two optional fields callers may include:
  //   - collectionKey: the variable's own home collection identifier
  //     (stable across renames, unlike `collection` which is a display name)
  //   - rootVariableCollectionId: the id of the collection this variable's
  //     value is inherited from, when the home collection extends another
  //   Both are passed straight through — this Map is intentionally
  //   schema-less so new discovery fields never require a cache change.
  addVariable(path, variable) { this.variables.set(path, variable); }
  getVariable(path) { return this.variables.get(path) || null; }
  addComponent(key, component) { this.components.set(key, component); }
  getComponent(key) { return this.components.get(key) || null; }

  /**
   * Number of components discovered via the REST API — i.e. an authoritative
   * full-library enumeration. Components from other sources (plugin page-scan,
   * learned recipes, library-search ingestion) carry a different `source`.
   */
  restComponentCount() {
    let n = 0;
    for (const c of this.components.values()) {
      if (c && c.source === 'rest_api') n++;
    }
    return n;
  }

  /**
   * True when the component set Mimic knows was NOT enumerated from the live
   * library — the cache holds components but none came from the REST API and
   * no library file key was available to run one. In that state Mimic only
   * knows components already instantiated on the file (page-scan), so
   * mimic_map_components reports false gaps and a build can silently use few or
   * zero DS components. Callers should warn (not silently proceed).
   */
  componentEnumerationDegraded(libraryFileKey) {
    return this.components.size > 0 && this.restComponentCount() === 0 && !libraryFileKey;
  }
  markFailed(key, permanent = true) {
    this.failedKeys.set(key, { timestamp: Date.now(), permanent });
  }
  hasFailed(key) {
    const entry = this.failedKeys.get(key);
    if (!entry) return false;
    if (entry.permanent) return true;
    // Transient failures (timeouts) allow retry after 30 seconds
    const COOLDOWN_MS = 30000;
    if (Date.now() - entry.timestamp >= COOLDOWN_MS) {
      this.failedKeys.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Finds the closest matching variable paths for a given path.
   * Returns up to 5 suggestions sorted by relevance.
   * @param {string} path - The variable path to look up
   * @param {string|null} category - Optional category filter (text, background, border, etc.)
   * @returns {string[]}
   */
  suggestVariable(path, category) {
    if (!path || this.variables.size === 0) return [];
    const needle = path.toLowerCase();
    const scored = [];
    for (const [cachedPath, info] of this.variables) {
      if (category && info.category && info.category !== category) continue;
      const cp = cachedPath.toLowerCase();
      // Exact match — no suggestions needed
      if (cp === needle) return [];
      let score = 0;
      // Substring containment
      if (cp.includes(needle)) score += 3;
      if (needle.includes(cp)) score += 2;
      // Shared prefix
      let prefix = 0;
      while (prefix < cp.length && prefix < needle.length && cp[prefix] === needle[prefix]) prefix++;
      score += prefix * 0.5;
      // Same category is a bonus
      if (category && info.category === category) score += 1;
      if (score > 0) scored.push({ path: cachedPath, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map(s => s.path);
  }

  /**
   * Validates all *Variable params in a tool args object.
   * Returns { valid: true } or { valid: false, warnings: [...] } with suggestions.
   * @param {object} args - Tool arguments containing *Variable fields
   * @returns {{ valid: boolean, warnings: string[] }}
   */
  validateVariables(args) {
    if (!args || typeof args !== 'object') return { valid: true, warnings: [] };
    const warnings = [];
    const categoryMismatches = [];
    // Structured signal data (spec defect M, acceptance 27) — emitted
    // alongside the human-readable `categoryMismatches` prose so callers
    // (mcp.js) can build category_mismatch signals from real fields
    // instead of regexing the warning string. A wording change to the
    // prose message can never silently break signal emission again.
    const categoryMismatchDetails = [];
    const varFields = Object.keys(args).filter(k => k.endsWith('Variable'));
    for (const field of varFields) {
      const path = args[field];
      if (!path || typeof path !== 'string') continue;

      // Determine expected category from field name
      let expectedCategory = null;
      if (field.startsWith('fill')) expectedCategory = 'background';
      if (field.startsWith('stroke')) expectedCategory = 'border';
      if (field === 'fillVariable' && args.content !== undefined) expectedCategory = 'text'; // text node fill → text color
      if (field.startsWith('padding') || field.startsWith('gap')
          || field === 'gridRowGapVariable' || field === 'gridColumnGapVariable') expectedCategory = 'spacing';
      if (field.startsWith('cornerRadius')) expectedCategory = 'radius';

      const cached = this.variables.get(path);
      if (cached) {
        // Variable exists — check category match.
        // Category mismatches produce warnings but don't block (the variable IS valid,
        // just semantically wrong). Common violations:
        //   - bg-* used as strokeVariable (should be border-*)
        //   - bg-* used as fillVariable on text nodes (should be text-*)
        //   - fg-* used as fillVariable on frames (should be bg-*)
        if (expectedCategory && cached.category && cached.category !== expectedCategory) {
          // Allow 'color' (generic) and 'foreground' for fills — these are ambiguous
          const isAmbiguous = cached.category === 'color'
            || (expectedCategory === 'background' && cached.category === 'foreground')
            || (expectedCategory === 'text' && cached.category === 'foreground');
          if (!isAmbiguous) {
            const CATEGORY_LABELS = {
              text: 'text-*',
              background: 'bg-*',
              border: 'border-*',
              foreground: 'fg-*',
              spacing: 'spacing variables',
              radius: 'radius variables',
            };
            const expectedLabel = CATEGORY_LABELS[expectedCategory] || expectedCategory;
            const actualLabel = CATEGORY_LABELS[cached.category] || cached.category;
            const suggestion = this.suggestVariable(
              path.replace(/^[^-/]+-/, ''), // strip prefix to find alternatives
              expectedCategory
            );
            const fix = suggestion.length > 0
              ? ` Use instead: ${suggestion[0]}`
              : '';
            categoryMismatches.push(
              `${field}: '${path}' is a ${actualLabel} variable but used for ${expectedCategory}. ` +
              `${expectedCategory} properties should use ${expectedLabel} variables.${fix}`
            );
            categoryMismatchDetails.push({
              field,
              path,
              actualCategory: cached.category,
              expectedCategory,
              suggestion: suggestion.length > 0 ? suggestion[0] : null,
            });
          }
        }
        continue;
      }

      // Variable not found — suggest alternatives
      const suggestions = this.suggestVariable(path, expectedCategory);
      const altSuggestions = suggestions.length === 0 && expectedCategory
        ? this.suggestVariable(path, null) // try without category filter
        : [];
      const allSuggestions = [...new Set([...suggestions, ...altSuggestions])].slice(0, 5);

      if (allSuggestions.length > 0) {
        warnings.push(`${field}: '${path}' not found in DS. Available: ${allSuggestions.join(', ')}`);
      } else {
        const count = this.variables.size;
        warnings.push(`${field}: '${path}' not found in DS (${count} variables cached). Use figma_list_ds (kind: "variables") to see available variables.`);
      }
    }
    // Category mismatches are warnings, not blocking errors — variable paths
    // are valid but semantically wrong. They're surfaced so the LLM corrects
    // them, but the build isn't blocked (the variable WILL bind in Figma).
    const pathErrors = warnings.filter(w => !categoryMismatches.includes(w));
    return {
      valid: pathErrors.length === 0,
      warnings: [...pathErrors, ...categoryMismatches],
      categoryMismatches,
      categoryMismatchDetails,
      hasPathErrors: pathErrors.length > 0,
    };
  }

  getEnforcementProfile() {
    const hasTextStyles = this.textStyles.size > 0;
    const hasTypographyVars = [...this.variables.values()].some(v =>
      v.collection && (v.collection.toLowerCase().includes('font') || v.collection.toLowerCase().includes('typography')));
    const colorVars = [...this.variables.values()].filter(v =>
      v.category === 'text' || v.category === 'background' || v.category === 'border' || v.category === 'foreground' || v.category === 'color');
    const spacingVars = [...this.variables.values()].filter(v => v.category === 'spacing');
    const radiusVars = [...this.variables.values()].filter(v => v.category === 'radius');

    const hasFillStyles = this.fillStyles.size > 0;
    return {
      enforceTextStyles: hasTextStyles || hasTypographyVars,
      enforceFillStyles: hasFillStyles,
      enforceColorVars: colorVars.length > 0,
      enforceSpacingVars: spacingVars.length > 0,
      enforceRadiusVars: radiusVars.length > 0,
      counts: { textStyles: this.textStyles.size, fillStyles: this.fillStyles.size, effectStyles: this.effectStyles.size, colorVars: colorVars.length, spacingVars: spacingVars.length, radiusVars: radiusVars.length }
    };
  }

  /**
   * Find a variable by keyword + scope + hint. DS-agnostic lookup.
   * Searches cached variable paths for the best match.
   * @param {string} keyword - Part of the variable name (e.g. 'border', 'text')
   * @param {string} [scope] - Expected scope (e.g. 'STROKE', 'TEXT_FILL')
   * @param {string} [hint] - Additional keyword for specificity (e.g. 'secondary', 'primary')
   * @returns {string|null} Best matching variable path
   */
  findVariable(keyword, scope, hint) {
    const needle = keyword.toLowerCase();
    const hintLower = hint ? hint.toLowerCase() : null;
    let best = null;
    let bestScore = 0;
    for (const [path, info] of this.variables) {
      const lp = path.toLowerCase();
      if (!lp.includes(needle)) continue;
      let score = 1;
      if (scope && info.scopes && info.scopes.includes(scope)) score += 3;
      if (hintLower && lp.includes(hintLower)) score += 2;
      if (info.resolvedType === 'COLOR') score += 1;
      if (score > bestScore) { bestScore = score; best = path; }
    }
    return best;
  }

  /**
   * Find a text style by size keyword + weight keyword. DS-agnostic.
   * @param {string} sizeHint - Size part (e.g. 'xs', 'sm', 'md')
   * @param {string} weightHint - Weight part (e.g. 'Medium', 'Semibold', 'Bold')
   * @returns {string|null} Text style key (for textStyleId)
   */
  findTextStyle(sizeHint, weightHint) {
    const sizeLower = sizeHint.toLowerCase();
    const weightLower = weightHint.toLowerCase();
    for (const [key, style] of this.textStyles) {
      const name = (style.name || '').toLowerCase();
      if (name.includes(sizeLower) && name.includes(weightLower)) return key;
    }
    return null;
  }

  /**
   * Find a fill style by keyword. DS-agnostic lookup.
   * @param {string} keyword - Part of the style name (e.g. 'Blue-500', 'Gray-100', 'White')
   * @returns {string|null} Fill style key (for fillStyleId)
   */
  findFillStyle(keyword) {
    if (!keyword || this.fillStyles.size === 0) return null;
    const needle = keyword.toLowerCase();
    // Exact match first
    for (const [key, style] of this.fillStyles) {
      if ((style.name || '').toLowerCase() === needle) return key;
    }
    // Partial match
    for (const [key, style] of this.fillStyles) {
      if ((style.name || '').toLowerCase().includes(needle)) return key;
    }
    return null;
  }

  /**
   * Find a palette of distinct DS color variables for chart data.
   * Looks for utility/component colors, excludes text/bg/border semantic colors.
   * @param {number} [count=8] - Number of colors to return
   * @returns {string[]|null} Array of variable paths, or null if fewer than 3 found
   */
  findPalette(count = 8) {
    const palette = [];
    const seen = new Set();
    for (const [path, info] of this.variables) {
      if (info.resolvedType !== 'COLOR') continue;
      const lp = path.toLowerCase();
      // Skip semantic colors (text, background, border)
      if (lp.includes('/text/') || lp.includes('/background/') || lp.includes('/bg/') || lp.includes('/border/')) continue;
      // Skip brand/status colors — reserved for their semantic purpose,
      // never for chart data (brand reads as emphasis; success/warning/
      // error read as status).
      if (/brand|success|warning|error|danger|destructive/.test(lp)) continue;
      // Prefer mid-ramp colors (…-500) and primary ramp entries
      if (lp.includes('500') || lp.includes('primary')) {
        const base = lp.replace(/\d+$/, '');
        if (!seen.has(base)) {
          seen.add(base);
          palette.push(path);
        }
      }
      if (palette.length >= count) break;
    }
    return palette.length >= 3 ? palette : null;
  }

  clear() {
    this.textStyles.clear();
    this.fillStyles.clear();
    this.effectStyles.clear();
    this.variables.clear();
    this.components.clear();
    this.failedKeys.clear();
    this.libraryFontIncompatible = false;
  }
}
module.exports = { DsCache };
