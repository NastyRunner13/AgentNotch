const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BaseWatcher, formatDuration } = require('../base-watcher');
const { sqlite, resolveCursorPaths } = require('./paths');
const { scanComposers } = require('./scan-composers');
const { scanTranscripts } = require('./scan-transcripts');

const execFileAsync = promisify(execFile);

/**
 * Watches Cursor IDE process + local composer state (SQLite) + agent transcripts.
 *
 * Cursor does not expose remote Allow/Deny; this deepens the *signal* so the
 * notch can show real agent sessions (working / done / project) instead of
 * a single "Cursor is open" placeholder.
 */
class CursorWatcher extends BaseWatcher {
  constructor(options = {}) {
    super('Cursor', { pollInterval: 4000, safetyPollInterval: 12000, ...options });
    const paths = options.paths || resolveCursorPaths();
    this.globalDb = options.globalDb || paths.globalDb;
    this.workspaceRoot = options.workspaceRoot || paths.workspaceRoot;
    this.projectsRoot = options.projectsRoot || paths.projectsRoot;
    this._startedAt = null;
    this._checking = false;
    this._globalToken = '';
    this._workspaceToken = '';
    /** @type {Map<string, string>} composerId → cwd */
    this._composerCwd = new Map();
    /** @type {Map<string, { size: number, mtime: number }>} */
    this._transcriptMeta = new Map();
  }

  _start() {
    console.log('[Cursor] Process + composer monitoring started');
    const watch = [];
    if (fs.existsSync(path.dirname(this.globalDb))) watch.push(path.dirname(this.globalDb));
    if (fs.existsSync(this.workspaceRoot)) watch.push(this.workspaceRoot);
    if (fs.existsSync(this.projectsRoot)) watch.push(this.projectsRoot);
    if (watch.length) this.watchDirs(watch);
  }

  _stop() {
    this._startedAt = null;
    this._globalToken = '';
    this._workspaceToken = '';
    this._composerCwd.clear();
    this._transcriptMeta.clear();
  }

  async _poll() {
    if (this._checking) return;
    this._checking = true;

    try {
      const isRunning = await this._checkProcess();
      const now = Date.now();
      const activeIds = new Set();

      if (isRunning && !this._startedAt) this._startedAt = now;
      if (!isRunning) this._startedAt = null;

      // Composer + transcript sessions when SQLite (or files) available
      const composerSessions = sqlite
        ? scanComposers(this, now, isRunning)
        : [];
      const transcriptSessions = scanTranscripts(this, now, isRunning, composerSessions);

      for (const s of composerSessions) {
        activeIds.add(s.id);
        this._updateSession(s.id, s);
      }
      for (const s of transcriptSessions) {
        if (activeIds.has(s.id)) continue; // composer session wins
        activeIds.add(s.id);
        this._updateSession(s.id, s);
      }

      // Fallback: IDE open, no rich sessions → presence-only card
      if (isRunning && activeIds.size === 0) {
        const sessionId = 'cursor-main';
        activeIds.add(sessionId);
        const duration = this._startedAt ? now - this._startedAt : 0;
        this._updateSession(sessionId, {
          taskName: 'Cursor IDE',
          status: 'idle',
          currentTool: null,
          lastMessage: sqlite
            ? 'Cursor is open — no recent agent sessions'
            : 'Cursor is open',
          userPrompt: '',
          permissionRequest: null,
          question: null,
          duration,
          durationFormatted: formatDuration(duration),
          startTime: this._startedAt || now,
          lastTime: now,
          lastActivityAt: now,
          terminal: 'Cursor',
          toolCalls: [],
          activity: [],
          isActive: true,
          cwd: '',
          model: null
        });
      }

      // Drop stale sessions
      for (const [id] of this.sessions) {
        if (!activeIds.has(id)) this._removeSession(id);
      }
    } finally {
      this._checking = false;
    }
  }

  async _checkProcess() {
    try {
      const platform = os.platform();

      if (platform === 'win32') {
        const { stdout } = await execFileAsync(
          'tasklist',
          ['/FI', 'IMAGENAME eq Cursor.exe', '/NH'],
          { timeout: 3000, windowsHide: true, encoding: 'utf-8' }
        );
        return stdout.toLowerCase().includes('cursor.exe');
      }

      if (platform === 'darwin') {
        try {
          const { stdout } = await execFileAsync('pgrep', ['-x', 'Cursor'], {
            timeout: 3000,
            encoding: 'utf-8'
          });
          return stdout.trim().length > 0;
        } catch (err) {
          if (err && err.code === 1) return false;
          return false;
        }
      }

      if (platform === 'linux') {
        try {
          const { stdout } = await execFileAsync('pgrep', ['-xi', 'cursor'], {
            timeout: 3000,
            encoding: 'utf-8'
          });
          return stdout.trim().length > 0;
        } catch (err) {
          if (err && err.code === 1) return false;
          return false;
        }
      }

      return false;
    } catch {
      return false;
    }
  }
}

module.exports = { CursorWatcher };
