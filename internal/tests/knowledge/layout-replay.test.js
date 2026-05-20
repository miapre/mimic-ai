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

const STORE_PATH = path.join(__dirname, '.test-layout-replay.json');

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

  require('../../../src/tools/build').register(null, context);
  require('../../../src/tools/components').register(null, context);
  require('../../../src/tools/learning').register(null, context);

  return { context, handlers, bridge, session, dsCache, buildManifest, knowledgeStore };
}

// ─── Unit Tests ──────────────────────────────────────────────────

const { getPatternPrefix, captureLayoutConfig, applyLayoutReplay } = require('../../../src/tools/build');

describe('Layout Replay — getPatternPrefix', () => {
  it('extracts prefix from "Card: Revenue"', () => {
    assert.strictEqual(getPatternPrefix('Card: Revenue'), 'Card');
  });

  it('extracts prefix from "Status Row: Active"', () => {
    assert.strictEqual(getPatternPrefix('Status Row: Active'), 'Status Row');
  });

  it('returns null for names without colon', () => {
    assert.strictEqual(getPatternPrefix('Header Section'), null);
  });

  it('returns null for short prefixes (< 3 chars)', () => {
    assert.strictEqual(getPatternPrefix('A: thing'), null);
  });

  it('returns null for empty/null', () => {
    assert.strictEqual(getPatternPrefix(null), null);
    assert.strictEqual(getPatternPrefix(''), null);
  });

  it('returns null when colon is at position 0', () => {
    assert.strictEqual(getPatternPrefix(': value'), null);
  });
});

describe('Layout Replay — captureLayoutConfig', () => {
  it('captures relevant layout properties', () => {
    const config = captureLayoutConfig({
      name: 'Card: Revenue',
      parentId: 'p1',
      direction: 'VERTICAL',
      gapVariable: 'Spacing/spacing-lg',
      paddingVariable: 'Spacing/spacing-md',
      cornerRadiusVariable: 'Radius/radius-md',
      fillVariable: 'Colors/bg-primary',
    });

    assert.strictEqual(config.direction, 'VERTICAL');
    assert.strictEqual(config.gapVariable, 'Spacing/spacing-lg');
    assert.strictEqual(config.paddingVariable, 'Spacing/spacing-md');
    assert.strictEqual(config.cornerRadiusVariable, 'Radius/radius-md');
    assert.strictEqual(config.fillVariable, 'Colors/bg-primary');
    // Non-layout keys should not be captured
    assert.strictEqual(config.name, undefined);
    assert.strictEqual(config.parentId, undefined);
  });

  it('returns null when no layout properties provided', () => {
    const config = captureLayoutConfig({ name: 'Card: X', parentId: 'p1' });
    assert.strictEqual(config, null);
  });

  it('captures raw numeric values', () => {
    const config = captureLayoutConfig({
      name: 'Card: X',
      direction: 'HORIZONTAL',
      gap: 16,
      padding: 24,
      cornerRadius: 8,
    });

    assert.strictEqual(config.direction, 'HORIZONTAL');
    assert.strictEqual(config.gap, 16);
    assert.strictEqual(config.padding, 24);
    assert.strictEqual(config.cornerRadius, 8);
  });
});

describe('Layout Replay — applyLayoutReplay', () => {
  it('applies stored config as defaults for missing properties', () => {
    const args = { name: 'Card: Users', parentId: 'p1', direction: 'HORIZONTAL' };
    const layoutConfig = {
      direction: 'VERTICAL',
      gapVariable: 'Spacing/spacing-lg',
      paddingVariable: 'Spacing/spacing-md',
    };

    const { merged, applied } = applyLayoutReplay(args, layoutConfig);

    // Explicit direction should NOT be overridden
    assert.strictEqual(merged.direction, 'HORIZONTAL');
    assert.strictEqual(applied.direction, undefined);
    // Missing properties should be filled from config
    assert.strictEqual(merged.gapVariable, 'Spacing/spacing-lg');
    assert.strictEqual(applied.gapVariable, 'Spacing/spacing-lg');
    assert.strictEqual(merged.paddingVariable, 'Spacing/spacing-md');
  });

  it('returns empty applied when all properties are already specified', () => {
    const args = {
      name: 'Card: Users',
      parentId: 'p1',
      direction: 'VERTICAL',
      gapVariable: 'Spacing/custom',
    };
    const layoutConfig = { direction: 'VERTICAL', gapVariable: 'Spacing/spacing-lg' };

    const { applied } = applyLayoutReplay(args, layoutConfig);
    assert.strictEqual(Object.keys(applied).length, 0);
  });
});

// ─── Integration Tests ──────────────────────────────────────────

describe('Layout Replay — capture during build', () => {
  let handlers, bridge, session, buildManifest;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;
    buildManifest = setup.buildManifest;
    try { fs.unlinkSync(STORE_PATH); } catch {}

    bridge.setResponse('get_page_nodes', { nodes: [] });
  });

  it('captures layout config in session for frames with pattern prefix', async () => {
    await handlers.figma_create_frame({
      name: 'Card: Revenue',
      parentId: 'parent:1',
      direction: 'VERTICAL',
      gap: 24,
      padding: 16,
      cornerRadius: 8,
    });

    assert.ok(session._frameLayoutConfigs, 'should create _frameLayoutConfigs');
    const config = session._frameLayoutConfigs.get('Card');
    assert.ok(config, 'should store config for prefix "Card"');
    assert.strictEqual(config.direction, 'VERTICAL');
    assert.strictEqual(config.gap, 24);
    assert.strictEqual(config.padding, 16);
    assert.strictEqual(config.cornerRadius, 8);
  });

  it('stores only first occurrence config (does not overwrite)', async () => {
    // First card
    await handlers.figma_create_frame({
      name: 'Card: Revenue',
      parentId: 'parent:1',
      direction: 'VERTICAL',
      gap: 16,
    });

    // Second card — different config
    await handlers.figma_create_frame({
      name: 'Card: Users',
      parentId: 'parent:1',
      direction: 'HORIZONTAL',
      gap: 24,
    });

    const config = session._frameLayoutConfigs.get('Card');
    assert.strictEqual(config.direction, 'VERTICAL', 'first config should win');
    assert.strictEqual(config.gap, 16, 'first gap should win');
  });

  it('does not capture config for page-level frames (artboards)', async () => {
    await handlers.figma_create_frame({
      name: 'Card: Dashboard',
      direction: 'VERTICAL',
      width: 1440,
      height: 900,
    });

    // No parentId → artboard → should NOT capture pattern
    const configs = session._frameLayoutConfigs;
    assert.ok(!configs || !configs.has('Card'));
  });
});

describe('Layout Replay — persistence in build report', () => {
  let handlers, session, knowledgeStore, buildManifest;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    session = setup.session;
    knowledgeStore = setup.knowledgeStore;
    buildManifest = setup.buildManifest;
    try { fs.unlinkSync(STORE_PATH); } catch {}
  });

  it('persists layoutConfig with pattern during build report', async () => {
    // Simulate two "Card:" frames in the build manifest
    buildManifest.addSection('Card: Revenue', 'n1', 'frame');
    buildManifest.addSection('Card: Users', 'n2', 'frame');
    buildManifest.addSection('Header Section', 'n3', 'frame');

    // Simulate captured layout config
    session._frameLayoutConfigs = new Map([
      ['Card', { direction: 'VERTICAL', gapVariable: 'Spacing/spacing-lg', paddingVariable: 'Spacing/spacing-md' }],
    ]);
    session.phaseToolCalls[3] = 10;

    await handlers.mimic_generate_build_report({
      screenName: 'Layout Test',
      components: [],
      primitives: [],
      toolCallCount: 20,
      cacheHits: 0,
    });

    const pattern = knowledgeStore.getPattern('Card');
    assert.ok(pattern, 'Card pattern should exist');
    assert.ok(pattern.layoutConfig, 'layoutConfig should be stored');
    assert.strictEqual(pattern.layoutConfig.direction, 'VERTICAL');
    assert.strictEqual(pattern.layoutConfig.gapVariable, 'Spacing/spacing-lg');
  });

  it('does NOT overwrite existing layoutConfig on subsequent builds', async () => {
    // Pre-populate a pattern with existing layoutConfig
    knowledgeStore.setPattern('Card', {
      description: 'Existing pattern',
      buildCount: 2,
      occurrences: 4,
      confidence: 'new',
      layoutConfig: { direction: 'HORIZONTAL', gap: 8 },
    });

    buildManifest.addSection('Card: A', 'n1', 'frame');
    buildManifest.addSection('Card: B', 'n2', 'frame');

    // New build has different config
    session._frameLayoutConfigs = new Map([
      ['Card', { direction: 'VERTICAL', gap: 16 }],
    ]);
    session.phaseToolCalls[3] = 5;

    await handlers.mimic_generate_build_report({
      screenName: 'Overwrite Test',
      components: [],
      primitives: [],
      toolCallCount: 10,
      cacheHits: 0,
    });

    const pattern = knowledgeStore.getPattern('Card');
    // Original config should be preserved
    assert.strictEqual(pattern.layoutConfig.direction, 'HORIZONTAL');
    assert.strictEqual(pattern.layoutConfig.gap, 8);
  });
});

describe('Layout Replay — auto-apply on create_frame', () => {
  let handlers, bridge, session, knowledgeStore;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;
    knowledgeStore = setup.knowledgeStore;
    try { fs.unlinkSync(STORE_PATH); } catch {}

    bridge.setResponse('get_page_nodes', { nodes: [] });
  });

  it('auto-applies confirmed pattern layoutConfig on matching frame', async () => {
    knowledgeStore.setPattern('Card', {
      description: 'Card pattern',
      buildCount: 4,
      occurrences: 8,
      confidence: 'confirmed',
      layoutConfig: {
        direction: 'VERTICAL',
        gap: 24,
        padding: 16,
        cornerRadius: 8,
      },
    });

    const result = await handlers.figma_create_frame({
      name: 'Card: New Feature',
      parentId: 'parent:1',
    });

    // Should have sent the replayed config to the bridge
    const createMsgs = bridge.getMessages('create_frame');
    assert.strictEqual(createMsgs.length, 1);
    assert.strictEqual(createMsgs[0].payload.direction, 'VERTICAL');
    assert.strictEqual(createMsgs[0].payload.gap, 24);
    assert.strictEqual(createMsgs[0].payload.padding, 16);
    assert.strictEqual(createMsgs[0].payload.cornerRadius, 8);

    // Result should include _layoutReplay
    assert.ok(result._layoutReplay, 'should report _layoutReplay');
    assert.strictEqual(result._layoutReplay.direction, 'VERTICAL');
    assert.ok(result.hint.includes('layout replay'));

    // Should count as replay savings
    assert.strictEqual(session.replaySavings, 1);
  });

  it('does NOT auto-apply for new (unconfirmed) patterns', async () => {
    knowledgeStore.setPattern('Card', {
      description: 'Card pattern',
      buildCount: 1,
      occurrences: 2,
      confidence: 'new',
      layoutConfig: { direction: 'VERTICAL', gap: 16 },
    });

    const result = await handlers.figma_create_frame({
      name: 'Card: Test',
      parentId: 'parent:1',
    });

    assert.strictEqual(result._layoutReplay, undefined);
    assert.strictEqual(session.replaySavings || 0, 0);
  });

  it('does NOT override explicitly provided properties', async () => {
    knowledgeStore.setPattern('Card', {
      description: 'Card pattern',
      buildCount: 5,
      occurrences: 10,
      confidence: 'verified',
      layoutConfig: {
        direction: 'VERTICAL',
        gap: 24,
        padding: 16,
      },
    });

    const result = await handlers.figma_create_frame({
      name: 'Card: Custom',
      parentId: 'parent:1',
      direction: 'HORIZONTAL',  // Explicitly set — should NOT be overridden
    });

    const createMsgs = bridge.getMessages('create_frame');
    // Direction should be the caller's value
    assert.strictEqual(createMsgs[0].payload.direction, 'HORIZONTAL');
    // But gap and padding should come from replay
    assert.strictEqual(createMsgs[0].payload.gap, 24);
    assert.strictEqual(createMsgs[0].payload.padding, 16);

    // _layoutReplay should only list what was actually auto-applied
    assert.strictEqual(result._layoutReplay.direction, undefined);
    assert.strictEqual(result._layoutReplay.gap, 24);
  });

  it('does NOT replay when pattern has no layoutConfig', async () => {
    knowledgeStore.setPattern('Card', {
      description: 'Card pattern',
      buildCount: 5,
      occurrences: 10,
      confidence: 'confirmed',
      // No layoutConfig
    });

    const result = await handlers.figma_create_frame({
      name: 'Card: Test',
      parentId: 'parent:1',
    });

    assert.strictEqual(result._layoutReplay, undefined);
  });
});

describe('Layout Replay — end-to-end flow', () => {
  let handlers, bridge, session, knowledgeStore, buildManifest;

  beforeEach(() => {
    const setup = createTestContext();
    handlers = setup.handlers;
    bridge = setup.bridge;
    session = setup.session;
    knowledgeStore = setup.knowledgeStore;
    buildManifest = setup.buildManifest;
    try { fs.unlinkSync(STORE_PATH); } catch {}

    bridge.setResponse('get_page_nodes', { nodes: [] });
  });

  it('captures in build 1, replays in build 2 after promotion', async () => {
    // ── Build 1: create Card frames ──
    await handlers.figma_create_frame({
      name: 'Card: Revenue',
      parentId: 'parent:1',
      direction: 'VERTICAL',
      gap: 24,
      padding: 16,
      cornerRadius: 8,
    });

    await handlers.figma_create_frame({
      name: 'Card: Users',
      parentId: 'parent:1',
      direction: 'VERTICAL',
      gap: 24,
      padding: 16,
      cornerRadius: 8,
    });

    session.phaseToolCalls[3] = 10;

    await handlers.mimic_generate_build_report({
      screenName: 'E2E Layout 1',
      components: [],
      primitives: [],
      toolCallCount: 20,
      cacheHits: 0,
    });

    // Pattern should be stored with layoutConfig
    let pattern = knowledgeStore.getPattern('Card');
    assert.ok(pattern, 'pattern should exist');
    assert.ok(pattern.layoutConfig, 'layoutConfig should be stored');
    assert.strictEqual(pattern.confidence, 'new'); // Only 1 build

    // ── Simulate promotion to confirmed (3 builds) ──
    pattern.buildCount = 3;
    pattern.confidence = 'confirmed';
    knowledgeStore.setPattern('Card', pattern);

    // ── Build 2: create a new Card without specifying layout ──
    bridge.reset();
    bridge.setResponse('get_page_nodes', { nodes: [] });
    session.replaySavings = 0;

    const result = await handlers.figma_create_frame({
      name: 'Card: Conversion Rate',
      parentId: 'parent:2',
      // No layout properties specified — should come from replay
    });

    assert.ok(result._layoutReplay, 'should have _layoutReplay');
    assert.strictEqual(result._layoutReplay.direction, 'VERTICAL');
    assert.strictEqual(result._layoutReplay.gap, 24);
    assert.strictEqual(result._layoutReplay.padding, 16);
    assert.strictEqual(result._layoutReplay.cornerRadius, 8);

    // Bridge should have received the replayed config
    const createMsgs = bridge.getMessages('create_frame');
    assert.strictEqual(createMsgs[0].payload.direction, 'VERTICAL');
    assert.strictEqual(createMsgs[0].payload.gap, 24);
  });
});
