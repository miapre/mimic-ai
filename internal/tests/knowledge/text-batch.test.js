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

const STORE_PATH = path.join(__dirname, '.test-text-batch.json');

function createTestContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  const knowledgeStore = new KnowledgeStore(STORE_PATH);
  const buildManifest = new BuildManifest();

  const session = {
    phase: 3,
    artboardId: null,
    enforcementProfile: null,
    toolCallCount: 0,
    cacheHits: 0,
    replaySavings: 0,
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

  require('../../../src/tools/components').register(null, context);
  require('../../../src/tools/learning').register(null, context);

  return { context, handlers, bridge, session, dsCache, buildManifest, knowledgeStore };
}

// ─── Basic Functionality ─────────────────────────────────────────

describe('Text Batch — figma_batch_set_component_text', () => {
  let handlers, bridge, session;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;
  });

  it('sets multiple text nodes in a single call', async () => {
    const result = await handlers.figma_batch_set_component_text({
      nodeId: 'comp:1',
      overrides: [
        { textNodeName: 'Heading', content: 'Dashboard' },
        { textNodeName: 'Supporting text', content: 'Welcome back' },
        { textNodeName: 'Badge text', content: 'Active' },
      ],
    });

    assert.strictEqual(result.succeeded, 3);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.total, 3);
    assert.ok(result.hint.includes('3 text node(s) set in one call'));

    // Should send ONE bridge call (not 3)
    const batchMsgs = bridge.getMessages('batch_set_component_text');
    assert.strictEqual(batchMsgs.length, 1);
    assert.strictEqual(batchMsgs[0].payload.overrides.length, 3);
  });

  it('increments toolCallCount once (not per text node)', async () => {
    const before = session.toolCallCount;
    await handlers.figma_batch_set_component_text({
      nodeId: 'comp:1',
      overrides: [
        { textNodeName: 'A', content: 'a' },
        { textNodeName: 'B', content: 'b' },
        { textNodeName: 'C', content: 'c' },
      ],
    });

    assert.strictEqual(session.toolCallCount, before + 1, 'batch should count as 1 tool call');
  });

  it('tracks overridden text nodes in componentTextTracker', async () => {
    session.componentTextTracker.set('comp:1', {
      name: 'Button',
      expected: [
        { nodeId: 'tn1', name: 'Heading', defaultText: 'Default' },
        { nodeId: 'tn2', name: 'Supporting text', defaultText: 'Default' },
      ],
      overridden: new Set(),
    });

    await handlers.figma_batch_set_component_text({
      nodeId: 'comp:1',
      overrides: [
        { textNodeName: 'Heading', content: 'Dashboard' },
        { textNodeName: 'Supporting text', content: 'Welcome' },
      ],
    });

    const tracker = session.componentTextTracker.get('comp:1');
    assert.ok(tracker.overridden.has('Heading'));
    assert.ok(tracker.overridden.has('Supporting text'));
  });

  it('handles partial failures gracefully', async () => {
    bridge.setResponse('batch_set_component_text', {
      nodeId: 'comp:1',
      total: 3,
      succeeded: 2,
      failed: 1,
      results: [
        { textNodeName: 'Heading', nodeId: 'tn1', ok: true, characters: 'Test' },
        { textNodeName: 'Missing Node', ok: false, error: 'TEXT_NODE_NOT_FOUND', available: ['Heading', 'Label'] },
        { textNodeName: 'Label', nodeId: 'tn2', ok: true, characters: 'OK' },
      ],
      applied: {},
      warnings: [],
      bindingFailures: false,
    });

    const result = await handlers.figma_batch_set_component_text({
      nodeId: 'comp:1',
      overrides: [
        { textNodeName: 'Heading', content: 'Test' },
        { textNodeName: 'Missing Node', content: 'Nope' },
        { textNodeName: 'Label', content: 'OK' },
      ],
    });

    assert.strictEqual(result.succeeded, 2);
    assert.strictEqual(result.failed, 1);
    assert.ok(result.hint.includes('1 text node(s) not found'));
  });
});

// ─── Text Node Structure Learning ─────────────────────────────

describe('Text Batch — text node structure learning', () => {
  let handlers, bridge, session;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;

    // Set up component key tracking (normally done by figma_insert_component)
    session._nodeComponentKeys = new Map([['comp:1', 'btn-key-123']]);

    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'HORIZONTAL',
    });
  });

  it('learns text node names from batch call', async () => {
    await handlers.figma_batch_set_component_text({
      nodeId: 'comp:1',
      overrides: [
        { textNodeName: 'Heading', content: 'Dashboard' },
        { textNodeName: 'Supporting text', content: 'Welcome' },
      ],
    });

    assert.ok(session._textNodeStructures, 'should create _textNodeStructures');
    const structure = session._textNodeStructures.get('btn-key-123');
    assert.ok(structure, 'should store structure for componentKey');
    assert.deepStrictEqual(structure.nodeNames, ['Heading', 'Supporting text']);
    assert.strictEqual(structure.count, 2);
  });

  it('does not learn when no component key mapping exists', async () => {
    session._nodeComponentKeys = new Map(); // Empty

    await handlers.figma_batch_set_component_text({
      nodeId: 'comp:1',
      overrides: [
        { textNodeName: 'Heading', content: 'Test' },
      ],
    });

    const structures = session._textNodeStructures;
    assert.ok(!structures || structures.size === 0);
  });
});

// ─── Persistence in Build Report ─────────────────────────────

describe('Text Batch — text node persistence in build report', () => {
  let handlers, session, knowledgeStore;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    session = setup.session;
    knowledgeStore = setup.knowledgeStore;
    try { fs.unlinkSync(STORE_PATH); } catch {}
  });

  it('persists textNodes in component recipe after build report', async () => {
    session._componentInsertions = new Map([
      ['btn-key-123', { count: 1, names: ['Button'] }],
    ]);
    session._textNodeStructures = new Map([
      ['btn-key-123', { nodeNames: ['Heading', 'Supporting text', 'Label'], count: 3 }],
    ]);
    session.phaseToolCalls[3] = 10;

    await handlers.mimic_generate_build_report({
      screenName: 'Text Learning Test',
      components: [{ name: 'Button', instances: 1, componentKey: 'btn-key-123' }],
      primitives: [],
      toolCallCount: 15,
      cacheHits: 0,
    });

    const recipe = knowledgeStore.getComponent('btn-key-123');
    assert.ok(recipe, 'recipe should exist');
    assert.deepStrictEqual(recipe.textNodes, ['Heading', 'Supporting text', 'Label']);
  });

  it('preserves existing textNodes when no new structure learned', async () => {
    knowledgeStore.setComponent('btn-key-456', {
      names: ['Badge'],
      componentKey: 'btn-key-456',
      buildCount: 3,
      confidence: 'confirmed',
      textNodes: ['Label', 'Count'],
    });

    session._componentInsertions = new Map([
      ['btn-key-456', { count: 1, names: ['Badge'] }],
    ]);
    // No _textNodeStructures set
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'Preserve Test',
      components: [{ name: 'Badge', instances: 1, componentKey: 'btn-key-456' }],
      primitives: [],
      toolCallCount: 10,
      cacheHits: 0,
    });

    const recipe = knowledgeStore.getComponent('btn-key-456');
    assert.deepStrictEqual(recipe.textNodes, ['Label', 'Count'], 'existing textNodes should be preserved');
  });
});

// ─── End-to-End Flow ─────────────────────────────────────────

describe('Text Batch — e2e insert + batch text + report', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;
    knowledgeStore = setup.knowledgeStore;
    try { fs.unlinkSync(STORE_PATH); } catch {}

    bridge.setResponse('insert_component', {
      nodeId: 'comp:e2e',
      name: 'Table cell',
      componentKey: 'cell-key-1',
      type: 'INSTANCE',
      configurationHints: {
        textNodes: [
          { nodeId: 'tn:1', name: 'Text', characters: 'Default' },
          { nodeId: 'tn:2', name: 'Supporting text', characters: 'Default' },
        ],
      },
    });
    bridge.setResponse('get_node_props', {
      layoutSizingHorizontal: 'FIXED',
      layoutMode: 'VERTICAL',
    });
  });

  it('insert → batch text → report captures text structure', async () => {
    // Insert component
    await handlers.figma_insert_component({
      componentKey: 'cell-key-1',
      parentId: 'parent:1',
      name: 'Table cell: Name',
    });

    // Batch set text
    await handlers.figma_batch_set_component_text({
      nodeId: 'comp:e2e',
      overrides: [
        { textNodeName: 'Text', content: 'Sarah Chen' },
        { textNodeName: 'Supporting text', content: 'sarah@co.com' },
      ],
    });

    // Generate report
    session._componentInsertions = new Map([
      ['cell-key-1', { count: 1, names: ['Table cell'] }],
    ]);
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'E2E Text Batch',
      components: [{ name: 'Table cell', instances: 1, componentKey: 'cell-key-1' }],
      primitives: [],
      toolCallCount: 10,
      cacheHits: 0,
    });

    // Recipe should have textNodes
    const recipe = knowledgeStore.getComponent('cell-key-1');
    assert.ok(recipe, 'recipe should exist');
    assert.deepStrictEqual(recipe.textNodes, ['Text', 'Supporting text']);

    // Text tracker should show all overridden
    const tracker = session.componentTextTracker.get('comp:e2e');
    assert.ok(tracker.overridden.has('Text'));
    assert.ok(tracker.overridden.has('Supporting text'));
  });
});

// ─── Efficiency Comparison ───────────────────────────────────

describe('Text Batch — efficiency', () => {
  let handlers, bridge, session;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;
  });

  it('batch uses 1 tool call vs. N individual calls', async () => {
    // Batch: 4 text nodes in 1 call
    const before = session.toolCallCount;
    await handlers.figma_batch_set_component_text({
      nodeId: 'comp:1',
      overrides: [
        { textNodeName: 'A', content: '1' },
        { textNodeName: 'B', content: '2' },
        { textNodeName: 'C', content: '3' },
        { textNodeName: 'D', content: '4' },
      ],
    });
    const batchCalls = session.toolCallCount - before;

    // Individual: 4 separate calls
    const beforeIndividual = session.toolCallCount;
    for (const name of ['A', 'B', 'C', 'D']) {
      await handlers.figma_set_component_text({
        nodeId: 'comp:2',
        textNodeName: name,
        content: 'x',
      });
    }
    const individualCalls = session.toolCallCount - beforeIndividual;

    assert.strictEqual(batchCalls, 1, 'batch should use 1 tool call');
    assert.strictEqual(individualCalls, 4, 'individual should use 4 tool calls');
  });
});
