/**
 * Pure attention / interrupt policy.
 * Decides sound, desktop notification, and collapsed-bar reveal per event kind.
 * Does not know window focus — callers still suppress toasts when focused.
 */

'use strict';

/**
 * @typedef {'permission-request'|'question'|'needs-attention'|'done'} InterruptKind
 * @typedef {{ sound: boolean, notify: boolean, reveal: boolean }} InterruptChannels
 */

/**
 * Normalize session status or event label to a policy kind.
 * @param {string} statusOrKind
 * @returns {InterruptKind|null}
 */
function kindFromStatus(statusOrKind) {
  if (!statusOrKind) return null;
  if (statusOrKind === 'done') return 'done';
  if (statusOrKind === 'permission-request') return 'permission-request';
  if (statusOrKind === 'question') return 'question';
  if (statusOrKind === 'needs-attention') return 'needs-attention';
  return null;
}

/**
 * @param {object} settings
 * @param {{ kind: InterruptKind }} opts
 * @returns {InterruptChannels}
 */
function channelsForEvent(settings, opts) {
  const kind = opts && opts.kind;
  const s = settings || {};

  const masters = {
    sound: s.soundAlerts !== false,
    notify: s.desktopNotifications !== false
  };

  const revealAttention = s.revealOnAttention !== false;
  const revealDone = s.revealOnDone !== false;

  /** @type {InterruptChannels} */
  const off = { sound: false, notify: false, reveal: false };

  switch (kind) {
    case 'permission-request':
      return {
        sound: masters.sound && s.soundOnPermission !== false,
        notify: masters.notify && s.notifyOnPermission !== false,
        reveal: revealAttention
      };
    case 'question':
      return {
        sound: masters.sound && s.soundOnQuestion !== false,
        notify: masters.notify && s.notifyOnQuestion !== false,
        reveal: revealAttention
      };
    case 'needs-attention':
      return {
        sound: masters.sound && s.soundOnNeedsAttention !== false,
        notify: masters.notify && s.notifyOnNeedsAttention !== false,
        reveal: revealAttention
      };
    case 'done':
      return {
        sound: masters.sound && s.soundOnDone === true,
        notify: masters.notify && s.notifyOnDone !== false,
        reveal: revealDone
      };
    default:
      return off;
  }
}

/**
 * Combine channel flags for one or more sessions (OR — if any wants sound, play once).
 * @param {object} settings
 * @param {Array<{ status?: string }>} sessions
 * @param {InterruptKind} [forceKind] — use for done events (status is already idle)
 * @returns {InterruptChannels}
 */
function channelsForSessions(settings, sessions, forceKind) {
  const list = Array.isArray(sessions) ? sessions : [];
  /** @type {InterruptChannels} */
  const acc = { sound: false, notify: false, reveal: false };

  if (forceKind) {
    const ch = channelsForEvent(settings, { kind: forceKind });
    return {
      sound: ch.sound,
      notify: ch.notify,
      reveal: ch.reveal
    };
  }

  if (list.length === 0) return acc;

  for (const session of list) {
    const kind = kindFromStatus(session && session.status);
    if (!kind) continue;
    const ch = channelsForEvent(settings, { kind });
    acc.sound = acc.sound || ch.sound;
    acc.notify = acc.notify || ch.notify;
    acc.reveal = acc.reveal || ch.reveal;
  }
  return acc;
}

/**
 * Clamp autohide delay to a safe range.
 * @param {unknown} ms
 * @returns {number}
 */
function clampAutohideDelayMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 4000;
  return Math.min(30000, Math.max(1000, Math.round(n)));
}

/**
 * Allowed notch alignments.
 * @param {unknown} align
 * @returns {'left'|'center'|'right'}
 */
function normalizeNotchAlign(align) {
  if (align === 'left' || align === 'right' || align === 'center') return align;
  return 'center';
}

module.exports = {
  kindFromStatus,
  channelsForEvent,
  channelsForSessions,
  clampAutohideDelayMs,
  normalizeNotchAlign
};
