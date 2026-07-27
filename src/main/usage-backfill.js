const fs = require('fs');
const path = require('path');
const os = require('os');
const { dayKey } = require('./usage-stats');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  // Node < 22.5 — OpenCode backfill unavailable, file scanners still work
}

/**
 * UsageBackfill — one-shot full-history scanner that reconstructs per-day
 * token/cost/session-time from on-disk agent records so the dashboard shows
 * past dates instead of only accumulating from first run.
 *
 * Sources (all local files, read-only):
 *   Claude Code — ~/.claude/projects/<proj>/(sessions/)?<id>.jsonl
 *     message.usage per assistant entry, deduped by message id (streaming
 *     writes repeat the same message across lines)
 *   Codex       — ~/.codex/sessions/**​/rollout-*.jsonl
 *     token_count events carry cumulative total_token_usage; per-event
 *     deltas are attributed to the event's own day
 *   OpenCode    — opencode.db session rows (cumulative token columns + cost)
 *     attributed to the time_updated day (no per-day breakdown available)
 *
 * Grok / Cursor / Antigravity expose no local token data — nothing to scan.
 *
 * Every record carries the same session id the live watcher uses, so the
 * tracker's high-water marks line up between backfill and live ingestion.
 */

/** Skip absurdly large transcript files (corrupt or logs, not sessions). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_DEPTH = 4;

function emptyTotals() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function parseTs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') {
    const t = ts > 1e12 ? ts : ts * 1000;
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  const t = new Date(ts).getTime();
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Read a whole JSONL file as text, or null when unreadable/too large. */
function readWholeFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function newRecord(id, agent) {
  return {
    id,
    agent,
    /** Map `${day}|${model}` → { day, model, tokens, cost } */
    days: new Map(),
    /** Map day → { min, max } entry timestamps for session-time spans */
    spans: new Map()
  };
}

function bumpSpan(rec, day, ts) {
  let s = rec.spans.get(day);
  if (!s) {
    s = { min: ts, max: ts };
    rec.spans.set(day, s);
  } else {
    if (ts < s.min) s.min = ts;
    if (ts > s.max) s.max = ts;
  }
}

function bankTokens(rec, day, model, tokens, cost = 0) {
  const key = `${day}|${model || ''}`;
  let e = rec.days.get(key);
  if (!e) {
    e = { day, model: model || null, tokens: emptyTotals(), cost: 0 };
    rec.days.set(key, e);
  }
  for (const k of Object.keys(e.tokens)) e.tokens[k] += tokens[k] || 0;
  e.cost += cost;
}

/** Finalize a record: convert spans to msByDay, days Map to array. */
function finalizeRecord(rec) {
  const msByDay = {};
  for (const [day, s] of rec.spans) {
    if (s.max > s.min) msByDay[day] = s.max - s.min;
  }
  return {
    id: rec.id,
    agent: rec.agent,
    days: [...rec.days.values()],
    msByDay
  };
}

function hasContent(rec) {
  return rec.days.size > 0 || rec.spans.size > 0;
}

/* ── Claude Code ─────────────────────────────────────── */

function scanClaudeFile(filePath) {
  const content = readWholeFile(filePath);
  if (!content) return null;

  const rec = newRecord(`claude-${path.basename(filePath, '.jsonl')}`, 'Claude Code');
  const seenUsageIds = new Set();

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = parseTs(entry.timestamp || entry.created_at);
    const day = ts ? dayKey(ts) : null;
    if (day) bumpSpan(rec, day, ts);

    const type = entry.type || entry.role || '';
    if (type !== 'assistant' || !entry.message || typeof entry.message !== 'object') continue;

    const usage = entry.message.usage;
    if (!usage || typeof usage !== 'object' || !day) continue;

    // Streaming writes repeat the same message across lines — count once
    const msgId = typeof entry.message.id === 'string' ? entry.message.id : null;
    if (msgId && seenUsageIds.has(msgId)) continue;
    if (msgId) seenUsageIds.add(msgId);

    const model = (typeof entry.message.model === 'string' && entry.message.model)
      || (typeof entry.model === 'string' && entry.model)
      || null;

    bankTokens(rec, day, model, {
      input: Number(usage.input_tokens) || 0,
      output: Number(usage.output_tokens) || 0,
      reasoning: 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
      cacheWrite: Number(usage.cache_creation_input_tokens) || 0
    });
  }

  return hasContent(rec) ? finalizeRecord(rec) : null;
}

/* ── Codex ───────────────────────────────────────────── */

/** Map Codex total_token_usage to tracker shape (cached ⊂ input, reasoning ⊂ output). */
function mapCodexUsage(u) {
  const input = Number(u.input_tokens) || 0;
  const cached = Number(u.cached_input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const reasoning = Number(u.reasoning_output_tokens) || 0;
  return {
    input: Math.max(0, input - cached),
    output: Math.max(0, output - reasoning),
    reasoning,
    cacheRead: cached,
    cacheWrite: Number(u.cache_write_input_tokens) || 0
  };
}

function scanCodexFile(filePath) {
  const content = readWholeFile(filePath);
  if (!content) return null;

  const rec = newRecord(`codex-${path.basename(filePath, '.jsonl')}`, 'Codex');
  let prev = null; // cumulative snapshot from the previous token_count event
  let currentModel = null;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;

    const ts = parseTs(entry.timestamp || entry.created_at || entry.ts);
    const day = ts ? dayKey(ts) : null;
    if (day) bumpSpan(rec, day, ts);

    if (typeof payload.model === 'string' && payload.model) {
      currentModel = payload.model;
    }

    if (payload.type !== 'token_count' || !day) continue;
    const usage = payload.info && payload.info.total_token_usage;
    if (!usage || typeof usage !== 'object') continue;

    const cur = mapCodexUsage(usage);
    if (prev) {
      const delta = emptyTotals();
      let any = false;
      for (const k of Object.keys(delta)) {
        delta[k] = Math.max(0, cur[k] - prev[k]);
        if (delta[k] > 0) any = true;
      }
      if (any) bankTokens(rec, day, currentModel, delta);
    } else {
      // First event of the file: treat as a full cumulative sighting
      bankTokens(rec, day, currentModel, cur);
    }
    // High-water per field — a reset mid-file never produces negative banking
    prev = {
      input: Math.max(prev ? prev.input : 0, cur.input),
      output: Math.max(prev ? prev.output : 0, cur.output),
      reasoning: Math.max(prev ? prev.reasoning : 0, cur.reasoning),
      cacheRead: Math.max(prev ? prev.cacheRead : 0, cur.cacheRead),
      cacheWrite: Math.max(prev ? prev.cacheWrite : 0, cur.cacheWrite)
    };
  }

  return hasContent(rec) ? finalizeRecord(rec) : null;
}

/* ── OpenCode ────────────────────────────────────────── */

function scanOpencodeDb(dbPath) {
  if (!sqlite) return [];
  let db;
  const records = [];
  try {
    db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
    const rows = db.prepare(
      'SELECT id, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session'
    ).all();

    for (const row of rows) {
      const updated = Number(row.time_updated) || 0;
      if (!updated) continue;
      const day = dayKey(updated);

      let model = null;
      try {
        const m = typeof row.model === 'string' ? JSON.parse(row.model) : row.model;
        model = m?.modelID || m?.id || m?.name || null;
      } catch {
        // ignore
      }

      const rec = newRecord(`opencode-${row.id}`, 'OpenCode');
      bankTokens(rec, day, model, {
        input: Number(row.tokens_input) || 0,
        output: Number(row.tokens_output) || 0,
        reasoning: Number(row.tokens_reasoning) || 0,
        cacheRead: Number(row.tokens_cache_read) || 0,
        cacheWrite: Number(row.tokens_cache_write) || 0
      }, Number(row.cost) || 0);

      const created = Number(row.time_created) || updated;
      if (updated > created) {
        bumpSpan(rec, day, created);
        bumpSpan(rec, day, updated);
      }
      records.push(finalizeRecord(rec));
    }
  } catch (err) {
    console.warn('[UsageBackfill] OpenCode scan failed:', err.message);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return records;
}

/* ── Orchestrator ────────────────────────────────────── */

function antigravityConversationId(filePath) {
  const parts = filePath.split(/[\\/]/);
  const idx = parts.lastIndexOf('.system_generated');
  return idx > 0 ? parts[idx - 1] : null;
}

function scanAntigravityFile(filePath) {
  const base = path.basename(filePath);
  if (base !== 'transcript.jsonl' && base !== 'transcript_full.jsonl') return null;

  const conversationId = antigravityConversationId(filePath);
  if (!conversationId) return null;

  const content = readWholeFile(filePath);
  if (!content) return null;

  const rec = newRecord(`antigravity-${conversationId}`, 'Antigravity');

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = parseTs(entry.created_at || entry.timestamp || entry.ts);
    if (!ts) continue;
    bumpSpan(rec, dayKey(ts), ts);
  }

  return hasContent(rec) ? finalizeRecord(rec) : null;
}

function* walkJsonl(rootDir, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(full, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield full;
    }
  }
}

/**
 * Scan all known agent data roots. Injectable paths for tests.
 *
 * @param {{ claudeProjectsDir?: string, codexSessionsDir?: string,
 *   antigravityBrainDir?: string, opencodeDbPaths?: string[] }} [opts]
 * @returns {{ records: Array<object>, files: number, errors: number }}
 */
function scanUsageHistory(opts = {}) {
  const home = os.homedir();
  const claudeProjectsDir = opts.claudeProjectsDir || path.join(home, '.claude', 'projects');
  const codexSessionsDir = opts.codexSessionsDir || path.join(home, '.codex', 'sessions');
  const antigravityBrainDir = opts.antigravityBrainDir ||
    path.join(home, '.gemini', 'antigravity-ide', 'brain');
  const opencodeDbPaths = opts.opencodeDbPaths || [
    path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'opencode', 'opencode.db') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db') : null
  ].filter(Boolean);

  const byId = new Map(); // first sighting wins — dup basenames are the same session
  let files = 0;
  let errors = 0;

  const collect = (filePath, scanner) => {
    files++;
    try {
      const rec = scanner(filePath);
      if (rec && !byId.has(rec.id)) byId.set(rec.id, rec);
    } catch {
      errors++;
    }
  };

  for (const filePath of walkJsonl(claudeProjectsDir)) collect(filePath, scanClaudeFile);
  for (const filePath of walkJsonl(codexSessionsDir)) collect(filePath, scanCodexFile);
  for (const filePath of walkJsonl(antigravityBrainDir)) collect(filePath, scanAntigravityFile);

  for (const dbPath of opencodeDbPaths) {
    try {
      if (!fs.existsSync(dbPath)) continue;
    } catch {
      continue;
    }
    for (const rec of scanOpencodeDb(dbPath)) {
      if (!byId.has(rec.id)) byId.set(rec.id, rec);
    }
  }

  return { records: [...byId.values()], files, errors };
}

module.exports = {
  scanUsageHistory,
  scanClaudeFile,
  scanCodexFile,
  scanAntigravityFile,
  scanOpencodeDb,
  mapCodexUsage
};
