'use strict';

/**
 * Regression tests for the WebSocket bridge hardening audit:
 *   1. Port takeover no longer kills processes — EADDRINUSE is handled by
 *      probing whether the existing listener is a Mimic bridge.
 *   2. Ping/pong liveness — a frozen/half-open socket is terminated instead
 *      of leaving `connected: true` for the full op timeout.
 *   3. Superseded connections reject their in-flight response handlers
 *      immediately instead of idling out the timeout.
 *   4. /execute request bodies are capped (413 beyond the limit).
 *   5. A raw WebSocket connection is not treated as the plugin executor
 *      until it sends the `mimic_hello` handshake message.
 *
 * These tests bind real HTTP/WS servers on dedicated ports (39561-39572)
 * to avoid clashing with any other suite in this repo (none currently bind
 * real servers — see bridge.test.js, which only exercises Bridge methods
 * without calling start()). Every test closes everything it opens in a
 * `finally` block — a real listening server left open by a failed
 * assertion would otherwise keep the whole `node --test` process alive
 * indefinitely (net servers hold the event loop open).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { Bridge } = require('../../src/bridge');

const BASE_PORT = 39561;

/** Connect a raw `ws` client to the bridge and wait for the socket to open. */
function connectClient(port) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on('open', () => resolve(client));
    client.on('error', reject);
  });
}

function sendHello(client) {
  client.send(JSON.stringify({ type: 'mimic_hello' }));
}

/** Poll until `check()` returns true or the timeout elapses. */
function waitFor(check, { timeout = 2000, interval = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** Start a real Bridge and guarantee bridge.stop() runs even on assertion failure. */
async function withBridge(opts, fn) {
  const bridge = new Bridge(opts);
  await bridge.start();
  try {
    return await fn(bridge);
  } finally {
    await bridge.stop().catch(() => {});
  }
}

describe('Bridge — multi-session attach (defect 1)', () => {
  it('a second bridge on the same Mimic port attaches as a client instead of failing, without killing the first', async () => {
    const port = BASE_PORT + 0;
    await withBridge({ port }, async (bridgeA) => {
      const bridgeB = new Bridge({ port });
      await bridgeB.start(); // must NOT reject — it attaches as a client
      try {
        assert.equal(bridgeB.mode, 'client');
        assert.equal(bridgeA.mode, 'owner');
        // The first bridge must be completely unharmed — no process was killed.
        assert.equal(bridgeA.connected, false);
        assert.ok(bridgeA.server.listening);
      } finally {
        await bridgeB.stop().catch(() => {});
      }
    });
  });

  it('a client-mode bridge proxies operations to the owner and back to the plugin', async () => {
    const port = BASE_PORT + 5;
    await withBridge({ port }, async (bridgeA) => {
      // Simulate the Figma plugin: connect to the owner and echo every request
      // back as a successful result keyed by the same id.
      const plugin = await connectClient(port);
      plugin.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'mimic_hello') return;
        plugin.send(JSON.stringify({ id: msg.id, result: { echoed: msg.type } }));
      });
      sendHello(plugin);
      await waitFor(() => bridgeA.connected);

      const bridgeB = new Bridge({ port });
      await bridgeB.start();
      try {
        assert.equal(bridgeB.mode, 'client');
        // A single op proxied through the owner to the (fake) plugin.
        const single = await bridgeB.send('get_page_nodes', {});
        assert.deepEqual(single, { echoed: 'get_page_nodes' });
      } finally {
        plugin.close();
        await bridgeB.stop().catch(() => {});
      }
    });
  });

  it('fails with generic EADDRINUSE guidance when the port is held by a non-Mimic process', async () => {
    const port = BASE_PORT + 1;
    const plainServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'not a mimic bridge' }));
    });
    await new Promise((resolve) => plainServer.listen(port, '127.0.0.1', resolve));

    try {
      const bridge = new Bridge({ port });
      await assert.rejects(
        () => bridge.start(),
        (err) => {
          assert.doesNotMatch(err.message, /Another Mimic AI session/);
          assert.match(err.message, new RegExp(`Port ${port} is already in use`));
          assert.match(err.message, /MIMIC_BRIDGE_PORT/);
          return true;
        }
      );
    } finally {
      await new Promise((resolve) => plainServer.close(resolve));
    }
  });

  it('MIMIC_BRIDGE_PORT env var is honored when no explicit port option is passed', () => {
    const prior = process.env.MIMIC_BRIDGE_PORT;
    process.env.MIMIC_BRIDGE_PORT = '45123';
    try {
      const bridge = new Bridge();
      assert.equal(bridge.port, 45123);
    } finally {
      if (prior === undefined) delete process.env.MIMIC_BRIDGE_PORT;
      else process.env.MIMIC_BRIDGE_PORT = prior;
    }
  });

  it('accepts the Figma plugin WebSocket origins (figma.com and sandboxed "null"), rejects arbitrary web origins', async () => {
    const port = BASE_PORT + 6;
    await withBridge({ port }, async () => {
      const tryOrigin = (origin) => new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin === undefined ? {} : { headers: { Origin: origin } });
        const t = setTimeout(() => { try { ws.terminate(); } catch (_) {} resolve('timeout'); }, 2000);
        ws.on('open', () => { clearTimeout(t); ws.close(); resolve('accepted'); });
        ws.on('error', () => { clearTimeout(t); resolve('rejected'); });
      });

      assert.equal(await tryOrigin(undefined), 'accepted', 'no-origin (bridge client) must connect');
      assert.equal(await tryOrigin('null'), 'accepted', 'sandboxed-iframe "null" origin must connect');
      assert.equal(await tryOrigin('https://www.figma.com'), 'accepted', 'Figma plugin origin must connect');
      assert.equal(await tryOrigin('https://evil.example.com'), 'rejected', 'arbitrary web origin must be blocked');
    });
  });

  it('/status no longer reports the removed pendingOps field', async () => {
    const port = BASE_PORT + 2;
    await withBridge({ port }, async (bridge) => {
      const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/status`, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      const parsed = JSON.parse(body);
      assert.equal(parsed.service, 'mimic-ai-bridge');
      assert.ok(!('pendingOps' in parsed), 'pendingOps should be removed from /status');
    });
  });
});

describe('Bridge hardening — ping/pong liveness (defect 2)', () => {
  it('a socket that never pongs back is terminated on the next tick, and ops fail fast', async () => {
    const port = BASE_PORT + 3;
    await withBridge({ port, keepaliveInterval: 50 }, async (bridge) => {
      const client = await connectClient(port);
      try {
        sendHello(client);
        await waitFor(() => bridge.connected === true);

        // Simulate two ping ticks with no pong in between (frozen plugin):
        // tick 1 marks the ping outstanding, tick 2 finds it still unanswered.
        bridge._pingTick();
        assert.equal(bridge.ws.isAlive, false);
        bridge._pingTick();

        await waitFor(() => bridge.connected === false);
        assert.equal(bridge.ws, null);

        // Ops must fail fast (PLUGIN_DISCONNECTED), not hang out the timeout.
        await assert.rejects(
          () => bridge.send('create_frame', {}),
          (err) => {
            assert.match(err.message, /PLUGIN_DISCONNECTED/);
            return true;
          }
        );
      } finally {
        client.close();
      }
    });
  });

  it('a socket that responds to pings stays alive across ticks', async () => {
    const port = BASE_PORT + 4;
    await withBridge({ port, keepaliveInterval: 50 }, async (bridge) => {
      const client = await connectClient(port);
      try {
        sendHello(client);
        await waitFor(() => bridge.connected === true);

        // `ws` clients auto-respond to ping frames with pong at the protocol
        // level, so a real tick-pong-tick cycle should never mark it dead.
        bridge._pingTick();
        assert.equal(bridge.ws.isAlive, false);
        await waitFor(() => bridge.ws && bridge.ws.isAlive === true);
        bridge._pingTick();
        assert.equal(bridge.connected, true);
      } finally {
        client.close();
      }
    });
  });
});

describe('Bridge hardening — supersede rejects in-flight handlers (defect 3)', () => {
  it('a new connection sending hello rejects the prior connection\'s pending ops immediately', async () => {
    const port = BASE_PORT + 5;
    await withBridge({ port, defaultTimeout: 5000 }, async (bridge) => {
      const clientA = await connectClient(port);
      let clientB = null;
      try {
        sendHello(clientA);
        await waitFor(() => bridge.connected === true);

        const pending = bridge.send('create_frame', { name: 'stuck' });
        // clientA never replies — request would otherwise idle for defaultTimeout.

        clientB = await connectClient(port);
        sendHello(clientB);

        await assert.rejects(pending, (err) => {
          assert.match(err.message, /PLUGIN_DISCONNECTED/);
          assert.match(err.message, /reconnected/);
          return true;
        });

        await waitFor(() => bridge.ws && bridge.connected === true);
      } finally {
        clientA.close();
        if (clientB) clientB.close();
      }
    });
  });

  it('socket close rejects any still-pending handlers immediately', async () => {
    const port = BASE_PORT + 6;
    await withBridge({ port, defaultTimeout: 5000 }, async (bridge) => {
      const client = await connectClient(port);
      try {
        sendHello(client);
        await waitFor(() => bridge.connected === true);

        const pending = bridge.send('create_frame', { name: 'stuck' });
        client.close();

        await assert.rejects(pending, (err) => {
          assert.match(err.message, /PLUGIN_DISCONNECTED/);
          return true;
        });
      } finally {
        client.close();
      }
    });
  });
});

describe('Bridge hardening — /execute body cap (defect 5a)', () => {
  it('rejects oversized bodies with 413', async () => {
    const port = BASE_PORT + 7;
    await withBridge({ port }, async () => {
      const bigPayload = 'x'.repeat(3 * 1024 * 1024); // 3 MB — over the 2 MB cap
      const body = JSON.stringify({ type: 'create_frame', payload: { note: bigPayload } });

      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/execute', method: 'POST', headers: { 'Content-Type': 'application/json', 'Connection': 'close' } },
          (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
        );
        // The server responds 413 and closes while the client is still
        // streaming the 3 MB body — the tail of the write can race the
        // close and surface as ECONNRESET/EPIPE on the request. That is
        // the expected shape of an early rejection, not a failure: only
        // reject if we never got a response at all.
        let gotResponse = false;
        req.on('response', () => { gotResponse = true; });
        req.on('error', (err) => {
          if (gotResponse) return; // response already resolving
          if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
            resolve(413); // early close after/while rejecting = the cap worked
          } else {
            reject(err);
          }
        });
        req.write(body);
        req.end();
      });

      assert.equal(status, 413);
    });
  });

  it('still processes normal-sized bodies (fails 500 with PLUGIN_DISCONNECTED when no plugin is connected)', async () => {
    const port = BASE_PORT + 8;
    await withBridge({ port }, async () => {
      const body = JSON.stringify({ type: 'create_frame', payload: { name: 'ok' } });
      const { status, parsed } = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/execute', method: 'POST', headers: { 'Content-Type': 'application/json', 'Connection': 'close' } },
          (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, parsed: JSON.parse(data) }));
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      assert.equal(status, 500);
      assert.match(parsed.error, /PLUGIN_DISCONNECTED/);
    });
  });
});

describe('Bridge hardening — executor requires hello handshake (defect 5b/5c)', () => {
  it('a connection that never sends hello is not treated as the plugin executor', async () => {
    const port = BASE_PORT + 9;
    await withBridge({ port }, async (bridge) => {
      const client = await connectClient(port);
      try {
        // Give the bridge a moment to (incorrectly, if regressed) promote the socket.
        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(bridge.connected, false);
        assert.equal(bridge.ws, null);
      } finally {
        client.close();
      }
    });
  });

  it('promotes the connection to executor once it sends mimic_hello', async () => {
    const port = BASE_PORT + 10;
    await withBridge({ port }, async (bridge) => {
      const client = await connectClient(port);
      try {
        assert.equal(bridge.connected, false);

        sendHello(client);
        await waitFor(() => bridge.connected === true);
        assert.ok(bridge.ws, 'bridge.ws should be set once hello arrives');
      } finally {
        client.close();
      }
    });
  });

  it('quietly ignores non-JSON and unrecognized-type messages before the handshake (no crash, no promotion)', async () => {
    const port = BASE_PORT + 11;
    await withBridge({ port }, async (bridge) => {
      const client = await connectClient(port);
      try {
        client.send('not json at all');
        client.send(JSON.stringify({ type: 'not_a_hello', payload: {} }));
        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(bridge.connected, false, 'garbage/unknown messages must not promote the connection');

        // The bridge (and the test process) must still be alive and responsive.
        sendHello(client);
        await waitFor(() => bridge.connected === true);
      } finally {
        client.close();
      }
    });
  });
});
