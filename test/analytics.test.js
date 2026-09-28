const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
let buildPerformanceModel, renderPerformanceView, buildUsageModel, buildSeries, renderUsageView;
before(async () => {
  ({ buildPerformanceModel, renderPerformanceView } = await import('../src/renderer/components/performance-view.js'));
  ({ buildUsageModel, buildSeries, renderUsageView } = await import('../src/renderer/components/usage-view.js'));
});
const date = (offset = 0) => {
  const d = new Date(); d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
describe('Analytics semantics', () => {
  it('keeps mixed and missing costs through every aggregate', () => {
    const buckets = [
      { day: date(), agent: 'Codex', model: 'a', total: 100, cost: 1, costKnown: true, costActual: true },
      { day: date(), agent: 'Codex', model: 'a', total: 200, cost: 2, costKnown: true, costActual: false },
      { day: date(), agent: 'Codex', model: 'a', total: 50, cost: 0, costKnown: false }
    ];
    const stats = { buckets, sessionTime: [] };
    const model = buildUsageModel(stats, 7);
    for (const row of [model.totals, model.days[0], model.agents[0], model.agents[0].models[0], buildSeries(stats, 7).slots.at(-1)]) {
      assert.equal(row.mixed, true);
      assert.equal(row.partial, true);
      assert.equal(row.cost, 3);
    }
    assert.ok(renderUsageView(stats, 7, 'cost').includes('mixed, partial'));
  });
  it('shows unavailable costs for entirely unpriced usage, not zero dollars', () => {
    const stats = { buckets: [{ day: date(), agent: 'Codex', model: 'unknown', total: 100, costKnown: false }], sessionTime: [] };
    const html = renderUsageView(stats, 7, 'cost');
    assert.ok(html.includes('unavailable'));
    assert.ok(!html.includes('$0.00'));
    assert.ok(!html.includes('NaN') && !html.includes('Infinity'));
  });
  it('renders shared-control mode without duplicate filter buttons', () => {
    const html = renderUsageView({ buckets: [], sessionTime: [] }, 30, 'tokens', [], { controls: false });
    assert.ok(!html.includes('data-range='));
  });
  it('filters performance by calendar range and agent and uses only complete episodes for median', () => {
    const stats = { enabled: true, days: [
      { day: date(), agent: 'Codex', workMs: 100, waitMs: 40, attentionEpisodes: 2, completedEpisodes: 3 },
      { day: date(), agent: 'Claude Code', workMs: 999, waitMs: 50 },
      { day: date(10), agent: 'Codex', workMs: 5000 }
    ], episodes: [
      { day: date(), agent: 'Codex', workMs: 20, complete: true },
      { day: date(), agent: 'Codex', workMs: 40, complete: true },
      { day: date(), agent: 'Codex', workMs: 900, complete: false }
    ] };
    const model = buildPerformanceModel(stats, 7, 'Codex');
    assert.equal(model.totals.workMs, 100);
    assert.equal(model.totals.waitMs, 40);
    assert.equal(model.medianWorkMs, 30);
    assert.equal(model.sampleSize, 2);
  });
  it('leaves missing performance unavailable and explains paused collection', () => {
    assert.equal(buildPerformanceModel({}, 7).medianWorkMs, null);
    const html = renderPerformanceView({ enabled: false }, 7);
    assert.ok(html.includes('Collection paused'));
    assert.ok(html.includes('No performance observations yet'));
  });
  it('escapes agent names in performance tables', () => {
    const html = renderPerformanceView({ days: [{day:date(), agent:'<script>alert(1)</script>', workMs: 100}], episodes:[] }, 7);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});
