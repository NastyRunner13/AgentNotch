const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * UsageTracker — accumulates token/cost usage from live agent sessions into
 * persisted daily buckets keyed by (day, agent, model).
 *
 * Data sources are local session files only:
 *   Claude Code — message.usage on transcript entries (summed by the watcher)
 *   Codex       — token_count info.total_token_usage (cumulative per session)
 *   OpenCode    — session row token columns + actual cost (SQLite)
 *   Grok / Cursor / Antigravity expose no local token data, so they never
 *   appear here — the dashboard only shows what agents actually report.
 *
 * Watchers re-parse sessions continuously, so totals arrive as cumulative
 * snapshots. The tracker stores a high-water mark per session and only banks
 * the positive delta, which keeps re-ingestion idempotent and survives
 * restarts. (Claude tail-window parses can under-report for very long
 * sessions — a shrunk snapshot banks nothing, a recovered one banks the
 * difference. Values are estimates by design.)
 */

const RETENTION_DAYS = 90;
/** Snapshots for sessions not seen for this long are dropped. */
const SNAPSHOT_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Approximate list prices, USD per 1M tokens. Matched case-insensitively by
 * substring in order — keep specific entries before generic ones. Only used
 * when the harness does not report actual cost; real billing may differ.
 */
const MODEL_PRICING = [
  { match: 'claude-opus-4', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: 'claude-sonnet-4', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'claude-3-5-sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'claude-3-5-haiku', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  { match: 'claude-haiku', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: 'sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'opus', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: 'haiku', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: 'gpt-5-pro', input: 15, output: 120 },
  { match: 'gpt-5-codex', input: 1.25, output: 10, cacheRead: 0.125 },
  { match: 'gpt-5', input: 1.25, output: 10, cacheRead: 0.125 },
  { match: 'codex-mini', input: 1.5, output: 6, cacheRead: 0.375 },
  { match: 'o4-mini', input: 1.1, output: 4.4, cacheRead: 0.275 },
  { match: 'o3', input: 2, output: 8, cacheRead: 0.5 },
  { match: 'gemini-2.5-pro', input: 1.25, output: 10 },
  { match: 'gemini-2.5-flash', input: 0.3, output: 2.5 },
  { match: 'grok-code-fast', input: 0.2, output: 1.5, cacheRead: 0.02 },
  { match: 'grok-4', input: 3, output: 15, cacheRead: 0.75 },
  { match: 'grok-3', input: 3, output: 15 }
];

function findPricing(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const p of MODEL_PRICING) {
    if (m.includes(p.match)) return p;
  }
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function emptyTotals() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function normalizeTokens(t) {
  const out = emptyTotals();
  if (!t || typeof t !== 'object') return out;
  out.input = num(t.input);
  out.output = num(t.output);
  out.reasoning = num(t.reasoning);
  out.cacheRead = num(t.cacheRead);
  out.cacheWrite = num(t.cacheWrite);
  return out;
}

function totalsPositive(t) {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite > 0;
}

/** Local calendar day string (YYYY-MM-DD) for bucket keys. */
function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Estimated USD cost for one bucket of tokens at list prices.
 * Reasoning tokens are billed as output. Cache rates fall back to
 * input-derived defaults when the table omits them.
 * Returns null when the model has no known pricing.
 */
function estimateCost(model, t) {
  const p = findPricing(model);
  if (!p) return null;
  const cacheReadRate = p.cacheRead != null ? p.cacheRead : p.input * 0.1;
  const cacheWriteRate = p.cacheWrite != null ? p.cacheWrite : p.input * 1.25;
  return (t.input / 1e6) * p.input
    + ((t.output + t.reasoning) / 1e6) * p.output
    + (t.cacheRead / 1e6) * cacheReadRate
    + (t.cacheWrite / 1e6) * cacheWriteRate;
}

class UsageTracker {
  /**
   * @param {{ dataPath?: string, now?: () => number }} opts
   *   dataPath — defaults to ~/.agent-notch/usage-stats.json (inject for tests)
   *   now      — clock override for tests
   */
  constructor(opts = {}) {
    this._dataPath = opts.dataPath || path.join(os.homedir(), '.agent-notch', 'usage-stats.json');
    this._now = opts.now || (() => Date.now());
    /** sessionId → { day, agent, model, totals, cost, seenAt } */
    this._snapshots = new Map();
    /** `${day}|${agent}|${model}` → { day, agent, model, totals, cost, sess: {} } */
    this._buckets = new Map();
    this._dirty = false;
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this._dataPath)) return;
      const data = JSON.parse(fs.readFileSync(this._dataPath, 'utf-8'));
      if (data && data.version === 1) {
        for (const [id, snap] of Object.entries(data.sessions || {})) {
          this._snapshots.set(id, {
            day: snap.day || dayKey(this._now()),
            agent: snap.agent || 'Unknown',
            model: snap.model ?? null,
            totals: normalizeTokens(snap.totals),
            cost: num(snap.cost),
            seenAt: num(snap.seenAt) || this._now()
          });
        }
        for (const [key, b] of Object.entries(data.buckets || {})) {
          this._buckets.set(key, {
            day: b.day,
            agent: b.agent,
            model: b.model ?? null,
            totals: normalizeTokens(b.totals),
            cost: num(b.cost),
            sess: b.sess && typeof b.sess === 'object' ? b.sess : {}
          });
        }
      }
    } catch (err) {
      console.warn('[UsageTracker] Failed to load stats:', err.message);
      this._snapshots.clear();
      this._buckets.clear();
    }
    this._prune();
  }

  /**
   * Ingest the current live-session list. Idempotent: only positive deltas
   * over each session's high-water mark are banked.
   * @param {Array<object>} sessions
   * @returns {boolean} true when any bucket changed
   */
  ingest(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) return false;
    const now = this._now();
    const today = dayKey(now);
    let changed = false;

    for (const s of sessions) {
      if (!s || !s.id || !s.agent) continue;
      const totals = normalizeTokens(s.tokens);
      const cost = num(s.cost);
      // Sessions without any usage signal contribute nothing (Grok/Cursor/…)
      if (!totalsPositive(totals) && cost <= 0) continue;

      const prev = this._snapshots.get(s.id);
      const model = typeof s.model === 'string' && s.model ? s.model : (prev?.model ?? null);

      if (!prev) {
        // First sighting: bank the full cumulative snapshot.
        const snap = { day: today, agent: s.agent, model, totals, cost, seenAt: now };
        this._snapshots.set(s.id, snap);
        this._bank(today, s.agent, model, totals, cost, s.id);
        changed = true;
        continue;
      }

      // High-water mark per field — sliding-window re-parses can shrink a
      // snapshot; never bank negative movement, keep the max.
      const delta = emptyTotals();
      let any = false;
      for (const k of Object.keys(delta)) {
        const d = totals[k] - prev.totals[k];
        if (d > 0) { delta[k] = d; any = true; }
      }
      const costDelta = cost - prev.cost;
      if (costDelta > 0) any = true;

      prev.totals = {
        input: Math.max(prev.totals.input, totals.input),
        output: Math.max(prev.totals.output, totals.output),
        reasoning: Math.max(prev.totals.reasoning, totals.reasoning),
        cacheRead: Math.max(prev.totals.cacheRead, totals.cacheRead),
        cacheWrite: Math.max(prev.totals.cacheWrite, totals.cacheWrite)
      };
      prev.cost = Math.max(prev.cost, cost);
      prev.seenAt = now;
      if (model) prev.model = model;

      if (any) {
        this._bank(today, s.agent, prev.model, delta, Math.max(0, costDelta), s.id);
        changed = true;
      }
    }

    if (changed) {
      this._dirty = true;
      this._scheduleSave();
    }
    return changed;
  }

  _bank(day, agent, model, delta, costDelta, sessionId) {
    const key = `${day}|${agent}|${model || ''}`;
    let b = this._buckets.get(key);
    if (!b) {
      b = { day, agent, model: model || null, totals: emptyTotals(), cost: 0, sess: {} };
      this._buckets.set(key, b);
    }
    for (const k of Object.keys(b.totals)) b.totals[k] += delta[k];
    b.cost += costDelta;
    if (sessionId) b.sess[sessionId] = 1;
  }

  /** Drop buckets outside retention and snapshots for long-dead sessions. */
  _prune() {
    const now = this._now();
    const cutoff = dayKey(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    for (const [key, b] of this._buckets) {
      if (b.day < cutoff) this._buckets.delete(key);
    }
    for (const [id, snap] of this._snapshots) {
      if (now - snap.seenAt > SNAPSHOT_STALE_MS) this._snapshots.delete(id);
    }
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Persist immediately (also called by the debounced timer). */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._dirty) return;
    try {
      const dir = path.dirname(this._dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this._prune();
      const sessions = {};
      for (const [id, snap] of this._snapshots) sessions[id] = snap;
      const buckets = {};
      for (const [key, b] of this._buckets) buckets[key] = b;
      fs.writeFileSync(this._dataPath, JSON.stringify({
        version: 1,
        updatedAt: this._now(),
        sessions,
        buckets
      }));
      this._dirty = false;
    } catch (err) {
      console.warn('[UsageTracker] Failed to save stats:', err.message);
    }
  }

  /**
   * Flat bucket list for the renderer. Cost is resolved here: actual
   * harness-reported cost wins, otherwise list-price estimate.
   *   cost        — USD (0 when neither actual nor estimable)
   *   costKnown   — true when cost reflects a real price (actual or priced)
   *   costActual  — true when reported by the harness (not estimated)
   * @returns {{ updatedAt: number, buckets: Array<object> }}
   */
  getStats() {
    const buckets = [];
    for (const b of this._buckets.values()) {
      const total = b.totals.input + b.totals.output + b.totals.reasoning
        + b.totals.cacheRead + b.totals.cacheWrite;
      const est = estimateCost(b.model, b.totals);
      const actual = b.cost > 0;
      buckets.push({
        day: b.day,
        agent: b.agent,
        model: b.model,
        input: b.totals.input,
        output: b.totals.output,
        reasoning: b.totals.reasoning,
        cacheRead: b.totals.cacheRead,
        cacheWrite: b.totals.cacheWrite,
        total,
        sessions: Object.keys(b.sess).length,
        cost: actual ? b.cost : (est || 0),
        costActual: actual,
        costKnown: actual || est != null
      });
    }
    // Most recent first, then biggest bucket first within a day
    buckets.sort((a, b) => (a.day === b.day ? b.total - a.total : (a.day < b.day ? 1 : -1)));
    return { updatedAt: this._now(), buckets };
    }
}

module.exports = {
  UsageTracker,
  estimateCost,
  findPricing,
  dayKey,
  MODEL_PRICING
};
