const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Renderer component is an ES module — loaded dynamically (same pattern the
// markdown-table test uses for session-card.js).
let buildUsageModel, buildSeries, renderUsageView, usageFingerprint;

const DAY_MS = 86400000;
const day = (offset) => {
  const d = new Date(Date.now() - offset * DAY_MS);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
};

function bucket(offset, agent, model, total, cost, extra = {}) {
  return {
    day: day(offset),
    agent,
    model,
    input: Math.round(total * 0.1),
    output: Math.round(total * 0.2),
    reasoning: 0,
    cacheRead: Math.round(total * 0.6),
    cacheWrite: Math.round(total * 0.1),
    total,
    sessions: 1,
    cost,
    costActual: false,
    costKnown: true,
    ...extra
  };
}

function makeStats() {
  return {
    updatedAt: Date.now(),
    buckets: [
      bucket(0, 'Claude Code', 'claude-opus-4', 800000, 3.40, { sessions: 2 }),
      bucket(0, 'Codex', 'gpt-5-codex', 250000, 0.44),
      bucket(1, 'Claude Code', 'claude-opus-4', 1200000, 5.10),
      bucket(3, 'OpenCode', 'gemini-2.5-pro', 180000, 0.64, { costActual: true }),
      bucket(10, 'Claude Code', 'mystery', 50000, 0, { costKnown: false })
    ],
    sessionTime: [
      { day: day(0), agent: 'Claude Code', sessions: 2, ms: 7200000 },
      { day: day(0), agent: 'Codex', sessions: 1, ms: 1800000 },
      { day: day(1), agent: 'Claude Code', sessions: 1, ms: 3600000 },
      { day: day(1), agent: 'Grok', sessions: 1, ms: 900000 },
      { day: day(3), agent: 'OpenCode', sessions: 1, ms: 2400000 },
      { day: day(10), agent: 'Claude Code', sessions: 1, ms: 1200000 }
    ]
  };
}

describe('usage-view model + charts', async () => {
  before(async () => {
    ({ buildUsageModel, buildSeries, renderUsageView, usageFingerprint } =
      await import('../src/renderer/components/usage-view.js'));
  });

  it('aggregates totals, split, and derived stats for a range', () => {
    const m = buildUsageModel(makeStats(), 7);
    // day-10 bucket/session excluded by the 7d cutoff
    assert.equal(m.totals.tokens, 800000 + 250000 + 1200000 + 180000);
    assert.equal(m.totals.sessions, 6); // from sessionTime entries only
    assert.equal(m.totals.ms, 7200000 + 1800000 + 3600000 + 900000 + 2400000);
    assert.equal(m.totals.agents, 4);
    assert.equal(m.totals.activeDays, 3);
    // Split sums match buckets (10% input, 20% output, 60% cacheRead, 10% cacheWrite)
    assert.equal(m.totals.split.cacheRead, Math.round(2430000 * 0.6));
    assert.ok(m.totals.cacheShare > 0.55 && m.totals.cacheShare < 0.65);
    assert.ok(m.totals.avgSessionMs > 0);
    assert.ok(Math.abs(m.totals.avgCostPerSession - (9.58 / 6)) < 1e-9);
    assert.equal(m.totals.estimated, true);  // some list-price estimates
    assert.equal(m.totals.partial, false);   // unpriced bucket is out of range
  });

  it('flags partial cost when unpriced token usage is in range', () => {
    const m = buildUsageModel(makeStats(), 30);
    assert.equal(m.totals.partial, true);
    assert.equal(m.totals.costKnown, true);
    // Unpriced bucket contributes tokens but not cost
    assert.equal(m.totals.tokens, 2430000 + 50000);
    assert.ok(Math.abs(m.totals.cost - 9.58) < 1e-9);
  });

  it('per-agent rows carry avg session length and cost share', () => {
    const m = buildUsageModel(makeStats(), 7);
    const claude = m.agents.find(a => a.agent === 'Claude Code');
    assert.equal(claude.sessions, 3);
    assert.equal(claude.avgMs, (7200000 + 3600000) / 3);
    assert.ok(Math.abs(claude.costShare - (8.50 / 9.58)) < 1e-9);
    // Sorted by tokens desc — Grok (time only) last
    assert.equal(m.agents[0].agent, 'Claude Code');
    assert.equal(m.agents[m.agents.length - 1].agent, 'Grok');
  });

  it('buildSeries calendar-fills zero days and stacks per-agent values', () => {
    const { slots, weekly } = buildSeries(makeStats(), 7);
    assert.equal(weekly, false);
    assert.equal(slots.length, 7);
    // Ascending, today last
    assert.equal(slots[6].key, day(0));
    // Yesterday (offset 1) has Claude tokens; day before (offset 2) is a zero gap
    assert.equal(slots[5].tokens, 1200000);
    assert.equal(slots[4].tokens, 0);
    // Today stacks Claude + Codex
    const today = slots[6];
    assert.equal(today.tokens, 1050000);
    assert.equal(today.byAgent.get('Claude Code').tokens, 800000);
    assert.equal(today.byAgent.get('Codex').cost, 0.44);
    assert.equal(today.sessions, 3);
    assert.equal(today.ms, 9000000);
  });

  it('buildSeries buckets 90d ranges into weeks', () => {
    const { slots, weekly } = buildSeries(makeStats(), 90);
    assert.equal(weekly, true);
    assert.equal(slots.length, 13);
    // All activity lands inside the bucket range; totals are preserved
    const tokens = slots.reduce((s, x) => s + x.tokens, 0);
    assert.equal(tokens, 2480000);
  });

  it('renders SVG burn chart with per-agent segments and legend', () => {
    const html = renderUsageView(makeStats(), 7, 'tokens');
    assert.ok(html.includes('<svg'));
    assert.ok(html.includes('usage-chart'));
    // One rect per agent on active days: today 2 + yesterday 1 + day-3 1
    const rects = html.match(/<rect /g) || [];
    assert.equal(rects.length, 4);
    // Agent identity colors used for segments
    assert.ok(html.includes('#D97757')); // Claude
    assert.ok(html.includes('#10B981')); // Codex
    // 'Today' x-label highlighted
    assert.ok(html.includes('data-today="1"'));
  });

  it('burn chart respects cost mode', () => {
    const html = renderUsageView(makeStats(), 7, 'cost');
    assert.ok(html.includes('data-chart-mode="cost" role="tab" aria-selected="true"'));
    assert.ok(html.includes('peak cost/day'));
  });

  it('renders spend trajectory only when cost is known and range > 1', () => {
    assert.ok(renderUsageView(makeStats(), 7, 'tokens').includes('usage-trend'));
    assert.ok(!renderUsageView(makeStats(), 1, 'tokens').includes('usage-trend'));
    const timeOnly = { buckets: [], sessionTime: [{ day: day(0), agent: 'Grok', sessions: 1, ms: 60000 }] };
    assert.ok(!renderUsageView(timeOnly, 7, 'tokens').includes('usage-trend'));
  });

  it('renders token mix with cache-read share', () => {
    const html = renderUsageView(makeStats(), 7, 'tokens');
    assert.ok(html.includes('usage-mix'));
    assert.ok(html.includes('cache read'));
    assert.ok(html.includes('Cache reads'));
  });

  it('hides charts quietly when there is no token data', () => {
    const timeOnly = { buckets: [], sessionTime: [{ day: day(0), agent: 'Grok', sessions: 2, ms: 3600000 }] };
    const html = renderUsageView(timeOnly, 7, 'tokens');
    assert.ok(!html.includes('usage-chart"'));
    assert.ok(!html.includes('usage-mix'));
    // Time stats still show
    assert.ok(html.includes('1h'));
    assert.ok(html.includes('Grok'));
  });

  it('fingerprint is stable and reacts to range and chart mode', () => {
    const s = makeStats();
    assert.equal(usageFingerprint(s, 7, 'tokens'), usageFingerprint(s, 7, 'tokens'));
    assert.notEqual(usageFingerprint(s, 7, 'tokens'), usageFingerprint(s, 30, 'tokens'));
    assert.notEqual(usageFingerprint(s, 7, 'tokens'), usageFingerprint(s, 7, 'cost'));
  });

  it('renders quiet empty state when nothing is in range', () => {
    const html = renderUsageView({ buckets: [], sessionTime: [] }, 7, 'tokens');
    assert.ok(html.includes('No usage in this range'));
  });
});
