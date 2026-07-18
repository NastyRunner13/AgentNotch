const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { ClaudeWatcher } = require('./watchers/claude-watcher');
const { CodexWatcher } = require('./watchers/codex-watcher');
const { CursorWatcher } = require('./watchers/cursor-watcher');
const { AntigravityWatcher } = require('./watchers/antigravity-watcher');
const { GrokWatcher } = require('./watchers/grok-watcher');
const { createSettingsStore } = require('./store');
const { collectUsageLimits } = require('./usage-limits');

/**
 * @typedef {Object} AgentSession
 * @property {string} id
 * @property {string} agent
 * @property {string} taskName
 * @property {'working'|'idle'|'permission-request'|'question'|'needs-attention'|'stopped'} status
 * @property {string|null} currentTool
 * @property {string} [lastMessage]
 * @property {string} [userPrompt]
 * @property {object|null} [permissionRequest]
 * @property {object|null} [question]
 * @property {number} [duration]
 * @property {string} [durationFormatted]
 * @property {number} [startTime]
 * @property {number} [lastTime]
 * @property {number} [lastActivityAt]
 * @property {string} [terminal]
 * @property {string[]} [toolCalls]
 * @property {Array<{text:string,at?:number}>} [activity]
 * @property {Array<{step:string,status:string}>} [plan]
 * @property {boolean} [isActive]
 * @property {string} [cwd]
 * @property {string|null} [model]
 * @property {object|null} [rateLimit]
 */

const DEFAULT_SETTINGS = {
  enableClaude: true,
  enableCodex: true,
  enableCursor: true,
  enableAntigravity: true,
  enableGrok: true,
  soundAlerts: true,
  launchAtStartup: false,
  desktopNotifications: true,
  pollInterval: 3000
};

const AGENT_APP_MAP = {
  'Claude Code': { win: 'WindowsTerminal.exe', mac: 'Terminal', linux: null, processNames: ['WindowsTerminal', 'wt', 'claude'] },
  'Codex': { win: 'WindowsTerminal.exe', mac: 'Terminal', linux: null, processNames: ['WindowsTerminal', 'wt', 'codex'] },
  'Cursor': { win: 'Cursor.exe', mac: 'Cursor', linux: 'cursor', processNames: ['Cursor'] },
  'Antigravity': { win: null, mac: null, linux: null, processNames: ['Antigravity', 'gemini'] },
  'Grok': { win: 'WindowsTerminal.exe', mac: 'Terminal', linux: null, processNames: ['WindowsTerminal', 'wt', 'grok'] }
};

/**
 * Central orchestrator for all agent watchers.
 * Aggregates sessions from all agents and emits unified events.
 * Supports session history persistence and task dispatch.
 */
class AgentManager extends EventEmitter {
  constructor() {
    super();

    this._store = createSettingsStore();
    this.settings = { ...DEFAULT_SETTINGS, ...this._store.store };

    const poll = this.settings.pollInterval || 3000;
    this.watchers = {
      claude: new ClaudeWatcher({ pollInterval: poll }),
      codex: new CodexWatcher({ pollInterval: poll }),
      cursor: new CursorWatcher({ pollInterval: Math.max(poll, 5000) }),
      antigravity: new AntigravityWatcher({ pollInterval: poll }),
      grok: new GrokWatcher({ pollInterval: poll })
    };

    // Session history
    this._historyPath = path.join(os.homedir(), '.agent-notch', 'history.json');
    this._history = [];
    this._archivedIds = new Set();
    this._loadHistory();

    this._emitTimer = null;
    /** @type {Set<string>} session ids currently in attention (for sound debounce) */
    this._attentionIds = new Set();
    /** @type {Map<string, string>} previous status per session id (for done detection) */
    this._prevStatus = new Map();
    /** @type {Array|null} last usage snapshot */
    this._usageLimits = null;
    this._usageTimer = null;

    // Forward session updates from all watchers
    for (const watcher of Object.values(this.watchers)) {
      watcher.on('session-update', () => {
        this._scheduleEmit();
      });
    }
  }

  start() {
    if (this.settings.enableClaude) this.watchers.claude.start();
    if (this.settings.enableCodex) this.watchers.codex.start();
    if (this.settings.enableCursor) this.watchers.cursor.start();
    if (this.settings.enableAntigravity) this.watchers.antigravity.start();
    if (this.settings.enableGrok) this.watchers.grok.start();

    console.log('[AgentManager] Started all watchers');

    // Initial emit
    this._scheduleEmit();
    this._refreshUsageLimits();

    // Periodically archive stale sessions to history
    this._archiveTimer = setInterval(() => this._archiveStale(), 30000);
    // Usage limits refresh (local file reads)
    this._usageTimer = setInterval(() => this._refreshUsageLimits(), 15000);
  }

  stop() {
    for (const watcher of Object.values(this.watchers)) {
      watcher.stop();
    }
    if (this._emitTimer) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
    }
    if (this._archiveTimer) {
      clearInterval(this._archiveTimer);
      this._archiveTimer = null;
    }
    if (this._usageTimer) {
      clearInterval(this._usageTimer);
      this._usageTimer = null;
    }
    this._saveHistory();
    console.log('[AgentManager] Stopped all watchers');
  }

  _scheduleEmit() {
    // Debounce emissions to avoid flooding the renderer
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      const sessions = this.getSessions();
      this._detectStatusTransitions(sessions);
      this.emit('sessions-update', sessions);
    }, 200);
  }

  /**
   * Emit attention (permission/question) and done (finished implementing) once per transition.
   */
  _detectStatusTransitions(sessions) {
    const ATTENTION = new Set(['permission-request', 'question', 'needs-attention']);
    const ACTIVE_WORK = new Set(['working', 'permission-request', 'question', 'needs-attention']);
    const currentAttention = new Set();
    const newlyAttention = [];
    const newlyDone = [];
    const seen = new Set();

    for (const session of sessions) {
      seen.add(session.id);
      const prev = this._prevStatus.get(session.id);

      if (ATTENTION.has(session.status)) {
        currentAttention.add(session.id);
        if (!this._attentionIds.has(session.id)) {
          newlyAttention.push(session);
        }
      }

      // Done implementing: transitioned from active work → idle
      if (session.status === 'idle' && prev && ACTIVE_WORK.has(prev)) {
        newlyDone.push(session);
      }

      this._prevStatus.set(session.id, session.status);
    }

    // Drop statuses for sessions that disappeared
    for (const id of this._prevStatus.keys()) {
      if (!seen.has(id)) this._prevStatus.delete(id);
    }

    this._attentionIds = currentAttention;

    if (newlyAttention.length > 0) {
      this.emit('attention', newlyAttention);
    }
    if (newlyDone.length > 0) {
      this.emit('done', newlyDone);
    }
  }

  _refreshUsageLimits() {
    try {
      const sessions = this.getSessions();
      const usage = collectUsageLimits({
        sessions,
        enabled: this.settings
      });
      this._usageLimits = usage;
      this.emit('usage-update', usage);
    } catch (err) {
      console.warn('[AgentManager] usage limits failed:', err.message);
    }
  }

  getUsageLimits() {
    if (!this._usageLimits) {
      this._refreshUsageLimits();
    }
    return this._usageLimits || [];
  }

  getSessions() {
    const all = [];
    for (const watcher of Object.values(this.watchers)) {
      all.push(...watcher.getSessions().filter(session =>
        session.status !== 'idle' || !this._archivedIds.has(session.id)
      ));
    }
    // Sort: needs-attention first, then working, then idle
    const priority = {
      'permission-request': 0,
      'question': 1,
      'needs-attention': 2,
      'working': 3,
      'idle': 4,
      'stopped': 5
    };
    all.sort((a, b) => {
      const pa = priority[a.status] ?? 4;
      const pb = priority[b.status] ?? 4;
      if (pa !== pb) return pa - pb;
      return (b.lastTime || 0) - (a.lastTime || 0);
    });
    return all;
  }

  getSettings() {
    return { ...this.settings };
  }

  /**
   * Which agent data roots exist on disk (for empty-state / settings UI).
   */
  getAgentDetection() {
    const home = os.homedir();
    const exists = (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    };
    return {
      claude: exists(path.join(home, '.claude', 'projects')),
      codex: exists(path.join(home, '.codex', 'sessions')),
      cursor: true, // process-based
      antigravity: exists(path.join(home, '.gemini', 'antigravity-ide', 'brain')),
      grok: exists(path.join(home, '.grok', 'sessions'))
    };
  }

  updateSettings(newSettings) {
    const prev = { ...this.settings };
    Object.assign(this.settings, newSettings);

    // Persist settings (only known keys)
    const toSave = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (this.settings[key] !== undefined) {
        toSave[key] = this.settings[key];
      }
    }
    this._store.set(toSave);

    // Toggle watchers based on settings
    const watcherMap = {
      enableClaude: 'claude',
      enableCodex: 'codex',
      enableCursor: 'cursor',
      enableAntigravity: 'antigravity',
      enableGrok: 'grok'
    };

    for (const [setting, watcherKey] of Object.entries(watcherMap)) {
      if (this.settings[setting]) {
        this.watchers[watcherKey].start();
      } else {
        this.watchers[watcherKey].stop();
      }
    }

    // Apply poll interval to all watchers
    if (newSettings.pollInterval !== undefined) {
      const poll = this.settings.pollInterval || 3000;
      for (const [key, watcher] of Object.entries(this.watchers)) {
        watcher.setPollInterval(key === 'cursor' ? Math.max(poll, 5000) : poll);
      }
    }

    // Notify main process for login-item / side effects
    if (prev.launchAtStartup !== this.settings.launchAtStartup) {
      this.emit('settings-changed', { launchAtStartup: this.settings.launchAtStartup });
    }

    this.emit('settings-changed', { ...this.settings });
  }

  // ── History ────────────────────────────────────────

  _loadHistory() {
    try {
      if (fs.existsSync(this._historyPath)) {
        const data = fs.readFileSync(this._historyPath, 'utf-8');
        this._history = JSON.parse(data);
        // Track archived IDs to avoid duplicates
        for (const entry of this._history) {
          this._archivedIds.add(entry.id);
        }
      }
    } catch (err) {
      console.error('[AgentManager] Failed to load history:', err.message);
      this._history = [];
    }
  }

  _saveHistory() {
    try {
      const dir = path.dirname(this._historyPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Keep last 200 entries max
      if (this._history.length > 200) {
        this._history = this._history.slice(-200);
      }
      fs.writeFileSync(this._historyPath, JSON.stringify(this._history, null, 2));
    } catch (err) {
      console.error('[AgentManager] Failed to save history:', err.message);
    }
  }

  _archiveStale() {
    const sessions = this.getSessions();
    for (const session of sessions) {
      // Archive idle sessions that haven't been modified in 5+ minutes
      if (session.status === 'idle' && session.lastTime) {
        const idleTime = Date.now() - session.lastTime;
        if (idleTime > 300000 && !this._archivedIds.has(session.id)) {
          this._archiveSession(session);
        }
      }
    }
  }

  _archiveSession(session) {
    if (this._archivedIds.has(session.id)) return;

    this._archivedIds.add(session.id);
    this._history.push({
      id: session.id,
      agent: session.agent,
      taskName: session.taskName,
      userPrompt: session.userPrompt,
      status: session.status,
      duration: session.duration,
      durationFormatted: session.durationFormatted,
      startTime: session.startTime,
      lastTime: session.lastTime,
      lastActivityAt: session.lastActivityAt,
      toolCalls: session.toolCalls || [],
      lastMessage: session.lastMessage,
      activity: session.activity || [],
      plan: session.plan || [],
      cwd: session.cwd || null,
      archivedAt: Date.now()
    });

    this._saveHistory();
    this._scheduleEmit();
  }

  getHistory() {
    // Return sorted by most recent first
    return [...this._history].sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  }

  clearHistory() {
    this._history = [];
    this._archivedIds.clear();
    this._saveHistory();
    return { success: true };
  }

  // ── Actions ────────────────────────────────────────

  /**
   * Remote approval is not available for most agents.
   * Focus the agent app so the user can approve there.
   */
  async approvePermission(sessionId) {
    const result = await this.jumpToTerminal(sessionId);
    return {
      success: result.success,
      message: result.success
        ? 'Opened agent — approve the permission request there. Remote approve is not supported yet.'
        : result.message,
      focused: result.success
    };
  }

  async denyPermission(sessionId) {
    const result = await this.jumpToTerminal(sessionId);
    return {
      success: result.success,
      message: result.success
        ? 'Opened agent — deny the permission request there. Remote deny is not supported yet.'
        : result.message,
      focused: result.success
    };
  }

  async answerQuestion(sessionId, answer) {
    const result = await this.jumpToTerminal(sessionId);
    return {
      success: result.success,
      message: result.success
        ? `Opened agent — answer there${answer ? ` (suggested: ${String(answer).slice(0, 80)})` : ''}. Remote answer is not supported yet.`
        : result.message,
      focused: result.success,
      answer
    };
  }

  async jumpToTerminal(sessionId) {
    const session = this.getSessions().find(s => s.id === sessionId);
    if (!session) return { success: false, message: 'Session not found' };

    try {
      const focused = await focusAgentApp(session.agent);
      if (focused) {
        return { success: true, message: `Focused ${session.agent}` };
      }
      return {
        success: false,
        message: `Could not focus ${session.agent}. Open it manually.`
      };
    } catch (err) {
      return { success: false, message: err.message || 'Focus failed' };
    }
  }

  /**
   * Dispatch a task to an agent CLI without shell interpolation.
   */
  async dispatchTask(agent, prompt) {
    const text = String(prompt || '').trim();
    if (!text) {
      return { success: false, message: 'Prompt is empty' };
    }

    const cliMap = {
      'Claude Code': { bin: 'claude', args: [text] },
      'Codex': { bin: 'codex', args: [text] },
      'Antigravity': { bin: 'gemini', args: [text] },
      'Grok': { bin: 'grok', args: [text] }
    };

    const spec = cliMap[agent];
    if (!spec) {
      return { success: false, message: `Unknown agent: ${agent}` };
    }

    try {
      await spawnInTerminal(spec.bin, spec.args);
      return { success: true, message: `Dispatched to ${agent}` };
    } catch (err) {
      return {
        success: false,
        message: err.message || `Failed to launch ${spec.bin}. Is it on PATH?`
      };
    }
  }
}

/**
 * Focus an agent application window (best-effort, platform-specific).
 */
function focusAgentApp(agentName) {
  return new Promise((resolve) => {
    const mapping = AGENT_APP_MAP[agentName];
    const platform = process.platform;

    if (platform === 'win32') {
      const processNames = (mapping && mapping.processNames) || [agentName];
      // Try each process name; use PowerShell to restore/focus main window
      const namesList = processNames.map(n => n.replace(/'/g, "''")).join("','");
      const ps = `
        $names = @('${namesList}');
        foreach ($n in $names) {
          $p = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
          if ($p) {
            Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);';
            [Native.Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null;
            [Native.Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;
            exit 0;
          }
        }
        # Fallback: start Cursor if agent is Cursor
        if ('${agentName.replace(/'/g, "''")}' -eq 'Cursor') {
          Start-Process 'Cursor' -ErrorAction SilentlyContinue;
          exit 0;
        }
        exit 1;
      `.replace(/\n/g, ' ');

      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps
      ], { windowsHide: true });

      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
      return;
    }

    if (platform === 'darwin') {
      const appName = (mapping && mapping.mac) || agentName;
      const script = `tell application "${appName.replace(/"/g, '\\"')}" to activate`;
      const child = spawn('osascript', ['-e', script]);
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
      return;
    }

    // Linux best-effort
    if (mapping && mapping.linux) {
      const child = spawn('wmctrl', ['-a', mapping.linux]);
      child.on('close', (code) => {
        if (code === 0) return resolve(true);
        spawn(mapping.linux, [], { detached: true, stdio: 'ignore' }).unref();
        resolve(true);
      });
      child.on('error', () => {
        try {
          spawn(mapping.linux, [], { detached: true, stdio: 'ignore' }).unref();
          resolve(true);
        } catch {
          resolve(false);
        }
      });
      return;
    }

    resolve(false);
  });
}

/**
 * Spawn a CLI inside a new terminal window without shell-string interpolation of the prompt.
 * @param {string} bin
 * @param {string[]} args
 */
function spawnInTerminal(bin, args) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;

    if (platform === 'win32') {
      // cmd /k keeps window open; pass bin and args as separate argv after /k so
      // the prompt is not re-parsed as shell metacharacters by our process.
      // Using `cmd /k` with one argument list: start via spawn of cmd.exe.
      const quotedArgs = args.map(a => {
        // Escape for cmd.exe: wrap in quotes, double inner quotes
        const s = String(a).replace(/"/g, '""');
        return `"${s}"`;
      }).join(' ');
      const line = `${bin} ${quotedArgs}`;
      const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', line], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.on('error', reject);
      child.unref();
      // start returns immediately
      resolve();
      return;
    }

    if (platform === 'darwin') {
      // osascript: open Terminal and run command with proper escaping for AppleScript
      const full = [bin, ...args].map(part => {
        const s = String(part).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `"${s}"`;
      }).join(' & " " & ');
      const script = `tell application "Terminal" to do script (${full})`;
      const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`osascript exited ${code}. Is ${bin} installed?`));
      });
      child.unref();
      return;
    }

    // Linux: try x-terminal-emulator or gnome-terminal
    const termArgs = ['-e', bin, ...args];
    const child = spawn('x-terminal-emulator', termArgs, {
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => {
      const g = spawn('gnome-terminal', ['--', bin, ...args], {
        detached: true,
        stdio: 'ignore'
      });
      g.on('error', reject);
      g.unref();
      resolve();
    });
    child.unref();
    resolve();
  });
}

module.exports = { AgentManager };
