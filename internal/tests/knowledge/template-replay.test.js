'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { MockBridge } = require('../helpers/mock-bridge');
const { DsCache } = require('../../../src/ds/cache');
const { DsResolver } = require('../../../src/ds/resolver');
const { KnowledgeStore } = require('../../../src/knowledge/store');
const { BuildManifest } = require('../../../src/knowledge/manifest');

/**
 * Build a test context with mock bridge, register components + learning tools.
 */
function createTestContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  const knowledgeStore = new KnowledgeStore(path.join(__dirname, '.test-replay-knowledge.json'));
  const buildManifest = new BuildManifest();

  const session = {
    phase: 3, // build phase — components require phase >= 2
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
    componentTextTracker: new Map(),
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

  const context = {
    bridge,
    dsCache,
    dsResolver,
    knowledgeStore,
    buildManifest,
    session,
    requirePhase,
    advancePhase,
    registerTool,
  };

  // Register components and learning tool modules
  require('../../../src/tools/components').register(null, context);
  require('../../../src/tools/learning').register(null, context);

  return { context, handlers, bridge, session, dsCache, buildManifest, knowledgeStore };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('Template Replay — Variant Config Tracking', () => {
  let handlers, bridge, session;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;

    // Mock insert_component to return a known nodeId + componentKey
    bridge.setResponse('insert_component', {
      nodeId: 'node-456',
      name: 'Button',
      type: 'INSTANCE',
      componentKey: 'btn-key-123',
      configurationHints: {},
    });

    // Mock get_node_props for the parent (needed by auto-sizing logic)
    bridge.setResponse('get_node_props', {
      id: 'parent-1',
      name: 'Parent',
      type: 'FRAME',
      width: 400,
      height: 300,
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'VERTICAL',
    });
  });

  it('tracks nodeId → componentKey on insert and records variant config', async () => {
    // Insert a component
    await handlers.figma_insert_component({
      componentKey: 'btn-key-123',
      parentId: 'parent-1',
      name: 'Primary Button',
    });

    // Verify nodeId → componentKey mapping was created
    assert.ok(session._nodeComponentKeys, '_nodeComponentKeys should be created');
    assert.strictEqual(
      session._nodeComponentKeys.get('node-456'),
      'btn-key-123',
      'nodeId should map to componentKey'
    );

    // Set variant on the inserted component
    await handlers.figma_set_variant({
      nodeId: 'node-456',
      properties: { Size: 'Large', State: 'Default' },
    });

    // Verify variant config was recorded keyed by componentKey
    assert.ok(session._variantConfigs, '_variantConfigs should be created');
    assert.deepStrictEqual(
      session._variantConfigs.get('btn-key-123'),
      { Size: 'Large', State: 'Default' },
      'variant config should be stored under componentKey'
    );
  });

  it('merges variant properties across multiple set_variant calls', async () => {
    // Insert a component
    await handlers.figma_insert_component({
      componentKey: 'btn-key-123',
      parentId: 'parent-1',
    });

    // Set variant — first call
    await handlers.figma_set_variant({
      nodeId: 'node-456',
      properties: { Size: 'Large' },
    });

    // Set variant — second call with additional property
    await handlers.figma_set_variant({
      nodeId: 'node-456',
      properties: { State: 'Hover' },
    });

    assert.deepStrictEqual(
      session._variantConfigs.get('btn-key-123'),
      { Size: 'Large', State: 'Hover' },
      'variant configs should merge across calls'
    );
  });

  it('does not record variant config when nodeId has no componentKey mapping', async () => {
    // Call set_variant on a nodeId that was never inserted
    await handlers.figma_set_variant({
      nodeId: 'unknown-node',
      properties: { Size: 'Small' },
    });

    // _variantConfigs may or may not exist, but should have no entries
    const configs = session._variantConfigs;
    if (configs) {
      assert.strictEqual(configs.size, 0, 'no variant config should be stored for unknown nodeId');
    }
  });
});

const REPLAY_STORE_PATH = path.join(__dirname, '.test-replay.json');

describe('Template Replay — recipe persistence', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('persists variant config as defaultVariants in recipe after build report', async () => {
    session._componentInsertions = new Map([
      ['btn-key-123', { count: 2, names: ['Button'] }],
    ]);
    session._variantConfigs = new Map([
      ['btn-key-123', { Size: 'sm', Hierarchy: 'Primary' }],
    ]);
    session.phaseToolCalls[3] = 10;

    await handlers.mimic_generate_build_report({
      screenName: 'Test Screen',
      components: [{ name: 'Button', instances: 2, componentKey: 'btn-key-123' }],
      primitives: [],
      toolCallCount: 25,
      cacheHits: 0,
    });

    const recipe = knowledgeStore.getComponent('btn-key-123');
    assert.ok(recipe, 'Recipe should exist');
    assert.deepStrictEqual(recipe.defaultVariants, { Size: 'sm', Hierarchy: 'Primary' });
  });
});

describe('Template Replay — auto-apply on insert', () => {
  let handlers, bridge, session, knowledgeStore, dsCache;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    dsCache = ctx.dsCache;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('auto-applies defaultVariants from confirmed recipe on insert', async () => {
    knowledgeStore.setComponent('btn-key-456', {
      names: ['Button'],
      componentKey: 'btn-key-456',
      buildCount: 4,
      confidence: 'confirmed',
      defaultVariants: { Size: 'sm', Hierarchy: 'Primary' },
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:99',
      name: 'Button',
      componentKey: 'btn-key-456',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    const result = await handlers.figma_insert_component({
      componentKey: 'btn-key-456',
      parentId: 'parent:1',
    });

    const variantMsgs = bridge.getMessages('set_variant');
    assert.strictEqual(variantMsgs.length, 1);
    assert.strictEqual(variantMsgs[0].payload.nodeId, 'node:99');
    assert.deepStrictEqual(variantMsgs[0].payload.properties, {
      Size: 'sm', Hierarchy: 'Primary',
    });

    assert.ok(result._autoApplied);
    assert.deepStrictEqual(result._autoApplied.variants, {
      Size: 'sm', Hierarchy: 'Primary',
    });
  });

  it('does NOT auto-apply variants for new (unconfirmed) recipes', async () => {
    knowledgeStore.setComponent('btn-key-789', {
      names: ['Button'],
      componentKey: 'btn-key-789',
      buildCount: 1,
      confidence: 'new',
      defaultVariants: { Size: 'lg' },
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:100',
      name: 'Button',
      componentKey: 'btn-key-789',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    await handlers.figma_insert_component({
      componentKey: 'btn-key-789',
      parentId: 'parent:1',
    });

    const variantMsgs = bridge.getMessages('set_variant');
    assert.strictEqual(variantMsgs.length, 0);
  });

  it('allows variant override when applyRecipe is false', async () => {
    knowledgeStore.setComponent('btn-key-override', {
      names: ['Button'],
      componentKey: 'btn-key-override',
      buildCount: 5,
      confidence: 'confirmed',
      defaultVariants: { Size: 'sm' },
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:101',
      name: 'Button',
      componentKey: 'btn-key-override',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    await handlers.figma_insert_component({
      componentKey: 'btn-key-override',
      parentId: 'parent:1',
      applyRecipe: false,
    });

    const variantMsgs = bridge.getMessages('set_variant');
    assert.strictEqual(variantMsgs.length, 0);
  });
});

describe('Template Replay — savings tracking', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('tracks replaySavings in session and includes in build report', async () => {
    knowledgeStore.setComponent('btn-key-sav', {
      names: ['Button'],
      componentKey: 'btn-key-sav',
      buildCount: 4,
      confidence: 'confirmed',
      defaultVariants: { Size: 'sm' },
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:200',
      name: 'Button',
      componentKey: 'btn-key-sav',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    await handlers.figma_insert_component({
      componentKey: 'btn-key-sav',
      parentId: 'parent:1',
    });

    assert.strictEqual(session.replaySavings, 1);

    // Generate report
    session._componentInsertions = new Map([
      ['btn-key-sav', { count: 1, names: ['Button'] }],
    ]);
    session.phaseToolCalls[3] = 5;

    const report = await handlers.mimic_generate_build_report({
      screenName: 'Savings Test',
      components: [{ name: 'Button', instances: 1, componentKey: 'btn-key-sav' }],
      primitives: [],
      toolCallCount: 10,
      cacheHits: 1,
    });

    assert.ok(report.summary.includes('1 replayed'));
  });
});

describe('Template Replay — build history', () => {
  it('records replaySavings in build history', () => {
    const store = new KnowledgeStore(REPLAY_STORE_PATH);
    store.recordBuild({
      screenName: 'Dashboard',
      toolCalls: 50,
      cacheHits: 5,
      replaySavings: 3,
      componentCount: 8,
      primitiveCount: 2,
      bindingFailures: 0,
      componentUsagePercent: 80,
    });
    const history = store.getBuildHistory();
    assert.strictEqual(history[0].replaySavings, 3);
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });
});
