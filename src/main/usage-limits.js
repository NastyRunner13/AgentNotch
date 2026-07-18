const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Collects local usage / rate-limit snapshots for coding agents.
 * Only reads files on disk — never calls remote APIs.
 */

const AGENTS = [
  { id: 'claude', name: 'Claude Code', short: 'Claude', color: '#D97757' },
  { id: 'codex', name: 'Codex', short: 'Codex', color: '#10B981' },
  { id: 'cursor', name: 'Cursor', short: 'Cursor', color: '#06B6D4' },
  { id: 'antigravity', name: 'Antigravity', short: 'Gemini', color: '#4285F4' },
  { id: 'grok', name: 'Grok', short: 'Grok', color: '#EF4444' }
];

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function readFileTail(filePath, maxBytes = 96_000) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size <= 0) return '';
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function formatReset(resetsAt) {
  if (!resetsAt) return null;
  // Codex uses unix seconds
  const ms = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * Grok Build: billing credits live in ~/.grok/logs/unified.jsonl
 *   billing: fetched credits config → creditUsagePercent, subscriptionTier, weekly period
 */
function readGrokUsage(home = os.homedir()) {
  const logPath = path.join(home, '.grok', 'logs', 'unified.jsonl');
  const tail = readFileTail(logPath, 120_000);
  if (!tail) {
    return emptyUsage('grok', { note: fs.existsSync(path.join(home, '.grok')) ? 'No usage data yet' : 'Not installed' });
  }

  let latest = null;
  for (const line of tail.split(/\r?\n/)) {
    if (!line.includes('billing: fetched credits config')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.ctx?.config) latest = entry;
    } catch {
      // skip
    }
  }

  if (!latest?.ctx?.config) {
    return emptyUsage('grok', { note: 'No usage data yet' });
  }

  const cfg = latest.ctx.config;
  const used = Number(cfg.creditUsagePercent);
  const period = cfg.currentPeriod || {};
  const tier = latest.ctx.subscriptionTier || cfg.subscriptionTier || null;
  const end = period.end || cfg.billingPeriodEnd || null;

  return {
    id: 'grok',
    name: 'Grok',
    short: 'Grok',
    color: '#EF4444',
    available: Number.isFinite(used),
    usedPercent: Number.isFinite(used) ? Math.round(used) : null,
    remainingPercent: Number.isFinite(used) ? Math.max(0, Math.round(100 - used)) : null,
    window: period.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? 'Weekly' : (period.type || 'Period'),
    resetsAt: end ? new Date(end).getTime() : null,
    resetsLabel: end ? formatIsoDate(end) : null,
    plan: tier,
    model: null,
    note: tier ? `${tier}${end ? ` · resets ${formatIsoDate(end)}` : ''}` : null
  };
}

function formatIsoDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * Codex: rate_limits on token_count events in session JSONL.
 * Prefer live session data when provided; fall back to scanning recent files.
 */
function readCodexUsage(home = os.homedir(), sessionHints = []) {
  // Prefer freshest rate limit from live sessions
  let best = null;
  for (const s of sessionHints) {
    if (s.agent !== 'Codex' || !s.rateLimit) continue;
    if (!best || (s.rateLimit.updatedAt || 0) >= (best.updatedAt || 0)) {
      best = { ...s.rateLimit, model: s.model || s.rateLimit.model || null };
    }
  }

  if (!best) {
    best = scanCodexSessionsForRateLimit(path.join(home, '.codex', 'sessions'));
  }

  if (!best || best.usedPercent == null) {
    const model = readCodexDefaultModel(home);
    return emptyUsage('codex', {
      note: fs.existsSync(path.join(home, '.codex')) ? 'No usage data yet' : 'Not installed',
      model
    });
  }

  const used = Math.round(Number(best.usedPercent));
  return {
    id: 'codex',
    name: 'Codex',
    short: 'Codex',
    color: '#10B981',
    available: true,
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    window: best.windowMinutes ? `${Math.round(best.windowMinutes / (60 * 24))}d` : null,
    resetsAt: best.resetsAt || null,
    resetsLabel: formatReset(best.resetsAt),
    plan: best.planType || null,
    model: best.model || readCodexDefaultModel(home),
    note: [
      best.planType,
      best.resetsAt ? `resets ${formatReset(best.resetsAt)}` : null
    ].filter(Boolean).join(' · ') || null
  };
}

function readCodexDefaultModel(home) {
  try {
    const cfgPath = path.join(home, '.codex', 'config.toml');
    if (!fs.existsSync(cfgPath)) return null;
    const text = fs.readFileSync(cfgPath, 'utf-8');
    const m = text.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function scanCodexSessionsForRateLimit(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return null;
  const files = [];
  walkJsonl(sessionsDir, files, 4);
  files.sort((a, b) => b.mtime - a.mtime);

  for (const file of files.slice(0, 8)) {
    const found = extractCodexRateLimitFromFile(file.path);
    if (found) return found;
  }
  return null;
}

function walkJsonl(dir, out, maxDepth, depth = 0) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, out, maxDepth, depth + 1);
    } else if (entry.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(full);
        out.push({ path: full, mtime: st.mtimeMs });
      } catch {
        // skip
      }
    }
  }
}

function extractCodexRateLimitFromFile(filePath) {
  const tail = readFileTail(filePath, 200_000);
  if (!tail) return null;
  let best = null;
  let model = null;
  for (const line of tail.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
      if (payload.model && typeof payload.model === 'string') model = payload.model;
      if (payload.type === 'token_count' && payload.rate_limits) {
        const primary = payload.rate_limits.primary;
        if (primary && primary.used_percent != null) {
          best = {
            usedPercent: primary.used_percent,
            windowMinutes: primary.window_minutes,
            resetsAt: primary.resets_at,
            planType: payload.rate_limits.plan_type || null,
            model,
            updatedAt: entry.timestamp ? Date.parse(entry.timestamp) : Date.now()
          };
        }
      }
    } catch {
      // skip
    }
  }
  return best;
}

/**
 * Claude Code: model from settings; rate limits are not reliably on disk.
 * If a live session carries rateLimit, use it.
 */
function readClaudeUsage(home = os.homedir(), sessionHints = []) {
  const settings = safeReadJson(path.join(home, '.claude', 'settings.json')) || {};
  const model = settings.model || null;

  let best = null;
  for (const s of sessionHints) {
    if (s.agent !== 'Claude Code') continue;
    if (s.rateLimit && s.rateLimit.usedPercent != null) {
      if (!best || (s.rateLimit.updatedAt || 0) >= (best.updatedAt || 0)) {
        best = { ...s.rateLimit, model: s.model || model };
      }
    }
  }

  if (best && best.usedPercent != null) {
    const used = Math.round(Number(best.usedPercent));
    return {
      id: 'claude',
      name: 'Claude Code',
      short: 'Claude',
      color: '#D97757',
      available: true,
      usedPercent: used,
      remainingPercent: Math.max(0, 100 - used),
      window: best.window || null,
      resetsAt: best.resetsAt || null,
      resetsLabel: formatReset(best.resetsAt),
      plan: best.plan || null,
      model: best.model || model,
      note: best.note || null
    };
  }

  const installed = fs.existsSync(path.join(home, '.claude'));
  return emptyUsage('claude', {
    note: installed ? 'Limit not exposed locally' : 'Not installed',
    model
  });
}

function emptyUsage(id, extras = {}) {
  const meta = AGENTS.find(a => a.id === id) || { id, name: id, short: id, color: '#888' };
  return {
    id: meta.id,
    name: meta.name,
    short: meta.short,
    color: meta.color,
    available: false,
    usedPercent: null,
    remainingPercent: null,
    window: null,
    resetsAt: null,
    resetsLabel: null,
    plan: null,
    model: extras.model || null,
    note: extras.note || null
  };
}

function readCursorUsage() {
  return emptyUsage('cursor', { note: 'Limit not available locally' });
}

function readAntigravityUsage() {
  return emptyUsage('antigravity', { note: 'Limit not available locally' });
}

/**
 * @param {{ sessions?: Array, home?: string, enabled?: Record<string, boolean> }} opts
 * @returns {Array<object>}
 */
function collectUsageLimits(opts = {}) {
  const home = opts.home || os.homedir();
  const sessions = Array.isArray(opts.sessions) ? opts.sessions : [];
  const enabled = opts.enabled || {};

  const all = [
    readClaudeUsage(home, sessions),
    readCodexUsage(home, sessions),
    readCursorUsage(),
    readAntigravityUsage(),
    readGrokUsage(home)
  ];

  // Enrich models from live sessions when available
  for (const usage of all) {
    const match = sessions.find(s => {
      if (usage.id === 'claude') return s.agent === 'Claude Code' && s.model;
      if (usage.id === 'codex') return s.agent === 'Codex' && s.model;
      if (usage.id === 'grok') return s.agent === 'Grok' && s.model;
      if (usage.id === 'cursor') return s.agent === 'Cursor' && s.model;
      if (usage.id === 'antigravity') return s.agent === 'Antigravity' && s.model;
      return false;
    });
    if (match?.model) usage.model = match.model;
  }

  // Filter disabled agents from settings when provided
  return all.filter(u => {
    if (u.id === 'claude' && enabled.enableClaude === false) return false;
    if (u.id === 'codex' && enabled.enableCodex === false) return false;
    if (u.id === 'cursor' && enabled.enableCursor === false) return false;
    if (u.id === 'antigravity' && enabled.enableAntigravity === false) return false;
    if (u.id === 'grok' && enabled.enableGrok === false) return false;
    return true;
  });
}

module.exports = {
  collectUsageLimits,
  readGrokUsage,
  readCodexUsage,
  readClaudeUsage,
  extractCodexRateLimitFromFile
};
