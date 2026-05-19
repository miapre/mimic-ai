'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

class Bridge {
  /**
   * @param {object} opts
   * @param {number} [opts.port=3056]
   * @param {number} [opts.keepaliveInterval=15000]
   * @param {number} [opts.maxReconnectAttempts=3]
   * @param {number} [opts.defaultTimeout=60000]
   */
  constructor(opts = {}) {
    this.port = opts.port ?? 3056;
    this.keepaliveInterval = opts.keepaliveInterval ?? 15000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 3;
    this.defaultTimeout = opts.defaultTimeout ?? 120000;

    this.connected = false;
    this.ws = null;
    this.server = null;
    this.wss = null;
    this._keepaliveTimer = null;

    /** @type {Array<{msg: object, resolve: Function, reject: Function, timeout: number}>} */
    this.pendingOps = [];

    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.responseHandlers = new Map();
  }

  // ── Message formatting ──────────────────────────────────────────────

  /**
   * Creates a message envelope with a unique ID.
   */
  formatMessage(type, payload) {
    return {
      id: crypto.randomUUID(),
      type,
      payload: payload ?? {},
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Start HTTP + WebSocket server.
   * @returns {Promise<void>}
   */
  start() {
    // Kill any zombie process on the port before binding
    try {
      const pids = execSync(`lsof -ti :${this.port} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (pids) {
        for (const pid of pids.split('\n')) {
          try { process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
        }
        // Brief wait for port release
        execSync('sleep 0.3');
      }
    } catch (_) { /* no process on port — normal */ }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleHttp(req, res);
      });

      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on('connection', (socket) => this._onConnection(socket));

      this.server.listen(this.port, () => {
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Gracefully stop everything.
   */
  async stop() {
    this.stopKeepalive();

    // Reject all pending response handlers
    for (const [id, handler] of this.responseHandlers) {
      clearTimeout(handler.timer);
      handler.reject(new Error('Bridge shutting down'));
    }
    this.responseHandlers.clear();

    // Reject queued ops
    for (const op of this.pendingOps) {
      op.reject(new Error('Bridge shutting down'));
    }
    this.pendingOps = [];

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ── Sending ─────────────────────────────────────────────────────────

  /**
   * Send a message to the connected Figma plugin.
   * Queues if not connected; resolves when response arrives.
   *
   * @param {string} type
   * @param {object} payload
   * @param {number} [timeout]
   * @returns {Promise<object>}
   */
  send(type, payload, timeout) {
    const msg = this.formatMessage(type, payload);
    const effectiveTimeout = timeout ?? this.defaultTimeout;

    const promise = new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) {
        // Fail fast — don't queue indefinitely when the plugin is disconnected.
        // The user gets a clear error and can reconnect the plugin and retry.
        reject(new Error(
          `PLUGIN_DISCONNECTED: Cannot execute "${type}" — the Figma plugin is not connected. ` +
          `Open Figma and run the Mimic AI plugin (Plugins > Development > Mimic AI > Run), ` +
          `then retry the operation.`
        ));
        return;
      }

      this._dispatch(msg, resolve, reject, effectiveTimeout);
    });

    return promise;
  }

  /**
   * Send a batch of operations to the plugin in one WebSocket message.
   * The plugin executes them sequentially with $resultOf:N reference resolution.
   * Auto-chunks at CHUNK_SIZE operations to avoid plugin timeout.
   *
   * @param {Array<{type: string, payload: object}>} operations
   * @param {number} [timeout] - Override timeout per chunk.
   * @returns {Promise<{results: Array, totalOps: number, succeeded: number, failed: number}>}
   */
  sendBatch(operations, timeout) {
    const CHUNK_SIZE = 50;

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
      const effectiveTimeout = timeout ?? (this.defaultTimeout + normalizedOps.length * 500);
      const msg = this.formatMessage('batch_execute', { operations: normalizedOps });

      return new Promise((resolve, reject) => {
        if (!this.connected || !this.ws) {
          reject(new Error(
            `PLUGIN_DISCONNECTED: Cannot execute batch — the Figma plugin is not connected. ` +
            `Open Figma and run the Mimic AI plugin, then retry.`
          ));
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
    const CHUNK_SIZE = 50;
    const allResults = [];
    let offset = 0;

    for (let start = 0; start < operations.length; start += CHUNK_SIZE) {
      const chunk = operations.slice(start, start + CHUNK_SIZE);

      // Remap $resultOf references: prior-chunk refs resolve to concrete values,
      // same-chunk refs get re-indexed relative to chunk start.
      const remapped = chunk.map(op => {
        const payload = { ...op.payload };
        for (const key of ['nodeId', 'parentId', 'targetId']) {
          if (typeof payload[key] === 'string') {
            const m = payload[key].match(/^\$resultOf:(\d+)(?:\.(.+))?$/);
            if (m) {
              const refIdx = parseInt(m[1], 10);
              if (refIdx < offset) {
                // Reference points to a prior chunk — resolve with concrete value
                const field = m[2] || 'nodeId';
                const prior = allResults[refIdx];
                payload[key] = (prior && prior.ok && prior.result) ? (prior.result[field] || null) : null;
              } else {
                // Reference is within this chunk — remap index
                const newIdx = refIdx - offset;
                payload[key] = `$resultOf:${newIdx}${m[2] ? '.' + m[2] : ''}`;
              }
            }
          }
        }
        return { type: op.type, payload };
      });

      const effectiveTimeout = timeout ?? (this.defaultTimeout + remapped.length * 500);
      const msg = this.formatMessage('batch_execute', { operations: remapped });

      const chunkResult = await new Promise((resolve, reject) => {
        if (!this.connected || !this.ws) {
          reject(new Error(
            `PLUGIN_DISCONNECTED: Cannot execute batch chunk — the Figma plugin is not connected. ` +
            `Open Figma and run the Mimic AI plugin, then retry.`
          ));
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

  // ── Keepalive ───────────────────────────────────────────────────────

  startKeepalive() {
    this.stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      if (this.ws && this.connected) {
        this.ws.ping();
      }
    }, this.keepaliveInterval);

    // Allow the Node process to exit even if the timer is running
    if (this._keepaliveTimer.unref) {
      this._keepaliveTimer.unref();
    }
  }

  stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  // ── Pending ops flush ───────────────────────────────────────────────

  flushPendingOps() {
    const ops = this.pendingOps.splice(0);
    for (const op of ops) {
      this._dispatch(op.msg, op.resolve, op.reject, op.timeout);
    }
  }

  // ── Private ─────────────────────────────────────────────────────────

  /**
   * Normalize Figma node IDs: replace dashes with colons.
   */
  _normalizeNodeIds(payload) {
    if (!payload) return payload;
    const out = { ...payload };
    for (const key of ['nodeId', 'parentId', 'targetId']) {
      if (typeof out[key] === 'string') {
        out[key] = out[key].replace(/-/g, ':');
      }
    }
    return out;
  }

  /**
   * Send a message over the WebSocket and register a response handler.
   */
  _dispatch(msg, resolve, reject, timeout) {
    const normalized = {
      ...msg,
      payload: this._normalizeNodeIds(msg.payload),
    };

    const timer = setTimeout(() => {
      this.responseHandlers.delete(msg.id);
      reject(new Error(`Bridge timeout after ${timeout}ms for ${msg.type} (${msg.id})`));
    }, timeout);

    // Allow timer to not block exit
    if (timer.unref) timer.unref();

    this.responseHandlers.set(msg.id, { resolve, reject, timer });

    try {
      this.ws.send(JSON.stringify(normalized));
    } catch (err) {
      clearTimeout(timer);
      this.responseHandlers.delete(msg.id);
      reject(err);
    }
  }

  /**
   * Handle incoming WebSocket connection from the Figma plugin.
   */
  _onConnection(socket) {
    // Only keep the latest connection
    if (this.ws) {
      this.ws.close();
    }

    this.ws = socket;
    this.connected = true;

    this.startKeepalive();
    this.flushPendingOps();

    socket.on('message', (data) => {
      this._onMessage(data);
    });

    socket.on('close', () => {
      if (this.ws === socket) {
        this.connected = false;
        this.ws = null;
        this.stopKeepalive();
      }
    });

    socket.on('error', (err) => {
      // Swallow; close handler will clean up
    });
  }

  /**
   * Handle an incoming message (response from Figma plugin).
   */
  _onMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // Malformed JSON, ignore
    }

    const handler = this.responseHandlers.get(data.id);
    if (!handler) return; // No matching request

    clearTimeout(handler.timer);
    this.responseHandlers.delete(data.id);

    if (data.error) {
      const errorMsg = typeof data.error === 'object'
        ? (data.error.message || JSON.stringify(data.error))
        : String(data.error);
      const err = new Error(errorMsg);
      err.pluginError = data.error;
      handler.reject(err);
    } else {
      handler.resolve(data.result ?? data);
    }
  }

  /**
   * Minimal HTTP handler for /status and /execute.
   */
  _handleHttp(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        connected: this.connected,
        pendingOps: this.pendingOps.length,
      }));
      return;
    }

    if (req.url === '/execute' && req.method === 'POST') {
      this._handleExecute(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  /**
   * POST /execute — forward a command to the Figma plugin via WebSocket.
   */
  _handleExecute(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { type, payload, timeout } = JSON.parse(body);
        if (!type) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "type" field' }));
          return;
        }
        const result = await this.send(type, payload, timeout);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
}

// ── Standalone entry point ────────────────────────────────────────────

async function startStandalone() {
  const bridge = new Bridge({ port: Number(process.env.BRIDGE_PORT) || 3056 });
  await bridge.start();
  console.log(`Bridge listening on port ${bridge.port}`);

  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { Bridge, startStandalone };
