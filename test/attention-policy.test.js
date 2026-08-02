const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  kindFromStatus,
  isAttentionStatus,
  channelsForEvent,
  channelsForSessions,
  clampAutohideDelayMs,
  normalizeNotchAlign,
  normalizeSnoozePreset,
  createSnoozeEntry,
  isSnoozeActive,
  isSessionSnoozed,
  formatSnoozeLabel,
  agentIdFromName,
  normalizeMutedAgents,
  isFocusMode,
  isAgentMuted,
  attentionRank,
  attentionEpisodeKey,
  isAttentionEpisodeAcknowledged,
  compareSessionsByAttention,
  buildAttentionQueue,
  annotateAttentionQueue,
  formatAttentionStatusLine
} = require('../src/main/attention-policy');
const { DEFAULT_SETTINGS } = require('../src/main/settings-defaults');

describe('attention-policy', () => {
  describe('kindFromStatus', () => {
    it('maps known statuses', () => {
      assert.equal(kindFromStatus('permission-request'), 'permission-request');
      assert.equal(kindFromStatus('question'), 'question');
      assert.equal(kindFromStatus('needs-attention'), 'needs-attention');
      assert.equal(kindFromStatus('done'), 'done');
    });

    it('returns null for unknown', () => {
      assert.equal(kindFromStatus('working'), null);
      assert.equal(kindFromStatus('idle'), null);
      assert.equal(kindFromStatus(''), null);
    });
  });

  describe('isAttentionStatus', () => {
    it('flags human-needed statuses only', () => {
      assert.equal(isAttentionStatus('permission-request'), true);
      assert.equal(isAttentionStatus('question'), true);
      assert.equal(isAttentionStatus('needs-attention'), true);
      assert.equal(isAttentionStatus('working'), false);
      assert.equal(isAttentionStatus('idle'), false);
    });
  });

  describe('channelsForEvent defaults', () => {
    it('matches legacy behavior for attention + done', () => {
      const perm = channelsForEvent(DEFAULT_SETTINGS, { kind: 'permission-request' });
      assert.deepEqual(perm, { sound: true, notify: true, reveal: true });

      const done = channelsForEvent(DEFAULT_SETTINGS, { kind: 'done' });
      assert.deepEqual(done, { sound: false, notify: true, reveal: true });
    });

    it('master soundAlerts off kills all sound including done', () => {
      const s = { ...DEFAULT_SETTINGS, soundAlerts: false, soundOnDone: true };
      assert.equal(channelsForEvent(s, { kind: 'permission-request' }).sound, false);
      assert.equal(channelsForEvent(s, { kind: 'done' }).sound, false);
    });

    it('master desktopNotifications off kills all notify', () => {
      const s = { ...DEFAULT_SETTINGS, desktopNotifications: false };
      assert.equal(channelsForEvent(s, { kind: 'permission-request' }).notify, false);
      assert.equal(channelsForEvent(s, { kind: 'done' }).notify, false);
    });

    it('can silence done notify while keeping permission sound', () => {
      const s = { ...DEFAULT_SETTINGS, notifyOnDone: false };
      const perm = channelsForEvent(s, { kind: 'permission-request' });
      const done = channelsForEvent(s, { kind: 'done' });
      assert.equal(perm.sound, true);
      assert.equal(perm.notify, true);
      assert.equal(done.notify, false);
      assert.equal(done.sound, false);
    });

    it('soundOnDone requires explicit true', () => {
      const off = channelsForEvent({ ...DEFAULT_SETTINGS, soundOnDone: false }, { kind: 'done' });
      const on = channelsForEvent({ ...DEFAULT_SETTINGS, soundOnDone: true }, { kind: 'done' });
      assert.equal(off.sound, false);
      assert.equal(on.sound, true);
    });

    it('reveal flags are independent of masters', () => {
      const s = {
        ...DEFAULT_SETTINGS,
        soundAlerts: false,
        desktopNotifications: false,
        revealOnAttention: false,
        revealOnDone: true
      };
      assert.equal(channelsForEvent(s, { kind: 'question' }).reveal, false);
      assert.equal(channelsForEvent(s, { kind: 'done' }).reveal, true);
    });

    it('unknown kind is all off', () => {
      assert.deepEqual(
        channelsForEvent(DEFAULT_SETTINGS, { kind: 'nope' }),
        { sound: false, notify: false, reveal: false }
      );
    });

    it('snoozed mutes sound and notify but keeps reveal', () => {
      const perm = channelsForEvent(DEFAULT_SETTINGS, {
        kind: 'permission-request',
        snoozed: true
      });
      assert.deepEqual(perm, { sound: false, notify: false, reveal: true });

      const done = channelsForEvent(
        { ...DEFAULT_SETTINGS, soundOnDone: true },
        { kind: 'done', snoozed: true }
      );
      assert.deepEqual(done, { sound: false, notify: false, reveal: true });
    });

    it('focusMode mutes sound and notify but keeps reveal', () => {
      const s = { ...DEFAULT_SETTINGS, focusMode: true, soundOnDone: true };
      assert.deepEqual(
        channelsForEvent(s, { kind: 'permission-request' }),
        { sound: false, notify: false, reveal: true }
      );
      assert.deepEqual(
        channelsForEvent(s, { kind: 'done' }),
        { sound: false, notify: false, reveal: true }
      );
    });

    it('muted agent mutes sound and notify for that agent only', () => {
      const s = { ...DEFAULT_SETTINGS, mutedAgents: ['cursor'] };
      const muted = channelsForEvent(s, {
        kind: 'permission-request',
        agent: 'Cursor'
      });
      assert.deepEqual(muted, { sound: false, notify: false, reveal: true });

      const other = channelsForEvent(s, {
        kind: 'permission-request',
        agent: 'Claude Code'
      });
      assert.deepEqual(other, { sound: true, notify: true, reveal: true });
    });
  });

  describe('channelsForSessions', () => {
    it('ORs channels across sessions', () => {
      const s = {
        ...DEFAULT_SETTINGS,
        soundOnPermission: false,
        soundOnQuestion: true,
        notifyOnPermission: true,
        notifyOnQuestion: false
      };
      const ch = channelsForSessions(s, [
        { status: 'permission-request' },
        { status: 'question' }
      ]);
      assert.equal(ch.sound, true); // from question
      assert.equal(ch.notify, true); // from permission
      assert.equal(ch.reveal, true);
    });

    it('forceKind done ignores session status', () => {
      const s = { ...DEFAULT_SETTINGS, notifyOnDone: false };
      const ch = channelsForSessions(s, [{ status: 'idle' }], 'done');
      assert.equal(ch.notify, false);
      assert.equal(ch.sound, false);
      assert.equal(ch.reveal, true);
    });

    it('per-session snooze mutes only that session in OR', () => {
      const ch = channelsForSessions(DEFAULT_SETTINGS, [
        { status: 'permission-request', snoozed: true },
        { status: 'question', snoozed: false }
      ]);
      // question still wants sound+notify
      assert.equal(ch.sound, true);
      assert.equal(ch.notify, true);
      assert.equal(ch.reveal, true);
    });

    it('all snoozed sessions mute sound and notify; reveal still ORs', () => {
      const ch = channelsForSessions(DEFAULT_SETTINGS, [
        { status: 'permission-request', snoozed: true },
        { status: 'needs-attention', snoozed: true }
      ]);
      assert.equal(ch.sound, false);
      assert.equal(ch.notify, false);
      assert.equal(ch.reveal, true);
    });

    it('forceKind done respects per-session snooze', () => {
      const ch = channelsForSessions(
        { ...DEFAULT_SETTINGS, soundOnDone: true },
        [{ status: 'idle', snoozed: true }],
        'done'
      );
      assert.equal(ch.sound, false);
      assert.equal(ch.notify, false);
      assert.equal(ch.reveal, true);
    });

    it('focusMode mutes all sessions in OR', () => {
      const ch = channelsForSessions(
        { ...DEFAULT_SETTINGS, focusMode: true },
        [
          { status: 'permission-request', agent: 'Claude Code' },
          { status: 'question', agent: 'Codex' }
        ]
      );
      assert.equal(ch.sound, false);
      assert.equal(ch.notify, false);
      assert.equal(ch.reveal, true);
    });

    it('per-agent mute mutes only matching sessions in OR', () => {
      const ch = channelsForSessions(
        { ...DEFAULT_SETTINGS, mutedAgents: ['cursor', 'opencode'] },
        [
          { status: 'permission-request', agent: 'Cursor' },
          { status: 'question', agent: 'Claude Code' }
        ]
      );
      // Claude still wants sound+notify
      assert.equal(ch.sound, true);
      assert.equal(ch.notify, true);
      assert.equal(ch.reveal, true);
    });

    it('all sessions muted by agent list silence sound and notify', () => {
      const ch = channelsForSessions(
        { ...DEFAULT_SETTINGS, mutedAgents: ['claude', 'codex'] },
        [
          { status: 'permission-request', agent: 'Claude Code' },
          { status: 'needs-attention', agent: 'Codex' }
        ]
      );
      assert.equal(ch.sound, false);
      assert.equal(ch.notify, false);
      assert.equal(ch.reveal, true);
    });
  });

  describe('focus and mute helpers', () => {
    it('agentIdFromName maps display names and ids', () => {
      assert.equal(agentIdFromName('Claude Code'), 'claude');
      assert.equal(agentIdFromName('claude'), 'claude');
      assert.equal(agentIdFromName('OpenCode'), 'opencode');
      assert.equal(agentIdFromName('Unknown'), null);
      assert.equal(agentIdFromName(''), null);
    });

    it('normalizeMutedAgents whitelist and dedupe', () => {
      assert.deepEqual(
        normalizeMutedAgents(['cursor', 'Cursor', 'nope', 'claude', 'claude']),
        ['cursor', 'claude']
      );
      assert.deepEqual(normalizeMutedAgents(null), []);
      assert.deepEqual(normalizeMutedAgents('cursor'), []);
    });

    it('isFocusMode and isAgentMuted', () => {
      assert.equal(isFocusMode({ focusMode: true }), true);
      assert.equal(isFocusMode({ focusMode: false }), false);
      assert.equal(isFocusMode(null), false);
      assert.equal(isAgentMuted({ mutedAgents: ['grok'] }, 'Grok'), true);
      assert.equal(isAgentMuted({ mutedAgents: ['grok'] }, 'Codex'), false);
      assert.equal(isAgentMuted({}, 'Grok'), false);
    });
  });

  describe('snooze helpers', () => {
    it('normalizeSnoozePreset', () => {
      assert.equal(normalizeSnoozePreset('15m'), '15m');
      assert.equal(normalizeSnoozePreset('1h'), '1h');
      assert.equal(normalizeSnoozePreset('until-idle'), 'until-idle');
      assert.equal(normalizeSnoozePreset('2h'), null);
      assert.equal(normalizeSnoozePreset(''), null);
    });

    it('createSnoozeEntry timed and until-idle', () => {
      const now = 1_000_000;
      const t15 = createSnoozeEntry('15m', now);
      assert.equal(t15.until, now + 15 * 60 * 1000);
      assert.equal(t15.untilIdle, undefined);

      const t1h = createSnoozeEntry('1h', now);
      assert.equal(t1h.until, now + 60 * 60 * 1000);

      const idle = createSnoozeEntry('until-idle', now);
      assert.deepEqual(idle, { untilIdle: true });

      assert.equal(createSnoozeEntry('nope', now), null);
    });

    it('isSnoozeActive timed', () => {
      const entry = { until: 5000 };
      assert.equal(isSnoozeActive(entry, { now: 4000 }), true);
      assert.equal(isSnoozeActive(entry, { now: 5000 }), false);
      assert.equal(isSnoozeActive(entry, { now: 6000 }), false);
    });

    it('isSnoozeActive until-idle clears on idle/stopped', () => {
      const entry = { untilIdle: true };
      assert.equal(isSnoozeActive(entry, { status: 'working' }), true);
      assert.equal(isSnoozeActive(entry, { status: 'permission-request' }), true);
      assert.equal(isSnoozeActive(entry, { status: 'idle' }), false);
      assert.equal(isSnoozeActive(entry, { status: 'stopped' }), false);
    });

    it('isSessionSnoozed reads flags and fields', () => {
      assert.equal(isSessionSnoozed({ snoozed: true, status: 'working' }), true);
      assert.equal(
        isSessionSnoozed({ snoozed: true, snoozeUntilIdle: true, status: 'idle' }),
        false
      );
      assert.equal(
        isSessionSnoozed({ snoozeUntil: 10_000, status: 'working' }, { now: 5000 }),
        true
      );
      assert.equal(
        isSessionSnoozed({ snoozeUntil: 10_000, status: 'working' }, { now: 11_000 }),
        false
      );
    });

    it('formatSnoozeLabel', () => {
      assert.equal(formatSnoozeLabel({ snoozed: true, snoozeUntilIdle: true }), 'Snoozed · until idle');
      const now = 0;
      assert.equal(
        formatSnoozeLabel({ snoozed: true, snoozeUntil: 12 * 60 * 1000 }, now),
        'Snoozed · 12m'
      );
      assert.equal(
        formatSnoozeLabel({ snoozed: true, snoozeUntil: 30 * 1000 }, now),
        'Snoozed · <1m'
      );
      assert.equal(formatSnoozeLabel({ snoozed: false }), '');
    });
  });

  describe('helpers', () => {
    it('clampAutohideDelayMs', () => {
      assert.equal(clampAutohideDelayMs(4000), 4000);
      assert.equal(clampAutohideDelayMs(100), 1000);
      assert.equal(clampAutohideDelayMs(99999), 30000);
      assert.equal(clampAutohideDelayMs('nope'), 4000);
    });

    it('normalizeNotchAlign', () => {
      assert.equal(normalizeNotchAlign('left'), 'left');
      assert.equal(normalizeNotchAlign('right'), 'right');
      assert.equal(normalizeNotchAlign('center'), 'center');
      assert.equal(normalizeNotchAlign('top'), 'center');
    });
  });

  describe('attention queue', () => {
    it('attentionRank orders permission before question before needs-attention', () => {
      assert.ok(attentionRank('permission-request') < attentionRank('question'));
      assert.ok(attentionRank('question') < attentionRank('needs-attention'));
      assert.ok(attentionRank('needs-attention') < attentionRank('working'));
      assert.ok(attentionRank('working') < attentionRank('idle'));
    });

    it('attentionEpisodeKey is stable for needs-attention without lastTime thrash', () => {
      const a = {
        id: 's1',
        status: 'needs-attention',
        lastMessage: 'Waiting for input',
        lastTime: 100
      };
      const b = { ...a, lastTime: 999 };
      assert.equal(attentionEpisodeKey(a), attentionEpisodeKey(b));
      assert.equal(attentionEpisodeKey({ id: 'x', status: 'working' }), null);
    });

    it('attentionEpisodeKey uses permission requestId', () => {
      const s = {
        status: 'permission-request',
        permissionRequest: { requestId: 'req-1', tool: 'Bash' }
      };
      assert.equal(attentionEpisodeKey(s), 'perm:req-1|Bash|');
      assert.notEqual(
        attentionEpisodeKey(s),
        attentionEpisodeKey({
          status: 'permission-request',
          permissionRequest: { requestId: 'req-2', tool: 'Bash' }
        })
      );
    });

    it('isAttentionEpisodeAcknowledged matches keys', () => {
      const s = {
        status: 'question',
        question: { text: 'Ship it?' }
      };
      const key = attentionEpisodeKey(s);
      assert.equal(isAttentionEpisodeAcknowledged(s, key), true);
      assert.equal(isAttentionEpisodeAcknowledged(s, 'other'), false);
      assert.equal(isAttentionEpisodeAcknowledged(s, null), false);
    });

    it('compareSessionsByAttention puts unacked attention first', () => {
      const sessions = [
        { id: 'w', status: 'working', lastTime: 50 },
        { id: 'ack', status: 'needs-attention', attentionAcknowledged: true, lastTime: 90 },
        { id: 'q', status: 'question', attentionAcknowledged: false, lastTime: 10 },
        { id: 'p', status: 'permission-request', attentionAcknowledged: false, lastTime: 5 },
        { id: 'i', status: 'idle', lastTime: 100 }
      ];
      sessions.sort(compareSessionsByAttention);
      assert.deepEqual(
        sessions.map((s) => s.id),
        ['p', 'q', 'ack', 'w', 'i']
      );
    });

    it('buildAttentionQueue excludes acked and non-attention', () => {
      const list = [
        { id: 'p', status: 'permission-request' },
        { id: 'a', status: 'needs-attention', attentionAcknowledged: true },
        { id: 'w', status: 'working' },
        { id: 'q', status: 'question' }
      ];
      const q = buildAttentionQueue(list);
      assert.deepEqual(q.map((s) => s.id), ['p', 'q']);
    });

    it('annotateAttentionQueue sets 1-based index and total', () => {
      const list = [
        { id: 'p', status: 'permission-request' },
        { id: 'q', status: 'question' },
        { id: 'w', status: 'working', queueIndex: 99, queueTotal: 99 }
      ];
      const q = annotateAttentionQueue(list);
      assert.equal(q.length, 2);
      assert.equal(list[0].queueIndex, 1);
      assert.equal(list[0].queueTotal, 2);
      assert.equal(list[1].queueIndex, 2);
      assert.equal(list[1].queueTotal, 2);
      assert.equal(list[2].queueIndex, undefined);
      assert.equal(list[2].queueTotal, undefined);
    });

    it('formatAttentionStatusLine', () => {
      assert.equal(
        formatAttentionStatusLine(
          { agent: 'Claude Code', status: 'permission-request' },
          (a) => (a === 'Claude Code' ? 'Claude' : a)
        ),
        'Claude needs permission'
      );
      assert.equal(
        formatAttentionStatusLine({ agent: 'Codex', status: 'question' }),
        'Codex asks a question'
      );
      assert.equal(
        formatAttentionStatusLine({ agent: 'Grok', status: 'needs-attention' }),
        'Grok needs you'
      );
    });
  });
});
