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
/** Historical per-session time attribution older than this is dropped. */
const DAYSESS_STALE_DAYS = RETENTION_DAYS;

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
    /** sessionId → { day, agent, model, totals, cost, seenAt, hist? } */
    this._snapshots = new Map();
    /** `${day}|${agent}|${model}` → { day, agent, model, totals, cost, sess: {} } */
    this._buckets = new Map();
    /** `${day}|${agent}|${sessionId}` → { day, agent, id, ms } — historical session time */
    this._daySess = new Map();
    /** Last full-history backfill scan (ms epoch), 0 = never */
    this.lastBackfillAt = 0;
    /** Scanner schema version last applied to persisted history. */
    this.lastBackfillVersion = 0;
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
            seenAt: num(snap.seenAt) || this._now(),
            hist: snap.hist && typeof snap.hist === 'object' ? snap.hist : undefined
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
        for (const [key, e] of Object.entries(data.daySessions || {})) {
          this._daySess.set(key, {
            day: e.day,
            agent: e.agent,
            id: e.id,
            ms: num(e.ms)
          });
        }
        this.lastBackfillAt = num(data.lastBackfillAt);
        this.lastBackfillVersion = num(data.lastBackfillVersion);
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

  /**
   * Bank historical per-day usage for one session, from a full scan of its
   * on-disk records (usage-backfill). Idempotent: per-(session, day, model)
   * high-water marks mean a re-scan only banks newly appended tokens.
   *
   * Startup-race safety: if live `ingest` already banked this session's
   * cumulative snapshot into "today" before the scan ran, that banked amount
   * is credited against the scanned per-day sums (most recent days first —
   * the live tail window covers recent activity), so the same tokens are
   * never counted twice.
   *
   * Also raises the live high-water mark to the scanned cumulative total, so
   * subsequent live ingestion banks only genuinely new tokens.
   *
   * @param {{ id: string, agent: string,
   *   days: Array<{ day: string, model: string|null, tokens: object, cost?: number }>,
   *   msByDay?: Object<string, number> }} record
   * @returns {boolean} true when any bucket changed
   */
  ingestHistorical(record) {
    if (!record || !record.id || !record.agent || !Array.isArray(record.days)) return false;
    const now = this._now();
    const days = record.days
      .filter(d => d && typeof d.day === 'string')
      .map(d => ({ day: d.day, model: d.model ?? null, tokens: normalizeTokens(d.tokens), cost: num(d.cost) }))
      .filter(d => totalsPositive(d.tokens) || d.cost > 0)
      .sort((a, b) => (a.day < b.day ? 1 : -1)); // most recent first for crediting
    if (days.length === 0 && !record.msByDay) return false;

    let snap = this._snapshots.get(record.id);

    // Credit what live ingest already banked (only on first historical sighting)
    const credit = snap && !snap.hist
      ? { ...snap.totals, cost: snap.cost }
      : null;

    const hist = snap?.hist ? { ...snap.hist } : {};
    let changed = false;

    for (const d of days) {
      const t = { ...d.tokens };
      let cost = d.cost;
      if (credit) {
        for (const k of Object.keys(t)) {
          const c = Math.min(t[k], credit[k]);
          t[k] -= c;
          credit[k] -= c;
        }
        const cc = Math.min(cost, credit.cost);
        cost -= cc;
        credit.cost -= cc;
      }

      const hk = `${d.day}|${d.model || ''}`;
      const banked = hist[hk] || { totals: emptyTotals(), cost: 0 };
      const delta = emptyTotals();
      let any = false;
      for (const k of Object.keys(delta)) {
        const dv = t[k] - banked.totals[k];
        if (dv > 0) { delta[k] = dv; any = true; }
      }
      const costDelta = cost - banked.cost;
      if (costDelta > 0) any = true;

      if (any) {
        hist[hk] = {
          totals: {
            input: Math.max(banked.totals.input, t.input),
            output: Math.max(banked.totals.output, t.output),
            reasoning: Math.max(banked.totals.reasoning, t.reasoning),
            cacheRead: Math.max(banked.totals.cacheRead, t.cacheRead),
            cacheWrite: Math.max(banked.totals.cacheWrite, t.cacheWrite)
          },
          cost: Math.max(banked.cost, cost)
        };
        this._bank(d.day, record.agent, d.model, delta, Math.max(0, costDelta), record.id);
        changed = true;
      } else if (!hist[hk]) {
        hist[hk] = { totals: { ...t }, cost };
      }
    }

    // Raise (or create) the live high-water mark to the scanned cumulative sum
    const scanned = emptyTotals();
    let scannedCost = 0;
    for (const d of days) {
      for (const k of Object.keys(scanned)) scanned[k] += d.tokens[k];
      scannedCost += d.cost;
    }
    if (!snap) {
      snap = {
        day: dayKey(now),
        agent: record.agent,
        model: days[0]?.model ?? null,
        totals: scanned,
        cost: scannedCost,
        seenAt: now,
        hist
      };
      this._snapshots.set(record.id, snap);
      if (totalsPositive(scanned) || scannedCost > 0) changed = true;
    } else {
      for (const k of Object.keys(snap.totals)) {
        snap.totals[k] = Math.max(snap.totals[k], scanned[k]);
      }
      snap.cost = Math.max(snap.cost, scannedCost);
      snap.seenAt = now;
      snap.hist = hist;
    }

    // Session time per day (max wins — re-scans stay idempotent)
    if (record.msByDay && typeof record.msByDay === 'object') {
      for (const [day, ms] of Object.entries(record.msByDay)) {
        const v = num(ms);
        if (!v) continue;
        const key = `${day}|${record.agent}|${record.id}`;
        const prev = this._daySess.get(key);
        if (!prev || v > prev.ms) {
          this._daySess.set(key, { day, agent: record.agent, id: record.id, ms: v });
          changed = true;
        }
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
      // Snapshots carrying historical high-water marks must survive — dropping
      // one would make the next backfill re-bank that session's whole history.
      if (snap.hist) continue;
      if (now - snap.seenAt > SNAPSHOT_STALE_MS) this._snapshots.delete(id);
    }
    for (const [key, e] of this._daySess) {
      if (e.day < cutoff) this._daySess.delete(key);
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
      const daySessions = {};
      for (const [key, e] of this._daySess) daySessions[key] = e;
      fs.writeFileSync(this._dataPath, JSON.stringify({
        version: 1,
        updatedAt: this._now(),
        lastBackfillAt: this.lastBackfillAt || 0,
        lastBackfillVersion: this.lastBackfillVersion || 0,
        sessions,
        buckets,
        daySessions
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
   * @param {{ excludeIds?: Set<string> }} [opts]
   *   excludeIds — session ids to skip in sessionDays (the caller already
   *   accounts for them via live sessions / history; avoids double counting)
   * @returns {{ updatedAt: number, buckets: Array<object>,
   *   sessionDays: Array<{day:string, agent:string, sessions:number, ms:number}> }}
   */
  getStats(opts = {}) {
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

    // Historical session time, grouped per day+agent
    const exclude = opts.excludeIds instanceof Set ? opts.excludeIds : null;
    const dayAgentMap = new Map();
    for (const e of this._daySess.values()) {
      if (exclude && exclude.has(e.id)) continue;
      const key = `${e.day}|${e.agent}`;
      let g = dayAgentMap.get(key);
      if (!g) {
        g = { day: e.day, agent: e.agent, sessions: 0, ms: 0 };
        dayAgentMap.set(key, g);
      }
      g.sessions += 1;
      g.ms += e.ms;
    }
    const sessionDays = [...dayAgentMap.values()]
      .sort((a, b) => (a.day < b.day ? 1 : -1));

    return { updatedAt: this._now(), buckets, sessionDays };
    }
}

module.exports = {
  UsageTracker,
  estimateCost,
  findPricing,
  dayKey,
  MODEL_PRICING
};
