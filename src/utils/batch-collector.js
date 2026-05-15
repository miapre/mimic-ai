'use strict';

/**
 * BatchCollector — drop-in bridge replacement that collects operations
 * into an array for sendBatch(), instead of sending each one individually.
 *
 * Usage:
 *   const collector = new BatchCollector();
 *   // Use collector.send() exactly like bridge.send()
 *   const result = await collector.send('create_frame', { parentId, name: 'Card' });
 *   // result.nodeId is '$resultOf:0' — a reference, not a real ID
 *   const child = await collector.send('create_text', { parentId: result.nodeId, ... });
 *   // child.nodeId is '$resultOf:1'
 *
 *   // Flush: send all collected ops as one batch
 *   const batchResult = await collector.flush(bridge);
 *   // batchResult has real nodeIds for all operations
 *
 *   // For read-then-write operations that need real data:
 *   await collector.flush(bridge); // flush pending ops first
 *   const svgResult = await bridge.send('create_svg', { parentId: realId, ... });
 *   // svgResult.unboundChildren has real nodeIds
 *
 * The collector is transparent: builders keep their existing code pattern.
 * The only change is swapping `bridge` for `collector` on linear operations.
 */
class BatchCollector {
  constructor() {
    /** @type {Array<{type: string, payload: object}>} */
    this.ops = [];
    this._idx = 0;
    /** @type {Map<number, object>} Real results after flush, keyed by batch index */
    this._realResults = new Map();
  }

  /**
   * Collect an operation. Returns a fake result with $resultOf:N references.
   * Mimics bridge.send() signature — returns a Promise for compatibility.
   *
   * @param {string} type - Handler type (create_frame, create_text, etc.)
   * @param {object} payload - Operation payload. Values that are $resultOf:N strings are preserved.
   * @returns {Promise<{nodeId: string, [key: string]: any}>}
   */
  async send(type, payload) {
    const myIdx = this._idx++;
    const resolvedPayload = this._resolvePayload(payload || {});
    this.ops.push({ type, payload: resolvedPayload });

    // Return a fake result with $resultOf reference as nodeId.
    // Builders check `result?.nodeId` for truthiness — this passes.
    return {
      nodeId: `$resultOf:${myIdx}`,
      _batchIdx: myIdx,
      _isBatchRef: true,
    };
  }

  /**
   * Flush all collected ops via bridge.sendBatch().
   * Returns the batch result. After flush, _realResults is populated
   * so getRealNodeId() can map batch indices to real IDs.
   *
   * @param {object} bridge - The Bridge instance
   * @returns {Promise<{results: Array, totalOps: number, succeeded: number, failed: number}>}
   */
  async flush(bridge) {
    if (this.ops.length === 0) {
      return { results: [], totalOps: 0, succeeded: 0, failed: 0 };
    }

    const batchResult = await bridge.sendBatch(this.ops);

    // Store real results for post-flush lookups
    for (const r of (batchResult.results || [])) {
      if (r.ok && r.result) {
        this._realResults.set(r.index, r.result);
      }
    }

    // Clear ops (already sent)
    const sentCount = this.ops.length;
    this.ops = [];

    return batchResult;
  }

  /**
   * Get the real nodeId for a batch reference after flush.
   * @param {string} ref - A '$resultOf:N' string or a real nodeId
   * @returns {string|null} The real nodeId, or the input if not a reference
   */
  getRealNodeId(ref) {
    if (!ref || typeof ref !== 'string') return ref;
    const m = ref.match(/^\$resultOf:(\d+)$/);
    if (!m) return ref; // Already a real ID
    const idx = parseInt(m[1], 10);
    const result = this._realResults.get(idx);
    return result?.nodeId || null;
  }

  /**
   * Get the full real result for a batch index after flush.
   * @param {number} idx - Batch operation index
   * @returns {object|null}
   */
  getRealResult(idx) {
    return this._realResults.get(idx) || null;
  }

  /**
   * Resolve payload values: if a value is a fake result object (from a prior
   * collector.send()), extract its $resultOf:N reference.
   */
  _resolvePayload(payload) {
    const out = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value && typeof value === 'object' && value._isBatchRef) {
        // Fake result from a prior send() — use its reference
        out[key] = value.nodeId; // '$resultOf:N'
      } else {
        out[key] = value;
      }
    }
    return out;
  }
}

module.exports = { BatchCollector };
