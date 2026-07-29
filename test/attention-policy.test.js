const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  kindFromStatus,
  channelsForEvent,
  channelsForSessions,
  clampAutohideDelayMs,
  normalizeNotchAlign
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
