const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { buildResumeCommand, buildNewSessionCommand, DISPATCH_AGENT_NAMES } = require('../src/main/agent-manager');
const { analyzeClaudeEntries } = require('../src/main/watchers/claude-watcher');
const { analyzeCodexEntries } = require('../src/main/watchers/codex-watcher');
const { analyzeOpencodeSession } = require('../src/main/watchers/opencode-watcher');

const fileTimes = { startTime: 1_000, lastTime: 2_000 };
const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('buildResumeCommand', () => {
  it('builds a headless resume for Claude Code sessions', () => {
    const cmd = buildResumeCommand({
      id: `claude-${UUID}`,
      agent: 'Claude Code',
      cwd: 'C:\\dev\\proj'
    }, 'fix the bug');

    assert.equal(cmd.bin, 'claude');
    assert.deepEqual(cmd.args, ['-p', '--resume', UUID, 'fix the bug']);
    assert.equal(cmd.cwd, 'C:\\dev\\proj');
  });

  it('keeps the prompt as a single argv element (no shell interpolation)', () => {
    const text = 'say "hi" & echo pwned';
    const cmd = buildResumeCommand({
      id: `claude-${UUID}`,
      agent: 'Claude Code',
      cwd: '/tmp/proj'
    }, text);

    assert.equal(cmd.args[cmd.args.length - 1], text);
    assert.equal(cmd.args.length, 4);
  });

  it('builds a headless resume for Codex using session_meta resumeId', () => {
    const cmd = buildResumeCommand({
      id: 'codex-rollout-2026-07-20T10-00-00-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      agent: 'Codex',
      resumeId: UUID,
      cwd: '/tmp/proj'
    }, 'continue');

    assert.equal(cmd.bin, 'codex');
    assert.deepEqual(cmd.args, ['exec', '--skip-git-repo-check', 'resume', UUID, 'continue']);
  });

  it('extracts the uuid from a Codex rollout filename when resumeId is missing', () => {
    const cmd = buildResumeCommand({
      id: `codex-rollout-2026-07-20T10-00-00-${UUID}`,
      agent: 'Codex',
      cwd: '/tmp/proj'
    }, 'continue');

    assert.deepEqual(cmd.args, ['exec', '--skip-git-repo-check', 'resume', UUID, 'continue']);
  });

  it('builds a headless resume for Grok sessions', () => {
    const cmd = buildResumeCommand({
      id: `grok-${UUID}`,
      agent: 'Grok',
      cwd: '/tmp/proj'
    }, 'hello');

    assert.equal(cmd.bin, 'grok');
    assert.deepEqual(cmd.args, ['-r', UUID, '-p', 'hello']);
  });

  it('builds a headless resume for OpenCode sessions', () => {
    const cmd = buildResumeCommand({
      id: 'opencode-ses_07c4fc0a5ffePqrMlIsjiNQ6Fn',
      agent: 'OpenCode',
      cwd: 'C:\\dev\\proj'
    }, 'hello');

    assert.equal(cmd.bin, 'opencode');
    assert.deepEqual(cmd.args, ['run', '-s', 'ses_07c4fc0a5ffePqrMlIsjiNQ6Fn', 'hello']);
  });

  it('returns null for agents that cannot receive dispatches', () => {
    assert.equal(buildResumeCommand({ id: 'antigravity-abc', agent: 'Antigravity', cwd: '/tmp' }, 'hi'), null);
    assert.equal(buildResumeCommand({ id: 'cursor-main', agent: 'Cursor', cwd: '/tmp' }, 'hi'), null);
    assert.equal(buildResumeCommand(null, 'hi'), null);
    assert.equal(buildResumeCommand({}, 'hi'), null);
  });

  it('rejects unsafe native ids', () => {
    assert.equal(buildResumeCommand({ id: 'claude-../etc/passwd', agent: 'Claude Code', cwd: '/tmp' }, 'hi'), null);
    assert.equal(buildResumeCommand({ id: 'claude-abc & whoami', agent: 'Claude Code', cwd: '/tmp' }, 'hi'), null);
    assert.equal(buildResumeCommand({ id: 'claude-', agent: 'Claude Code', cwd: '/tmp' }, 'hi'), null);
  });

  it('returns an empty cwd when the session directory is unknown', () => {
    const cmd = buildResumeCommand({ id: `claude-${UUID}`, agent: 'Claude Code' }, 'hi');
    assert.equal(cmd.cwd, '');
  });
});

describe('buildNewSessionCommand', () => {
  it('builds headless new-session commands for every dispatchable agent', () => {
    assert.equal(DISPATCH_AGENT_NAMES.length, 4);

    const claude = buildNewSessionCommand('Claude Code', 'hello world', 'C:\\dev\\proj');
    assert.deepEqual(claude, { bin: 'claude', args: ['-p', 'hello world'], cwd: 'C:\\dev\\proj' });

    const codex = buildNewSessionCommand('Codex', 'hello', '/tmp/proj');
    assert.deepEqual(codex, { bin: 'codex', args: ['exec', '--skip-git-repo-check', 'hello'], cwd: '/tmp/proj' });

    const grok = buildNewSessionCommand('Grok', 'hello', '/tmp/proj');
    assert.deepEqual(grok, { bin: 'grok', args: ['-p', 'hello'], cwd: '/tmp/proj' });

    const opencode = buildNewSessionCommand('OpenCode', 'hello', '/tmp/proj');
    assert.deepEqual(opencode, { bin: 'opencode', args: ['run', 'hello'], cwd: '/tmp/proj' });
  });

  it('returns null for unknown agents', () => {
    assert.equal(buildNewSessionCommand('Antigravity', 'hi', '/tmp'), null);
    assert.equal(buildNewSessionCommand('Cursor', 'hi', '/tmp'), null);
    assert.equal(buildNewSessionCommand('Nope', 'hi', '/tmp'), null);
  });

  it('falls back to the home directory when no cwd is given', () => {
    const cmd = buildNewSessionCommand('Grok', 'hi', '');
    assert.equal(cmd.cwd, os.homedir());
  });
});

describe('session cwd extraction (needed to resume in the right directory)', () => {
  it('claude analyzer captures cwd from transcript records', () => {
    const result = analyzeClaudeEntries([
      { type: 'user', cwd: 'C:\\dev\\proj', timestamp: '2026-07-20T10:00:00Z', message: { content: 'fix it' } },
      { type: 'assistant', timestamp: '2026-07-20T10:00:05Z', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }
    ], '', fileTimes);
    assert.equal(result.cwd, 'C:\\dev\\proj');
  });

  it('codex analyzer captures cwd from turn_context and id from session_meta', () => {
    const result = analyzeCodexEntries([
      { timestamp: '2026-07-20T10:00:00Z', type: 'session_meta', payload: { id: UUID } },
      { timestamp: '2026-07-20T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.6', cwd: '/tmp/proj' } }
    ], 'c1', '', fileTimes);
    assert.equal(result.cwd, '/tmp/proj');
    assert.equal(result.resumeId, UUID);
  });

  it('opencode analyzer surfaces the session directory', () => {
    const result = analyzeOpencodeSession(
      { id: 'ses_abc', title: 'task', time_created: 1_000, time_updated: 2_000, directory: 'C:\\dev\\proj' },
      [],
      [],
      3_000
    );
    assert.equal(result.cwd, 'C:\\dev\\proj');
  });
});
