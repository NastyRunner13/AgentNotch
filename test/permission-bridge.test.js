const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Isolate filesystem under a temp home before loading the module
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-perm-'));
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;

process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// Windows uses USERPROFILE; Node os.homedir() prefers USERPROFILE on win32
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP_HOME;
}

// Clear module cache so permission-bridge picks up env (os.homedir is fixed at load time)
// Actually os.homedir() reads env each call on Node - good.
const bridge = require('../src/main/permission-bridge');

describe('permission-bridge', () => {
  before(() => {
    bridge.ensureDirs();
  });

  after(() => {
    if (ORIG_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIG_HOME;
    if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = ORIG_USERPROFILE;
    try {
      fs.rmSync(TMP_HOME, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    // Clean pending/decisions between tests
    for (const p of bridge.listPending()) {
      bridge.cleanupRequest(p.id);
    }
    const ddir = bridge.decisionsDir();
    if (fs.existsSync(ddir)) {
      for (const f of fs.readdirSync(ddir)) {
        try { fs.unlinkSync(path.join(ddir, f)); } catch { /* */ }
      }
    }
  });

  it('toNotchSessionId maps transcript basename', () => {
    assert.equal(
      bridge.toNotchSessionId('abc', '/Users/x/.claude/projects/p/00893aaf-19fa.jsonl'),
      'claude-00893aaf-19fa'
    );
    assert.equal(bridge.toNotchSessionId('sess-1', ''), 'claude-sess-1');
    assert.equal(bridge.toNotchSessionId('claude-already', ''), 'claude-already');
  });

  it('createPendingFromHookInput + submitDecision allow', async () => {
    const pending = bridge.createPendingFromHookInput({
      session_id: 'sess-xyz',
      transcript_path: path.join(TMP_HOME, '.claude', 'projects', 'hash', 'sess-xyz.jsonl'),
      cwd: '/tmp/proj',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test', description: 'Run tests' }
    });

    assert.ok(pending.id);
    assert.equal(pending.tool, 'Bash');
    assert.equal(pending.notchSessionId, 'claude-sess-xyz');
    assert.equal(bridge.listPending().length, 1);

    const res = bridge.submitDecisionForSession('claude-sess-xyz', 'allow');
    assert.equal(res.success, true);
    assert.equal(res.remote, true);
    assert.equal(res.decision, 'allow');

    // Decision file exists for the waiting hook
    const decisionFile = path.join(bridge.decisionsDir(), `${pending.id}.json`);
    const decision = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    assert.equal(decision.decision, 'allow');
  });

  it('buildHookResponse shapes PermissionRequest output', () => {
    const allow = bridge.buildHookResponse('allow');
    assert.equal(allow.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.equal(allow.hookSpecificOutput.decision.behavior, 'allow');

    const deny = bridge.buildHookResponse('deny');
    assert.equal(deny.hookSpecificOutput.decision.behavior, 'deny');
    assert.ok(deny.hookSpecificOutput.decision.message);
  });

  it('mergePendingIntoSessions upgrades Claude session', () => {
    const pending = bridge.createPendingFromHookInput({
      session_id: 'm1',
      transcript_path: '/x/m1.jsonl',
      tool_name: 'Edit',
      tool_input: { file_path: '/x/a.ts' }
    });

    const sessions = [
      {
        id: 'claude-m1',
        agent: 'Claude Code',
        status: 'working',
        taskName: 'Refactor',
        lastTime: 1,
        lastActivityAt: 1
      }
    ];

    const merged = bridge.mergePendingIntoSessions(sessions);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, 'permission-request');
    assert.equal(merged[0].remoteApprove, true);
    assert.equal(merged[0].permissionRequest.tool, 'Edit');
    assert.equal(merged[0].permissionRequest.requestId, pending.id);
  });

  it('mergePendingIntoSessions creates synthetic session for orphan pending', () => {
    const pending = bridge.createPendingFromHookInput({
      session_id: 'orphan-1',
      transcript_path: '',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/f.js' }
    });

    const merged = bridge.mergePendingIntoSessions([]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].agent, 'Claude Code');
    assert.equal(merged[0].status, 'permission-request');
    assert.equal(merged[0].remoteApprove, true);
    assert.equal(merged[0].permissionRequest.requestId, pending.id);
  });

  it('findPendingForSession supports claude-pending- prefix', () => {
    const pending = bridge.createPendingFromHookInput({
      session_id: '',
      transcript_path: '',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    });
    // Force null notch id
    const pPath = path.join(bridge.pendingDir(), `${pending.id}.json`);
    const data = JSON.parse(fs.readFileSync(pPath, 'utf8'));
    data.notchSessionId = null;
    fs.writeFileSync(pPath, JSON.stringify(data), 'utf8');

    const found = bridge.findPendingForSession(`claude-pending-${pending.id}`);
    assert.ok(found);
    assert.equal(found.id, pending.id);
  });

  it('waitForDecision resolves after submitDecision', async () => {
    const pending = bridge.createPendingFromHookInput({
      session_id: 'wait-1',
      transcript_path: '/t/wait-1.jsonl',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' }
    });

    setTimeout(() => {
      bridge.submitDecision(pending.id, 'deny');
    }, 80);

    const decision = await bridge.waitForDecision(pending.id, 2000);
    assert.equal(decision, 'deny');
  });

  it('hook CLI exits with allow JSON when decision is written', async () => {
    // Use the real bridge script with env pointing at TMP_HOME
    const script = path.join(__dirname, '..', 'src', 'main', 'permission-bridge.js');
    const hookInput = JSON.stringify({
      session_id: 'cli-test',
      transcript_path: path.join(TMP_HOME, 'cli-test.jsonl'),
      cwd: TMP_HOME,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'true' }
    });

    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        HOME: TMP_HOME,
        USERPROFILE: TMP_HOME,
        AGENT_NOTCH_PERMISSION_TIMEOUT_MS: '5000',
        AGENT_NOTCH_PERMISSION_POLL_MS: '50'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.stdin.write(hookInput);
    child.stdin.end();

    // Wait until pending appears, then decide
    const deadline = Date.now() + 4000;
    let pendingId = null;
    while (Date.now() < deadline) {
      // list from same dirs (module already uses TMP_HOME)
      const list = bridge.listPending().filter((p) => p.claudeSessionId === 'cli-test');
      if (list.length) {
        pendingId = list[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(pendingId, `pending not created. stderr=${stderr}`);
    bridge.submitDecision(pendingId, 'allow');

    const code = await new Promise((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', reject);
      setTimeout(() => {
        child.kill();
        reject(new Error('hook CLI timed out'));
      }, 5000);
    });

    assert.equal(code, 0, `stderr=${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'allow');
  });

  it('installClaudeHook writes settings and isHookInstalled', () => {
    const claudeDir = path.join(TMP_HOME, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // Pre-existing unrelated hook should be preserved
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }]
        }
      }, null, 2),
      'utf8'
    );

    const res = bridge.installClaudeHook();
    assert.equal(res.success, true);
    assert.ok(fs.existsSync(bridge.bridgeInstallPath()));
    assert.equal(bridge.isHookInstalled(), true);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.ok(settings.hooks.PreToolUse);
    assert.ok(settings.hooks.PermissionRequest);
    const handler = settings.hooks.PermissionRequest[0].hooks[0];
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, 'node');
    assert.ok(String(handler.args[0]).includes('claude-permission-bridge.js'));

    const un = bridge.uninstallClaudeHook();
    assert.equal(un.success, true);
    assert.equal(bridge.isHookInstalled(), false);
    const after = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.ok(after.hooks.PreToolUse);
    assert.equal(after.hooks.PermissionRequest, undefined);
  });
});
