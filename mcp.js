#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Bridge } = require('./src/bridge');
const { DsCache } = require('./src/ds/cache');
const { DsResolver } = require('./src/ds/resolver');
const { KnowledgeStore } = require('./src/knowledge/store');
const { BuildManifest } = require('./src/knowledge/manifest');
const { FigmaRest } = require('./src/figma-rest');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

/**
 * Resolve FIGMA_TOKEN from multiple sources (first match wins):
 * 1. ~/.mimic-ai.json  { "figmaToken": "figd_..." }  — hot-reloadable
 * 2. process.env.FIGMA_TOKEN (standard MCP env config) — set at spawn time
 * 3. null (server starts without REST API — discovery prompts setup)
 *
 * Config file wins over env var so token updates take effect without
 * restarting the MCP server process.
 */
function resolveFigmaToken() {
  try {
    const configPath = path.join(os.homedir(), '.mimic-ai.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg.figmaToken) return cfg.figmaToken;
  } catch { /* file doesn't exist or is invalid — fall through to env */ }
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN;
  return null;
}

/**
 * MCP clients (including Claude Code) may deliver array/object tool arguments
 * as JSON-encoded strings instead of parsed values. This function walks the
 * args object and parses any string that looks like JSON array/object.
 */
function deepCoerceArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  for (const key of Object.keys(out)) {
    const val = out[key];
    if (typeof val === 'string') {
      // Try to parse JSON arrays and objects
      if ((val.startsWith('[') && val.endsWith(']')) || (val.startsWith('{') && val.endsWith('}'))) {
        try { out[key] = JSON.parse(val); } catch { /* keep as string */ }
      }
      // Coerce boolean strings
      else if (val === 'true') out[key] = true;
      else if (val === 'false') out[key] = false;
    }
  }
  return out;
}

// Build session state
const session = {
  phase: 0,      // 0=idle, 1=discovery, 2=inventory, 3=build, 4=qa, 5=report
  artboardId: null,
  enforcementProfile: null,
  toolCallCount: 0,
  cacheHits: 0,
  // Circuit breaker state
  consecutiveFailures: 0,
  phaseToolCalls: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  checkpointIssued: false,
  // Binding failure tracking — accumulated during Phase 3 for the build report
  bindingFailures: [],
  // Text override tracking — per component instance, tracks expected vs overridden text nodes
  // Key: component nodeId → { name, expected: [{nodeId, name, defaultText}], overridden: Set<nodeId|name> }
  componentTextTracker: new Map(),
  // Variable source mismatch confirmation state
  pendingVariableMismatchConfirmation: false,
  variableMismatchSourceLibs: null,
  variableSourceConfirmed: null,
  // Report enforcement — blocks new builds until report is generated
  buildsSinceReport: 0,
};

// Circuit breaker constants
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PHASE3_CALLS_BEFORE_CHECKPOINT = 20;
const MAX_PHASE3_CALLS_BEFORE_STOP = 300;

function requirePhase(minPhase, hint) {
  const { PhaseError } = require('./src/utils/errors');
  if (session.phase < minPhase) {
    throw new PhaseError(session.phase, minPhase, hint);
  }
  // Enforce report before next build: if builds happened since last report, block new build tools
  if (session.buildsSinceReport > 0 && minPhase >= 2) {
    const err = new Error(
      `REPORT_REQUIRED: ${session.buildsSinceReport} build operation(s) completed without a report. ` +
      `Call mimic_generate_build_report before continuing. The build report is mandatory after every build — ` +
      `it teaches users about DS usage, gaps, and efficiency.`
    );
    err.code = 'REPORT_REQUIRED';
    throw err;
  }
}

function advancePhase(to) {
  if (to >= 3 && session.phase < 3) {
    session.buildsSinceReport++;
  }
  session.phase = Math.max(session.phase, to);
}

function resetSession() {
  session.phase = 0;
  session.artboardId = null;
  session.enforcementProfile = null;
  session.toolCallCount = 0;
  session.cacheHits = 0;
  session.consecutiveFailures = 0;
  session.phaseToolCalls = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  session.checkpointIssued = false;
  session.bindingFailures = [];
  session.componentTextTracker = new Map();
  session.buildsSinceReport = 0;
  // Community library check state
  session.pendingCommunityCheck = false;
  session.discoveryFileKey = null;
  session.discoveredLibraries = null;
  session.discoveryResults = null;
  session.completenessWarnings = null;
  // Variable source mismatch state
  session.pendingVariableMismatchConfirmation = false;
  session.variableMismatchSourceLibs = null;
  session.variableSourceConfirmed = null;
}

// ── Tool Registry ─────────────────────────────────────────────────────
const toolRegistry = { tools: [], handlers: {} };

function registerTool(name, description, inputSchema, handler) {
  toolRegistry.tools.push({ name, description, inputSchema });
  toolRegistry.handlers[name] = handler;
}

// Shared instances
const bridge = new Bridge({ port: 3056 });
const dsCache = new DsCache();
const dsResolver = new DsResolver(dsCache);
const knowledgeStore = new KnowledgeStore(
  path.join(process.cwd(), 'ds-knowledge.json')
);
const buildManifest = new BuildManifest();
// Lazy-resolved on each discovery call — re-reads config file so token
// updates take effect without restarting the MCP server process.
let _figmaRest = null;
let _lastToken = null;
function getFigmaRest() {
  const token = resolveFigmaToken();
  if (!token) return null;
  if (token !== _lastToken) {
    _figmaRest = new FigmaRest(token);
    _lastToken = token;
  }
  return _figmaRest;
}
// Backwards compat for code that references figmaRest directly
const figmaRest = null; // use getFigmaRest() instead

// MCP Server
const server = new Server(
  { name: 'mimic-ai', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

// Context object passed to all tool registration functions
const context = {
  bridge,
  dsCache,
  dsResolver,
  knowledgeStore,
  buildManifest,
  session,
  requirePhase,
  advancePhase,
  resetSession,
  registerTool,
  get figmaRest() { return getFigmaRest(); },
};

// Tool registration
require('./src/tools/status').register(server, context);
require('./src/tools/ds-setup').register(server, context);
require('./src/tools/build').register(server, context);
require('./src/tools/components').register(server, context);
require('./src/tools/edit').register(server, context);
require('./src/tools/inspect').register(server, context);
require('./src/tools/batch').register(server, context);
require('./src/tools/learning').register(server, context);
require('./src/tools/compliance').register(server, context);
require('./src/tools/rendering').register(server, context);
require('./src/tools/table').register(server, context);
require('./src/tools/chart').register(server, context);

// ── MCP Request Handlers ──────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolRegistry.tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolRegistry.handlers[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool', name }) }],
    };
  }
  // These tools are always allowed, even when circuit breaker is active
  const EXEMPT_TOOLS = new Set([
    // Status & reporting
    'mimic_status', 'mimic_generate_build_report', 'mimic_generate_design_md',
    // Discovery & setup (failures here shouldn't block builds)
    'mimic_discover_ds', 'mimic_map_components', 'mimic_ai_knowledge_read',
    'figma_discover_library_styles', 'figma_discover_library_variables',
    'figma_discover_library_components',
    'figma_preload_styles', 'figma_preload_variables', 'figma_set_session_defaults',
    // Inspect & QA
    'figma_validate_ds_compliance', 'figma_get_node_props', 'figma_get_node_children',
    'figma_get_node_parent', 'figma_get_page_nodes', 'figma_get_pages',
    'figma_get_selection', 'figma_get_text_info', 'figma_get_component_variants',
    'figma_read_variable_values', 'figma_list_text_styles',
  ]);

  // Circuit breaker: check if too many consecutive failures
  if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !EXEMPT_TOOLS.has(name)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'CIRCUIT_BREAKER',
        consecutiveFailures: session.consecutiveFailures,
        message: `${session.consecutiveFailures} consecutive tool calls have failed. Stop building and generate the report with mimic_generate_build_report. Do not attempt more fixes — investigate the pattern of failures first.`,
        recentPhase: session.phase,
        toolCallCount: session.toolCallCount,
      }) }],
    };
  }

  // Circuit breaker: max tool calls in Phase 3 before forced stop
  if (session.phase === 3 && session.phaseToolCalls[3] >= MAX_PHASE3_CALLS_BEFORE_STOP && !EXEMPT_TOOLS.has(name)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'BUILD_LIMIT_REACHED',
        message: `${MAX_PHASE3_CALLS_BEFORE_STOP} tool calls in build phase. This build is too large or stuck. Generate the report with mimic_generate_build_report and assess what was built so far.`,
        toolCallCount: session.toolCallCount,
        phaseToolCalls: session.phaseToolCalls[3],
      }) }],
    };
  }

  try {
    const result = await handler(deepCoerceArgs(args || {}));

    // Success: reset consecutive failure counter, increment phase counter
    session.consecutiveFailures = 0;
    session.phaseToolCalls[session.phase] = (session.phaseToolCalls[session.phase] || 0) + 1;

    // Track binding failures at session level for the build report
    if (result && typeof result === 'object' && result.bindingFailures) {
      const failedBindings = Object.entries(result.applied || {})
        .filter(([, ok]) => ok === false)
        .map(([k]) => k);
      session.bindingFailures.push({
        tool: name,
        nodeId: result.nodeId || null,
        nodeName: result.name || null,
        failedBindings,
        warnings: result.warnings || [],
      });
    }

    // Phase 3 checkpoint: after N build operations, insert a progress summary
    if (session.phase === 3
        && session.phaseToolCalls[3] === MAX_PHASE3_CALLS_BEFORE_CHECKPOINT
        && !session.checkpointIssued) {
      session.checkpointIssued = true;
      const checkpoint = {
        checkpoint: true,
        buildOpsCompleted: session.phaseToolCalls[3],
        message: `${MAX_PHASE3_CALLS_BEFORE_CHECKPOINT} build operations completed. Take a screenshot or call figma_validate_ds_compliance to verify progress before continuing. Fix any issues now — they compound if left until the end.`,
        cachedState: {
          textStyles: dsCache.textStyles.size,
          variables: dsCache.variables.size,
          components: dsCache.components.size,
          failedKeys: dsCache.failedKeys.size,
          libraryFontIncompatible: dsCache.libraryFontIncompatible,
        },
      };
      // Merge checkpoint into result
      const merged = typeof result === 'object' && result !== null
        ? { ...result, _checkpoint: checkpoint }
        : { result, _checkpoint: checkpoint };
      return {
        content: [{ type: 'text', text: JSON.stringify(merged) }],
      };
    }

    // Inject report reminder sparingly — every 10th build op or on status checks
    const buildOps = session.phaseToolCalls[3] || 0;
    if (session.phase >= 3 && session.phase < 5 && buildOps > 0 && typeof result === 'object' && result !== null) {
      if (name === 'mimic_status' || buildOps % 10 === 0) {
        result._reportReminder = 'When the build is done, you MUST call mimic_generate_build_report before responding to the user.';
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    // Only count failures toward circuit breaker for non-exempt tools
    if (!EXEMPT_TOOLS.has(name)) {
      session.consecutiveFailures++;
    }
    session.phaseToolCalls[session.phase] = (session.phaseToolCalls[session.phase] || 0) + 1;

    const errorPayload = err.toJSON ? err.toJSON() : { error: err.message };

    // Surface plugin error details (available options, recovery hints)
    if (err.pluginError && typeof err.pluginError === 'object') {
      if (err.pluginError.available) errorPayload.available = err.pluginError.available;
      if (err.pluginError.recovery) errorPayload.recovery = err.pluginError.recovery;
      if (err.pluginError.property) errorPayload.property = err.pluginError.property;
    }

    // Add failure context to help Claude understand the pattern
    if (session.consecutiveFailures >= 2) {
      errorPayload._failureContext = {
        consecutiveFailures: session.consecutiveFailures,
        warning: session.consecutiveFailures === 2
          ? 'Two consecutive failures. If the next call also fails, the circuit breaker will activate. Verify your parameters against cached DS values before retrying.'
          : `${session.consecutiveFailures} consecutive failures. Circuit breaker will activate.`,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
    };
  }
});

async function main() {
  // Start bridge (auto-starts, invisible to user)
  await bridge.start();

  // Load knowledge store if it exists
  knowledgeStore.load();

  // Connect MCP
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

module.exports = { server, context };
