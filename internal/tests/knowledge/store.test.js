const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { KnowledgeStore } = require('../../../src/knowledge/store');

const TEST_PATH = path.join(__dirname, 'test-knowledge.json');

describe('KnowledgeStore', () => {
  afterEach(() => { try { fs.unlinkSync(TEST_PATH); } catch {} });

  it('creates new store with correct schema', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.save();
    const data = JSON.parse(fs.readFileSync(TEST_PATH, 'utf-8'));
    assert.equal(data.version, 2);
    assert.ok(data.components);
    assert.ok(data.patterns);
    assert.ok(data.gaps);
    assert.ok(data.meta);
  });

  it('loads existing store', () => {
    fs.writeFileSync(TEST_PATH, JSON.stringify({
      version: 2, dsFingerprint: 'abc',
      components: { 'btn': { componentKey: 'k1' } },
      patterns: {}, gaps: {}, meta: { buildCount: 5 }
    }));
    const store = new KnowledgeStore(TEST_PATH);
    store.load();
    assert.equal(store.data.meta.buildCount, 5);
    assert.equal(store.data.components.btn.componentKey, 'k1');
  });

  it('saves component recipe', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.setComponent('button-primary', {
      componentKey: 'abc123',
      variant: { Size: 'md', Hierarchy: 'Primary' },
      confidence: 'strong',
      buildCount: 1,
    });
    store.save();
    const reloaded = new KnowledgeStore(TEST_PATH);
    reloaded.load();
    assert.equal(reloaded.data.components['button-primary'].componentKey, 'abc123');
  });

  it('stores and retrieves library file keys', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.setLibraryFileKey('LayerLens Theme', '3iUvHvO7znmQUJ3k4hKRVe');
    assert.equal(store.getLibraryFileKey('LayerLens Theme'), '3iUvHvO7znmQUJ3k4hKRVe');
    assert.equal(store.getLibraryFileKey('Unknown'), null);
  });

  it('persists library file keys across save/load', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.setLibraryFileKey('LayerLens Theme', 'abc123');
    store.save();
    const store2 = new KnowledgeStore(TEST_PATH);
    store2.load();
    assert.equal(store2.getLibraryFileKey('LayerLens Theme'), 'abc123');
  });

  it('backfills libraryFileKeys on load of old store', () => {
    fs.writeFileSync(TEST_PATH, JSON.stringify({
      version: 2, dsFingerprint: null,
      components: {}, patterns: {}, gaps: {},
      meta: { buildCount: 0, lastBuild: null, created: null }
    }));
    const store = new KnowledgeStore(TEST_PATH);
    store.load();
    assert.deepEqual(store.data.libraryFileKeys, {});
    store.setLibraryFileKey('Test', 'key123');
    assert.equal(store.getLibraryFileKey('Test'), 'key123');
  });

  it('tracks gap evidence', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.addGap('tab-component', {
      evidence: 'Built as primitive',
      elements: ['nav tabs'],
      estimatedSavings: { toolCalls: 6 },
    });
    assert.ok(store.data.gaps['tab-component']);
    assert.equal(store.data.gaps['tab-component'].elements.length, 1);
  });
});
