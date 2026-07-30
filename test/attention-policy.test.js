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
  formatSnoozeLabel
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
});
