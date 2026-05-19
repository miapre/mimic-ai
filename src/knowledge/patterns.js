'use strict';

const CONFIRMED_THRESHOLD = 3;
const VERIFIED_THRESHOLD = 7;

class PatternMatcher {
  /**
   * Auto-promote confidence through three tiers:
   *   new → confirmed (3+ builds)
   *   confirmed → verified (7+ builds)
   * Returns the (possibly promoted) pattern — does NOT mutate the original.
   */
  maybePromote(pattern) {
    const result = { ...pattern };
    if (result.buildCount >= VERIFIED_THRESHOLD && (result.confidence === 'new' || result.confidence === 'confirmed' || result.confidence === 'strong')) {
      if (result.confidence !== 'verified') {
        result.confidence = 'verified';
        result.source = 'auto_promoted';
        result.promotedAt = new Date().toISOString();
      }
    } else if (result.buildCount >= CONFIRMED_THRESHOLD && result.confidence === 'new') {
      result.confidence = 'confirmed';
      result.source = 'auto_promoted';
      result.promotedAt = new Date().toISOString();
    }
    return result;
  }

  /**
   * Apply a user correction — immediately sets confidence to 'confirmed'.
   * User corrections are strong signal but not verified (need more builds).
   */
  applyCorrection(pattern, source = 'user_correction') {
    return {
      ...pattern,
      confidence: 'confirmed',
      source,
      correctedAt: new Date().toISOString(),
    };
  }

  /**
   * Apply a confirmation (user explicitly confirms a pattern is correct).
   * Immediately sets to 'verified' — highest tier.
   */
  applyConfirmation(pattern) {
    return {
      ...pattern,
      confidence: 'verified',
      source: 'user_confirmed',
      confirmedAt: new Date().toISOString(),
    };
  }

  /**
   * Increment usage count on a pattern.
   */
  incrementUsage(pattern) {
    return {
      ...pattern,
      buildCount: (pattern.buildCount || 0) + 1,
      lastUsed: new Date().toISOString(),
    };
  }
}

module.exports = { PatternMatcher, CONFIRMED_THRESHOLD, VERIFIED_THRESHOLD };
