const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Renderer component is an ES module — loaded dynamically (same pattern as
// the usage-view test).
let buildInsightsModel, renderInsightsView, insightsFingerprint;

const DAY_MS = 86400000;
const rec = (offset, overrides = {}) => ({
  id: `r-${offset}-${Math.random().toString(36).slice(2, 8)}`,
  agent: 'Claude Code',
  ts: Date.now() - offset * DAY_MS,
  day: '2026-07-20',
  taskName: 'task',
  category: 'feature',
  area: 'backend',
  langs: ['TypeScript'],
  complexity: 40,
  specificity: 50,
  words: 10,
  tools: 5,
  durationMs: 600000,
  ...overrides
});

function makeData() {
  return {
    updatedAt: Date.now(),
    records: [
      rec(0, { category: 'bugfix', area: 'frontend', complexity: 20, specificity: 20, agent: 'Claude Code' }),
      rec(0, { category: 'bugfix', area: 'backend', complexity: 60, specificity: 70, agent: 'Codex', langs: ['Python'] }),
      rec(1, { category: 'feature', area: 'fullstack', complexity: 80, specificity: 80, agent: 'Codex' }),
      rec(2, { category: 'testing', area: 'backend', complexity: 40, specificity: 40, agent: 'Claude Code' }),
      rec(10, { category: 'docs', area: 'docs', complexity: 10, specificity: 30, agent: 'Grok', langs: ['Markdown'] })
    ]
  };
}

describe('insights-view model', async () => {
  before(async () => {
    ({ buildInsightsModel, renderInsightsView, insightsFingerprint } =
      await import('../src/renderer/components/insights-view.js'));
  });

  it('aggregates categories, areas, bands, and averages for a range', () => {
    const m = buildInsightsModel(makeData(), 7);
    assert.equal(m.total, 4); // day-10 record excluded
    assert.equal(m.agents, 2);
    // bugfix leads with 2 of 4
    assert.equal(m.topCategory.id, 'bugfix');
    assert.equal(m.topCategory.count, 2);
    assert.equal(m.topCategory.share, 0.5);
    // backend leads areas (2 of 4)
    assert.equal(m.topArea.id, 'backend');
    // complexity: 20 simple, 40 moderate, 60 complex, 80 deep → one each
    assert.deepEqual(m.complexity, { simple: 1, moderate: 1, complex: 1, deep: 1 });
    assert.equal(Math.round(m.avgComplexity), 50);
    // specificity: 20 vague, 40 clear, 70+80 precise
    assert.deepEqual(m.specificity, { vague: 1, clear: 1, precise: 2 });
    assert.equal(m.specificityLabel, 'Clear'); // avg 55 → clear band
    assert.equal(m.empty, false);
  });

  it('range 0 (All) includes every record', () => {
    const m = buildInsightsModel(makeData(), 0);
    assert.equal(m.total, 5);
    assert.equal(m.agents, 3);
  });

  it('collects top languages across records', () => {
    const m = buildInsightsModel(makeData(), 0);
    const ts = m.langs.find(l => l.lang === 'TypeScript');
    assert.ok(ts && ts.count >= 3);
  });

  it('handles empty and malformed data', () => {
    assert.equal(buildInsightsModel(null, 7).empty, true);
    assert.equal(buildInsightsModel({}, 7).empty, true);
    assert.equal(buildInsightsModel({ records: [null, { bogus: true }] }, 7).empty, true);
  });

  it('renders all sections for a populated model', () => {
    const html = renderInsightsView(makeData(), 7);
    for (const section of ['Intent distribution', 'Work type', 'Task complexity', 'Prompt specificity']) {
      assert.ok(html.includes(section), `missing section: ${section}`);
    }
    assert.ok(html.includes('data-insight-range'));
    assert.ok(html.includes('Bug fixes'));
    assert.ok(html.includes('Classified on-device'));
  });

  it('renders a quiet empty state when there is nothing to show', () => {
    const html = renderInsightsView({ records: [] }, 7);
    assert.ok(html.includes('No conversations in this range'));
    assert.ok(!html.includes('Intent distribution'));
  });

  it('shows the specificity tip only when vague prompts dominate', () => {
    const vague = { records: [rec(0, { specificity: 10 }), rec(1, { specificity: 12 }), rec(2, { specificity: 70 })] };
    assert.ok(renderInsightsView(vague, 0).includes('insight-tip'));
    const sharp = { records: [rec(0, { specificity: 90 }), rec(1, { specificity: 85 }), rec(2, { specificity: 70 })] };
    assert.ok(!renderInsightsView(sharp, 0).includes('insight-tip'));
  });

  it('fingerprint is stable per model and differs across ranges', () => {
    const data = makeData();
    assert.equal(insightsFingerprint(data, 7), insightsFingerprint(data, 7));
    assert.notEqual(insightsFingerprint(data, 7), insightsFingerprint(data, 0));
  });
});
