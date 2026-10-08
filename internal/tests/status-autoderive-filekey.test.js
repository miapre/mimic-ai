'use strict';

/**
 * Auto-derive the library file key from a published component key already on
 * the page, so a single-library file never has to prompt for it. Verifies the
 * derived key is cached and the file-key prompt is skipped (REST discovery can
 * then run). Falls back to the prompt when derivation is unavailable — covered
 * by status-single-library-filekey.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { MockBridge } = require('./helpers/mock-bridge');
const { DsCache } = require('../../src/ds/cache');
const { KnowledgeStore } = require('../../src/knowledge/store');

function createContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const tmpFile = path.join(os.tmpdir(), `mimic-test-ks-autoderive-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const knowledgeStore = new KnowledgeStore(tmpFile).load();
  const session = {
    phase: 0, toolCallCount: 0, selectedLibraryKey: null,
    pendingCommunityCheck: false, discoveredLibraries: null, discoveryFileKey: null,
  };
  const toolHandlers = {};
  const register = (name, _d, _s, h) => { toolHandlers[name] = h; };
  const advancePhase = (to) => { session.phase = Math.max(session.phase, to); };
  const resetSession = () => { session.phase = 0; };

  // figmaRest stub: resolveLibraryFileKey succeeds; all fetchers return empty
  // (we only care that discovery proceeds past the file-key prompt).
  const figmaRest = {
    validateToken: async () => {},
    resolveLibraryFileKey: async () => 'DERIVED_LIB_KEY',
    getFileFreshness: async () => ({ version: 1, lastModified: 'x' }),
    getFileComponents: async () => [],
    getFileTextStyles: async () => [],
    getFileFillStyles: async () => [],
    parseEffectStylesResponse: () => [],
    _get: async () => ({}),
  };

  require('../../src/tools/status').register(null, {
    bridge, dsCache, knowledgeStore, session, advancePhase, resetSession, registerTool: register, figmaRest,
  });
  return { toolHandlers, bridge, session, knowledgeStore };
}

describe('mimic_discover_ds — auto-derives the library file key (no prompt)', () => {
  it('derives file_key from a page remote component key, caches it, and skips the file-key prompt', async () => {
    const { toolHandlers, bridge, knowledgeStore } = createContext();
    const ONLY_LIB = 'Acme Design System';

    bridge.setResponse('discover_library_variables', {
      libraries: [{ name: ONLY_LIB, collections: ['Colors'] }],
      variables: [{ path: 'Colors/Background/bg-primary', key: 'v1', resolvedType: 'COLOR', collection: 'Colors', libraryName: ONLY_LIB }],
      totalVariables: 1,
    });
    // A remote component instance exists on the page — its key is what we derive from.
    bridge.setResponse('discover_library_components', {
      components: [{ key: 'remote-comp-key', name: 'Button', isRemote: true, isComponentSet: true }],
    });

    const result = await toolHandlers['mimic_discover_ds']({ fileKey: 'consuming-file' });

    // The file key was derived + cached, so the file-key prompt was skipped and
    // discovery proceeded to the normal community-library check step.
    assert.equal(knowledgeStore.getLibraryFileKey(ONLY_LIB), 'DERIVED_LIB_KEY', 'derived key must be cached');
    assert.notEqual(result._needsLibraryFileKey, true, 'must NOT prompt for the file key once derived');
    assert.equal(result.communityLibraryCheckRequired, true, 'advances to the community check, not the file-key prompt');
  });
});
