/**
 * Pure history helpers — filter, pin partition, archive snapshot, trim, resume target.
 * No Electron / FS side effects.
 */

'use strict';

const DEFAULT_CONTINUE_PROMPT = 'Continue from where we left off.';

const DISPATCHABLE_AGENTS = new Set([
  'Claude Code',
  'Codex',
  'Grok',
  'OpenCode'
]);

/**
 * @param {unknown} entries
 * @param {string} [query]
 * @returns {object[]}
 */
function filterHistoryEntries(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list.slice();

  return list.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
    const base = cwd.split(/[/\\]/).filter(Boolean).pop() || '';
    const hay = [
      entry.taskName,
      entry.agent,
      entry.userPrompt,
      entry.lastMessage,
      cwd,
      base
    ]
      .map((v) => String(v || '').toLowerCase())
      .join('\n');
    return hay.includes(q);
  });
}

/**
 * Split into pinned (newest pin first) and unpinned (caller keeps archive order).
 * @param {unknown} entries
 * @returns {{ pinned: object[], unpinned: object[] }}
 */
function partitionPinnedHistory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const pinned = [];
  const unpinned = [];
  for (const entry of list) {
    if (entry && entry.pinned) pinned.push(entry);
    else if (entry) unpinned.push(entry);
  }
  pinned.sort((a, b) => (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0));
  return { pinned, unpinned };
}

/**
 * Cap history while never dropping pinned entries.
 * @param {object[]} entries — chronological or any order
 * @param {number} [maxUnpinned=200]
 * @returns {object[]}
 */
function trimHistoryEntries(entries, maxUnpinned = 200) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const max = Number.isFinite(maxUnpinned) && maxUnpinned > 0 ? maxUnpinned : 200;
  const { pinned, unpinned } = partitionPinnedHistory(list);
  // Keep most recent unpinned by archivedAt / lastTime
  unpinned.sort((a, b) => {
    const ta = Number(a.archivedAt || a.lastTime) || 0;
    const tb = Number(b.archivedAt || b.lastTime) || 0;
    return ta - tb;
  });
  const keptUnpinned = unpinned.length > max ? unpinned.slice(unpinned.length - max) : unpinned;
  // Stable store order: unpinned chrono then pinned (pins not dropped)
  return [...keptUnpinned, ...pinned];
}

/**
 * Build archive snapshot from a live session; preserve pin flags from previous entry.
 * @param {object} session
 * @param {object|null} [previous]
 * @param {number} [now]
 * @returns {object}
 */
function buildArchiveSnapshot(session, previous = null, now = Date.now()) {
  const s = session || {};
  const prev = previous && typeof previous === 'object' ? previous : null;
  const snapshot = {
    id: s.id,
    agent: s.agent,
    taskName: s.taskName,
    userPrompt: s.userPrompt,
    status: s.status,
    duration: s.duration,
    durationFormatted: s.durationFormatted,
    startTime: s.startTime,
    lastTime: s.lastTime,
    lastActivityAt: s.lastActivityAt,
    toolCalls: s.toolCalls || [],
    lastMessage: s.lastMessage,
    activity: s.activity || [],
    plan: s.plan || [],
    cwd: s.cwd || null,
    resumeId: s.resumeId || (prev && prev.resumeId) || null,
    model: s.model || (prev && prev.model) || null,
    archivedAt: now,
    pinned: false,
    pinnedAt: null
  };

  if (prev) {
    if (prev.pinned) {
      snapshot.pinned = true;
      snapshot.pinnedAt = prev.pinnedAt || now;
    }
    if (prev.dismissedMarker !== undefined) {
      snapshot.dismissedMarker = prev.dismissedMarker;
    }
  }

  return snapshot;
}

/**
 * Apply pin flag to an entry (pure).
 * @param {object} entry
 * @param {boolean} pinned
 * @param {number} [now]
 * @returns {object}
 */
function applyHistoryPin(entry, pinned, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return entry;
  const next = { ...entry };
  if (pinned) {
    next.pinned = true;
    next.pinnedAt = now;
  } else {
    next.pinned = false;
    next.pinnedAt = null;
  }
  return next;
}

/**
 * Decide how to continue a history entry.
 * @param {object} entry
 * @param {{
 *   liveIds?: Set<string>,
 *   isDirectory?: (p: string) => boolean,
 *   canResume?: boolean
 * }} [opts]
 * @returns {{ mode: 'live'|'resume'|'new'|'focus', agent?: string, sessionId?: string, cwd?: string|null, resumeId?: string|null, message?: string }}
 */
function buildHistoryResumeTarget(entry, opts = {}) {
  if (!entry || typeof entry.id !== 'string') {
    return { mode: 'focus', message: 'History entry not found' };
  }

  const liveIds = opts.liveIds instanceof Set ? opts.liveIds : new Set();
  const isDir = typeof opts.isDirectory === 'function'
    ? opts.isDirectory
    : () => false;

  if (liveIds.has(entry.id)) {
    return { mode: 'live', sessionId: entry.id, agent: entry.agent };
  }

  const agent = entry.agent;
  const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : '';
  const dispatchable = DISPATCHABLE_AGENTS.has(agent);
  const dirOk = Boolean(cwd && isDir(cwd));

  if (!dispatchable) {
    return {
      mode: 'focus',
      agent,
      message: `Open ${agent || 'agent'} to continue`
    };
  }

  if (!dirOk) {
    return {
      mode: 'focus',
      agent,
      message: 'Session directory unknown — open the agent to continue'
    };
  }

  // Prefer resume of the archived session when the command builder can form it.
  // Caller may pass canResume=false after buildResumeCommand returns null.
  if (opts.canResume !== false) {
    return {
      mode: 'resume',
      sessionId: entry.id,
      agent,
      cwd,
      resumeId: entry.resumeId || null
    };
  }

  return { mode: 'new', agent, cwd };
}

/**
 * Refine after buildResumeCommand is known (canResume false → new or focus).
 * @param {object} entry
 * @param {{ liveIds?: Set<string>, isDirectory?: (p: string) => boolean, canResume?: boolean }} opts
 */
function resolveHistoryResumeTarget(entry, opts = {}) {
  return buildHistoryResumeTarget(entry, opts);
}

function isDispatchableHistoryAgent(agent) {
  return DISPATCHABLE_AGENTS.has(agent);
}

function projectFolderName(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

module.exports = {
  DEFAULT_CONTINUE_PROMPT,
  DISPATCHABLE_AGENTS,
  filterHistoryEntries,
  partitionPinnedHistory,
  trimHistoryEntries,
  buildArchiveSnapshot,
  applyHistoryPin,
  buildHistoryResumeTarget,
  resolveHistoryResumeTarget,
  isDispatchableHistoryAgent,
  projectFolderName
};
