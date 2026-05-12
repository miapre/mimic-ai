const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DsRequired, PluginError, PhaseError, BridgeError } = require('../../../src/utils/errors');

describe('Error types', () => {
  it('DsRequired includes property, available list, and recovery hint', () => {
    const err = new DsRequired('textStyle', ['Display xl', 'Text sm'], 'Pass textStyleId');
    assert.equal(err.error, 'DS_REQUIRED');
    assert.equal(err.property, 'textStyle');
    assert.deepStrictEqual(err.available, ['Display xl', 'Text sm']);
    assert.equal(err.recovery, 'Pass textStyleId');
    assert.ok(err.message.includes('textStyle'));
  });

  it('PhaseError blocks wrong-phase tool calls', () => {
    const err = new PhaseError(3, 1, 'Call mimic_discover_ds first');
    assert.equal(err.requiredPhase, 1);
    assert.equal(err.currentPhase, 3);
    assert.ok(err.message.includes('mimic_discover_ds'));
  });
});
