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

  // ── resolveTextStyleKey ────────────────────────────────────────

  it('resolves style name to key', () => {
    const cache = new DsCache();
    cache.addTextStyle('key123', { name: 'Text sm/Semibold' });
    assert.equal(cache.resolveTextStyleKey('Text sm/Semibold'), 'key123');
  });

  it('resolves style name case-insensitively', () => {
    const cache = new DsCache();
    cache.addTextStyle('key456', { name: 'Display xl/Bold' });
    assert.equal(cache.resolveTextStyleKey('display xl/bold'), 'key456');
  });

  it('passes through existing keys', () => {
    const cache = new DsCache();
    cache.addTextStyle('direct-key', { name: 'Text xs/Regular' });
    assert.equal(cache.resolveTextStyleKey('direct-key'), 'direct-key');
  });

  it('returns null for unknown names', () => {
    const cache = new DsCache();
    cache.addTextStyle('key789', { name: 'Text md/Medium' });
    assert.equal(cache.resolveTextStyleKey('Nonexistent Style'), null);
  });

  it('returns null for null/undefined input', () => {
    const cache = new DsCache();
    assert.equal(cache.resolveTextStyleKey(null), null);
    assert.equal(cache.resolveTextStyleKey(undefined), null);
  });

  it('restComponentCount counts only rest_api-sourced components', () => {
    const cache = new DsCache();
    cache.addComponent('a', { name: 'Button', source: 'rest_api' });
    cache.addComponent('b', { name: 'Badge', source: 'page_scan' });
    cache.addComponent('c', { name: 'Card', source: 'rest_api' });
    cache.addComponent('d', { name: 'Icon' }); // no source
    assert.equal(cache.restComponentCount(), 2);
  });

  it('componentEnumerationDegraded: true when cache is page-scan-only and no library file key', () => {
    const cache = new DsCache();
    cache.addComponent('b', { name: 'Badge', source: 'page_scan' });
    assert.equal(cache.componentEnumerationDegraded(null), true);
  });

  it('componentEnumerationDegraded: false once a library file key enabled REST enumeration', () => {
    const cache = new DsCache();
    cache.addComponent('a', { name: 'Button', source: 'rest_api' });
    assert.equal(cache.componentEnumerationDegraded('lib-file-key'), false);
    // also false when a key is present even if cache is page-scan (REST was attempted)
    const cache2 = new DsCache();
    cache2.addComponent('b', { name: 'Badge', source: 'page_scan' });
    assert.equal(cache2.componentEnumerationDegraded('lib-file-key'), false);
  });

  it('componentEnumerationDegraded: false for an empty cache (nothing to be wrong about yet)', () => {
    const cache = new DsCache();
    assert.equal(cache.componentEnumerationDegraded(null), false);
  });

  it('validateVariables does NOT flag a border-* fill on a 1px horizontal divider', () => {
    const cache = new DsCache();
    cache.addVariable('Colors/Border/border-tertiary', { key: 'b1', category: 'border' });
    const res = cache.validateVariables({ shape: 'rectangle', height: 1, fillVariable: 'Colors/Border/border-tertiary' });
    assert.equal((res.categoryMismatches || []).length, 0, 'a hairline divider fill is legitimate');
    assert.equal((res.categoryMismatchDetails || []).length, 0);
  });

  it('validateVariables does NOT flag a border-* fill on a 1px vertical divider', () => {
    const cache = new DsCache();
    cache.addVariable('Colors/Border/border-secondary', { key: 'b2', category: 'border' });
    const res = cache.validateVariables({ shape: 'rectangle', width: 1, fillVariable: 'Colors/Border/border-secondary' });
    assert.equal((res.categoryMismatches || []).length, 0);
  });

  it('validateVariables STILL flags a border-* fill on a normal-sized surface', () => {
    const cache = new DsCache();
    cache.addVariable('Colors/Border/border-tertiary', { key: 'b1', category: 'border' });
    const res = cache.validateVariables({ width: 200, height: 100, fillVariable: 'Colors/Border/border-tertiary' });
    assert.equal((res.categoryMismatches || []).length, 1, 'border-as-fill on a real surface is still a mismatch');
  });
});
