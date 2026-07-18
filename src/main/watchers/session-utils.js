const fs = require('fs');
const { parseJSONL, formatDuration, getDurationFromFile, isFileActive } = require('./base-watcher');

/**
 * Shared helpers for agent JSONL watchers.
 */

function getText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(part => part && (part.text || part.content || part.value || ''))
    .filter(Boolean)
    .join('\n');
}

function normalizePlan(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
    step: typeof item === 'string' ? item : (item.step || item.title || item.text || ''),
    status: typeof item === 'string' ? 'pending' : (item.status || 'pending')
  })).filter(item => item.step);
}

/**
 * Build a chronological activity timeline for session cards.
 * Prefer richer per-watcher timelines when available; this is the shared fallback.
 * @param {string} lastMessage
 * @param {string[]} toolCalls
 * @param {number} at
 * @param {Array<{text?:string, at?:number, kind?:string}>} [extra]
 */
function buildActivity(lastMessage, toolCalls, at, extra = []) {
  const activity = [];

  for (const tool of (toolCalls || []).slice(-20)) {
    const text = String(tool || '').trim();
    if (!text) continue;
    activity.push({
      text,
      at,
      kind: classifyActivityTool(text),
      tool: text
    });
  }

  for (const item of extra || []) {
    if (!item) continue;
    const text = typeof item === 'string' ? item : (item.text || item.message || '');
    if (!text) continue;
    activity.push({
      text: String(text).length > 1200 ? String(text).slice(-1200) : String(text),
      at: (typeof item === 'object' && item.at) || at,
      kind: (typeof item === 'object' && item.kind) || 'message',
      filePath: typeof item === 'object' ? item.filePath : undefined,
      tool: typeof item === 'object' ? item.tool : undefined
    });
  }

  if (lastMessage) {
    const msg = String(lastMessage);
    activity.push({
      text: msg.length > 1200 ? msg.slice(-1200) : msg,
      at,
      kind: 'message'
    });
  }

  return activity.slice(-40);
}

function classifyActivityTool(label) {
  const n = String(label || '').toLowerCase();
  if (n.includes('terminal') || n.includes('bash') || n.includes('shell') || n.startsWith('run(') || n.includes('run_terminal')) {
    return 'terminal';
  }
  if (
    n.includes('edit') ||
    n.includes('write') ||
    n.includes('read') ||
    n.includes('search_replace') ||
    n.includes('str_replace') ||
    n.includes('apply_patch') ||
    /\.(js|ts|tsx|jsx|py|go|rs|css|html|md|json|yml|yaml)\b/i.test(n)
  ) {
    return 'file';
  }
  if (n.includes('grep') || n.includes('search') || n.includes('glob') || n.includes('find')) {
    return 'search';
  }
  return 'tool';
}

/**
 * Read a file from a byte offset (incremental JSONL tail).
 * @returns {{ content: string, newOffset: number, truncated: boolean, size: number } | null}
 */
function readFileDelta(filePath, lastOffset = 0) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const size = stat.size;
  // Truncated or rewritten
  if (size < lastOffset) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, newOffset: size, truncated: true, size, full: true };
  }

  if (size === lastOffset) {
    return { content: '', newOffset: lastOffset, truncated: false, size, full: false, unchanged: true };
  }

  // First read or force full
  if (lastOffset === 0) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, newOffset: size, truncated: false, size, full: true };
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const length = size - lastOffset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, lastOffset);
    return {
      content: buf.toString('utf-8'),
      newOffset: size,
      truncated: false,
      size,
      full: false
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse only complete JSONL lines from a chunk; return remainder for next read.
 */
function parseJSONLChunk(chunk, pendingLine = '') {
  const combined = pendingLine + chunk;
  const lines = combined.split('\n');
  const incomplete = combined.endsWith('\n') ? '' : (lines.pop() || '');
  const text = lines.join('\n');
  const entries = text.trim() ? parseJSONL(text) : [];
  return { entries, pendingLine: incomplete };
}

/**
 * If file hasn't grown, optionally mark a working session idle based on mtime.
 * @returns {'skip'|'idle-update'|null} null means caller should re-read
 */
function checkUnchangedSession(filePath, lastSize, hasSession, existingStatus) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return 'skip';
  }

  if (stat.size <= lastSize && hasSession) {
    const isActive = isFileActive(filePath, 60000);
    if (!isActive && existingStatus === 'working') {
      return 'idle-update';
    }
    return 'skip';
  }
  return null;
}

/**
 * Apply idle status when file is stale.
 */
function applyActiveIdle(status, filePath, thresholdMs = 60000) {
  const isActive = isFileActive(filePath, thresholdMs);
  if (!isActive && status === 'working') {
    return { status: 'idle', isActive: false, currentTool: null };
  }
  return { status, isActive, currentTool: undefined };
}

function resolveTimes(startTime, lastTime, filePath) {
  const fileTimes = getDurationFromFile(filePath);
  const start = startTime || fileTimes.startTime;
  const last = lastTime || fileTimes.lastTime;
  const duration = start && last ? last - start : 0;
  return {
    startTime: start,
    lastTime: last,
    lastActivityAt: fileTimes.lastTime,
    duration,
    durationFormatted: formatDuration(duration)
  };
}

module.exports = {
  getText,
  normalizePlan,
  buildActivity,
  classifyActivityTool,
  readFileDelta,
  parseJSONLChunk,
  checkUnchangedSession,
  applyActiveIdle,
  resolveTimes,
  parseJSONL,
  formatDuration,
  getDurationFromFile,
  isFileActive
};
