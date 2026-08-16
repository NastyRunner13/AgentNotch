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

  it('normalizes agent display names, tool case, and cwd basename', () => {
    const n = mem.normalizeEntry({
      agent: 'Claude Code',
      tool: 'Bash',
      cwd: 'C:\\dev\\agent-notch'
    });
    assert.deepEqual(n, { agent: 'claude', tool: 'bash', project: 'agent-notch' });
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
    assert.equal(mem.matches(store, { agent: 'claude', tool: 'read', project: 'proj' }), true);
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
      project: 'alpha'
    });
    assert.equal(mem.matches(store, { agent: 'claude', tool: 'bash', project: 'beta' }), false);
    assert.equal(mem.matches(store, { agent: 'claude', tool: 'read', project: 'alpha' }), false);
  });

  it('persists atomically and reloads', () => {
    const store = mem.remember(mem.clearAll(), {
      agent: 'claude',
      tool: 'bash',
      project: 'agent-notch'
    }, 42);
    mem.save(store, file);
    const loaded = mem.load(file);
    assert.equal(mem.matches(loaded, { agent: 'claude', tool: 'bash', project: 'agent-notch' }), true);
    assert.equal(loaded.entries[0].at, 42);
  });

  it('load returns empty store when file is missing or corrupt', () => {
    assert.deepEqual(mem.load(file).entries, []);
    fs.writeFileSync(file, 'not-json');
    assert.deepEqual(mem.load(file).entries, []);
  });
});
