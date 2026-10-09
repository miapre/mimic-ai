'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FigmaRest } = require('../../src/figma-rest');

describe('FigmaRest', () => {
  it('throws if no token provided', () => {
    assert.throws(() => new FigmaRest(), /token/i);
    assert.throws(() => new FigmaRest(''), /token/i);
  });

  it('parseComponentsResponse extracts component keys and names', () => {
    const rest = new FigmaRest('figd_test');
    const raw = {
      meta: {
        components: [
          { key: 'abc123', name: 'Button', description: 'Primary button', containing_frame: { name: 'Buttons' } },
          { key: 'def456', name: 'Badge', description: '', containing_frame: { name: 'Badges' } },
        ]
      }
    };
    const result = rest.parseComponentsResponse(raw);
    assert.equal(result.length, 2);
    assert.equal(result[0].key, 'abc123');
    assert.equal(result[0].name, 'Button');
    assert.equal(result[0].containingFrame, 'Buttons');
    assert.equal(result[1].key, 'def456');
    assert.equal(result[1].name, 'Badge');
  });

  it('parseStylesResponse filters to TEXT styles only', () => {
    const rest = new FigmaRest('figd_test');
    const raw = {
      meta: {
        styles: [
          { key: 's1', name: 'Display lg', style_type: 'TEXT', description: '' },
          { key: 's2', name: 'Brand/Primary', style_type: 'FILL', description: '' },
          { key: 's3', name: 'Text sm', style_type: 'TEXT', description: '' },
        ]
      }
    };
    const result = rest.parseStylesResponse(raw);
    assert.equal(result.length, 2);
    assert.equal(result[0].key, 's1');
    assert.equal(result[0].name, 'Display lg');
    assert.equal(result[1].key, 's3');
  });

  it('getFileComponents requests page_size=1000 (team/library components pagination cap raised, 2026)', async () => {
    const rest = new FigmaRest('figd_test');
    let requestedPath = null;
    rest._get = async (p) => { requestedPath = p; return { meta: { components: [] } }; };

    await rest.getFileComponents('abc123');
    assert.equal(requestedPath, '/files/abc123/components?page_size=1000');
  });

  it('parseComponentsResponse handles empty/missing meta gracefully', () => {
    const rest = new FigmaRest('figd_test');
    assert.deepEqual(rest.parseComponentsResponse({}), []);
    assert.deepEqual(rest.parseComponentsResponse({ meta: {} }), []);
    assert.deepEqual(rest.parseComponentsResponse({ meta: { components: [] } }), []);
  });

  it('parseStylesResponse handles empty/missing meta gracefully', () => {
    const rest = new FigmaRest('figd_test');
    assert.deepEqual(rest.parseStylesResponse({}), []);
    assert.deepEqual(rest.parseStylesResponse({ meta: {} }), []);
    assert.deepEqual(rest.parseStylesResponse({ meta: { styles: [] } }), []);
  });

  it('resolveLibraryFileKey returns meta.file_key from a component_set key', async () => {
    const rest = new FigmaRest('figd_test');
    const paths = [];
    rest._get = async (p) => { paths.push(p); return { meta: { file_key: 'LIBKEY123' } }; };
    const fk = await rest.resolveLibraryFileKey('setkey');
    assert.equal(fk, 'LIBKEY123');
    assert.equal(paths[0], '/component_sets/setkey', 'tries component_sets first');
  });

  it('resolveLibraryFileKey falls through component_sets -> components -> styles on 404', async () => {
    const rest = new FigmaRest('figd_test');
    const tried = [];
    rest._get = async (p) => {
      tried.push(p);
      if (p.startsWith('/styles/')) return { meta: { file_key: 'FROM_STYLE' } };
      throw new Error('FIGMA_NOT_FOUND: nope');
    };
    const fk = await rest.resolveLibraryFileKey('k');
    assert.equal(fk, 'FROM_STYLE');
    assert.deepEqual(tried, ['/component_sets/k', '/components/k', '/styles/k']);
  });

  it('resolveLibraryFileKey returns null when nothing resolves or key is falsy', async () => {
    const rest = new FigmaRest('figd_test');
    rest._get = async () => { throw new Error('FIGMA_NOT_FOUND'); };
    assert.equal(await rest.resolveLibraryFileKey('k'), null);
    assert.equal(await rest.resolveLibraryFileKey(''), null);
  });
});

describe('FigmaRest.getTextStylesWithFallback', () => {
  it('falls back to the working file when the library file publishes no text styles', async () => {
    const rest = new FigmaRest('figd_test');
    const calls = [];
    rest.getFileTextStyles = async (fileKey) => {
      calls.push(fileKey);
      return fileKey === 'working-file' ? [{ key: 's1', name: 'Text sm' }] : [];
    };
    const styles = await rest.getTextStylesWithFallback('library-file', 'working-file');
    assert.deepEqual(calls, ['library-file', 'working-file'], 'tries library first, then working file');
    assert.equal(styles.length, 1);
    assert.equal(styles[0].key, 's1');
  });

  it('uses library-file styles and never hits the working file when present', async () => {
    const rest = new FigmaRest('figd_test');
    const calls = [];
    rest.getFileTextStyles = async (fileKey) => { calls.push(fileKey); return [{ key: 'lib1', name: 'Display sm' }]; };
    const styles = await rest.getTextStylesWithFallback('library-file', 'working-file');
    assert.deepEqual(calls, ['library-file']);
    assert.equal(styles[0].key, 'lib1');
  });

  it('survives a throwing library fetch and still returns working-file styles', async () => {
    const rest = new FigmaRest('figd_test');
    rest.getFileTextStyles = async (fileKey) => {
      if (fileKey === 'library-file') throw new Error('403');
      return [{ key: 'w1', name: 'Text md' }];
    };
    const styles = await rest.getTextStylesWithFallback('library-file', 'working-file');
    assert.equal(styles.length, 1);
    assert.equal(styles[0].key, 'w1');
  });

  it('does not double-fetch when library and working keys are identical', async () => {
    const rest = new FigmaRest('figd_test');
    const calls = [];
    rest.getFileTextStyles = async (fileKey) => { calls.push(fileKey); return []; };
    const styles = await rest.getTextStylesWithFallback('same', 'same');
    assert.deepEqual(calls, ['same']);
    assert.equal(styles.length, 0);
  });

  it('discovers from the working file even with no library file key', async () => {
    const rest = new FigmaRest('figd_test');
    const calls = [];
    rest.getFileTextStyles = async (fileKey) => { calls.push(fileKey); return [{ key: 'w2', name: 'Text lg' }]; };
    const styles = await rest.getTextStylesWithFallback(null, 'working-file');
    assert.deepEqual(calls, ['working-file']);
    assert.equal(styles[0].key, 'w2');
  });
});
