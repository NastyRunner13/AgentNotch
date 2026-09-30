const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BaseWatcher } = require('../src/main/watchers/base-watcher');
const { CodexWatcher } = require('../src/main/watchers/codex-watcher');
const { AgentManager } = require('../src/main/agent-manager');
const bridge = require('../src/main/permissions/permission-bridge');

describe('tracking health', () => {
  it('distinguishes missing sources, readable empty sources, activity, failure and recovery', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-health-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const w = new BaseWatcher('Test');
    w.healthPaths = [path.join(root, 'sessions')];
    w._running = true;
    await w._runPoll();
    assert.equal(w.health.state, 'missing');
    assert.equal(w.health.lastSuccessAt, null);
    fs.mkdirSync(w.healthPaths[0]);
    await w._runPoll();
    assert.equal(w.health.state, 'polling');
    assert.equal(w.health.lastEventAt, null, 'A successful scan is not an agent event');
    w._poll = async () => w._updateSession('test-1', { status: 'working', lastActivityAt: 1000 });
    await w._runPoll();
    assert.equal(w.health.lastEventAt, 1000);
    const successAt = w.health.lastSuccessAt;
    w._poll = async () => { w.reportReadError(new Error('Unsupported schema')); };
    await w._runPoll();
    assert.equal(w.health.state, 'error');
    assert.equal(w.health.error, 'Unsupported schema');
    assert.equal(w.health.lastSuccessAt, successAt);
    w._poll = async () => {};
    await w._runPoll();
    assert.equal(w.health.state, 'polling');
    assert.equal(w.health.error, '');
    w.stop();
    assert.equal(w.health.state, 'disabled');
  });

  it('preserves sessions when a scan fails and reports nested read errors', async t => {
    const w = new CodexWatcher();
    w._running = true;
    w._updateSession('codex-existing', { status: 'working' });
    t.mock.method(fs, 'existsSync', () => true);
    t.mock.method(fs, 'readdirSync', () => { throw new Error('Access denied'); });
    await w._runPoll();
    assert.equal(w.health.state, 'error');
    assert.match(w.health.error, /Access denied/);
    assert.equal(w.getSessions().length, 1);
  });

  it('coalesces overlapping polls and ignores work finishing after stop', async () => {
    const w = new BaseWatcher('Test');
    w._running = true;
    let finish;
    let calls = 0;
    w._poll = async () => {
      calls++;
      await new Promise(resolve => { finish = resolve; });
      w._updateSession('late', { status: 'working' });
    };
    const first = w._runPoll();
    const second = w._runPoll();
    assert.equal(calls, 1);
    w.stop();
    finish();
    await Promise.all([first, second]);
    assert.equal(w.health.state, 'disabled');
    assert.equal(w.getSessions().length, 0);
  });

  it('does not count IDE presence as session activity', () => {
    const w = new BaseWatcher('Cursor');
    w._updateSession('cursor-main', { lastActivityAt: Date.now(), status: 'idle' });
    assert.equal(w.health.lastEventAt, null);
  });

  it('a disconnected setup check times out and can be retried', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const manager = Object.create(AgentManager.prototype);
    const watcher = { enabled: true, checkHealth: () => new Promise(() => {}) };
    manager.watchers = { test: watcher };
    manager.getTrackingHealth = () => [];
    const pending = manager.checkTrackingSetup();
    const rejected = assert.rejects(pending, /10 seconds/);
    t.mock.timers.tick(10000);
    await rejected;
    watcher.checkHealth = async () => {};
    assert.deepEqual(await manager.checkTrackingSetup(), []);
  });

  it('excludes disabled watchers from the manager feed and setup check', async t => {
    t.mock.method(bridge, 'mergePendingIntoSessions', list => list);
    const w = new BaseWatcher('Codex', { enabled: false });
    w._updateSession('codex-old', { status: 'working' });
    let checks = 0;
    w.checkHealth = async () => { checks++; };
    const manager = Object.create(AgentManager.prototype);
    Object.assign(manager, { watchers: { codex: w }, settings: {}, _dismissed: new Map(), _archivedIds: new Set(), _snoozes: new Map(), _attentionAcks: new Map() });
    assert.deepEqual(manager.getSessions(), []);
    const health = await manager.checkTrackingSetup();
    assert.equal(checks, 0);
    assert.equal(health[0].state, 'disabled');
    assert.equal(health[0].sessionCount, 0);
  });

  it('renders source errors as text and never marks a quiet session disconnected', async () => {
    const { renderTrackingHealth } = await import('../src/renderer/components/tracking-health.js');
    const html = renderTrackingHealth([{ agent: 'Codex', source: 'Local', state: 'watching', checkedAt: 100000, lastEventAt: 1000, sessionCount: 1, paths: ['<script>'] }], 100000);
    assert.match(html, /Reading session files/);
    assert.match(html, /Last activity 1m ago/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });
});
