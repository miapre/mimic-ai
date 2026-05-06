'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

class Bridge {
  /**
   * @param {object} opts
   * @param {number} [opts.port=3055]
   * @param {number} [opts.keepaliveInterval=15000]
   * @param {number} [opts.maxReconnectAttempts=3]
   * @param {number} [opts.defaultTimeout=60000]
   */
  constructor(opts = {}) {
    this.port = opts.port ?? 3055;
    this.keepaliveInterval = opts.keepaliveInterval ?? 15000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 3;
    this.defaultTimeout = opts.defaultTimeout ?? 60000;

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
        // Queue for later
        this.pendingOps.push({ msg, resolve, reject, timeout: effectiveTimeout });
        return;
      }

      this._dispatch(msg, resolve, reject, effectiveTimeout);
    });

    return promise;
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
      const err = new Error(typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error));
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
  const bridge = new Bridge({ port: Number(process.env.BRIDGE_PORT) || 3055 });
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
