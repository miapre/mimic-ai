const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DsResolver } = require('../../../src/ds/resolver');
const { DsCache } = require('../../../src/ds/cache');

describe('DsResolver', () => {
  it('resolves exact variable path', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'v1' });
    const resolver = new DsResolver(cache);
    assert.deepStrictEqual(resolver.resolve('bg-primary'), { key: 'v1' });
  });

  it('fuzzy matches by stripping collection prefix', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'v1' });
    const resolver = new DsResolver(cache);
    assert.deepStrictEqual(resolver.resolve('Colors/Background/bg-primary'), { key: 'v1' });
  });

  it('returns null for unknown paths', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'v1', category: 'background' });
    const resolver = new DsResolver(cache);
    const result = resolver.resolve('bg-tertiary');
    assert.equal(result, null);
  });

  it('lists available variables by category', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'v1', category: 'background' });
    cache.addVariable('bg-secondary', { key: 'v2', category: 'background' });
    cache.addVariable('text-primary', { key: 'v3', category: 'text' });
    const resolver = new DsResolver(cache);
    const available = resolver.listByCategory('background');
    assert.equal(available.length, 2);
  });
});
