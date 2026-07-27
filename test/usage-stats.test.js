const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageTracker, estimateCost, findPricing, dayKey } = require('../src/main/usage-stats');

const NOW = new Date('2026-07-27T12:00:00').getTime();
const TODAY = dayKey(NOW);

function makeTracker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-usage-'));
  return {
    tracker: new UsageTracker({ dataPath: path.join(dir, 'usage-stats.json'), now: () => NOW }),
    dir
  };
}

function claudeSession(id, tokens, extra = {}) {
  return {
    id,
    agent: 'Claude Code',
    model: 'claude-opus-4',
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
    ...extra
  };
}

describe('UsageTracker', () => {
  let ctx;
  beforeEach(() => { ctx = makeTracker(); });
  afterEach(() => { fs.rmSync(ctx.dir, { recursive: true, force: true }); });

  it('banks a first-sighting snapshot into a day+agent+model bucket', () => {
    const changed = ctx.tracker.ingest([
      claudeSession('claude-1', { input: 1000, output: 500 })
    ]);
    assert.equal(changed, true);

    const { buckets } = ctx.tracker.getStats();
    assert.equal(buckets.length, 1);
    const b = buckets[0];
    assert.equal(b.day, TODAY);
    assert.equal(b.agent, 'Claude Code');
    assert.equal(b.model, 'claude-opus-4');
    assert.equal(b.input, 1000);
    assert.equal(b.output, 500);
    assert.equal(b.total, 1500);
    assert.equal(b.sessions, 1);
    assert.equal(b.costKnown, true);
    assert.equal(b.costActual, false); // estimated at list price
    assert.ok(b.cost > 0);
  });

  it('is idempotent — re-ingesting the same cumulative snapshot banks nothing', () => {
    const snap = [claudeSession('claude-1', { input: 1000, output: 500 })];
    ctx.tracker.ingest(snap);
    const changed = ctx.tracker.ingest(snap);
    assert.equal(changed, false);

    const { buckets } = ctx.tracker.getStats();
    assert.equal(buckets[0].total, 1500);
  });

  it('banks only the positive delta on cumulative re-ingest', () => {
    ctx.tracker.ingest([claudeSession('claude-1', { input: 1000, output: 500 })]);
    ctx.tracker.ingest([claudeSession('claude-1', { input: 1400, output: 900 })]);

    const { buckets } = ctx.tracker.getStats();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].input, 1400);
    assert.equal(buckets[0].output, 900);
    assert.equal(buckets[0].total, 2300);
  });

  it('never banks negative movement (shrunk tail-window snapshots)', () => {
    ctx.tracker.ingest([claudeSession('claude-1', { input: 5000, output: 2000 })]);
    ctx.tracker.ingest([claudeSession('claude-1', { input: 100, output: 50 })]);

    const { buckets } = ctx.tracker.getStats();
    assert.equal(buckets[0].total, 7000);
  });

  it('counts distinct sessions per bucket and separates models', () => {
    ctx.tracker.ingest([
      claudeSession('claude-1', { input: 100 }),
      claudeSession('claude-2', { input: 200 }),
      claudeSession('claude-3', { input: 300 }, { model: 'claude-sonnet-4' })
    ]);

    const { buckets } = ctx.tracker.getStats();
    assert.equal(buckets.length, 2);
    const opus = buckets.find(b => b.model === 'claude-opus-4');
    const sonnet = buckets.find(b => b.model === 'claude-sonnet-4');
    assert.equal(opus.sessions, 2);
    assert.equal(opus.total, 300);
    assert.equal(sonnet.sessions, 1);
  });

  it('prefers harness-reported actual cost over list-price estimate', () => {
    ctx.tracker.ingest([
      {
        id: 'opencode-1',
        agent: 'OpenCode',
        model: 'gemini-2.5-pro',
        tokens: { input: 100000, output: 10000 },
        cost: 0.42
      }
    ]);

    const { buckets } = ctx.tracker.getStats();
    assert.equal(buckets[0].costActual, true);
    assert.equal(buckets[0].cost, 0.42);
  });

  it('marks unpriced models as cost-unknown instead of fake zero', () => {
    ctx.tracker.ingest([
      {
        id: 'x-1',
        agent: 'SomeAgent',
        model: 'totally-unknown-model-9000',
        tokens: { input: 1000, output: 1000 }
      }
    ]);

    const { buckets } = ctx.tracker.getStats();
    assert.equal(buckets[0].costKnown, false);
    assert.equal(buckets[0].cost, 0);
    assert.equal(buckets[0].total, 2000);
  });

  it('skips sessions with no usage signal (Grok/Cursor presence-only)', () => {
    const changed = ctx.tracker.ingest([
      { id: 'grok-1', agent: 'Grok', tokens: { input: 0, output: 0 } },
      { id: 'cursor-1', agent: 'Cursor' }
    ]);
    assert.equal(changed, false);
    assert.equal(ctx.tracker.getStats().buckets.length, 0);
  });

  it('persists buckets and reloads them across restarts', () => {
    ctx.tracker.ingest([claudeSession('claude-1', { input: 1000, output: 500 })]);
    ctx.tracker.flush();

    const reloaded = new UsageTracker({ dataPath: ctx.tracker._dataPath, now: () => NOW });
    const { buckets } = reloaded.getStats();
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].total, 1500);

    // High-water mark survives: re-ingesting the same snapshot banks nothing
    const changed = reloaded.ingest([claudeSession('claude-1', { input: 1000, output: 500 })]);
    assert.equal(changed, false);
    assert.equal(reloaded.getStats().buckets[0].total, 1500);
  });

  it('sorts buckets most-recent first, then by total within a day', () => {
    const yesterday = NOW - 86400000;
    const t1 = new UsageTracker({ dataPath: ctx.tracker._dataPath, now: () => yesterday });
    t1.ingest([claudeSession('claude-old', { input: 10 })]);
    t1.flush();

    // Fresh process "restart" today loads yesterday's bucket from disk
    const t2 = new UsageTracker({ dataPath: ctx.tracker._dataPath, now: () => NOW });
    t2.ingest([
      claudeSession('claude-a', { input: 100 }, { model: 'claude-sonnet-4' }),
      claudeSession('claude-b', { input: 900 })
    ]);

    const { buckets } = t2.getStats();
    assert.equal(buckets.length, 3);
    assert.equal(buckets[0].day, TODAY);
    assert.equal(buckets[0].total, 900); // bigger bucket first within the day
    assert.equal(buckets[1].total, 100);
    assert.equal(buckets[2].day, dayKey(yesterday));
  });
});

describe('estimateCost / findPricing', () => {
  it('matches models case-insensitively by substring, specific first', () => {
    assert.equal(findPricing('Claude-Opus-4-20250514').match, 'claude-opus-4');
    assert.equal(findPricing('gpt-5-codex').match, 'gpt-5-codex');
    assert.equal(findPricing('some-random-model'), null);
  });

  it('bills reasoning tokens as output', () => {
    const withReasoning = estimateCost('gpt-5', { input: 0, output: 0, reasoning: 1e6, cacheRead: 0, cacheWrite: 0 });
    const withOutput = estimateCost('gpt-5', { input: 0, output: 1e6, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(withReasoning, withOutput);
  });

  it('returns null for unpriced models', () => {
    assert.equal(estimateCost('nope-model', { input: 1e6, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }), null);
  });
});
