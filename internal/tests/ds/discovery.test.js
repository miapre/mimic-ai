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
    const cache = new DsCache();
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
