/**
 * Usage dashboard — dense, quiet analytics from local data only.
 * Summary strips, stacked daily burn chart, spend trajectory, token mix,
 * daily rows, and a per-agent/model breakdown. Charts are hand-rolled
 * inline SVG (no dependencies, CSP-safe); agent hues identify series,
 * status hues stay semantic. No hero cards; mono owns the numbers.
 */

const AGENT_COLORS = {
  'Claude Code': '#D97757',
  'Codex': '#10B981',
  'Cursor': '#06B6D4',
  'Antigravity': '#4285F4',
  'Grok': '#EF4444',
  'OpenCode': '#8B5CF6'
};
const FALLBACK_AGENT_COLOR = '#8a8a8a';

export const USAGE_RANGES = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' }
];

export const CHART_MODES = [
  { id: 'tokens', label: 'Tokens' },
  { id: 'cost', label: 'Cost' }
];

/** Token split categories — semantic hues: green = cheap cache reads,
 *  amber = pricey cache writes, blue = produced output, neutral = input. */
const TOKEN_MIX = [
  { key: 'cacheRead', label: 'cache read', color: '#4ADE80' },
  { key: 'output', label: 'output', color: '#60A5FA' },
  { key: 'reasoning', label: 'reasoning', color: '#22D3EE' },
  { key: 'cacheWrite', label: 'cache write', color: '#F59E0B' },
  { key: 'input', label: 'input', color: 'rgba(255,255,255,0.35)' }
];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Buckets longer ranges into week slots so bars stay legible. */
const WEEKLY_THRESHOLD_DAYS = 45;

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Local calendar day string (YYYY-MM-DD) — mirror of main-process dayKey. */
function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** 842 → "842" · 18400 → "18.4K" · 1900000 → "1.9M" */
function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) {
    const k = n / 1e3;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  const m = n / 1e6;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
}

/** Cost in USD → "$3.42"; unknown cost → em dash (never a fake zero). */
function fmtCost(usd, known = true) {
  if (!known) return '—';
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

/** 420000 → "7m" · 8040000 → "2h 14m" · 90000000 → "1d 1h" */
function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  if (h < 24) return remMin ? `${h}h ${remMin}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

function fmtPct(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${Math.round(ratio * 100)}%`;
}

function shortDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function dayLabel(day) {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - DAY_MS);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  return new Date(parseDay(day)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

/**
 * Aggregate raw tracker stats into the view model for a range.
 * Cost flags: `estimated` when list pricing filled in, `partial` when some
 * token usage has no known price (shown honestly, never silently zeroed).
 */
export function buildUsageModel(stats, rangeDays) {
  const buckets = Array.isArray(stats?.buckets) ? stats.buckets : [];
  const sessionTime = Array.isArray(stats?.sessionTime) ? stats.sessionTime : [];
  const cutoff = dayKey(Date.now() - (rangeDays - 1) * DAY_MS);

  const daysMap = new Map();  // day → aggregate
  const agentsMap = new Map(); // agent → aggregate
  const totals = {
    tokens: 0, cost: 0, costKnown: false, estimated: false, partial: false,
    sessions: 0, ms: 0,
    split: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  };

  const dayEntry = (day) => {
    let e = daysMap.get(day);
    if (!e) {
      e = { day, tokens: 0, cost: 0, costKnown: false, sessions: 0, ms: 0 };
      daysMap.set(day, e);
    }
    return e;
  };
  const agentEntry = (agent) => {
    let e = agentsMap.get(agent);
    if (!e) {
      e = { agent, tokens: 0, cost: 0, costKnown: false, sessions: 0, ms: 0, models: new Map() };
      agentsMap.set(agent, e);
    }
    return e;
  };

  for (const b of buckets) {
    if (!b || !b.day || b.day < cutoff) continue;
    const tokens = Number(b.total) || 0;
    const known = Boolean(b.costKnown);
    const cost = known ? (Number(b.cost) || 0) : 0;
    const sess = Number(b.sessions) || 0;

    const d = dayEntry(b.day);
    d.tokens += tokens;
    d.cost += cost;
    d.costKnown = d.costKnown || known;

    const a = agentEntry(b.agent || 'Unknown');
    a.tokens += tokens;
    a.cost += cost;
    a.costKnown = a.costKnown || known;

    for (const k of Object.keys(totals.split)) {
      totals.split[k] += Number(b[k]) || 0;
    }

    const modelName = b.model || null;
    if (tokens > 0 || cost > 0) {
      const mk = modelName || '';
      let m = a.models.get(mk);
      if (!m) {
        m = { model: modelName, tokens: 0, cost: 0, costKnown: false, sessions: 0 };
        a.models.set(mk, m);
      }
      m.tokens += tokens;
      m.cost += cost;
      m.costKnown = m.costKnown || known;
      m.sessions += sess;
    }

    totals.tokens += tokens;
    totals.cost += cost;
    totals.costKnown = totals.costKnown || known;
    if (known && !b.costActual) totals.estimated = true;
    if (!known && tokens > 0) totals.partial = true;
  }

  for (const t of sessionTime) {
    if (!t || !t.day || t.day < cutoff) continue;
    const ms = Number(t.ms) || 0;
    const sess = Number(t.sessions) || 0;
    dayEntry(t.day).ms += ms;
    dayEntry(t.day).sessions += sess;
    agentEntry(t.agent || 'Unknown').ms += ms;
    agentEntry(t.agent || 'Unknown').sessions += sess;
    totals.ms += ms;
    totals.sessions += sess;
  }

  const days = [...daysMap.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const d of days) d.label = dayLabel(d.day);

  const agents = [...agentsMap.values()]
    .map(a => ({
      ...a,
      color: AGENT_COLORS[a.agent] || FALLBACK_AGENT_COLOR,
      avgMs: a.sessions > 0 ? a.ms / a.sessions : 0,
      costShare: totals.cost > 0 ? a.cost / totals.cost : 0,
      models: [...a.models.values()].sort((x, y) => y.tokens - x.tokens)
    }))
    .sort((a, b) => (b.tokens - a.tokens) || (b.ms - a.ms));

  totals.agents = agents.length;
  totals.activeDays = days.length;
  totals.avgCostPerSession = totals.costKnown && totals.sessions > 0
    ? totals.cost / totals.sessions : null;
  totals.avgSessionMs = totals.sessions > 0 ? totals.ms / totals.sessions : 0;
  totals.cacheShare = totals.tokens > 0 ? totals.split.cacheRead / totals.tokens : 0;
  totals.dailyAvgCost = totals.costKnown && totals.activeDays > 0
    ? totals.cost / totals.activeDays : null;

  return { days, agents, totals, empty: days.length === 0 && agents.length === 0 };
}

/**
 * Calendar-filled ascending time series for charts. Every slot in the range
 * is present (zero-activity days included) so the timeline reads honestly.
 * Ranges beyond 45 days aggregate into 7-day buckets.
 *
 * @returns {{ slots: Array<object>, weekly: boolean }}
 *   slot: { key, label, startTs, tokens, cost, ms, sessions, byAgent: Map<agent,{tokens,cost}> }
 */
export function buildSeries(stats, rangeDays) {
  const buckets = Array.isArray(stats?.buckets) ? stats.buckets : [];
  const sessionTime = Array.isArray(stats?.sessionTime) ? stats.sessionTime : [];
  const weekly = rangeDays > WEEKLY_THRESHOLD_DAYS;
  const bucketDays = weekly ? 7 : 1;
  const slotCount = Math.ceil(rangeDays / bucketDays);

  const todayStart = parseDay(dayKey(Date.now()));
  const firstStart = todayStart - (rangeDays - 1) * DAY_MS;

  const slots = [];
  for (let i = 0; i < slotCount; i++) {
    const startTs = firstStart + i * bucketDays * DAY_MS;
    slots.push({
      key: dayKey(startTs),
      startTs,
      tokens: 0,
      cost: 0,
      ms: 0,
      sessions: 0,
      byAgent: new Map()
    });
  }
  const slotIndex = (day) => {
    const idx = Math.floor((parseDay(day) - firstStart) / (bucketDays * DAY_MS));
    return idx >= 0 && idx < slotCount ? idx : -1;
  };
  const bumpAgent = (slot, agent, tokens, cost) => {
    let a = slot.byAgent.get(agent);
    if (!a) {
      a = { tokens: 0, cost: 0 };
      slot.byAgent.set(agent, a);
    }
    a.tokens += tokens;
    a.cost += cost;
  };

  for (const b of buckets) {
    if (!b || !b.day) continue;
    const idx = slotIndex(b.day);
    if (idx === -1) continue;
    const tokens = Number(b.total) || 0;
    const cost = b.costKnown ? (Number(b.cost) || 0) : 0;
    slots[idx].tokens += tokens;
    slots[idx].cost += cost;
    bumpAgent(slots[idx], b.agent || 'Unknown', tokens, cost);
  }
  for (const t of sessionTime) {
    if (!t || !t.day) continue;
    const idx = slotIndex(t.day);
    if (idx === -1) continue;
    slots[idx].ms += Number(t.ms) || 0;
    slots[idx].sessions += Number(t.sessions) || 0;
  }

  for (const s of slots) s.label = shortDate(s.startTs);
  return { slots, weekly };
}

/** Stable fingerprint of the rendered model — skips flicker-prone rebuilds. */
export function usageFingerprint(stats, rangeDays, chartMode = 'tokens') {
  return JSON.stringify(buildUsageModel(stats, rangeDays)) + `\x1d${rangeDays}\x1d${chartMode}`;
}

/* ── Charts (inline SVG) ─────────────────────────────── */

const CHART_W = 576;
const BURN_H = 112;
const BURN_PAD_TOP = 10;
const TREND_H = 64;
const TREND_PAD = 6;

function agentOrder(series, mode) {
  const totals = new Map();
  for (const s of series) {
    for (const [agent, v] of s.byAgent) {
      totals.set(agent, (totals.get(agent) || 0) + (mode === 'cost' ? v.cost : v.tokens));
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([agent]) => agent);
}

/**
 * Stacked daily burn chart — one bar per slot, segments per agent.
 * Honest gaps for zero days; two hairline gridlines; mono peak label.
 */
function renderBurnChart(series, weekly, mode) {
  const n = series.length;
  if (n === 0) return '';
  const valueOf = (s) => (mode === 'cost' ? s.cost : s.tokens);
  const max = series.reduce((mx, s) => Math.max(mx, valueOf(s)), 0);
  if (max <= 0) return '';

  const order = agentOrder(series, mode);
  const fmt = mode === 'cost' ? (v) => fmtCost(v) : fmtTokens;
  const unit = mode === 'cost' ? 'cost' : 'tokens';

  const slotW = CHART_W / n;
  const barW = Math.max(3, Math.min(26, slotW * 0.6));
  const usableH = BURN_H - BURN_PAD_TOP;
  const midY = BURN_PAD_TOP + usableH / 2;
  const baseY = BURN_H;

  const bars = series.map((s, i) => {
    const total = valueOf(s);
    const x = slotW * i + (slotW - barW) / 2;
    if (total <= 0) return '';
    let y = baseY;
    const segs = [];
    for (const agent of order) {
      const v = s.byAgent.get(agent);
      if (!v) continue;
      const val = mode === 'cost' ? v.cost : v.tokens;
      if (val <= 0) continue;
      const h = Math.max(1, (val / max) * usableH);
      y -= h;
      segs.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${AGENT_COLORS[agent] || FALLBACK_AGENT_COLOR}"/>`);
    }
    const tip = `${escapeHtml(s.label)} — ${fmt(total)} ${unit}${s.sessions ? ` · ${s.sessions} sess` : ''}`;
    return `<g><title>${tip}</title>${segs.join('')}</g>`;
  }).join('');

  // X labels: every slot for ≤7, every 5th for month-ish, every 2nd when weekly
  const step = weekly ? 2 : n <= 7 ? 1 : 5;
  const labels = series.map((s, i) => {
    if (i % step !== 0 && i !== n - 1) return '';
    const isToday = !weekly && s.key === dayKey(Date.now());
    const text = isToday ? 'Today' : weekly || n > 7 ? s.label : new Date(s.startTs).toLocaleDateString('en-US', { weekday: 'short' });
    return `<span class="usage-chart-x" style="left:${(slotW * i).toFixed(1)}px;width:${slotW.toFixed(1)}px"${isToday ? ' data-today="1"' : ''}>${escapeHtml(text)}</span>`;
  }).join('');

  const legend = order.map(agent => {
    const total = series.reduce((sum, s) => {
      const v = s.byAgent.get(agent);
      return sum + (v ? (mode === 'cost' ? v.cost : v.tokens) : 0);
    }, 0);
    if (total <= 0) return '';
    return `<span class="usage-chart-legend-item">
      <span class="usage-agent-dot" style="background:${AGENT_COLORS[agent] || FALLBACK_AGENT_COLOR}"></span>
      ${escapeHtml(agent)} <span class="usage-chart-legend-val">${fmt(total)}</span>
    </span>`;
  }).join('');

  return `<div class="usage-chart" role="img" aria-label="${unit === 'cost' ? 'Daily cost' : 'Daily tokens'} by agent, peak ${fmt(max)}">
    <div class="usage-chart-peak">${fmt(max)}<span class="usage-chart-peak-unit"> peak ${unit}/day</span></div>
    <svg width="100%" height="${BURN_H}" viewBox="0 0 ${CHART_W} ${BURN_H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="${BURN_PAD_TOP}" x2="${CHART_W}" y2="${BURN_PAD_TOP}" class="usage-grid"/>
      <line x1="0" y1="${midY}" x2="${CHART_W}" y2="${midY}" class="usage-grid"/>
      ${bars}
    </svg>
    <div class="usage-chart-xrow">${labels}</div>
    <div class="usage-chart-legend">${legend}</div>
  </div>`;
}

/** Cumulative spend trajectory — area + line, end dot with total. */
function renderCostTrend(series) {
  const n = series.length;
  if (n < 2) return '';
  let cum = 0;
  const points = series.map((s, i) => {
    cum += s.cost;
    return { i, cum, day: s };
  });
  const max = cum;
  if (max <= 0) return '';

  const slotW = CHART_W / n;
  const usableH = TREND_H - TREND_PAD * 2;
  const xy = points.map(p => {
    const x = slotW * p.i + slotW / 2;
    const y = TREND_PAD + usableH * (1 - p.cum / max);
    return [x, y];
  });
  const line = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${TREND_H} L${xy[0][0].toFixed(1)},${TREND_H} Z`;
  const [ex, ey] = xy[xy.length - 1];

  return `<div class="usage-trend" role="img" aria-label="Cumulative spend ${fmtCost(max)} over the range">
    <svg width="100%" height="${TREND_H}" viewBox="0 0 ${CHART_W} ${TREND_H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="${TREND_H - 0.5}" x2="${CHART_W}" y2="${TREND_H - 0.5}" class="usage-grid"/>
      <path d="${area}" class="usage-trend-area"/>
      <path d="${line}" class="usage-trend-line"/>
      <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="2.5" class="usage-trend-dot"/>
    </svg>
    <div class="usage-trend-caption">
      <span>${escapeHtml(series[0].label)}</span>
      <span class="usage-trend-total">${fmtCost(max)} cumulative</span>
      <span>${escapeHtml(series[n - 1].label)}</span>
    </div>
  </div>`;
}

/** Token composition — one horizontal stacked bar + mono legend. */
function renderTokenMix(split, totalTokens) {
  if (totalTokens <= 0) return '';
  const parts = TOKEN_MIX
    .map(c => ({ ...c, value: split[c.key] || 0 }))
    .filter(p => p.value > 0);
  if (parts.length === 0) return '';

  const bar = parts.map(p =>
    `<span class="usage-mix-seg" style="width:${((p.value / totalTokens) * 100).toFixed(2)}%;background:${p.color}" title="${p.label} — ${fmtTokens(p.value)} (${fmtPct(p.value / totalTokens)})"></span>`
  ).join('');

  const legend = parts.map(p =>
    `<span class="usage-mix-item">
      <span class="usage-mix-dot" style="background:${p.color}"></span>
      ${p.label} <span class="usage-mix-val">${fmtPct(p.value / totalTokens)}</span>
    </span>`
  ).join('');

  return `<div class="usage-mix">
    <div class="usage-mix-bar">${bar}</div>
    <div class="usage-mix-legend">${legend}</div>
  </div>`;
}

/* ── Sections ────────────────────────────────────────── */

function renderStatRow(items, secondary = false) {
  return `<div class="usage-summary-row${secondary ? ' usage-summary-secondary' : ''}" role="list">
    ${items.map(i => `<div class="usage-stat" role="listitem"${i.title ? ` title="${escapeHtml(i.title)}"` : ''}>
      <span class="usage-stat-value">${escapeHtml(i.value)}</span>
      <span class="usage-stat-label">${escapeHtml(i.label)}</span>
    </div>`).join('')}
  </div>`;
}

function renderSummary(totals) {
  const costNote = totals.partial ? 'partial' : totals.estimated ? 'est' : null;
  const primary = [
    { value: totals.costKnown ? fmtCost(totals.cost) : '—', label: costNote ? `Cost (${costNote})` : 'Cost' },
    { value: fmtTokens(totals.tokens), label: 'Tokens' },
    { value: String(totals.sessions), label: 'Sessions' },
    { value: fmtMs(totals.ms), label: 'Agent time' },
    { value: String(totals.agents), label: `Agent${totals.agents === 1 ? '' : 's'}` }
  ];
  const secondary = [
    {
      value: totals.avgCostPerSession != null ? fmtCost(totals.avgCostPerSession) : '—',
      label: '$ / session'
    },
    { value: fmtMs(totals.avgSessionMs), label: 'Avg session' },
    {
      value: totals.dailyAvgCost != null ? fmtCost(totals.dailyAvgCost) : '—',
      label: '$ / active day'
    },
    {
      value: fmtPct(totals.cacheShare),
      label: 'Cache reads',
      title: 'Share of tokens served from prompt cache — much cheaper than fresh input'
    }
  ];
  return `<div class="usage-summary">${renderStatRow(primary)}${renderStatRow(secondary, true)}</div>`;
}

function renderDays(days) {
  return `<div class="usage-section">
    <h4 class="usage-eyebrow">Daily</h4>
    <div class="usage-days">
      ${days.map(d => `<div class="usage-day" title="${escapeHtml(d.day)} — ${fmtTokens(d.tokens)} tokens across ${d.sessions} session${d.sessions === 1 ? '' : 's'}">
        <span class="usage-day-label">${escapeHtml(d.label)}</span>
        <span class="usage-day-meta">${d.sessions > 0 ? `${d.sessions} sess · ${fmtMs(d.ms)}` : ''}</span>
        <span class="usage-day-tokens">${d.tokens > 0 ? fmtTokens(d.tokens) : '—'}</span>
        <span class="usage-day-cost">${fmtCost(d.cost, d.costKnown)}</span>
      </div>`).join('')}
    </div>
  </div>`;
}

function renderAgents(agents) {
  return `<div class="usage-section">
    <h4 class="usage-eyebrow">Agents</h4>
    <div class="usage-agents">
      ${agents.map(a => `<div class="usage-agent">
        <div class="usage-agent-head">
          <span class="usage-agent-dot" style="background:${a.color}"></span>
          <span class="usage-agent-name">${escapeHtml(a.agent)}</span>
          <span class="usage-agent-meta">${a.sessions} sess · ${fmtMs(a.ms)} · ${fmtMs(a.avgMs)} avg</span>
          <span class="usage-agent-tokens">${a.tokens > 0 ? fmtTokens(a.tokens) : '—'}</span>
          <span class="usage-agent-cost">${a.tokens > 0 || a.costKnown ? fmtCost(a.cost, a.costKnown) : '—'}${a.costShare > 0.005 ? `<span class="usage-agent-share">${fmtPct(a.costShare)}</span>` : ''}</span>
        </div>
        ${a.models.length ? `<div class="usage-models">
          ${a.models.map(m => `<div class="usage-model">
            <span class="usage-model-name">${escapeHtml(m.model || 'unknown model')}</span>
            <span class="usage-model-sess">${m.sessions} sess</span>
            <span class="usage-model-tokens">${fmtTokens(m.tokens)}</span>
            <span class="usage-model-cost">${fmtCost(m.cost, m.costKnown)}</span>
          </div>`).join('')}
        </div>` : ''}
      </div>`).join('')}
    </div>
  </div>`;
}

export function renderUsageView(stats, rangeDays, chartMode = 'tokens') {
  const model = buildUsageModel(stats, rangeDays);

  const rangeToggle = `<div class="usage-range" role="tablist" aria-label="Usage range">
    ${USAGE_RANGES.map(r => `<button type="button" class="usage-range-btn${r.days === rangeDays ? ' active' : ''}"
      data-range="${r.days}" role="tab" aria-selected="${r.days === rangeDays}">${r.label}</button>`).join('')}
  </div>`;

  if (model.empty) {
    return `${rangeToggle}
      <div class="empty-state usage-empty">
        <p class="empty-title">No usage in this range</p>
        <p class="empty-desc">Session time, tokens, and cost appear here as agents work. Token data comes from local agent files only.</p>
      </div>`;
  }

  const { slots, weekly } = buildSeries(stats, rangeDays);
  const burnChart = renderBurnChart(slots, weekly, chartMode);
  const trend = rangeDays > 1 && model.totals.costKnown ? renderCostTrend(slots) : '';
  const mix = renderTokenMix(model.totals.split, model.totals.tokens);

  const chartSection = burnChart ? `<div class="usage-section">
    <div class="usage-chart-head">
      <h4 class="usage-eyebrow">Burn</h4>
      <div class="usage-range usage-chart-modes" role="tablist" aria-label="Chart metric">
        ${CHART_MODES.map(m => `<button type="button" class="usage-range-btn${m.id === chartMode ? ' active' : ''}"
          data-chart-mode="${m.id}" role="tab" aria-selected="${m.id === chartMode}">${m.label}</button>`).join('')}
      </div>
    </div>
    ${burnChart}
    ${trend ? `<h4 class="usage-eyebrow usage-eyebrow-gap">Spend trajectory</h4>${trend}` : ''}
  </div>` : '';

  const mixSection = mix ? `<div class="usage-section">
    <h4 class="usage-eyebrow">Token mix</h4>
    ${mix}
  </div>` : '';

  const footnote = model.totals.costKnown
    ? `<p class="usage-footnote">${model.totals.estimated ? 'Costs estimated at list prices — actual billing may differ. ' : ''}${model.totals.partial ? 'Some token usage has no known price and is excluded from cost. ' : ''}Local data only.</p>`
    : `<p class="usage-footnote">No priced token data in this range — costs appear when an agent reports tokens for a known model. Local data only.</p>`;

  return `${rangeToggle}
    ${renderSummary(model.totals)}
    ${chartSection}
    ${mixSection}
    ${renderDays(model.days)}
    ${renderAgents(model.agents)}
    ${footnote}`;
}
