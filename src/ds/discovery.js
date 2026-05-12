'use strict';

class DsDiscovery {
  /**
   * @param {import('../bridge')} bridge - WebSocket bridge to Figma plugin
   * @param {import('./cache').DsCache} dsCache - DS cache instance
   * @param {import('../knowledge/store').KnowledgeStore} knowledgeStore - Knowledge store instance
   */
  constructor(bridge, dsCache, knowledgeStore) {
    this.bridge = bridge;
    this.dsCache = dsCache;
    this.knowledgeStore = knowledgeStore;
    this.selectedLibraryKey = null;
  }

  /**
   * Set the selected library key. Once set, all searches filter to this library.
   * @param {string} libraryKey
   */
  setLibrary(libraryKey) {
    this.selectedLibraryKey = libraryKey;
  }

  /**
   * Extract unique library names and keys from search results.
   * Each result is expected to have `libraryName` and `libraryKey` fields
   * (populated by the Figma MCP search_design_system response).
   *
   * @param {Array<{ libraryName?: string, libraryKey?: string }>} searchResults
   * @returns {Array<{ name: string, libraryKey: string }>}
   */
  detectLibraries(searchResults) {
    const seen = new Map();
    for (const r of searchResults) {
      const key = r.libraryKey;
      const name = r.libraryName;
      if (key && !seen.has(key)) {
        seen.set(key, { name: name || 'Unknown', libraryKey: key });
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Filter search results to only the selected library.
   * If no library is selected, returns all results unchanged.
   *
   * @param {Array<{ libraryKey?: string }>} searchResults
   * @returns {Array}
   */
  filterByLibrary(searchResults) {
    if (!this.selectedLibraryKey) return searchResults;
    return searchResults.filter(r => r.libraryKey === this.selectedLibraryKey);
  }

  /**
   * Enumerate all available library components and styles from the plugin.
   * Calls bridge to get plugin's view of the library.
   */
  async enumerateLibrary() {
    if (!this.bridge.connected) {
      throw new Error('Plugin not connected. Open Figma, go to Plugins → Development → Mimic AI → Run.');
    }
    const status = await this.bridge.send('get_plugin_status');

    // The actual library enumeration happens via the Figma MCP (read channel)
    // or via the plugin's local variable/style enumeration.
    // For now, return the plugin status — full enumeration will use
    // the official Figma MCP tools during the build.
    return {
      fileName: status.fileName,
      currentPage: status.currentPage || status.currentPageName,
      enforcementProfile: status.enforcementProfile,
    };
  }

  /**
   * Search for a DS component matching the given element type.
   * First checks the knowledge store (cached mappings), then
   * searches the dsCache if not found.
   *
   * @param {string} elementType - e.g., 'button', 'tab', 'badge', 'header'
   * @returns {{ found: boolean, componentKey?: string, variant?: object, source?: string } | { found: false, searchTerms: string[] }}
   */
  searchComponent(elementType) {
    const base = String(elementType || '').toLowerCase().trim();

    // Check knowledge store first
    const knownComponents = this.knowledgeStore.data.components;
    for (const [id, recipe] of Object.entries(knownComponents)) {
      if (id.toLowerCase().includes(base)) {
        return {
          found: true,
          componentKey: recipe.componentKey,
          variant: recipe.variant,
          recipe,
          source: 'knowledge_store',
          confidence: recipe.confidence || 'moderate',
        };
      }
    }

    // Generate search terms for the element type
    const searchTerms = this.getSearchTerms(base);

    // Collect all matching components from dsCache
    const matches = [];
    for (const [key, component] of this.dsCache.components) {
      const name = (component.name || '').toLowerCase();
      if (searchTerms.some(term => name.includes(term))) {
        matches.push({ key, component });
      }
    }

    // Check for multiple libraries before filtering
    if (matches.length > 0) {
      const libraries = this.detectLibraries(matches.map(m => m.component));
      if (libraries.length > 1 && !this.selectedLibraryKey) {
        return {
          found: false,
          multipleLibraries: true,
          libraries,
          message: 'Multiple DS libraries detected. Which one is your design system?',
        };
      }

      // Filter to selected library
      const filtered = this.selectedLibraryKey
        ? matches.filter(m => m.component.libraryKey === this.selectedLibraryKey)
        : matches;

      if (filtered.length > 0) {
        const { key, component } = filtered[0];
        return {
          found: true,
          componentKey: key,
          componentName: component.name,
          isComponentSet: component.isComponentSet,
          source: 'ds_cache',
          confidence: 'new',
        };
      }
    }

    // Section-level elements (header, footer, sidebar) are high-value DS components
    // that may exist in the library but not be instantiated on the current page.
    // The discovery scan only finds page instances — guide explicit library search.
    const sectionElements = ['header', 'footer', 'sidebar', 'navigation', 'nav', 'topbar', 'bottombar'];
    const isSection = sectionElements.some(s => base.includes(s));

    return {
      found: false,
      searchTerms,
      message: `No DS component found for "${elementType}" in page instances. Searched: ${searchTerms.join(', ')}`,
      fallbackRequired: isSection,
      fallbackHint: isSection
        ? `"${elementType}" is a section-level element that likely exists in the DS library but was not found on this page. You MUST search the library using Figma MCP search_design_system with terms: ${searchTerms.join(', ')}. Do NOT build a custom ${elementType} without first confirming the DS has no component for it.`
        : `If a DS component should exist, search the library using Figma MCP search_design_system with terms: ${searchTerms.join(', ')}.`,
    };
  }

  /**
   * Generate search terms for an element type.
   * Returns multiple variations to handle different naming conventions.
   */
  getSearchTerms(elementType) {
    const base = elementType.toLowerCase().trim();
    const terms = [base];

    const aliases = {
      'button': ['btn', 'cta', 'action'],
      'input': ['text field', 'textfield', 'text input', 'form field'],
      'dropdown': ['select', 'menu', 'combobox', 'picker'],
      'tab': ['tabs', 'tab bar', 'tab group'],
      'badge': ['tag', 'chip', 'pill', 'label'],
      'card': ['tile', 'panel'],
      'table': ['data table', 'grid', 'list'],
      'pagination': ['pager', 'page nav'],
      'header': ['nav', 'navigation', 'top bar', 'app bar', 'navbar'],
      'footer': ['bottom bar', 'footer nav', 'footer navigation', 'site footer', 'page footer'],
      'sidebar': ['side nav', 'sidenav', 'side navigation', 'drawer'],
      'avatar': ['profile', 'user icon'],
      'tooltip': ['popover', 'hint'],
      'modal': ['dialog', 'alert dialog', 'sheet'],
      'checkbox': ['check', 'checkmark'],
      'radio': ['radio button', 'option'],
      'toggle': ['switch'],
      'breadcrumb': ['breadcrumbs', 'path'],
      'divider': ['separator', 'line'],
      'progress': ['progress bar', 'loader', 'spinner'],
      'alert': ['banner', 'notification', 'toast', 'snackbar'],
    };

    if (aliases[base]) {
      terms.push(...aliases[base]);
    }

    return terms;
  }

  /**
   * Build a complete component map from an HTML section inventory.
   *
   * @param {string[]} elementTypes - e.g., ['header', 'button', 'tab', 'table', 'badge', 'footer']
   * @returns {Object} Map of elementType → search result
   */
  buildComponentMap(elementTypes) {
    const map = {};
    for (const type of elementTypes) {
      const result = this.searchComponent(type);
      // If any search triggers the multi-library prompt, return it immediately
      if (result.multipleLibraries) {
        return result;
      }
      map[type] = result;
    }
    return map;
  }

  /**
   * Compare current DS fingerprint with stored one.
   * Returns change detection info.
   */
  detectChanges(currentFingerprint) {
    const stored = this.knowledgeStore.data.dsFingerprint;
    if (!stored) {
      return { changed: false, firstBuild: true };
    }
    if (stored !== currentFingerprint) {
      return { changed: true, previousFingerprint: stored, currentFingerprint };
    }
    return { changed: false };
  }
}

module.exports = { DsDiscovery };
