const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { sessionNavigation, terminalLaunch, openSessionTarget } = require('../src/main/session/session-navigation');
const { AgentManager } = require('../src/main/agent-manager');
const id = '12345678-1234-1234-1234-123456789abc';

describe('exact session navigation', () => {
  it('opens only the selected native Codex thread and keeps it separate from other sessions', async () => {
    const session = { agent: 'Codex', id: `codex-rollout-2026-${id}`, resumeId: id, status: 'working', cwd: 'C:/project' };
    const target = sessionNavigation(session, { platform: 'win32' });
    assert.equal(target.kind, 'thread');
    let opened;
    const result = await openSessionTarget(target, { openExternal: async uri => { opened = uri; } });
    assert.equal(opened, `codex://threads/${id}`);
    assert.equal(result.exact, true);
    assert.notEqual(sessionNavigation({ ...session, resumeId: id.replace('abc', 'def') }).uri, opened);
  });

  it('never sends WSL sessions to an unrelated local Codex app', () => {
    const session = { agent: 'Codex', id: `codex-wsl-${id}`, status: 'idle', cwd: '/home/dev/app' };
    assert.equal(sessionNavigation(session, { platform: 'win32' }).kind, 'app');
    const target = sessionNavigation(session, { platform: 'win32', wsl: { distro: 'Ubuntu' } });
    assert.equal(target.kind, 'resume');
    assert.equal(target.distro, 'Ubuntu');
    assert.deepEqual(target.args, ['resume', id]);
    const other = sessionNavigation({ ...session, sourceRoot: '\\\\wsl$\\Debian\\home\\dev\\.codex\\sessions' }, { platform: 'win32', wsl: { distro: 'Ubuntu' } });
    assert.equal(other.distro, 'Debian');
  });

  it('keeps custom Codex storage on its own CLI instead of opening the default app database', () => {
    const target = sessionNavigation({ agent: 'Codex', id: `codex-${id}`, status: 'idle', cwd: 'C:/work', sourceRoot: 'D:/separate-codex/sessions' }, { platform: 'win32' });
    assert.equal(target.kind, 'resume');
    assert.equal(target.env.CODEX_HOME, 'D:/separate-codex');
    const command = terminalLaunch(target, 'win32');
    const encoded = command.args.at(-1).match(/'([A-Za-z0-9+/=]+)'$/)[1];
    assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /\$env:CODEX_HOME='D:\/separate-codex'/);
  });

  it('offers explicit terminal resume for idle Codex sessions without requiring the app', () => {
    const session = { agent: 'Codex', id: `codex-${id}`, status: 'idle', cwd: '/work' };
    assert.equal(sessionNavigation(session, { platform: 'linux' }).canResume, true);
    assert.equal(sessionNavigation(session, { platform: 'linux', preferTerminal: true }).kind, 'resume');
    assert.equal(sessionNavigation({ ...session, trackingUnavailable: true }, { platform: 'linux', preferTerminal: true }).kind, 'app');
  });

  it('revalidates a terminal resume against current state in the main process', async () => {
    const manager = Object.create(AgentManager.prototype);
    manager.getSessions = () => [{ agent: 'Claude Code', id: `claude-${id}`, status: 'working', cwd: 'C:/work' }];
    const result = await manager.jumpToTerminal(`claude-${id}`, 'resume');
    assert.equal(result.success, false);
    assert.match(result.message, /cannot be resumed/);
    assert.equal((await manager.jumpToTerminal('missing', 'resume')).success, false);
  });

  for (const agent of ['Claude Code', 'Grok', 'OpenCode']) {
    it(`resumes the exact idle ${agent} session without sending a prompt`, () => {
      const prefix = { 'Claude Code': 'claude', Grok: 'grok', OpenCode: 'opencode' }[agent];
      const session = { agent, id: `${prefix}-${id}`, status: 'idle', cwd: '/work/project' };
      const target = sessionNavigation(session, { platform: 'linux' });
      assert.equal(target.kind, 'resume');
      assert.equal(target.args.at(-1), id);
      assert.ok(!target.args.includes('-p'));
      for (const status of ['working', 'permission-request', 'question', 'needs-attention']) {
        assert.equal(sessionNavigation({ ...session, status }, { platform: 'linux' }).kind, 'app');
      }
    });
  }

  it('uses an explicit app fallback for unsupported and invalid targets', () => {
    for (const agent of ['Cursor', 'Antigravity']) assert.equal(sessionNavigation({ agent }).exact, false);
    for (const resumeId of ['--help', '../new', 'new?prompt=bad', 'x;calc', 'a\nb']) {
      assert.equal(sessionNavigation({ agent: 'Codex', id: `codex-${id}`, resumeId }).kind, 'app');
    }
    assert.equal(sessionNavigation({ agent: 'Claude Code', id: 'claude-pending-test', status: 'idle', cwd: '/tmp' }).kind, 'app');
  });

  it('encodes Windows terminal programs and quotes project paths as literals', () => {
    const cwd = "C:\\work\\O'Brien;$(calc)";
    const target = sessionNavigation({ agent: 'Claude Code', id: `claude-${id}`, status: 'idle', cwd }, { platform: 'win32' });
    const command = terminalLaunch(target, 'win32');
    assert.equal(command.bin, 'powershell.exe');
    const encoded = command.args.at(-1).match(/'([A-Za-z0-9+/=]+)'$/)[1];
    const program = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.equal(program, `Set-Location -LiteralPath 'C:\\work\\O''Brien;$(calc)' -ErrorAction Stop; & 'claude' '--resume' '${id}'`);
    assert.doesNotMatch(command.args.at(-1), /\$\(calc\)/);
  });

  it('quotes POSIX paths and emits an interactive terminal command on each platform', () => {
    const target = { kind: 'resume', bin: 'claude', args: ['--resume', id], cwd: "/tmp/a' ; touch bad" };
    const linux = terminalLaunch(target, 'linux');
    assert.equal(linux.bin, 'x-terminal-emulator');
    assert.match(linux.args.at(-1), /cd '\/tmp\/a'\\'' ; touch bad'/);
    const mac = terminalLaunch(target, 'darwin');
    assert.equal(mac.bin, 'osascript');
    assert.match(mac.args[1], /tell application "Terminal"/);
  });

  it('surfaces deep-link and terminal failures without falling through to a different session', async () => {
    await assert.rejects(openSessionTarget({ kind: 'thread', uri: `codex://threads/${id}` }, { openExternal: async () => { throw new Error('No handler'); } }), /No handler/);
    const target = { kind: 'resume', bin: 'claude', args: ['--resume', id], cwd: '/tmp' };
    await assert.rejects(openSessionTarget(target, { platform: 'darwin', launch: () => {
      const child = new EventEmitter();
      process.nextTick(() => child.emit('exit', 1));
      return child;
    } }), /Could not open/);
  });
});
