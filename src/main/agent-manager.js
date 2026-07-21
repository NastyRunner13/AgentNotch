const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const chokidar = require('chokidar');
const { ClaudeWatcher } = require('./watchers/claude-watcher');
const { CodexWatcher } = require('./watchers/codex-watcher');
const { CursorWatcher } = require('./watchers/cursor-watcher');
const { AntigravityWatcher } = require('./watchers/antigravity-watcher');
const { GrokWatcher } = require('./watchers/grok-watcher');
const { OpencodeWatcher } = require('./watchers/opencode-watcher');
const { createSettingsStore } = require('./store');
const { collectUsageLimits } = require('./usage-limits');
const permissionBridge = require('./permission-bridge');

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
  enableOpencode: true,
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
  'Grok': { win: 'WindowsTerminal.exe', mac: 'Terminal', linux: null, processNames: ['WindowsTerminal', 'wt', 'grok'] },
  'OpenCode': { win: 'WindowsTerminal.exe', mac: 'Terminal', linux: null, processNames: ['WindowsTerminal', 'wt', 'opencode'] }
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
      grok: new GrokWatcher({ pollInterval: poll }),
      opencode: new OpencodeWatcher({ pollInterval: poll })
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
    /** @type {import('chokidar').FSWatcher|null} */
    this._permissionWatcher = null;
    /** @type {Set<string>} pending request ids already used for attention emit */
    this._knownPendingIds = new Set();

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
    if (this.settings.enableOpencode) this.watchers.opencode.start();

    // Keep bridge script fresh for Claude PermissionRequest hooks
    try {
      permissionBridge.syncBridgeScript();
      permissionBridge.pruneStalePending();
    } catch (err) {
      console.warn('[AgentManager] permission bridge sync failed:', err.message);
    }
    this._startPermissionWatcher();

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
    this._stopPermissionWatcher();
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

  _startPermissionWatcher() {
    this._stopPermissionWatcher();
    try {
      permissionBridge.ensureDirs();
      const dir = permissionBridge.pendingDir();
      this._permissionWatcher = chokidar.watch(dir, {
        ignoreInitial: false,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 50 }
      });
      const onChange = () => {
        this._onPendingPermissionsChanged();
      };
      this._permissionWatcher.on('add', onChange);
      this._permissionWatcher.on('change', onChange);
      this._permissionWatcher.on('unlink', onChange);
    } catch (err) {
      console.warn('[AgentManager] permission watcher failed:', err.message);
    }
  }

  _stopPermissionWatcher() {
    if (this._permissionWatcher) {
      try {
        this._permissionWatcher.close();
      } catch {
        // ignore
      }
      this._permissionWatcher = null;
    }
  }

  _onPendingPermissionsChanged() {
    const pending = permissionBridge.listPending();
    const currentIds = new Set(pending.map((p) => p.id));

    // Drop known ids that are gone
    for (const id of this._knownPendingIds) {
      if (!currentIds.has(id)) this._knownPendingIds.delete(id);
    }

    const newly = pending.filter((p) => !this._knownPendingIds.has(p.id));
    for (const p of newly) {
      this._knownPendingIds.add(p.id);
    }

    this._scheduleEmit();

    if (newly.length > 0) {
      // Build lightweight session-shaped objects for notifications
      const sessions = this.getSessions().filter((s) => s.remoteApprove && s.status === 'permission-request');
      const attention = sessions.length
        ? sessions.filter((s) => newly.some((p) => p.notchSessionId === s.id || s.permissionRequest?.requestId === p.id))
        : newly.map((p) => ({
          id: p.notchSessionId || `claude-pending-${p.id}`,
          agent: 'Claude Code',
          taskName: p.tool ? `Permission: ${p.tool}` : 'Permission request',
          status: 'permission-request',
          permissionRequest: permissionBridge.pendingToPermissionRequest(p),
          remoteApprove: true
        }));
      if (attention.length > 0) {
        this.emit('attention', attention);
      }
    }
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

  async _refreshUsageLimits() {
    try {
      // Prune orphaned pending requests on every usage refresh tick (every 15s)
      permissionBridge.pruneStalePending();
      const sessions = this.getSessions();
      const usage = await collectUsageLimits({
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
      // Fire async refresh but return empty synchronously for first call
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

    // Merge Claude PermissionRequest hook pendings (true remote approve)
    const merged = permissionBridge.mergePendingIntoSessions(all);

    // Sort: needs-attention first, then working, then idle
    const priority = {
      'permission-request': 0,
      'question': 1,
      'needs-attention': 2,
      'working': 3,
      'idle': 4,
      'stopped': 5
    };
    merged.sort((a, b) => {
      const pa = priority[a.status] ?? 4;
      const pb = priority[b.status] ?? 4;
      if (pa !== pb) return pa - pb;
      return (b.lastTime || 0) - (a.lastTime || 0);
    });
    return merged;
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
    const opencodeDbPaths = [
      path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'opencode', 'opencode.db') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db') : null
    ].filter(Boolean);
    return {
      claude: exists(path.join(home, '.claude', 'projects')),
      codex: exists(path.join(home, '.codex', 'sessions')),
      cursor: true, // process-based
      antigravity: exists(path.join(home, '.gemini', 'antigravity-ide', 'brain')),
      grok: exists(path.join(home, '.grok', 'sessions')),
      opencode: opencodeDbPaths.some(exists)
    };
  }

  updateSettings(newSettings) {
    const prev = { ...this.settings };
    // Whitelist: only accept known keys from DEFAULT_SETTINGS (prevents __proto__
    // pollution), and only when the value type matches the default (prevents
    // type confusion from a compromised/buggy renderer).
    const safeUpdate = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.prototype.hasOwnProperty.call(newSettings, key)) continue;
      if (typeof newSettings[key] !== typeof DEFAULT_SETTINGS[key]) continue;
      safeUpdate[key] = newSettings[key];
    }
    Object.assign(this.settings, safeUpdate);

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
      enableGrok: 'grok',
      enableOpencode: 'opencode'
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
   * Approve a permission request.
   * Claude Code: write decision file for the PermissionRequest hook bridge (true remote).
   * Others: focus the agent app so the user can approve there.
   */
  async approvePermission(sessionId) {
    const remote = permissionBridge.submitDecisionForSession(sessionId, 'allow');
    if (remote.success) {
      this._scheduleEmit();
      return remote;
    }

    // Explicit requestId on session card (synthetic / orphan)
    const session = this.getSessions().find((s) => s.id === sessionId);
    const requestId = session?.permissionRequest?.requestId;
    if (requestId) {
      const byId = permissionBridge.submitDecision(requestId, 'allow');
      if (byId.success) {
        this._scheduleEmit();
        return byId;
      }
    }

    const result = await this.jumpToTerminal(sessionId);
    return {
      success: result.success,
      message: result.success
        ? 'Opened agent — approve the permission request there. Install the Claude hook in Settings for in-notch approve.'
        : result.message,
      focused: result.success,
      remote: false
    };
  }

  async denyPermission(sessionId) {
    const remote = permissionBridge.submitDecisionForSession(sessionId, 'deny');
    if (remote.success) {
      this._scheduleEmit();
      return remote;
    }

    const session = this.getSessions().find((s) => s.id === sessionId);
    const requestId = session?.permissionRequest?.requestId;
    if (requestId) {
      const byId = permissionBridge.submitDecision(requestId, 'deny');
      if (byId.success) {
        this._scheduleEmit();
        return byId;
      }
    }

    const result = await this.jumpToTerminal(sessionId);
    return {
      success: result.success,
      message: result.success
        ? 'Opened agent — deny the permission request there. Install the Claude hook in Settings for in-notch deny.'
        : result.message,
      focused: result.success,
      remote: false
    };
  }

  installClaudePermissionHook() {
    try {
      return permissionBridge.installClaudeHook();
    } catch (err) {
      return { success: false, message: err.message || 'Install failed' };
    }
  }

  uninstallClaudePermissionHook() {
    try {
      return permissionBridge.uninstallClaudeHook();
    } catch (err) {
      return { success: false, message: err.message || 'Uninstall failed' };
    }
  }

  getClaudePermissionHookStatus() {
    try {
      return permissionBridge.getHookStatus();
    } catch (err) {
      return {
        installed: false,
        bridgeExists: false,
        bridgePath: permissionBridge.bridgeInstallPath(),
        settingsPath: path.join(os.homedir(), '.claude', 'settings.json'),
        pendingCount: 0,
        error: err.message
      };
    }
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
   * Dispatch a message to an already-running session: resume the session's own
   * native id with its agent CLI in non-interactive mode, so the message lands
   * in the SAME chat/session (and its transcript) instead of starting a new one.
   * No terminal window is opened; the watchers pick up the new activity.
   *
   * @param {string} sessionId — AgentNotch session id (e.g. `claude-<uuid>`)
   * @param {string} prompt
   */
  async dispatchTask(sessionId, prompt) {
    const text = String(prompt || '').trim();
    if (!text) {
      return { success: false, message: 'Prompt is empty' };
    }

    const session = this.getSessions().find(s => s.id === sessionId);
    if (!session) {
      return { success: false, message: 'Session not found — it may have already ended.' };
    }

    const cmd = buildResumeCommand(session, text);
    if (!cmd) {
      return {
        success: false,
        message: `${session.agent} sessions can't receive dispatched messages.`
      };
    }
    if (!cmd.cwd || !isDirectory(cmd.cwd)) {
      return {
        success: false,
        message: 'Session directory unknown — cannot resume this session yet.'
      };
    }

    try {
      await runHeadlessResume(cmd);
      this._scheduleEmit();
      return {
        success: true,
        message: `Sent to ${session.agent} · ${session.taskName || 'session'}`,
        sessionId: session.id
      };
    } catch (err) {
      return {
        success: false,
        message: err.message || `Failed to dispatch to ${session.agent}`
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
 * Agents that support resuming a live session non-interactively.
 * `prefix` is the AgentNotch session-id prefix; the native resume id is the
 * remainder (Codex prefers session.resumeId captured from session_meta).
 */
const DISPATCH_AGENTS = {
  'Claude Code': {
    bin: 'claude',
    prefix: 'claude-',
    args: (id, text) => ['-p', '--resume', id, text]
  },
  'Codex': {
    bin: 'codex',
    prefix: 'codex-',
    args: (id, text) => ['exec', '--skip-git-repo-check', 'resume', id, text]
  },
  'Grok': {
    bin: 'grok',
    prefix: 'grok-',
    args: (id, text) => ['-r', id, '-p', text]
  },
  'OpenCode': {
    bin: 'opencode',
    prefix: 'opencode-',
    args: (id, text) => ['run', '-s', id, text]
  }
};

// Native ids come from on-disk filenames / db ids — keep them argument-safe.
const NATIVE_ID_RE = /^[a-zA-Z0-9._~%-]{1,220}$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Build the non-interactive resume command for a live session, or null when
 * the agent can't receive dispatched messages (Antigravity, Cursor, …).
 * Pure — exported for tests.
 *
 * @param {object} session — live AgentNotch session
 * @param {string} text    — message to deliver
 * @returns {{bin:string, args:string[], cwd:string}|null}
 */
function buildResumeCommand(session, text) {
  if (!session || typeof session.id !== 'string') return null;
  const spec = DISPATCH_AGENTS[session.agent];
  if (!spec || !session.id.startsWith(spec.prefix)) return null;

  // Codex rollout filenames are `rollout-<ts>-<uuid>`; the resume id is the
  // UUID — prefer the exact id captured from session_meta when available.
  let nativeId = session.resumeId || session.id.slice(spec.prefix.length);
  if (session.agent === 'Codex' && !session.resumeId) {
    const m = nativeId.match(UUID_RE);
    if (m) nativeId = m[0];
  }
  if (!nativeId || !NATIVE_ID_RE.test(nativeId)) return null;

  const cwd = typeof session.cwd === 'string' ? session.cwd.trim() : '';
  return { bin: spec.bin, args: spec.args(nativeId, text), cwd };
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const DISPATCH_LOG_DIR = path.join(os.tmpdir(), 'agent-notch-dispatch');
const _resolvedCli = new Map();

/**
 * Locate a CLI on PATH. On Windows, prefer a real .exe over .cmd shims
 * (CreateProcess can't exec .cmd directly — those go through cmd.exe).
 */
function resolveCli(bin) {
  if (_resolvedCli.has(bin)) return _resolvedCli.get(bin);
  let resolved = { file: bin, viaCmd: false };

  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', [bin], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      });
      const candidates = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const exe = candidates.find(c => /\.exe$/i.test(c));
      const cmd = candidates.find(c => /\.(cmd|bat)$/i.test(c));
      if (exe) {
        resolved = { file: exe, viaCmd: false };
      } else if (cmd) {
        resolved = { file: cmd, viaCmd: true };
      }
    } catch {
      // fall through — spawn will report ENOENT if truly missing
    }
  }

  _resolvedCli.set(bin, resolved);
  return resolved;
}

function openDispatchLog(bin) {
  fs.mkdirSync(DISPATCH_LOG_DIR, { recursive: true });
  pruneDispatchLogs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(DISPATCH_LOG_DIR, `${stamp}-${bin}.log`);
  return { logPath, fd: fs.openSync(logPath, 'a') };
}

function pruneDispatchLogs(keep = 12) {
  try {
    const files = fs.readdirSync(DISPATCH_LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.unlinkSync(path.join(DISPATCH_LOG_DIR, f)); } catch { /* ignore */ }
    }
  } catch {
    // ignore
  }
}

function readLogTail(logPath, max = 600) {
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    return content.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-max);
  } catch {
    return '';
  }
}

/**
 * Spawn the resume command hidden (no terminal window), detached, with output
 * captured to a log file. Resolves once the process survives a short grace
 * window; rejects early on spawn failure or a fast non-zero exit (e.g. the
 * native session id was rejected), including the captured CLI error output.
 *
 * @param {{bin:string, args:string[], cwd:string}} cmd
 */
function runHeadlessResume(cmd) {
  return new Promise((resolve, reject) => {
    const cli = resolveCli(cmd.bin);
    const { logPath, fd } = openDispatchLog(cmd.bin);

    const file = cli.viaCmd ? (process.env.ComSpec || 'cmd.exe') : cli.file;
    const args = cli.viaCmd ? ['/d', '/s', '/c', cli.file, ...cmd.args] : cmd.args;

    let child;
    let graceTimer = null;
    try {
      child = spawn(file, args, {
        cwd: cmd.cwd,
        windowsHide: true,
        detached: true,
        stdio: ['ignore', fd, fd]
      });
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      reject(new Error(`Failed to launch ${cmd.bin}: ${err.message}`));
      return;
    }

    const settle = (err) => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      try { fs.closeSync(fd); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve();
    };

    child.on('error', (err) => {
      settle(new Error(`Failed to launch ${cmd.bin} — is it installed and on PATH? (${err.message})`));
    });

    child.on('exit', (code) => {
      if (code === 0) {
        settle();
      } else {
        const tail = readLogTail(logPath);
        settle(new Error(tail || `${cmd.bin} exited with code ${code}`));
      }
    });

    // Grace window: CLIs reject an unknown session id / auth problem within a
    // second or two; a still-running process after that means the message was
    // accepted and the agent is now working on it.
    graceTimer = setTimeout(() => {
      graceTimer = null;
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      child.unref();
      settle();
    }, 4000);
  });
}

module.exports = { AgentManager, buildResumeCommand };
