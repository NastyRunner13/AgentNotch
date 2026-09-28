const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PerformanceTracker, MAX_OBSERVATION_GAP_MS } = require('../src/main/usage/performance-stats');

describe('PerformanceTracker', () => {
  let dir, dataPath, now, tracker;
  const observe = (status, extra = {}) => tracker.ingest([{ id: 'session-1', agent: 'Codex', status, ...extra }]);
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-performance-'));
    dataPath = path.join(dir, 'performance.json');
    now = new Date(2026, 8, 28, 12).getTime();
    tracker = new PerformanceTracker({ dataPath, now: () => now });
  });
  afterEach(() => {
    tracker.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('measures work and waiting separately through a fully observed episode', () => {
    observe('idle');
    now += 1000;
    observe('working');
    now += 10000;
    observe('permission-request', { attentionEpisodeKey: 'request-1' });
    observe('permission-request', { attentionEpisodeKey: 'request-1' });
    now += 5000;
    observe('working');
    now += 2000;
    observe('idle');
    observe('idle');
    const stats = tracker.getStats();
    assert.deepEqual(stats.days[0], {
      day: '2026-09-28', agent: 'Codex', workMs: 12000, waitMs: 5000,
      attentionEpisodes: 1, completedEpisodes: 1
    });
    assert.deepEqual(stats.episodes, [{ day: '2026-09-28', agent: 'Codex', workMs: 12000, complete: true }]);
    assert.equal(stats.incompleteObservations, 0);
  });

  it('counts distinct attention requests once even without leaving the attention state', () => {
    observe('question', { attentionEpisodeKey: 'one' });
    now += 2000;
    observe('question', { attentionEpisodeKey: 'one' });
    observe('question', { attentionEpisodeKey: 'two' });
    assert.equal(tracker.getStats().days[0].attentionEpisodes, 2);
    assert.equal(tracker.getStats().days[0].waitMs, 2000);
  });

  it('excludes initially running work from duration medians but counts observed completion', () => {
    observe('working');
    now += 5000;
    observe('idle');
    const stats = tracker.getStats();
    assert.equal(stats.days[0].workMs, 5000);
    assert.equal(stats.days[0].completedEpisodes, 1);
    assert.equal(stats.episodes.length, 0);
    assert.equal(stats.incompleteObservations, 1);
  });

  it('never counts stopping or disappearing as completion', () => {
    observe('idle');
    observe('working');
    now += 1000;
    observe('stopped');
    observe('working');
    now += 1000;
    tracker.ingest([]);
    assert.equal(tracker.getStats().days[0].completedEpisodes, 0);
    assert.equal(tracker.getStats().incompleteObservations, 2);
    assert.equal(tracker.getStats().days[0].workMs, 1000);
  });

  it('breaks an episode across observation gaps and backward clock changes', () => {
    observe('idle');
    observe('working');
    now += MAX_OBSERVATION_GAP_MS + 1;
    observe('working');
    now += 1000;
    observe('idle');
    assert.equal(tracker.getStats().days[0].workMs, 1000);
    assert.equal(tracker.getStats().episodes.length, 0);
    observe('working');
    now -= 1000;
    observe('idle');
    assert.equal(tracker.getStats().days[0].workMs, 1000);
    assert.equal(tracker.getStats().days[0].completedEpisodes, 1);
  });

  it('does not bridge sleep or restart and persists only minimal local aggregates', () => {
    observe('idle');
    observe('working', { userPrompt: 'private prompt', cwd: '/private/project' });
    now += 1000;
    tracker.suspend();
    now += 3600000;
    observe('working');
    tracker.resume();
    observe('working');
    now += 2000;
    observe('working');
    tracker.flush();
    const disk = fs.readFileSync(dataPath, 'utf8');
    assert.ok(!disk.includes('private'));
    assert.ok(!disk.includes('session-1'));
    now += 3600000;
    tracker = new PerformanceTracker({ dataPath, now: () => now });
    observe('idle');
    assert.equal(tracker.getStats().days[0].workMs, 3000);
    assert.equal(tracker.getStats().days[0].completedEpisodes, 0);
    assert.equal(tracker.getStats().incompleteObservations, 2);
  });

  it('splits elapsed intervals at local midnight', () => {
    now = new Date(2026, 8, 28, 23, 59, 55).getTime();
    observe('idle');
    observe('working');
    now += 10000;
    observe('idle');
    const stats = tracker.getStats();
    assert.equal(stats.days[0].day, '2026-09-29');
    assert.equal(stats.days[0].workMs, 5000);
    assert.equal(stats.days[0].completedEpisodes, 1);
    assert.equal(stats.days[1].workMs, 5000);
    assert.equal(stats.episodes[0].workMs, 10000);
  });

  it('respects disable and clear without retaining a resumable timer', () => {
    observe('idle');
    observe('working');
    now += 1000;
    tracker.setEnabled(false);
    now += 10000;
    observe('idle');
    assert.equal(tracker.getStats().enabled, false);
    assert.equal(tracker.getStats().days[0].workMs, 1000);
    tracker.setEnabled(true);
    observe('working');
    tracker.clear();
    assert.deepEqual(tracker.getStats().days, []);
    assert.equal(tracker.getStats().coverageStart, null);
    now += 2000;
    observe('idle');
    assert.deepEqual(tracker.getStats().days, []);
  });

  it('retains only the current and preceding 89 calendar days', () => {
    observe('working');
    now += 1000;
    observe('idle');
    const future = new Date(now);
    future.setDate(future.getDate() + 90);
    now = future.getTime();
    assert.deepEqual(tracker.getStats().days, []);
    assert.deepEqual(tracker.getStats().episodes, []);
  });

  it('observes raw manager sessions before dismissal, archive, or notification filtering', (t) => {
    const { AgentManager } = require('../src/main/agent-manager');
    const bridge = require('../src/main/permissions/permission-bridge');
    t.mock.method(bridge, 'mergePendingIntoSessions', sessions => sessions);
    const manager = Object.create(AgentManager.prototype);
    let status = 'idle';
    manager.settings = { enableCodex: true, enableClaude: false, focusMode: true };
    manager._performanceTracker = tracker;
    manager._dismissed = new Map([['session-1', now]]);
    manager._archivedIds = new Set(['session-1']);
    manager.watchers = {
      codex: { getSessions: () => [{ id: 'session-1', agent: 'Codex', status }] },
      claude: { getSessions: () => { throw new Error('disabled watcher must not be read'); } }
    };
    manager.getSessions = () => { throw new Error('presentation must not drive measurements'); };
    manager.getPerformanceStats();
    status = 'working';
    manager.getPerformanceStats();
    now += 1000;
    status = 'idle';
    const stats = manager.getPerformanceStats();
    assert.equal(stats.days[0].workMs, 1000);
    assert.equal(stats.days[0].completedEpisodes, 1);
    assert.equal(stats.episodes.length, 1);
    manager.watchers.codex.getSessions = () => { throw new Error('watcher unavailable'); };
    assert.doesNotThrow(() => manager.getPerformanceStats());
  });
});
