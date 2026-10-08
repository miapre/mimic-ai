'use strict';

/**
 * Regression test: single enabled DS library must trigger the library-file-key
 * capture (and therefore REST discovery of published text/fill/effect styles
 * and the full component set) — the same path a multi-library file takes after
 * the user picks a library.
 *
 * The bug: the multi-library gate in src/tools/status.js only fires when
 * varDiscovery.libraries.length > 1. With exactly one library, selectedLibraryKey
 * stayed null, so the "needs library file key" prompt (gated on a selected
 * library) never fired, libraryFileKey stayed null, and every REST fetch
 * (components + styles) was skipped. Result: 0 text styles / 0 fill styles and
 * a partial component set even though the DS publishes them — the build then
 * silently fell back to raw font-size variables and primitives.
 *
 * The fix auto-selects the sole discovered library so the existing file-key
 * prompt fires. This test drives the REAL mimic_discover_ds handler.
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
  const tmpFile = path.join(os.tmpdir(), `mimic-test-ks-singlelib-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const knowledgeStore = new KnowledgeStore(tmpFile).load();

  const session = {
    phase: 0,
    toolCallCount: 0,
    selectedLibraryKey: null,
    pendingCommunityCheck: false,
    discoveredLibraries: null,
    discoveryFileKey: null,
    discoveryResults: null,
    completenessWarnings: null,
    enforcementProfile: null,
  };

  const toolHandlers = {};
  function registerTool(name, _desc, _schema, handler) { toolHandlers[name] = handler; }
  function advancePhase(to) { session.phase = Math.max(session.phase, to); }
  function resetSession() { session.phase = 0; }

  const figmaRest = { validateToken: async () => {} };

  require('../../src/tools/status').register(null, {
    bridge, dsCache, knowledgeStore, session,
    advancePhase, resetSession, registerTool, figmaRest,
  });

  return { toolHandlers, bridge, session };
}

describe('mimic_discover_ds — single-library auto-select triggers file-key capture', () => {
  it('auto-selects the sole discovered library and stops to request its file key (so REST style/component discovery can run)', async () => {
    const { toolHandlers, bridge, session } = createContext();
    const discover = toolHandlers['mimic_discover_ds'];
    assert.ok(discover, 'mimic_discover_ds must be registered');

    const FILE_KEY = 'consuming-file-key';
    const ONLY_LIB = 'Acme Design System';

    // Exactly one enabled library, with variables (so the single-library path,
    // not the community/externalVariables path, is exercised).
    bridge.setResponse('discover_library_variables', {
      libraries: [{ name: ONLY_LIB, collections: ['Colors', 'Spacing', 'Typography'] }],
      variables: [
        { path: 'Colors/Background/bg-primary', key: 'var-bg-primary', resolvedType: 'COLOR', collection: 'Colors', libraryName: ONLY_LIB },
      ],
      totalVariables: 1,
    });

    const result = await discover({ fileKey: FILE_KEY });

    // The sole library is auto-selected…
    assert.equal(session.selectedLibraryKey, ONLY_LIB, 'single library must be auto-selected');
    // …and discovery STOPS to capture the library file key, instead of silently
    // proceeding with no REST discovery.
    assert.equal(result._stopBuild, true, 'build must stop until the library file key is provided');
    assert.equal(result._needsLibraryFileKey, true, 'must request the library file key');
    assert.equal(result.selectedLibraryKey, ONLY_LIB);
  });

  it('does NOT prompt for a file key when skipRestApi is set (community/public library escape hatch)', async () => {
    const { toolHandlers, bridge, session } = createContext();
    const discover = toolHandlers['mimic_discover_ds'];

    const FILE_KEY = 'consuming-file-key';
    const ONLY_LIB = 'Acme Design System';
    bridge.setResponse('discover_library_variables', {
      libraries: [{ name: ONLY_LIB, collections: ['Colors'] }],
      variables: [
        { path: 'Colors/Background/bg-primary', key: 'var-bg-primary', resolvedType: 'COLOR', collection: 'Colors', libraryName: ONLY_LIB },
      ],
      totalVariables: 1,
    });

    const result = await discover({ fileKey: FILE_KEY, skipRestApi: true });

    // Still auto-selected, but the file-key prompt is bypassed by skipRestApi.
    assert.equal(session.selectedLibraryKey, ONLY_LIB);
    assert.notEqual(result._needsLibraryFileKey, true, 'skipRestApi must bypass the file-key prompt');
  });
});
