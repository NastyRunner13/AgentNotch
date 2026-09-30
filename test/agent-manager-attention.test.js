const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AgentManager } = require('../src/main/agent-manager');
const bridge = require('../src/main/permissions/permission-bridge');

function setup(t, kind, orphan = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = { id: 'request-1', kind, tool: 'Read', notchSessionId: orphan ? '' : 'claude-test' };
  const session = {
    id: orphan ? 'claude-pending-request-1' : 'claude-test', agent: 'Claude Code',
    status: kind === 'question' ? 'question' : 'permission-request',
    [kind === 'question' ? 'question' : 'permissionRequest']: { requestId: request.id }
  };
  const state = { pending: [request], sessions: [session], alerts: [] };
  t.mock.method(bridge, 'listPending', () => state.pending);
  const manager = Object.create(AgentManager.prototype);
  Object.assign(manager, {
    settings: { alwaysAllowEnabled: false },
    _knownPendingIds: new Set(), _attentionEpisodes: new Map(), _prevStatus: new Map(),
    _snoozes: new Map(), _attentionAcks: new Map(), _emitTimer: null,
    _observePerformance: () => {}, _usageTracker: { ingest: () => {} },
    getSessions: () => state.sessions
  });
  manager.on('attention', sessions => state.alerts.push(sessions.map(s => s.id)));
  return { manager, state, request, session };
}

describe('permission attention delivery', () => {
  for (const kind of ['permission', 'question']) {
    for (const orphan of [false, true]) {
      it(`alerts once for each ${orphan ? 'orphan ' : ''}${kind} request across watcher and scheduled updates`, (t) => {
        const { manager, state, request, session } = setup(t, kind, orphan);
        manager._onPendingPermissionsChanged();
        manager._onPendingPermissionsChanged();
        t.mock.timers.tick(200);
        assert.deepEqual(state.alerts, [[session.id]]);

        manager._onPendingPermissionsChanged();
        t.mock.timers.tick(200);
        assert.equal(state.alerts.length, 1);

        request.id = 'request-2';
        (session.question || session.permissionRequest).requestId = request.id;
        manager._onPendingPermissionsChanged();
        t.mock.timers.tick(200);
        assert.equal(state.alerts.length, 2, 'A different request must still alert');
      });
    }
  }

  it('does not alert for an already acknowledged episode', (t) => {
    const { manager, state, session } = setup(t, 'permission');
    session.attentionAcknowledged = true;
    manager._onPendingPermissionsChanged();
    t.mock.timers.tick(200);
    assert.equal(state.alerts.length, 0);
  });

  it('still auto-approves new requests before scheduled attention delivery', (t) => {
    const { manager, state } = setup(t, 'permission');
    manager.settings.alwaysAllowEnabled = true;
    let approvals = 0;
    manager._autoAllowPending = () => {
      approvals++;
      state.pending = [];
      state.sessions = [];
      return true;
    };
    manager._onPendingPermissionsChanged();
    t.mock.timers.tick(200);
    assert.equal(approvals, 1);
    assert.equal(state.alerts.length, 0);
  });
});
