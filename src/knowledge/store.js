'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;

function createEmptyStore() {
  return {
    version: SCHEMA_VERSION,
    dsFingerprint: null,
    components: {},
    patterns: {},
    gaps: {},
    libraryFileKeys: {},
    meta: {
      buildCount: 0,
      lastBuild: null,
      created: new Date().toISOString(),
    },
  };
}

class KnowledgeStore {
  /**
   * @param {string} filePath - Path to ds-knowledge.json
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = createEmptyStore();
  }

  /** Load existing store from disk. Creates empty store if file missing. */
  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported schema version: ${parsed.version}`);
      }
      this.data = parsed;
      // Backfill new fields for existing stores
      if (!this.data.libraryFileKeys) this.data.libraryFileKeys = {};
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.data = createEmptyStore();
      } else {
        throw err;
      }
    }
    return this;
  }

  /** Persist current state to disk. */
  save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    return this;
  }

  // ── Components ──────────────────────────────────────────────

  setComponent(name, recipe) {
    this.data.components[name] = {
      ...recipe,
      lastUsed: new Date().toISOString(),
    };
    return this;
  }

  getComponent(name) {
    return this.data.components[name] || null;
  }

  // ── Patterns ────────────────────────────────────────────────

  setPattern(name, pattern) {
    this.data.patterns[name] = {
      ...pattern,
      lastUsed: new Date().toISOString(),
    };
    return this;
  }

  getPattern(name) {
    return this.data.patterns[name] || null;
  }

  // ── Gaps ────────────────────────────────────────────────────

  addGap(name, gap) {
    const existing = this.data.gaps[name];
    if (existing) {
      // Merge elements (deduplicated)
      const merged = new Set([...existing.elements, ...gap.elements]);
      existing.elements = [...merged];
      existing.evidence = gap.evidence || existing.evidence;
      existing.estimatedSavings = gap.estimatedSavings || existing.estimatedSavings;
      existing.lastSeen = new Date().toISOString();
    } else {
      this.data.gaps[name] = {
        ...gap,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
    }
    return this;
  }

  getGaps() {
    return { ...this.data.gaps };
  }

  // ── Library File Keys ──────────────────────────────────────

  setLibraryFileKey(libraryName, fileKey) {
    if (!this.data.libraryFileKeys) this.data.libraryFileKeys = {};
    this.data.libraryFileKeys[libraryName] = fileKey;
    return this;
  }

  getLibraryFileKey(libraryName) {
    return this.data.libraryFileKeys?.[libraryName] || null;
  }

  // ── Meta ────────────────────────────────────────────────────

  incrementBuildCount() {
    this.data.meta.buildCount += 1;
    this.data.meta.lastBuild = new Date().toISOString();
    return this;
  }

  setFingerprint(fingerprint) {
    this.data.dsFingerprint = fingerprint;
    return this;
  }
}

module.exports = { KnowledgeStore };
