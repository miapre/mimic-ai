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

// ─── Edge Case Tests ──────────────────────────────────────────────

describe('Template Replay — override after auto-apply', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('manual set_variant after auto-apply overrides the recipe values', async () => {
    knowledgeStore.setComponent('btn-override', {
      names: ['Button'],
      componentKey: 'btn-override',
      buildCount: 5,
      confidence: 'verified',
      defaultVariants: { Size: 'sm', Hierarchy: 'Primary', Icon: 'Default' },
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:ov-1',
      name: 'Button',
      componentKey: 'btn-override',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    const result = await handlers.figma_insert_component({
      componentKey: 'btn-override',
      parentId: 'parent:1',
    });

    // Auto-applied the recipe defaults
    assert.ok(result._autoApplied);
    assert.deepStrictEqual(result._autoApplied.variants, {
      Size: 'sm', Hierarchy: 'Primary', Icon: 'Default',
    });

    // First set_variant was the auto-apply
    let variantMsgs = bridge.getMessages('set_variant');
    assert.strictEqual(variantMsgs.length, 1);

    // Now manually override with different values
    await handlers.figma_set_variant({
      nodeId: 'node:ov-1',
      properties: { Hierarchy: 'Secondary gray' },
    });

    // Bridge should have received TWO set_variant calls total
    variantMsgs = bridge.getMessages('set_variant');
    assert.strictEqual(variantMsgs.length, 2);
    assert.deepStrictEqual(variantMsgs[1].payload.properties, { Hierarchy: 'Secondary gray' });

    // The session variant config should reflect the merged state
    // (auto-applied + manual override)
    assert.deepStrictEqual(
      session._variantConfigs.get('btn-override'),
      { Hierarchy: 'Secondary gray' },
      'manual override recorded in session (only the manual call gets tracked)'
    );
  });

  it('applyRecipe: false skips auto-apply, then manual set_variant works normally', async () => {
    knowledgeStore.setComponent('btn-skip', {
      names: ['Button'],
      componentKey: 'btn-skip',
      buildCount: 5,
      confidence: 'confirmed',
      defaultVariants: { Size: 'sm' },
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:skip-1',
      name: 'Button',
      componentKey: 'btn-skip',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    const result = await handlers.figma_insert_component({
      componentKey: 'btn-skip',
      parentId: 'parent:1',
      applyRecipe: false,
    });

    assert.strictEqual(result._autoApplied, undefined);
    assert.strictEqual(bridge.getMessages('set_variant').length, 0);

    // Manual variant call works
    await handlers.figma_set_variant({
      nodeId: 'node:skip-1',
      properties: { Size: 'lg', Hierarchy: 'Tertiary gray' },
    });

    assert.strictEqual(bridge.getMessages('set_variant').length, 1);
    assert.deepStrictEqual(
      session._variantConfigs.get('btn-skip'),
      { Size: 'lg', Hierarchy: 'Tertiary gray' }
    );
  });
});

describe('Template Replay — last-write-wins behavior', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('last set_variant call wins when same component used with different configs', async () => {
    // Insert Badge #1 with Color: Success
    bridge.setResponse('insert_component', (payload) => ({
      nodeId: payload.name === 'Badge: Active' ? 'node:b1' : 'node:b2',
      name: payload.name,
      componentKey: 'badge-lw',
      type: 'INSTANCE',
    }));
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    await handlers.figma_insert_component({
      componentKey: 'badge-lw',
      parentId: 'parent:1',
      name: 'Badge: Active',
    });

    await handlers.figma_set_variant({
      nodeId: 'node:b1',
      properties: { Size: 'sm', Color: 'Success' },
    });

    // Insert Badge #2 with Color: Warning
    await handlers.figma_insert_component({
      componentKey: 'badge-lw',
      parentId: 'parent:1',
      name: 'Badge: Warning',
    });

    await handlers.figma_set_variant({
      nodeId: 'node:b2',
      properties: { Size: 'sm', Color: 'Warning' },
    });

    // Last write wins — Color should be Warning
    assert.deepStrictEqual(
      session._variantConfigs.get('badge-lw'),
      { Size: 'sm', Color: 'Warning' },
      'last set_variant call should win for the same componentKey'
    );

    // Persist and verify
    session._componentInsertions = new Map([
      ['badge-lw', { count: 2, names: ['Badge'] }],
    ]);
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'LW Test',
      components: [{ name: 'Badge', instances: 2, componentKey: 'badge-lw' }],
      primitives: [],
      toolCallCount: 10,
      cacheHits: 0,
    });

    const recipe = knowledgeStore.getComponent('badge-lw');
    assert.strictEqual(recipe.defaultVariants.Color, 'Warning',
      'persisted defaultVariants should reflect last-write-wins');
  });
});

describe('Template Replay — recipe drift across builds', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('subsequent builds update defaultVariants (recipe evolves)', async () => {
    // Pre-populate a recipe from a prior build
    knowledgeStore.setComponent('badge-drift', {
      names: ['Badge'],
      componentKey: 'badge-drift',
      buildCount: 2,
      confidence: 'new',
      defaultVariants: { Size: 'sm', Color: 'Success' },
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:drift-1',
      name: 'Badge',
      componentKey: 'badge-drift',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    // Insert and set a DIFFERENT color
    await handlers.figma_insert_component({
      componentKey: 'badge-drift',
      parentId: 'parent:1',
    });

    await handlers.figma_set_variant({
      nodeId: 'node:drift-1',
      properties: { Size: 'sm', Color: 'Error' },
    });

    session._componentInsertions = new Map([
      ['badge-drift', { count: 1, names: ['Badge'] }],
    ]);
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'Drift Test',
      components: [{ name: 'Badge', instances: 1, componentKey: 'badge-drift' }],
      primitives: [],
      toolCallCount: 10,
      cacheHits: 0,
    });

    const recipe = knowledgeStore.getComponent('badge-drift');
    // New color should overwrite old — recipe evolves with latest usage
    assert.strictEqual(recipe.defaultVariants.Color, 'Error',
      'recipe should evolve to reflect latest build variant config');
    // Size should be preserved (merge, not replace)
    assert.strictEqual(recipe.defaultVariants.Size, 'sm',
      'unchanged properties should be preserved');
  });
});

describe('Template Replay — error recovery', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('insert succeeds even when auto-apply set_variant fails', async () => {
    knowledgeStore.setComponent('btn-err', {
      names: ['Button'],
      componentKey: 'btn-err',
      buildCount: 5,
      confidence: 'confirmed',
      defaultVariants: { Size: 'sm' },
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:err-1',
      name: 'Button',
      componentKey: 'btn-err',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    // Make set_variant throw an error
    bridge.setResponse('set_variant', () => {
      throw new Error('Plugin disconnected');
    });

    const result = await handlers.figma_insert_component({
      componentKey: 'btn-err',
      parentId: 'parent:1',
    });

    // Insert should succeed
    assert.strictEqual(result.nodeId, 'node:err-1');
    // Auto-apply should NOT be reported
    assert.strictEqual(result._autoApplied, undefined);
    // No replay savings counted
    assert.strictEqual(session.replaySavings || 0, 0);
    // Hint should mention the failure
    assert.ok(result.hints.some(h => h.includes('auto-apply failed')),
      'hints should mention the failure');
  });
});

describe('Template Replay — multiple set_variant calls merge correctly', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('two set_variant calls on same nodeId merge into one recipe entry', async () => {
    bridge.setResponse('insert_component', {
      nodeId: 'node:merge-1',
      name: 'Button',
      componentKey: 'btn-merge',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    await handlers.figma_insert_component({
      componentKey: 'btn-merge',
      parentId: 'parent:1',
    });

    // First call: set Size
    await handlers.figma_set_variant({
      nodeId: 'node:merge-1',
      properties: { Size: 'sm' },
    });

    // Second call: set Hierarchy (should merge, not replace)
    await handlers.figma_set_variant({
      nodeId: 'node:merge-1',
      properties: { Hierarchy: 'Secondary gray' },
    });

    // Third call: override Size (should update)
    await handlers.figma_set_variant({
      nodeId: 'node:merge-1',
      properties: { Size: 'lg' },
    });

    assert.deepStrictEqual(
      session._variantConfigs.get('btn-merge'),
      { Size: 'lg', Hierarchy: 'Secondary gray' },
      'multiple calls should merge, with later values overriding earlier ones'
    );

    // Persist and verify
    session._componentInsertions = new Map([
      ['btn-merge', { count: 1, names: ['Button'] }],
    ]);
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'Merge Test',
      components: [{ name: 'Button', instances: 1, componentKey: 'btn-merge' }],
      primitives: [],
      toolCallCount: 10,
      cacheHits: 0,
    });

    const recipe = knowledgeStore.getComponent('btn-merge');
    assert.deepStrictEqual(recipe.defaultVariants, { Size: 'lg', Hierarchy: 'Secondary gray' },
      'persisted recipe should reflect merged variant config');
  });
});

describe('Template Replay — empty defaultVariants', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('does NOT auto-apply when defaultVariants is empty object', async () => {
    knowledgeStore.setComponent('btn-empty', {
      names: ['Button'],
      componentKey: 'btn-empty',
      buildCount: 5,
      confidence: 'confirmed',
      defaultVariants: {},
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:empty-1',
      name: 'Button',
      componentKey: 'btn-empty',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    const result = await handlers.figma_insert_component({
      componentKey: 'btn-empty',
      parentId: 'parent:1',
    });

    assert.strictEqual(result._autoApplied, undefined);
    assert.strictEqual(bridge.getMessages('set_variant').length, 0);
  });

  it('does NOT auto-apply when defaultVariants is missing (null/undefined)', async () => {
    knowledgeStore.setComponent('btn-null', {
      names: ['Button'],
      componentKey: 'btn-null',
      buildCount: 5,
      confidence: 'verified',
      // No defaultVariants field
    });

    bridge.setResponse('insert_component', {
      nodeId: 'node:null-1',
      name: 'Button',
      componentKey: 'btn-null',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    const result = await handlers.figma_insert_component({
      componentKey: 'btn-null',
      parentId: 'parent:1',
    });

    assert.strictEqual(result._autoApplied, undefined);
    assert.strictEqual(bridge.getMessages('set_variant').length, 0);
  });
});

describe('Template Replay — end-to-end flow', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    bridge = ctx.bridge;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('captures variants in build 1, replays in build 2', async () => {
    // ── Build 1: insert + manual variant ──
    bridge.setResponse('insert_component', {
      nodeId: 'node:e2e-1',
      name: 'Badge',
      componentKey: 'badge-key-e2e',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    const result1 = await handlers.figma_insert_component({
      componentKey: 'badge-key-e2e',
      parentId: 'parent:1',
    });

    // No recipe yet — should NOT auto-apply
    assert.strictEqual(result1._autoApplied, undefined);

    // Claude manually sets variant
    await handlers.figma_set_variant({
      nodeId: 'node:e2e-1',
      properties: { Color: 'Success', Size: 'sm' },
    });

    // Generate build report (persists recipe)
    session._componentInsertions = new Map([
      ['badge-key-e2e', { count: 1, names: ['Badge'] }],
    ]);
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'E2E Build 1',
      components: [{ name: 'Badge', instances: 1, componentKey: 'badge-key-e2e' }],
      primitives: [],
      toolCallCount: 10,
      cacheHits: 0,
    });

    // Verify recipe was saved with defaultVariants
    let recipe = knowledgeStore.getComponent('badge-key-e2e');
    assert.deepStrictEqual(recipe.defaultVariants, { Color: 'Success', Size: 'sm' });
    assert.strictEqual(recipe.confidence, 'new'); // Only 1 build

    // ── Simulate 2 more builds to reach confirmed ──
    recipe.buildCount = 3;
    recipe.confidence = 'confirmed';
    knowledgeStore.setComponent('badge-key-e2e', recipe);

    // ── Build 2: reset session state, insert same component ──
    bridge.reset();
    session.toolCallCount = 0;
    session.cacheHits = 0;
    session.replaySavings = 0;
    session._nodeComponentKeys = new Map();
    session._variantConfigs = new Map();

    bridge.setResponse('insert_component', {
      nodeId: 'node:e2e-2',
      name: 'Badge',
      componentKey: 'badge-key-e2e',
      type: 'INSTANCE',
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });

    const result2 = await handlers.figma_insert_component({
      componentKey: 'badge-key-e2e',
      parentId: 'parent:2',
    });

    // Should have auto-applied
    assert.ok(result2._autoApplied, 'Should have auto-applied');
    assert.deepStrictEqual(result2._autoApplied.variants, {
      Color: 'Success',
      Size: 'sm',
    });

    // Verify bridge received set_variant
    const variantMsgs = bridge.getMessages('set_variant');
    assert.strictEqual(variantMsgs.length, 1);
    assert.strictEqual(variantMsgs[0].payload.nodeId, 'node:e2e-2');

    // Verify savings counter
    assert.strictEqual(session.replaySavings, 1);
    assert.strictEqual(session.cacheHits, 1);
  });
});

describe('Gap Tracking — noise filtering', () => {
  let handlers, session, knowledgeStore;

  beforeEach(() => {
    const ctx = createTestContext();
    handlers = ctx.handlers;
    session = ctx.session;
    knowledgeStore = ctx.knowledgeStore;
    try { fs.unlinkSync(REPLAY_STORE_PATH); } catch {}
  });

  it('filters out generic container names from gaps', async () => {
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'Gap Filter Test',
      components: [],
      primitives: [
        { element: 'Content Container', reason: 'Custom frame created during build' },
        { element: 'Actions Row', reason: 'Custom frame created during build' },
        { element: 'Wrapper Section', reason: 'Custom frame created during build' },
        { element: 'Grid Layout', reason: 'Custom frame created during build' },
      ],
      toolCallCount: 10,
      cacheHits: 0,
    });

    const gaps = knowledgeStore.getGaps();
    assert.strictEqual(Object.keys(gaps).length, 0,
      'generic containers with generic reasons should not become gaps');
  });

  it('filters out artboard-like names from gaps', async () => {
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'Artboard Filter Test',
      components: [],
      primitives: [
        { element: 'Build 1 — Dashboard', reason: 'Custom frame created during build' },
        { element: 'Test Artboard', reason: 'Custom frame created during build' },
        { element: 'Replay Build 2', reason: 'Custom frame created during build' },
        { element: 'LV Build 3', reason: 'Custom frame created during build' },
      ],
      toolCallCount: 10,
      cacheHits: 0,
    });

    const gaps = knowledgeStore.getGaps();
    assert.strictEqual(Object.keys(gaps).length, 0,
      'artboard-like names with generic reasons should not become gaps');
  });

  it('keeps gaps with specific reasons or search terms', async () => {
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'Real Gap Test',
      components: [],
      primitives: [
        { element: 'Member Info stack', reason: 'Custom name+email text stack — no DS component for inline member info', searchTerms: ['member info', 'user info'] },
        { element: 'Metric card', reason: 'Custom metric card — no DS single-stat card component', searchTerms: ['card', 'metric card'] },
        { element: 'Content Container', reason: 'Custom frame created during build' },
      ],
      toolCallCount: 10,
      cacheHits: 0,
    });

    const gaps = knowledgeStore.getGaps();
    const gapNames = Object.keys(gaps);
    assert.ok(gapNames.includes('Member Info stack'), 'real gap with search terms should be kept');
    assert.ok(gapNames.includes('Metric card'), 'real gap with specific reason should be kept');
    assert.ok(!gapNames.includes('Content Container'), 'generic container should be filtered');
    assert.strictEqual(gapNames.length, 2, 'only real gaps should remain');
  });

  it('keeps container names when they have search terms', async () => {
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'Container With Terms Test',
      components: [],
      primitives: [
        { element: 'Actions Row', reason: 'No action bar component found in DS', searchTerms: ['action bar', 'toolbar'] },
      ],
      toolCallCount: 10,
      cacheHits: 0,
    });

    const gaps = knowledgeStore.getGaps();
    assert.ok(Object.keys(gaps).includes('Actions Row'),
      'container name with search terms should be kept as a real gap');
  });
});
