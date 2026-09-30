const EventEmitter = require('events');
const fs = require('fs');
const { cleanPrompt } = require('../lib/prompt-clean');

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
    this._jsonlStates = new Map();
    this._timer = null;
    this._running = false;
    this._fsWatcher = null;
    this._useEvents = false;
    this._pollSoonTimer = null;
    this.healthPaths = [];
    this.health = { state: 'disabled', checkedAt: null, lastSuccessAt: null, lastEventAt: null, error: '' };
    this._polling = null;
    this._generation = 0;
    this._watchError = '';
  }

  start() {
    if (this._running || !this.enabled) return;
    this._running = true;
    this._generation++;
    try { this._start(); } catch (err) { this._watchError = err.message; }
    this._runPoll();
    this._schedulePoll();
  }

  stop() {
    this._running = false;
    this._generation++;
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
    this._jsonlStates.clear();
    this.health = { ...this.health, state: 'disabled' };
    this.emit('health-update');
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
      this._fsWatcher.on('error', (err) => {
        this._watchError = err.message;
        this._closeFsWatcher();
        this._requestPollSoon();
      });
      this._useEvents = true;
      this._watchError = '';
      console.log(`[${this.name}] File watcher active on ${list.length} path(s)`);
    } catch (err) {
      this._useEvents = false;
      this._watchError = err.message;
      console.warn(`[${this.name}] chokidar unavailable, polling only:`, err.message);
    }
  }

  _closeFsWatcher() {
    if (this._fsWatcher) {
      try {
        Promise.resolve(this._fsWatcher.close()).catch(() => {});
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
      await this._runPoll();
    }, 150);
  }

  _schedulePoll() {
    if (!this._running) return;
    const generation = this._generation;
    const delay = this._useEvents
      ? Math.max(this.safetyPollInterval, this.pollInterval)
      : this.pollInterval;

    this._timer = setTimeout(async () => {
      await this._runPoll();
      if (generation === this._generation) this._schedulePoll();
    }, delay);
  }

  getSessions() {
    return Array.from(this.sessions.values());
  }

  // A setup check uses the same read path as normal monitoring. It never writes
  // a fake agent event or treats a quiet session as a broken connection.
  async checkHealth() {
    if (!this._running) return this.health;
    if (this._polling) await this._polling;
    if (!this._running) return this.health;
    if (!this._useEvents) {
      try { this._start(); } catch (err) { this._watchError = err.message; }
    }
    await this._runPoll();
    return this.health;
  }

  reportReadError(err) {
    this._readError = err?.message || String(err || 'Source could not be read');
  }

  async _runPoll() {
    if (!this._running) return;
    if (this._polling) return this._polling;
    const generation = this._generation;
    this._activePollGeneration = generation;
    this._polling = (async () => {
      let state = 'watching';
      let error = '';
      const sources = [];
      this._readError = '';
      try {
        for (const sourcePath of this.healthPaths) {
          try {
            const stat = await fs.promises.stat(sourcePath);
            if (stat.isDirectory()) await fs.promises.readdir(sourcePath);
            else {
              const file = await fs.promises.open(sourcePath, 'r');
              try { await file.read(Buffer.alloc(16), 0, 16, 0); } finally { await file.close(); }
            }
            sources.push({ path: sourcePath, readable: true });
          } catch (err) {
            sources.push({ path: sourcePath, readable: false, missing: err.code === 'ENOENT', error: err.code || 'Read failed' });
          }
        }
        if (this.healthPaths.length && !sources.some(s => s.readable)) {
          state = sources.every(s => s.missing) ? 'missing' : 'error';
          error = state === 'missing' ? 'No session data found. Start a session or check the data path below.' : 'Session data cannot be read. Check the path and folder permissions.';
        } else {
          await this._poll();
          if (this._readError) throw new Error(this._readError);
          if (!this._useEvents) state = 'polling';
        }
      } catch (err) {
        state = 'error';
        error = err.message;
      }
      if (!this._running || this._generation !== generation) return;
      const now = Date.now();
      this.health = { ...this.health, state, checkedAt: now, sources, error,
        watchError: this._watchError,
        lastSuccessAt: state === 'watching' || state === 'polling' ? now : this.health.lastSuccessAt };
      this.emit('health-update');
    })();
    try { await this._polling; } finally { this._polling = null; }
  }

  /** Replay existing records once, then feed appended records to a stateful analyzer. */
  _readJsonlSession(id, filePath, analyze) {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const stat = fs.fstatSync(fd);
      let cached = this._jsonlStates.get(id);
      const replaced = cached && (cached.filePath !== filePath || cached.ino !== stat.ino ||
        cached.dev !== stat.dev || cached.birthtimeMs !== stat.birthtimeMs);
      const rewritten = cached && (stat.size < cached.offset ||
        (stat.size === cached.size && stat.mtimeMs !== cached.mtimeMs));
      if (!cached || replaced || rewritten) {
        cached = { filePath, ino: stat.ino, dev: stat.dev, birthtimeMs: stat.birthtimeMs,
          offset: 0, pending: Buffer.alloc(0), state: {} };
      } else if (stat.size === cached.offset && stat.mtimeMs === cached.mtimeMs) {
        return null;
      }

      const fileTimes = {
        startTime: stat.birthtimeMs > 0 && stat.birthtimeMs < stat.mtimeMs ? stat.birthtimeMs : stat.mtimeMs,
        lastTime: stat.mtimeMs
      };
      const buffer = Buffer.alloc(256 * 1024);
      let result = null;
      while (cached.offset < stat.size) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - cached.offset), cached.offset);
        if (!count) break;
        cached.offset += count;
        const bytes = Buffer.concat([cached.pending, buffer.subarray(0, count)]);
        const end = bytes.lastIndexOf(10);
        if (end < 0) {
          cached.pending = bytes;
          continue;
        }
        // Decode only complete lines, so a split UTF-8 character survives writes.
        const entries = parseJSONL(bytes.subarray(0, end).toString('utf8'));
        cached.pending = Buffer.from(bytes.subarray(end + 1));
        if (entries.length) result = analyze(entries, cached.state, fileTimes);
      }

      // A valid last record need not end in a newline. Preview it on a copy:
      // the next write may finish that same line, which must be counted once.
      if (cached.pending.length) {
        const entries = parseJSONL(cached.pending.toString('utf8'));
        if (entries.length) result = analyze(entries, structuredClone(cached.state), fileTimes);
      }
      cached.size = stat.size;
      cached.mtimeMs = stat.mtimeMs;
      this._jsonlStates.set(id, cached);
      return result;
    } catch (err) {
      // A partial replay must never become the next append's starting state.
      this._jsonlStates.delete(id);
      throw err;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  _updateSession(id, data) {
    if (this._activePollGeneration != null && this._activePollGeneration !== this._generation) return;
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
    if (id !== 'cursor-main') {
      this.health.lastEventAt = Math.max(this.health.lastEventAt || 0, Number(session.lastActivityAt) || 0);
    }
    this.emit('session-update', session);
    return session;
  }

  _removeSession(id) {
    if (this._activePollGeneration != null && this._activePollGeneration !== this._generation) return;
    this._jsonlStates.delete(id);
    if (this.sessions.has(id)) {
      const session = this.sessions.get(id);
      session.status = 'stopped';
      this.emit('session-update', session);
      this.sessions.delete(id);
      this._onSessionRemoved(id);
    }
  }

  // Subclasses must implement these
  _start() {}
  _stop() {}
  async _poll() {}
  /** Called after a session is removed. Override to clean up per-session state. */
  _onSessionRemoved(_id) {}
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
  let clean = cleanPrompt(text);
  if (!clean) return 'Untitled session';
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
