const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PatternMatcher } = require('../../src/knowledge/patterns');

describe('PatternMatcher', () => {
  it('promotes pattern after 3 uncorrected builds', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'new', buildCount: 2, source: 'auto' };
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'new');
    pattern.buildCount = 3;
    const promoted2 = matcher.maybePromote(pattern);
    assert.equal(promoted2.confidence, 'strong');
    assert.equal(promoted2.source, 'auto_promoted');
  });

  it('user correction sets confidence to strong immediately', () => {
    const matcher = new PatternMatcher();
    const result = matcher.applyCorrection({ confidence: 'new', buildCount: 1 }, 'user_correction');
    assert.equal(result.confidence, 'strong');
    assert.equal(result.source, 'user_correction');
  });
});
