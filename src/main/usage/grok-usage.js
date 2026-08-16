const fs = require('fs');
const { dayKey } = require('./usage-stats');

/**
 * Grok Build writes per-turn token counts to ~/.grok/logs/unified.jsonl:
 *   msg = "shell.turn.inference_done"
 *   ctx.prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_tokens
 *   sid = session folder name (watcher id is grok-<sid>)
 *
 * Turns are incremental (not cumulative). Cached ⊂ prompt; reasoning ⊂ completion.
 */

function emptyTotals() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function mapGrokTurn(ctx) {
  const prompt = Number(ctx && ctx.prompt_tokens) || 0;
  const cached = Number(ctx && ctx.cached_prompt_tokens) || 0;
  const completion = Number(ctx && ctx.completion_tokens) || 0;
  const reasoning = Number(ctx && ctx.reasoning_tokens) || 0;
  return {
    input: Math.max(0, prompt - cached),
    output: Math.max(0, completion - reasoning),
    reasoning,
    cacheRead: cached,
    cacheWrite: 0
  };
}

function parseGrokLogLine(line) {
  if (!line || !line.includes('inference_done')) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.msg !== 'shell.turn.inference_done') return null;
  const ctx = entry.ctx && typeof entry.ctx === 'object' ? entry.ctx : {};
  const sid = entry.sid || ctx.sid;
  if (!sid || typeof sid !== 'string') return null;
  const tokens = mapGrokTurn(ctx);
  if (tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead <= 0) return null;
  const ts = entry.ts ? Date.parse(entry.ts) : 0;
  return {
    sid,
    ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
    tokens,
    model: typeof ctx.model === 'string' ? ctx.model
      : (typeof ctx.model_id === 'string' ? ctx.model_id : null)
  };
}

function newRecord(sid) {
  return {
    id: `grok-${sid}`,
    agent: 'Grok',
    days: new Map(),
    spans: new Map(),
    model: null
  };
}

function bankTurn(rec, ev) {
  if (ev.model) rec.model = ev.model;
  const day = ev.ts ? dayKey(ev.ts) : null;
  if (!day) return;
  const key = `${day}|${rec.model || ''}`;
  let e = rec.days.get(key);
  if (!e) {
    e = { day, model: rec.model || null, tokens: emptyTotals(), cost: 0 };
    rec.days.set(key, e);
  } else if (rec.model && !e.model) {
    e.model = rec.model;
  }
  for (const k of Object.keys(e.tokens)) e.tokens[k] += ev.tokens[k] || 0;

  let span = rec.spans.get(day);
  if (!span) {
    rec.spans.set(day, { last: ev.ts, ms: 0 });
  } else {
    const gap = ev.ts - span.last;
    if (gap > 0) span.ms += Math.min(gap, 15 * 60 * 1000);
    if (ev.ts > span.last) span.last = ev.ts;
  }
}

function finalizeRecord(rec) {
  const msByDay = {};
  for (const [day, s] of rec.spans) {
    if (s.ms > 0) msByDay[day] = s.ms;
  }
  return {
    id: rec.id,
    agent: rec.agent,
    days: [...rec.days.values()],
    msByDay
  };
}

/**
 * Full scan of unified.jsonl → one historical record per session sid.
 */
function scanGrokLog(logPath) {
  let content;
  try {
    const stat = fs.statSync(logPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 64 * 1024 * 1024) return [];
    content = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }

  const bySid = new Map();
  for (const line of content.split(/\r?\n/)) {
    const ev = parseGrokLogLine(line);
    if (!ev) continue;
    let rec = bySid.get(ev.sid);
    if (!rec) {
      rec = newRecord(ev.sid);
      bySid.set(ev.sid, rec);
    }
    bankTurn(rec, ev);
  }

  const records = [];
  for (const rec of bySid.values()) {
    if (rec.days.size > 0) records.push(finalizeRecord(rec));
  }
  return records;
}

/**
 * Incremental index for the live watcher — reads only new bytes each poll.
 */
class GrokLogTokenIndex {
  constructor() {
    this._path = '';
    this._offset = 0;
    this._bySid = new Map();
  }

  update(logPath) {
    if (!logPath) return;
    let stat;
    try {
      stat = fs.statSync(logPath);
    } catch {
      return;
    }
    if (this._path !== logPath || stat.size < this._offset) {
      this._path = logPath;
      this._offset = 0;
      this._bySid.clear();
    }
    if (stat.size === this._offset) return;

    let fd;
    try {
      fd = fs.openSync(logPath, 'r');
      const length = stat.size - this._offset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, this._offset);
      let text = buf.toString('utf-8');
      if (this._offset > 0) {
        const nl = text.indexOf('\n');
        if (nl !== -1) text = text.slice(nl + 1);
      }
      for (const line of text.split(/\r?\n/)) {
        const ev = parseGrokLogLine(line);
        if (!ev) continue;
        const prev = this._bySid.get(ev.sid) || {
          tokens: emptyTotals(),
          lastTs: 0,
          model: null
        };
        for (const k of Object.keys(prev.tokens)) prev.tokens[k] += ev.tokens[k] || 0;
        if (ev.ts > prev.lastTs) prev.lastTs = ev.ts;
        if (ev.model) prev.model = ev.model;
        this._bySid.set(ev.sid, prev);
      }
      this._offset = stat.size;
    } catch {
      // leave index as-is; next poll retries
    } finally {
      try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  get(sid) {
    return this._bySid.get(sid) || null;
  }
}

module.exports = {
  mapGrokTurn,
  parseGrokLogLine,
  scanGrokLog,
  GrokLogTokenIndex
};
