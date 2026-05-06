const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Bridge } = require('../src/bridge');

describe('Bridge', () => {
  it('initializes with correct defaults', () => {
    const bridge = new Bridge({ port: 3055 });
    assert.equal(bridge.port, 3055);
    assert.equal(bridge.connected, false);
    assert.equal(bridge.keepaliveInterval, 15000);
  });

  it('queues operations when not connected', () => {
    const bridge = new Bridge({ port: 3055 });
    const promise = bridge.send('create_frame', { name: 'test' });
    assert.equal(bridge.pendingOps.length, 1);
  });

  it('formats messages correctly', () => {
    const bridge = new Bridge({ port: 3055 });
    const msg = bridge.formatMessage('create_frame', { name: 'test' });
    assert.equal(msg.type, 'create_frame');
    assert.equal(msg.payload.name, 'test');
    assert.ok(msg.id);
  });
});
