class DsCache {
  constructor() {
    this.textStyles = new Map();
    this.variables = new Map();
    this.components = new Map();
    this.failedKeys = new Set();
  }

  addTextStyle(key, style) { this.textStyles.set(key, style); }
  getTextStyle(key) { return this.textStyles.get(key) || null; }
  addVariable(path, variable) { this.variables.set(path, variable); }
  getVariable(path) { return this.variables.get(path) || null; }
  addComponent(key, component) { this.components.set(key, component); }
  getComponent(key) { return this.components.get(key) || null; }
  markFailed(key) { this.failedKeys.add(key); }
  hasFailed(key) { return this.failedKeys.has(key); }

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
    const varFields = Object.keys(args).filter(k => k.endsWith('Variable'));
    for (const field of varFields) {
      const path = args[field];
      if (!path || typeof path !== 'string') continue;
      if (this.variables.has(path)) continue;
      // Determine expected category from field name
      let category = null;
      if (field.startsWith('fill')) category = 'background';
      if (field.startsWith('stroke')) category = 'border';
      if (field === 'fillVariable' && args.content !== undefined) category = 'text'; // text node fill → text color
      if (field.startsWith('padding') || field.startsWith('gap')) category = 'spacing';
      if (field.startsWith('cornerRadius')) category = 'radius';

      const suggestions = this.suggestVariable(path, category);
      const altSuggestions = suggestions.length === 0 && category
        ? this.suggestVariable(path, null) // try without category filter
        : [];
      const allSuggestions = [...new Set([...suggestions, ...altSuggestions])].slice(0, 5);

      if (allSuggestions.length > 0) {
        warnings.push(`${field}: '${path}' not found in DS. Available: ${allSuggestions.join(', ')}`);
      } else {
        const count = this.variables.size;
        warnings.push(`${field}: '${path}' not found in DS (${count} variables cached). Use figma_read_variable_values to see available variables.`);
      }
    }
    return { valid: warnings.length === 0, warnings };
  }

  getEnforcementProfile() {
    const hasTextStyles = this.textStyles.size > 0;
    const hasTypographyVars = [...this.variables.values()].some(v =>
      v.collection && (v.collection.toLowerCase().includes('font') || v.collection.toLowerCase().includes('typography')));
    const colorVars = [...this.variables.values()].filter(v =>
      v.category === 'text' || v.category === 'background' || v.category === 'border' || v.category === 'foreground' || v.category === 'color');
    const spacingVars = [...this.variables.values()].filter(v => v.category === 'spacing');
    const radiusVars = [...this.variables.values()].filter(v => v.category === 'radius');

    return {
      enforceTextStyles: hasTextStyles || hasTypographyVars,
      enforceColorVars: colorVars.length > 0,
      enforceSpacingVars: spacingVars.length > 0,
      enforceRadiusVars: radiusVars.length > 0,
      counts: { textStyles: this.textStyles.size, colorVars: colorVars.length, spacingVars: spacingVars.length, radiusVars: radiusVars.length }
    };
  }

  clear() {
    this.textStyles.clear();
    this.variables.clear();
    this.components.clear();
    this.failedKeys.clear();
  }
}
module.exports = { DsCache };
