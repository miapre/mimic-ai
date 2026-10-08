'use strict';

/**
 * DS-copilot guardrail: Mimic builds ONLY from a design system. When a file
 * surfaces no DS at all — no enabled library, zero variables, zero components,
 * zero styles — discovery must STOP and tell the user, never silently proceed
 * into a variable-less / component-less build.
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
  const tmpFile = path.join(os.tmpdir(), `mimic-test-ks-nods-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const knowledgeStore = new KnowledgeStore(tmpFile).load();
  const session = {
    phase: 0, toolCallCount: 0, selectedLibraryKey: null,
    pendingCommunityCheck: false, discoveredLibraries: null, discoveryFileKey: null,
  };
  const toolHandlers = {};
  const register = (name, _d, _s, h) => { toolHandlers[name] = h; };
  const advancePhase = (to) => { session.phase = Math.max(session.phase, to); };
  const resetSession = () => { session.phase = 0; };
  const figmaRest = { validateToken: async () => {} };
  require('../../src/tools/status').register(null, {
    bridge, dsCache, knowledgeStore, session, advancePhase, resetSession, registerTool: register, figmaRest,
  });
  return { toolHandlers, bridge, session };
}

describe('mimic_discover_ds — refuses to build without a design system', () => {
  it('stops with _noDesignSystem when no library, variables, components, or styles are found', async () => {
    const { toolHandlers, bridge } = createContext();
    // Empty everything: no libraries, no variables.
    bridge.setResponse('discover_library_variables', { libraries: [], variables: [], totalVariables: 0 });
    bridge.setResponse('discover_library_components', { components: [] });

    const result = await toolHandlers['mimic_discover_ds']({ fileKey: 'empty-file' });

    assert.equal(result._stopBuild, true, 'must stop the build');
    assert.equal(result._noDesignSystem, true, 'must flag no design system found');
  });

  it('does NOT stop for the skipRestApi escape hatch (community library path)', async () => {
    const { toolHandlers, bridge } = createContext();
    bridge.setResponse('discover_library_variables', { libraries: [], variables: [], totalVariables: 0 });
    bridge.setResponse('discover_library_components', { components: [] });

    const result = await toolHandlers['mimic_discover_ds']({ fileKey: 'empty-file', skipRestApi: true });

    assert.notEqual(result._noDesignSystem, true, 'skipRestApi must not trigger the no-DS stop');
  });
});
