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
