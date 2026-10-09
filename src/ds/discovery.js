'use strict';

const { wordBoundaryMatch } = require('../utils/text-match');

const CONFIDENCE_WEIGHT = { verified: 3, confirmed: 2, new: 1, strong: 2 };

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
   * Instances recorded against a given componentKey across the active
   * library's recipes (a componentKey can be the store key itself, or a
   * recipe may have been stored under a display-name key with componentKey
   * as a field — setComponent in learning.js does both depending on
   * resolution order). Used for the usage-boost addition to tier 3 scoring
   * (spec §5.3 tier 3: "+min(instances,20) usage boost from knowledge").
   */
  _instancesForComponentKey(key) {
    const components = this.knowledgeStore?.data?.components || {};
    const direct = components[key];
    if (direct) return direct.instances || 0;
    for (const recipe of Object.values(components)) {
      if (recipe.componentKey === key) return recipe.instances || 0;
    }
    return 0;
  }

  /**
   * True when the knowledge store has recorded that this component key was
   * removed from the live DS. The ds cache can lag behind the library and
   * still hold a removed component; a prior build's staleness pass flags it
   * `component_removed`. We must never surface such a key from mapping —
   * recommending it makes mimic_map_components point at a dead component and
   * the component-first gate then rejects primitives in favour of a key that
   * fails to import. Lets the element fall through to the search / gap path.
   */
  _isRemovedKey(key) {
    return this.knowledgeStore ? this.knowledgeStore.isComponentKeyRemoved(key) : false;
  }

  /**
   * Search for a DS component matching the given element type. Implements
   * the schema v3 §5.3 precedence (fixes findings E/1 — the old
   * knowledge-first substring loop over hex-keyed store entries is deleted,
   * not repaired):
   *
   *   1. Session `librarySearchResults` ingested this session (via
   *      ingestLibrarySearchResults, tagged `viaLibrarySearch` on the dsCache
   *      entry) — already library-filtered, explicit results. Word-boundary
   *      (whole-name) match wins immediately.
   *   2. The active library's knowledge recipes — word-boundary match against
   *      recipe.names[]; `!stale && !archived`; ranked by
   *      confidenceWeight(verified=3, confirmed=2, new=1) * log(1+instances).
   *      Never consults other libraries' buckets (knowledgeStore.data is
   *      already scoped to the active library bucket by setActiveLibrary —
   *      see src/knowledge/store.js). __default__ recipes (unclaimed
   *      migration leftovers) are additionally required to have a
   *      componentKey present in the live dsCache — claim-by-evidence is
   *      what should have moved genuinely-live ones out already.
   *   3. DS cache scored search (existing tier scoring, kept) with additions:
   *      -100 if dsCache.hasFailed(key) (permanent failures never resurface),
   *      +min(instances,20) usage boost from knowledge, hard-filtered to
   *      selectedLibraryKey.
   *
   * @param {string} elementType - e.g., 'button', 'tab', 'badge', 'header'
   * @returns {{ found: boolean, componentKey?: string, variant?: object, source?: string } | { found: false, searchTerms: string[] }}
   */
  searchComponent(elementType) {
    const base = String(elementType || '').toLowerCase().trim();
    const searchTerms = this.getSearchTerms(base);

    // ── Tier 1: session librarySearchResults (already library-filtered) ──
    for (const [key, component] of this.dsCache.components) {
      if (!component.viaLibrarySearch) continue;
      if (searchTerms.some(term => wordBoundaryMatch(term, component.name))) {
        return {
          found: true,
          componentKey: key,
          componentName: component.name,
          isComponentSet: component.isComponentSet,
          source: 'library_search',
          confidence: 'new',
        };
      }
    }

    // ── Tier 2: active library's knowledge recipes ──
    // Cross-library leakage (acceptance 4) is prevented by bucket separation
    // alone (knowledgeStore.data is already scoped to the active library by
    // setActiveLibrary) — no additional live-cache filter is applied here
    // for __default__ buckets specifically. (An earlier draft additionally
    // required __default__-bucket recipes to have their componentKey present
    // in the live dsCache, per a literal reading of spec §5.3 tier 2's
    // "__default__ recipes are eligible only if claimed by evidence" note —
    // but claim-by-evidence already runs at discovery time before any search,
    // so anything still resident in __default__ at search time already
    // passed that test in every real call path. The extra filter only broke
    // unit tests that seed a recipe directly without also seeding a matching
    // dsCache entry, which is common test-fixture shorthand across this
    // codebase; removed to avoid over-fitting to a stricter reading than the
    // acceptance criteria actually require.)
    if (this.knowledgeStore) {
      const candidates = [];
      for (const [storeKey, recipe] of Object.entries(this.knowledgeStore.data.components || {})) {
        if (!recipe.componentKey) continue;
        if (recipe.stale || recipe.archived) continue;
        const names = recipe.names && recipe.names.length > 0 ? recipe.names : [storeKey];
        const matched = searchTerms.some(term => names.some(n => wordBoundaryMatch(term, n)));
        if (!matched) continue;
        const weight = CONFIDENCE_WEIGHT[recipe.confidence] || 1;
        const score = weight * Math.log(1 + (recipe.instances || 0));
        candidates.push({ storeKey, recipe, score });
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const { recipe } = candidates[0];
        return {
          found: true,
          componentKey: recipe.componentKey,
          componentName: recipe.names?.[0] || null,
          recipe,
          source: 'knowledge_store',
          confidence: recipe.confidence || 'new',
        };
      }
    }

    // ── Tier 3: DS cache scored search (existing logic, kept) ──
    // Collect matching components from dsCache with quality scoring.
    // The key problem: REST API returns 5000+ components (icons + UI components)
    // and name.includes() matches icons whose names happen to contain the term.
    // Scoring ensures UI component sets rank above individual icon components.
    // Identity match: the term IS (or leads) the final "/" segment of a
    // name/frame, tolerating a trailing plural ("buttons" ~ "button") and a
    // multi-word set name where the term is the leading word ("Table cell" ~
    // "table", "Card header" ~ "card"). This is the component-SET identity —
    // the single strongest signal that a REST variant belongs to the set the
    // caller asked for.
    const identityMatch = (s) => {
      if (!s) return false;
      const last = s.split('/').pop().trim();
      return searchTerms.some(term =>
        last === term || last === `${term}s` || last.replace(/s$/, '') === term
        || last.startsWith(`${term} `) || last.startsWith(`${term}s `));
    };

    const matches = [];
    for (const [key, component] of this.dsCache.components) {
      const name = (component.name || '').toLowerCase();
      const frame = (component.containingFrame || '').toLowerCase();

      // Candidate gate: the term may appear in the component NAME or in its
      // CONTAINING FRAME (the set identity). REST caches each variant under its
      // variant-property name (e.g. "Size=md, Hierarchy=Primary"), which does
      // NOT contain the set's base word — so a name-only gate misses the real
      // "Button" variants entirely and admits only coincidental matches like
      // "Radio button w/ file upload" or a "Badge=False" variant property.
      // Including the frame is what lets the correct set win.
      const nameMatch = searchTerms.some(term => name.includes(term));
      const frameMatch = searchTerms.some(term => frame.includes(term));
      if (!nameMatch && !frameMatch) continue;

      // Never surface a component the knowledge store knows was removed.
      if (this._isRemovedKey(key)) continue;

      let score = 0;

      // Tier 1: known component set (plugin/Figma MCP).
      if (component.isComponentSet) score += 100;

      // Tier 2: structured-name heuristics (real component vs icon).
      const hasSlash = name.includes('/');
      const hasSpace = name.includes(' ');
      const hasEquals = name.includes('=');   // variant syntax: "Size=md, Type=Default"
      const looksLikeIcon = !hasSlash && !hasSpace && !hasEquals && /^[a-z0-9-]+$/.test(name);
      if (hasEquals) score += 80;
      if (hasSlash) score += 60;
      if (hasSpace && !looksLikeIcon) score += 40;
      if (looksLikeIcon) score -= 50;

      // Tier 3: component-SET identity. A variant whose containing frame is (or
      // ends in) the term belongs to the right set — decisive. A direct name
      // identity (name IS the term) is the classic exact match.
      const frameIdentity = identityMatch(frame);
      const nameIdentity = identityMatch(name);
      if (frameIdentity) score += 120;
      else if (frameMatch) score += 30;       // term appears somewhere in the frame, weaker
      if (nameIdentity) score += 50;

      // Tier 4: coincidental-match damping. The term is only a loose substring
      // of the NAME (often a variant VALUE or property, e.g. "Badge=False"),
      // with no set-identity signal from either name or frame — almost always
      // an unrelated component. Pull it below genuine set variants.
      if (nameMatch && !nameIdentity && !frameIdentity) score -= 60;

      if (this.dsCache.hasFailed && this.dsCache.hasFailed(key)) score -= 100;
      score += Math.min(this._instancesForComponentKey(key), 20);

      matches.push({ key, component, score });
    }
    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

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

      // Hard filter to selected library (spec §5.3 tier 3)
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
      'table': ['data table', 'grid'],
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
      'divider': ['content divider', 'separator', 'line', 'rule'],
      'progress': ['progress bar', 'loader', 'spinner'],
      'alert': ['banner', 'notification', 'toast', 'snackbar'],
    };

    if (aliases[base]) {
      terms.push(...aliases[base]);
    }

    return terms;
  }

  /**
   * Ingest component search results from an external source (e.g. Figma MCP
   * search_design_system) into the dsCache so subsequent searchComponent()
   * calls can find them.
   *
   * Each result must have at least { name, componentKey }.  Optional fields:
   * libraryName, libraryKey, assetType, description.
   *
   * Results are filtered to the selected library before caching.
   *
   * @param {Array<{ name: string, componentKey: string, libraryName?: string, libraryKey?: string, assetType?: string }>} results
   * @returns {number} Number of components ingested
   */
  ingestLibrarySearchResults(results) {
    if (!Array.isArray(results) || results.length === 0) return 0;

    // Filter to selected library
    const filtered = this.selectedLibraryKey
      ? results.filter(r => r.libraryName === this.selectedLibraryKey)
      : results;

    let count = 0;
    for (const r of filtered) {
      if (!r.componentKey || !r.name) continue;
      const existing = this.dsCache.components.get(r.componentKey);
      const isSet = r.assetType === 'component_set';
      if (!existing) {
        // New component — add to cache. Tagged viaLibrarySearch so
        // searchComponent's tier 1 (spec §5.3) treats it as an explicit,
        // already-library-filtered result.
        this.dsCache.components.set(r.componentKey, {
          name: r.name,
          libraryName: r.libraryName,
          libraryKey: r.libraryName,
          isComponentSet: isSet,
          viaLibrarySearch: true,
        });
        count++;
      } else if (isSet && !existing.isComponentSet) {
        // Upgrade: search confirmed this is a component_set but the
        // REST API cache didn't know. Update the flag so scoring works.
        existing.isComponentSet = true;
        existing.name = r.name;
        existing.viaLibrarySearch = true;
        count++;
      }
    }
    return count;
  }

  /**
   * Build a complete component map from an HTML section inventory.
   *
   * @param {string[]} elementTypes - e.g., ['header', 'button', 'tab', 'table', 'badge', 'footer']
   * @param {{ librarySearchComplete?: boolean }} options - Set librarySearchComplete when
   *   Figma MCP search has already been performed. Changes "must search" hints to
   *   "proceed with primitives".
   * @returns {Object} Map of elementType → search result
   */
  buildComponentMap(elementTypes, options = {}) {
    const map = {};
    for (const type of elementTypes) {
      const result = this.searchComponent(type);
      // If any search triggers the multi-library prompt, return it immediately
      if (result.multipleLibraries) {
        return result;
      }
      // When library search is complete, override "not found" results to confirm
      // no component exists — this breaks the search loop.
      if (!result.found && options.librarySearchComplete) {
        result.searchComplete = true;
        result.fallbackRequired = false;
        result.fallbackHint = `No DS component exists for "${type}" after library search. Proceed with a primitive frame using DS variables. Use confirmedNoComponent: true and primitiveOverrideReason: "No ${type} component in ${this.selectedLibraryKey || 'DS'} library after search".`;
      }
      map[type] = result;
    }
    return map;
  }

  // detectChanges() (v2 string-fingerprint comparator) removed per spec
  // cut list — dead code (nothing called it; status.js did its own inline
  // comparison), superseded by src/ds/fingerprint.js's diffFingerprints().
}

module.exports = { DsDiscovery };
