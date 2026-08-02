/**
 * Pure attention / interrupt policy.
 * Decides sound, desktop notification, and collapsed-bar reveal per event kind.
 * Session snooze, focus mode, and per-agent mute silence sound + toast only —
 * bar truth / reveal stay (status-before-chrome).
 * Does not know window focus — callers still suppress toasts when focused.
 */

'use strict';

/**
 * @typedef {'permission-request'|'question'|'needs-attention'|'done'} InterruptKind
 * @typedef {{ sound: boolean, notify: boolean, reveal: boolean }} InterruptChannels
 * @typedef {{ until?: number, untilIdle?: boolean }} SnoozeEntry
 * @typedef {'15m'|'1h'|'until-idle'} SnoozePreset
 * @typedef {'claude'|'codex'|'cursor'|'antigravity'|'grok'|'opencode'} MuteAgentId
 */

const ATTENTION_STATUSES = Object.freeze([
  'permission-request',
  'question',
  'needs-attention'
]);

/** Lower rank = higher priority in the attention queue and session list. */
const ATTENTION_PRIORITY = Object.freeze({
  'permission-request': 0,
  'question': 1,
  'needs-attention': 2,
  'working': 3,
  'idle': 4,
  'stopped': 5
});

const SNOOZE_PRESETS = Object.freeze({
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  'until-idle': null
});

/** Stable ids used in settings.mutedAgents (watcher keys). */
const MUTE_AGENT_IDS = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'grok',
  'opencode'
]);

/** Display name (session.agent) → mute id */
const AGENT_NAME_TO_ID = Object.freeze({
  'Claude Code': 'claude',
  Codex: 'codex',
  Cursor: 'cursor',
  Antigravity: 'antigravity',
  Grok: 'grok',
  OpenCode: 'opencode'
});

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
 * @param {string} [status]
 * @returns {boolean}
 */
function isAttentionStatus(status) {
  return ATTENTION_STATUSES.includes(status);
}

/**
 * Sort rank for session status (lower first). Unknown statuses sort like idle.
 * @param {string} [status]
 * @returns {number}
 */
function attentionRank(status) {
  if (status != null && Object.prototype.hasOwnProperty.call(ATTENTION_PRIORITY, status)) {
    return ATTENTION_PRIORITY[status];
  }
  return ATTENTION_PRIORITY.idle;
}

/**
 * Stable key for the current "needs human" episode on a session.
 * When the key changes (new permission, new question, new stall), a prior
 * dismiss-attention ack no longer applies and interrupts may fire again.
 * @param {object|null|undefined} session
 * @returns {string|null}
 */
function attentionEpisodeKey(session) {
  if (!session || !isAttentionStatus(session.status)) return null;
  const status = session.status;
  if (status === 'permission-request') {
    const pr = session.permissionRequest || {};
    const id = pr.requestId || pr.id || '';
    const tool = pr.tool || session.currentTool || '';
    const file = pr.filePath || '';
    return `perm:${id}|${tool}|${file}`;
  }
  if (status === 'question') {
    const q = session.question || {};
    const text = String(q.text || q.prompt || '').slice(0, 160);
    return `q:${text}`;
  }
  // needs-attention — stall / generic human need.
  // Avoid lastTime: poll updates thrash the episode key and re-fire interrupts.
  const msg = String(session.lastMessage || session.currentTool || session.taskName || '').slice(0, 120);
  return `att:${msg || session.id || 'need'}`;
}

/**
 * Whether an ack map entry still covers this session's current attention episode.
 * @param {object|null|undefined} session
 * @param {string|null|undefined} ackedKey — stored episode key
 * @returns {boolean}
 */
function isAttentionEpisodeAcknowledged(session, ackedKey) {
  if (!ackedKey || typeof ackedKey !== 'string') return false;
  const key = attentionEpisodeKey(session);
  return Boolean(key && key === ackedKey);
}

/**
 * Compare sessions for the live list + attention queue.
 * Unacked attention first (by status priority, then recency), then acked
 * attention, then working / idle / stopped.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareSessionsByAttention(a, b) {
  const aAtt = isAttentionStatus(a && a.status);
  const bAtt = isAttentionStatus(b && b.status);
  const aAck = Boolean(a && a.attentionAcknowledged);
  const bAck = Boolean(b && b.attentionAcknowledged);

  // Active (unacked) attention before everything else
  const aActive = aAtt && !aAck;
  const bActive = bAtt && !bAck;
  if (aActive !== bActive) return aActive ? -1 : 1;

  // Acked attention after active attention, before working
  const aSoft = aAtt && aAck;
  const bSoft = bAtt && bAck;
  if (aSoft !== bSoft) return aSoft ? -1 : 1;

  const ra = attentionRank(a && a.status);
  const rb = attentionRank(b && b.status);
  if (ra !== rb) return ra - rb;

  return (Number(b && b.lastTime) || 0) - (Number(a && a.lastTime) || 0);
}

/**
 * Active attention queue: human-needed sessions not dismissed for this episode.
 * Already sorted by priority when `sessions` were sorted with compareSessionsByAttention.
 * @param {Array<object>|null|undefined} sessions
 * @returns {object[]}
 */
function buildAttentionQueue(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return list.filter(
    (s) => s && isAttentionStatus(s.status) && !s.attentionAcknowledged && s.status !== 'stopped'
  );
}

/**
 * Annotate queue index/total on active attention sessions (1-based).
 * Mutates queue members in place; clears stale fields on non-queue sessions.
 * @param {Array<object>} sessions
 * @returns {object[]} the attention queue (same object refs as in sessions)
 */
function annotateAttentionQueue(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const queue = buildAttentionQueue(list);
  const total = queue.length;
  const inQueue = new Set(queue);
  for (const s of list) {
    if (!s) continue;
    if (!inQueue.has(s)) {
      if (s.queueIndex != null) delete s.queueIndex;
      if (s.queueTotal != null) delete s.queueTotal;
    }
  }
  for (let i = 0; i < total; i++) {
    queue[i].queueIndex = i + 1;
    queue[i].queueTotal = total;
  }
  return queue;
}

/**
 * Short status phrase for the collapsed strip (single session).
 * @param {object|null|undefined} session
 * @param {(agent: string) => string} [shortName]
 * @returns {string}
 */
function formatAttentionStatusLine(session, shortName) {
  if (!session) return '';
  const nameFn = typeof shortName === 'function' ? shortName : (a) => String(a || 'Agent');
  const agent = nameFn(session.agent);
  if (session.status === 'permission-request') return `${agent} needs permission`;
  if (session.status === 'question') return `${agent} asks a question`;
  return `${agent} needs you`;
}

/**
 * @param {unknown} preset
 * @returns {SnoozePreset|null}
 */
function normalizeSnoozePreset(preset) {
  if (preset === '15m' || preset === '1h' || preset === 'until-idle') return preset;
  return null;
}

/**
 * Build a snooze entry from a preset.
 * @param {unknown} preset
 * @param {number} [now]
 * @returns {SnoozeEntry|null}
 */
function createSnoozeEntry(preset, now = Date.now()) {
  const p = normalizeSnoozePreset(preset);
  if (!p) return null;
  if (p === 'until-idle') return { untilIdle: true };
  const ms = SNOOZE_PRESETS[p];
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { until: now + ms };
}

/**
 * Whether a snooze entry is still active for this session status.
 * until-idle clears when the session is idle/stopped.
 * Timed snoozes clear after `until`.
 * @param {SnoozeEntry|null|undefined} entry
 * @param {{ now?: number, status?: string }} [opts]
 * @returns {boolean}
 */
function isSnoozeActive(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return false;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const status = opts.status;

  if (entry.untilIdle) {
    if (status === 'idle' || status === 'stopped') return false;
    return true;
  }

  if (typeof entry.until === 'number' && Number.isFinite(entry.until)) {
    return now < entry.until;
  }

  return false;
}

/**
 * Session may carry `snoozed` boolean or raw snooze fields.
 * @param {object|null|undefined} session
 * @param {{ now?: number }} [opts]
 * @returns {boolean}
 */
function isSessionSnoozed(session, opts = {}) {
  if (!session) return false;
  if (session.snoozed === true) {
    // Explicit flag from AgentManager — still honor until-idle vs idle status
    if (session.snoozeUntilIdle && (session.status === 'idle' || session.status === 'stopped')) {
      return false;
    }
    if (typeof session.snoozeUntil === 'number' && Number.isFinite(opts.now)) {
      return opts.now < session.snoozeUntil;
    }
    return true;
  }
  if (session.snoozeUntilIdle || typeof session.snoozeUntil === 'number') {
    return isSnoozeActive(
      {
        untilIdle: Boolean(session.snoozeUntilIdle),
        until: session.snoozeUntil
      },
      { now: opts.now, status: session.status }
    );
  }
  return false;
}

/**
 * Short label for the snooze chip.
 * @param {object|null|undefined} session
 * @param {number} [now]
 * @returns {string}
 */
function formatSnoozeLabel(session, now = Date.now()) {
  if (!session || !isSessionSnoozed(session, { now })) return '';
  if (session.snoozeUntilIdle) return 'Snoozed · until idle';
  const until = session.snoozeUntil;
  if (typeof until !== 'number' || !Number.isFinite(until)) return 'Snoozed';
  const ms = until - now;
  if (ms <= 0) return 'Snoozed';
  if (ms < 60 * 1000) return 'Snoozed · <1m';
  const mins = Math.ceil(ms / (60 * 1000));
  if (mins < 60) return `Snoozed · ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `Snoozed · ${hours}h ${rem}m` : `Snoozed · ${hours}h`;
}

/**
 * Map session.agent display name or raw id → mute id.
 * @param {unknown} nameOrId
 * @returns {MuteAgentId|null}
 */
function agentIdFromName(nameOrId) {
  if (typeof nameOrId !== 'string' || !nameOrId) return null;
  if (MUTE_AGENT_IDS.includes(/** @type {MuteAgentId} */ (nameOrId))) {
    return /** @type {MuteAgentId} */ (nameOrId);
  }
  return AGENT_NAME_TO_ID[nameOrId] || null;
}

/**
 * Whitelist and dedupe mutedAgents from settings or UI.
 * @param {unknown} value
 * @returns {MuteAgentId[]}
 */
function normalizeMutedAgents(value) {
  if (!Array.isArray(value)) return [];
  /** @type {Set<MuteAgentId>} */
  const ids = new Set();
  for (const item of value) {
    const id = agentIdFromName(item);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * @param {object|null|undefined} settings
 * @returns {boolean}
 */
function isFocusMode(settings) {
  return Boolean(settings && settings.focusMode);
}

/**
 * @param {object|null|undefined} settings
 * @param {unknown} agent — session.agent display name or mute id
 * @returns {boolean}
 */
function isAgentMuted(settings, agent) {
  const id = agentIdFromName(agent);
  if (!id) return false;
  const list = settings && Array.isArray(settings.mutedAgents)
    ? settings.mutedAgents
    : [];
  return list.includes(id);
}

/**
 * @param {object} settings
 * @param {{ kind: InterruptKind, snoozed?: boolean, agent?: string }} opts
 * @returns {InterruptChannels}
 */
function channelsForEvent(settings, opts) {
  const kind = opts && opts.kind;
  const s = settings || {};
  const snoozed = Boolean(opts && opts.snoozed);
  const agent = opts && opts.agent;

  const masters = {
    sound: s.soundAlerts !== false,
    notify: s.desktopNotifications !== false
  };

  const revealAttention = s.revealOnAttention !== false;
  const revealDone = s.revealOnDone !== false;

  /** @type {InterruptChannels} */
  const off = { sound: false, notify: false, reveal: false };

  /** @type {InterruptChannels} */
  let ch;
  switch (kind) {
    case 'permission-request':
      ch = {
        sound: masters.sound && s.soundOnPermission !== false,
        notify: masters.notify && s.notifyOnPermission !== false,
        reveal: revealAttention
      };
      break;
    case 'question':
      ch = {
        sound: masters.sound && s.soundOnQuestion !== false,
        notify: masters.notify && s.notifyOnQuestion !== false,
        reveal: revealAttention
      };
      break;
    case 'needs-attention':
      ch = {
        sound: masters.sound && s.soundOnNeedsAttention !== false,
        notify: masters.notify && s.notifyOnNeedsAttention !== false,
        reveal: revealAttention
      };
      break;
    case 'done':
      ch = {
        sound: masters.sound && s.soundOnDone === true,
        notify: masters.notify && s.notifyOnDone !== false,
        reveal: revealDone
      };
      break;
    default:
      return off;
  }

  // Channel mutes only — reveal and bar truth stay (status-before-chrome).
  // Session snooze, focus mode, and per-agent mute all silence sound + toast.
  if (snoozed || isFocusMode(s) || isAgentMuted(s, agent)) {
    ch = { sound: false, notify: false, reveal: ch.reveal };
  }

  return ch;
}

/**
 * Combine channel flags for one or more sessions (OR — if any wants sound, play once).
 * Per-session snooze and per-agent mute are applied when session fields are set.
 * Focus mode is global via settings.
 * @param {object} settings
 * @param {Array<{ status?: string, agent?: string, snoozed?: boolean, snoozeUntil?: number, snoozeUntilIdle?: boolean }>} sessions
 * @param {InterruptKind} [forceKind] — use for done events (status is already idle)
 * @param {{ now?: number }} [opts]
 * @returns {InterruptChannels}
 */
function channelsForSessions(settings, sessions, forceKind, opts = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  /** @type {InterruptChannels} */
  const acc = { sound: false, notify: false, reveal: false };

  if (forceKind) {
    // Done / forced kind: OR across sessions with per-session snooze / agent mute
    if (list.length === 0) {
      return channelsForEvent(settings, { kind: forceKind, snoozed: false });
    }
    for (const session of list) {
      const snoozed = isSessionSnoozed(session, { now });
      const ch = channelsForEvent(settings, {
        kind: forceKind,
        snoozed,
        agent: session && session.agent
      });
      acc.sound = acc.sound || ch.sound;
      acc.notify = acc.notify || ch.notify;
      acc.reveal = acc.reveal || ch.reveal;
    }
    return acc;
  }

  if (list.length === 0) return acc;

  for (const session of list) {
    const kind = kindFromStatus(session && session.status);
    if (!kind) continue;
    const snoozed = isSessionSnoozed(session, { now });
    const ch = channelsForEvent(settings, {
      kind,
      snoozed,
      agent: session && session.agent
    });
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
  ATTENTION_STATUSES,
  ATTENTION_PRIORITY,
  SNOOZE_PRESETS,
  MUTE_AGENT_IDS,
  AGENT_NAME_TO_ID,
  kindFromStatus,
  isAttentionStatus,
  attentionRank,
  attentionEpisodeKey,
  isAttentionEpisodeAcknowledged,
  compareSessionsByAttention,
  buildAttentionQueue,
  annotateAttentionQueue,
  formatAttentionStatusLine,
  normalizeSnoozePreset,
  createSnoozeEntry,
  isSnoozeActive,
  isSessionSnoozed,
  formatSnoozeLabel,
  agentIdFromName,
  normalizeMutedAgents,
  isFocusMode,
  isAgentMuted,
  channelsForEvent,
  channelsForSessions,
  clampAutohideDelayMs,
  normalizeNotchAlign
};
