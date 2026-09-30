const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const backfill = require('../src/main/usage/usage-backfill');

it('processes input callbacks while scanning history and preserves scan results', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-backfill-perf-'));
  t.after(() => {
    fs.unlinkSync(path.join(dir, 'session.jsonl'));
    fs.rmdirSync(dir);
  });
  const record = JSON.stringify({ timestamp: '2026-09-29T12:00:00Z',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } } });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), record + '\n' +
    (JSON.stringify({ type: 'progress', padding: 'x'.repeat(1000) }) + '\n').repeat(20000));
  const opts = { codexSessionsDir: dir, claudeProjectsDir: path.join(dir, 'missing'),
    antigravityBrainDir: path.join(dir, 'missing'), grokLogPath: path.join(dir, 'missing'), opencodeDbPaths: [] };
  const expected = backfill.scanUsageHistory(opts);
  let inputHandled = false;
  const callback = setImmediate(() => { inputHandled = true; });
  t.after(() => clearImmediate(callback));
  const result = await backfill.scanUsageHistoryAsync(opts);
  assert.equal(inputHandled, true, 'History scanning blocked the main thread until completion');
  assert.deepEqual(result, expected);
  assert.equal(result.files, 1);
  assert.equal(result.records.length, 1);
});

it('cancels a scan when the app stops', async () => {
  const controller = new AbortController();
  const missing = path.join(os.tmpdir(), 'notch-no-history-' + process.pid);
  const opts = { codexSessionsDir: missing, claudeProjectsDir: missing,
    antigravityBrainDir: missing, grokLogPath: missing, opencodeDbPaths: [] };
  const result = backfill.scanUsageHistoryAsync(opts, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  await assert.rejects(backfill.scanUsageHistoryAsync(opts, { signal: controller.signal }), { name: 'AbortError' });
});

it('reports worker failures and allows a later scan to succeed', async () => {
  const missing = path.join(os.tmpdir(), 'notch-no-history-' + process.pid);
  const opts = { codexSessionsDir: missing, claudeProjectsDir: missing,
    antigravityBrainDir: missing, grokLogPath: missing, opencodeDbPaths: {} };
  await assert.rejects(backfill.scanUsageHistoryAsync(opts), /opencodeDbPaths is not iterable/);
  assert.deepEqual(await backfill.scanUsageHistoryAsync({ ...opts, opencodeDbPaths: [] }),
    { records: [], files: 0, errors: 0 });
});
