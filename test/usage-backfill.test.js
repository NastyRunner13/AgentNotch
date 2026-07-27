const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageTracker, dayKey } = require('../src/main/usage-stats');
const {
  scanClaudeFile,
  scanCodexFile,
  scanAntigravityFile,
  scanUsageHistory,
  mapCodexUsage
} = require('../src/main/usage-backfill');

const NOW = new Date('2026-07-27T12:00:00').getTime();
const TODAY = dayKey(NOW);
const YESTERDAY = dayKey(NOW - 86400000);
const ISO_TODAY = new Date(NOW - 3600000).toISOString();
const ISO_TODAY_LATE = new Date(NOW - 1800000).toISOString();
const ISO_YESTERDAY = new Date(NOW - 86400000 - 3600000).toISOString();

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-bf-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function tracker() {
  return new UsageTracker({ dataPath: path.join(dir, 'usage-stats.json'), now: () => NOW });
}

function writeJsonl(name, entries) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n'));
  return p;
}

/* ── Tracker: ingestHistorical ───────────────────────── */

describe('UsageTracker.ingestHistorical', () => {
  it('banks per-day tokens into separate day buckets', () => {
    const t = tracker();
    t.ingestHistorical({
      id: 'claude-abc',
      agent: 'Claude Code',
      days: [
        { day: TODAY, model: 'claude-opus-4', tokens: { input: 100, output: 50 } },
        { day: YESTERDAY, model: 'claude-opus-4', tokens: { input: 200, output: 80 } }
      ]
    });

    const { buckets } = t.getStats();
    assert.equal(buckets.length, 2);
    const today = buckets.find(b => b.day === TODAY);
    const yest = buckets.find(b => b.day === YESTERDAY);
    assert.equal(today.total, 150);
    assert.equal(yest.total, 280);
  });

  it('is idempotent across re-scans (only new tokens bank)', () => {
    const t = tracker();
    const rec = {
      id: 'codex-r1',
      agent: 'Codex',
      days: [{ day: TODAY, model: 'gpt-5', tokens: { input: 1000, output: 100 } }]
    };
    t.ingestHistorical(rec);
    assert.equal(t.ingestHistorical(rec), false);
    assert.equal(t.getStats().buckets[0].total, 1100);

    // File grew: re-scan with a larger cumulative sum banks only the delta
    t.ingestHistorical({
      ...rec,
      days: [{ day: TODAY, model: 'gpt-5', tokens: { input: 1400, output: 160 } }]
    });
    assert.equal(t.getStats().buckets[0].total, 1560);
  });

  it('raises the live high-water mark so live ingest banks only real deltas', () => {
    const t = tracker();
    t.ingestHistorical({
      id: 'opencode-1',
      agent: 'OpenCode',
      days: [{ day: YESTERDAY, model: 'gemini-2.5-pro', tokens: { input: 10000, output: 2000 }, cost: 0.5 }]
    });

    // Live session reports cumulative 12k/3k with cost 0.62 → only the delta lands today
    t.ingest([{
      id: 'opencode-1',
      agent: 'OpenCode',
      model: 'gemini-2.5-pro',
      tokens: { input: 12000, output: 3000 },
      cost: 0.62
    }]);

    const { buckets } = t.getStats();
    const yest = buckets.find(b => b.day === YESTERDAY);
    const today = buckets.find(b => b.day === TODAY);
    assert.equal(yest.total, 12000);
    assert.equal(today.total, 3000); // 2k input + 1k output delta, not the full 15k
    assert.ok(Math.abs(today.cost - 0.12) < 1e-9);
  });

  it('credits tokens live-ingest banked today before the scan ran (no double count)', () => {
    const t = tracker();
    // Live ingest first: session seen with cumulative 600 total → banked today
    t.ingest([{
      id: 'claude-race',
      agent: 'Claude Code',
      model: 'claude-opus-4',
      tokens: { input: 400, output: 200 }
    }]);

    // Backfill scan shows the same session spread over two days (500 yesterday,
    // 100 of today's 600 — the live 600 included yesterday's late tail)
    t.ingestHistorical({
      id: 'claude-race',
      agent: 'Claude Code',
      days: [
        { day: TODAY, model: 'claude-opus-4', tokens: { input: 300, output: 100 } },
        { day: YESTERDAY, model: 'claude-opus-4', tokens: { input: 300, output: 200 } }
      ]
    });

    const { buckets } = t.getStats();
    const today = buckets.find(b => b.day === TODAY);
    const yest = buckets.find(b => b.day === YESTERDAY);
    // Credit 600 applied most-recent-first: today 400 → fully credited,
    // remaining 200 credited against yesterday's 500 → banks 300
    assert.equal(today.total, 600);   // only what live banked, nothing added
    assert.equal(yest.total, 300);
    // Grand total across days = scanned 900 (no duplication of the 600)
    assert.equal(today.total + yest.total, 900);
  });

  it('records session time per day idempotently and groups it in getStats', () => {
    const t = tracker();
    const rec = {
      id: 'claude-t1',
      agent: 'Claude Code',
      days: [{ day: YESTERDAY, model: 'm', tokens: { input: 1 } }],
      msByDay: { [YESTERDAY]: 3600000, [TODAY]: 600000 }
    };
    t.ingestHistorical(rec);
    t.ingestHistorical(rec); // re-scan must not double

    const { sessionDays } = t.getStats();
    assert.equal(sessionDays.length, 2);
    const yest = sessionDays.find(d => d.day === YESTERDAY);
    assert.equal(yest.sessions, 1);
    assert.equal(yest.ms, 3600000);

    // excludeIds skips sessions the caller accounts for elsewhere
    const filtered = t.getStats({ excludeIds: new Set(['claude-t1']) });
    assert.equal(filtered.sessionDays.length, 0);
  });

  it('persists hist marks + daySessions across restarts (re-scan stays idempotent)', () => {
    const dataPath = path.join(dir, 'usage-stats.json');
    const t1 = new UsageTracker({ dataPath, now: () => NOW });
    const rec = {
      id: 'codex-p1',
      agent: 'Codex',
      days: [{ day: TODAY, model: 'gpt-5', tokens: { input: 500 } }],
      msByDay: { [TODAY]: 120000 }
    };
    t1.ingestHistorical(rec);
    t1.lastBackfillVersion = 2;
    t1.flush();

    const t2 = new UsageTracker({ dataPath, now: () => NOW });
    assert.equal(t2.lastBackfillVersion, 2);
    assert.equal(t2.ingestHistorical(rec), false);
    assert.equal(t2.getStats().buckets[0].total, 500);
    assert.equal(t2.getStats().sessionDays[0].ms, 120000);
  });

  it('never prunes snapshots carrying historical marks', () => {
    const old = NOW - 30 * 86400000; // 30 days "stale" by live rules
    const t = new UsageTracker({ dataPath: path.join(dir, 'u.json'), now: () => old });
    t.ingestHistorical({
      id: 'claude-old',
      agent: 'Claude Code',
      days: [{ day: dayKey(old), model: 'm', tokens: { input: 100 } }]
    });
    t.flush();

    const t2 = new UsageTracker({ dataPath: path.join(dir, 'u.json'), now: () => NOW });
    // Snapshot survived prune; re-scan banks nothing
    assert.equal(t2.ingestHistorical({
      id: 'claude-old',
      agent: 'Claude Code',
      days: [{ day: dayKey(old), model: 'm', tokens: { input: 100 } }]
    }), false);
  });
});

/* ── Scanner: format fixtures ────────────────────────── */

describe('usage-backfill scanners', () => {
  it('scanClaudeFile sums usage per day, dedupes streamed messages, tracks spans', () => {
    const p = writeJsonl('abc-123.jsonl', [
      { type: 'user', message: 'fix bug', timestamp: ISO_YESTERDAY },
      {
        type: 'assistant', timestamp: ISO_YESTERDAY,
        message: {
          id: 'msg_1', model: 'claude-opus-4-20250514',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 }
        }
      },
      // Streaming repeat of the same message id — must not double count
      {
        type: 'assistant', timestamp: ISO_YESTERDAY,
        message: {
          id: 'msg_1', model: 'claude-opus-4-20250514',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 }
        }
      },
      {
        type: 'assistant', timestamp: ISO_TODAY,
        message: {
          id: 'msg_2', model: 'claude-opus-4-20250514',
          usage: { input_tokens: 400, output_tokens: 100 }
        }
      },
      { type: 'assistant', timestamp: ISO_TODAY_LATE, message: { id: 'msg_3', content: [{ type: 'text', text: 'done' }] } }
    ]);

    const rec = scanClaudeFile(p);
    assert.equal(rec.id, 'claude-abc-123');
    assert.equal(rec.agent, 'Claude Code');
    assert.equal(rec.days.length, 2);

    const yest = rec.days.find(d => d.day === YESTERDAY);
    assert.equal(yest.model, 'claude-opus-4-20250514');
    assert.equal(yest.tokens.input, 1000);
    assert.equal(yest.tokens.output, 200);
    assert.equal(yest.tokens.cacheRead, 5000);
    assert.equal(yest.tokens.cacheWrite, 300);

    const today = rec.days.find(d => d.day === TODAY);
    assert.equal(today.tokens.input, 400);

    // Session time spans both days
    assert.ok(rec.msByDay[TODAY] > 0);
    assert.equal(typeof rec.msByDay[YESTERDAY], 'undefined'); // single ts → no span
  });

  it('scanCodexFile banks cumulative deltas per event day with correct field mapping', () => {
    const usage = (i, c, o, r) => ({
      input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: 0,
      output_tokens: o, reasoning_output_tokens: r, total_tokens: i + o
    });
    const p = writeJsonl('rollout-2026-07-26T10-00-00-aaaa.jsonl', [
      { timestamp: ISO_YESTERDAY, type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/tmp' } },
      { timestamp: ISO_YESTERDAY, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(10000, 8000, 500, 100) } } },
      { timestamp: ISO_TODAY, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(26000, 20000, 1500, 400) } } }
    ]);

    const rec = scanCodexFile(p);
    assert.equal(rec.id, 'codex-rollout-2026-07-26T10-00-00-aaaa');

    const yest = rec.days.find(d => d.day === YESTERDAY);
    // First sighting banks the full cumulative: input 2k fresh, 8k cache, output 400, reasoning 100
    assert.equal(yest.model, 'gpt-5-codex');
    assert.equal(yest.tokens.input, 2000);
    assert.equal(yest.tokens.cacheRead, 8000);
    assert.equal(yest.tokens.output, 400);
    assert.equal(yest.tokens.reasoning, 100);

    const today = rec.days.find(d => d.day === TODAY);
    // Delta only: input 6k-2k fresh, cache +12k, output 1100-400, reasoning +300
    assert.equal(today.tokens.input, 4000);
    assert.equal(today.tokens.cacheRead, 12000);
    assert.equal(today.tokens.output, 700);
    assert.equal(today.tokens.reasoning, 300);
  });

  it('mapCodexUsage keeps categories disjoint (cached ⊂ input, reasoning ⊂ output)', () => {
    const m = mapCodexUsage({
      input_tokens: 139123, cached_input_tokens: 112128, cache_write_input_tokens: 0,
      output_tokens: 2102, reasoning_output_tokens: 928, total_tokens: 141225
    });
    assert.equal(m.input, 26995);
    assert.equal(m.cacheRead, 112128);
    assert.equal(m.output, 1174);
    assert.equal(m.reasoning, 928);
    // Sum matches the reported total — nothing double counted
    assert.equal(m.input + m.cacheRead + m.output + m.reasoning + m.cacheWrite, 141225);
  });

  it('scanAntigravityFile records session time without fake token data', () => {
    const p = path.join(
      dir,
      'antigravity',
      'conv-1',
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, [
      JSON.stringify({ type: 'USER_INPUT', created_at: ISO_TODAY, content: 'build dashboard' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: ISO_TODAY_LATE, content: 'done' })
    ].join('\n'));

    const rec = scanAntigravityFile(p);
    assert.equal(rec.id, 'antigravity-conv-1');
    assert.equal(rec.agent, 'Antigravity');
    assert.deepEqual(rec.days, []);
    assert.ok(rec.msByDay[TODAY] > 0);
  });

  it('scanUsageHistory walks dirs and dedupes session ids', () => {
    const claudeRoot = path.join(dir, 'claude-projects');
    const codexRoot = path.join(dir, 'codex-sessions');
    const antigravityRoot = path.join(dir, 'antigravity-brain');
    fs.mkdirSync(path.join(claudeRoot, 'proj-a', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(codexRoot, '2026', '07', '26'), { recursive: true });
    fs.mkdirSync(path.join(antigravityRoot, 'conv-a', '.system_generated', 'logs'), { recursive: true });

    fs.writeFileSync(
      path.join(claudeRoot, 'proj-a', 'sessions', 's1.jsonl'),
      JSON.stringify({
        type: 'assistant', timestamp: ISO_TODAY,
        message: { id: 'm1', model: 'claude-opus-4', usage: { input_tokens: 100, output_tokens: 10 } }
      })
    );
    fs.writeFileSync(
      path.join(codexRoot, '2026', '07', '26', 'rollout-x.jsonl'),
      JSON.stringify({
        timestamp: ISO_TODAY, type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55 } } }
      })
    );
    fs.writeFileSync(
      path.join(antigravityRoot, 'conv-a', '.system_generated', 'logs', 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'USER_INPUT', created_at: ISO_TODAY }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: ISO_TODAY_LATE })
      ].join('\n')
    );

    const { records, files } = scanUsageHistory({
      claudeProjectsDir: claudeRoot,
      codexSessionsDir: codexRoot,
      antigravityBrainDir: antigravityRoot,
      opencodeDbPaths: [path.join(dir, 'missing.db')]
    });

    assert.equal(files, 3);
    assert.equal(records.length, 3);
    assert.ok(records.some(r => r.id === 'claude-s1'));
    assert.ok(records.some(r => r.id === 'codex-rollout-x'));
    assert.ok(records.some(r => r.id === 'antigravity-conv-a'));

    // End-to-end: records feed the tracker without error
    const t = tracker();
    for (const r of records) t.ingestHistorical(r);
    const { buckets, sessionDays } = t.getStats();
    assert.equal(buckets.length, 2);
    assert.ok(sessionDays.some(d => d.agent === 'Antigravity'));
  });
});
