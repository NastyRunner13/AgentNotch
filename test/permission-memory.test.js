const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mem = require('../src/main/permissions/permission-memory');

describe('permission-memory', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'an-perm-'));
    file = path.join(dir, 'permission-memory.json');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('normalizes agent and tool while retaining the full project path', () => {
    const n = mem.normalizeEntry({
      agent: 'Claude Code',
      tool: 'Bash',
      cwd: 'C:\\dev\\agent-notch'
    });
    assert.deepEqual(n, { agent: 'claude', tool: 'bash', project: 'C:/dev/agent-notch', source: 'local' });
  });

  it('rejects incomplete entries', () => {
    assert.equal(mem.normalizeEntry({ agent: 'claude', tool: 'bash' }), null);
    assert.equal(mem.normalizeEntry({ tool: 'bash', project: 'x' }), null);
    assert.equal(mem.normalizeEntry(null), null);
  });

  it('remember / matches / forget round-trip', () => {
    let store = mem.clearAll();
    const rec = { agent: 'Claude Code', tool: 'Read', cwd: '/tmp/proj' };
    assert.equal(mem.matches(store, rec), false);

    store = mem.remember(store, rec, 1000);
    assert.equal(mem.matches(store, { agent: 'claude', tool: 'read', project: '/tmp/proj' }), true);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].at, 1000);

    store = mem.remember(store, rec, 2000);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].at, 2000);

    store = mem.forget(store, rec);
    assert.equal(mem.matches(store, rec), false);
    assert.equal(store.entries.length, 0);
  });

  it('does not match a different project or tool', () => {
    let store = mem.remember(mem.clearAll(), {
      agent: 'claude',
      tool: 'bash',
      project: '/work/alpha'
    });
    assert.equal(mem.matches(store, { agent: 'claude', tool: 'bash', project: '/work/beta' }), false);
    assert.equal(mem.matches(store, { agent: 'claude', tool: 'read', project: '/work/alpha' }), false);
  });

  it('persists atomically and reloads', () => {
    const store = mem.remember(mem.clearAll(), {
      agent: 'claude',
      tool: 'bash',
      project: '/work/agent-notch'
    }, 42);
    mem.save(store, file);
    const loaded = mem.load(file);
    assert.equal(mem.matches(loaded, { agent: 'claude', tool: 'bash', project: '/work/agent-notch' }), true);
    assert.equal(loaded.entries[0].at, 42);
    assert.equal(loaded.version, 2);
  });

  it('never matches a same-named project in another directory', () => {
    const first = { agent: 'claude', tool: 'Bash', cwd: 'C:/work/client-a/app' };
    const store = mem.remember(mem.clearAll(), first);
    assert.equal(mem.matches(store, first), true);
    assert.equal(mem.matches(store, { ...first, cwd: 'C:/work/client-b/app' }), false);
  });

  it('retains path case so case-sensitive projects cannot share approval', () => {
    for (const cwd of ['/work/App', 'C:/work/App']) {
      const first = { agent: 'claude', tool: 'Bash', cwd };
      const store = mem.remember(mem.clearAll(), first);
      assert.equal(mem.matches(store, { ...first, cwd: cwd.replace('App', 'app') }), false);
    }
  });

  it('normalizes Windows separators and drive letters, and trailing separators', () => {
    const first = { agent: 'claude', tool: 'Read', cwd: 'c:\\work\\app\\' };
    const store = mem.remember(mem.clearAll(), first);
    assert.equal(mem.matches(store, { ...first, cwd: 'C:/work/app' }), true);
    assert.equal(mem.projectKey('/work/app/'), '/work/app');
  });

  it('rejects ambiguous or missing scope instead of broadening it', () => {
    for (const cwd of ['app', './app', '../app', 'C:app', '/work/link/../app', 'C:/work/link/../app', '/work/\0app']) {
      assert.equal(mem.normalizeEntry({ agent: 'claude', tool: 'Read', cwd }), null, cwd);
    }
    assert.equal(mem.normalizeEntry({ agent: 'claude', tool: 'Read', cwd: '/work/app', source: 'Ubuntu' }), null);
  });

  it('keeps identical Linux paths separate across source homes', () => {
    const first = { agent: 'claude', tool: 'Read', cwd: '/home/dev/app', source: '\\\\wsl$\\Ubuntu\\home\\dev\\.agent-notch' };
    const store = mem.remember(mem.clearAll(), first);
    assert.equal(mem.matches(store, first), true);
    assert.equal(mem.matches(store, { ...first, source: '\\\\wsl$\\Debian\\home\\dev\\.agent-notch' }), false);
    assert.equal(mem.matches(store, { ...first, source: undefined }), false);
    mem.save(store, file);
    assert.equal(mem.matches(mem.load(file), first), true);
  });

  it('discards legacy rules and does not reactivate them when saving a new rule', () => {
    const legacy = { version: 1, entries: [{ agent: 'claude', tool: 'bash', project: 'app' }] };
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.deepEqual(mem.load(file), { version: 2, entries: [] });
    assert.equal(mem.matches(legacy, { agent: 'claude', tool: 'bash', project: 'app' }), false);
    const next = mem.remember(legacy, { agent: 'claude', tool: 'Read', cwd: '/work/new' });
    assert.equal(next.version, 2);
    assert.equal(next.entries.length, 1);
    assert.equal(next.entries[0].project, '/work/new');
  });

  it('load returns empty store when file is missing or corrupt', () => {
    assert.deepEqual(mem.load(file).entries, []);
    fs.writeFileSync(file, 'not-json');
    assert.deepEqual(mem.load(file).entries, []);
  });

  it('manager auto-approval requires the same full project and source', (t) => {
    const { AgentManager } = require('../src/main/agent-manager');
    const bridge = require('../src/main/permissions/permission-bridge');
    const manager = Object.create(AgentManager.prototype);
    manager._permissionMemoryPath = file;
    const scope = { agent: 'claude', tool: 'Bash', cwd: '/home/dev/app', source: '//wsl$/Ubuntu/home/dev/.agent-notch' };
    mem.save(mem.remember(mem.clearAll(), scope), file);
    const decisions = [];
    t.mock.method(bridge, 'submitDecision', (id, decision) => {
      decisions.push({ id, decision });
      return { success: true, remote: true };
    });
    const pending = { id: 'permission-1', kind: 'permission', tool: 'Bash', cwd: scope.cwd, _home: scope.source };
    assert.equal(manager._autoAllowPending(pending), true);
    for (const changed of [
      { cwd: '/home/other/app' },
      { _home: '//wsl$/Debian/home/dev/.agent-notch' },
      { _home: undefined },
      { kind: 'question' }
    ]) {
      assert.equal(manager._autoAllowPending({ ...pending, ...changed }), false);
    }
    assert.deepEqual(decisions, [{ id: pending.id, decision: 'allow' }]);
  });

  it('remembering uses the pending request scope and approves that exact request', async (t) => {
    const { AgentManager } = require('../src/main/agent-manager');
    const bridge = require('../src/main/permissions/permission-bridge');
    const manager = Object.create(AgentManager.prototype);
    const pending = { id: 'permission-1', kind: 'permission', tool: 'Read', cwd: '/home/dev/app', _home: '//wsl$/Ubuntu/home/dev/.agent-notch' };
    Object.assign(manager, {
      _permissionMemoryPath: file,
      getSessions: () => [{ id: 'claude-1', agent: 'Claude Code', remoteApprove: true, cwd: '/stale/project', permissionRequest: { requestId: pending.id, tool: 'Bash' } }],
      _scheduleEmit: () => {},
      approvePermission: () => { throw new Error('Must approve the exact pending request'); }
    });
    t.mock.method(bridge, 'listPending', () => [pending]);
    const decisions = [];
    t.mock.method(bridge, 'submitDecision', (id, decision) => {
      decisions.push({ id, decision });
      return { success: true, remote: true };
    });
    const result = await manager.rememberAlwaysAllow('claude-1');
    assert.equal(result.success, true);
    assert.equal(result.remote, true);
    assert.equal(result.remembered, true);
    assert.deepEqual(decisions, [{ id: pending.id, decision: 'allow' }]);
    assert.equal(mem.matches(mem.load(file), { agent: 'claude', tool: pending.tool, cwd: pending.cwd, source: pending._home }), true);
    assert.equal(mem.matches(mem.load(file), { agent: 'claude', tool: 'Bash', cwd: '/stale/project', source: pending._home }), false);
  });

  it('does not remember expired, unscoped, or failed requests', async (t) => {
    const { AgentManager } = require('../src/main/agent-manager');
    const bridge = require('../src/main/permissions/permission-bridge');
    const manager = Object.create(AgentManager.prototype);
    Object.assign(manager, {
      _permissionMemoryPath: file,
      getSessions: () => [{ id: 'claude-1', agent: 'Claude Code', remoteApprove: true, cwd: '/work/app', permissionRequest: { requestId: 'permission-1', tool: 'Read' } }],
      _scheduleEmit: () => {},
      approvePermission: () => { throw new Error('Must approve the exact pending request'); }
    });
    let pending = [];
    t.mock.method(bridge, 'listPending', () => pending);
    t.mock.method(bridge, 'submitDecision', () => ({ success: false, message: 'Request expired' }));
    for (const rows of [[], [{ id: 'permission-1', tool: 'Read', cwd: '/work/app' }], [{ id: 'permission-1', tool: 'Read', cwd: '/work/app', _home: '/home/dev/.agent-notch' }]]) {
      pending = rows;
      const result = await manager.rememberAlwaysAllow('claude-1');
      assert.equal(result.success, false);
      assert.equal(Boolean(result.remembered), false);
      assert.equal(fs.existsSync(file), false);
    }
  });
});
