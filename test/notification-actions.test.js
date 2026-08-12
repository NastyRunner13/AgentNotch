const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canRemoteApprove,
  canRemoteAnswer,
  notificationActionsFor
} = require('../src/main/notification-actions');

describe('notificationActionsFor', () => {
  it('returns nothing for idle / done / missing', () => {
    assert.deepEqual(notificationActionsFor(null), []);
    assert.deepEqual(notificationActionsFor({ status: 'idle' }), []);
    assert.deepEqual(notificationActionsFor({ status: 'working' }), []);
  });

  it('Claude remote permission → Allow · Deny · Snooze', () => {
    const actions = notificationActionsFor({
      status: 'permission-request',
      remoteApprove: true,
      agent: 'Claude Code'
    });
    assert.deepEqual(actions.map((a) => a.id), ['allow', 'deny', 'snooze']);
    assert.deepEqual(actions.map((a) => a.text), ['Allow', 'Deny', 'Snooze']);
  });

  it('non-remote permission → Jump · Snooze', () => {
    const actions = notificationActionsFor({
      status: 'permission-request',
      remoteApprove: false,
      agent: 'Grok'
    });
    assert.deepEqual(actions.map((a) => a.id), ['jump', 'snooze']);
  });

  it('dispatchable question with 1–2 short options → answers + Snooze', () => {
    const actions = notificationActionsFor({
      status: 'question',
      agent: 'Claude Code',
      question: { text: 'Which?', options: ['Yes', 'No'] }
    });
    assert.equal(actions[0].id, 'answer');
    assert.equal(actions[0].answer, 'Yes');
    assert.equal(actions[1].answer, 'No');
    assert.equal(actions[2].id, 'snooze');
  });

  it('dispatchable question with long / many options → Open · Snooze', () => {
    const long = notificationActionsFor({
      status: 'question',
      agent: 'Codex',
      question: { options: ['This is a very long option label indeed'] }
    });
    assert.deepEqual(long.map((a) => a.id), ['open', 'snooze']);

    const many = notificationActionsFor({
      status: 'question',
      agent: 'Grok',
      question: { options: ['A', 'B', 'C'] }
    });
    assert.deepEqual(many.map((a) => a.id), ['open', 'snooze']);
  });

  it('non-dispatchable question / needs-attention → Jump · Snooze', () => {
    assert.deepEqual(
      notificationActionsFor({ status: 'question', agent: 'Cursor' }).map((a) => a.id),
      ['jump', 'snooze']
    );
    assert.deepEqual(
      notificationActionsFor({ status: 'needs-attention', agent: 'Claude Code' }).map((a) => a.id),
      ['jump', 'snooze']
    );
  });

  it('stalled working session → Jump · Snooze', () => {
    const actions = notificationActionsFor({
      status: 'working',
      stalled: true,
      agent: 'Claude Code'
    });
    assert.deepEqual(actions.map((a) => a.id), ['jump', 'snooze']);
  });

  it('canRemoteApprove / canRemoteAnswer flags', () => {
    assert.equal(canRemoteApprove({ status: 'permission-request', remoteApprove: true }), true);
    assert.equal(canRemoteApprove({ status: 'permission-request', remoteApprove: false }), false);
    assert.equal(canRemoteAnswer({ status: 'question', agent: 'Claude Code' }), true);
    assert.equal(canRemoteAnswer({ status: 'question', agent: 'Cursor' }), false);
  });
});
