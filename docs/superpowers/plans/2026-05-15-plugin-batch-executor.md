# Plugin-Side Batch Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send N Figma operations in one WebSocket message; plugin executes sequentially with dependency resolution, returns all results in one response. Eliminates per-operation WS round-trip overhead (estimated 40-60% wall-clock speedup for linear operation chains).

**Architecture:** New `batch_execute` handler in the plugin processes an ordered operation array. Operations can reference prior results via `$resultOf:N` markers. The bridge gets a `sendBatch()` method with auto-chunking for large batches. Bulk tools adopt a **hybrid approach**: batch linear chains, fall back to sequential `bridge.send()` for read-then-write patterns that require intermediate inspection.

**Tech Stack:** Node.js (bridge), Figma Plugin API (ES5-ish sandbox), node:test for testing.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `plugin/code.js` | Modify (~2252) | Add `handlers.batch_execute` — receives operation array, executes sequentially, resolves `$resultOf:N` references, returns all results |
| `src/bridge.js` | Modify (~139) | Add `sendBatch(operations, timeout)` — formats batch message, auto-chunks at 200 ops, returns aggregated results |
| `internal/tests/bridge.test.js` | Modify | Add tests for `sendBatch` formatting, queuing, chunking, and ref preservation |
| `internal/tests/batch-executor.test.js` | Create | Tests for plugin-side reference resolution (tested via simulated results) |

**NOT modified (yet):**
- `src/tools/learning.js` (build_table) — cellVariants requires `get_node_children` read-then-write, can't be expressed as linear `$resultOf` chain. Hybrid migration deferred to a follow-up after the executor proves stable.
- `src/tools/chart.js` (build_chart) — SVG `unboundChildren[N].nodeId` requires array indexing not supported by `$resultOf:N.field`. Same deferral.

---

### Task 1: Plugin batch_execute Handler

The plugin handler that receives an array of operations, executes them sequentially, resolves `$resultOf:N` references between operations, and returns all results in one response. This is the only place reference resolution lives — no duplicate implementation.

**Files:**
- Modify: `plugin/code.js` (after `handlers.validate_library_access`, ~line 2252)

- [ ] **Step 1: Add the batch_execute handler**

Insert after `handlers.validate_library_access` (around line 2252):

```javascript
// ── Batch Executor ───────────────────────────────────────────────────────────
// Receives an array of operations, executes sequentially with $resultOf:N
// reference resolution between operations. Returns all results in one response.
// Eliminates per-operation WebSocket round-trips.

handlers.batch_execute = async function (payload) {
  var operations = payload.operations || [];
  if (operations.length === 0) return { results: [], totalOps: 0, succeeded: 0, failed: 0 };
  if (operations.length > 200) throw {
    error: 'BATCH_TOO_LARGE',
    message: 'Maximum 200 operations per batch. Got: ' + operations.length + '. The bridge auto-chunks larger batches.',
    recovery: 'Use bridge.sendBatch() which handles chunking automatically.'
  };

  var results = [];
  var REF_PATTERN = /^\$resultOf:(\d+)(?:\.(.+))?$/;

  function resolvePayloadRefs(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(resolvePayloadRefs);
    var out = {};
    for (var key in obj) {
      if (!obj.hasOwnProperty(key)) continue;
      var val = obj[key];
      if (typeof val === 'string') {
        var m = val.match(REF_PATTERN);
        if (m) {
          var idx = parseInt(m[1], 10);
          var field = m[2] || 'nodeId';
          var entry = results[idx];
          out[key] = (entry && entry.ok && entry.result) ? (entry.result[field] || null) : null;
        } else {
          out[key] = val;
        }
      } else if (typeof val === 'object' && val !== null) {
        out[key] = resolvePayloadRefs(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  for (var i = 0; i < operations.length; i++) {
    var op = operations[i];
    var opType = op.type;
    var opPayload = op.payload || {};

    var resolved = resolvePayloadRefs(opPayload);

    // Normalize node IDs
    var idKeys = ['nodeId', 'parentId', 'targetId', 'instanceId', 'frameId'];
    for (var k = 0; k < idKeys.length; k++) {
      if (typeof resolved[idKeys[k]] === 'string') {
        resolved[idKeys[k]] = resolved[idKeys[k]].replace(/-/g, ':');
      }
    }

    // Skip if a required parent/node reference resolved to null
    if (resolved.parentId === null || resolved.nodeId === null) {
      results.push({
        ok: false, index: i, type: opType,
        error: 'SKIPPED_DEPENDENCY_FAILED',
        message: 'A $resultOf reference resolved to null (prior operation failed or out of bounds).',
      });
      continue;
    }

    var handler = handlers[opType];
    if (!handler) {
      results.push({ ok: false, index: i, type: opType, error: 'UNKNOWN_HANDLER', message: 'No handler: ' + opType });
      continue;
    }

    try {
      var result = handler(resolved);
      if (result && typeof result.then === 'function') {
        result = await result;
      }
      results.push({ ok: true, index: i, type: opType, result: result });
    } catch (err) {
      var errMsg = (err instanceof Error) ? err.message : (err.message || JSON.stringify(err));
      results.push({ ok: false, index: i, type: opType, error: errMsg });
    }
  }

  var succeeded = results.filter(function (r) { return r.ok; }).length;
  return {
    results: results,
    totalOps: results.length,
    succeeded: succeeded,
    failed: results.length - succeeded,
  };
};
```

- [ ] **Step 2: Verify plugin syntax**

Run: `cd "/Users/jabu/AI Studio/tools/Mimic AI" && node -e "try { require('./plugin/code.js') } catch(e) { if (e.message.includes('figma')) { console.log('Syntax OK (figma not defined is expected)') } else { throw e } }"`

Expected: "Syntax OK" — the only error should be about `figma` global not existing.

- [ ] **Step 3: Commit**

```bash
cd "/Users/jabu/AI Studio/tools/Mimic AI"
git add plugin/code.js
git commit -m "feat: add batch_execute handler to Figma plugin"
```

---

### Task 2: Bridge sendBatch Method

The server-side method that formats operations into one WS message. Auto-chunks at 200 operations (plugin limit) and stitches results together. Preserves `$resultOf:N` references during node ID normalization.

**Files:**
- Modify: `src/bridge.js` (after `send()` method, ~line 139)
- Modify: `internal/tests/bridge.test.js`

- [ ] **Step 1: Write failing tests for sendBatch**

Append to `internal/tests/bridge.test.js`:

```javascript
describe('sendBatch', () => {
  it('formats batch message correctly', () => {
    const bridge = new Bridge({ port: 3055 });
    const ops = [
      { type: 'create_frame', payload: { name: 'Card' } },
      { type: 'create_text', payload: { parentId: '$resultOf:0', content: 'Hello' } },
    ];
    bridge.sendBatch(ops);
    assert.equal(bridge.pendingOps.length, 1);
    const queued = bridge.pendingOps[0];
    assert.equal(queued.msg.type, 'batch_execute');
    assert.equal(queued.msg.payload.operations.length, 2);
    assert.equal(queued.msg.payload.operations[0].type, 'create_frame');
    assert.equal(queued.msg.payload.operations[1].payload.parentId, '$resultOf:0');
  });

  it('normalizes node IDs but preserves $resultOf references', () => {
    const bridge = new Bridge({ port: 3055 });
    const ops = [
      { type: 'create_text', payload: { parentId: '100-5' } },
      { type: 'create_text', payload: { parentId: '$resultOf:0' } },
    ];
    bridge.sendBatch(ops);
    const queued = bridge.pendingOps[0];
    assert.equal(queued.msg.payload.operations[0].payload.parentId, '100:5');
    assert.equal(queued.msg.payload.operations[1].payload.parentId, '$resultOf:0');
  });

  it('uses scaled timeout for batch', () => {
    const bridge = new Bridge({ port: 3055, defaultTimeout: 10000 });
    bridge.sendBatch([{ type: 'create_frame', payload: {} }]);
    const queued = bridge.pendingOps[0];
    assert.ok(queued.timeout > 10000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/jabu/AI Studio/tools/Mimic AI" && node --test internal/tests/bridge.test.js`
Expected: FAIL — sendBatch is not a function

- [ ] **Step 3: Implement sendBatch**

Add after the `send()` method in `src/bridge.js` (line ~139):

```javascript
  /**
   * Send a batch of operations to the plugin in one WebSocket message.
   * The plugin executes them sequentially with $resultOf:N reference resolution.
   * Auto-chunks at CHUNK_SIZE operations to avoid plugin timeout.
   *
   * @param {Array<{type: string, payload: object}>} operations
   * @param {number} [timeout] - Override timeout per chunk. Defaults to defaultTimeout + 150ms per op.
   * @returns {Promise<{results: Array, totalOps: number, succeeded: number, failed: number}>}
   */
  sendBatch(operations, timeout) {
    const CHUNK_SIZE = 200;

    // Normalize node IDs but preserve $resultOf references
    const normalizedOps = operations.map(op => {
      const payload = op.payload ? { ...op.payload } : {};
      for (const key of ['nodeId', 'parentId', 'targetId']) {
        if (typeof payload[key] === 'string' && !payload[key].startsWith('$resultOf:')) {
          payload[key] = payload[key].replace(/-/g, ':');
        }
      }
      return { type: op.type, payload };
    });

    // Single chunk — send directly
    if (normalizedOps.length <= CHUNK_SIZE) {
      const effectiveTimeout = timeout ?? (this.defaultTimeout + normalizedOps.length * 150);
      const msg = this.formatMessage('batch_execute', { operations: normalizedOps });

      return new Promise((resolve, reject) => {
        if (!this.connected || !this.ws) {
          this.pendingOps.push({ msg, resolve, reject, timeout: effectiveTimeout });
          return;
        }
        this._dispatch(msg, resolve, reject, effectiveTimeout);
      });
    }

    // Multiple chunks — execute sequentially, stitch results
    return this._sendBatchChunked(normalizedOps, timeout);
  }

  /**
   * Internal: split large batch into chunks and execute sequentially.
   * Cross-chunk $resultOf references are resolved by remapping indices.
   */
  async _sendBatchChunked(operations, timeout) {
    const CHUNK_SIZE = 200;
    const allResults = [];
    let offset = 0;

    for (let start = 0; start < operations.length; start += CHUNK_SIZE) {
      const chunk = operations.slice(start, start + CHUNK_SIZE);

      // Remap $resultOf references: indices in this chunk may reference
      // results from prior chunks. Replace with concrete nodeIds from allResults.
      const remapped = chunk.map(op => {
        const payload = { ...op.payload };
        for (const key of ['nodeId', 'parentId', 'targetId']) {
          if (typeof payload[key] === 'string') {
            const m = payload[key].match(/^\$resultOf:(\d+)(?:\.(.+))?$/);
            if (m) {
              const refIdx = parseInt(m[1], 10);
              if (refIdx < offset) {
                // Reference points to a prior chunk — resolve now
                const field = m[2] || 'nodeId';
                const prior = allResults[refIdx];
                payload[key] = (prior && prior.ok && prior.result) ? (prior.result[field] || null) : null;
              } else {
                // Reference is within this chunk — remap index relative to chunk start
                const newIdx = refIdx - offset;
                payload[key] = `$resultOf:${newIdx}${m[2] ? '.' + m[2] : ''}`;
              }
            }
          }
        }
        return { type: op.type, payload };
      });

      const effectiveTimeout = timeout ?? (this.defaultTimeout + remapped.length * 150);
      const msg = this.formatMessage('batch_execute', { operations: remapped });

      const chunkResult = await new Promise((resolve, reject) => {
        if (!this.connected || !this.ws) {
          this.pendingOps.push({ msg, resolve, reject, timeout: effectiveTimeout });
          return;
        }
        this._dispatch(msg, resolve, reject, effectiveTimeout);
      });

      // Re-index results to global indices
      const chunkResults = (chunkResult.results || []).map(r => ({
        ...r,
        index: r.index + offset,
      }));
      allResults.push(...chunkResults);
      offset += chunk.length;
    }

    const succeeded = allResults.filter(r => r.ok).length;
    return {
      results: allResults,
      totalOps: allResults.length,
      succeeded,
      failed: allResults.length - succeeded,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/Users/jabu/AI Studio/tools/Mimic AI" && node --test internal/tests/bridge.test.js`
Expected: All tests PASS (original 3 + new 3)

- [ ] **Step 5: Run full test suite**

Run: `cd "/Users/jabu/AI Studio/tools/Mimic AI" && npm test`
Expected: All 109+ tests PASS

- [ ] **Step 6: Commit**

```bash
cd "/Users/jabu/AI Studio/tools/Mimic AI"
git add src/bridge.js internal/tests/bridge.test.js
git commit -m "feat: add sendBatch method to bridge with auto-chunking"
```

---

### Task 3: Reference Resolution Tests

Test the reference resolution logic through simulated result arrays. The actual resolution runs in the plugin, but the pattern is testable with a portable implementation.

**Files:**
- Create: `internal/tests/batch-executor.test.js`

- [ ] **Step 1: Write tests**

```javascript
// internal/tests/batch-executor.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');

// Portable implementation of the plugin's resolvePayloadRefs for testing.
// The canonical implementation lives in plugin/code.js handlers.batch_execute.
const REF_PATTERN = /^\$resultOf:(\d+)(?:\.(.+))?$/;

function resolveRefs(payload, results) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map(item => resolveRefs(item, results));
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      const match = value.match(REF_PATTERN);
      if (match) {
        const idx = parseInt(match[1], 10);
        const field = match[2] || 'nodeId';
        const entry = results[idx];
        out[key] = (entry && entry.ok && entry.result) ? (entry.result[field] ?? null) : null;
      } else {
        out[key] = value;
      }
    } else if (typeof value === 'object' && value !== null) {
      out[key] = resolveRefs(value, results);
    } else {
      out[key] = value;
    }
  }
  return out;
}

describe('batch executor reference resolution', () => {
  const results = [
    { ok: true, result: { nodeId: '100:1', name: 'Card' } },
    { ok: true, result: { nodeId: '100:2', name: 'Title' } },
    { ok: false, error: 'NODE_NOT_FOUND' },
  ];

  it('substitutes $resultOf:N with result.nodeId (default field)', () => {
    const payload = { parentId: '$resultOf:0', content: 'hello' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, '100:1');
    assert.equal(resolved.content, 'hello');
  });

  it('substitutes $resultOf:N.field for explicit field access', () => {
    const payload = { parentId: '$resultOf:1.name' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, 'Title');
  });

  it('returns null for references to failed operations', () => {
    const payload = { parentId: '$resultOf:2' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, null);
  });

  it('returns null for out-of-bounds references', () => {
    const payload = { parentId: '$resultOf:99' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, null);
  });

  it('leaves non-reference strings untouched', () => {
    const payload = { parentId: '100:5', name: 'Test' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.parentId, '100:5');
    assert.equal(resolved.name, 'Test');
  });

  it('resolves references in nested objects', () => {
    const payload = { props: { nodeId: '$resultOf:0' }, name: 'test' };
    const resolved = resolveRefs(payload, results);
    assert.equal(resolved.props.nodeId, '100:1');
  });

  it('does not mutate original payload', () => {
    const payload = { parentId: '$resultOf:0' };
    const original = JSON.stringify(payload);
    resolveRefs(payload, results);
    assert.equal(JSON.stringify(payload), original);
  });
});

describe('batch executor dependency chain simulation', () => {
  it('resolves 3-level dependency chain', () => {
    const r = [
      { ok: true, result: { nodeId: 'A' } },
      { ok: true, result: { nodeId: 'B' } },
    ];
    const op2 = { nodeId: '$resultOf:1', fillVariable: 'color' };
    const resolved = resolveRefs(op2, r);
    assert.equal(resolved.nodeId, 'B');
    assert.equal(resolved.fillVariable, 'color');
  });

  it('cascades skip when root operation fails', () => {
    const r = [{ ok: false, error: 'FAILED' }];
    const op1 = { parentId: '$resultOf:0' };
    const resolved = resolveRefs(op1, r);
    assert.equal(resolved.parentId, null);
    // Plugin would mark this as SKIPPED_DEPENDENCY_FAILED
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd "/Users/jabu/AI Studio/tools/Mimic AI" && node --test internal/tests/batch-executor.test.js`
Expected: All 9 tests PASS

- [ ] **Step 3: Run full suite**

Run: `cd "/Users/jabu/AI Studio/tools/Mimic AI" && npm test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd "/Users/jabu/AI Studio/tools/Mimic AI"
git add internal/tests/batch-executor.test.js
git commit -m "test: add reference resolution tests for batch executor"
```

---

### Task 4: Smoke Test with Live Plugin

Manual verification that the batch executor works end-to-end through the real bridge + plugin.

**Files:** None (manual test)

- [ ] **Step 1: Restart MCP server and Figma plugin**

Run `/mcp` in Claude Code. Re-run the Mimic AI plugin in Figma.

- [ ] **Step 2: Test via mimic_status + direct bridge call**

Create a small test script to verify batch_execute works:

```bash
cd "/Users/jabu/AI Studio/tools/Mimic AI" && node -e "
const { Bridge } = require('./src/bridge');
const b = new Bridge({ port: 3056 });
b.start().then(async () => {
  // Wait for plugin connection
  await new Promise(r => setTimeout(r, 2000));
  if (!b.connected) { console.log('Plugin not connected'); process.exit(1); }

  const result = await b.sendBatch([
    { type: 'get_page_nodes', payload: {} },
  ]);
  console.log('Batch result:', JSON.stringify({ totalOps: result.totalOps, succeeded: result.succeeded }));
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
"
```

Expected: `{ totalOps: 1, succeeded: 1 }`

Note: This test may fail if port 3056 is already in use by the running MCP server. In that case, verify through a build instead (Step 3).

- [ ] **Step 3: Alternative verification — check plugin logs**

In Figma, open the plugin console (Plugins > Development > Open Console). Run any Mimic build tool. Check that no errors appear related to `batch_execute`.

- [ ] **Step 4: Commit (docs only)**

```bash
cd "/Users/jabu/AI Studio/tools/Mimic AI"
git add docs/superpowers/plans/2026-05-15-plugin-batch-executor.md
git commit -m "docs: add batch executor implementation plan"
```

---

## Migration Strategy (Future — NOT in this plan)

The executor is infrastructure. Bulk tools migrate to it incrementally:

**Hybrid pattern for build_table:**
```javascript
// Phase 1: Batch the linear operations (frames, inserts, text, sizing)
const linearOps = [];
// ... collect create_frame, insert_component, set_component_text, set_layout_sizing
const batchResult = await bridge.sendBatch(linearOps);

// Phase 2: Sequential for read-then-write (cellVariants need get_node_children)
for (const cell of cellsNeedingVariants) {
  const children = await bridge.send('get_node_children', { nodeId: cell.nodeId });
  const badgeId = findBadgeChild(children);
  await bridge.send('set_variant', { nodeId: badgeId, properties: cell.variants });
}
```

**Hybrid pattern for build_chart:**
```javascript
// Phase 1: Batch frames, title, axis labels, grid rectangles, bars
const linearOps = [];
// ... collect all non-SVG operations
const batchResult = await bridge.sendBatch(linearOps);

// Phase 2: Sequential for SVG creation + child enumeration + binding
const svgResult = await bridge.send('create_svg', { ... });
for (const child of svgResult.unboundChildren) {
  await bridge.send('set_node_fill', { nodeId: child.nodeId, fillVariable: ... });
}
```

**When to migrate:** After the executor proves stable through manual testing and at least one full dashboard build.

---

## What NOT to Build

- **No MCP-level batch_execute tool.** The executor is internal infrastructure — bulk tools call `bridge.sendBatch()` directly.
- **No parallel execution.** Operations run sequentially (single-threaded plugin sandbox).
- **No transaction rollback.** Continue-on-error only. Failed operations skip dependents.
- **No array indexing in references.** `$resultOf:N.field` only, not `$resultOf:N.arr[0].field`. Operations needing array access use sequential `bridge.send()`.
- **No duplicate resolveRefs module.** Reference resolution lives ONLY in the plugin handler. The Node.js test file has a portable copy for testing, clearly marked as such.
