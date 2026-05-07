#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Bridge } = require('./src/bridge');
const { DsCache } = require('./src/ds/cache');
const { DsResolver } = require('./src/ds/resolver');
const { KnowledgeStore } = require('./src/knowledge/store');
const { BuildManifest } = require('./src/knowledge/manifest');
const path = require('node:path');

// Build session state
const session = {
  phase: 0,      // 0=idle, 1=discovery, 2=inventory, 3=build, 4=qa, 5=report
  artboardId: null,
  enforcementProfile: null,
  toolCallCount: 0,
  cacheHits: 0,
};

function requirePhase(minPhase, hint) {
  const { PhaseError } = require('./src/utils/errors');
  if (session.phase < minPhase) {
    throw new PhaseError(session.phase, minPhase, hint);
  }
}

function advancePhase(to) {
  session.phase = Math.max(session.phase, to);
}

function resetSession() {
  session.phase = 0;
  session.artboardId = null;
  session.enforcementProfile = null;
  session.toolCallCount = 0;
  session.cacheHits = 0;
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
  try {
    const result = await handler(args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify(err.toJSON ? err.toJSON() : { error: err.message }) }],
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
