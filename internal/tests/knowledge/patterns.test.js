const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PatternMatcher, CONFIRMED_THRESHOLD, VERIFIED_THRESHOLD } = require('../../../src/knowledge/patterns');

describe('PatternMatcher', () => {
  it('promotes new → confirmed after CONFIRMED_THRESHOLD builds', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'new', buildCount: CONFIRMED_THRESHOLD - 1 };
    assert.equal(matcher.maybePromote(pattern).confidence, 'new');
    pattern.buildCount = CONFIRMED_THRESHOLD;
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'confirmed');
    assert.equal(promoted.source, 'auto_promoted');
  });

  it('promotes confirmed → verified after VERIFIED_THRESHOLD builds', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'confirmed', buildCount: VERIFIED_THRESHOLD - 1 };
    assert.equal(matcher.maybePromote(pattern).confidence, 'confirmed');
    pattern.buildCount = VERIFIED_THRESHOLD;
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'verified');
    assert.equal(promoted.source, 'auto_promoted');
  });

  it('promotes new → verified if buildCount jumps past both thresholds', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'new', buildCount: VERIFIED_THRESHOLD + 5 };
    // new with 12 builds should go straight to verified via the >= VERIFIED check
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'verified');
  });

  it('does not demote verified patterns', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'verified', buildCount: 1 };
    assert.equal(matcher.maybePromote(pattern).confidence, 'verified');
  });

  it('user correction sets confidence to confirmed', () => {
    const matcher = new PatternMatcher();
    const result = matcher.applyCorrection({ confidence: 'new', buildCount: 1 });
    assert.equal(result.confidence, 'confirmed');
    assert.equal(result.source, 'user_correction');
  });

  it('user confirmation sets confidence to verified', () => {
    const matcher = new PatternMatcher();
    const result = matcher.applyConfirmation({ confidence: 'new', buildCount: 1 });
    assert.equal(result.confidence, 'verified');
    assert.equal(result.source, 'user_confirmed');
  });

  it('legacy strong confidence gets promoted to verified at threshold', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'strong', buildCount: VERIFIED_THRESHOLD };
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'verified');
  });
});
