const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexWatcher } = require('../src/main/watchers/codex-watcher');
const { ClaudeWatcher } = require('../src/main/watchers/claude-watcher');
const { AntigravityWatcher } = require('../src/main/watchers/antigravity-watcher');

const at = '2026-09-29T01:00:00Z';
const later = '2026-09-29T01:05:00Z';
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const noise = jsonl([{ type: 'progress', padding: 'x'.repeat(10000) }]).repeat(160);
const fixtures = [
  {
    name: 'Codex', create: () => new CodexWatcher(),
    process: (watcher, file) => watcher._processSessionFile(file, 'codex-test'),
    head: [
      { type: 'session_meta', timestamp: at, payload: { id: 'native-test', cwd: '/work/project' } },
      { type: 'turn_context', payload: { model: 'test-model' } },
      { payload: { type: 'user_message', message: 'Implement session tracking' } }
    ],
    finish: { timestamp: later, payload: { type: 'task_complete', last_agent_message: 'Finished the task' } },
    expected: { cwd: '/work/project', model: 'test-model', resumeId: 'native-test', status: 'idle' }
  },
  {
    name: 'Claude', create: () => new ClaudeWatcher(),
    process: (watcher, file) => watcher._processSessionFile(file, 'claude-test', 'project', 'native-test'),
    head: [
      { type: 'user', timestamp: at, cwd: '/work/project', message: 'Implement session tracking' },
      { type: 'assistant', message: { id: 'message-1', model: 'test-model', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: 'Working on the task' }] } }
    ],
    finish: { type: 'assistant', timestamp: later, message: { id: 'message-2', usage: { input_tokens: 200, output_tokens: 20 }, content: [{ type: 'text', text: 'Finished the task' }], stop_reason: 'end_turn' } },
    expected: { cwd: '/work/project', model: 'test-model', resumeId: 'native-test', status: 'idle' }
  },
  {
    name: 'Antigravity', create: () => new AntigravityWatcher(),
    process: (watcher, file) => watcher._processTranscript(file, 'antigravity-test', 'native-test'),
    head: [{ type: 'USER_INPUT', timestamp: at, content: 'Implement session tracking' }],
    finish: { type: 'PLANNER_RESPONSE', timestamp: later, content: 'Working on the task' },
    expected: { conversationId: 'native-test', status: 'working' }
  }
];

describe('large transcript tracking', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-transcript-'));
    file = path.join(dir, 'session.jsonl');
  });
  afterEach(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });

  for (const fixture of fixtures) {
    for (const cold of [false, true]) {
      it(`${fixture.name} preserves metadata ${cold ? 'on first discovering a large file' : 'when the file grows past the tail threshold'}`, async () => {
        const watcher = fixture.create();
        fs.writeFileSync(file, jsonl(fixture.head));
        if (!cold) await fixture.process(watcher, file);
        fs.appendFileSync(file, noise + jsonl([fixture.finish]));
        await fixture.process(watcher, file);
        const session = watcher.getSessions()[0];
        assert.equal(session.userPrompt, 'Implement session tracking');
        assert.equal(session.taskName, 'Implement session tracking');
        assert.equal(session.startTime, Date.parse(at));
        assert.equal(session.duration, 300000);
        for (const [key, value] of Object.entries(fixture.expected)) assert.equal(session[key], value, key);
        if (fixture.name === 'Claude') {
          assert.equal(session.tokens.input, 300);
          assert.equal(session.tokens.output, 30);
        }
        watcher.stop();
      });
    }
  }

  it('recovers the latest prompt and model from the middle of a large file', () => {
    const fixture = fixtures[0];
    fs.writeFileSync(file, jsonl(fixture.head) + noise + jsonl([
      { type: 'turn_context', payload: { model: 'new-model' } },
      { payload: { type: 'user_message', message: 'Now add the regression tests' } }
    ]) + noise + jsonl([fixture.finish]));
    const watcher = fixture.create();
    fixture.process(watcher, file);
    const session = watcher.getSessions()[0];
    assert.equal(session.model, 'new-model');
    assert.equal(session.userPrompt, 'Now add the regression tests');
    assert.equal(session.resumeId, 'native-test');
  });

  it('keeps accumulating Claude usage after the transcript grows and deduplicates repeated message IDs', async () => {
    const fixture = fixtures[1];
    const watcher = fixture.create();
    fs.writeFileSync(file, jsonl(fixture.head) + noise + jsonl([fixture.finish]));
    await fixture.process(watcher, file);
    fs.appendFileSync(file, jsonl([fixture.finish, { type: 'assistant', message: { id: 'message-3', usage: { input_tokens: 50, output_tokens: 5 }, content: [] } }]));
    await fixture.process(watcher, file);
    assert.equal(watcher.getSessions()[0].tokens.input, 350);
    assert.equal(watcher.getSessions()[0].tokens.output, 35);
    await fixture.process(watcher, file);
    assert.equal(watcher.getSessions()[0].tokens.input, 350);
  });

  it('reads only appended bytes after discovery and keeps a bounded activity feed', (t) => {
    const fixture = fixtures[0];
    const watcher = fixture.create();
    fs.writeFileSync(file, jsonl(fixture.head) + noise);
    fixture.process(watcher, file);
    const appended = jsonl(Array.from({ length: 100 }, (_, i) => ({ payload: { type: 'agent_message', message: `Activity ${i}` } })));
    fs.appendFileSync(file, appended);
    const read = fs.readSync;
    let bytesRead = 0;
    t.mock.method(fs, 'readSync', (...args) => {
      const count = read(...args);
      bytesRead += count;
      return count;
    });
    fixture.process(watcher, file);
    assert.equal(bytesRead, Buffer.byteLength(appended));
    assert.equal(watcher.getSessions()[0].activity.length, 40);
    assert.equal(watcher.getSessions()[0].activity.at(-1).text, 'Activity 99');
    fixture.process(watcher, file);
    assert.equal(bytesRead, Buffer.byteLength(appended));
  });

  it('retains partial records and UTF-8 characters across writes', () => {
    const fixture = fixtures[0];
    const watcher = fixture.create();
    fs.writeFileSync(file, jsonl(fixture.head));
    fixture.process(watcher, file);
    const record = Buffer.from(jsonl([{ payload: { type: 'agent_message', message: 'Working with 🦊 characters' } }]));
    const split = record.indexOf(Buffer.from('🦊')) + 2;
    fs.appendFileSync(file, record.subarray(0, split));
    fixture.process(watcher, file);
    assert.equal(watcher.getSessions()[0].lastMessage, '');
    fs.appendFileSync(file, record.subarray(split));
    fixture.process(watcher, file);
    assert.equal(watcher.getSessions()[0].lastMessage, 'Working with 🦊 characters');
    assert.equal(watcher.getSessions()[0].resumeId, 'native-test');
  });

  it('processes a record larger than a read chunk without dropping its beginning', () => {
    const fixture = fixtures[0];
    fs.writeFileSync(file, jsonl(fixture.head) + jsonl([
      { payload: { type: 'agent_message', message: 'A'.repeat(400000) } }, fixture.finish
    ]));
    const watcher = fixture.create();
    fixture.process(watcher, file);
    assert.equal(watcher.getSessions()[0].status, 'idle');
    assert.equal(watcher.getSessions()[0].lastMessage, 'Finished the task');
    assert.equal(watcher.getSessions()[0].activity.length, 2);
  });

  it('shows a final record without a newline and does not count it twice when the newline arrives', async () => {
    const fixture = fixtures[1];
    const watcher = fixture.create();
    fs.writeFileSync(file, jsonl(fixture.head) + JSON.stringify(fixture.finish));
    await fixture.process(watcher, file);
    assert.equal(watcher.getSessions()[0].status, 'idle');
    assert.equal(watcher.getSessions()[0].tokens.input, 300);
    fs.appendFileSync(file, '\n');
    await fixture.process(watcher, file);
    assert.equal(watcher.getSessions()[0].tokens.input, 300);
    assert.equal(watcher.getSessions()[0].activity.length, 2);
  });

  for (const rewrite of ['truncate', 'same-size', 'replace']) {
    it(`resets old metadata on ${rewrite}`, () => {
      const fixture = fixtures[0];
      const watcher = fixture.create();
      const original = jsonl(fixture.head) + jsonl([fixture.finish]);
      fs.writeFileSync(file, rewrite === 'truncate' ? original + noise : original);
      fixture.process(watcher, file);
      const replacement = original.replace('native-test', 'second-test').replace('/work/project', '/work/changed');
      if (rewrite === 'replace') {
        fs.writeFileSync(path.join(dir, 'replacement.jsonl'), replacement);
        fs.unlinkSync(file);
        fs.renameSync(path.join(dir, 'replacement.jsonl'), file);
      } else {
        fs.writeFileSync(file, replacement);
      }
      // Deterministic mtime even on filesystems with coarse timestamp precision.
      fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
      fixture.process(watcher, file);
      assert.equal(watcher.getSessions()[0].resumeId, 'second-test');
      assert.equal(watcher.getSessions()[0].cwd, '/work/changed');
    });
  }

  it('rebuilds state after a watcher stops or a session is removed', async () => {
    const fixture = fixtures[1];
    const watcher = fixture.create();
    fs.writeFileSync(file, jsonl(fixture.head) + noise + jsonl([fixture.finish]));
    await fixture.process(watcher, file);
    watcher.stop();
    await fixture.process(watcher, file);
    assert.equal(watcher.getSessions()[0].tokens.input, 300);
    watcher._removeSession('claude-test');
    await fixture.process(watcher, file);
    assert.equal(watcher.getSessions()[0].tokens.input, 300);
    assert.equal(watcher.getSessions()[0].cwd, '/work/project');
  });
});
