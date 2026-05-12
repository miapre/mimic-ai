'use strict';

/**
 * Merges plugin binding feedback into the MCP tool response.
 * If the plugin reports any bindingFailures, elevates them to a visible warning.
 */
function surfaceBindingFeedback(result, toolName) {
  if (!result || !result.bindingFailures) return result;
  const failedBindings = Object.entries(result.applied || {})
    .filter(([, ok]) => ok === false)
    .map(([name]) => name);
  if (failedBindings.length > 0) {
    result._bindingWarning = `⚠ ${failedBindings.length} DS binding(s) FAILED on ${toolName}: ${failedBindings.join(', ')}. Check variable paths against figma_read_variable_values.`;
  }
  return result;
}

module.exports = { surfaceBindingFeedback };
