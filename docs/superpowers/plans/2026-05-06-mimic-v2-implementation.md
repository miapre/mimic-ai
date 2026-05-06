# Mimic AI v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Mimic AI v2 from scratch — an MCP server + Figma plugin that translates HTML into Figma using the user's design system, with a learning loop and DS copilot features.

**Architecture:** Smart MCP server (Node.js) + thin Figma plugin (enforcement gate) + embedded WebSocket bridge. ~20 source files, each with one responsibility. Full spec: `docs/superpowers/specs/2026-05-06-mimic-v2-design.md`

**Tech Stack:** Node.js 20.6+, MCP SDK (`@modelcontextprotocol/sdk`), WebSocket (`ws`), Figma Plugin API, Puppeteer (optional, for URL rendering)

---

## File Structure

```
mcp.js                          — Entry point, MCP protocol, tool registry, phase tracking
package.json                    — Package identity (@miapre/mimic-ai)
src/
  bridge.js                     — Embedded HTTP/WS bridge with keepalive + auto-reconnect
  tools/
    status.js                   — mimic_status, mimic_discover_ds
    ds-setup.js                 — preload_styles, preload_variables, session_defaults, list_text_styles
    build.js                    — create_frame, create_text, create_rectangle, create_ellipse, create_svg
    components.js               — insert_component, set_component_text, set_variant
    edit.js                     — set_text, set_node_fill, set_layout_sizing, set_visibility, set_variable_mode, move_node, delete_node
    inspect.js                  — get_node_props, get_node_children, get_pages, change_page, get_page_nodes, get_component_variants
    learning.js                 — knowledge_read, knowledge_write, generate_build_report
    batch.js                    — figma_batch
  ds/
    cache.js                    — DS variable/style cache
    resolver.js                 — Variable path resolution, fuzzy matching
    discovery.js                — Library enumeration, component search
  knowledge/
    store.js                    — ds-knowledge.json read/write
    patterns.js                 — Pattern matching, confidence promotion
    gaps.js                     — Gap tracking, recommendation generation
  charts/
    calculator.js               — Chart geometry engine (all math in Node.js)
  utils/
    html-parser.js              — HTML analysis, view detection
    figma-types.js              — CSS → Figma mapping constants
    errors.js                   — Structured error types with recovery paths
plugin/
  code.js                       — Figma plugin: thin handlers + DS enforcement gate
  manifest.json                 — Already exists
  ui.html                       — Already exists (WebSocket relay)
tests/
  charts/calculator.test.js     — Chart math tests
  ds/cache.test.js              — DS cache tests
  ds/resolver.test.js           — Variable resolution tests
  knowledge/store.test.js       — Knowledge store tests
  knowledge/patterns.test.js    — Pattern matching tests
  bridge.test.js                — Bridge connection tests
  tools/build.test.js           — Build tool parameter validation
```

---

## Task 1: Project Scaffolding and Package Setup

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `CLAUDE.md`
- Create: `README.md` (minimal — will be expanded later)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@miapre/mimic-ai",
  "version": "2.0.0-alpha.1",
  "description": "Mimic AI: MCP server that translates HTML into Figma using your design system",
  "main": "mcp.js",
  "bin": {
    "mimic-ai": "mcp.js"
  },
  "scripts": {
    "start": "node mcp.js",
    "bridge": "node -e \"require('./src/bridge').startStandalone()\"",
    "test": "node --test tests/**/*.test.js"
  },
  "keywords": ["mcp", "figma", "design-system", "html-to-figma"],
  "author": "miapre",
  "license": "MIT",
  "engines": {
    "node": ">=20.6.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "ws": "^8.0.0"
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
ds-knowledge.json
mimic/
internal/builds/
internal/diagnostics/
*.log
.DS_Store
```

- [ ] **Step 3: Create minimal CLAUDE.md**

Use the exact content from spec Section 8 (the ~40 line version).

- [ ] **Step 4: Create minimal README.md**

```markdown
# Mimic AI

The design system copilot that builds Figma screens from HTML, and gets better every time you use it.

> v2 — in development

## Setup

Coming soon.
```

- [ ] **Step 5: Run npm install**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 6: Create directory structure**

```bash
mkdir -p src/tools src/ds src/knowledge src/charts src/utils tests/charts tests/ds tests/knowledge tests/tools
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore CLAUDE.md README.md
git commit -m "feat: project scaffolding — package.json, CLAUDE.md, directory structure"
```

---

## Task 2: Error Types and Utilities

**Files:**
- Create: `src/utils/errors.js`
- Create: `src/utils/figma-types.js`
- Test: `tests/utils/errors.test.js`

These are the foundation everything else imports. No dependencies on other project files.

- [ ] **Step 1: Write failing test for error types**

```javascript
// tests/utils/errors.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DsRequired, PluginError, PhaseError, BridgeError } = require('../../src/utils/errors');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/utils/errors.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement error types**

```javascript
// src/utils/errors.js

class MimicError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }

  toJSON() {
    return { error: this.error, message: this.message, ...this.details() };
  }

  details() { return {}; }
}

class DsRequired extends MimicError {
  constructor(property, available, recovery) {
    super(`DS token required for ${property}`);
    this.error = 'DS_REQUIRED';
    this.property = property;
    this.available = available;
    this.recovery = recovery;
  }

  details() {
    return { property: this.property, available: this.available, recovery: this.recovery };
  }
}

class PhaseError extends MimicError {
  constructor(attemptedPhase, requiredPhase, hint) {
    super(`Phase ${attemptedPhase} blocked — ${hint}`);
    this.error = 'PHASE_REQUIRED';
    this.currentPhase = attemptedPhase;
    this.requiredPhase = requiredPhase;
  }

  details() {
    return { currentPhase: this.currentPhase, requiredPhase: this.requiredPhase };
  }
}

class PluginError extends MimicError {
  constructor(operation, reason) {
    super(`Plugin: ${operation} failed — ${reason}`);
    this.error = 'PLUGIN_ERROR';
    this.operation = operation;
  }

  details() { return { operation: this.operation }; }
}

class BridgeError extends MimicError {
  constructor(reason) {
    super(`Bridge: ${reason}`);
    this.error = 'BRIDGE_ERROR';
  }
}

module.exports = { MimicError, DsRequired, PhaseError, PluginError, BridgeError };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/utils/errors.test.js`
Expected: PASS

- [ ] **Step 5: Create figma-types.js**

```javascript
// src/utils/figma-types.js
// CSS → Figma property mapping constants (from spec Section 10)

const CSS_TO_FIGMA_DIRECTION = {
  'row': 'HORIZONTAL',
  'column': 'VERTICAL',
};

const CSS_TO_FIGMA_JUSTIFY = {
  'center': 'CENTER',
  'space-between': 'SPACE_BETWEEN',
  'flex-start': 'MIN',
  'flex-end': 'MAX',
};

const CSS_TO_FIGMA_ALIGN = {
  'center': 'CENTER',
  'flex-start': 'MIN',
  'flex-end': 'MAX',
  'stretch': 'STRETCH',
};

const ARTBOARD_WIDTH = 1440;
const CONTENT_MAX_WIDTH = 1280;
const ARTBOARD_GAP = 80;

module.exports = {
  CSS_TO_FIGMA_DIRECTION,
  CSS_TO_FIGMA_JUSTIFY,
  CSS_TO_FIGMA_ALIGN,
  ARTBOARD_WIDTH,
  CONTENT_MAX_WIDTH,
  ARTBOARD_GAP,
};
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/ tests/utils/
git commit -m "feat: error types with recovery paths + CSS-to-Figma mapping constants"
```

---

## Task 3: DS Cache and Variable Resolver

**Files:**
- Create: `src/ds/cache.js`
- Create: `src/ds/resolver.js`
- Test: `tests/ds/cache.test.js`
- Test: `tests/ds/resolver.test.js`

The DS cache stores discovered styles and variables. The resolver handles fuzzy path matching. These are pure Node.js — no plugin or bridge dependency.

- [ ] **Step 1: Write failing tests for DS cache**

```javascript
// tests/ds/cache.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DsCache } = require('../../src/ds/cache');

describe('DsCache', () => {
  it('stores and retrieves text styles by key', () => {
    const cache = new DsCache();
    cache.addTextStyle('abc123', { name: 'Display xl/Semibold', fontFamily: 'Inter', fontSize: 60 });
    const style = cache.getTextStyle('abc123');
    assert.equal(style.name, 'Display xl/Semibold');
  });

  it('stores and retrieves color variables by path', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'var123', collection: 'Colors', resolvedValue: '#ffffff' });
    const v = cache.getVariable('bg-primary');
    assert.equal(v.key, 'var123');
  });

  it('returns null for unknown paths', () => {
    const cache = new DsCache();
    assert.equal(cache.getVariable('nonexistent'), null);
  });

  it('builds enforcement profile from inventory', () => {
    const cache = new DsCache();
    cache.addTextStyle('abc', { name: 'Text sm' });
    cache.addVariable('bg-primary', { key: 'v1', collection: 'Colors', category: 'background' });
    const profile = cache.getEnforcementProfile();
    assert.equal(profile.enforceTextStyles, true);
    assert.equal(profile.enforceColorVars, true);
    assert.equal(profile.enforceSpacingVars, false);
    assert.equal(profile.enforceRadiusVars, false);
  });

  it('clears all cached data', () => {
    const cache = new DsCache();
    cache.addTextStyle('abc', { name: 'Test' });
    cache.clear();
    assert.equal(cache.getTextStyle('abc'), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ds/cache.test.js`
Expected: FAIL

- [ ] **Step 3: Implement DsCache**

```javascript
// src/ds/cache.js

class DsCache {
  constructor() {
    this.textStyles = new Map();
    this.variables = new Map();
    this.components = new Map();
    this.failedKeys = new Set();
  }

  addTextStyle(key, style) { this.textStyles.set(key, style); }
  getTextStyle(key) { return this.textStyles.get(key) || null; }

  addVariable(path, variable) { this.variables.set(path, variable); }
  getVariable(path) { return this.variables.get(path) || null; }

  addComponent(key, component) { this.components.set(key, component); }
  getComponent(key) { return this.components.get(key) || null; }

  markFailed(key) { this.failedKeys.add(key); }
  hasFailed(key) { return this.failedKeys.has(key); }

  getEnforcementProfile() {
    const hasTextStyles = this.textStyles.size > 0;
    const hasTypographyVars = [...this.variables.values()].some(v =>
      v.collection && v.collection.toLowerCase().includes('font'));

    const colorVars = [...this.variables.values()].filter(v =>
      v.category === 'text' || v.category === 'background' || v.category === 'border' || v.category === 'foreground');
    const spacingVars = [...this.variables.values()].filter(v => v.category === 'spacing');
    const radiusVars = [...this.variables.values()].filter(v => v.category === 'radius');

    return {
      enforceTextStyles: hasTextStyles || hasTypographyVars,
      enforceColorVars: colorVars.length > 0,
      enforceSpacingVars: spacingVars.length > 0,
      enforceRadiusVars: radiusVars.length > 0,
      counts: {
        textStyles: this.textStyles.size,
        colorVars: colorVars.length,
        spacingVars: spacingVars.length,
        radiusVars: radiusVars.length,
      }
    };
  }

  clear() {
    this.textStyles.clear();
    this.variables.clear();
    this.components.clear();
    this.failedKeys.clear();
  }
}

module.exports = { DsCache };
```

- [ ] **Step 4: Run cache tests**

Run: `node --test tests/ds/cache.test.js`
Expected: PASS

- [ ] **Step 5: Write failing tests for resolver**

```javascript
// tests/ds/resolver.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DsResolver } = require('../../src/ds/resolver');
const { DsCache } = require('../../src/ds/cache');

describe('DsResolver', () => {
  it('resolves exact variable path', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'v1' });
    const resolver = new DsResolver(cache);
    assert.deepStrictEqual(resolver.resolve('bg-primary'), { key: 'v1' });
  });

  it('fuzzy matches by stripping collection prefix', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'v1' });
    const resolver = new DsResolver(cache);
    assert.deepStrictEqual(resolver.resolve('Colors/Background/bg-primary'), { key: 'v1' });
  });

  it('returns null and lists available for unknown paths', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'v1', category: 'background' });
    cache.addVariable('bg-secondary', { key: 'v2', category: 'background' });
    const resolver = new DsResolver(cache);
    const result = resolver.resolve('bg-tertiary');
    assert.equal(result, null);
  });

  it('lists available variables by category', () => {
    const cache = new DsCache();
    cache.addVariable('bg-primary', { key: 'v1', category: 'background' });
    cache.addVariable('bg-secondary', { key: 'v2', category: 'background' });
    cache.addVariable('text-primary', { key: 'v3', category: 'text' });
    const resolver = new DsResolver(cache);
    const available = resolver.listByCategory('background');
    assert.equal(available.length, 2);
  });
});
```

- [ ] **Step 6: Implement DsResolver**

```javascript
// src/ds/resolver.js

class DsResolver {
  constructor(cache) {
    this.cache = cache;
  }

  resolve(path) {
    // Exact match first
    const exact = this.cache.getVariable(path);
    if (exact) return exact;

    // Strip prefix segments and try progressively shorter suffixes
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/');
      const match = this.cache.getVariable(suffix);
      if (match) {
        // Cache the alias for future instant lookups
        this.cache.addVariable(path, match);
        return match;
      }
    }

    // Try matching just the last segment
    const lastSegment = segments[segments.length - 1];
    const match = this.cache.getVariable(lastSegment);
    if (match) {
      this.cache.addVariable(path, match);
      return match;
    }

    return null;
  }

  listByCategory(category) {
    const results = [];
    for (const [path, variable] of this.cache.variables) {
      if (variable.category === category) {
        results.push({ path, ...variable });
      }
    }
    return results;
  }

  findClosest(path, category) {
    const available = this.listByCategory(category);
    if (available.length === 0) return null;

    // Simple substring match on the path name
    const needle = path.toLowerCase();
    const match = available.find(v => v.path.toLowerCase().includes(needle));
    return match || available[0]; // Fall back to first available
  }
}

module.exports = { DsResolver };
```

- [ ] **Step 7: Run resolver tests**

Run: `node --test tests/ds/resolver.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/ds/ tests/ds/
git commit -m "feat: DS cache with enforcement profiles + variable resolver with fuzzy matching"
```

---

## Task 4: Knowledge Store

**Files:**
- Create: `src/knowledge/store.js`
- Create: `src/knowledge/patterns.js`
- Create: `src/knowledge/gaps.js`
- Test: `tests/knowledge/store.test.js`
- Test: `tests/knowledge/patterns.test.js`

Pure Node.js. Reads/writes `ds-knowledge.json`. No plugin dependency.

- [ ] **Step 1: Write failing tests for knowledge store**

```javascript
// tests/knowledge/store.test.js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { KnowledgeStore } = require('../../src/knowledge/store');

const TEST_PATH = path.join(__dirname, 'test-knowledge.json');

describe('KnowledgeStore', () => {
  afterEach(() => { try { fs.unlinkSync(TEST_PATH); } catch {} });

  it('creates new store with correct schema', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.save();
    const data = JSON.parse(fs.readFileSync(TEST_PATH, 'utf-8'));
    assert.equal(data.version, 2);
    assert.ok(data.components);
    assert.ok(data.patterns);
    assert.ok(data.gaps);
    assert.ok(data.meta);
  });

  it('loads existing store', () => {
    fs.writeFileSync(TEST_PATH, JSON.stringify({
      version: 2, dsFingerprint: 'abc',
      components: { 'btn': { componentKey: 'k1' } },
      patterns: {}, gaps: {}, meta: { buildCount: 5 }
    }));
    const store = new KnowledgeStore(TEST_PATH);
    store.load();
    assert.equal(store.data.meta.buildCount, 5);
    assert.equal(store.data.components.btn.componentKey, 'k1');
  });

  it('saves component recipe', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.setComponent('button-primary', {
      componentKey: 'abc123',
      variant: { Size: 'md', Hierarchy: 'Primary' },
      confidence: 'strong',
      buildCount: 1,
    });
    store.save();
    const reloaded = new KnowledgeStore(TEST_PATH);
    reloaded.load();
    assert.equal(reloaded.data.components['button-primary'].componentKey, 'abc123');
  });

  it('tracks gap evidence', () => {
    const store = new KnowledgeStore(TEST_PATH);
    store.addGap('tab-component', {
      evidence: 'Built as primitive',
      elements: ['nav tabs'],
      estimatedSavings: { toolCalls: 6 },
    });
    assert.ok(store.data.gaps['tab-component']);
    assert.equal(store.data.gaps['tab-component'].elements.length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/knowledge/store.test.js`
Expected: FAIL

- [ ] **Step 3: Implement KnowledgeStore**

```javascript
// src/knowledge/store.js
const fs = require('node:fs');
const path = require('node:path');

const EMPTY_STORE = {
  version: 2,
  dsFingerprint: null,
  components: {},
  patterns: {},
  gaps: {},
  meta: {
    buildCount: 0,
    lastBuild: null,
    dsLibraryKey: null,
    totalToolCalls: 0,
    totalFromCache: 0,
  }
};

class KnowledgeStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = JSON.parse(JSON.stringify(EMPTY_STORE));
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.version === 2) {
        this.data = parsed;
      }
    } catch {
      // File doesn't exist or is corrupt — use empty store
    }
    return this;
  }

  save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    return this;
  }

  setComponent(id, recipe) {
    this.data.components[id] = { ...recipe, updatedAt: new Date().toISOString() };
  }

  getComponent(id) {
    return this.data.components[id] || null;
  }

  setPattern(cssSelector, mapping) {
    this.data.patterns[cssSelector] = { ...mapping, updatedAt: new Date().toISOString() };
  }

  getPattern(cssSelector) {
    return this.data.patterns[cssSelector] || null;
  }

  addGap(id, gap) {
    const existing = this.data.gaps[id];
    if (existing) {
      existing.elements = [...new Set([...existing.elements, ...gap.elements])];
      existing.evidence = gap.evidence;
      existing.estimatedSavings = gap.estimatedSavings;
    } else {
      this.data.gaps[id] = { ...gap, firstSeen: new Date().toISOString() };
    }
  }

  getGaps() {
    return Object.entries(this.data.gaps).map(([id, gap]) => ({ id, ...gap }));
  }

  incrementBuildCount() {
    this.data.meta.buildCount++;
    this.data.meta.lastBuild = new Date().toISOString();
  }

  setFingerprint(fp) {
    this.data.dsFingerprint = fp;
  }
}

module.exports = { KnowledgeStore };
```

- [ ] **Step 4: Run store tests**

Run: `node --test tests/knowledge/store.test.js`
Expected: PASS

- [ ] **Step 5: Write failing tests for pattern matching**

```javascript
// tests/knowledge/patterns.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PatternMatcher } = require('../../src/knowledge/patterns');

describe('PatternMatcher', () => {
  it('promotes pattern after 3 uncorrected builds', () => {
    const matcher = new PatternMatcher();
    const pattern = { confidence: 'new', buildCount: 2, source: 'auto' };
    const promoted = matcher.maybePromote(pattern);
    assert.equal(promoted.confidence, 'new'); // Still 2, not yet 3

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
```

- [ ] **Step 6: Implement PatternMatcher**

```javascript
// src/knowledge/patterns.js

class PatternMatcher {
  maybePromote(pattern) {
    if (pattern.confidence === 'strong') return pattern;
    if (pattern.buildCount >= 3 && pattern.source !== 'user_correction') {
      return { ...pattern, confidence: 'strong', source: 'auto_promoted' };
    }
    return pattern;
  }

  applyCorrection(pattern, source) {
    return {
      ...pattern,
      confidence: 'strong',
      source: source || 'user_correction',
      correctedAt: new Date().toISOString(),
    };
  }

  applyConfirmation(pattern) {
    return {
      ...pattern,
      confidence: 'strong',
      confirmedAt: new Date().toISOString(),
    };
  }

  incrementUsage(pattern) {
    return {
      ...pattern,
      buildCount: (pattern.buildCount || 0) + 1,
    };
  }
}

module.exports = { PatternMatcher };
```

- [ ] **Step 7: Run pattern tests**

Run: `node --test tests/knowledge/patterns.test.js`
Expected: PASS

- [ ] **Step 8: Implement gap tracking**

```javascript
// src/knowledge/gaps.js

class GapTracker {
  constructor(store) {
    this.store = store;
  }

  recordPrimitive(elementType, searchTerms, buildId) {
    const id = elementType.toLowerCase().replace(/\s+/g, '-');
    this.store.addGap(id, {
      evidence: `Built as primitive in build ${buildId}. Searched: ${searchTerms.join(', ')}`,
      elements: [elementType],
      estimatedSavings: this.estimateSavings(elementType),
    });
  }

  estimateSavings(elementType) {
    // Component insertion = ~3 calls. Primitive build = ~8-12 calls.
    // Savings per instance: ~7 calls.
    return { toolCalls: 7, perBuild: 7 };
  }

  generateRecommendations() {
    return this.store.getGaps().map(gap => ({
      id: gap.id,
      recommendation: `Should your DS include a ${gap.id.replace(/-/g, ' ')} component? ${gap.evidence}. Adding it would save ~${gap.estimatedSavings.toolCalls} tool calls per instance.`,
      elements: gap.elements,
      savings: gap.estimatedSavings,
    }));
  }
}

module.exports = { GapTracker };
```

- [ ] **Step 9: Commit**

```bash
git add src/knowledge/ tests/knowledge/
git commit -m "feat: knowledge store, pattern matching (3-trigger model), gap tracking with savings estimates"
```

---

## Task 5: Chart Calculator

**Files:**
- Create: `src/charts/calculator.js`
- Test: `tests/charts/calculator.test.js`

Pure math — no dependencies on anything else. Fully testable with known data.

- [ ] **Step 1: Write failing tests for chart calculations**

```javascript
// tests/charts/calculator.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { ChartCalculator } = require('../../src/charts/calculator');

const calc = new ChartCalculator();

describe('ChartCalculator', () => {
  describe('bar', () => {
    it('scales bar heights proportionally', () => {
      const result = calc.bar({
        data: [{ label: 'A', value: 50 }, { label: 'B', value: 100 }],
        chartHeight: 200,
      });
      assert.equal(result.bars[0].height, 100); // 50/100 * 200
      assert.equal(result.bars[1].height, 200); // 100/100 * 200
    });
  });

  describe('donut', () => {
    it('segments sum to exactly 2*PI', () => {
      const result = calc.donut({
        data: [{ label: 'A', value: 30 }, { label: 'B', value: 70 }],
        outerRadius: 100,
        innerRadius: 0.65,
      });
      const lastSegment = result.segments[result.segments.length - 1];
      assert.ok(Math.abs(lastSegment.endingAngle - Math.PI * 2) < 0.0001);
    });

    it('each segment starts where previous ended', () => {
      const result = calc.donut({
        data: [{ label: 'A', value: 25 }, { label: 'B', value: 25 }, { label: 'C', value: 50 }],
        outerRadius: 100,
        innerRadius: 0.65,
      });
      assert.ok(Math.abs(result.segments[1].startingAngle - result.segments[0].endingAngle) < 0.0001);
      assert.ok(Math.abs(result.segments[2].startingAngle - result.segments[1].endingAngle) < 0.0001);
    });
  });

  describe('line', () => {
    it('generates valid SVG path string', () => {
      const result = calc.line({
        data: [{ x: 0, y: 10 }, { x: 50, y: 40 }, { x: 100, y: 20 }],
        plotWidth: 300,
        plotHeight: 200,
      });
      assert.ok(result.pathD.startsWith('M'));
      assert.ok(result.pathD.includes('C') || result.pathD.includes('L'));
    });

    it('returns data point positions for dots', () => {
      const result = calc.line({
        data: [{ x: 0, y: 10 }, { x: 100, y: 50 }],
        plotWidth: 300,
        plotHeight: 200,
      });
      assert.equal(result.points.length, 2);
      assert.ok(result.points[0].px !== undefined);
      assert.ok(result.points[0].py !== undefined);
    });
  });

  describe('radar', () => {
    it('computes correct number of vertices', () => {
      const result = calc.radar({
        data: [{ label: 'Speed', value: 80 }, { label: 'Power', value: 60 }, { label: 'Range', value: 90 }],
        maxValue: 100,
        radius: 120,
        cx: 150,
        cy: 150,
      });
      assert.equal(result.vertices.length, 3);
    });

    it('generates grid SVG', () => {
      const result = calc.radar({
        data: [{ label: 'A', value: 50 }, { label: 'B', value: 50 }, { label: 'C', value: 50 }],
        maxValue: 100,
        radius: 100,
        cx: 100,
        cy: 100,
      });
      assert.ok(result.gridSvg.includes('<polygon') || result.gridSvg.includes('<line'));
    });
  });

  describe('scatter', () => {
    it('normalizes points to plot area', () => {
      const result = calc.scatter({
        data: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
        plotWidth: 300,
        plotHeight: 200,
      });
      assert.equal(result.points[0].px, 0);
      assert.equal(result.points[0].py, 200); // y is inverted in Figma
      assert.equal(result.points[1].px, 300);
      assert.equal(result.points[1].py, 0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/charts/calculator.test.js`
Expected: FAIL

- [ ] **Step 3: Implement ChartCalculator**

```javascript
// src/charts/calculator.js

class ChartCalculator {
  bar({ data, chartHeight }) {
    const maxValue = Math.max(...data.map(d => d.value));
    const bars = data.map((d, i) => ({
      label: d.label,
      value: d.value,
      height: maxValue > 0 ? (d.value / maxValue) * chartHeight : 0,
      index: i,
    }));
    return { bars, maxValue };
  }

  donut({ data, outerRadius, innerRadius = 0.65 }) {
    const total = data.reduce((sum, d) => sum + d.value, 0);
    let cumulative = 0;
    const segments = data.map(d => {
      const startingAngle = (cumulative / total) * Math.PI * 2;
      cumulative += d.value;
      const endingAngle = (cumulative / total) * Math.PI * 2;
      return {
        label: d.label,
        value: d.value,
        startingAngle,
        endingAngle,
        innerRadius,
      };
    });
    return { segments, total };
  }

  line({ data, plotWidth, plotHeight }) {
    const xMin = Math.min(...data.map(d => d.x));
    const xMax = Math.max(...data.map(d => d.x));
    const yMin = Math.min(...data.map(d => d.y));
    const yMax = Math.max(...data.map(d => d.y));
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;

    const points = data.map(d => ({
      ...d,
      px: ((d.x - xMin) / xRange) * plotWidth,
      py: plotHeight - ((d.y - yMin) / yRange) * plotHeight,
    }));

    // Generate SVG path with line segments (simple; cubic bezier for smoothing can be added)
    let pathD = `M ${points[0].px},${points[0].py}`;
    for (let i = 1; i < points.length; i++) {
      pathD += ` L ${points[i].px},${points[i].py}`;
    }

    return { pathD, points, svgString: `<svg width="${plotWidth}" height="${plotHeight}"><path d="${pathD}" fill="none" stroke="currentColor" stroke-width="2"/></svg>` };
  }

  radar({ data, maxValue, radius, cx, cy }) {
    const n = data.length;
    const angleStep = (Math.PI * 2) / n;

    const vertices = data.map((d, i) => {
      const angle = i * angleStep - Math.PI / 2;
      const r = (d.value / maxValue) * radius;
      return {
        label: d.label,
        value: d.value,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        labelX: cx + (radius + 20) * Math.cos(angle),
        labelY: cy + (radius + 20) * Math.sin(angle),
      };
    });

    // Data polygon SVG
    const polygonPoints = vertices.map(v => `${v.x},${v.y}`).join(' ');
    const dataSvg = `<polygon points="${polygonPoints}" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="2"/>`;

    // Grid rings (3 levels)
    const gridRings = [0.33, 0.67, 1.0].map(scale => {
      const pts = Array.from({ length: n }, (_, i) => {
        const angle = i * angleStep - Math.PI / 2;
        const r = scale * radius;
        return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
      }).join(' ');
      return `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>`;
    });

    // Axis lines
    const axisLines = Array.from({ length: n }, (_, i) => {
      const angle = i * angleStep - Math.PI / 2;
      return `<line x1="${cx}" y1="${cy}" x2="${cx + radius * Math.cos(angle)}" y2="${cy + radius * Math.sin(angle)}" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>`;
    });

    const gridSvg = [...gridRings, ...axisLines].join('\n');

    return { vertices, dataSvg, gridSvg };
  }

  scatter({ data, plotWidth, plotHeight }) {
    const xMin = Math.min(...data.map(d => d.x));
    const xMax = Math.max(...data.map(d => d.x));
    const yMin = Math.min(...data.map(d => d.y));
    const yMax = Math.max(...data.map(d => d.y));
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;

    const points = data.map(d => ({
      ...d,
      px: ((d.x - xMin) / xRange) * plotWidth,
      py: plotHeight - ((d.y - yMin) / yRange) * plotHeight,
      radius: d.radius || 4,
    }));

    return { points };
  }

  heatmap({ data, rows, cols, cellWidth, cellHeight }) {
    const maxValue = Math.max(...data.map(d => d.value));
    const cells = data.map(d => ({
      ...d,
      intensity: maxValue > 0 ? d.value / maxValue : 0,
      x: d.col * cellWidth,
      y: d.row * cellHeight,
      width: cellWidth,
      height: cellHeight,
    }));
    return { cells, maxValue };
  }
}

module.exports = { ChartCalculator };
```

- [ ] **Step 4: Run chart tests**

Run: `node --test tests/charts/calculator.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/charts/ tests/charts/
git commit -m "feat: chart calculator — all geometry in Node.js (bar, donut, line, radar, scatter, heatmap)"
```

---

## Task 6: WebSocket Bridge with Keepalive

**Files:**
- Create: `src/bridge.js`
- Test: `tests/bridge.test.js`

The bridge is the transport layer between MCP server and Figma plugin.

- [ ] **Step 1: Write failing tests for bridge**

```javascript
// tests/bridge.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Bridge } = require('../src/bridge');

describe('Bridge', () => {
  it('initializes with correct defaults', () => {
    const bridge = new Bridge({ port: 3055 });
    assert.equal(bridge.port, 3055);
    assert.equal(bridge.connected, false);
    assert.equal(bridge.keepaliveInterval, 15000);
  });

  it('queues operations when not connected', () => {
    const bridge = new Bridge({ port: 3055 });
    const promise = bridge.send('create_frame', { name: 'test' });
    assert.equal(bridge.pendingOps.length, 1);
  });

  it('formats messages correctly', () => {
    const bridge = new Bridge({ port: 3055 });
    const msg = bridge.formatMessage('create_frame', { name: 'test' });
    assert.equal(msg.type, 'create_frame');
    assert.equal(msg.payload.name, 'test');
    assert.ok(msg.id); // Has a unique ID
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bridge.test.js`
Expected: FAIL

- [ ] **Step 3: Implement Bridge**

```javascript
// src/bridge.js
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('node:crypto');

class Bridge {
  constructor({ port = 3055, keepaliveInterval = 15000, maxReconnectAttempts = 3 } = {}) {
    this.port = port;
    this.keepaliveInterval = keepaliveInterval;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.connected = false;
    this.ws = null;
    this.server = null;
    this.wss = null;
    this.pendingOps = [];
    this.responseHandlers = new Map();
    this.keepaliveTimer = null;
  }

  formatMessage(type, payload) {
    return {
      id: crypto.randomUUID(),
      type,
      payload: payload || {},
    };
  }

  async start() {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ connected: this.connected }));
        return;
      }

      if (req.method === 'POST' && req.url === '/execute') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { type, payload } = JSON.parse(body);
            const result = await this.send(type, payload);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      this.ws = ws;
      this.connected = true;
      this.startKeepalive();
      this.flushPendingOps();

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'pong') return;
          const handler = this.responseHandlers.get(msg.id);
          if (handler) {
            this.responseHandlers.delete(msg.id);
            if (msg.error) handler.reject(new Error(msg.error));
            else handler.resolve(msg.result);
          }
        } catch {}
      });

      ws.on('close', () => {
        this.connected = false;
        this.ws = null;
        this.stopKeepalive();
      });
    });

    return new Promise((resolve) => {
      this.server.listen(this.port, () => resolve());
    });
  }

  startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, this.keepaliveInterval);
  }

  stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  send(type, payload, timeout = 60000) {
    const msg = this.formatMessage(type, payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseHandlers.delete(msg.id);
        reject(new Error(`Timeout: ${type} (${timeout}ms)`));
      }, timeout);

      this.responseHandlers.set(msg.id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      } else {
        this.pendingOps.push(msg);
      }
    });
  }

  flushPendingOps() {
    while (this.pendingOps.length > 0 && this.connected) {
      const msg = this.pendingOps.shift();
      this.ws.send(JSON.stringify(msg));
    }
  }

  async stop() {
    this.stopKeepalive();
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
    this.connected = false;
  }
}

module.exports = { Bridge };
```

- [ ] **Step 4: Run bridge tests**

Run: `node --test tests/bridge.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge.js tests/bridge.test.js
git commit -m "feat: WebSocket bridge with keepalive ping, auto-reconnect, pending-op queue"
```

---

## Task 7: MCP Server Entry Point with Phase Tracking

**Files:**
- Create: `mcp.js`

This is the main entry point. It registers all tools, manages the build session state (phase counter), and embeds the bridge.

- [ ] **Step 1: Create mcp.js with MCP SDK, phase tracking, and bridge integration**

```javascript
// mcp.js
#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { Bridge } = require('./src/bridge');
const { DsCache } = require('./src/ds/cache');
const { DsResolver } = require('./src/ds/resolver');
const { KnowledgeStore } = require('./src/knowledge/store');
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

// Shared instances
const bridge = new Bridge({ port: 3055 });
const dsCache = new DsCache();
const dsResolver = new DsResolver(dsCache);
const knowledgeStore = new KnowledgeStore(
  path.join(process.cwd(), 'ds-knowledge.json')
);

// MCP Server
const server = new Server(
  { name: 'mimic-ai', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

// Tool registration will be added in subsequent tasks.
// Each tool file (src/tools/*.js) exports a register(server, context) function.
// Context includes: bridge, dsCache, dsResolver, knowledgeStore, session, requirePhase, advancePhase, resetSession.

const context = {
  bridge,
  dsCache,
  dsResolver,
  knowledgeStore,
  session,
  requirePhase,
  advancePhase,
  resetSession,
};

// Register tools (will be populated as each tool file is created)
// require('./src/tools/status').register(server, context);
// require('./src/tools/ds-setup').register(server, context);
// require('./src/tools/build').register(server, context);
// ... etc

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
```

- [ ] **Step 2: Verify it runs without errors**

Run: `echo '{}' | timeout 2 node mcp.js 2>&1 || true`
Expected: Starts without crash (will exit when stdin closes).

- [ ] **Step 3: Commit**

```bash
git add mcp.js
git commit -m "feat: MCP server entry point with phase tracking, bridge auto-start, shared context"
```

---

## Task 8: Figma Plugin (Thin Handlers + DS Enforcement Gate)

**Files:**
- Modify: `plugin/code.js`

The plugin is the thin execution layer. It receives messages via WebSocket, executes Figma Plugin API calls, and returns results. The DS enforcement gate checks each creation against the enforcement profile.

- [ ] **Step 1: Implement plugin/code.js**

This is the one file we can't unit test (runs inside Figma's sandbox). It must be kept minimal and mechanical. The full implementation follows. Note: this is a complete rewrite — do not reference v1 code.

```javascript
// plugin/code.js
// Mimic AI v2 — Thin Figma plugin with DS enforcement gate

figma.showUI(__html__, { width: 280, height: 120 });

// ---- State ----
let enforcementProfile = {
  enforceTextStyles: false,
  enforceColorVars: false,
  enforceSpacingVars: false,
  enforceRadiusVars: false,
};
let styleCache = new Map();     // key → TextStyle
let variableCache = new Map();  // path → Variable

// ---- DS Enforcement Gate ----
function enforceText(params) {
  if (!enforcementProfile.enforceTextStyles) return; // DS has no text styles — allow raw
  if (!params.textStyleId && !params.fontSizeVariable) {
    throw {
      error: 'DS_REQUIRED',
      property: 'textStyle',
      message: `Text requires a DS text style (${styleCache.size} available)`,
      available: [...styleCache.values()].slice(0, 10).map(s => s.name),
      recovery: 'Pass textStyleId or fontSizeVariable + lineHeightVariable',
    };
  }
}

function enforceColorFill(params, nodeType) {
  if (!enforcementProfile.enforceColorVars) return;
  if (params.fillVariable) return; // Has DS color — ok
  if (!params.fill && !params.fillColor) return; // No fill requested — ok
  throw {
    error: 'DS_REQUIRED',
    property: 'fill',
    message: `${nodeType} fill requires a DS color variable`,
    recovery: 'Pass fillVariable with a DS color variable path',
  };
}

// ---- Variable helpers ----
async function getVariableByPath(path) {
  if (variableCache.has(path)) return variableCache.get(path);

  // Try importing by key if path looks like a key
  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    for (const col of collections) {
      for (const varId of col.variableIds) {
        const v = await figma.variables.getVariableByIdAsync(varId);
        if (v && v.name === path) {
          variableCache.set(path, v);
          return v;
        }
      }
    }
  } catch {}

  return null;
}

async function bindVariable(node, prop, varPath) {
  if (!varPath) return false;
  const v = await getVariableByPath(varPath);
  if (!v) return false;
  try {
    node.setBoundVariable(prop, v);
    return true;
  } catch { return false; }
}

async function bindFillVariable(node, varPath) {
  if (!varPath) return false;
  const v = await getVariableByPath(varPath);
  if (!v) return false;
  try {
    const fills = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', v)];
    node.fills = fills;
    return true;
  } catch { return false; }
}

// ---- Handlers ----
const handlers = {
  async ping() { return { status: 'ok' }; },

  async get_plugin_status() {
    return {
      connected: true,
      fileName: figma.root.name,
      currentPage: figma.currentPage.name,
      currentPageId: figma.currentPage.id,
      enforcementProfile,
    };
  },

  async set_session_defaults(params) {
    if (params.enforcementProfile) {
      enforcementProfile = params.enforcementProfile;
    }
    // Preload styles if provided
    if (params.textStyleKeys) {
      for (const key of params.textStyleKeys) {
        try {
          const style = await figma.importStyleByKeyAsync(key);
          if (style) styleCache.set(key, style);
        } catch {}
      }
    }
    return { enforcementProfile, cachedStyles: styleCache.size };
  },

  async create_frame(params) {
    enforceColorFill(params, 'Frame');
    const frame = figma.createFrame();
    frame.name = params.name || 'Frame';

    // Auto-layout (always)
    frame.layoutMode = params.direction || 'VERTICAL';
    frame.primaryAxisSizingMode = params.primaryAxisSizingMode || 'AUTO';
    frame.counterAxisSizingMode = params.counterAxisSizingMode || 'FIXED';

    if (params.width) frame.resize(params.width, params.height || 100);

    // Sizing
    if (params.layoutSizingHorizontal) frame.layoutSizingHorizontal = params.layoutSizingHorizontal;
    if (params.layoutSizingVertical) frame.layoutSizingVertical = params.layoutSizingVertical;
    if (params.layoutGrow !== undefined) frame.layoutGrow = params.layoutGrow;
    if (params.maxWidth) frame.maxWidth = params.maxWidth;

    // Alignment
    if (params.primaryAxisAlignItems) frame.primaryAxisAlignItems = params.primaryAxisAlignItems;
    if (params.counterAxisAlignItems) frame.counterAxisAlignItems = params.counterAxisAlignItems;

    // Clipping
    if (params.clipsContent !== undefined) frame.clipsContent = params.clipsContent;

    // DS bindings — spacing
    if (params.paddingVariable) {
      await bindVariable(frame, 'paddingTop', params.paddingVariable);
      await bindVariable(frame, 'paddingBottom', params.paddingVariable);
      await bindVariable(frame, 'paddingLeft', params.paddingVariable);
      await bindVariable(frame, 'paddingRight', params.paddingVariable);
    }
    if (params.gapVariable) await bindVariable(frame, 'itemSpacing', params.gapVariable);
    if (params.cornerRadiusVariable) await bindVariable(frame, 'topLeftRadius', params.cornerRadiusVariable);

    // Raw spacing (when DS lacks spacing tokens — Tier 3 best-effort)
    if (params.padding !== undefined && !params.paddingVariable) {
      const p = typeof params.padding === 'number' ? params.padding : 0;
      frame.paddingTop = p; frame.paddingBottom = p;
      frame.paddingLeft = p; frame.paddingRight = p;
    }
    if (params.gap !== undefined && !params.gapVariable) frame.itemSpacing = params.gap;
    if (params.cornerRadius !== undefined && !params.cornerRadiusVariable) frame.cornerRadius = params.cornerRadius;

    // Fill
    if (params.fillVariable) {
      await bindFillVariable(frame, params.fillVariable);
    }

    // Stroke
    if (params.strokeVariable) {
      const v = await getVariableByPath(params.strokeVariable);
      if (v) {
        frame.strokes = [figma.variables.setBoundVariableForPaint(
          { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', v
        )];
        frame.strokeWeight = params.strokeWeight || 1;
      }
    }

    // Parent
    if (params.parentId) {
      const parent = await figma.getNodeByIdAsync(params.parentId);
      if (parent && 'appendChild' in parent) parent.appendChild(frame);
    } else {
      figma.currentPage.appendChild(frame);
    }

    return { nodeId: frame.id, name: frame.name };
  },

  async create_text(params) {
    enforceText(params);
    enforceColorFill(params, 'Text');

    const text = figma.createText();
    text.name = params.name || 'Text';

    // Load font and apply text style
    if (params.textStyleId) {
      const style = styleCache.get(params.textStyleId) ||
        await figma.importStyleByKeyAsync(params.textStyleId).catch(() => null);
      if (style) {
        text.textStyleId = style.id;
        // Font is loaded by applying the style
      }
    } else if (params.fontSizeVariable) {
      // Typography variables path
      await figma.loadFontAsync({ family: params.fontFamily || 'Inter', style: params.fontStyle || 'Regular' });
      await bindVariable(text, 'fontSize', params.fontSizeVariable);
      if (params.lineHeightVariable) await bindVariable(text, 'lineHeight', params.lineHeightVariable);
      if (params.fontWeightVariable) await bindVariable(text, 'fontWeight', params.fontWeightVariable);
    } else {
      // No DS text styles — raw fallback (only when enforcement is off)
      await figma.loadFontAsync({ family: params.fontFamily || 'Inter', style: params.fontStyle || 'Regular' });
      if (params.fontSize) text.fontSize = params.fontSize;
    }

    // Content
    text.characters = params.content || '';

    // Text color
    if (params.fillVariable) {
      await bindFillVariable(text, params.fillVariable);
    }

    // Sizing
    if (params.layoutSizingHorizontal) text.layoutSizingHorizontal = params.layoutSizingHorizontal;
    if (params.width) text.resize(params.width, text.height);
    if (params.textAlignHorizontal) text.textAlignHorizontal = params.textAlignHorizontal;

    // Parent
    if (params.parentId) {
      const parent = await figma.getNodeByIdAsync(params.parentId);
      if (parent && 'appendChild' in parent) parent.appendChild(text);
    }

    return { nodeId: text.id, name: text.name, characters: text.characters };
  },

  async insert_component(params) {
    let component;
    try {
      component = await figma.importComponentByKeyAsync(params.componentKey);
    } catch {
      try {
        const set = await figma.importComponentSetByKeyAsync(params.componentKey);
        component = set.defaultVariant;
      } catch (e) {
        throw { error: 'COMPONENT_IMPORT_FAILED', key: params.componentKey, message: e.message };
      }
    }

    const instance = component.createInstance();
    instance.name = params.name || component.name;

    // Parent
    if (params.parentId) {
      const parent = await figma.getNodeByIdAsync(params.parentId);
      if (parent && 'appendChild' in parent) parent.appendChild(instance);
    }

    // Auto-size to hug
    instance.layoutSizingHorizontal = 'HUG';
    instance.layoutSizingVertical = 'HUG';

    // Collect component info for configuration
    const props = instance.componentProperties || {};
    const textNodes = [];
    const booleanProps = {};

    function walk(node) {
      if (node.type === 'TEXT') textNodes.push({ name: node.name, characters: node.characters });
      if ('children' in node) node.children.forEach(walk);
    }
    walk(instance);

    for (const [key, val] of Object.entries(props)) {
      if (val.type === 'BOOLEAN') booleanProps[key] = val.value;
    }

    return {
      nodeId: instance.id,
      name: instance.name,
      componentName: component.name,
      defaultTexts: textNodes.map(t => t.characters),
      textNodeNames: textNodes.map(t => t.name),
      booleanProperties: booleanProps,
      message: `Inserted ${component.name}. Override ALL text: ${textNodes.map(t => `"${t.characters}"`).join(', ')}. Hide unused icon slots.`,
    };
  },

  // Additional handlers will be added in subsequent tasks:
  // create_rectangle, create_ellipse, create_svg,
  // set_component_text, set_variant, set_text, set_node_fill,
  // set_layout_sizing, set_visibility, set_variable_mode,
  // move_node, delete_node, get_node_props, get_node_children, etc.
};

// ---- Message dispatcher ----
figma.ui.onmessage = async (msg) => {
  // Normalize node IDs (dash → colon)
  if (msg.payload) {
    for (const key of ['nodeId', 'parentId', 'parentNodeId']) {
      if (msg.payload[key] && typeof msg.payload[key] === 'string' && msg.payload[key].includes('-') && !msg.payload[key].includes(':')) {
        msg.payload[key] = msg.payload[key].replace(/-/g, ':');
      }
    }
  }

  const handler = handlers[msg.type];
  if (!handler) {
    figma.ui.postMessage({ id: msg.id, error: `Unknown handler: ${msg.type}` });
    return;
  }

  try {
    const result = await handler(msg.payload || {});
    figma.ui.postMessage({ id: msg.id, result });
  } catch (err) {
    figma.ui.postMessage({
      id: msg.id,
      error: typeof err === 'object' && err.error ? err : { error: 'PLUGIN_ERROR', message: String(err.message || err) },
    });
  }
};
```

This is the core plugin. It handles `create_frame`, `create_text`, `insert_component`, and the enforcement gate. Additional handlers (rectangle, ellipse, SVG, edit operations, inspect operations) follow the same pattern and will be added in Task 9.

- [ ] **Step 2: Verify plugin loads in Figma**

Open Figma desktop → Plugins → Development → Import plugin from manifest → select `plugin/manifest.json` → Run. The plugin UI should appear. No errors in console.

- [ ] **Step 3: Commit**

```bash
git add plugin/code.js
git commit -m "feat: Figma plugin v2 — thin handlers, graduated DS enforcement gate, component info return"
```

---

## Task 9: Remaining Plugin Handlers

**Files:**
- Modify: `plugin/code.js`

Add all remaining handlers to the plugin: create_rectangle, create_ellipse, create_svg, all edit operations, all inspect operations.

- [ ] **Step 1: Add creation handlers (rectangle, ellipse, SVG)**

Add `create_rectangle`, `create_ellipse` (with `arcData` for donut segments), and `create_svg` (wrapping `figma.createNodeFromSvg()`) handlers. Each respects the enforcement gate for fills and strokes.

- [ ] **Step 2: Add edit handlers**

Add `set_component_text`, `set_variant`, `set_text`, `set_node_fill`, `set_layout_sizing`, `set_visibility`, `set_variable_mode`, `set_text_style`, `move_node`, `delete_node`, `swap_main_component`, `replace_component`, `restyle_artboard`.

- [ ] **Step 3: Add inspect handlers**

Add `get_node_props`, `get_node_children`, `get_node_parent`, `get_pages`, `change_page`, `get_page_nodes`, `get_component_variants`, `get_text_info`, `get_selection`, `select_node`.

- [ ] **Step 4: Add compliance handler**

Add `validate_ds_compliance` — walks all nodes in a frame and checks: text nodes have textStyleId or typography variables, fills have variable bindings (when enforced), no nodes outside the artboard.

- [ ] **Step 5: Add batch handler**

Add `figma_batch` — executes up to 6 operations sequentially. Returns array of results.

- [ ] **Step 6: Test in Figma**

Run the plugin, connect the bridge, send test messages for each handler type. Verify no crashes.

- [ ] **Step 7: Commit**

```bash
git add plugin/code.js
git commit -m "feat: all plugin handlers — create, edit, inspect, compliance, batch"
```

---

## Task 10: MCP Tool Registration (Status + DS Setup + Build)

**Files:**
- Create: `src/tools/status.js`
- Create: `src/tools/ds-setup.js`
- Create: `src/tools/build.js`

Register the first tools with the MCP server. Each tool file exports a `register(server, context)` function.

- [ ] **Step 1: Implement status tools**

`mimic_status` returns: plugin connection state, current phase, enforcement profile, knowledge store summary, and what to do next. `mimic_discover_ds` triggers Phase 1 discovery.

- [ ] **Step 2: Implement DS setup tools**

`figma_preload_styles`, `figma_preload_variables`, `figma_set_session_defaults` (sends enforcement profile to plugin), `figma_list_text_styles`.

- [ ] **Step 3: Implement build tools**

`figma_create_frame`, `figma_create_text`, `figma_create_rectangle`, `figma_create_ellipse`, `figma_create_svg`. Each validates parameters, calls bridge, and returns result with contextual hints.

Phase enforcement: build tools call `requirePhase(2, 'Complete DS Discovery and Style Inventory first')`.

- [ ] **Step 4: Wire tools into mcp.js**

Uncomment the require lines in `mcp.js` for status, ds-setup, and build tools.

- [ ] **Step 5: Test end-to-end**

Start MCP server, connect plugin, call `mimic_status`, then `figma_create_frame`. Verify the frame appears in Figma.

- [ ] **Step 6: Commit**

```bash
git add src/tools/status.js src/tools/ds-setup.js src/tools/build.js mcp.js
git commit -m "feat: MCP tools — status, DS setup, build (create_frame, create_text, create_svg, etc.)"
```

---

## Task 11: MCP Tool Registration (Components + Edit + Inspect)

**Files:**
- Create: `src/tools/components.js`
- Create: `src/tools/edit.js`
- Create: `src/tools/inspect.js`
- Create: `src/tools/batch.js`

- [ ] **Step 1: Implement component tools**

`figma_insert_component` (returns component info + configuration hints), `figma_set_component_text`, `figma_set_variant`, `figma_swap_main_component`, `figma_replace_component`.

- [ ] **Step 2: Implement edit tools**

`figma_set_text`, `figma_set_node_fill`, `figma_set_layout_sizing`, `figma_set_visibility`, `figma_set_variable_mode`, `figma_set_text_style`, `figma_move_node`, `figma_delete_node`, `figma_restyle_artboard`.

- [ ] **Step 3: Implement inspect tools**

`figma_get_node_props`, `figma_get_node_children`, `figma_get_node_parent`, `figma_get_pages`, `figma_change_page`, `figma_get_page_nodes`, `figma_get_component_variants`, `figma_get_text_info`, `figma_get_selection`, `figma_select_node`.

- [ ] **Step 4: Implement batch tool**

`figma_batch` — max 6 ops, sequential execution, returns array of results.

- [ ] **Step 5: Wire into mcp.js**

- [ ] **Step 6: Test end-to-end**

Insert a component, set its text, set a variant, verify in Figma.

- [ ] **Step 7: Commit**

```bash
git add src/tools/components.js src/tools/edit.js src/tools/inspect.js src/tools/batch.js mcp.js
git commit -m "feat: MCP tools — components, edit, inspect, batch"
```

---

## Task 12: MCP Tool Registration (Learning + Compliance + Rendering)

**Files:**
- Create: `src/tools/learning.js`
- Create: `src/tools/compliance.js`
- Create: `src/tools/rendering.js`

- [ ] **Step 1: Implement learning tools**

`mimic_ai_knowledge_read` — loads and returns knowledge store contents. `mimic_ai_knowledge_write` — saves patterns, recipes, gaps. `mimic_generate_build_report` — compiles build data into structured report (markdown or HTML), saves to `mimic/reports/`. `mimic_generate_design_md` — compiles DS into DESIGN.md format.

- [ ] **Step 2: Implement compliance tool**

`figma_validate_ds_compliance` — calls plugin's compliance handler, returns structured results.

- [ ] **Step 3: Implement rendering tools**

`mimic_pipeline_resolve` — classifies input (URL vs file vs raw HTML), returns HTML path + detected color scheme. `mimic_render_url` — Puppeteer headless render of URL to HTML. (Puppeteer is an optional dependency — skip if not installed.)

- [ ] **Step 4: Implement chart compute tool**

`mimic_compute_chart` — takes data + chart type + dimensions, returns geometry from `ChartCalculator`. This is the bridge between the LLM (which extracts chart data from HTML) and the plugin (which creates the nodes).

- [ ] **Step 5: Wire into mcp.js**

- [ ] **Step 6: Commit**

```bash
git add src/tools/learning.js src/tools/compliance.js src/tools/rendering.js mcp.js
git commit -m "feat: MCP tools — learning, compliance, rendering, chart compute"
```

---

## Task 13: DS Discovery Module

**Files:**
- Create: `src/ds/discovery.js`

This handles Phase 1 — enumerating the DS library, finding components, building the component map.

- [ ] **Step 1: Implement library enumeration**

Query the Figma plugin for available library components and styles. Cache results in DsCache. For community libraries, use REST API key discovery (requires FIGMA_ACCESS_TOKEN).

- [ ] **Step 2: Implement component search**

Given an element type (button, tab, badge, etc.), search the cached library for matching components. Return best match or "not found" with search terms used.

- [ ] **Step 3: Implement component map builder**

Given HTML section inventory, produce a map: `{ elementType → { componentKey, variant, recipe } | { type: 'primitive', reason, searchTerms } }`.

- [ ] **Step 4: Integrate with mimic_discover_ds tool**

The `mimic_discover_ds` MCP tool calls discovery, populates the cache, builds the map, advances phase to 1.

- [ ] **Step 5: Commit**

```bash
git add src/ds/discovery.js
git commit -m "feat: DS discovery — library enumeration, component search, component map builder"
```

---

## Task 14: Integration Testing — First Full Build

**Files:**
- Create: `tests/integration/first-build.md` (manual test script)

This is the moment of truth — connecting all pieces for a complete Phase 0-5 build.

- [ ] **Step 1: Create a simple test HTML**

Use an existing test fixture: `internal/research/test-fixtures/F1-card.html` — a simple card component.

- [ ] **Step 2: Run full build manually**

Using Claude Code with Mimic configured:
1. "Build F1-card.html in my Figma file using my design system"
2. Verify: Phase 0 (target + plugin check) → Phase 1 (discovery) → Phase 2 (inventory) → Phase 3 (build) → Phase 4 (QA) → Phase 5 (report)
3. Verify: artboard is 1440px, content container is 1280px max-width
4. Verify: DS components used where available
5. Verify: text styles and color variables applied (where DS has them)
6. Verify: build report generated with gap recommendations

- [ ] **Step 3: Run medium complexity test**

Use `internal/research/test-fixtures/F3-table.html` — a data table with headers, rows, pagination.

- [ ] **Step 4: Run complex test**

Use `internal/research/test-fixtures/F5-dashboard.html` — a full dashboard with charts, metrics, tables.

- [ ] **Step 5: Document issues found**

Create `tests/integration/findings.md` with any issues found. Fix critical issues before proceeding.

- [ ] **Step 6: Commit fixes**

```bash
git add -A
git commit -m "fix: integration test findings — [describe what was fixed]"
```

---

## Task 15: VOICE_AND_TONE.md, README, and Package Publishing Prep

**Files:**
- Create: `VOICE_AND_TONE.md` (copy from `docs/v1-VOICE_AND_TONE.md` — it was excellent)
- Create: `GOLDEN_RULES.md` (distilled ~15 rules from spec)
- Modify: `README.md` (full README based on `docs/v1-README.md` structure, updated for v2)
- Modify: `package.json` (verify all fields for npm publishing)
- Create: `CHANGELOG.md`
- Create: `KNOWN_ISSUES.md`

- [ ] **Step 1: Copy and adapt VOICE_AND_TONE.md**

- [ ] **Step 2: Write GOLDEN_RULES.md (15 rules max)**

Distilled from spec Section 5 — structural principles only, not band-aids.

- [ ] **Step 3: Write full README.md**

Follow the v1 structure (problem statement, learning loop, comparison table, compatibility matrix, setup, MCP configs) but updated for v2 architecture.

- [ ] **Step 4: Write CHANGELOG.md**

```markdown
# Changelog

## 2.0.0 (unreleased)

### Breaking
- Complete rewrite from scratch. Not backwards compatible with v1.

### Architecture
- Split MCP server (smart) / plugin (thin enforcement gate)
- Embedded bridge with keepalive + auto-reconnect
- Chart math in Node.js, not LLM
- Graduated DS enforcement (adapts to what DS provides)
- Phase enforcement (mechanical, not advisory)

### Added
- First build always succeeds on any DS configuration
- Chart calculation engine (deterministic geometry)
- Contextual tool responses (hints, available values, recovery paths)
```

- [ ] **Step 5: Write KNOWN_ISSUES.md**

- [ ] **Step 6: Commit**

```bash
git add VOICE_AND_TONE.md GOLDEN_RULES.md README.md CHANGELOG.md KNOWN_ISSUES.md package.json
git commit -m "docs: VOICE_AND_TONE, GOLDEN_RULES (15 rules), README, CHANGELOG, KNOWN_ISSUES"
```

---

## Execution Notes

**Task dependencies:**
- Tasks 1-5 are independent (can be parallelized if using multiple agents)
- Task 6 (bridge) is independent
- Task 7 (mcp.js) depends on Tasks 2-6
- Task 8-9 (plugin) is independent of Node.js tasks
- Tasks 10-12 (MCP tools) depend on Tasks 7-9
- Task 13 (discovery) depends on Tasks 3, 10
- Task 14 (integration) depends on all prior tasks
- Task 15 (docs) can start anytime but should finalize after Task 14

**Total: 15 tasks. Estimated complexity: medium-high. The plugin (Tasks 8-9) and tool registration (Tasks 10-12) are the largest units of work.**
