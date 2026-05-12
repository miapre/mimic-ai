const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DsCache } = require('../../../src/ds/cache');

describe('DsCache', () => {
  it('stores and retrieves text styles by key', () => {
    const cache = new DsCache();
    cache.addTextStyle('abc123', { name: 'Display xl/Semibold', fontFamily: 'Inter', fontSize: 60 });
    const style = cache.getTextStyle('abc123');
    assert.equal(style.name, 'Display xl/Semibold');
  });

  it('stores and retrieves color variables by path', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'var123', collection: 'Colors', resolvedValue: '#ffffff' });
    const v = cache.getVariable('bg-primary');
    assert.equal(v.key, 'var123');
  });

  it('returns null for unknown paths', () => {
    const cache = new DsCache();
    assert.equal(cache.getVariable('nonexistent'), null);
  });

  it('builds enforcement profile from inventory', () => {
    const cache = new DsCache();
    cache.addTextStyle('abc', { name: 'Text sm' });
    cache.addVariable('bg-primary', { key: 'v1', collection: 'Colors', category: 'background' });
    const profile = cache.getEnforcementProfile();
    assert.equal(profile.enforceTextStyles, true);
    assert.equal(profile.enforceColorVars, true);
    assert.equal(profile.enforceSpacingVars, false);
    assert.equal(profile.enforceRadiusVars, false);
  });

  it('clears all cached data', () => {
    const cache = new DsCache();
    cache.addTextStyle('abc', { name: 'Test' });
    cache.clear();
    assert.equal(cache.getTextStyle('abc'), null);
  });
});
