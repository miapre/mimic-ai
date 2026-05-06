'use strict';

const PROMOTION_THRESHOLD = 3;

class PatternMatcher {
  /**
   * Auto-promote a pattern to 'strong' after PROMOTION_THRESHOLD uncorrected builds.
   * Returns the (possibly promoted) pattern — does NOT mutate the original.
   */
  maybePromote(pattern) {
    const result = { ...pattern };
    if (result.buildCount >= PROMOTION_THRESHOLD && result.confidence === 'new') {
      result.confidence = 'strong';
      result.source = 'auto_promoted';
      result.promotedAt = new Date().toISOString();
    }
    return result;
  }

  /**
   * Apply a user correction — immediately sets confidence to 'strong'.
   */
  applyCorrection(pattern, source = 'user_correction') {
    return {
      ...pattern,
      confidence: 'strong',
      source,
      correctedAt: new Date().toISOString(),
    };
  }

  /**
   * Apply a confirmation (user explicitly confirms a pattern is correct).
   */
  applyConfirmation(pattern) {
    return {
      ...pattern,
      confidence: 'strong',
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

module.exports = { PatternMatcher, PROMOTION_THRESHOLD };
