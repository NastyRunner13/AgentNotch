const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const { BaseWatcher, formatDuration } = require('./base-watcher');

const execFileAsync = promisify(execFile);

/**
 * Watches for running Cursor IDE processes (async, non-blocking).
 *
 * Cursor doesn't expose rich session JSON easily, so we report a lightweight
 * "IDE open" session as idle (not working) unless we later detect agent activity.
 */
class CursorWatcher extends BaseWatcher {
  constructor(options = {}) {
    super('Cursor', { pollInterval: 5000, ...options });
    this._startedAt = null;
    this._checking = false;
  }

  _start() {
    console.log('[Cursor] Process monitoring started');
  }

  _stop() {
    this._startedAt = null;
  }

  async _poll() {
    if (this._checking) return;
    this._checking = true;

    try {
      const isRunning = await this._checkProcess();
      const sessionId = 'cursor-main';

      if (isRunning) {
        if (!this._startedAt) {
          this._startedAt = Date.now();
        }

        const duration = Date.now() - this._startedAt;

        this._updateSession(sessionId, {
          taskName: 'Cursor IDE',
          // Idle = open but not claimed as an active coding-agent run
          status: 'idle',
          currentTool: null,
          lastMessage: 'Cursor is open',
          userPrompt: '',
          permissionRequest: null,
          question: null,
          duration,
          durationFormatted: formatDuration(duration),
          startTime: this._startedAt,
          lastTime: Date.now(),
          lastActivityAt: Date.now(),
          terminal: 'Cursor',
          toolCalls: [],
          isActive: true
        });
      } else {
        this._startedAt = null;
        if (this.sessions.has(sessionId)) {
          this._removeSession(sessionId);
        }
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
          // pgrep exits 1 when no match
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
