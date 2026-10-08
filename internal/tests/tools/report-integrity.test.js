'use strict';

/**
 * Regression tests for the "Report integrity" bug fixes in
 * src/tools/learning.js (mimic_generate_build_report):
 *
 * A2 + addendum: structural validation must actually run (bridge was never
 *   destructured from context, so every bridge.send() call inside the
 *   validation try/catch silently ReferenceError'd and was swallowed —
 *   validationStatus stayed at its initial value forever). Now:
 *   - bridge IS destructured, so get_node_props/get_node_children calls
 *     actually reach the bridge.
 *   - validationStatus starts as 'UNAVAILABLE' (never 'PASS' by default).
 *   - A bridge error yields 'UNAVAILABLE', never a false 'PASS'.
 *   - The header text always matches validationStatus honestly.
 * A3: recommendations must lead with a component-first quality gate failure
 *   instead of claiming "DS coverage and build quality are good."
 * A4: the disproven cross-build "Learning is working: N% fewer tool calls"
 *   claim must never appear; cache hits / replay savings are reported instead.
 * B4: a report/manifest file write failure must not leave the session wedged
 *   in REPORT_REQUIRED — buildsSinceReport must clear regardless.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockBridge } = require('../helpers/mock-bridge');
const { DsCache } = require('../../../src/ds/cache');
const { KnowledgeStore } = require('../../../src/knowledge/store');
const { BuildManifest } = require('../../../src/knowledge/manifest');

function createHarness() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-integrity-'));
  const knowledgeStore = new KnowledgeStore(path.join(tmpDir, 'ds-knowledge.json'));
  const buildManifest = new BuildManifest();

  const session = {
    phase: 3,
    artboardId: null,
    toolCallCount: 5,
    cacheHits: 0,
    phaseToolCalls: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 },
    bindingFailures: [],
    categoryMismatches: [],
    componentTextTracker: new Map(),
    buildsSinceReport: 1,
    replaySavings: 0,
  };

  function advancePhase(to) {
    session.phase = Math.max(session.phase, to);
  }

  const handlers = {};
  function registerTool(name, _description, _inputSchema, handler) {
    handlers[name] = handler;
  }

  const context = { registerTool, knowledgeStore, buildManifest, dsCache, session, advancePhase, bridge };
  require('../../../src/tools/learning').register(null, context);

  return { handlers, bridge, session, dsCache, buildManifest, knowledgeStore, tmpDir };
}

function cleanup(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

describe('mimic_generate_build_report — structural validation (three-state, bridge fix)', () => {
  it('actually calls the bridge and reports PASS on a healthy artboard (proves the missing bridge destructure is fixed)', async () => {
    const h = createHarness();
    h.buildManifest.artboardId = 'artboard-1'; // MockBridge defaults: width 100, height 50 → healthy ratio; no children
    try {
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Test Screen', components: [], primitives: [],
      });
      assert.equal(h.bridge.getMessages('get_node_props').length, 1, 'validation must actually call the bridge');
      assert.equal(h.bridge.getMessages('get_node_children').length, 1, 'deep scan must actually call the bridge');
      assert.equal(result.validationStatus, 'PASS');
      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.match(reportContent, /## ✓ Structural Validation Passed/);
    } finally {
      cleanup(h.tmpDir);
    }
  });

  it('never claims PASS when no artboard ID is available — reports UNAVAILABLE and skips the bridge entirely', async () => {
    const h = createHarness();
    // No buildManifest.artboardId, no session.artboardId set.
    try {
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Test Screen', components: [], primitives: [],
      });
      assert.equal(h.bridge.getMessages('get_node_props').length, 0, 'should never call the bridge with no artboard ID');
      assert.equal(result.validationStatus, 'UNAVAILABLE');
      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.match(reportContent, /## ⚠ Structural Validation Skipped/);
      assert.doesNotMatch(reportContent, /Structural Validation Passed/);
    } finally {
      cleanup(h.tmpDir);
    }
  });

  it('a bridge error during validation yields UNAVAILABLE, never a false PASS', async () => {
    const h = createHarness();
    h.buildManifest.artboardId = 'artboard-1';
    h.bridge.setResponse('get_node_props', () => { throw new Error('simulated bridge failure'); });
    try {
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Test Screen', components: [], primitives: [],
      });
      assert.equal(h.bridge.getMessages('get_node_props').length, 1, 'the call should have been attempted');
      assert.equal(result.validationStatus, 'UNAVAILABLE');
      assert.notEqual(result.validationStatus, 'PASS');
      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.match(reportContent, /## ⚠ Structural Validation Skipped/);
    } finally {
      cleanup(h.tmpDir);
    }
  });

  it('a bad layout ratio yields FAIL, not PASS', async () => {
    const h = createHarness();
    h.buildManifest.artboardId = 'artboard-1';
    h.bridge.setResponse('get_node_props', { width: 100, height: 500 }); // ratio 5:1
    try {
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Test Screen', components: [], primitives: [],
      });
      assert.equal(result.validationStatus, 'FAIL');
      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.match(reportContent, /## ⚠ BUILD NEEDS REVIEW — Structural Validation/);
    } finally {
      cleanup(h.tmpDir);
    }
  });
});

describe('mimic_generate_build_report — quality-gate-aware recommendations (A3)', () => {
  it('leads recommendations with the quality gate failure instead of "DS coverage and build quality are good"', async () => {
    const h = createHarness();
    try {
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Low Quality Screen',
        components: [],
        primitives: [
          { element: 'Custom card', reason: 'x' },
          { element: 'Custom badge', reason: 'x' },
          { element: 'Custom button', reason: 'x' },
        ],
      });
      assert.equal(result.componentQualityGate, 'FAIL');
      assert.ok(result.recommendations.length > 0, 'must have at least one recommendation');
      assert.match(result.recommendations[0], /Component-first quality gate failed/);
      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.doesNotMatch(reportContent, /No recommendations for this build\. DS coverage and build quality are good\./);
    } finally {
      cleanup(h.tmpDir);
    }
  });

  it('still shows the honest "all good" fallback when the gate passes and there is nothing else to recommend', async () => {
    const h = createHarness();
    try {
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Good Screen',
        components: [{ name: 'Button', instances: 10, componentKey: 'ck-btn' }],
        primitives: [],
      });
      assert.equal(result.componentQualityGate, 'PASS');
      assert.equal(result.recommendations.length, 0);
      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.match(reportContent, /No recommendations for this build\. DS coverage and build quality are good\./);
    } finally {
      cleanup(h.tmpDir);
    }
  });
});

describe('mimic_generate_build_report — disproven "Learning is working" claim removed (A4)', () => {
  it('never emits the cross-build tool-call-reduction claim, even across many builds with decreasing tool calls', async () => {
    const h = createHarness();
    try {
      // Seed build history with a clear decreasing tool-call trend, the
      // exact shape that used to trigger "Learning is working: N% fewer...".
      h.knowledgeStore.recordBuild({ screenName: 'B1', toolCalls: 200, cacheHits: 2, componentCount: 5, primitiveCount: 1, bindingFailures: 0, componentUsagePercent: 80 });
      h.knowledgeStore.recordBuild({ screenName: 'B2', toolCalls: 150, cacheHits: 5, componentCount: 5, primitiveCount: 1, bindingFailures: 0, componentUsagePercent: 82 });
      h.knowledgeStore.recordBuild({ screenName: 'B3', toolCalls: 100, cacheHits: 10, componentCount: 5, primitiveCount: 1, bindingFailures: 0, componentUsagePercent: 85 });
      h.session.cacheHits = 10;
      h.session.replaySavings = 3;

      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'B4', components: [{ name: 'Button', instances: 5, componentKey: 'ck-btn' }], primitives: [],
      });

      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.doesNotMatch(reportContent, /Learning is working/);
      assert.doesNotMatch(reportContent, /fewer tool calls compared to your first build/);
      assert.doesNotMatch(reportContent, /Learning impact:/);

      // Valid, non-comparative metrics should still be present.
      assert.match(reportContent, /Learning signal:/);
      assert.ok(
        result.recommendations.some(r => /Learning is active/.test(r)),
        'cache hits / replay savings should still surface as a recommendation'
      );
    } finally {
      cleanup(h.tmpDir);
    }
  });

  it('does not emit "Build complexity increasing" either — same disproven comparison, either direction', async () => {
    const h = createHarness();
    try {
      h.knowledgeStore.recordBuild({ screenName: 'B1', toolCalls: 50, cacheHits: 0, componentCount: 2, primitiveCount: 0, bindingFailures: 0, componentUsagePercent: 90 });
      h.knowledgeStore.recordBuild({ screenName: 'B2', toolCalls: 300, cacheHits: 0, componentCount: 2, primitiveCount: 0, bindingFailures: 0, componentUsagePercent: 90 });

      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'B3', components: [{ name: 'Button', instances: 2, componentKey: 'ck-btn' }], primitives: [],
      });
      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.doesNotMatch(reportContent, /Build complexity increasing/);
    } finally {
      cleanup(h.tmpDir);
    }
  });
});

describe('mimic_generate_build_report — report write failure does not wedge the session (B4)', () => {
  let originalWriteFileSync;
  let originalHomedir;
  let originalCwd;
  let fakeHome;
  let fakeCwd;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'report-fail-home-'));
    fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'report-fail-cwd-'));
    originalWriteFileSync = fs.writeFileSync;
    originalHomedir = os.homedir;
    originalCwd = process.cwd;
    os.homedir = () => fakeHome;
    process.cwd = () => fakeCwd;
  });

  afterEach(() => {
    fs.writeFileSync = originalWriteFileSync;
    os.homedir = originalHomedir;
    process.cwd = originalCwd;
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(fakeCwd, { recursive: true, force: true }); } catch {}
  });

  it('clears buildsSinceReport and advances to phase 5 even when the report write throws, with a fallback write and a warning', async () => {
    const h = createHarness();
    try {
      // Force writes under the project "mimic/builds" dir to fail, as if
      // cwd were unwritable — everything else (including the manifest, and
      // the fallback under fakeHome/.mimic-ai/builds) still writes fine.
      fs.writeFileSync = (filePath, ...rest) => {
        if (typeof filePath === 'string' && filePath.includes(path.join(fakeCwd, 'mimic', 'builds'))) {
          throw new Error('EACCES: permission denied (simulated)');
        }
        return originalWriteFileSync(filePath, ...rest);
      };

      assert.equal(h.session.buildsSinceReport, 1);
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Wedge Test', components: [], primitives: [],
      });

      // The core fix: the session must never stay wedged in REPORT_REQUIRED
      // just because a file write failed.
      assert.equal(h.session.buildsSinceReport, 0, 'buildsSinceReport must clear even when the write fails');
      assert.equal(h.session.phase, 5, 'phase must still advance to 5');

      assert.ok(result.reportWriteWarning, 'a warning must be surfaced in the response');
      assert.ok(result.reportPath, 'a fallback path should still be returned');
      assert.ok(result.reportPath.startsWith(path.join(fakeHome, '.mimic-ai', 'builds')), 'fallback should land under ~/.mimic-ai/builds');
      assert.ok(fs.existsSync(result.reportPath), 'fallback report file should actually exist on disk');
    } finally {
      cleanup(h.tmpDir);
    }
  });

  it('degrades to a warning (does not throw) when BOTH the project dir and the fallback are unwritable', async () => {
    const h = createHarness();
    try {
      // Only fail writes for the report file itself (project + fallback both
      // write "build-report.md") — knowledgeStore.save() writes to a
      // completely different path and must keep working normally; this test
      // is scoped to the report file write, not knowledge persistence.
      fs.writeFileSync = (filePath, ...rest) => {
        if (typeof filePath === 'string' && filePath.includes('build-report.md')) {
          throw new Error('EACCES: permission denied everywhere (simulated)');
        }
        return originalWriteFileSync(filePath, ...rest);
      };

      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Total Failure Test', components: [], primitives: [],
      });

      assert.equal(h.session.buildsSinceReport, 0, 'must still clear — report content is returned inline regardless');
      assert.equal(h.session.phase, 5);
      assert.equal(result.reportPath, null);
      assert.ok(result.reportWriteWarning);
      assert.match(result.reportWriteWarning, /only copy/i);
    } finally {
      cleanup(h.tmpDir);
    }
  });
});

describe('mimic_ai_knowledge_write — error message includes "rule" (A5)', () => {
  it('lists rule as a valid type when an unknown type is given', async () => {
    const h = createHarness();
    try {
      const result = await h.handlers.mimic_ai_knowledge_write({ type: 'bogus', id: 'x', data: {} });
      assert.match(result.error, /component, pattern, gap, or rule/);
    } finally {
      cleanup(h.tmpDir);
    }
  });
});

describe('mimic_ai_knowledge_read — surfaces knowledge store recovery warnings', () => {
  it('includes _storeWarning after the store recovered from a corrupt file', async () => {
    const h = createHarness();
    try {
      // Overwrite with garbage, then let the tool's own load() discover it.
      fs.writeFileSync(h.knowledgeStore.filePath, 'not json', 'utf-8');
      const result = await h.handlers.mimic_ai_knowledge_read({});
      assert.ok(result._storeWarning, 'should surface the recovery warning');
      assert.equal(result._storeWarning.code, 'KNOWLEDGE_STORE_CORRUPT');
    } finally {
      cleanup(h.tmpDir);
    }
  });

  it('omits _storeWarning on a normal, healthy load', async () => {
    const h = createHarness();
    try {
      const result = await h.handlers.mimic_ai_knowledge_read({});
      assert.equal(result._storeWarning, undefined);
    } finally {
      cleanup(h.tmpDir);
    }
  });
});

describe('mimic_generate_build_report — zero-component quality gate', () => {
  it('FAILS a build that used 0 DS components even when every primitive is justified (was a vacuous PASS)', async () => {
    const h = createHarness();
    try {
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'All Primitives Screen',
        components: [],
        primitives: [
          { element: 'sidebar', reason: 'DS sidebar component does not fit this layout' },
          { element: 'card', reason: 'mapped card component flagged removed in cache' },
          { element: 'badge', reason: 'mapper resolved badge to the wrong component' },
          { element: 'icon', reason: 'no generic DS icon component exists here' },
        ],
      });
      assert.equal(result.componentQualityGate, 'FAIL', '0 instances must never pass the gate');
      assert.equal(result.componentUsagePercent, 0, 'usage must read 0%, not a vacuous 100%');
      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.match(reportContent, /[Zz]ero DS components/, 'report must name the zero-component failure');
    } finally {
      cleanup(h.tmpDir);
    }
  });

  it('still PASSES a component-backed build whose only primitives are justified (exemption preserved)', async () => {
    const h = createHarness();
    try {
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Mostly Components Screen',
        components: [{ name: 'Button', instances: 10 }],
        primitives: [
          { element: 'chart', reason: 'no DS chart component exists in this library' },
        ],
      });
      assert.equal(result.componentQualityGate, 'PASS', 'justified primitives inside a component-backed build still pass');
      assert.equal(result.componentUsagePercent, 100);
    } finally {
      cleanup(h.tmpDir);
    }
  });

  it('FAILS the ordinary <80% case without claiming a zero-component failure', async () => {
    const h = createHarness();
    try {
      const result = await h.handlers.mimic_generate_build_report({
        screenName: 'Too Many Unjustified Screen',
        components: [{ name: 'Button', instances: 1 }],
        primitives: [
          { element: 'card' }, { element: 'badge' }, { element: 'row' }, { element: 'tile' },
        ],
      });
      assert.equal(result.componentQualityGate, 'FAIL');
      assert.ok(result.componentUsagePercent < 80 && result.componentUsagePercent > 0);
      const reportContent = fs.readFileSync(result.reportPath, 'utf-8');
      assert.doesNotMatch(reportContent, /[Zz]ero DS components/, 'this is not a zero-component build');
    } finally {
      cleanup(h.tmpDir);
    }
  });
});
