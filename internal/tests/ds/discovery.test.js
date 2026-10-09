const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DsDiscovery } = require('../../../src/ds/discovery');
const { DsCache } = require('../../../src/ds/cache');
const { KnowledgeStore } = require('../../../src/knowledge/store');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function makeKnowledgeStore(components = {}) {
  const tmpFile = path.join(os.tmpdir(), `mimic-test-ks-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({
    version: 2, dsFingerprint: null,
    components, patterns: {}, gaps: {},
    meta: { buildCount: 0, lastBuild: null, created: new Date().toISOString() },
  }));
  return new KnowledgeStore(tmpFile).load();
}

describe('DsDiscovery.searchComponent', () => {
  it('returns component from knowledge store when key exists', () => {
    // Schema v3: __default__-bucket recipes (unclaimed migration leftovers,
    // or — as here — a store never scoped to a specific library) are only
    // eligible via tier 2 if their componentKey is present in the live
    // dsCache (spec §5.3 tier 2) — claim-by-evidence is what would normally
    // have moved a genuinely-live recipe out of __default__. Seed the cache
    // so this recipe is "live" for the purposes of this test.
    const cache = new DsCache();
    cache.addComponent('btn-key-123', { name: 'Button' });
    const ks = makeKnowledgeStore({
      'Button': { componentKey: 'btn-key-123', variant: { Size: 'md' } },
    });
    const discovery = new DsDiscovery(null, cache, ks);
    const result = discovery.searchComponent('button');
    assert.equal(result.found, true);
    assert.equal(result.componentKey, 'btn-key-123');
    assert.equal(result.source, 'knowledge_store');
  });

  it('skips knowledge store entry with null componentKey and falls through to DS cache', () => {
    const cache = new DsCache();
    // Simulate REST API cache having the component
    cache.addComponent('table-cell-key-abc', {
      name: 'Table cell',
      libraryKey: 'lib-1',
      isComponentSet: true,
    });
    const ks = makeKnowledgeStore({
      'Table cell': { componentKey: null, variant: null },
    });
    const discovery = new DsDiscovery(null, cache, ks);
    discovery.setLibrary('lib-1');
    const result = discovery.searchComponent('table cell');
    assert.equal(result.found, true);
    assert.equal(result.componentKey, 'table-cell-key-abc');
    assert.equal(result.source, 'ds_cache');
  });

  it('returns not found when both knowledge store and DS cache miss', () => {
    const cache = new DsCache();
    const ks = makeKnowledgeStore({
      'Table cell': { componentKey: null },
    });
    const discovery = new DsDiscovery(null, cache, ks);
    const result = discovery.searchComponent('table cell');
    assert.equal(result.found, false);
  });

  it('prioritizes component sets over icons with same search term', () => {
    const cache = new DsCache();
    // Icon: short lowercase name containing "button" via alias match
    cache.addComponent('icon-help-key', {
      name: 'help-octagon',
      libraryKey: 'lib-1',
      source: 'rest_api',
      // REST API does not set isComponentSet
    });
    // Real UI component set
    cache.addComponent('button-set-key', {
      name: 'Buttons/Button',
      libraryKey: 'lib-1',
      isComponentSet: true,
    });
    const ks = makeKnowledgeStore();
    const discovery = new DsDiscovery(null, cache, ks);
    discovery.setLibrary('lib-1');
    const result = discovery.searchComponent('button');
    assert.equal(result.found, true);
    assert.equal(result.componentKey, 'button-set-key');
    assert.equal(result.componentName, 'Buttons/Button');
  });

  it('prioritizes structured names over icon-style names from REST API', () => {
    const cache = new DsCache();
    // REST API components without isComponentSet
    cache.addComponent('icon-filter-key', {
      name: 'filter-lines',
      libraryKey: 'lib-1',
      source: 'rest_api',
    });
    cache.addComponent('divider-set-key', {
      name: 'Content divider',
      libraryKey: 'lib-1',
      source: 'rest_api',
    });
    const ks = makeKnowledgeStore();
    const discovery = new DsDiscovery(null, cache, ks);
    discovery.setLibrary('lib-1');
    const result = discovery.searchComponent('divider');
    assert.equal(result.found, true);
    assert.equal(result.componentKey, 'divider-set-key');
    assert.equal(result.componentName, 'Content divider');
  });

  it('prioritizes exact name match over substring match', () => {
    const cache = new DsCache();
    // "award-badge-01" contains "badge" but is an icon
    cache.addComponent('award-badge-key', {
      name: 'award-badge-01',
      libraryKey: 'lib-1',
      source: 'rest_api',
    });
    // "Badge" is the real component
    cache.addComponent('badge-set-key', {
      name: 'Badge',
      libraryKey: 'lib-1',
      source: 'rest_api',
    });
    const ks = makeKnowledgeStore();
    const discovery = new DsDiscovery(null, cache, ks);
    discovery.setLibrary('lib-1');
    const result = discovery.searchComponent('badge');
    assert.equal(result.found, true);
    assert.equal(result.componentKey, 'badge-set-key');
  });

  it('prioritizes variant-syntax names over plain icons', () => {
    const cache = new DsCache();
    cache.addComponent('icon-input-key', {
      name: 'text-input',
      libraryKey: 'lib-1',
      source: 'rest_api',
    });
    cache.addComponent('input-set-key', {
      name: 'Input field',
      libraryKey: 'lib-1',
      source: 'rest_api',
    });
    const ks = makeKnowledgeStore();
    const discovery = new DsDiscovery(null, cache, ks);
    discovery.setLibrary('lib-1');
    const result = discovery.searchComponent('input');
    assert.equal(result.found, true);
    assert.equal(result.componentKey, 'input-set-key');
    assert.equal(result.componentName, 'Input field');
  });

  it('ingestLibrarySearchResults upgrades isComponentSet on existing entries', () => {
    const cache = new DsCache();
    // REST API cached without isComponentSet
    cache.addComponent('badge-key', {
      name: 'badge-icon',
      libraryKey: 'MyLib',
      source: 'rest_api',
    });
    const ks = makeKnowledgeStore();
    const discovery = new DsDiscovery(null, cache, ks);
    discovery.setLibrary('MyLib');

    // Figma MCP search confirms it's a component set with a better name
    const ingested = discovery.ingestLibrarySearchResults([{
      name: 'Badge',
      componentKey: 'badge-key',
      libraryName: 'MyLib',
      assetType: 'component_set',
    }]);

    assert.equal(ingested, 1);
    const cached = cache.components.get('badge-key');
    assert.equal(cached.isComponentSet, true);
    assert.equal(cached.name, 'Badge');
  });

  it('filters DS cache results by selectedLibraryKey', () => {
    const cache = new DsCache();
    cache.addComponent('wrong-lib-key', {
      name: 'Badge',
      libraryKey: 'lib-other',
    });
    cache.addComponent('right-lib-key', {
      name: 'Badge',
      libraryKey: 'lib-target',
    });
    const ks = makeKnowledgeStore();
    const discovery = new DsDiscovery(null, cache, ks);
    discovery.setLibrary('lib-target');
    const result = discovery.searchComponent('badge');
    assert.equal(result.found, true);
    assert.equal(result.componentKey, 'right-lib-key');
  });
});

describe('DsDiscovery.searchComponent — removed component keys', () => {
  it('does not surface a ds-cache component whose key is flagged component_removed', () => {
    const cache = new DsCache();
    cache.addComponent('card-header-removed', {
      name: 'Card header', libraryKey: 'lib-1', isComponentSet: true,
    });
    const ks = makeKnowledgeStore({
      'card-header-removed': {
        componentKey: 'card-header-removed', names: ['Card header'],
        stale: true, staleReason: 'component_removed',
      },
    });
    const discovery = new DsDiscovery(null, cache, ks);
    discovery.setLibrary('lib-1');
    const result = discovery.searchComponent('card');
    assert.equal(result.found, false, 'a removed component key must never be served');
  });

  it('prefers the real set variant (frame identity) over a coincidental name match', () => {
    const cache = new DsCache();
    // Real Button: REST caches the variant under its variant-property name
    // (no "button" in it); the set identity lives in containingFrame.
    cache.addComponent('real-btn', { name: 'Size=md, Hierarchy=Primary, State=Default', containingFrame: 'Button', libraryKey: 'lib' });
    // Coincidental: a radio/file-upload variant whose NAME contains "button".
    cache.addComponent('radio-btn', { name: 'Selected=True, Type=Radio button w/ file upload', containingFrame: 'Checkboxes and radios', libraryKey: 'lib' });
    const d = new DsDiscovery(null, cache, makeKnowledgeStore());
    d.setLibrary('lib');
    const r = d.searchComponent('button');
    assert.equal(r.found, true);
    assert.equal(r.componentKey, 'real-btn', 'frame identity must beat a coincidental name hit');
  });

  it('does not pick a variant-property coincidence ("Badge=False") over the real Badge set', () => {
    const cache = new DsCache();
    // A form-field whose NAME contains the word "badge" only as a variant property.
    cache.addComponent('label-field', { name: 'Size=sm, Actions=False, Badge=False', containingFrame: 'Input field', libraryKey: 'lib' });
    // The real Badge: the word is nowhere in the variant name, only in the frame.
    cache.addComponent('real-badge', { name: 'Color=Gray, Size=sm', containingFrame: 'Badge', libraryKey: 'lib' });
    const d = new DsDiscovery(null, cache, makeKnowledgeStore());
    d.setLibrary('lib');
    const r = d.searchComponent('badge');
    assert.equal(r.componentKey, 'real-badge', 'the real Badge set must win over a Badge=False variant property');
  });

  it('"table" resolves to the Table cell set (leading-word identity), not a List component', () => {
    const cache = new DsCache();
    cache.addComponent('table-cell', { name: 'Style=Text', containingFrame: 'Table cell', libraryKey: 'lib' });
    cache.addComponent('list-item', { name: 'Type=Default', containingFrame: 'List', libraryKey: 'lib' });
    const d = new DsDiscovery(null, cache, makeKnowledgeStore());
    d.setLibrary('lib');
    const r = d.searchComponent('table');
    assert.equal(r.found, true);
    assert.equal(r.componentKey, 'table-cell', 'leading-word identity "Table cell" ~ "table"; List is no longer a table alias');
  });

  it('prefers a live component over a removed one with the same name', () => {
    const cache = new DsCache();
    cache.addComponent('badge-removed', { name: 'Badge', libraryKey: 'lib-1', isComponentSet: true });
    cache.addComponent('badge-live', { name: 'Badge', libraryKey: 'lib-1', isComponentSet: true });
    const ks = makeKnowledgeStore({
      'badge-removed': {
        componentKey: 'badge-removed', names: ['Badge'],
        stale: true, staleReason: 'component_removed',
      },
    });
    const discovery = new DsDiscovery(null, cache, ks);
    discovery.setLibrary('lib-1');
    const result = discovery.searchComponent('badge');
    assert.equal(result.found, true);
    assert.equal(result.componentKey, 'badge-live', 'the live key must win over the removed one');
  });
});
