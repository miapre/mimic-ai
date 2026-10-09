'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { MockBridge } = require('../helpers/mock-bridge');
const { DsCache } = require('../../../src/ds/cache');
const { KnowledgeStore } = require('../../../src/knowledge/store');

function harness() {
  const bridge = new MockBridge();
  const dsCache = new DsCache();
  const ks = new KnowledgeStore(
    path.join(os.tmpdir(), `ks-health-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  ).load();
  const session = {
    phase: 2, toolCallCount: 0, cacheHits: 0, artboardId: null,
    phaseToolCalls: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  };
  const handlers = {};
  const register = (n, _d, _s, h) => { handlers[n] = h; };
  const advancePhase = (to) => { session.phase = Math.max(session.phase, to); };
  require('../../../src/tools/status').register(null, {
    bridge, dsCache, knowledgeStore: ks, session,
    advancePhase, resetSession: () => {}, registerTool: register,
    figmaRest: { validateToken: async () => {} },
  });
  return { handlers, dsCache, ks, session };
}

describe('mimic_status — discoveryHealth', () => {
  it('reports page-scan source and degraded when no REST components', async () => {
    const h = harness();
    h.dsCache.addComponent('c1', { name: 'Button', source: 'page_scan' });
    const r = await h.handlers.mimic_status();
    assert.equal(r.discoveryHealth.enumerationSource, 'page-scan');
    assert.equal(r.discoveryHealth.restComponents, 0);
    assert.equal(r.discoveryHealth.degraded, true);
    assert.ok((r.discoveryHealth.notes || []).some(n => /page-scan/i.test(n)));
  });

  it('reports rest source and not degraded when REST components present and cache fresh', async () => {
    const h = harness();
    h.dsCache.addComponent('c1', { name: 'Button', source: 'rest_api' });
    h.dsCache.addComponent('c2', { name: 'Badge', source: 'rest_api' });
    const r = await h.handlers.mimic_status();
    assert.equal(r.discoveryHealth.enumerationSource, 'rest');
    assert.equal(r.discoveryHealth.degraded, false);
    assert.equal(r.discoveryHealth.removedCached, 0);
  });

  it('flags a high removed-key ratio as degraded with a stale note', async () => {
    const h = harness();
    h.dsCache.addComponent('r1', { name: 'Card', source: 'rest_api' });
    h.dsCache.addComponent('r2', { name: 'Table', source: 'rest_api' });
    h.dsCache.addComponent('ok', { name: 'Button', source: 'rest_api' });
    h.ks.data.components = {
      r1: { componentKey: 'r1', stale: true, staleReason: 'component_removed' },
      r2: { componentKey: 'r2', stale: true, staleReason: 'component_removed' },
    };
    const r = await h.handlers.mimic_status();
    assert.equal(r.discoveryHealth.removedCached, 2);
    assert.ok(r.discoveryHealth.removedRatio >= 0.3);
    assert.equal(r.discoveryHealth.degraded, true);
    assert.ok((r.discoveryHealth.notes || []).some(n => /stale/i.test(n)));
  });

  it('reports source "none" for an empty cache', async () => {
    const h = harness();
    const r = await h.handlers.mimic_status();
    assert.equal(r.discoveryHealth.enumerationSource, 'none');
    assert.equal(r.discoveryHealth.componentsCached, 0);
    assert.equal(r.discoveryHealth.degraded, false);
  });
});
