'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { MockBridge } = require('../helpers/mock-bridge');
const { DsCache } = require('../../../src/ds/cache');
const { DsResolver } = require('../../../src/ds/resolver');
const { KnowledgeStore } = require('../../../src/knowledge/store');
const { BuildManifest } = require('../../../src/knowledge/manifest');

/**
 * Build a full tool context with a mock bridge.
 * Registers all tool modules and returns the handler map.
 */
function createTestContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  // Use a temp path that won't collide with real data
  const knowledgeStore = new KnowledgeStore(path.join(__dirname, '.test-knowledge.json'));
  const buildManifest = new BuildManifest();

  const session = {
    phase: 0,
    artboardId: null,
    enforcementProfile: null,
    toolCallCount: 0,
    cacheHits: 0,
    selectedLibraryKey: null,
    expectedStyleCount: null,
    consecutiveFailures: 0,
    phaseToolCalls: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    checkpointIssued: false,
    bindingFailures: [],
  };

  const handlers = {};

  function registerTool(name, _description, _inputSchema, handler) {
    handlers[name] = handler;
  }

  function requirePhase(minPhase, hint) {
    const { PhaseError } = require('../../../src/utils/errors');
    if (session.phase < minPhase) throw new PhaseError(session.phase, minPhase, hint);
  }

  function advancePhase(to) {
    session.phase = Math.max(session.phase, to);
  }

  function resetSession() {
    session.phase = 0;
    session.artboardId = null;
    session.toolCallCount = 0;
    session.cacheHits = 0;
    session.consecutiveFailures = 0;
    session.phaseToolCalls = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    session.checkpointIssued = false;
    session.bindingFailures = [];
  }

  const context = {
    bridge,
    dsCache,
    dsResolver,
    knowledgeStore,
    buildManifest,
    session,
    requirePhase,
    advancePhase,
    resetSession,
    registerTool,
  };

  // Register all tool modules
  require('../../../src/tools/status').register(null, context);
  require('../../../src/tools/ds-setup').register(null, context);
  require('../../../src/tools/build').register(null, context);
  require('../../../src/tools/components').register(null, context);
  require('../../../src/tools/edit').register(null, context);
  require('../../../src/tools/inspect').register(null, context);
  require('../../../src/tools/learning').register(null, context);
  require('../../../src/tools/batch').register(null, context);
  require('../../../src/tools/compliance').register(null, context);
  require('../../../src/tools/rendering').register(null, context);

  return { context, handlers, bridge, session, dsCache, buildManifest, knowledgeStore };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('MCP Tool Integration', () => {
  let ctx, handlers, bridge, session, dsCache, buildManifest, knowledgeStore;

  beforeEach(() => {
    const setup = createTestContext();
    ctx = setup.context;
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;
    dsCache = setup.dsCache;
    buildManifest = setup.buildManifest;
    knowledgeStore = setup.knowledgeStore;
  });

  // ── 1. mimic_status ───────────────────────────────────────────

  describe('mimic_status', () => {
    it('returns phase and connection info', async () => {
      const result = await handlers.mimic_status({});
      assert.strictEqual(result.phase, 0);
      assert.strictEqual(result.phaseLabel, 'idle');
      assert.strictEqual(result.pluginConnected, true);
      assert.strictEqual(result.toolCallCount, 0);
      assert.ok(result.hint);
    });

    it('reflects current session state', async () => {
      session.phase = 3;
      session.toolCallCount = 15;
      session.artboardId = 'art:1';
      const result = await handlers.mimic_status({});
      assert.strictEqual(result.phase, 3);
      assert.strictEqual(result.phaseLabel, 'build');
      assert.strictEqual(result.toolCallCount, 15);
      assert.strictEqual(result.artboardId, 'art:1');
    });

    it('includes dsCache counts', async () => {
      dsCache.addTextStyle('key1', { name: 'Text sm' });
      dsCache.addVariable('bg-primary', { key: 'v1', category: 'background' });
      const result = await handlers.mimic_status({});
      assert.strictEqual(result.dsCache.textStyles, 1);
      assert.strictEqual(result.dsCache.variables, 1);
    });
  });

  // ── 2. figma_set_session_defaults ─────────────────────────────

  describe('figma_set_session_defaults', () => {
    it('sends enforcement profile to plugin and advances to phase 2', async () => {
      dsCache.addTextStyle('key1', { name: 'Text sm' });
      const result = await handlers.figma_set_session_defaults({});
      const msgs = bridge.getMessages('set_session_defaults');
      assert.strictEqual(msgs.length, 1);
      assert.ok(msgs[0].payload.enforcementProfile);
      assert.strictEqual(session.phase, 2);
    });

    it('rejects permissive mode when DS has tokens', async () => {
      dsCache.addVariable('bg-primary', { key: 'v1', category: 'background' });
      const result = await handlers.figma_set_session_defaults({ dsMode: 'permissive' });
      assert.strictEqual(result.error, 'DS_MODE_REJECTED');
      // Should NOT have sent anything to the bridge
      assert.strictEqual(bridge.getMessages('set_session_defaults').length, 0);
    });
  });

  // ── 3. figma_create_frame ─────────────────────────────────────

  describe('figma_create_frame', () => {
    it('requires phase >= 2', async () => {
      session.phase = 0;
      await assert.rejects(
        () => handlers.figma_create_frame({ name: 'Test' }),
        (err) => {
          assert.strictEqual(err.error, 'PHASE_REQUIRED');
          return true;
        }
      );
    });

    it('sends correct bridge message when phase is met', async () => {
      session.phase = 3;
      const result = await handlers.figma_create_frame({
        name: 'Metrics Row',
        direction: 'VERTICAL',
        parentId: 'parent:1',
      });
      assert.ok(result.nodeId);
      const msgs = bridge.getMessages('create_frame');
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].payload.name, 'Metrics Row');
      assert.strictEqual(msgs[0].payload.direction, 'VERTICAL');
    });

    it('records section in build manifest when parentId is set', async () => {
      session.phase = 3;
      await handlers.figma_create_frame({ name: 'Metrics Row', parentId: 'parent:1' });
      const found = buildManifest.findBySection('metrics');
      assert.ok(found);
      assert.strictEqual(found.htmlSection, 'Metrics Row');
    });

    it('advances phase to 3', async () => {
      session.phase = 2;
      await handlers.figma_create_frame({ name: 'Test', parentId: 'p:1' });
      assert.strictEqual(session.phase, 3);
    });
  });

  // ── 4. figma_create_text ──────────────────────────────────────

  describe('figma_create_text', () => {
    it('sends correct bridge message', async () => {
      session.phase = 3;
      const result = await handlers.figma_create_text({
        content: 'Hello World',
        name: 'Greeting',
        parentId: 'mock:1',
      });
      assert.ok(result.nodeId);
      const msgs = bridge.getMessages('create_text');
      assert.strictEqual(msgs[0].payload.content, 'Hello World');
      assert.strictEqual(msgs[0].payload.name, 'Greeting');
    });

    it('requires phase >= 2', async () => {
      session.phase = 1;
      await assert.rejects(
        () => handlers.figma_create_text({ content: 'Test', parentId: 'p:1' }),
        (err) => err.error === 'PHASE_REQUIRED'
      );
    });
  });

  // ── 5. figma_insert_component ─────────────────────────────────

  describe('figma_insert_component', () => {
    it('sends component key and returns config hints', async () => {
      session.phase = 3;
      const result = await handlers.figma_insert_component({
        componentKey: 'abc123',
        name: 'Primary Button',
        parentId: 'parent:1',
      });
      assert.ok(result.nodeId);
      assert.ok(result.hints);
      assert.ok(Array.isArray(result.hints));
      const msgs = bridge.getMessages('insert_component');
      assert.strictEqual(msgs[0].payload.componentKey, 'abc123');
    });

    it('rejects previously failed component keys', async () => {
      session.phase = 3;
      dsCache.markFailed('bad-key');
      const result = await handlers.figma_insert_component({
        componentKey: 'bad-key',
        parentId: 'p:1',
      });
      assert.strictEqual(result.error, 'COMPONENT_PREVIOUSLY_FAILED');
      // Should NOT have sent to bridge
      assert.strictEqual(bridge.getMessages('insert_component').length, 0);
    });

    it('records component in build manifest', async () => {
      session.phase = 3;
      await handlers.figma_insert_component({
        componentKey: 'key1',
        name: 'Submit Button',
        parentId: 'p:1',
      });
      const found = buildManifest.findBySection('Submit Button');
      assert.ok(found);
      assert.strictEqual(found.type, 'component');
    });
  });

  // ── 6. figma_set_component_text ───────────────────────────────

  describe('figma_set_component_text', () => {
    it('sends correct params to bridge', async () => {
      session.phase = 3;
      await handlers.figma_set_component_text({
        nodeId: 'mock:1',
        textNodeName: 'Label',
        content: 'Submit',
      });
      const msgs = bridge.getMessages('set_component_text');
      assert.strictEqual(msgs[0].payload.textNodeName, 'Label');
      assert.strictEqual(msgs[0].payload.content, 'Submit');
      assert.strictEqual(msgs[0].payload.nodeId, 'mock:1');
    });
  });

  // ── 7. figma_set_variant ──────────────────────────────────────

  describe('figma_set_variant', () => {
    it('sends properties correctly', async () => {
      session.phase = 3;
      await handlers.figma_set_variant({
        nodeId: 'mock:1',
        properties: { Size: 'md', Hierarchy: 'Primary' },
      });
      const msgs = bridge.getMessages('set_variant');
      assert.deepStrictEqual(msgs[0].payload.properties, {
        Size: 'md',
        Hierarchy: 'Primary',
      });
    });
  });

  // ── 8. mimic_find_node ────────────────────────────────────────

  describe('mimic_find_node', () => {
    it('searches build manifest and returns match', async () => {
      buildManifest.addSection('Header Section', 'node:100', 'frame');
      buildManifest.addSection('Metrics Row', 'node:200', 'frame');
      const result = await handlers.mimic_find_node({ sectionName: 'header' });
      assert.strictEqual(result.found, true);
      assert.strictEqual(result.figmaNodeId, 'node:100');
    });

    it('returns available sections when not found', async () => {
      buildManifest.addSection('Header', 'node:100', 'frame');
      buildManifest.addSection('Footer', 'node:200', 'frame');
      const result = await handlers.mimic_find_node({ sectionName: 'sidebar' });
      assert.strictEqual(result.found, false);
      assert.ok(result.available.includes('Header'));
      assert.ok(result.available.includes('Footer'));
    });
  });

  // ── 9. figma_validate_ds_compliance ───────────────────────────

  describe('figma_validate_ds_compliance', () => {
    it('sends validate message to bridge', async () => {
      const result = await handlers.figma_validate_ds_compliance({ nodeId: 'art:1' });
      const msgs = bridge.getMessages('validate_ds_compliance');
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].payload.nodeId, 'art:1');
      assert.ok(result.summary);
      assert.strictEqual(result.summary.violations, 0);
    });

    it('returns violations when bridge reports them', async () => {
      bridge.setResponse('validate_ds_compliance', {
        violations: [{ nodeId: 'n:1', rule: 'no-raw-hex', severity: 'error' }],
        summary: { totalNodes: 10, compliant: 9, violations: 1 },
      });
      const result = await handlers.figma_validate_ds_compliance({ nodeId: 'art:1' });
      assert.strictEqual(result.violations.length, 1);
      assert.strictEqual(result.summary.violations, 1);
    });
  });

  // ── 10. figma_batch ───────────────────────────────────────────

  describe('figma_batch', () => {
    it('executes multiple operations sequentially', async () => {
      session.phase = 3;
      const result = await handlers.figma_batch({
        operations: [
          { type: 'create_frame', payload: { name: 'Row 1' } },
          { type: 'create_text', payload: { content: 'Label', parentId: 'p:1' } },
          { type: 'set_visibility', payload: { nodeId: 'n:1', visible: false } },
        ],
      });
      assert.strictEqual(result.total, 3);
      assert.strictEqual(result.succeeded, 3);
      assert.strictEqual(result.failed, 0);
      // Verify each operation sent the right bridge message
      assert.strictEqual(bridge.getMessages('create_frame').length, 1);
      assert.strictEqual(bridge.getMessages('create_text').length, 1);
      assert.strictEqual(bridge.getMessages('set_visibility').length, 1);
    });

    it('requires phase >= 2', async () => {
      session.phase = 0;
      await assert.rejects(
        () => handlers.figma_batch({ operations: [{ type: 'create_frame', payload: {} }] }),
        (err) => err.error === 'PHASE_REQUIRED'
      );
    });

    it('rejects empty batch', async () => {
      session.phase = 3;
      const result = await handlers.figma_batch({ operations: [] });
      assert.strictEqual(result.error, 'EMPTY_BATCH');
    });

    it('rejects oversized batch', async () => {
      session.phase = 3;
      const ops = Array.from({ length: 7 }, (_, i) => ({
        type: 'create_frame',
        payload: { name: `Frame ${i}` },
      }));
      const result = await handlers.figma_batch({ operations: ops });
      assert.strictEqual(result.error, 'BATCH_TOO_LARGE');
    });

    it('reports individual failures without stopping the batch', async () => {
      session.phase = 3;
      bridge.setResponse('create_frame', () => {
        throw new Error('Plugin timeout');
      });
      const result = await handlers.figma_batch({
        operations: [
          { type: 'create_frame', payload: { name: 'Fail' } },
          { type: 'create_text', payload: { content: 'OK', parentId: 'p:1' } },
        ],
      });
      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.failed, 1);
      assert.strictEqual(result.succeeded, 1);
      assert.strictEqual(result.results[0].ok, false);
      assert.strictEqual(result.results[1].ok, true);
    });
  });

  // ── Cross-cutting: toolCallCount ──────────────────────────────

  describe('toolCallCount tracking', () => {
    it('increments on build tools', async () => {
      session.phase = 3;
      assert.strictEqual(session.toolCallCount, 0);
      await handlers.figma_create_frame({ name: 'Test', parentId: 'p:1' });
      assert.strictEqual(session.toolCallCount, 1);
      await handlers.figma_create_text({ content: 'Hi', parentId: 'p:1' });
      assert.strictEqual(session.toolCallCount, 2);
    });

    it('increments on inspect tools', async () => {
      session.phase = 3;
      await handlers.figma_get_node_props({ nodeId: 'n:1' });
      assert.strictEqual(session.toolCallCount, 1);
    });

    it('increments per batch operation', async () => {
      session.phase = 3;
      await handlers.figma_batch({
        operations: [
          { type: 'create_frame', payload: { name: 'A' } },
          { type: 'create_frame', payload: { name: 'B' } },
        ],
      });
      assert.strictEqual(session.toolCallCount, 2);
    });
  });

  // ── DS setup flow ─────────────────────────────────────────────

  describe('figma_preload_styles', () => {
    it('sends style keys to bridge and caches returned styles', async () => {
      bridge.setResponse('preload_styles', {
        preloadedStyles: 2,
        styleCacheSize: 2,
        styles: [
          { key: 'k1', name: 'Text sm', fontFamily: 'Inter', fontSize: 14 },
          { key: 'k2', name: 'Text lg', fontFamily: 'Inter', fontSize: 18 },
        ],
      });
      const result = await handlers.figma_preload_styles({
        styleKeys: ['k1', 'k2'],
      });
      assert.strictEqual(result.cached, 2);
      assert.strictEqual(dsCache.textStyles.size, 2);
      assert.ok(dsCache.getTextStyle('k1'));
    });

    it('warns on partial load', async () => {
      bridge.setResponse('preload_styles', {
        preloadedStyles: 5,
        styles: [],
      });
      const result = await handlers.figma_preload_styles({
        styleKeys: ['k1', 'k2', 'k3', 'k4', 'k5'],
        expectedCount: 20,
      });
      assert.ok(result.warning);
      assert.ok(result.warning.includes('Partial'));
    });
  });

  describe('figma_preload_variables', () => {
    it('caches variables and sends to bridge', async () => {
      const result = await handlers.figma_preload_variables({
        variables: [
          { path: 'bg-primary', key: 'v1', collection: 'Colors', category: 'background' },
          { path: 'spacing-md', key: 'v2', collection: 'Spacing', category: 'spacing' },
        ],
      });
      assert.strictEqual(dsCache.variables.size, 2);
      assert.ok(dsCache.getVariable('bg-primary'));
      const msgs = bridge.getMessages('preload_variables');
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].payload.variables.length, 2);
    });
  });
});
