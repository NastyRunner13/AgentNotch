const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  filterHistoryEntries,
  partitionPinnedHistory,
  trimHistoryEntries,
  buildArchiveSnapshot,
  applyHistoryPin,
  buildHistoryResumeTarget,
  resolveHistoryResumeTarget,
  isDispatchableHistoryAgent,
  projectFolderName,
  DEFAULT_CONTINUE_PROMPT
} = require('../src/main/history-utils');
const { buildResumeCommand } = require('../src/main/agent-manager');

const UUID = '123e4567-e89b-42d3-a456-426614174000';

function entry(overrides = {}) {
  return {
    id: `claude-${UUID}`,
    agent: 'Claude Code',
    taskName: 'Fix auth bug',
    userPrompt: 'please fix login',
    lastMessage: 'patched middleware',
    cwd: 'C:\\dev\\agent-notch',
    archivedAt: 1_000,
    pinned: false,
    pinnedAt: null,
    ...overrides
  };
}

describe('filterHistoryEntries', () => {
  const list = [
    entry({ id: 'a1', taskName: 'Fix auth bug', agent: 'Claude Code' }),
    entry({ id: 'a2', taskName: 'Add charts', agent: 'Codex', cwd: '/tmp/dashboard' }),
    entry({ id: 'a3', taskName: 'Idle', agent: 'Grok', userPrompt: 'refactor billing' })
  ];

  it('returns all when query empty', () => {
    assert.equal(filterHistoryEntries(list, '').length, 3);
    assert.equal(filterHistoryEntries(list, '   ').length, 3);
  });

  it('matches task name case-insensitively', () => {
    const hit = filterHistoryEntries(list, 'auth');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, 'a1');
  });

  it('matches project folder basename', () => {
    const hit = filterHistoryEntries(list, 'dashboard');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, 'a2');
  });

  it('matches agent and prompt text', () => {
    assert.equal(filterHistoryEntries(list, 'codex').length, 1);
    assert.equal(filterHistoryEntries(list, 'billing').length, 1);
  });

  it('handles non-arrays', () => {
    assert.deepEqual(filterHistoryEntries(null, 'x'), []);
  });
});

describe('partitionPinnedHistory', () => {
  it('sorts pinned by pinnedAt desc and leaves unpinned order', () => {
    const list = [
      entry({ id: 'u1', pinned: false }),
      entry({ id: 'p1', pinned: true, pinnedAt: 100 }),
      entry({ id: 'u2', pinned: false }),
      entry({ id: 'p2', pinned: true, pinnedAt: 200 })
    ];
    const { pinned, unpinned } = partitionPinnedHistory(list);
    assert.deepEqual(pinned.map((e) => e.id), ['p2', 'p1']);
    assert.deepEqual(unpinned.map((e) => e.id), ['u1', 'u2']);
  });
});

describe('trimHistoryEntries', () => {
  it('never drops pinned entries when over max', () => {
    const list = [];
    for (let i = 0; i < 10; i++) {
      list.push(entry({ id: `u${i}`, pinned: false, archivedAt: i + 1 }));
    }
    list.push(entry({ id: 'pin-old', pinned: true, pinnedAt: 1, archivedAt: 0 }));
    const trimmed = trimHistoryEntries(list, 5);
    assert.ok(trimmed.some((e) => e.id === 'pin-old'));
    assert.equal(trimmed.filter((e) => !e.pinned).length, 5);
    // Most recent unpinned kept
    assert.ok(trimmed.some((e) => e.id === 'u9'));
    assert.ok(!trimmed.some((e) => e.id === 'u0'));
  });
});

describe('buildArchiveSnapshot', () => {
  it('stores resumeId and preserves pin flags from previous', () => {
    const session = {
      id: `codex-rollout-${UUID}`,
      agent: 'Codex',
      taskName: 't',
      resumeId: UUID,
      cwd: '/tmp/p',
      toolCalls: ['Bash'],
      status: 'idle'
    };
    const prev = { id: session.id, pinned: true, pinnedAt: 42, dismissedMarker: 99 };
    const snap = buildArchiveSnapshot(session, prev, 5000);
    assert.equal(snap.resumeId, UUID);
    assert.equal(snap.pinned, true);
    assert.equal(snap.pinnedAt, 42);
    assert.equal(snap.dismissedMarker, 99);
    assert.equal(snap.archivedAt, 5000);
  });

  it('defaults pin off without previous', () => {
    const snap = buildArchiveSnapshot({ id: 'claude-x', agent: 'Claude Code' });
    assert.equal(snap.pinned, false);
    assert.equal(snap.pinnedAt, null);
  });
});

describe('applyHistoryPin', () => {
  it('sets and clears pin', () => {
    const base = entry({ pinned: false });
    const on = applyHistoryPin(base, true, 123);
    assert.equal(on.pinned, true);
    assert.equal(on.pinnedAt, 123);
    const off = applyHistoryPin(on, false, 999);
    assert.equal(off.pinned, false);
    assert.equal(off.pinnedAt, null);
  });
});

describe('buildHistoryResumeTarget', () => {
  const isDirectory = (p) => p === 'C:\\dev\\agent-notch' || p === '/tmp/p';

  it('returns live when session still running', () => {
    const e = entry({ id: 'claude-live' });
    const t = buildHistoryResumeTarget(e, {
      liveIds: new Set(['claude-live']),
      isDirectory
    });
    assert.equal(t.mode, 'live');
    assert.equal(t.sessionId, 'claude-live');
  });

  it('returns resume for dispatchable + valid cwd', () => {
    const t = buildHistoryResumeTarget(entry(), { isDirectory });
    assert.equal(t.mode, 'resume');
    assert.equal(t.cwd, 'C:\\dev\\agent-notch');
  });

  it('returns new when canResume is false but cwd ok', () => {
    const t = resolveHistoryResumeTarget(entry(), { isDirectory, canResume: false });
    assert.equal(t.mode, 'new');
    assert.equal(t.agent, 'Claude Code');
  });

  it('returns focus for Cursor', () => {
    const t = buildHistoryResumeTarget(
      entry({ agent: 'Cursor', id: 'cursor-1' }),
      { isDirectory }
    );
    assert.equal(t.mode, 'focus');
  });

  it('returns focus when cwd missing', () => {
    const t = buildHistoryResumeTarget(entry({ cwd: null }), { isDirectory });
    assert.equal(t.mode, 'focus');
  });
});

describe('buildResumeCommand with history-shaped objects', () => {
  it('builds Claude resume from history snapshot fields', () => {
    const cmd = buildResumeCommand({
      id: `claude-${UUID}`,
      agent: 'Claude Code',
      cwd: 'C:\\dev\\proj',
      resumeId: null
    }, DEFAULT_CONTINUE_PROMPT);
    assert.ok(cmd);
    assert.equal(cmd.bin, 'claude');
    assert.deepEqual(cmd.args, ['-p', '--resume', UUID, DEFAULT_CONTINUE_PROMPT]);
  });

  it('prefers resumeId for Codex history entries', () => {
    const cmd = buildResumeCommand({
      id: `codex-rollout-2026-07-20T10-00-00-${UUID}`,
      agent: 'Codex',
      resumeId: UUID,
      cwd: '/tmp/proj'
    }, 'go');
    assert.deepEqual(cmd.args, ['exec', '--skip-git-repo-check', 'resume', UUID, 'go']);
  });
});

describe('misc helpers', () => {
  it('isDispatchableHistoryAgent', () => {
    assert.equal(isDispatchableHistoryAgent('Claude Code'), true);
    assert.equal(isDispatchableHistoryAgent('Cursor'), false);
  });

  it('projectFolderName', () => {
    assert.equal(projectFolderName('C:\\dev\\agent-notch'), 'agent-notch');
    assert.equal(projectFolderName('/tmp/foo/bar'), 'bar');
    assert.equal(projectFolderName(''), '');
  });
});
