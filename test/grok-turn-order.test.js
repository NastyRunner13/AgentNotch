const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeGrokEvents, mergeGrokStatus } = require('../src/main/watchers/grok/events');
const { analyzeGrokEntries } = require('../src/main/watchers/grok/updates');
const { GrokWatcher } = require('../src/main/watchers/grok/watcher');
const { AgentManager } = require('../src/main/agent-manager');

const at = Date.UTC(2026, 8, 29);
const times = { startTime: at, lastTime: at + 10000 };
const event = (type, offset, fields = {}) => ({ type, timestamp: at + offset, ...fields });
const update = (sessionUpdate, offset, fields = {}) => ({
  timestamp: at + offset,
  method: 'session/update',
  params: { update: { sessionUpdate, ...fields } }
});
function merge(events, updates) {
  return mergeGrokStatus({
    eventState: analyzeGrokEvents(events),
    updateState: analyzeGrokEntries(updates, 'grok-test', '', times),
    isActive: true
  });
}

describe('Grok turn ordering across streams', () => {
  it('starts the next turn when events advance before updates', () => {
    const result = merge([
      event('turn_ended', 1000),
      event('turn_started', 2000),
      event('phase_changed', 2100, { phase: 'waiting_for_model' })
    ], [update('turn_completed', 1000)]);
    assert.equal(result.status, 'working');
    assert.equal(result.currentTool, 'Waiting for model…');
  });

  it('starts the next turn when updates advance before events', () => {
    const result = merge([event('turn_ended', 1000)], [
      update('turn_completed', 1000),
      update('user_message_chunk', 2000, { content: 'Implement the next task' }),
      update('tool_call', 2100, { title: 'read_file', rawInput: { path: 'next.js' } })
    ]);
    assert.equal(result.status, 'working');
    assert.equal(result.currentTool, 'read_file: next.js');
  });

  it('does not mistake an empty update stream for a completed turn', () => {
    assert.equal(merge([event('turn_started', 2000)], []).status, 'working');
  });

  it('keeps a new permission request when the events stream still shows the old completion', () => {
    const result = merge([event('turn_ended', 1000)], [
      update('user_message_chunk', 2000, { content: 'Run the next task' }),
      update('permission_request', 2100, { tool: 'run_terminal_command' })
    ]);
    assert.equal(result.status, 'permission-request');
    assert.equal(result.permissionRequest.tool, 'run_terminal_command');
  });

  it('clears the previous tool and permission at an explicit event turn start', () => {
    const result = merge([
      event('permission_requested', 500, { tool: 'old_tool' }),
      event('phase_changed', 600, { phase: 'permission_prompt' }),
      event('turn_started', 2000)
    ], [update('turn_completed', 1000)]);
    assert.equal(result.status, 'working');
    assert.equal(result.currentTool, null);
    assert.equal(result.permissionRequest, null);
  });

  for (const source of ['events', 'updates']) {
    it(`accepts completion from ${source} after the current turn started`, () => {
      const events = [event('turn_started', 2000)];
      const updates = [update('user_message_chunk', 2000, { content: 'Start the task' })];
      if (source === 'events') events.push(event('turn_ended', 3000));
      else updates.push(update('turn_completed', 3000));
      const result = merge(events, updates);
      assert.equal(result.status, 'idle');
      assert.equal(result.currentTool, null);
    });
  }

  it('does not reopen a completed turn for late assistant chunks or unrelated metadata', () => {
    const result = merge([event('turn_ended', 3000)], [
      update('user_message_chunk', 2000, { content: 'Start the task' }),
      update('agent_message_chunk', 4000, { content: 'Buffered final reply' }),
      update('usage_metadata', 5000)
    ]);
    assert.equal(result.status, 'idle');
  });

  for (const timestamp of [null, at + 2000]) {
    it(`keeps completion precedence with ${timestamp ? 'tied' : 'missing'} boundary timestamps`, () => {
      const start = event('turn_started', 2000);
      start.timestamp = timestamp;
      assert.equal(merge([start], [update('turn_completed', 2000)]).status, 'idle');
    });
  }

  it('uses record timestamps, including ACP metadata, rather than file modification times', () => {
    const start = update('user_message_chunk', 2000, { content: 'Next task' });
    delete start.timestamp;
    start.params._meta = { agentTimestampMs: at + 2000 };
    const end = event('turn_ended', 1000);
    end.timestamp /= 1000;
    assert.equal(merge([end], [start]).status, 'working');
  });

  it('recognizes a legacy user turn after the previous completion', () => {
    assert.equal(merge([event('turn_ended', 1000)], [
      update('turn_completed', 1000),
      { type: 'user', timestamp: at + 2000, content: 'Start the next task' }
    ]).status, 'working');
  });

  it('does not let a late recap move an already recorded completion past a new turn', () => {
    assert.equal(merge([event('turn_started', 2000)], [
      update('turn_completed', 1000),
      update('session_recap', 3000, { summary: 'Previous turn finished' })
    ]).status, 'working');
  });

  for (const firstSource of ['events', 'updates']) {
    it(`tracks real file updates and emits done once when ${firstSource} starts first`, (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-grok-turn-'));
      const eventsPath = path.join(dir, 'events.jsonl');
      const updatesPath = path.join(dir, 'updates.jsonl');
      t.after(() => {
        fs.unlinkSync(eventsPath);
        fs.unlinkSync(updatesPath);
        fs.rmdirSync(dir);
      });
      fs.writeFileSync(eventsPath, JSON.stringify(event('turn_ended', 1000)) + '\n');
      fs.writeFileSync(updatesPath, JSON.stringify(update('turn_completed', 1000)) + '\n');
      const watcher = new GrokWatcher({ grokDir: dir, tokenIndex: { get: () => null } });
      const manager = Object.create(AgentManager.prototype);
      Object.assign(manager, {
        _prevStatus: new Map(), _attentionEpisodes: new Map(),
        _snoozes: new Map(), _attentionAcks: new Map()
      });
      let doneCount = 0;
      manager.on('done', () => doneCount++);
      const poll = () => {
        watcher._processSessionDir(dir, 'grok-test', dir);
        manager._detectStatusTransitions(watcher.getSessions());
        return watcher.getSessions()[0];
      };
      assert.equal(poll().status, 'idle');
      const startEvent = JSON.stringify(event('turn_started', 2000)) + '\n';
      const startUpdate = JSON.stringify(update('user_message_chunk', 2000, { content: 'Next task' })) + '\n';
      fs.appendFileSync(firstSource === 'events' ? eventsPath : updatesPath,
        firstSource === 'events' ? startEvent : startUpdate);
      assert.equal(poll().status, 'working');
      assert.equal(poll().status, 'working', 'An unchanged poll must retain the new turn');
      fs.appendFileSync(firstSource === 'events' ? updatesPath : eventsPath,
        firstSource === 'events' ? startUpdate : startEvent);
      assert.equal(poll().status, 'working');
      assert.equal(doneCount, 0, 'The previous completion must not finish this turn');
      fs.appendFileSync(updatesPath, JSON.stringify(update('turn_completed', 3000)) + '\n');
      assert.equal(poll().status, 'idle');
      poll();
      fs.appendFileSync(eventsPath, JSON.stringify(event('turn_ended', 3000)) + '\n');
      poll();
      assert.equal(doneCount, 1);
    });
  }
});
