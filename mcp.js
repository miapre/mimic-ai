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
const { recordBuildLimitHit } = require('./src/utils/build-limit');
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
 * Resolve the canonical knowledge store path.
 *
 * Previously this was `path.join(process.cwd(), 'ds-knowledge.json')` — since
 * cwd depends entirely on how the MCP client launches the server, learning
 * silently fragmented into a different file per working directory. The
 * canonical location is now `~/.mimic-ai/ds-knowledge.json`, stable
 * regardless of launch cwd.
 *
 * MIMIC_KNOWLEDGE_PATH overrides this if set (e.g. for tests, or a user who
 * wants the store somewhere else deliberately).
 */
function resolveKnowledgeStorePath() {
  if (process.env.MIMIC_KNOWLEDGE_PATH) return process.env.MIMIC_KNOWLEDGE_PATH;
  return path.join(os.homedir(), '.mimic-ai', 'ds-knowledge.json');
}

/**
 * One-time migration: if the canonical knowledge store doesn't exist yet,
 * check legacy locations — cwd/ds-knowledge.json (the old default), then
 * ~/ds-knowledge.json (a path some workarounds referenced but the code never
 * actually used) — and copy the first one found to the canonical path. The
 * original file is left in place (never deleted — it's the user's data).
 *
 * Returns a human-readable migration note, or null if nothing needed migrating.
 */
function migrateKnowledgeStoreIfNeeded(canonicalPath) {
  if (fs.existsSync(canonicalPath)) return null;

  const legacyCandidates = [
    path.join(process.cwd(), 'ds-knowledge.json'),
    path.join(os.homedir(), 'ds-knowledge.json'),
  ];

  for (const legacyPath of legacyCandidates) {
    if (path.resolve(legacyPath) === path.resolve(canonicalPath)) continue;
    try {
      if (!fs.existsSync(legacyPath)) continue;
      const canonicalDir = path.dirname(canonicalPath);
      if (!fs.existsSync(canonicalDir)) fs.mkdirSync(canonicalDir, { recursive: true });
      fs.copyFileSync(legacyPath, canonicalPath);
      return `Migrated knowledge store from ${legacyPath} to ${canonicalPath} (original left in place).`;
    } catch {
      // Best-effort migration — try the next candidate.
    }
  }
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

/**
 * Single source of truth for session shape (B8 fix).
 *
 * Every key the codebase reads or writes on `session` — verified by
 * grepping `session\.` across src/ and mcp.js — is defined here with its
 * zero-state initial value. resetSession() and resetBuildState() below
 * both derive the "fresh" session from this factory instead of hand-listing
 * keys to clear, so a key that's added to the session shape but forgotten
 * in a reset function is no longer possible — it either exists here (and
 * gets reset) or the session never had it in the first place.
 */
function createSession() {
  return {
    // Core build-protocol state
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
    // Plugin disconnect during active build — blocks all build tools until mimic_status is called
    buildInterrupted: false,
    // Variable category mismatches — accumulated during Phase 3 for the build report
    categoryMismatches: [],
    // Failure signals — accumulated during build for no-good compilation
    _signals: new Map(),

    // Community library check state (DS discovery flow)
    pendingCommunityCheck: false,
    discoveryFileKey: null,
    discoveredLibraries: null,
    discoveryResults: null,
    completenessWarnings: null,

    // Library selection (B8: previously missing from resetSession, so a
    // file switch left the PREVIOUS file's library selection in place)
    selectedLibraryKey: null,
    pendingExternalVariables: false,
    externalVariablesLibraryKey: null,
    communityLibraryVariableKeys: null,
    // Name-keyed libraries this session has already confirmed identity for
    // (schema v3 §3.2 drift check) — avoids re-prompting every discovery
    // call within the same session once the user has answered once.
    identityDriftConfirmedFor: null,

    // Component mapping cache (mimic_map_components) + expected style count
    componentMap: null,
    expectedStyleCount: null,

    // Classified DS fingerprint diff from the most recent discovery,
    // consumed (and cleared) by the next mimic_generate_build_report to
    // build the four-block DS Changes section (spec §4.5).
    lastDsChangesReport: null,

    // Per-build execution caches (B8: previously missing from resetSession —
    // these leaked across file switches, and, before the B7 fix below, across
    // builds within the same file too)
    _pendingInserts: new Map(),
    _timeoutRetries: new Map(),
    _componentInsertions: new Map(),
    _variantConfigs: new Map(),
    _nodeVariantConfigs: new Map(),
    _nodeComponentKeys: new Map(),
    _frameLayoutConfigs: new Map(),
    _textNodeStructures: new Map(),
    replaySavings: 0,

    // Server-level notice surfaced by mimic_status (knowledge store
    // migration/corruption warnings from startup). Deliberately NOT reset by
    // resetSession() or resetBuildState() — it's process-startup metadata,
    // not file- or build-scoped state. Both reset functions below carry it
    // over explicitly instead of letting it fall out of the factory reset.
    knowledgeStoreNotice: null,
  };
}

// Build session state
const session = createSession();

// Circuit breaker constants
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PHASE3_CALLS_BEFORE_CHECKPOINT = 20;
const MAX_PHASE3_CALLS_BEFORE_STOP = 300;

/**
 * B21 fix (v3.0.0 update): originally every tool in src/tools/edit.js
 * mutated the Figma document but none called requirePhase() themselves, so
 * the gate was enforced centrally here by name. The v3.0.0 consolidation
 * merged 8 of those 11 tools (figma_set_text, figma_set_node_fill,
 * figma_set_layout_sizing, figma_set_visibility, figma_set_text_style,
 * figma_set_node_position, figma_restyle_artboard, figma_move_node) plus
 * figma_select_node and figma_change_page (from inspect.js, previously
 * ungated) into `figma_update_node`, and figma_set_variable_mode +
 * figma_set_all_variable_modes into `figma_variable_modes`. Both new tools
 * now self-gate inside their handlers (edit.js calls requirePhase(2, ...)
 * directly, matching the pattern already used in components.js) so the
 * mutating ops keep the original Phase-2 requirement while
 * figma_update_node's 'select' and 'page' ops stay ungated exactly as
 * figma_select_node/figma_change_page were before the merge — a single
 * name-keyed Set can't express "gate some ops of this tool but not others."
 * figma_delete_node is unchanged — still centrally gated here, since its
 * handler still doesn't call requirePhase() itself.
 */
const EDIT_TOOLS_REQUIRE_PHASE_2 = new Set([
  'figma_delete_node',
]);

function requirePhase(minPhase, hint) {
  const { PhaseError } = require('./src/utils/errors');
  if (session.phase < minPhase) {
    throw new PhaseError(session.phase, minPhase, hint);
  }
}

/**
 * Enforce report before starting a new build session.
 * Call this only from session-starting tools (discover_ds), not from
 * individual build operations (create_frame, create_text, etc.).
 */
function requireReportIfPending() {
  if (session.buildsSinceReport > 0) {
    const err = new Error(
      `REPORT_REQUIRED: A build completed without a report. ` +
      `Call mimic_generate_build_report before starting a new build. ` +
      `The build report is mandatory after every build — ` +
      `it teaches users about DS usage, gaps, and efficiency.`
    );
    err.code = 'REPORT_REQUIRED';
    throw err;
  }
}

function advancePhase(to) {
  // Mark that a build happened (for report enforcement on next discovery)
  if (to >= 3 && session.buildsSinceReport === 0) {
    session.buildsSinceReport = 1;
  }
  session.phase = Math.max(session.phase, to);
}

/**
 * Full reset — used when the discovered fileKey changes (status.js calls
 * this before re-running discovery on a different file, mcp.js ~line 601).
 * Every DS-cached and build-scoped key goes back to its createSession()
 * zero state; only `knowledgeStoreNotice` (process-startup metadata, not
 * file state) survives.
 *
 * Implementation note (B8): this mutates `session` IN PLACE — delete every
 * existing key, then Object.assign the factory's fresh keys back in —
 * rather than reassigning `session` to a new object. Every tool module
 * destructures `const { session } = context` once at require() time, so a
 * few tool modules hold that original object by reference; replacing the
 * binding here would leave them reading a stale, never-updated session.
 * Deleting+reassigning keys (instead of a hand-picked list of `session.x =
 * ...` lines, which is what caused B8 in the first place) is what makes a
 * missed key structurally impossible: anything createSession() doesn't
 * define simply won't exist on `session` after this runs.
 */
function resetSession() {
  const carryOver = { knowledgeStoreNotice: session.knowledgeStoreNotice };
  for (const key of Object.keys(session)) delete session[key];
  Object.assign(session, createSession(), carryOver);
}

/**
 * Partial reset — used after a successful mimic_generate_build_report (see
 * the CallToolRequestSchema wrapper below, which is where this is hooked
 * in). This is the B7 fix.
 *
 * Returns the session to Phase 2 (DS discovery / library-selection state —
 * the expensive part — stays cached) while zeroing every per-build
 * accumulator, so the next build in the SAME file gets a clean slate:
 * the Phase-3 circuit-breaker checkpoint/stop limits can fire again, and
 * the next report doesn't double-count this build's tool calls, binding
 * failures, category mismatches, or text overrides.
 *
 * DS-discovery state preserved across this reset (deliberately kept out of
 * the "wipe" set): enforcementProfile, selectedLibraryKey, discoveryFileKey,
 * discoveredLibraries, discoveryResults, completenessWarnings,
 * pendingCommunityCheck, communityLibraryVariableKeys,
 * externalVariablesLibraryKey, pendingExternalVariables,
 * pendingVariableMismatchConfirmation, variableMismatchSourceLibs,
 * variableSourceConfirmed, componentMap, expectedStyleCount. These all
 * describe "what was discovered/selected for this file", not "what
 * happened during this specific build" — clearing them would force the
 * next build in the same file to redo discovery and re-map components,
 * exactly the expensive work B7 says must survive the reset.
 *
 * buildManifest (sections + artboardId) is a second per-build accumulator
 * that lives outside `session` — a plain singleton constructed below and
 * never reset anywhere else — so mimic_generate_build_report's
 * screenName/component/primitive inference (src/tools/learning.js ~140)
 * would otherwise merge the next build's sections with this build's.
 * Clearing it here keeps that inference correct for build #2 without
 * touching learning.js.
 */
function resetBuildState() {
  const preserve = {
    phase: 2,
    enforcementProfile: session.enforcementProfile,
    selectedLibraryKey: session.selectedLibraryKey,
    discoveryFileKey: session.discoveryFileKey,
    discoveredLibraries: session.discoveredLibraries,
    discoveryResults: session.discoveryResults,
    completenessWarnings: session.completenessWarnings,
    pendingCommunityCheck: session.pendingCommunityCheck,
    communityLibraryVariableKeys: session.communityLibraryVariableKeys,
    externalVariablesLibraryKey: session.externalVariablesLibraryKey,
    pendingExternalVariables: session.pendingExternalVariables,
    pendingVariableMismatchConfirmation: session.pendingVariableMismatchConfirmation,
    variableMismatchSourceLibs: session.variableMismatchSourceLibs,
    variableSourceConfirmed: session.variableSourceConfirmed,
    componentMap: session.componentMap,
    expectedStyleCount: session.expectedStyleCount,
    identityDriftConfirmedFor: session.identityDriftConfirmedFor,
    knowledgeStoreNotice: session.knowledgeStoreNotice,
  };
  for (const key of Object.keys(session)) delete session[key];
  Object.assign(session, createSession(), preserve);

  // Per-build accumulator that lives outside `session` — see doc comment above.
  buildManifest.sections = [];
  buildManifest.artboardId = null;
  buildManifest.createdAt = null;
}

// ── Tool Registry ─────────────────────────────────────────────────────
const toolRegistry = { tools: [], handlers: {}, outputSchemas: {} };

/**
 * Register an MCP tool.
 *
 * `meta` (optional, 5th arg) carries the v3.0.0 tool-surface additions:
 *   - annotations: MCP ToolAnnotations hint object (readOnlyHint,
 *     destructiveHint, idempotentHint, title, ...) — see SDK 1.29
 *     `ToolAnnotationsSchema`. Purely advisory metadata for hosts; never
 *     changes handler behavior.
 *   - outputSchema: JSON Schema (type: 'object') describing the shape of
 *     the tool's structured result. When present, the CallToolRequest
 *     handler below also returns `structuredContent` alongside the
 *     existing `content` text block (kept for backwards compatibility —
 *     see CallToolResultSchema in the SDK).
 *
 * Kept as an optional trailing param (not a breaking change to the
 * function signature) so every existing call site that doesn't need
 * annotations/outputSchema is untouched.
 */
function registerTool(name, description, inputSchema, handler, meta) {
  const tool = { name, description, inputSchema };
  if (meta && meta.annotations) tool.annotations = meta.annotations;
  if (meta && meta.outputSchema) {
    tool.outputSchema = meta.outputSchema;
    toolRegistry.outputSchemas[name] = meta.outputSchema;
  }
  toolRegistry.tools.push(tool);
  toolRegistry.handlers[name] = handler;
}

// Shared instances
// No explicit port here — the Bridge constructor already resolves
// MIMIC_BRIDGE_PORT itself (opts.port ?? (Number(process.env.MIMIC_BRIDGE_PORT)
// || 3056), see src/bridge.js). Passing `{ port: 3056 }` used to override
// that env-aware default unconditionally, silently ignoring MIMIC_BRIDGE_PORT.
const bridge = new Bridge();

// Flag active build as interrupted when plugin disconnects mid-build.
// Build tools are blocked until mimic_status clears the flag after reconnection.
bridge._onDisconnect = () => {
  if (session.phase >= 3 && session.phase < 5) {
    session.buildInterrupted = true;
  }
};
const dsCache = new DsCache();
const dsResolver = new DsResolver(dsCache);
const knowledgeStorePath = resolveKnowledgeStorePath();
const knowledgeStoreDir = path.dirname(knowledgeStorePath);
if (!fs.existsSync(knowledgeStoreDir)) {
  fs.mkdirSync(knowledgeStoreDir, { recursive: true });
}
// One-time migration from legacy locations (old cwd-based default, or the
// ~/ds-knowledge.json path some workarounds referenced) into the canonical
// path. Runs before load() so the migrated data is what actually loads.
const knowledgeStoreMigrationNote = migrateKnowledgeStoreIfNeeded(knowledgeStorePath);
const knowledgeStore = new KnowledgeStore(knowledgeStorePath);
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
  { name: 'mimic-ai', version: require('./package.json').version },
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
  requireReportIfPending,
  advancePhase,
  resetSession,
  resetBuildState,
  registerTool,
  get figmaRest() { return getFigmaRest(); },
};

// Tool registration
// NOTE (v3.0.0): src/tools/batch.js (figma_batch) was removed in the
// tool-surface consolidation — see CHANGELOG.md 3.0.0. The plugin-side
// `batch_execute` bridge handler and its tests are untouched; only the
// MCP-level tool + its registration were deleted.
require('./src/tools/status').register(server, context);
require('./src/tools/ds-setup').register(server, context);
require('./src/tools/build').register(server, context);
require('./src/tools/components').register(server, context);
require('./src/tools/edit').register(server, context);
require('./src/tools/inspect').register(server, context);
require('./src/tools/learning').register(server, context);
require('./src/tools/compliance').register(server, context);
require('./src/tools/rendering').register(server, context);
require('./src/tools/table').register(server, context);
require('./src/tools/chart').register(server, context);

// ── MCP Request Handlers ──────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolRegistry.tools,
}));

/**
 * Build a CallToolResult payload. When the tool declared an outputSchema
 * (registerTool's `meta.outputSchema`), the SDK's CallToolResultSchema
 * expects `structuredContent` to accompany `content` — see the 1.29
 * ToolSchema/CallToolResultSchema definitions in
 * node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js. `content` is
 * always populated too (kept for backwards compatibility with clients that
 * don't read structuredContent).
 */
function buildCallResult(name, payload) {
  const result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  if (toolRegistry.outputSchemas[name] && payload && typeof payload === 'object') {
    result.structuredContent = payload;
  }
  return result;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolRegistry.handlers[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool', name }) }],
    };
  }
  // These tools are always allowed, even when circuit breaker is active.
  // v3.0.0: updated for the consolidated surface — figma_inspect covers every
  // former figma_get_* read, figma_list_ds covers the list/read caches, and
  // mimic_ds_assets covers the manual discover/preload/set_defaults escape
  // hatches. mimic_generate_design_md folded into mimic_ai_knowledge_read.
  const EXEMPT_TOOLS = new Set([
    // Status & reporting
    'mimic_status', 'mimic_generate_build_report',
    // Discovery & setup (failures here shouldn't block builds)
    'mimic_discover_ds', 'mimic_map_components', 'mimic_ai_knowledge_read',
    'mimic_ds_assets',
    // Inspect & QA (read-only)
    'figma_validate_ds_compliance', 'figma_inspect', 'figma_list_ds',
  ]);

  // Build interrupt guard: plugin disconnected during an active build.
  // ALL build tools are blocked until the plugin reconnects and mimic_status is called.
  // This prevents the LLM from continuing with Mimic tools in a corrupted session state.
  if (session.buildInterrupted && !EXEMPT_TOOLS.has(name)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'BUILD_INTERRUPTED',
        message: 'The Figma plugin disconnected during an active build. This build session is paused. '
          + 'STOP ALL BUILDING — do NOT use other Figma tools (Figma MCP, use_figma, etc.) as a fallback. '
          + 'They bypass DS enforcement and produce output without components, variables, or text styles. '
          + 'The user must reconnect the plugin, then call mimic_status to resume.',
        recovery: 'Ask the user to run the Mimic AI plugin in Figma, then call mimic_status.',
        phase: session.phase,
        toolCallCount: session.toolCallCount,
      }) }],
    };
  }

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

  // Circuit breaker: max tool calls in Phase 3 before forced stop.
  // The report resets phaseToolCalls[3], so episodes are tracked cumulatively
  // (recordBuildLimitHit) to escalate on repeats instead of granting a free
  // reset every time the cap is re-hit.
  if (session.phase === 3 && session.phaseToolCalls[3] >= MAX_PHASE3_CALLS_BEFORE_STOP && !EXEMPT_TOOLS.has(name)) {
    const limit = recordBuildLimitHit(session, MAX_PHASE3_CALLS_BEFORE_STOP);
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: limit.error,
        buildLimitHits: limit.buildLimitHits,
        message: limit.message,
        toolCallCount: session.toolCallCount,
        phaseToolCalls: session.phaseToolCalls[3],
      }) }],
    };
  }

  try {
    // B21: edit.js tools have no built-in phase gate. Enforce it centrally
    // here by name — throwing routes through the same catch block below as
    // every other requirePhase() call (PhaseError shape, consecutiveFailures
    // bookkeeping), so it behaves identically to a tool that checked its own
    // phase internally.
    if (EDIT_TOOLS_REQUIRE_PHASE_2.has(name)) {
      requirePhase(2, 'Edit tools modify existing nodes and validate against the cached DS — '
        + 'call mimic_discover_ds (and reach Phase 2) before editing.');
    }

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
      // Emit signals for no-good compilation
      for (const varPath of failedBindings) {
        session._signals.set(`binding_failure:${varPath}`, {
          type: 'binding_failure', key: varPath, context: `${name}: ${varPath} not found`,
        });
      }
    }

    // Track category mismatches for the build report
    if (result && typeof result === 'object' && result._categoryWarnings) {
      session.categoryMismatches.push(...result._categoryWarnings);
      // Emit signals for no-good compilation FROM STRUCTURED DATA (fixes
      // defect M / acceptance 27) — dsCache.validateVariables emits
      // `categoryMismatchDetails` ({ path, actualCategory, expectedCategory })
      // alongside the human-readable warning string. Consuming that
      // structured field means a wording change to the warning message can
      // never silently break signal emission (the old code regexed the
      // prose string to reconstruct this same data).
      if (Array.isArray(result._categoryMismatchDetails)) {
        for (const detail of result._categoryMismatchDetails) {
          const signalKey = `${detail.path}->${detail.expectedCategory}`;
          session._signals.set(`category_mismatch:${signalKey}`, {
            type: 'category_mismatch',
            key: signalKey,
            context: `${detail.field}: '${detail.path}' (${detail.actualCategory}) used for ${detail.expectedCategory}`,
          });
        }
      }
    }

    // B7 fix: a successful mimic_generate_build_report returns the session to
    // Phase 2 (DS discovery/library-selection state preserved — that's the
    // expensive part) and zeroes every per-build accumulator. Without this,
    // the second build in the same file stayed at Phase 5 forever: the
    // Phase-3 checkpoint/stop limits could never fire again, report
    // reminders never re-injected, and bindingFailures/componentTextTracker/
    // categoryMismatches/phaseToolCalls kept accumulating so the next report
    // double-counted this build's data.
    //
    // Mechanism: learning.js (a different worker's file) already signals
    // report completion by calling advancePhase(5) and clearing
    // buildsSinceReport inside its own handler — it does not (and does not
    // need to) know about resetBuildState(). Detecting the successful call
    // by tool name here, in this wrapper, means the reset lives entirely in
    // mcp.js with zero changes to learning.js.
    if (name === 'mimic_generate_build_report') {
      resetBuildState();
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
      return buildCallResult(name, merged);
    }

    // Inject report reminder sparingly — every 10th build op or on status checks
    const buildOps = session.phaseToolCalls[3] || 0;
    if (session.phase >= 3 && session.phase < 5 && buildOps > 0 && typeof result === 'object' && result !== null) {
      if (name === 'mimic_status' || buildOps % 10 === 0) {
        result._reportReminder = 'When the build is done, you MUST call mimic_generate_build_report before responding to the user.';
      }
    }

    return buildCallResult(name, result);
  } catch (err) {
    const { isInfraError } = require('./src/utils/errors');
    const infraFailure = isInfraError(err);

    // Only count USER errors toward circuit breaker (wrong params, phase errors, bad variable paths).
    // Infra failures (bridge timeout, parent node disappeared, plugin disconnected) are NOT the
    // user's fault — reset the counter and warn with retry guidance instead of punishing.
    if (!EXEMPT_TOOLS.has(name)) {
      if (infraFailure) {
        session.consecutiveFailures = 0; // reset — don't punish for infra problems
      } else {
        session.consecutiveFailures++;
      }
    }
    session.phaseToolCalls[session.phase] = (session.phaseToolCalls[session.phase] || 0) + 1;

    const errorPayload = err.toJSON ? err.toJSON() : { error: err.message };

    // Surface plugin error details (available options, recovery hints)
    if (err.pluginError && typeof err.pluginError === 'object') {
      if (err.pluginError.available) errorPayload.available = err.pluginError.available;
      if (err.pluginError.recovery) errorPayload.recovery = err.pluginError.recovery;
      if (err.pluginError.property) errorPayload.property = err.pluginError.property;
    }

    // Plugin disconnect during active build: set interrupt flag
    const isDisconnect = /PLUGIN_DISCONNECTED/i.test(err.message);
    if (isDisconnect && session.phase >= 3 && session.phase < 5) {
      session.buildInterrupted = true;
    }

    // Infra failures: add recovery guidance instead of circuit breaker warnings
    if (infraFailure) {
      errorPayload._infraFailure = {
        classified: true,
        message: isDisconnect
          ? 'PLUGIN DISCONNECTED during active build. STOP ALL BUILDING. '
            + 'Do NOT use other Figma tools (Figma MCP, use_figma, etc.) as a fallback — '
            + 'they bypass DS enforcement and produce output without components, variables, or text styles. '
            + 'Tell the user the plugin disconnected. After reconnection, call mimic_status to resume.'
          : 'This is an infrastructure failure (plugin/bridge), not a user error. '
            + 'The circuit breaker counter has been reset. '
            + 'Retry the operation, or if the plugin is disconnected, ask the user to restart it.',
        suggestion: isDisconnect
          ? 'STOP. Ask the user to reconnect the Figma plugin. Then call mimic_status to resume the build.'
          : /Bridge timeout/i.test(err.message)
            ? 'Bridge timed out — the plugin may be busy or disconnected. Wait a moment and retry.'
            : /Parent node not found/i.test(err.message) || /Parent node not found/i.test(err.pluginError?.message || '')
              ? 'Parent node disappeared — this is a plugin state issue. Verify the parent still exists with figma_inspect (target: "children") on its container, then retry.'
            : /plugin disconnected/i.test(err.message)
              ? 'Plugin disconnected — ask the user to restart the Figma plugin, then retry.'
              : 'Infrastructure error detected. Retry or check plugin status.',
      };
    }

    // Add failure context for user errors approaching circuit breaker
    if (!infraFailure && session.consecutiveFailures >= 2) {
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
  // Connect the MCP transport FIRST so the tools always register, even if the
  // bridge can't come up. A bridge problem must never leave a Claude session
  // with zero Mimic tools — it surfaces at call time with a clear message
  // instead of the whole server silently failing to start.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Load knowledge store if it exists. load() never throws — a corrupt file
  // or unsupported schema version is backed up and replaced with a fresh
  // store instead of preventing the server from connecting (see store.js).
  knowledgeStore.load();

  // Surface knowledge-store startup notices loudly. These aren't fatal, but
  // they mean learning silently reset or moved — the user should know.
  // Stashed on `session` too so a future mimic_status update can surface
  // them in-band, the same way session.buildInterrupted does today.
  if (knowledgeStoreMigrationNote) {
    console.error(`[mimic-ai] ${knowledgeStoreMigrationNote}`);
    session.knowledgeStoreNotice = knowledgeStoreMigrationNote;
  }
  if (knowledgeStore.loadWarning) {
    console.error(`[mimic-ai] ${knowledgeStore.loadWarning.message}`);
    session.knowledgeStoreNotice = knowledgeStore.loadWarning.message;
  }

  // Bring up the bridge. Not fatal: start() attaches to an already-running
  // Mimic bridge when the port is taken (this session then proxies build
  // operations through it), so a second Claude session still gets a working
  // Mimic. Any other failure is logged and the tools keep working degraded.
  try {
    await bridge.start();
  } catch (err) {
    console.error(`[mimic-ai] Bridge unavailable: ${err.message}`);
  }
}

// Only auto-start when run directly (`node mcp.js` / the `mimic-ai` bin entry),
// not when required by tests — requiring this module registers tools and
// constructs shared instances (harmless), but must not open the bridge port
// or attempt a stdio connection as a side effect of `require()`.
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  server,
  context,
  createSession,
  resolveKnowledgeStorePath,
  migrateKnowledgeStoreIfNeeded,
};
