'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 3;

const VALID_CONFIDENCE_TIERS = new Set(['new', 'confirmed', 'verified', 'strong']);
const EXCLUDED_VARIANT_PROPERTY_TYPES = new Set(['BOOLEAN', 'TEXT']);

/**
 * Split a string into lowercase alphanumeric word tokens.
 * Used for whole-word rule matching — see findMatchingRules().
 */
function tokenize(str) {
  return (str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Library identity per schema v3 spec §3.2:
 *   libraryId := libraryFileKey (stable, canonical) | "name:" + normalize(libraryName)
 * normalize = lowercase, trim, collapse whitespace.
 */
function computeLibraryId({ libraryFileKey, libraryName } = {}) {
  if (libraryFileKey) return libraryFileKey;
  if (libraryName) return `name:${String(libraryName).toLowerCase().trim().replace(/\s+/g, ' ')}`;
  return '__default__';
}

function createEmptyLibraryBucket() {
  const now = new Date().toISOString();
  return {
    libraryName: null,
    libraryFileKey: null,
    idSource: null, // 'fileKey' | 'name' | 'legacy'
    aliases: [],
    // v3 structured fingerprint (spec §4.1) — storage only, capture logic is Wave 5's.
    fingerprint: null,
    // Legacy v2 string fingerprint. Kept under this exact field name (not
    // renamed to `legacyFingerprint` as the spec suggests) because
    // src/ds/discovery.js and src/tools/status.js read/write
    // `knowledgeStore.data.dsFingerprint` directly and are out of scope for
    // this worker (Wave-5 integration). Conceptually this IS the spec's
    // "legacyFingerprint" — same value, existing accessor name preserved.
    dsFingerprint: null,
    components: {},
    patterns: {},
    gaps: {},
    buildHistory: [],
    manifests: [],
    signals: [],
    meta: {
      buildCount: 0,
      lastBuild: null,
      created: now,
    },
  };
}

function createEmptyStore() {
  const now = new Date().toISOString();
  return {
    version: SCHEMA_VERSION,
    meta: {
      created: now,
      migratedFrom: null,
      lastCompaction: null,
    },
    rules: {},
    // Global name -> fileKey lookup, used at identity-resolution time (before
    // a library bucket even exists — e.g. "has the user given us this
    // community library's file key before?"). This is a v2 holdover kept
    // as-is; it is NOT the same thing as a library bucket's `aliases` list
    // (which records renamed bucket ids after identity becomes known).
    libraryFileKeys: {},
    libraries: {},
  };
}

/**
 * Derive `defaultVariants` from `variantStats` (majority-wins, spec §5.1).
 *
 * for each property in variantStats:
 *   top = argmax(count); total = sum(counts)
 *   include property in defaultVariants iff top.count >= 3 AND top.count/total >= 0.6
 *
 * `propertyTypes` is an optional `{ [property]: 'VARIANT'|'BOOLEAN'|'TEXT'|... }`
 * hint — property type information may not exist at store level (it lives in
 * the DS cache), so callers that have it should pass it; BOOLEAN/TEXT
 * properties are excluded from replay entirely regardless of vote share.
 */
function deriveDefaultVariants(recipe, propertyTypes = {}) {
  const variantStats = recipe && recipe.variantStats;
  if (!variantStats || typeof variantStats !== 'object') return {};
  const defaults = {};
  for (const [prop, valueCounts] of Object.entries(variantStats)) {
    const type = propertyTypes[prop];
    if (type && EXCLUDED_VARIANT_PROPERTY_TYPES.has(type)) continue;
    const entries = Object.entries(valueCounts || {});
    if (entries.length === 0) continue;
    const total = entries.reduce((sum, [, c]) => sum + (c || 0), 0);
    if (total === 0) continue;
    const [topValue, topCount] = entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
    if (topCount >= 3 && topCount / total >= 0.6) {
      defaults[prop] = topValue;
    }
  }
  return defaults;
}

function laterDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

function earlierDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) < new Date(b) ? a : b;
}

class KnowledgeStore {
  /**
   * @param {string} filePath - Path to the knowledge store file (kept as
   *   ds-knowledge.json — see resolveKnowledgeStorePath in mcp.js; spec calls
   *   the canonical filename knowledge.json, but the file name itself was
   *   fixed in a prior commit and is out of scope to rename again here).
   */
  constructor(filePath) {
    this.filePath = filePath;
    this._store = createEmptyStore();
    this.activeLibraryId = '__default__';
    // Set when load() had to recover from a corrupt/unsupported-version file.
    // Not part of the store data — it's ephemeral, process-local operational
    // state. Callers (mcp.js, mimic_status, mimic_ai_knowledge_read) should
    // surface this loudly to the user.
    this.loadWarning = null;
    // Set when load() migrated a v2 file to v3. Ephemeral, same rationale.
    this.migrationNote = null;
    // "Seen" snapshots (ids/keys this session has actually loaded from disk
    // at some point) — used by merge-on-save to distinguish "this session
    // never knew about X" (disk-only, another session's concurrent addition
    // — keep it) from "this session saw X and then explicitly removed it"
    // (a real deletion — must not be resurrected by the merge). Without
    // this, removeRule()/similar deletions would silently come back on the
    // next save() because a naive union-of-ids merge can't tell the two
    // cases apart. Empty on a fresh, never-loaded instance — consistent
    // with "an unloaded store doesn't know what's on disk, so it can't have
    // deleted anything from it".
    this._seenRuleIds = new Set();
    this._seenRecipeKeys = {};
    this._syncDataView();
  }

  _captureSeenIds() {
    this._seenRuleIds = new Set(Object.keys(this._store.rules || {}));
    this._seenRecipeKeys = {};
    for (const [libId, bucket] of Object.entries(this._store.libraries || {})) {
      this._seenRecipeKeys[libId] = new Set(Object.keys(bucket.components || {}));
    }
  }

  // ── Internal: bucket management + compatibility view ──────────

  _ensureBucket(id) {
    if (!this._store.libraries[id]) {
      this._store.libraries[id] = createEmptyLibraryBucket();
    }
    return this._store.libraries[id];
  }

  _activeBucket() {
    return this._ensureBucket(this.activeLibraryId || '__default__');
  }

  /**
   * Rebuilds `this.data` as a compatibility view over the currently active
   * library bucket. Every existing v2 consumer (learning.js, status.js,
   * build.js, components.js, discovery.js) reads/writes `knowledgeStore.data.X`
   * directly (not just through accessor methods) — so `data.components`,
   * `data.patterns`, `data.gaps`, `data.buildHistory`, `data.signals`,
   * `data.manifests`, and `data.meta` are the SAME object references as the
   * active bucket's fields (not copies), so in-place mutation through either
   * path stays consistent. `data.rules` and `data.libraryFileKeys` remain
   * global (never bucket-scoped) per spec §3.3.
   */
  _syncDataView() {
    const bucket = this._activeBucket();
    this.data = {
      version: this._store.version,
      rules: this._store.rules,
      libraryFileKeys: this._store.libraryFileKeys,
      libraries: this._store.libraries,
      components: bucket.components,
      patterns: bucket.patterns,
      gaps: bucket.gaps,
      buildHistory: bucket.buildHistory,
      signals: bucket.signals,
      manifests: bucket.manifests,
      meta: bucket.meta,
      dsFingerprint: bucket.dsFingerprint,
      fingerprint: bucket.fingerprint,
    };
    return this.data;
  }

  /**
   * Set the active library bucket. All existing v2-style accessors
   * (getComponent/setComponent, getPattern/setPattern, addGap/getGaps,
   * checkStaleness, recordBuild, addSignal, etc.) operate on whichever
   * bucket is active. When no active library has ever been set, the active
   * bucket is `__default__` (matching migrated-v2 behavior — spec §3.3/§5.5).
   *
   * @param {string|null} libraryId
   * @param {{ libraryName?: string, libraryFileKey?: string, idSource?: string }} [info]
   */
  setActiveLibrary(libraryId, info = {}) {
    const id = libraryId || '__default__';
    this.activeLibraryId = id;
    const bucket = this._ensureBucket(id);
    if (info.libraryName !== undefined) bucket.libraryName = info.libraryName;
    if (info.libraryFileKey !== undefined) bucket.libraryFileKey = info.libraryFileKey;
    if (info.idSource !== undefined) bucket.idSource = info.idSource;
    this._syncDataView();
    return this;
  }

  getActiveLibraryId() {
    return this.activeLibraryId;
  }

  getLibraryBucket(libraryId) {
    return this._store.libraries[libraryId] || null;
  }

  /** Per-library summaries (component/pattern/gap counts) — never the full dump. */
  getLibrarySummaries() {
    const out = {};
    for (const [id, bucket] of Object.entries(this._store.libraries)) {
      out[id] = {
        libraryName: bucket.libraryName,
        libraryFileKey: bucket.libraryFileKey,
        idSource: bucket.idSource,
        aliases: bucket.aliases || [],
        componentCount: Object.keys(bucket.components || {}).length,
        patternCount: Object.keys(bucket.patterns || {}).length,
        gapCount: Object.keys(bucket.gaps || {}).length,
        buildCount: bucket.meta?.buildCount || 0,
      };
    }
    return out;
  }

  // ── Corruption recovery ────────────────────────────────────────

  /**
   * Back up an unreadable/corrupt knowledge file and reset to a fresh
   * empty schema-v3 store. Never let a bad knowledge file prevent the
   * MCP server from starting — a build with no learning is recoverable,
   * a server that never connects is not.
   */
  _recoverFromCorruption(rawContent, reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.filePath}.corrupt-${stamp}`;
    let backedUp = false;
    try {
      fs.writeFileSync(backupPath, rawContent, 'utf-8');
      backedUp = true;
    } catch { /* best effort — still proceed with a fresh store */ }

    this._store = createEmptyStore();
    this.activeLibraryId = '__default__';
    this._captureSeenIds();
    this.loadWarning = {
      code: 'KNOWLEDGE_STORE_CORRUPT',
      reason,
      backupPath: backedUp ? backupPath : null,
      message: `⚠ Knowledge store at ${this.filePath} could not be loaded (${reason}). ` +
        (backedUp
          ? `The unreadable file was backed up to ${backupPath}. `
          : `A backup could not be written. `) +
        `Starting with a fresh knowledge store — previously learned components, ` +
        `patterns, and rules are unavailable unless recovered manually from the backup.`,
    };

    // Persist the fresh store immediately (direct write, bypassing the
    // merge-with-disk step in save() — there is nothing valid on disk to
    // merge with, and re-reading here would just re-encounter the same
    // unreadable file) so a restart doesn't re-trigger recovery against the
    // same bad file.
    try { this._persist(this._store); } catch { /* non-fatal — in-memory store still usable */ }

    this._syncDataView();
    return this;
  }

  // ── Migration from v2 ───────────────────────────────────────────

  _migrateRecipes(v2Components) {
    const out = {};
    for (const [key, recipe] of Object.entries(v2Components || {})) {
      const migrated = { ...recipe };
      if (!migrated.confidence) migrated.confidence = 'new'; // same backfill v2 load() used to do
      if (migrated.defaultVariants && Object.keys(migrated.defaultVariants).length > 0) {
        // Seed variantStats so migrated recipes still replay, but can be
        // outvoted by fresh observations (spec §3.4 step 3).
        const seedCount = Math.min(migrated.buildCount || 1, 3);
        const variantStats = {};
        for (const [prop, val] of Object.entries(migrated.defaultVariants)) {
          variantStats[prop] = { [val]: seedCount };
        }
        migrated.variantStats = variantStats;
      }
      if (Array.isArray(migrated.textNodes)) {
        // textNodes array -> frequency map, count 1 each (spec §3.4 step 3).
        const freq = {};
        for (const name of migrated.textNodes) freq[name] = (freq[name] || 0) + 1;
        migrated.textNodes = freq;
      }
      out[key] = migrated;
    }
    return out;
  }

  _migrateGaps(v2Gaps) {
    const out = {};
    for (const [key, gap] of Object.entries(v2Gaps || {})) {
      out[key] = {
        status: 'open',
        resolvedBy: null,
        buildNumbers: [],
        ...gap,
      };
    }
    return out;
  }

  _migrateFromV2(v2) {
    const now = new Date().toISOString();
    const bucket = createEmptyLibraryBucket();
    bucket.idSource = 'legacy';
    bucket.components = this._migrateRecipes(v2.components || {});
    bucket.patterns = v2.patterns || {};
    bucket.gaps = this._migrateGaps(v2.gaps || {});
    bucket.buildHistory = v2.buildHistory || [];
    bucket.signals = v2.signals || [];
    bucket.manifests = [];
    bucket.meta = {
      buildCount: v2.meta?.buildCount || 0,
      lastBuild: v2.meta?.lastBuild || null,
      created: v2.meta?.created || now,
    };
    // v2 string fingerprint — kept under the existing `dsFingerprint` field
    // name (see createEmptyLibraryBucket comment). Conceptually this is the
    // spec's "legacyFingerprint": unusable for structured diffing, meant to
    // be discarded after the first v3 (structured) discovery.
    bucket.dsFingerprint = v2.dsFingerprint || null;

    const store = createEmptyStore();
    store.meta.migratedFrom = 2;
    store.meta.created = v2.meta?.created || now;
    store.libraries.__default__ = bucket;

    // Rules move to global scope with libraryId: null (spec §3.4 step 2).
    const rules = {};
    for (const [id, rule] of Object.entries(v2.rules || {})) {
      rules[id] = { ...rule, libraryId: rule.libraryId !== undefined ? rule.libraryId : null };
    }
    store.rules = rules;

    // libraryFileKeys becomes the alias seed table (spec §3.4 step 2) — kept
    // as the same global map shape for back-compat with getLibraryFileKey/
    // setLibraryFileKey, which resolve identity BEFORE any bucket exists.
    store.libraryFileKeys = { ...(v2.libraryFileKeys || {}) };

    return store;
  }

  _backupV2Once(rawV2Content) {
    try {
      const backupPath = path.join(path.dirname(this.filePath), 'knowledge.v2.backup.json');
      if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, rawV2Content, 'utf-8');
      }
    } catch { /* best effort */ }
  }

  _backfillV3() {
    if (!this._store.meta) this._store.meta = { created: new Date().toISOString(), migratedFrom: null, lastCompaction: null };
    if (!this._store.rules) this._store.rules = {};
    if (!this._store.libraryFileKeys) this._store.libraryFileKeys = {};
    if (!this._store.libraries) this._store.libraries = {};
    for (const bucket of Object.values(this._store.libraries)) {
      if (!bucket.components) bucket.components = {};
      if (!bucket.patterns) bucket.patterns = {};
      if (!bucket.gaps) bucket.gaps = {};
      if (!bucket.buildHistory) bucket.buildHistory = [];
      if (!bucket.signals) bucket.signals = [];
      if (!bucket.manifests) bucket.manifests = [];
      if (!bucket.aliases) bucket.aliases = [];
      if (!bucket.meta) bucket.meta = { buildCount: 0, lastBuild: null, created: new Date().toISOString() };
      if (bucket.dsFingerprint === undefined) bucket.dsFingerprint = null;
      if (bucket.fingerprint === undefined) bucket.fingerprint = null;
      for (const comp of Object.values(bucket.components)) {
        if (!comp.confidence) comp.confidence = 'new';
      }
    }
  }

  // ── Load / Save ─────────────────────────────────────────────────

  /**
   * Load existing store from disk. Creates empty store if file missing.
   * Migrates v2 -> v3 (writing back atomically + a one-time v2 backup).
   * Never throws — corrupt/unreadable/unsupported-version files recover
   * into a fresh store with a loud loadWarning instead (spec §3.1).
   */
  load() {
    try {
      return this._loadInner();
    } catch (err) {
      // Belt and braces: spec explicitly requires load() to never throw.
      // Any unexpected failure (including a bug in migration/backfill code)
      // degrades to the same recovery path as a corrupt file.
      return this._recoverFromCorruption('', `unexpected load error: ${err && err.message}`);
    }
  }

  _loadInner() {
    this.loadWarning = null;
    this.migrationNote = null;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        return this._recoverFromCorruption(raw, `invalid JSON: ${parseErr.message}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return this._recoverFromCorruption(raw, 'not a valid store object');
      }
      if (parsed.version === SCHEMA_VERSION) {
        this._store = parsed;
        this._backfillV3();
      } else if (parsed.version === 2) {
        this._store = this._migrateFromV2(parsed);
        this._backupV2Once(raw);
        this.migrationNote = 'Migrated knowledge store from schema v2 to v3 — all prior data moved into libraries.__default__ (rules moved to global scope).';
        // Write back immediately so a second load() of this same path sees
        // v3 directly and does not re-migrate (idempotent — spec acceptance
        // criterion 1).
        try { this._persist(this._store); } catch { /* best-effort */ }
      } else {
        return this._recoverFromCorruption(raw, `unsupported schema version: ${parsed.version}`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._store = createEmptyStore();
      } else {
        return this._recoverFromCorruption('', `read error: ${err.message}`);
      }
    }
    this.activeLibraryId = this.activeLibraryId || '__default__';
    this._captureSeenIds();
    this._syncDataView();
    return this;
  }

  _persist(store) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  _readDiskStoreRaw() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.version === SCHEMA_VERSION) return parsed;
      return null; // missing / corrupt / not-yet-migrated — nothing to merge against
    } catch {
      return null;
    }
  }

  _mergeRules(diskRules, memRules) {
    const ids = new Set([...Object.keys(diskRules || {}), ...Object.keys(memRules || {})]);
    const out = {};
    for (const id of ids) {
      const d = (diskRules || {})[id];
      const m = (memRules || {})[id];
      if (d && m) {
        const dTime = Date.parse(d.updatedAt || d.createdAt || 0) || 0;
        const mTime = Date.parse(m.updatedAt || m.createdAt || 0) || 0;
        out[id] = mTime >= dTime ? m : d;
      } else if (m) {
        out[id] = m;
      } else if (d) {
        // Disk-only. If this session previously saw this id (loaded it at
        // some point) and it's now absent from memory, that's an explicit
        // removeRule() — don't resurrect it. If this session never saw it,
        // it's another session's concurrent addition — keep it.
        if (this._seenRuleIds && this._seenRuleIds.has(id)) continue;
        out[id] = d;
      }
    }
    return out;
  }

  _sumVariantStats(a, b) {
    if (!a && !b) return undefined;
    const out = {};
    for (const prop of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      out[prop] = {};
      const av = (a && a[prop]) || {};
      const bv = (b && b[prop]) || {};
      for (const val of new Set([...Object.keys(av), ...Object.keys(bv)])) {
        out[prop][val] = (av[val] || 0) + (bv[val] || 0);
      }
    }
    return out;
  }

  /**
   * Merge a single recipe from disk and memory. Per spec §3.1: variantStats
   * counts are summed per value; buildCount takes the max. Everything else
   * not explicitly specified by the spec (instances, confidence, stale
   * flags, textNodes, slots, etc.) uses last-writer-wins in favor of the
   * in-memory (current save's) version — documented best-effort, per spec's
   * own "documented best-effort" framing for same-library concurrent saves.
   */
  _mergeRecipe(d, m) {
    const merged = { ...d, ...m };
    merged.buildCount = Math.max(d.buildCount || 0, m.buildCount || 0);
    merged.instances = Math.max(d.instances || 0, m.instances || 0);
    merged.names = [...new Set([...(d.names || []), ...(m.names || [])])];
    const variantStats = this._sumVariantStats(d.variantStats, m.variantStats);
    if (variantStats) merged.variantStats = variantStats;
    return merged;
  }

  _mergeRecipes(disk, mem, libraryId) {
    const keys = new Set([...Object.keys(disk || {}), ...Object.keys(mem || {})]);
    const out = {};
    const seen = libraryId != null ? this._seenRecipeKeys?.[libraryId] : null;
    for (const key of keys) {
      const d = (disk || {})[key];
      const m = (mem || {})[key];
      if (d && m) {
        out[key] = this._mergeRecipe(d, m);
      } else if (m) {
        out[key] = m;
      } else if (d) {
        // Same rationale as _mergeRules: don't resurrect a recipe this
        // session saw and then removed (e.g. claimByEvidence moving it out
        // of __default__ into another bucket).
        if (seen && seen.has(key)) continue;
        out[key] = d;
      }
    }
    return out;
  }

  _mergePatterns(disk, mem) {
    const keys = new Set([...Object.keys(disk || {}), ...Object.keys(mem || {})]);
    const out = {};
    for (const key of keys) {
      const d = (disk || {})[key];
      const m = (mem || {})[key];
      if (d && m) {
        out[key] = {
          ...d,
          ...m,
          buildCount: Math.max(d.buildCount || 0, m.buildCount || 0),
          occurrences: (d.occurrences || 0) + (m.occurrences || 0),
        };
      } else {
        out[key] = m || d;
      }
    }
    return out;
  }

  _mergeGaps(disk, mem) {
    const keys = new Set([...Object.keys(disk || {}), ...Object.keys(mem || {})]);
    const out = {};
    for (const key of keys) {
      const d = (disk || {})[key];
      const m = (mem || {})[key];
      if (d && m) {
        out[key] = {
          ...d,
          ...m,
          elements: [...new Set([...(d.elements || []), ...(m.elements || [])])],
          buildNumbers: [...new Set([...(d.buildNumbers || []), ...(m.buildNumbers || [])])].sort((a, b) => a - b),
        };
      } else {
        out[key] = m || d;
      }
    }
    return out;
  }

  _mergeCappedArray(diskArr, memArr, cap, keyFn) {
    const d = diskArr || [];
    const m = memArr || [];
    if (!keyFn) {
      return [...d, ...m].slice(-cap);
    }
    // Fast path: one array's sequence is a prefix of the other's — true in
    // the overwhelmingly common single-session case, since save() always
    // moves forward from whatever was last persisted. Taking the longer
    // array wholesale avoids any risk of the fallback dedup key colliding
    // (buildNumber can repeat when incrementBuildCount() didn't fire, and
    // date strings are only millisecond-resolution — two entries could
    // otherwise be misidentified as "the same" and one silently dropped).
    const shorter = d.length <= m.length ? d : m;
    const longer = d.length <= m.length ? m : d;
    const isPrefix = shorter.every((item, i) => keyFn(item) === keyFn(longer[i]));
    if (isPrefix) return longer.slice(-cap);

    // Fallback: genuinely divergent (concurrent) history — interleave and
    // dedup by identity key, later (mem) entries winning ties on a shared key.
    const seen = new Map();
    for (const item of [...d, ...m]) {
      seen.set(keyFn(item), item);
    }
    return [...seen.values()].slice(-cap);
  }

  _mergeLibraryBucket(disk, mem, libraryId) {
    return {
      libraryName: mem.libraryName ?? disk.libraryName ?? null,
      libraryFileKey: mem.libraryFileKey ?? disk.libraryFileKey ?? null,
      idSource: mem.idSource ?? disk.idSource ?? null,
      aliases: [...new Set([...(disk.aliases || []), ...(mem.aliases || [])])],
      fingerprint: mem.fingerprint ?? disk.fingerprint ?? null,
      dsFingerprint: mem.dsFingerprint ?? disk.dsFingerprint ?? null,
      components: this._mergeRecipes(disk.components, mem.components, libraryId),
      patterns: this._mergePatterns(disk.patterns, mem.patterns),
      gaps: this._mergeGaps(disk.gaps, mem.gaps),
      buildHistory: this._mergeCappedArray(disk.buildHistory, mem.buildHistory, 50, (h) => `${h.buildNumber}:${h.date}`),
      manifests: this._mergeCappedArray(disk.manifests, mem.manifests, 3, null),
      signals: this._mergeCappedArray(disk.signals, mem.signals, 200, (s) => `${s.type}:${s.key}:${s.buildNumber}`),
      meta: {
        buildCount: Math.max(disk.meta?.buildCount || 0, mem.meta?.buildCount || 0),
        lastBuild: laterDate(disk.meta?.lastBuild, mem.meta?.lastBuild),
        created: earlierDate(disk.meta?.created, mem.meta?.created),
      },
      // Ephemeral claim-by-evidence bookkeeping (see claimByEvidence) — not
      // part of the documented shape, carried through opportunistically so a
      // merge mid-claim doesn't lose progress. Harmless if absent.
      ...(disk.__originalRecipeCount !== undefined || mem.__originalRecipeCount !== undefined
        ? { __originalRecipeCount: mem.__originalRecipeCount ?? disk.__originalRecipeCount }
        : {}),
      ...(disk.__claimCounts || mem.__claimCounts
        ? { __claimCounts: { ...(disk.__claimCounts || {}), ...(mem.__claimCounts || {}) } }
        : {}),
    };
  }

  /**
   * Merge the in-memory store with whatever is currently on disk before
   * writing, at the library-bucket level (spec §3.1): a bucket touched only
   * by the OTHER session is carried forward untouched (last-writer-wins per
   * bucket); a bucket touched by both sessions gets the same-library merge
   * policy above. If disk has nothing usable (missing/corrupt/pre-v3), the
   * in-memory store is written as-is.
   */
  _mergeWithDisk(memStore) {
    const disk = this._readDiskStoreRaw();
    if (!disk) return memStore;

    const merged = {
      version: SCHEMA_VERSION,
      meta: {
        created: earlierDate(memStore.meta?.created, disk.meta?.created) || memStore.meta?.created || new Date().toISOString(),
        migratedFrom: memStore.meta?.migratedFrom ?? disk.meta?.migratedFrom ?? null,
        lastCompaction: memStore.meta?.lastCompaction ?? disk.meta?.lastCompaction ?? null,
      },
      rules: this._mergeRules(disk.rules, memStore.rules),
      libraryFileKeys: { ...(disk.libraryFileKeys || {}), ...(memStore.libraryFileKeys || {}) },
      libraries: {},
    };

    const allIds = new Set([...Object.keys(disk.libraries || {}), ...Object.keys(memStore.libraries || {})]);
    for (const id of allIds) {
      const diskBucket = disk.libraries?.[id];
      const memBucket = memStore.libraries?.[id];
      if (diskBucket && memBucket) {
        merged.libraries[id] = this._mergeLibraryBucket(diskBucket, memBucket, id);
      } else {
        merged.libraries[id] = memBucket || diskBucket;
      }
    }
    return merged;
  }

  /**
   * Persist current state to disk. Atomic: write to a temp file, then
   * rename over the target (unchanged from the pre-v3 implementation).
   * Extended per spec §3.1: re-loads the on-disk file first and merges at
   * the library-bucket level so two sessions on different DSs never
   * clobber each other's buckets.
   */
  save() {
    const merged = this._mergeWithDisk(this._store);
    this._store = merged;
    this._persist(merged);
    // The merged result is now the truth this session knows about — update
    // the seen-sets so a later save() in this same session correctly treats
    // anything just-merged-away-by-deletion as still deleted, and doesn't
    // misidentify genuinely-never-seen disk-only entries as deletions.
    this._captureSeenIds();
    this._syncDataView();
    return this;
  }

  // ── Components ──────────────────────────────────────────────

  setComponent(name, recipe) {
    if (recipe && recipe.confidence !== undefined && !VALID_CONFIDENCE_TIERS.has(recipe.confidence)) {
      throw new Error(
        `Invalid confidence tier: "${recipe.confidence}". Must be one of: ${[...VALID_CONFIDENCE_TIERS].filter((t) => t !== 'strong').join(', ')}.`
      );
    }
    if (recipe && recipe.variantStats !== undefined
        && (typeof recipe.variantStats !== 'object' || recipe.variantStats === null || Array.isArray(recipe.variantStats))) {
      throw new Error('variantStats must be an object of { property: { value: count } }.');
    }
    this.data.components[name] = {
      ...recipe,
      lastUsed: new Date().toISOString(),
    };
    return this;
  }

  getComponent(name) {
    return this.data.components[name] || null;
  }

  /**
   * True when this component key is recorded as removed from the live DS.
   * Recipes are keyed by componentKey or by name (with a componentKey field),
   * so check both forms. Used by discovery to skip dead keys and by the
   * stale-cache guard / status health line.
   */
  isComponentKeyRemoved(key) {
    if (!key) return false;
    const removed = (r) => Boolean(r && r.stale && r.staleReason === 'component_removed');
    if (removed(this.data.components?.[key])) return true;
    for (const recipe of Object.values(this.data.components || {})) {
      if (recipe.componentKey === key && removed(recipe)) return true;
    }
    return false;
  }

  /** How many of the given component keys are flagged component_removed. */
  countRemovedComponentKeys(keys) {
    let n = 0;
    for (const key of keys || []) {
      if (this.isComponentKeyRemoved(key)) n++;
    }
    return n;
  }

  /** Increment a variantStats observation count directly (helper for callers building up stats). */
  addVariantObservation(recipeKey, property, value, count = 1) {
    const recipe = this.data.components[recipeKey];
    if (!recipe) return this;
    if (!recipe.variantStats) recipe.variantStats = {};
    if (!recipe.variantStats[property]) recipe.variantStats[property] = {};
    recipe.variantStats[property][value] = (recipe.variantStats[property][value] || 0) + count;
    return this;
  }

  /**
   * Recompute `defaultVariants` on a stored recipe from its `variantStats`
   * (spec §5.1). `propertyTypes` is an optional hint (property -> VARIANT/
   * BOOLEAN/TEXT/...) since type info may not exist at store level.
   */
  recomputeDefaultVariants(recipeKey, propertyTypes) {
    const recipe = this.data.components[recipeKey];
    if (!recipe) return this;
    recipe.defaultVariants = deriveDefaultVariants(recipe, propertyTypes);
    return this;
  }

  /**
   * Dedup helper so buildCount increments exactly once per build regardless
   * of how many times a caller reports the same componentKey within that
   * build (fixes defect D: "Badge: On track" + "Badge: Plateau" in one
   * build must add +1, not +2).
   */
  recordComponentBuild(recipeKey, buildNumber) {
    const recipe = this.data.components[recipeKey];
    if (!recipe) return this;
    if (!recipe._buildCountedFor) recipe._buildCountedFor = [];
    if (recipe._buildCountedFor.includes(buildNumber)) return this;
    recipe._buildCountedFor.push(buildNumber);
    if (recipe._buildCountedFor.length > 50) recipe._buildCountedFor = recipe._buildCountedFor.slice(-50);
    recipe.buildCount = (recipe.buildCount || 0) + 1;
    return this;
  }

  // ── Confidence demotion (spec §4.6) — storage/logic only; wiring is Wave 5 ──

  /**
   * Demote a recipe in reaction to a detected DS change or a replay failure.
   * verified -> confirmed; sets needsReverify. Remembers the pre-demotion
   * tier so a subsequent clean replay can restore verified specifically
   * (confirmed recipes that were never verified should stay confirmed).
   */
  demoteRecipe(key, reason) {
    const recipe = this.data.components[key];
    if (!recipe) return this;
    if (recipe.confidence === 'verified') {
      recipe._preDemotionConfidence = 'verified';
      recipe.confidence = 'confirmed';
    }
    recipe.needsReverify = true;
    recipe.demotedAt = new Date().toISOString();
    if (reason) recipe.demoteReason = reason;
    return this;
  }

  /**
   * First subsequent build with a clean, validated replay restores verified
   * and clears needsReverify (spec §4.6).
   */
  restoreAfterCleanReplay(key) {
    const recipe = this.data.components[key];
    if (!recipe) return this;
    if (recipe.needsReverify) {
      recipe.needsReverify = false;
      if (recipe._preDemotionConfidence === 'verified') {
        recipe.confidence = 'verified';
      }
      delete recipe._preDemotionConfidence;
    }
    return this;
  }

  /**
   * Record a per-key replay failure. Any failure demotes verified ->
   * confirmed immediately. Two CONSECUTIVE failures on the same property
   * drop that property from defaultVariants and reset its variantStats
   * (targeted unlearning, not whole-recipe demolition) — fixes defect C.
   */
  recordReplayFailure(key, property) {
    const recipe = this.data.components[key];
    if (!recipe) return this;

    if (!recipe.failureLog) recipe.failureLog = [];
    recipe.failureLog.push({ type: 'variant_apply_failed', property, at: new Date().toISOString() });
    if (recipe.failureLog.length > 10) recipe.failureLog = recipe.failureLog.slice(-10);

    this.demoteRecipe(key, `replay_failure:${property}`);

    if (!recipe._consecutivePropertyFailures) recipe._consecutivePropertyFailures = {};
    recipe._consecutivePropertyFailures[property] = (recipe._consecutivePropertyFailures[property] || 0) + 1;

    if (recipe._consecutivePropertyFailures[property] >= 2) {
      if (recipe.defaultVariants) delete recipe.defaultVariants[property];
      if (recipe.variantStats) delete recipe.variantStats[property];
      recipe._consecutivePropertyFailures[property] = 0;
      if (!recipe._propertyDropped) recipe._propertyDropped = [];
      recipe._propertyDropped.push({ property, at: new Date().toISOString() });
    }
    return this;
  }

  /**
   * Clear the consecutive-failure counter for a property after a clean,
   * validated apply — otherwise an old, unrelated failure could combine
   * with a later one to falsely trigger the 2-strike drop.
   */
  recordReplaySuccess(key, property) {
    const recipe = this.data.components[key];
    if (!recipe) return this;
    if (recipe._consecutivePropertyFailures) recipe._consecutivePropertyFailures[property] = 0;
    return this;
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
      const merged = new Set([...(existing.elements || []), ...(gap.elements || [])]);
      existing.elements = [...merged];
      existing.evidence = gap.evidence || existing.evidence;
      existing.estimatedSavings = gap.estimatedSavings || existing.estimatedSavings;
      existing.lastSeen = new Date().toISOString();
      if (gap.buildNumbers) {
        existing.buildNumbers = [...new Set([...(existing.buildNumbers || []), ...gap.buildNumbers])];
      }
    } else {
      this.data.gaps[name] = {
        status: 'open',
        resolvedBy: null,
        buildNumbers: [],
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

  /** Mark a gap resolved-pending because a name-matching component appeared in the DS. */
  markGapResolvedPending(name, resolvedBy) {
    const gap = this.data.gaps[name];
    if (!gap) return this;
    gap.status = 'resolved-pending';
    gap.resolvedBy = resolvedBy || null;
    return this;
  }

  /** Mark a gap fully resolved because the resolving component was actually used. */
  markGapResolved(name) {
    const gap = this.data.gaps[name];
    if (!gap) return this;
    gap.status = 'resolved';
    return this;
  }

  // ── Rules ───────────────────────────────────────────────────
  // Global (never bucket-scoped): categories color/variable/structure/
  // component/spacing, plus a `libraryId` field (spec §3.3) — null means
  // the rule applies globally; a specific libraryId scopes it to that
  // library only. Default when unspecified: the active library if one is
  // set (and isn't the cold-start `__default__` bucket), else null (global).

  setRule(id, ruleData) {
    if (!this.data.rules) this.data.rules = {};
    const existing = this.data.rules[id];
    const hasActiveLibrary = this.activeLibraryId && this.activeLibraryId !== '__default__';
    const libraryId = ruleData.libraryId !== undefined
      ? ruleData.libraryId
      : (existing ? existing.libraryId ?? null : (hasActiveLibrary ? this.activeLibraryId : null));
    this.data.rules[id] = {
      ...ruleData,
      libraryId,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this;
  }

  getRule(id) {
    return this.data.rules?.[id] || null;
  }

  removeRule(id) {
    if (this.data.rules) delete this.data.rules[id];
    return this;
  }

  /**
   * Get all rules, optionally filtered by category. NOT library-scoped —
   * used for whole-store bookkeeping (e.g. no-good compilation dedup)
   * where every rule regardless of library must be visible.
   */
  getRules(category) {
    const rules = this.data.rules || {};
    if (!category) return { ...rules };
    const filtered = {};
    for (const [id, rule] of Object.entries(rules)) {
      if (rule.category === category) filtered[id] = rule;
    }
    return filtered;
  }

  /**
   * Rules currently in effect for the active library: active-status rules
   * (candidate/dismissed auto-compiled rules are excluded) that are either
   * global (`libraryId: null`) or scoped to the current active library.
   * Global-only when no library is active (cold start / __default__).
   *
   * Used both for point-of-use injection (findMatchingRules, below) and for
   * mimic_status's rule listing (status.js calls this directly) — so the
   * library-scoping guarantee (acceptance criterion 5) holds in both places
   * without needing to change status.js.
   */
  getActiveRules() {
    const rules = this.data.rules || {};
    const active = {};
    for (const [id, rule] of Object.entries(rules)) {
      if (rule.source && rule.status !== 'active') continue; // dismissed/candidate excluded
      const ruleLib = rule.libraryId !== undefined ? rule.libraryId : null;
      if (ruleLib !== null && ruleLib !== this.activeLibraryId) continue; // scoped to a different library
      active[id] = rule;
    }
    return active;
  }

  /**
   * Find rules relevant to a given context. Matches by:
   * - scope word-token match against context keywords
   * - category match
   * - rule text word-token match against any context keyword
   *
   * Uses whole-word (token) matching, not substring matching — a keyword
   * like "tab" must never match rule text mentioning "table". Keywords
   * that are themselves multi-word phrases (e.g. "card header") still
   * match when ALL of their words appear as whole tokens in the scope or
   * rule text, so multi-word phrase matching keeps working.
   *
   * Only considers rules from getActiveRules() — active status AND
   * library-scoped (global + current active library only).
   *
   * @param {string[]} keywords - Context words (e.g., ['card', 'revenue', 'badge'])
   * @param {string} [category] - Optional category filter
   * @returns {Array<{id: string, rule: string, category: string, reason?: string}>}
   */
  findMatchingRules(keywords, category) {
    const rules = this.getActiveRules();
    const keywordTokenSets = keywords
      .map(k => tokenize(k))
      .filter(toks => toks.length > 0);
    const matches = [];
    for (const [id, r] of Object.entries(rules)) {
      if (category && r.category !== category) continue;
      const scopeTokens = new Set(tokenize(r.scope));
      const ruleTokens = new Set(tokenize(r.rule));
      const hit = keywordTokenSets.some(toks => {
        // Multi-word keyword: match as a phrase — all its words must appear
        // as whole tokens in the same field (scope or rule text).
        if (toks.length > 1) {
          return toks.every(t => scopeTokens.has(t)) || toks.every(t => ruleTokens.has(t));
        }
        // Single-word keyword: whole-token match anywhere in scope or rule text.
        return scopeTokens.has(toks[0]) || ruleTokens.has(toks[0]);
      });
      if (hit) matches.push({ id, rule: r.rule, category: r.category, reason: r.reason });
    }
    return matches;
  }

  // ── Library File Keys (global, identity-resolution time) ────

  setLibraryFileKey(libraryName, fileKey) {
    if (!this.data.libraryFileKeys) this.data.libraryFileKeys = {};
    this.data.libraryFileKeys[libraryName] = fileKey;
    return this;
  }

  getLibraryFileKey(libraryName) {
    return this.data.libraryFileKeys?.[libraryName] || null;
  }

  // ── Library identity (spec §3.2) ─────────────────────────────

  /**
   * Rename a library bucket (e.g. a community "name:x" bucket becomes a
   * fileKey-identified bucket once the file key becomes known). Merges into
   * an existing bucket at `newId` if one already exists, using the same
   * merge policy as same-library concurrent saves. Records the old id as an
   * alias and preserves stats.
   */
  renameLibraryBucket(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return this;
    const oldBucket = this._store.libraries[oldId];
    if (!oldBucket) return this;

    const existingNew = this._store.libraries[newId];
    const merged = existingNew ? this._mergeLibraryBucket(existingNew, oldBucket) : { ...oldBucket };
    merged.aliases = [...new Set([...(merged.aliases || []), oldId])];
    if (!merged.idSource || merged.idSource === 'name') {
      merged.idSource = 'fileKey';
    }
    merged.libraryFileKey = merged.libraryFileKey || newId;

    this._store.libraries[newId] = merged;
    delete this._store.libraries[oldId];
    if (this.activeLibraryId === oldId) this.activeLibraryId = newId;
    this._syncDataView();
    return this;
  }

  /**
   * Sanity-check helper for name-keyed library identity collisions (spec
   * §3.2): if a large majority of a bucket's previously-observed
   * componentKeys are absent from a fresh discovery's live key set, this is
   * likely a DIFFERENT library that happens to share a name, not the same
   * one having changed. Storage-level signal only — callers (Wave 5) decide
   * whether to prompt the user rather than mass-staling everything.
   */
  checkLibraryIdentityDrift(libraryId, liveComponentKeys) {
    const bucket = this._store.libraries[libraryId];
    if (!bucket) return { possiblyDifferentLibrary: false };
    const storedKeys = Object.values(bucket.components || {})
      .map(r => r.componentKey)
      .filter(Boolean);
    if (storedKeys.length === 0) return { possiblyDifferentLibrary: false };
    const liveSet = liveComponentKeys instanceof Set ? liveComponentKeys : new Set(liveComponentKeys || []);
    const vanished = storedKeys.filter(k => !liveSet.has(k));
    const vanishedRatio = vanished.length / storedKeys.length;
    return {
      possiblyDifferentLibrary: vanishedRatio > 0.6,
      vanishedRatio,
      vanishedCount: vanished.length,
      totalStoredKeys: storedKeys.length,
    };
  }

  /**
   * Lazy claim-by-evidence migration (spec §3.4 step 4): every `__default__`
   * recipe whose componentKey exists in library L's live cache is moved
   * (not copied) into L's bucket. Once `__default__` has no recipes left,
   * its patterns/gaps/history are copied to whichever library claimed >=50%
   * of the original `__default__` recipe count, and `__default__` is
   * deleted. Safe against mixed-DS v2 stores: a recipe is claimed by at
   * most one library, ever.
   */
  claimByEvidence(libraryId, liveComponentKeys) {
    if (!libraryId || libraryId === '__default__') return { claimed: 0, claimedKeys: [] };
    const defaultBucket = this._store.libraries.__default__;
    if (!defaultBucket) return { claimed: 0, claimedKeys: [] };

    if (defaultBucket.__originalRecipeCount === undefined) {
      defaultBucket.__originalRecipeCount = Object.keys(defaultBucket.components).length;
      defaultBucket.__claimCounts = {};
    }

    const liveSet = liveComponentKeys instanceof Set ? liveComponentKeys : new Set(liveComponentKeys || []);
    const targetBucket = this._ensureBucket(libraryId);
    const claimedKeys = [];

    for (const [key, recipe] of Object.entries(defaultBucket.components)) {
      if (recipe.componentKey && liveSet.has(recipe.componentKey)) {
        targetBucket.components[key] = targetBucket.components[key]
          ? this._mergeRecipe(targetBucket.components[key], recipe)
          : recipe;
        delete defaultBucket.components[key];
        claimedKeys.push(key);
      }
    }

    if (claimedKeys.length > 0) {
      defaultBucket.__claimCounts[libraryId] = (defaultBucket.__claimCounts[libraryId] || 0) + claimedKeys.length;
    }

    const nowEmpty = Object.keys(defaultBucket.components).length === 0;
    if (nowEmpty && defaultBucket.__originalRecipeCount > 0 && this._store.libraries.__default__) {
      const total = defaultBucket.__originalRecipeCount;
      const entries = Object.entries(defaultBucket.__claimCounts || {})
        .map(([id, count]) => ({ id, count, ratio: count / total }))
        .sort((a, b) => b.ratio - a.ratio);
      const majority = entries.find(e => e.ratio >= 0.5);
      if (majority) {
        const heir = this._ensureBucket(majority.id);
        heir.patterns = { ...heir.patterns, ...defaultBucket.patterns };
        heir.gaps = { ...heir.gaps, ...defaultBucket.gaps };
        heir.buildHistory = [...(heir.buildHistory || []), ...(defaultBucket.buildHistory || [])].slice(-50);
        heir.signals = [...(heir.signals || []), ...(defaultBucket.signals || [])].slice(-200);
      }
      delete this._store.libraries.__default__;
      if (this.activeLibraryId === '__default__') this.activeLibraryId = libraryId;
    }

    this._syncDataView();
    return { claimed: claimedKeys.length, claimedKeys };
  }

  // ── Build History ───────────────────────────────────────────

  /**
   * Record a build snapshot for cross-build comparison.
   * Keeps the last 50 entries per library (spec §3.5 — was 20 in v2).
   */
  recordBuild({ screenName, toolCalls, cacheHits, replaySavings, componentCount, primitiveCount, bindingFailures, componentUsagePercent }) {
    if (!this.data.buildHistory) this.data.buildHistory = [];
    this.data.buildHistory.push({
      screenName,
      buildNumber: this.data.meta.buildCount + 1,
      date: new Date().toISOString(),
      toolCalls: toolCalls || 0,
      cacheHits: cacheHits || 0,
      replaySavings: replaySavings || 0,
      componentCount: componentCount || 0,
      primitiveCount: primitiveCount || 0,
      bindingFailures: bindingFailures || 0,
      componentUsagePercent: componentUsagePercent || 0,
    });
    if (this.data.buildHistory.length > 50) {
      this.data.buildHistory = this.data.buildHistory.slice(-50);
    }
    return this;
  }

  /** Returns build history array (most recent last). */
  getBuildHistory() {
    return this.data.buildHistory || [];
  }

  // ── Manifests (spec §3.3/§3.5 — last 3 build manifests per library) ──

  addManifest(manifest) {
    if (!this.data.manifests) this.data.manifests = [];
    this.data.manifests.push(manifest);
    if (this.data.manifests.length > 3) {
      this.data.manifests = this.data.manifests.slice(-3);
    }
    return this;
  }

  getManifests() {
    return this.data.manifests || [];
  }

  // ── Signals ─────────────────────────────────────────────────

  addSignal({ type, key, context, buildNumber }) {
    if (!this.data.signals) this.data.signals = [];
    const dedupKey = `${type}:${key}:${buildNumber}`;
    const exists = this.data.signals.some(
      s => `${s.type}:${s.key}:${s.buildNumber}` === dedupKey
    );
    if (exists) return this;
    this.data.signals.push({
      type, key, context, buildNumber,
      date: new Date().toISOString(),
    });
    if (this.data.signals.length > 200) {
      this.data.signals = this.data.signals.slice(-200);
    }
    return this;
  }

  getSignals() {
    return this.data.signals || [];
  }

  evictOldSignals(currentBuildNumber) {
    if (!this.data.signals) return this;
    const cutoff = currentBuildNumber - 20;
    this.data.signals = this.data.signals.filter(s => s.buildNumber > cutoff);
    return this;
  }

  // ── Staleness ───────────────────────────────────────────────

  markRecipeStale(key, reason) {
    const recipe = this.data.components[key];
    if (!recipe) return this;
    recipe.stale = true;
    recipe.staleReason = reason;
    recipe.staleAt = new Date().toISOString();
    return this;
  }

  clearRecipeStale(key) {
    const recipe = this.data.components[key];
    if (!recipe) return this;
    delete recipe.stale;
    delete recipe.staleReason;
    delete recipe.staleAt;
    return this;
  }

  checkStaleness(dsComponentKeys, dsVariantProperties) {
    const results = [];
    for (const [key, recipe] of Object.entries(this.data.components)) {
      if (!recipe.componentKey) continue;
      if (recipe.stale) continue;

      if (!dsComponentKeys.has(recipe.componentKey)) {
        this.markRecipeStale(key, 'component_removed');
        results.push({ key, names: recipe.names || [], reason: 'component_removed' });
        continue;
      }

      if (recipe.defaultVariants && dsVariantProperties[recipe.componentKey]) {
        const currentProps = Object.keys(dsVariantProperties[recipe.componentKey]);
        const storedProps = Object.keys(recipe.defaultVariants);
        const missing = storedProps.filter(p => !currentProps.includes(p));
        if (missing.length > 0) {
          this.markRecipeStale(key, 'variants_changed');
          results.push({ key, names: recipe.names || [], reason: 'variants_changed' });
        }
      }
    }
    return results;
  }

  // ── Meta ────────────────────────────────────────────────────

  incrementBuildCount() {
    this.data.meta.buildCount += 1;
    this.data.meta.lastBuild = new Date().toISOString();
    return this;
  }

  /**
   * Legacy v2 string fingerprint accessor — kept for discovery.js/status.js
   * (out of scope for this worker), which read/write `data.dsFingerprint`
   * directly. See createEmptyLibraryBucket for why this isn't renamed to
   * `legacyFingerprint`.
   */
  setFingerprint(fingerprint) {
    const bucket = this._activeBucket();
    bucket.dsFingerprint = fingerprint;
    this.data.dsFingerprint = fingerprint;
    return this;
  }

  getFingerprint() {
    return this.data.dsFingerprint;
  }

  /**
   * v3 structured fingerprint (spec §4.1) — storage only. Capture logic
   * (building the components/styles/variables sets + hash) is Wave 5's.
   */
  setStructuredFingerprint(fingerprint) {
    const bucket = this._activeBucket();
    bucket.fingerprint = fingerprint;
    this.data.fingerprint = fingerprint;
    return this;
  }

  getStructuredFingerprint() {
    return this._activeBucket().fingerprint || null;
  }
}

module.exports = { KnowledgeStore, SCHEMA_VERSION, computeLibraryId, deriveDefaultVariants };
