'use strict';

const ESTIMATED_CALLS_PER_PRIMITIVE = 7;

class GapTracker {
  /**
   * Record a gap where a DS component was missing and a primitive was used.
   * @param {string} name - Component name (e.g. 'tab-component')
   * @param {object} opts
   * @param {string[]} opts.searchTerms - Terms tried during DS search
   * @param {string[]} opts.elements - HTML elements that triggered this gap
   * @param {string} [opts.evidence] - How it was resolved
   * @returns {object} Gap record ready for KnowledgeStore.addGap()
   */
  recordPrimitive(name, { searchTerms = [], elements = [], evidence = 'Built as primitive' } = {}) {
    return {
      name,
      evidence,
      elements,
      searchTerms,
      estimatedSavings: this.estimateSavings(elements.length || 1),
      recordedAt: new Date().toISOString(),
    };
  }

  /**
   * Estimate tool-call savings if a DS component existed.
   * ~7 calls saved per instance (search + create frame + add children + style each).
   * @param {number} instanceCount - Number of times this gap appeared in a build
   * @returns {{ toolCalls: number, instanceCount: number }}
   */
  estimateSavings(instanceCount = 1) {
    return {
      toolCalls: instanceCount * ESTIMATED_CALLS_PER_PRIMITIVE,
      instanceCount,
    };
  }

  /**
   * Generate formatted recommendations from a gaps object.
   * @param {object} gaps - The gaps collection from KnowledgeStore
   * @returns {Array<{ name: string, priority: string, savings: number, elements: string[], evidence: string }>}
   */
  generateRecommendations(gaps) {
    const entries = Object.entries(gaps);
    if (entries.length === 0) return [];

    return entries
      .map(([name, gap]) => {
        const savings = gap.estimatedSavings?.toolCalls || ESTIMATED_CALLS_PER_PRIMITIVE;
        const elementCount = gap.elements?.length || 0;
        const priority = elementCount >= 3 ? 'high' : elementCount >= 2 ? 'medium' : 'low';

        return {
          name,
          priority,
          savings,
          elements: gap.elements || [],
          evidence: gap.evidence || 'Unknown',
        };
      })
      .sort((a, b) => b.savings - a.savings);
  }
}

module.exports = { GapTracker, ESTIMATED_CALLS_PER_PRIMITIVE };
