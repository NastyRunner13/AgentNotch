const EventEmitter = require('events');
const fs = require('fs');

/**
 * Base class for all agent watchers.
 * Subclasses implement _start(), _stop(), and _poll().
 * Optional: call this.watchDirs(paths) from _start for chokidar + safety poll.
 */
class BaseWatcher extends EventEmitter {
  constructor(name, options = {}) {
    super();
    this.name = name;
    this.enabled = options.enabled !== false;
    this.pollInterval = options.pollInterval || 3000;
    /** Safety poll when file events are active (ms) */
    this.safetyPollInterval = options.safetyPollInterval || 12000;
    this.sessions = new Map();
    this._timer = null;
    this._running = false;
    this._fsWatcher = null;
    this._useEvents = false;
    this._pollSoonTimer = null;
  }

  start() {
    if (this._running || !this.enabled) return;
    this._running = true;
    this._start();
    this._schedulePoll();
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._pollSoonTimer) {
      clearTimeout(this._pollSoonTimer);
      this._pollSoonTimer = null;
    }
    this._closeFsWatcher();
    this._stop();
  }

  /**
   * Update poll interval. Takes effect on the next scheduled tick.
   * @param {number} ms
   */
  setPollInterval(ms) {
    const next = Number(ms);
    if (!Number.isFinite(next) || next < 500) return;
    this.pollInterval = next;
  }

  /**
   * Watch directories/files with chokidar; fall back silently if unavailable.
   * Safety poll continues at safetyPollInterval.
   * @param {string|string[]} paths
   */
  watchDirs(paths) {
    this._closeFsWatcher();
    const list = (Array.isArray(paths) ? paths : [paths]).filter(p => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (list.length === 0) {
      this._useEvents = false;
      return;
    }

    try {
      const chokidar = require('chokidar');
      this._fsWatcher = chokidar.watch(list, {
        ignoreInitial: true,
        ignorePermissionErrors: true,
        awaitWriteFinish: {
          stabilityThreshold: 250,
          pollInterval: 100
        },
        depth: 6
      });
      const kick = () => this._requestPollSoon();
      this._fsWatcher.on('add', kick);
      this._fsWatcher.on('change', kick);
      this._fsWatcher.on('unlink', kick);
      this._useEvents = true;
      console.log(`[${this.name}] File watcher active on ${list.length} path(s)`);
    } catch (err) {
      this._useEvents = false;
      console.warn(`[${this.name}] chokidar unavailable, polling only:`, err.message);
    }
  }

  _closeFsWatcher() {
    if (this._fsWatcher) {
      try {
        this._fsWatcher.close();
      } catch {
        // ignore
      }
      this._fsWatcher = null;
    }
    this._useEvents = false;
  }

  _requestPollSoon() {
    if (!this._running) return;
    if (this._pollSoonTimer) return;
    this._pollSoonTimer = setTimeout(async () => {
      this._pollSoonTimer = null;
      if (!this._running) return;
      try {
        await this._poll();
      } catch (err) {
        console.error(`[${this.name}] Poll error:`, err.message);
      }
    }, 150);
  }

  _schedulePoll() {
    if (!this._running) return;
    const delay = this._useEvents
      ? Math.max(this.safetyPollInterval, this.pollInterval)
      : this.pollInterval;

    this._timer = setTimeout(async () => {
      try {
        await this._poll();
      } catch (err) {
        console.error(`[${this.name}] Poll error:`, err.message);
      }
      this._schedulePoll();
    }, delay);
  }

  getSessions() {
    return Array.from(this.sessions.values());
  }

  _updateSession(id, data) {
    const existing = this.sessions.get(id);
    const session = {
      ...existing,
      ...data,
      id,
      agent: this.name,
      lastActivityAt: data.lastActivityAt || data.lastTime || (existing && existing.lastActivityAt) || Date.now(),
      updatedAt: Date.now()
    };
    this.sessions.set(id, session);
    this.emit('session-update', session);
    return session;
  }

  _removeSession(id) {
    if (this.sessions.has(id)) {
      const session = this.sessions.get(id);
      session.status = 'stopped';
      this.emit('session-update', session);
      this.sessions.delete(id);
    }
  }

  // Subclasses must implement these
  _start() {}
  _stop() {}
  async _poll() {}
}

/**
 * Parses a JSONL file line by line.
 * Returns an array of parsed JSON objects.
 */
function parseJSONL(content) {
  const lines = content.split('\n').filter(l => l.trim());
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Extracts a human-readable task name from a prompt/message.
 */
function extractTaskName(text, maxLen = 40) {
  if (!text) return 'Untitled session';
  // Strip XML-like tags (e.g., <USER_REQUEST>)
  let clean = text.replace(/<[^>]+>/g, '').trim();
  // Take first line, trim, truncate
  let name = clean.split('\n')[0].trim();
  if (name.length > maxLen) {
    name = name.substring(0, maxLen - 1) + '…';
  }
  return name || 'Untitled session';
}

/**
 * Formats a duration in ms to a human string like "3m", "1h 23m", "2h"
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  if (ms < 60000) {
    const secs = Math.floor(ms / 1000);
    return `${secs}s`;
  }
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (remMins === 0) return `${hours}h`;
  return `${hours}h ${remMins}m`;
}

/**
 * Calculate duration from file modification time and creation time.
 * Useful when transcript entries don't have reliable timestamps.
 */
function getDurationFromFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const created = stat.birthtime.getTime();
    const modified = stat.mtime.getTime();
    if (created > 0 && modified > created) {
      return { startTime: created, lastTime: modified, duration: modified - created };
    }
    return { startTime: modified, lastTime: modified, duration: 0 };
  } catch {
    return { startTime: Date.now(), lastTime: Date.now(), duration: 0 };
  }
}

/**
 * Determine if a session is "active" (still being written to)
 * based on file modification time.
 * Active = modified within the last `thresholdMs`.
 */
function isFileActive(filePath, thresholdMs = 60000) {
  try {
    const stat = fs.statSync(filePath);
    return (Date.now() - stat.mtime.getTime()) < thresholdMs;
  } catch {
    return false;
  }
}

/**
 * Read JSONL content efficiently. Full read under maxFullBytes;
 * otherwise read a tail window (first line may be partial — skipped by parseJSONL).
 */
function readJsonlEfficient(filePath, maxFullBytes = 1_500_000, tailBytes = 800_000) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  if (stat.size <= maxFullBytes) {
    return {
      content: fs.readFileSync(filePath, 'utf-8'),
      size: stat.size,
      full: true
    };
  }

  const start = Math.max(0, stat.size - tailBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf-8');
    // Drop possibly partial first line when tailing
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return { content: text, size: stat.size, full: false };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  BaseWatcher,
  parseJSONL,
  extractTaskName,
  formatDuration,
  getDurationFromFile,
  isFileActive,
  readJsonlEfficient
};
