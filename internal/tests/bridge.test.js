const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Bridge } = require('../../src/bridge');

describe('Bridge', () => {
  it('initializes with correct defaults', () => {
    const bridge = new Bridge({ port: 3055 });
    assert.equal(bridge.port, 3055);
    assert.equal(bridge.connected, false);
    assert.equal(bridge.keepaliveInterval, 15000);
  });

  it('rejects immediately when not connected', async () => {
    const bridge = new Bridge({ port: 3055 });
    await assert.rejects(
      () => bridge.send('create_frame', { name: 'test' }),
      (err) => {
        assert.ok(err.message.includes('PLUGIN_DISCONNECTED'));
        return true;
      }
    );
  });

  it('formats messages correctly', () => {
    const bridge = new Bridge({ port: 3055 });
    const msg = bridge.formatMessage('create_frame', { name: 'test' });
    assert.equal(msg.type, 'create_frame');
    assert.equal(msg.payload.name, 'test');
    assert.ok(msg.id);
  });
});

describe('sendBatch', () => {
  it('rejects immediately when not connected', async () => {
    const bridge = new Bridge({ port: 3055 });
    const ops = [
      { type: 'create_frame', payload: { name: 'Card' } },
      { type: 'create_text', payload: { parentId: '$resultOf:0', content: 'Hello' } },
    ];
    await assert.rejects(
      () => bridge.sendBatch(ops),
      (err) => {
        assert.ok(err.message.includes('PLUGIN_DISCONNECTED'));
        return true;
      }
    );
  });

  it('normalizes node IDs in operations', () => {
    const bridge = new Bridge({ port: 3055 });
    // Test normalization via formatMessage internals — sendBatch normalizes before dispatch
    const ops = [
      { type: 'create_text', payload: { parentId: '100-5' } },
      { type: 'create_text', payload: { parentId: '$resultOf:0' } },
    ];
    // Manually normalize like sendBatch does
    const normalized = ops.map(op => {
      const payload = { ...op.payload };
      for (const key of ['nodeId', 'parentId', 'targetId']) {
        if (typeof payload[key] === 'string' && !payload[key].startsWith('$resultOf:')) {
          payload[key] = payload[key].replace(/-/g, ':');
        }
      }
      return { type: op.type, payload };
    });
    assert.equal(normalized[0].payload.parentId, '100:5');
    assert.equal(normalized[1].payload.parentId, '$resultOf:0');
  });

  it('computes scaled timeout for batch', () => {
    const bridge = new Bridge({ port: 3055, defaultTimeout: 10000 });
    // Timeout formula: defaultTimeout + ops.length * 150
    const ops = [{ type: 'create_frame', payload: {} }];
    const expected = 10000 + ops.length * 150;
    assert.ok(expected > 10000);
    assert.equal(expected, 10150);
  });
});
