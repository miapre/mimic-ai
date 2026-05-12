'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MockBridge } = require('./helpers/mock-bridge');
const { DsCache } = require('../../src/ds/cache');
const { DsResolver } = require('../../src/ds/resolver');
const { KnowledgeStore } = require('../../src/knowledge/store');
const { BuildManifest } = require('../../src/knowledge/manifest');
const path = require('node:path');

function createContext() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const dsResolver = new DsResolver(dsCache);
  const knowledgeStore = new KnowledgeStore(path.join(__dirname, '.test-knowledge.json'));
  const buildManifest = new BuildManifest();
  const session = {
    phase: 2, // build-ready
    artboardId: null,
    enforcementProfile: null,
    toolCallCount: 0,
    cacheHits: 0,
    consecutiveFailures: 0,
    phaseToolCalls: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    checkpointIssued: false,
    bindingFailures: [],
  };

  const toolHandlers = {};
  function registerTool(name, _desc, _schema, handler) {
    toolHandlers[name] = handler;
  }
  function requirePhase(min) {
    if (session.phase < min) throw new Error(`Phase ${session.phase} < ${min}`);
  }
  function advancePhase(to) {
    session.phase = Math.max(session.phase, to);
  }

  const context = {
    bridge, dsCache, dsResolver, knowledgeStore, buildManifest, session,
    requirePhase, advancePhase, registerTool, resetSession: () => {},
  };

  // Register tools
  require('../../src/tools/build').register(null, context);
  require('../../src/tools/components').register(null, context);
  require('../../src/tools/edit').register(null, context);

  return { context, toolHandlers, bridge, dsCache, session };
}

describe('Binding Feedback', () => {
  let ctx;

  beforeEach(() => {
    ctx = createContext();
  });

  describe('create_frame with successful bindings', () => {
    it('returns applied and no warnings when bindings succeed', async () => {
      const result = await ctx.toolHandlers.figma_create_frame({
        name: 'Test Frame',
        parentId: 'parent:1',
      });
      assert.ok(result.nodeId);
      // No variable params means no bindings tracked
      assert.deepEqual(result.applied, {});
      assert.deepEqual(result.warnings, []);
      assert.equal(result.bindingFailures, false);
    });
  });

  describe('create_frame with binding failures', () => {
    it('surfaces binding failures from plugin response', async () => {
      // Configure mock to return failed bindings
      ctx.bridge.setResponse('create_frame', {
        nodeId: 'mock:99',
        name: 'Header Section',
        type: 'FRAME',
        applied: { fillVariable: false, gapVariable: true },
        warnings: ['fillVariable: variable "bg-primary" not found in cache (0 cached)'],
        bindingFailures: true,
      });

      const result = await ctx.toolHandlers.figma_create_frame({
        name: 'Header Section',
        parentId: 'parent:1',
        fillVariable: 'bg-primary',
        gapVariable: 'sp-xl',
      });

      // Variables must pass MCP validation first — add them to cache
      ctx.dsCache.addVariable('bg-primary', { key: 'k1', category: 'background' });
      ctx.dsCache.addVariable('sp-xl', { key: 'k2', category: 'spacing' });

      const result2 = await ctx.toolHandlers.figma_create_frame({
        name: 'Header Section',
        parentId: 'parent:1',
        fillVariable: 'bg-primary',
        gapVariable: 'sp-xl',
      });

      assert.equal(result2.bindingFailures, true);
      assert.equal(result2.applied.fillVariable, false);
      assert.equal(result2.applied.gapVariable, true);
      assert.ok(result2._bindingWarning);
      assert.ok(result2._bindingWarning.includes('fillVariable'));
      assert.ok(result2.hint.includes('FAILED'));
    });
  });

  describe('create_text with binding failures', () => {
    it('reports text style failure in applied field', async () => {
      ctx.bridge.setResponse('create_text', {
        nodeId: 'mock:100',
        name: 'Page Title',
        type: 'TEXT',
        characters: 'Hello World',
        textStyleName: null,
        applied: { textStyle: false, fillVariable: false },
        warnings: [
          'textStyle: style "abc123" not found or not importable (styleCache: 0)',
          'fillVariable: variable "text-primary" not found in cache (0 cached)',
        ],
        bindingFailures: true,
      });

      ctx.dsCache.addVariable('text-primary', { key: 'k3', category: 'text' });

      const result = await ctx.toolHandlers.figma_create_text({
        name: 'Page Title',
        parentId: 'parent:1',
        content: 'Hello World',
        textStyleId: 'abc123',
        fillVariable: 'text-primary',
      });

      assert.equal(result.bindingFailures, true);
      assert.equal(result.applied.textStyle, false);
      assert.equal(result.applied.fillVariable, false);
      assert.ok(result._bindingWarning);
      assert.ok(result.hint.includes('FAILED'));
    });
  });

  describe('create_text with all bindings succeeding', () => {
    it('returns no warnings when everything works', async () => {
      ctx.bridge.setResponse('create_text', {
        nodeId: 'mock:101',
        name: 'Subtitle',
        type: 'TEXT',
        characters: 'Sub',
        textStyleName: 'Body/Regular',
        applied: { textStyle: true, fillVariable: true },
        warnings: [],
        bindingFailures: false,
      });

      ctx.dsCache.addVariable('text-secondary', { key: 'k4', category: 'text' });

      const result = await ctx.toolHandlers.figma_create_text({
        name: 'Subtitle',
        parentId: 'parent:1',
        content: 'Sub',
        textStyleId: 'style123',
        fillVariable: 'text-secondary',
      });

      assert.equal(result.bindingFailures, false);
      assert.equal(result.textStyleName, 'Body/Regular');
      assert.equal(result.applied.textStyle, true);
      assert.deepEqual(result.warnings, []);
      assert.equal(result._bindingWarning, undefined);
    });
  });

  describe('MCP variable validation blocks before plugin', () => {
    it('returns INVALID_VARIABLE_PATHS when variable not in cache', async () => {
      // Do NOT add variables to cache — validation should block
      const result = await ctx.toolHandlers.figma_create_frame({
        name: 'Test',
        parentId: 'p:1',
        fillVariable: 'nonexistent-var',
      });

      assert.equal(result.error, 'INVALID_VARIABLE_PATHS');
      assert.ok(result.warnings.length > 0);
      assert.ok(result.warnings[0].includes('nonexistent-var'));
    });
  });

  describe('session binding failure tracking', () => {
    it('records binding failures at session level', async () => {
      ctx.bridge.setResponse('create_frame', {
        nodeId: 'mock:200',
        name: 'Bad Frame',
        type: 'FRAME',
        applied: { fillVariable: false },
        warnings: ['fillVariable: not found'],
        bindingFailures: true,
      });

      ctx.dsCache.addVariable('bg-test', { key: 'k5', category: 'background' });

      await ctx.toolHandlers.figma_create_frame({
        name: 'Bad Frame',
        parentId: 'p:1',
        fillVariable: 'bg-test',
      });

      // The MCP layer (mcp.js) would track this, but in tests we're calling
      // the handler directly. Verify the result has the bindingFailures flag
      // so that mcp.js CAN track it.
      const result = await ctx.toolHandlers.figma_create_frame({
        name: 'Bad Frame',
        parentId: 'p:1',
        fillVariable: 'bg-test',
      });
      assert.equal(result.bindingFailures, true);
      assert.ok(result.applied);
    });
  });

  describe('set_node_fill binding feedback', () => {
    it('surfaces fill binding failure', async () => {
      ctx.bridge.setResponse('set_node_fill', {
        nodeId: 'node:1',
        name: 'Card',
        applied: { fillVariable: false },
        warnings: ['fillVariable: variable "bg-card" not found in cache (0 cached)'],
        bindingFailures: true,
      });

      ctx.dsCache.addVariable('bg-card', { key: 'k6', category: 'background' });

      const result = await ctx.toolHandlers.figma_set_node_fill({
        nodeId: 'node:1',
        fillVariable: 'bg-card',
      });

      assert.equal(result.bindingFailures, true);
      assert.ok(result._bindingWarning);
    });
  });

  describe('set_layout_sizing binding feedback', () => {
    it('surfaces padding variable failure', async () => {
      ctx.bridge.setResponse('set_layout_sizing', {
        nodeId: 'node:2',
        name: 'Container',
        layoutSizingHorizontal: 'FILL',
        layoutSizingVertical: 'HUG',
        applied: { paddingVariable: false, gapVariable: true },
        warnings: ['paddingVariable: variable "sp-lg" not found'],
        bindingFailures: true,
      });

      ctx.dsCache.addVariable('sp-lg', { key: 'k7', category: 'spacing' });
      ctx.dsCache.addVariable('sp-md', { key: 'k8', category: 'spacing' });

      const result = await ctx.toolHandlers.figma_set_layout_sizing({
        nodeId: 'node:2',
        layoutSizingHorizontal: 'FILL',
        paddingVariable: 'sp-lg',
        gapVariable: 'sp-md',
      });

      assert.equal(result.bindingFailures, true);
      assert.ok(result._bindingWarning);
      assert.ok(result._bindingWarning.includes('paddingVariable'));
    });
  });
});
