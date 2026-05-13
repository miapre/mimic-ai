'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DsDiscovery } = require('../../src/ds/discovery');
const { DsCache } = require('../../src/ds/cache');
const { KnowledgeStore } = require('../../src/knowledge/store');
const { MockBridge } = require('./helpers/mock-bridge');
const { DsResolver } = require('../../src/ds/resolver');
const { BuildManifest } = require('../../src/knowledge/manifest');

function createToolContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  const knowledgeStore = new KnowledgeStore(path.join(__dirname, '.test-knowledge.json'));
  const buildManifest = new BuildManifest();
  const session = { phase: 2, toolCallCount: 0, cacheHits: 0 };
  const handlers = {};

  const context = {
    bridge,
    dsCache,
    dsResolver,
    knowledgeStore,
    buildManifest,
    session,
    requirePhase(min) {
      if (session.phase < min) throw new Error(`phase ${session.phase} < ${min}`);
    },
    advancePhase(to) {
      session.phase = Math.max(session.phase, to);
    },
    registerTool(name, _desc, _schema, handler) {
      handlers[name] = handler;
    },
  };

  require('../../src/tools/build').register(null, context);
  require('../../src/tools/ds-setup').register(null, context);
  require('../../src/tools/components').register(null, context);
  require('../../src/tools/edit').register(null, context);
  require('../../src/tools/learning').register(null, context);
  require('../../src/tools/batch').register(null, context);

  return { bridge, dsCache, knowledgeStore, session, handlers };
}

describe('component-first enforcement', () => {
  let setup;

  beforeEach(() => {
    setup = createToolContext();
  });

  it('maps missing section components without throwing and returns fallback guidance', () => {
    const discovery = new DsDiscovery(new MockBridge(), new DsCache(), new KnowledgeStore('/tmp/mimic-test.json'));
    const result = discovery.searchComponent('header');

    assert.equal(result.found, false);
    assert.equal(result.fallbackRequired, true);
    assert.match(result.fallbackHint, /MUST search the library/);
    assert.deepEqual(result.searchTerms.slice(0, 2), ['header', 'nav']);
  });

  it('preserves fallback guidance from mimic_map_components', async () => {
    const result = await setup.handlers.mimic_map_components({ elementTypes: ['header', 'button'] });

    assert.equal(result.mapped, 0);
    assert.equal(result.missing, 2);
    assert.equal(result.notFound[0].fallbackRequired, true);
    assert.match(result.notFound[0].fallbackHint, /MUST search the library/);
    assert.ok(setup.session.componentMap);
  });

  it('blocks protected primitive frames until no-component override is documented', async () => {
    const blocked = await setup.handlers.figma_create_frame({
      name: 'Button: Start free trial',
      parentId: 'parent:1',
    });

    assert.equal(blocked.error, 'COMPONENT_FIRST_REQUIRED');
    assert.equal(setup.bridge.getMessages('create_frame').length, 0);

    const allowed = await setup.handlers.figma_create_frame({
      name: 'Button: Start free trial',
      parentId: 'parent:1',
      confirmedNoComponent: true,
      primitiveOverrideReason: 'Fixture-specific button variant missing from the DS library.',
    });

    assert.ok(allowed.nodeId);
    assert.match(allowed._componentCheck, /Primitive override accepted/);
    assert.equal(setup.bridge.getMessages('create_frame').length, 1);
  });

  it('applies the same component-first gate inside figma_batch', async () => {
    const result = await setup.handlers.figma_batch({
      operations: [
        { type: 'create_frame', payload: { name: 'Header Navigation', parentId: 'parent:1' } },
        { type: 'create_frame', payload: { name: 'Hero Section', parentId: 'parent:1' } },
      ],
    });

    assert.equal(result.total, 2);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].error, 'COMPONENT_FIRST_REQUIRED');
    assert.equal(setup.bridge.getMessages('create_frame').length, 1);
  });

  it('passes known single-component import mode to component insertion', async () => {
    setup.dsCache.addComponent('single-component-key', {
      name: 'Buttons/Button',
      isComponentSet: false,
    });

    await setup.handlers.figma_insert_component({
      componentKey: 'single-component-key',
      parentId: 'parent:1',
      name: 'Smoke button',
    });

    const insert = setup.bridge.getMessages('insert_component')[0];
    assert.equal(insert.payload.importMode, 'component');
  });

  it('passes known single-component import mode to batch component insertion', async () => {
    setup.dsCache.addComponent('single-component-key', {
      name: 'Buttons/Button',
      isComponentSet: false,
    });

    await setup.handlers.figma_batch({
      operations: [
        {
          type: 'insert_component',
          payload: {
            componentKey: 'single-component-key',
            parentId: 'parent:1',
            name: 'Smoke button',
          },
        },
      ],
    });

    const insert = setup.bridge.getMessages('insert_component')[0];
    assert.equal(insert.payload.importMode, 'component');
  });

  it('generates a build report when report args are omitted', async () => {
    const result = await setup.handlers.mimic_generate_build_report({});

    assert.ok(result.reportPath);
    assert.match(result.summary, /Build report for/);
    assert.equal(result.componentQualityGate, 'PASS');
  });

  it('blocks page-level artboards that overlap existing top-level nodes', async () => {
    setup.bridge.setResponse('get_page_nodes', {
      nodes: [
        { id: 'existing:1', name: 'Existing Artboard', type: 'FRAME', x: 0, y: 0, width: 1280, height: 720 },
      ],
    });

    const result = await setup.handlers.figma_create_frame({
      name: 'Overlapping Artboard',
      x: 500,
      y: 0,
      width: 1280,
      height: 720,
      direction: 'VERTICAL',
    });

    assert.equal(result.error, 'ARTBOARD_OVERLAP');
    assert.equal(result.suggestedX, 1360);
    assert.equal(setup.bridge.getMessages('create_frame').length, 0);
  });

  it('auto-places page-level artboards to the right when x is omitted', async () => {
    setup.bridge.setResponse('get_page_nodes', {
      nodes: [
        { id: 'existing:1', name: 'Existing Artboard', type: 'FRAME', x: 0, y: 0, width: 1280, height: 720 },
      ],
    });

    await setup.handlers.figma_create_frame({
      name: 'Auto Placed Artboard',
      y: 0,
      width: 1280,
      height: 720,
      direction: 'VERTICAL',
    });

    const created = setup.bridge.getMessages('create_frame')[0];
    assert.equal(created.payload.x, 1360);
  });

  it('sets node position directly for placement correction', async () => {
    const result = await setup.handlers.figma_set_node_position({
      nodeId: 'artboard:1',
      x: 1360,
      y: 0,
    });

    assert.equal(result.x, 1360);
    assert.equal(result.y, 0);
    assert.equal(setup.bridge.getMessages('set_node_position').length, 1);
  });

  it('sets component text by exact text node id', async () => {
    const result = await setup.handlers.figma_set_component_text_by_id({
      nodeId: 'component:1',
      textNodeId: 'Icomponent:1;child:2',
      content: 'Run verification',
    });

    const message = setup.bridge.getMessages('set_component_text_by_id')[0];
    assert.equal(message.payload.nodeId, 'component:1');
    assert.equal(message.payload.textNodeId, 'Icomponent:1;child:2');
    assert.equal(result.characters, 'Run verification');
  });
});
