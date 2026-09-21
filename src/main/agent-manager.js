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
const { GrokWatcher } = require('./watchers/grok/watcher');
const { OpencodeWatcher } = require('./watchers/opencode-watcher');
const { createSettingsStore } = require('./settings/store');
const {
  DEFAULT_SETTINGS,
  ATTENTION_NOTIFY_KEYS,
  ATTENTION_SOUND_KEYS
} = require('./settings/settings-defaults');
const { collectUsageLimits, detectLimitCrossings } = require('./usage/usage-limits');
const { UsageTracker, dayKey, sessionActiveMs } = require('./usage/usage-stats');
const { scanUsageHistory } = require('./usage/usage-backfill');
const { buildInsights } = require('./insights/insights');
const permissionBridge = require('./permissions/permission-bridge');
const permissionMemory = require('./permissions/permission-memory');
const {
  normalizeAgentRoots,
  probeWsl,
  resolveAgentWatchTargets,
  wslUncPath,
  toWindowsReadablePath,
  toLinuxCwd,
  isLinuxCwd,
  isWslBackedSession
} = require('./lib/agent-paths');
const { readGitContext } = require('./session/git-context');
const { parseTaggedSessionId } = require('./watchers/session-utils');
const {
  normalizeNotchAlign,
  clampAutohideDelayMs,
  createSnoozeEntry,
  isSnoozeActive,
  normalizeMutedAgents,
  isSessionAttention,
  isStalled,
  normalizeStallAfterMs,
  attentionEpisodeKey,
  isAttentionEpisodeAcknowledged,
  compareSessionsByAttention,
  annotateAttentionQueue
} = require('./session/attention-policy');
const {
  buildArchiveSnapshot,
  applyHistoryPin,
  trimHistoryEntries,
  resolveHistoryResumeTarget,
  DEFAULT_CONTINUE_PROMPT
} = require('./session/history-utils');
const {
  sanitizeWslDistro,
  sanitizeHotkey,
  clampPollInterval,
  sanitizeConfigurablePath,
  sanitizeAgentRoots,
  planWindowsCliLaunch,
  writePrivateFile,
  ensurePrivateDir
} = require('./security/security');

const USAGE_BACKFILL_VERSION = 3; // v3: Grok tokens + active-span session time

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
    this._migrateAttentionSettings();
    this._normalizeNotchSettings();

    /** @type {{ distro: string, linuxHome: string }|null} */
    this._wslInfo = null;
    this._wslProbed = false;
    this.watchers = {};
    this._createWatchers();

    // Session history
    this._historyPath = path.join(os.homedir(), '.agent-notch', 'history.json');
    this._history = [];
    this._archivedIds = new Set();
    /** @type {Map<string, number>} dismissed non-idle sessions: id → lastTime snapshot at dismiss time */
    this._dismissed = new Map();
    /**
     * Session snooze: mute sound + toast only (bar truth stays).
     * @type {Map<string, { until?: number, untilIdle?: boolean }>}
     */
    this._snoozes = new Map();
    /**
     * Dismiss-attention acks: session id → episode key.
     * Clears that episode from the attention queue without removing the session.
     * @type {Map<string, string>}
     */
    this._attentionAcks = new Map();
    this._loadHistory();

    this._emitTimer = null;
    /**
     * Session id → attention episode key currently known (interrupt debounce).
     * Re-fires when the episode key changes even if status stays attention.
     * @type {Map<string, string>}
     */
    this._attentionEpisodes = new Map();
    /** @type {Map<string, string>} previous status per session id (for done detection) */
    this._prevStatus = new Map();
    /** @type {Array|null} last usage snapshot */
    this._usageLimits = null;
    /** @type {Map<string, string>} limit alert debounce: agent|resetsAt|band → band */
    this._limitAlertState = new Map();
    this._usageTimer = null;
    /** Token/cost accumulation into persisted daily buckets (dashboard data) */
    this._usageTracker = new UsageTracker();
    /** Delayed one-shot history backfill timer */
    this._backfillTimer = null;
    /** @type {import('chokidar').FSWatcher|null} */
    this._permissionWatcher = null;
    /** @type {Set<string>} pending request ids already used for attention emit */
    this._knownPendingIds = new Set();
    this._permissionMemoryPath = permissionMemory.defaultMemoryPath();
  }

  _probeWslCached() {
    if (this._wslProbed) return this._wslInfo;
    this._wslProbed = true;
    if (process.platform !== 'win32' || this.settings.watchWsl === false) {
      this._wslInfo = null;
      this._configurePermissionRoots();
      return null;
    }
    this._wslInfo = probeWsl({ preferred: this.settings.wslDistro });
    this._configurePermissionRoots();
    return this._wslInfo;
  }

  /** Watch Windows + WSL `~/.agent-notch/permissions` so WSL Claude Allow works. */
  _configurePermissionRoots() {
    const extra = [];
    const wsl = this._wslInfo;
    if (wsl && wsl.distro && wsl.linuxHome) {
      extra.push(wslUncPath(wsl.distro, wsl.linuxHome, '.agent-notch'));
    }
    permissionBridge.setExtraAgentNotchHomes(extra);
  }

  /**
   * Build / rebuild watcher instances from settings (custom roots + WSL extra).
   * Extra WSL watchers use sourceTag `wsl` so session ids do not collide.
   */
  _createWatchers() {
    if (this.watchers) {
      for (const watcher of Object.values(this.watchers)) {
        try { watcher.stop(); } catch { /* ignore */ }
        try { watcher.removeAllListeners(); } catch { /* ignore */ }
      }
    }

    const poll = this.settings.pollInterval || 3000;
    const resolved = resolveAgentWatchTargets(this.settings, {
      wsl: this._probeWslCached()
    });
    const t = resolved.targets;
    const home = os.homedir();

    const cursorUserData = t.cursor.primary;
    const cursorPaths = {
      globalDb: path.join(cursorUserData, 'User', 'globalStorage', 'state.vscdb'),
      workspaceRoot: path.join(cursorUserData, 'User', 'workspaceStorage'),
      projectsRoot: path.join(home, '.cursor', 'projects')
    };

    this.watchers = {
      claude: new ClaudeWatcher({ pollInterval: poll, claudeDir: t.claude.primary }),
      codex: new CodexWatcher({ pollInterval: poll, codexDir: t.codex.primary }),
      cursor: new CursorWatcher({ pollInterval: Math.max(poll, 5000), paths: cursorPaths }),
      antigravity: new AntigravityWatcher({ pollInterval: poll, geminiDir: t.antigravity.primary }),
      grok: new GrokWatcher({ pollInterval: poll, grokDir: t.grok.primary }),
      opencode: new OpencodeWatcher({ pollInterval: poll, dbPath: t.opencode.primary })
    };

    if (t.claude.extra[0]) {
      this.watchers.claudeWsl = new ClaudeWatcher({
        pollInterval: poll,
        claudeDir: t.claude.extra[0],
        sourceTag: 'wsl'
      });
    }
    if (t.codex.extra[0]) {
      this.watchers.codexWsl = new CodexWatcher({
        pollInterval: poll,
        codexDir: t.codex.extra[0],
        sourceTag: 'wsl'
      });
    }
    if (t.grok.extra[0]) {
      this.watchers.grokWsl = new GrokWatcher({
        pollInterval: poll,
        grokDir: t.grok.extra[0],
        sourceTag: 'wsl'
      });
    }
    if (t.antigravity.extra[0]) {
      this.watchers.antigravityWsl = new AntigravityWatcher({
        pollInterval: poll,
        geminiDir: t.antigravity.extra[0],
        sourceTag: 'wsl'
      });
    }
    if (t.opencode.extra[0]) {
      this.watchers.opencodeWsl = new OpencodeWatcher({
        pollInterval: poll,
        dbPath: t.opencode.extra[0],
        sourceTag: 'wsl'
      });
    }

    for (const watcher of Object.values(this.watchers)) {
      watcher.on('session-update', () => {
        this._scheduleEmit();
      });
    }
  }

  _applyWatcherEnabled() {
    const map = {
      enableClaude: ['claude', 'claudeWsl'],
      enableCodex: ['codex', 'codexWsl'],
      enableCursor: ['cursor'],
      enableAntigravity: ['antigravity', 'antigravityWsl'],
      enableGrok: ['grok', 'grokWsl'],
      enableOpencode: ['opencode', 'opencodeWsl']
    };
    for (const [setting, keys] of Object.entries(map)) {
      for (const key of keys) {
        const watcher = this.watchers[key];
        if (!watcher) continue;
        if (this.settings[setting]) watcher.start();
        else watcher.stop();
      }
    }
  }

  start() {
    this._applyWatcherEnabled();

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
    // Re-annotate stall even when watchers have nothing new to emit
    this._stallTimer = setInterval(() => this._scheduleEmit(), 15000);
    // Usage limits refresh (local file reads)
    this._usageTimer = setInterval(() => this._refreshUsageLimits(), 15000);
    // One-shot usage backfill from on-disk session files (dashboard history)
    this._backfillTimer = setTimeout(() => {
      this._backfillTimer = null;
      this._backfillUsage();
    }, 2500);
  }

  /**
   * Reconstruct per-day token/cost/session-time history from on-disk agent
   * records (Claude transcripts, Codex rollouts, OpenCode DB) so the usage
   * dashboard shows past dates. Idempotent — the tracker banks only deltas
   * over its high-water marks. Throttled: at most once per 6h of app runtime.
   */
  _backfillUsage() {
    const THROTTLE_MS = 6 * 60 * 60 * 1000;
    if (
      this._usageTracker.lastBackfillVersion === USAGE_BACKFILL_VERSION &&
      Date.now() - (this._usageTracker.lastBackfillAt || 0) < THROTTLE_MS
    ) return;

    const started = Date.now();
    try {
      const { records, files, errors } = scanUsageHistory();
      let banked = 0;
      for (const rec of records) {
        try {
          if (this._usageTracker.ingestHistorical(rec)) banked++;
        } catch (err) {
          console.warn(`[UsageBackfill] ingest failed for ${rec.id}:`, err.message);
        }
      }
      this._usageTracker.lastBackfillAt = Date.now();
      this._usageTracker.lastBackfillVersion = USAGE_BACKFILL_VERSION;
      this._usageTracker.flush();
      console.log(
        `[UsageBackfill] Scanned ${files} files → ${records.length} sessions ` +
        `(${banked} with new data, ${errors} errors) in ${Date.now() - started}ms`
      );
    } catch (err) {
      console.warn('[UsageBackfill] scan failed:', err.message);
    }
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
    if (this._stallTimer) {
      clearInterval(this._stallTimer);
      this._stallTimer = null;
    }
    if (this._backfillTimer) {
      clearTimeout(this._backfillTimer);
      this._backfillTimer = null;
    }
    try {
      this._usageTracker.flush();
    } catch {
      // ignore
    }
    this._saveHistory();
    console.log('[AgentManager] Stopped all watchers');
  }

  _startPermissionWatcher() {
    this._stopPermissionWatcher();
    try {
      this._configurePermissionRoots();
      permissionBridge.ensureDirs();
      const dirs = permissionBridge.allAgentNotchHomes()
        .map((home) => permissionBridge.pendingDir(home))
        .filter((dir) => {
          try { return fs.existsSync(dir); } catch { return false; }
        });
      if (dirs.length === 0) dirs.push(permissionBridge.pendingDir());
      this._permissionWatcher = chokidar.watch(dirs, {
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
    const stillNew = [];
    for (const p of newly) {
      this._knownPendingIds.add(p.id);
      if (this.settings.alwaysAllowEnabled !== false && this._autoAllowPending(p)) {
        continue;
      }
      stillNew.push(p);
    }

    this._scheduleEmit();

    if (stillNew.length > 0) {
      // Build lightweight session-shaped objects for notifications
      const sessions = this.getSessions().filter((s) => s.remoteApprove && s.status === 'permission-request');
      const attention = sessions.length
        ? sessions.filter((s) => stillNew.some((p) => p.notchSessionId === s.id || s.permissionRequest?.requestId === p.id))
        : stillNew.map((p) => ({
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
      try {
        this._usageTracker.ingest(sessions);
      } catch (err) {
        console.warn('[AgentManager] usage ingest failed:', err.message);
      }
      this.emit('sessions-update', sessions);
    }, 200);
  }

  /**
   * Emit attention (permission/question) and done (finished implementing) once per
   * transition or new attention episode (new permission / question after dismiss).
   */
  _detectStatusTransitions(sessions) {
    const ACTIVE_WORK = new Set(['working', 'permission-request', 'question', 'needs-attention']);
    /** @type {Map<string, string>} */
    const currentEpisodes = new Map();
    const newlyAttention = [];
    const newlyDone = [];
    const seen = new Set();

    for (const session of sessions) {
      seen.add(session.id);
      const prev = this._prevStatus.get(session.id);

      if (isSessionAttention(session)) {
        const key = attentionEpisodeKey(session) || session.status;
        currentEpisodes.set(session.id, key);
        // Interrupt only for unacked queue items; keep episode map when
        // dismissed so "restore" does not re-blast sound/toast.
        if (!session.attentionAcknowledged) {
          const prevKey = this._attentionEpisodes.get(session.id);
          if (prevKey !== key) {
            newlyAttention.push(session);
          }
        }
      }

      // Done implementing: transitioned from active work → idle
      if (session.status === 'idle' && prev && ACTIVE_WORK.has(prev)) {
        newlyDone.push(session);
      }

      // until-idle snooze ends when the session settles to idle
      if (session.status === 'idle' || session.status === 'stopped') {
        const sn = this._snoozes.get(session.id);
        if (sn && sn.untilIdle) this._snoozes.delete(session.id);
      }

      this._prevStatus.set(session.id, session.status);
    }

    // Drop statuses for sessions that disappeared
    for (const id of this._prevStatus.keys()) {
      if (!seen.has(id)) this._prevStatus.delete(id);
    }
    // Drop snoozes for sessions watchers no longer track
    if (this._snoozes.size) {
      for (const id of [...this._snoozes.keys()]) {
        if (!seen.has(id)) this._snoozes.delete(id);
      }
    }
    // Drop attention acks for sessions watchers no longer track
    if (this._attentionAcks.size) {
      for (const id of [...this._attentionAcks.keys()]) {
        if (!seen.has(id)) this._attentionAcks.delete(id);
      }
    }

    this._attentionEpisodes = currentEpisodes;

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
      const previous = this._usageLimits;
      const usage = await collectUsageLimits({
        sessions,
        enabled: this.settings
      });
      this._usageLimits = usage;
      this.emit('usage-update', usage);

      const alerts = detectLimitCrossings(usage, previous, this._limitAlertState, {
        notifyWarn: this.settings.notifyOnLimitWarn === true,
        notifyCrit: this.settings.notifyOnLimitCrit !== false
      });
      if (alerts.length > 0) {
        this.emit('limit-alert', alerts);
      }
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

  /**
   * Dashboard data: token/cost buckets (per day+agent+model, from the
   * tracker) plus session-time aggregates (per day+agent) derived from
   * history and live sessions. Time is attributed to the day a session
   * ended (history) or started (still live); durations are estimates —
   * agents that report no local token data (Grok, Cursor, Antigravity)
   * still contribute session time and counts here.
   *
   * @returns {{ updatedAt: number, buckets: Array<object>, sessionTime: Array<{day:string, agent:string, sessions:number, ms:number}> }}
   */
  getUsageStats() {
    // Live + history session ids own their session-time records; the
    // tracker's backfilled sessionDays skip them to avoid double counting.
    const live = this.getSessions();
    const inHistory = new Set(this._history.map(h => h.id));
    const excludeIds = new Set(inHistory);
    for (const s of live) {
      if (s && s.id) excludeIds.add(s.id);
    }

    const base = this._usageTracker.getStats({ excludeIds });

    const timeMap = new Map(); // `${day}|${agent}` → { day, agent, sessions, ms }
    const addTime = (agent, ts, ms) => {
      if (!agent || !Number.isFinite(ts) || !(ms > 0)) return;
      const day = dayKey(ts);
      const key = `${day}|${agent}`;
      let entry = timeMap.get(key);
      if (!entry) {
        entry = { day, agent, sessions: 0, ms: 0 };
        timeMap.set(key, entry);
      }
      entry.sessions += 1;
      entry.ms += ms;
    };
    for (const h of this._history) {
      addTime(h.agent, h.lastTime || h.archivedAt, sessionActiveMs(h));
    }

    // Live sessions not yet archived count toward today; skip ids already in
    // history so a revived session is not double-counted while it keeps working.
    const now = Date.now();
    for (const s of live) {
      if (!s || s.status === 'stopped' || inHistory.has(s.id)) continue;
      addTime(s.agent, s.startTime || now, sessionActiveMs(s, now, true));
    }

    // Backfilled historical session time (per day+agent, ids already excluded)
    for (const sd of base.sessionDays || []) {
      const key = `${sd.day}|${sd.agent}`;
      let entry = timeMap.get(key);
      if (!entry) {
        entry = { day: sd.day, agent: sd.agent, sessions: 0, ms: 0 };
        timeMap.set(key, entry);
      }
      entry.sessions += sd.sessions;
      entry.ms += sd.ms;
    }

    const sessionTime = [...timeMap.values()]
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    return { updatedAt: base.updatedAt, buckets: base.buckets, sessionTime };
  }

  /**
   * Conversation insights: per-session intent / work-type / complexity /
   * specificity records built from history + live prompted sessions. Live
   * sessions win over their archived snapshot (a revived session keeps
   * accumulating tools and time). Sessions without a real prompt contribute
   * no record. All classification is local heuristics (insights.js).
   *
   * @returns {{ updatedAt: number, records: Array<object> }}
   */
  getInsights() {
    const live = this.getSessions().filter(s => s && s.status !== 'stopped');
    const liveIds = new Set(live.map(s => s.id));
    const merged = [
      ...live,
      ...this._history.filter(h => !liveIds.has(h.id))
    ];
    return buildInsights(merged);
  }

  getSessions() {
    const all = [];
    const seenIds = new Set();
    for (const watcher of Object.values(this.watchers)) {
      for (const session of watcher.getSessions()) {
        seenIds.add(session.id);

        // Dismissed sessions stay hidden until the watcher reports activity
        // newer than the dismiss-time snapshot — then the session returns.
        if (this._dismissed.has(session.id)) {
          const marker = this._dismissed.get(session.id);
          const current = session.lastTime || session.lastActivityAt || 0;
          if (current > marker) {
            this._reviveSession(session.id);
            all.push(session);
          }
          continue;
        }

        if (this._archivedIds.has(session.id)) {
          // Archived sessions are hidden while idle; new work revives them.
          if (session.status === 'idle') continue;
          this._archivedIds.delete(session.id);
        }

        all.push(session);
      }
    }

    // Drop dismiss markers for sessions no watcher tracks anymore
    if (this._dismissed.size) {
      for (const id of [...this._dismissed.keys()]) {
        if (!seenIds.has(id)) this._clearDismissMarker(id);
      }
    }

    // Merge Claude PermissionRequest hook pendings (true remote approve)
    const merged = permissionBridge.mergePendingIntoSessions(all);

    // Annotate snooze + stall + git + attention-ack, then sort (active queue first)
    const now = Date.now();
    const stallAfter = this.settings.stallAfterMs;
    const annotated = merged.map((session) => {
      let s = this._withSnooze(session);
      s = { ...s, stalled: isStalled(s, now, stallAfter) };
      if (s.cwd) {
        const resolved = toWindowsReadablePath(s.cwd, this._wslInfo);
        if (resolved && resolved !== s.cwd) {
          s = { ...s, cwdResolved: resolved };
        }
        const git = readGitContext(resolved || s.cwd);
        if (git) s = { ...s, git };
      }
      return this._withAttentionMeta(s);
    });
    annotated.sort(compareSessionsByAttention);
    annotateAttentionQueue(annotated);
    return annotated;
  }

  _autoAllowPending(pending) {
    try {
      const store = permissionMemory.load(this._permissionMemoryPath);
      const hit = permissionMemory.matches(store, {
        agent: 'claude',
        tool: pending.tool,
        cwd: pending.cwd
      });
      if (!hit) return false;
      const res = permissionBridge.submitDecision(pending.id, 'allow', 'always-allow');
      return Boolean(res && res.success);
    } catch {
      return false;
    }
  }

  rememberAlwaysAllow(sessionId) {
    const session = this.getSessions().find((s) => s.id === sessionId);
    if (!session) return { success: false, message: 'Session not found' };
    const pr = session.permissionRequest;
    if (!pr || !session.remoteApprove) {
      return { success: false, message: 'No remote permission to remember' };
    }
    const entry = permissionMemory.normalizeEntry({
      agent: session.agent,
      tool: pr.tool,
      cwd: session.cwd || pr.filePath
    });
    if (!entry) {
      return { success: false, message: 'Need a tool and project folder to remember' };
    }
    const store = permissionMemory.remember(
      permissionMemory.load(this._permissionMemoryPath),
      entry
    );
    permissionMemory.save(store, this._permissionMemoryPath);
    const allowed = this.approvePermission(sessionId);
    return {
      success: Boolean(allowed && allowed.success),
      remote: Boolean(allowed && allowed.remote),
      remembered: true,
      message: allowed && allowed.success
        ? `Always allow ${pr.tool} in ${entry.project}`
        : (allowed && allowed.message) || 'Remembered — approve failed',
      entry
    };
  }

  getPermissionMemory() {
    const store = permissionMemory.load(this._permissionMemoryPath);
    return {
      count: store.entries.length,
      entries: store.entries
    };
  }

  clearPermissionMemory() {
    permissionMemory.save(permissionMemory.clearAll(), this._permissionMemoryPath);
    return { success: true, message: 'Always-allow list cleared', count: 0 };
  }

  /**
   * Attach attention-ack + episode key for the renderer / queue.
   * Drops stale acks when the episode changes or status leaves attention.
   * @param {object} session
   * @returns {object}
   */
  _withAttentionMeta(session) {
    if (!session || !session.id) return session;

    const key = attentionEpisodeKey(session);
    const ackedKey = this._attentionAcks.get(session.id);

    if (!isSessionAttention(session)) {
      if (ackedKey != null) this._attentionAcks.delete(session.id);
      if (session.attentionAcknowledged || session.attentionEpisodeKey != null) {
        return {
          ...session,
          attentionAcknowledged: false,
          attentionEpisodeKey: null
        };
      }
      return session;
    }

    // Stale ack for a different episode — clear so the queue sees the new need
    if (ackedKey != null && !isAttentionEpisodeAcknowledged(session, ackedKey)) {
      this._attentionAcks.delete(session.id);
    }

    const acknowledged = isAttentionEpisodeAcknowledged(
      session,
      this._attentionAcks.get(session.id)
    );

    if (
      session.attentionAcknowledged === acknowledged &&
      session.attentionEpisodeKey === key
    ) {
      return session;
    }

    return {
      ...session,
      attentionAcknowledged: acknowledged,
      attentionEpisodeKey: key
    };
  }

  /**
   * Attach snooze fields for the renderer / interrupt policy.
   * Does not clone the whole session unless snoozed (cheap path).
   * @param {object} session
   * @returns {object}
   */
  _withSnooze(session) {
    if (!session || !session.id) return session;
    const entry = this._snoozes.get(session.id);
    if (!entry) {
      if (session.snoozed || session.snoozeUntil != null || session.snoozeUntilIdle) {
        return {
          ...session,
          snoozed: false,
          snoozeUntil: null,
          snoozeUntilIdle: false
        };
      }
      return session;
    }

    const now = Date.now();
    if (!isSnoozeActive(entry, { now, status: session.status })) {
      this._snoozes.delete(session.id);
      return {
        ...session,
        snoozed: false,
        snoozeUntil: null,
        snoozeUntilIdle: false
      };
    }

    return {
      ...session,
      snoozed: true,
      snoozeUntil: typeof entry.until === 'number' ? entry.until : null,
      snoozeUntilIdle: Boolean(entry.untilIdle)
    };
  }

  /**
   * Mute sound + desktop toast for a session. Bar status stays truthful.
   * @param {string} sessionId
   * @param {'15m'|'1h'|'until-idle'} preset
   */
  snoozeSession(sessionId, preset) {
    if (!sessionId || typeof sessionId !== 'string') {
      return { success: false, message: 'Invalid session' };
    }
    const entry = createSnoozeEntry(preset);
    if (!entry) {
      return { success: false, message: 'Unknown snooze preset' };
    }

    // Allow snooze even if session briefly missing (race with poll)
    this._snoozes.set(sessionId, entry);
    this._scheduleEmit();

    let message = 'Alerts muted';
    if (entry.untilIdle) {
      message = 'Alerts muted until idle';
    } else if (preset === '15m') {
      message = 'Alerts muted for 15 minutes';
    } else if (preset === '1h') {
      message = 'Alerts muted for 1 hour';
    }

    return { success: true, message, snooze: entry };
  }

  /**
   * Clear session snooze (restore sound/toast per Attention Control).
   * @param {string} sessionId
   */
  clearSnooze(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      return { success: false, message: 'Invalid session' };
    }
    const had = this._snoozes.delete(sessionId);
    if (had) this._scheduleEmit();
    return {
      success: true,
      message: had ? 'Snooze cleared' : 'Not snoozed'
    };
  }

  /**
   * Dismiss this attention episode from the queue without removing the session.
   * Session stays visible; bar/queue stop counting it until a new episode.
   * Distinct from dismissSession (hide/archive) and snooze (mute channels only).
   * @param {string} sessionId
   */
  dismissAttention(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      return { success: false, message: 'Invalid session' };
    }
    const session = this.getSessions().find((s) => s.id === sessionId);
    if (!session) {
      return { success: false, message: 'Session not found' };
    }
    if (!isSessionAttention(session)) {
      return { success: false, message: 'Session is not waiting for you' };
    }
    const key = attentionEpisodeKey(session);
    if (!key) {
      return { success: false, message: 'No attention episode' };
    }
    if (session.attentionAcknowledged) {
      return { success: true, message: 'Already cleared from queue' };
    }
    this._attentionAcks.set(sessionId, key);
    this._scheduleEmit();
    return { success: true, message: 'Cleared from attention queue' };
  }

  /**
   * Restore a dismissed attention episode back into the queue.
   * Does not re-fire sound/toast for the same episode.
   * @param {string} sessionId
   */
  clearAttentionAck(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      return { success: false, message: 'Invalid session' };
    }
    const had = this._attentionAcks.delete(sessionId);
    if (had) this._scheduleEmit();
    return {
      success: true,
      message: had ? 'Back in attention queue' : 'Not dismissed'
    };
  }

  /** @returns {Map<string, { until?: number, untilIdle?: boolean }>} */
  getSnoozes() {
    return this._snoozes;
  }

  /** @returns {Map<string, string>} */
  getAttentionAcks() {
    return this._attentionAcks;
  }

  getSettings() {
    return { ...this.settings };
  }

  /**
   * Upgrade path: older installs only had soundAlerts / desktopNotifications.
   * Seed matrix keys from masters when those keys were never written to disk.
   */
  _migrateAttentionSettings() {
    const store = this._store;
    const has = (key) => {
      try {
        return typeof store.has === 'function' && store.has(key);
      } catch {
        return false;
      }
    };

    let changed = false;
    if (!has('notifyOnPermission')) {
      const n = this.settings.desktopNotifications !== false;
      for (const key of ATTENTION_NOTIFY_KEYS) {
        this.settings[key] = n;
      }
      changed = true;
    }
    if (!has('soundOnPermission')) {
      const s = this.settings.soundAlerts !== false;
      for (const key of ATTENTION_SOUND_KEYS) {
        this.settings[key] = s;
      }
      // soundOnDone stays at default (false) unless already present
      if (!has('soundOnDone')) {
        this.settings.soundOnDone = false;
      }
      changed = true;
    }
    if (changed) {
      this._persistSettings();
    }
  }

  _normalizeNotchSettings() {
    this.settings.autohideDelayMs = clampAutohideDelayMs(this.settings.autohideDelayMs);
    this.settings.notchAlign = normalizeNotchAlign(this.settings.notchAlign);
    if (typeof this.settings.notchDisplayId !== 'number' || !Number.isFinite(this.settings.notchDisplayId)) {
      this.settings.notchDisplayId = 0;
    }
    this.settings.globalHotkey = sanitizeHotkey(this.settings.globalHotkey);
    this.settings.pollInterval = clampPollInterval(this.settings.pollInterval);
    this.settings.focusMode = Boolean(this.settings.focusMode);
    this.settings.mutedAgents = normalizeMutedAgents(this.settings.mutedAgents);

    // Sessions appearance
    const dens = String(this.settings.cardDensity || 'comfortable');
    this.settings.cardDensity = dens === 'compact' ? 'compact' : 'comfortable';
    const groupBy = String(this.settings.sessionGroupBy || 'status');
    this.settings.sessionGroupBy = ['status', 'agent', 'project'].includes(groupBy) ? groupBy : 'status';
    this.settings.showSessionModel = this.settings.showSessionModel !== false;
    this.settings.showSessionCwd = this.settings.showSessionCwd !== false;
    this.settings.showSessionGit = this.settings.showSessionGit !== false;
    this.settings.showSessionActivity = this.settings.showSessionActivity !== false;
    this.settings.autoCollapseFinished = this.settings.autoCollapseFinished !== false;
    this.settings.alwaysAllowEnabled = this.settings.alwaysAllowEnabled !== false;
    this.settings.agentRoots = sanitizeAgentRoots(normalizeAgentRoots(this.settings.agentRoots));
    this.settings.watchWsl = this.settings.watchWsl !== false;
    this.settings.wslDistro = sanitizeWslDistro(this.settings.wslDistro);
    this.settings.stallAfterMs = normalizeStallAfterMs(this.settings.stallAfterMs);

    // Dispatch defaults
    const allowedAgents = new Set(['', 'Claude Code', 'Codex', 'Grok', 'OpenCode']);
    const defAgent = String(this.settings.defaultDispatchAgent || '');
    this.settings.defaultDispatchAgent = allowedAgents.has(defAgent) ? defAgent : '';
    this.settings.defaultProjectCwd = sanitizeConfigurablePath(this.settings.defaultProjectCwd);
  }

  _persistSettings() {
    const toSave = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (this.settings[key] !== undefined) {
        toSave[key] = this.settings[key];
      }
    }
    this._store.set(toSave);
    try {
      fs.chmodSync(path.join(os.homedir(), '.agent-notch', 'settings.json'), 0o600);
    } catch {
      // Windows ACLs / first-write race
    }
  }

  /**
   * Which agent data roots exist on disk (for empty-state / settings UI).
   */
  getAgentDetection() {
    const exists = (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    };
    const resolved = resolveAgentWatchTargets(this.settings, {
      exists,
      wsl: this._probeWslCached()
    });
    const t = resolved.targets;
    const any = (...parts) => parts.filter(Boolean).some(exists);
    return {
      claude: any(t.claude.primary, path.join(t.claude.primary, 'projects'), ...t.claude.extra),
      codex: any(t.codex.primary, path.join(t.codex.primary, 'sessions'), ...t.codex.extra),
      cursor: true,
      antigravity: any(
        t.antigravity.primary,
        path.join(t.antigravity.primary, 'antigravity-ide', 'brain'),
        ...t.antigravity.extra
      ),
      grok: any(t.grok.primary, path.join(t.grok.primary, 'sessions'), ...t.grok.extra),
      opencode: any(t.opencode.primary, ...t.opencode.extra),
      wsl: Boolean(resolved.wslDistro),
      wslDistro: resolved.wslDistro || ''
    };
  }

  updateSettings(newSettings) {
    if (!newSettings || typeof newSettings !== 'object') return;
    const prev = { ...this.settings };
    // Whitelist: only accept known keys from DEFAULT_SETTINGS (prevents __proto__
    // pollution), and only when the value type matches the default (prevents
    // type confusion from a compromised/buggy renderer).
    const safeUpdate = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!Object.prototype.hasOwnProperty.call(newSettings, key)) continue;
      // mutedAgents is an array (typeof 'object') — accept only real arrays
      if (key === 'mutedAgents') {
        if (!Array.isArray(newSettings[key])) continue;
        safeUpdate[key] = normalizeMutedAgents(newSettings[key]);
        continue;
      }
      if (key === 'agentRoots') {
        if (!newSettings[key] || typeof newSettings[key] !== 'object' || Array.isArray(newSettings[key])) continue;
        safeUpdate[key] = normalizeAgentRoots(newSettings[key]);
        continue;
      }
      if (typeof newSettings[key] !== typeof DEFAULT_SETTINGS[key]) continue;
      safeUpdate[key] = newSettings[key];
    }
    Object.assign(this.settings, safeUpdate);

    // Masters gate delivery in attention-policy only — they do not overwrite the
    // matrix, so turning a master back on restores the user's prior event picks.
    // When the matrix is edited, re-derive masters so the top toggles stay honest
    // (any channel on → master on). Explicit master writes always win for that key.
    const matrixTouched = [...ATTENTION_NOTIFY_KEYS, ...ATTENTION_SOUND_KEYS, 'soundOnDone']
      .some((k) => Object.prototype.hasOwnProperty.call(safeUpdate, k));
    if (matrixTouched && !Object.prototype.hasOwnProperty.call(safeUpdate, 'soundAlerts')) {
      this.settings.soundAlerts = Boolean(
        this.settings.soundOnPermission ||
        this.settings.soundOnQuestion ||
        this.settings.soundOnNeedsAttention ||
        this.settings.soundOnDone
      );
    }
    if (matrixTouched && !Object.prototype.hasOwnProperty.call(safeUpdate, 'desktopNotifications')) {
      this.settings.desktopNotifications = Boolean(
        this.settings.notifyOnPermission ||
        this.settings.notifyOnQuestion ||
        this.settings.notifyOnNeedsAttention ||
        this.settings.notifyOnDone
      );
    }

    this._normalizeNotchSettings();
    this._persistSettings();

    const pathKeys = ['agentRoots', 'watchWsl', 'wslDistro'];
    const pathsChanged = pathKeys.some((k) => Object.prototype.hasOwnProperty.call(safeUpdate, k));
    if (pathsChanged) {
      this._wslProbed = false;
      this._createWatchers();
      this._startPermissionWatcher();
    }

    this._applyWatcherEnabled();

    // Apply poll interval to all watchers
    if (newSettings.pollInterval !== undefined) {
      const poll = this.settings.pollInterval || 3000;
      for (const [key, watcher] of Object.entries(this.watchers)) {
        watcher.setPollInterval(key === 'cursor' ? Math.max(poll, 5000) : poll);
      }
    }

    // Notify main process for login-item / side effects (full settings payload)
    this.emit('settings-changed', { ...this.settings, _prev: prev });
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
          if (Number.isFinite(entry.dismissedMarker)) {
            this._dismissed.set(entry.id, entry.dismissedMarker);
          }
          this._ingestHistoryUsage(entry);
        }
      }
    } catch (err) {
      console.error('[AgentManager] Failed to load history:', err.message);
      this._history = [];
    }
  }

  _saveHistory() {
    try {
      // Cap unpinned at 200; never drop pinned
      this._history = trimHistoryEntries(this._history, 200);
      writePrivateFile(this._historyPath, JSON.stringify(this._history, null, 2));
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
    const existingIdx = this._history.findIndex(h => h.id === session.id);
    const previous = existingIdx !== -1 ? this._history[existingIdx] : null;
    const snapshot = buildArchiveSnapshot(session, previous, Date.now());

    // A session archived before (then revived) updates its entry instead of
    // duplicating it — history stays unique per session id.
    if (existingIdx !== -1) {
      this._history[existingIdx] = snapshot;
    } else {
      this._history.push(snapshot);
    }

    this._ingestHistoryUsage(snapshot);
    this._saveHistory();
    this._scheduleEmit();
  }

  /**
   * Bank tokens persisted on a history snapshot so Usage survives after
   * the live watcher (or OpenCode DB) is gone. High-water marks keep this
   * idempotent with live ingest and backfill.
   */
  _ingestHistoryUsage(entry) {
    if (!entry || !entry.id || !entry.agent || !entry.tokens) return;
    try {
      this._usageTracker.ingestHistorical({
        id: entry.id,
        agent: entry.agent,
        days: [{
          day: dayKey(entry.lastTime || entry.archivedAt || Date.now()),
          model: entry.model || null,
          tokens: entry.tokens,
          cost: Number(entry.cost) || 0
        }]
      });
    } catch (err) {
      console.warn('[AgentManager] history usage ingest failed:', err.message);
    }
  }

  getHistory() {
    // Return sorted by most recent first (pins are sorted in the renderer)
    return [...this._history].sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  }

  /**
   * Pin or unpin a history entry. Pins survive restart and are never trimmed.
   * @param {string} historyId
   * @param {boolean} pinned
   */
  pinHistory(historyId, pinned) {
    if (!historyId || typeof historyId !== 'string') {
      return { success: false, message: 'Invalid history id' };
    }
    const idx = this._history.findIndex(h => h.id === historyId);
    if (idx === -1) {
      return { success: false, message: 'History entry not found' };
    }
    this._history[idx] = applyHistoryPin(this._history[idx], Boolean(pinned), Date.now());
    this._saveHistory();
    return {
      success: true,
      message: pinned ? 'Pinned' : 'Unpinned',
      entry: this._history[idx],
      history: this.getHistory()
    };
  }

  /**
   * Continue work from a history entry: live dispatch, headless resume, new
   * session in the same project, or focus the agent app.
   * @param {string} historyId
   * @param {string} [prompt]
   */
  async dispatchFromHistory(historyId, prompt) {
    if (!historyId || typeof historyId !== 'string') {
      return { success: false, message: 'Invalid history id' };
    }
    const text = String(prompt || '').trim() || DEFAULT_CONTINUE_PROMPT;
    if (text.length > 8000) {
      return { success: false, message: 'Dispatch prompt too long (max 8000 chars)' };
    }

    const entry = this._history.find(h => h.id === historyId);
    if (!entry) {
      return { success: false, message: 'History entry not found' };
    }

    const liveIds = new Set(this.getSessions().map(s => s.id));
    let target = resolveHistoryResumeTarget(entry, {
      liveIds,
      isDirectory,
      canResume: true
    });

    if (target.mode === 'live') {
      return this.dispatchTask(target.sessionId, text);
    }

    if (target.mode === 'resume') {
      const sessionLike = {
        id: entry.id,
        agent: entry.agent,
        cwd: entry.cwd,
        resumeId: entry.resumeId || null
      };
      const cmd = planDispatchCommand(buildResumeCommand(sessionLike, text), sessionLike, this._wslInfo);
      if (!canRunDispatch(cmd)) {
        target = resolveHistoryResumeTarget(entry, {
          liveIds,
          isDirectory,
          canResume: false
        });
      } else {
        try {
          await runHeadlessResume(cmd);
          this._scheduleEmit();
          return {
            success: true,
            message: `Continued ${entry.agent} · ${entry.taskName || 'session'}`,
            mode: 'resume'
          };
        } catch (err) {
          return {
            success: false,
            message: err.message || `Failed to resume ${entry.agent}`
          };
        }
      }
    }

    if (target.mode === 'new') {
      const cmd = buildNewSessionCommand(target.agent, text, target.cwd);
      if (!cmd) {
        return { success: false, message: `Cannot start new ${target.agent} sessions from history.` };
      }
      try {
        await runHeadlessResume(cmd);
        this._scheduleEmit();
        return {
          success: true,
          message: `New ${target.agent} session in ${cmd.cwd}`,
          mode: 'new'
        };
      } catch (err) {
        return {
          success: false,
          message: err.message || `Failed to start ${target.agent}`
        };
      }
    }

    // focus
    try {
      const focused = await focusAgentApp(entry.agent, this._focusOpts(entry));
      return {
        success: focused,
        message: focused
          ? (target.message || `Focused ${entry.agent}`)
          : `Could not focus ${entry.agent}. Open it manually.`,
        mode: 'focus'
      };
    } catch (err) {
      return { success: false, message: err.message || 'Focus failed', mode: 'focus' };
    }
  }

  /**
   * Focus an agent app by name (history Jump when no live session id).
   * @param {string} agentName
   */
  async focusAgentByName(agentName) {
    if (!agentName || typeof agentName !== 'string') {
      return { success: false, message: 'Invalid agent' };
    }
    try {
      const focused = await focusAgentApp(agentName);
      return {
        success: focused,
        message: focused
          ? `Focused ${agentName}`
          : `Could not focus ${agentName}. Open it manually.`
      };
    } catch (err) {
      return { success: false, message: err.message || 'Focus failed' };
    }
  }

  clearHistory() {
    this._history = [];
    this._archivedIds.clear();
    this._dismissed.clear();
    this._snoozes.clear();
    this._attentionAcks.clear();
    this._saveHistory();
    return { success: true };
  }

  // ── Dismiss ────────────────────────────────────────

  /**
   * Remove a session from the notch: snapshot it into history and hide it.
   * Idle sessions stay hidden once archived. Stuck / needs-attention sessions
   * stay hidden until the watcher reports NEW activity (new file writes) —
   * then the session returns to the window on its own.
   */
  dismissSession(sessionId) {
    const session = this.getSessions().find(s => s.id === sessionId);
    if (!session) {
      return { success: false, message: 'Session not found' };
    }

    const wasIdle = session.status === 'idle';
    const marker = session.lastTime || session.lastActivityAt || Date.now();
    this._archiveSession(session);

    if (!wasIdle) {
      const m = Number.isFinite(marker) ? marker : Date.now();
      this._dismissed.set(session.id, m);
      const entry = this._history.find(h => h.id === session.id);
      if (entry) {
        entry.dismissedMarker = m;
        this._saveHistory();
      }
    }

    this._scheduleEmit();
    return {
      success: true,
      message: wasIdle
        ? 'Moved to history'
        : 'Session hidden — it returns if activity resumes'
    };
  }

  /** Bring a dismissed session back: clear its marker and archived flag. */
  _reviveSession(id) {
    this._archivedIds.delete(id);
    this._clearDismissMarker(id);
  }

  /** Remove the dismiss marker from the map and the persisted history entry. */
  _clearDismissMarker(id) {
    this._dismissed.delete(id);
    const entry = this._history.find(h => h.id === id);
    if (entry && entry.dismissedMarker !== undefined) {
      delete entry.dismissedMarker;
      this._saveHistory();
    }
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
      this._configurePermissionRoots();
      const local = permissionBridge.installClaudeHook();
      const wsl = this._installWslClaudeHook();
      if (wsl && wsl.success) {
        return {
          ...local,
          wsl: true,
          message: `${local.message} Also installed in WSL (${this._wslInfo.distro}).`
        };
      }
      return local;
    } catch (err) {
      return { success: false, message: err.message || 'Install failed' };
    }
  }

  _installWslClaudeHook() {
    const wsl = this._probeWslCached();
    if (!wsl || process.platform !== 'win32') return null;
    const homeUnc = wslUncPath(wsl.distro, wsl.linuxHome);
    if (!homeUnc) return null;
    const posix = path.posix;
    return permissionBridge.installClaudeHookAt({
      settingsPath: path.join(homeUnc, '.claude', 'settings.json'),
      bridgePath: path.join(homeUnc, '.agent-notch', 'bin', permissionBridge.HOOK_MARKER),
      hookArgPath: posix.join(wsl.linuxHome, '.agent-notch', 'bin', permissionBridge.HOOK_MARKER)
    });
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
    const text = String(answer || '').trim();
    if (!text) {
      return { success: false, message: 'Answer is empty' };
    }

    const session = this.getSessions().find((s) => s.id === sessionId);
    if (!session) {
      return { success: false, message: 'Session not found — it may have already ended.' };
    }

    const cmd = planDispatchCommand(buildResumeCommand(session, text), session, this._wslInfo);
    if (canRunDispatch(cmd)) {
      try {
        await runHeadlessResume(cmd);
        this._scheduleEmit();
        const agentShort = session.agent === 'Claude Code' ? 'Claude' : session.agent;
        const task = String(session.taskName || 'session').replace(/\s+/g, ' ').trim();
        const shortTask = task.length > 36 ? `${task.slice(0, 35)}…` : task;
        return {
          success: true,
          message: `Answered · ${agentShort} · ${shortTask}`,
          remote: true,
          landed: true,
          sessionId: session.id,
          answer: text
        };
      } catch (err) {
        return {
          success: false,
          message: err.message || `Failed to answer ${session.agent}`,
          remote: false,
          answer: text
        };
      }
    }

    const result = await this.jumpToTerminal(sessionId);
    return {
      success: result.success,
      message: result.success
        ? `Opened agent — answer there${text ? ` (suggested: ${text.slice(0, 80)})` : ''}.`
        : result.message,
      focused: result.success,
      remote: false,
      answer: text
    };
  }

  _focusOpts(session) {
    const wsl = this._wslInfo;
    const linux = Boolean(session && isLinuxCwd(session.cwd));
    return {
      linuxCwd: linux,
      wslDistro: linux && wsl ? wsl.distro : ''
    };
  }

  async jumpToTerminal(sessionId) {
    const session = this.getSessions().find(s => s.id === sessionId);
    if (!session) return { success: false, message: 'Session not found' };

    try {
      const focused = await focusAgentApp(session.agent, this._focusOpts(session));
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

    // `new:<Agent>` targets start a brand-new session instead of resuming one
    if (typeof sessionId === 'string' && sessionId.startsWith(NEW_TARGET_PREFIX)) {
      return this._dispatchNewSession(sessionId.slice(NEW_TARGET_PREFIX.length), text);
    }

    const session = this.getSessions().find(s => s.id === sessionId);
    if (!session) {
      return { success: false, message: 'Session not found — it may have already ended.' };
    }

    const cmd = planDispatchCommand(buildResumeCommand(session, text), session, this._wslInfo);
    if (!cmd) {
      return {
        success: false,
        message: `${session.agent} sessions can't receive dispatched messages.`
      };
    }
    if (!canRunDispatch(cmd)) {
      return {
        success: false,
        message: 'Session directory unknown — cannot resume this session yet.'
      };
    }

    try {
      await runHeadlessResume(cmd);
      this._scheduleEmit();
      const agentShort = session.agent === 'Claude Code' ? 'Claude' : session.agent;
      const task = String(session.taskName || 'session').replace(/\s+/g, ' ').trim();
      const shortTask = task.length > 36 ? `${task.slice(0, 35)}…` : task;
      const dir = projectFolderName(session.cwd);
      const where = dir ? ` · ${dir}` : '';
      return {
        success: true,
        message: `Landed in ${agentShort} · ${shortTask}${where}`,
        sessionId: session.id,
        landed: true,
        agent: session.agent,
        cwd: session.cwd || ''
      };
    } catch (err) {
      return {
        success: false,
        message: err.message || `Failed to dispatch to ${session.agent}`
      };
    }
  }

  /**
   * Start a brand-new headless session for an agent, in the directory that
   * agent most recently worked in. The new session shows up in the notch via
   * the watchers, so the chat can be continued from the dispatch bar.
   */
  async _dispatchNewSession(agentName, text) {
    const cmd = buildNewSessionCommand(agentName, text, this._resolveNewSessionCwd(agentName));
    if (!cmd) {
      return { success: false, message: `Cannot start new ${agentName} sessions from the notch.` };
    }

    try {
      await runHeadlessResume(cmd);
      this._scheduleEmit();
      const agentShort = agentName === 'Claude Code' ? 'Claude' : agentName;
      const dir = projectFolderName(cmd.cwd);
      return {
        success: true,
        message: dir
          ? `New ${agentShort} session landed in ${dir}`
          : `New ${agentShort} session started`,
        landed: true,
        agent: agentName,
        cwd: cmd.cwd || ''
      };
    } catch (err) {
      return {
        success: false,
        message: err.message || `Failed to start ${agentName}`
      };
    }
  }

  /**
   * Best-guess working directory for a new session:
   * 1. Settings defaultProjectCwd (if valid)
   * 2. Directory the agent used most recently (live, then history)
   * 3. Any known session directory
   * 4. User home
   */
  _resolveNewSessionCwd(agentName) {
    const preferred = String(this.settings.defaultProjectCwd || '').trim();
    if (preferred && isDirectory(preferred)) return preferred;

    const live = this.getSessions();
    const fromLiveAgent = live.find(s => s.agent === agentName && isDirectory(s.cwd || ''));
    if (fromLiveAgent) return fromLiveAgent.cwd;

    const history = this.getHistory();
    const fromHistoryAgent = history.find(h => h.agent === agentName && isDirectory(h.cwd || ''));
    if (fromHistoryAgent) return fromHistoryAgent.cwd;

    const fromLiveAny = live.find(s => isDirectory(s.cwd || ''));
    if (fromLiveAny) return fromLiveAny.cwd;

    const fromHistoryAny = history.find(h => isDirectory(h.cwd || ''));
    if (fromHistoryAny) return fromHistoryAny.cwd;

    return os.homedir();
  }
}

/**
 * Last successfully focused window per agent (process id + optional title).
 * Prefer this window on the next Jump so multi-instance agents stay sticky.
 * @type {Map<string, { pid: number, title: string, at: number }>}
 */
const lastFocusedByAgent = new Map();

/**
 * Focus an agent application window (best-effort, platform-specific).
 * Remembers the last focused process per agent so Jump is sticky.
 * @param {string} agentName
 * @returns {Promise<boolean>}
 */
function focusAgentApp(agentName, opts = {}) {
  return new Promise((resolve) => {
    const mapping = AGENT_APP_MAP[agentName];
    const platform = process.platform;
    const remembered = lastFocusedByAgent.get(agentName);
    const prefPid = remembered && Number.isFinite(remembered.pid) ? remembered.pid : 0;
    const wslDistro = opts && opts.wslDistro;
    const linuxCwd = Boolean(opts && opts.linuxCwd);

    if (platform === 'win32') {
      const processNames = (mapping && mapping.processNames) || [agentName];
      const namesList = processNames.map(n => n.replace(/'/g, "''")).join("','");
      const agentEsc = agentName.replace(/'/g, "''");
      // Prefer last-focused PID when still alive with a window; else scan process names.
      // Prints "ok:<pid>:<title>" on success so we can remember stickiness.
      const ps = `
        Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -ErrorAction SilentlyContinue;
        function Focus-Proc($p) {
          if (-not $p -or $p.MainWindowHandle -eq 0) { return $false }
          [Native.Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null;
          [Native.Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;
          $title = ($p.MainWindowTitle -replace '[\\r\\n:]',' ').Trim();
          Write-Output ("ok:" + $p.Id + ":" + $title);
          return $true
        }
        $pref = ${prefPid};
        if ($pref -gt 0) {
          $p = Get-Process -Id $pref -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
          if (Focus-Proc $p) { exit 0 }
        }
        $names = @('${namesList}');
        foreach ($n in $names) {
          $p = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
          if (Focus-Proc $p) { exit 0 }
        }
        if ('${agentEsc}' -eq 'Cursor') {
          Start-Process 'Cursor' -ErrorAction SilentlyContinue;
          Write-Output 'ok:0:Cursor';
          exit 0;
        }
        exit 1;
      `.replace(/\n/g, ' ');

      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps
      ], { windowsHide: true });

      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
      child.on('close', (code) => {
        if (code === 0) {
          rememberFocusedFromStdout(agentName, stdout);
          resolve(true);
          return;
        }
        if (linuxCwd && wslDistro) {
          tryFocusWslProfile(wslDistro).then(resolve);
          return;
        }
        resolve(false);
      });
      child.on('error', () => {
        if (linuxCwd && wslDistro) {
          tryFocusWslProfile(wslDistro).then(resolve);
          return;
        }
        resolve(false);
      });
      return;
    }

    if (platform === 'darwin') {
      const appName = (mapping && mapping.mac) || agentName;
      // Prefer re-activating the same app; remember by app name (PID less useful for activate)
      const script = `tell application "${appName.replace(/"/g, '\\"')}" to activate`;
      const child = spawn('osascript', ['-e', script]);
      child.on('close', (code) => {
        if (code === 0) {
          lastFocusedByAgent.set(agentName, { pid: prefPid || 0, title: appName, at: Date.now() });
          resolve(true);
        } else {
          resolve(false);
        }
      });
      child.on('error', () => resolve(false));
      return;
    }

    // Linux best-effort — prefer last window title via wmctrl when available
    if (mapping && mapping.linux) {
      const tryWmctrl = (titleHint) => new Promise((res) => {
        if (!titleHint) return res(false);
        const c = spawn('wmctrl', ['-a', titleHint]);
        c.on('close', (code) => res(code === 0));
        c.on('error', () => res(false));
      });

      (async () => {
        if (remembered && remembered.title) {
          if (await tryWmctrl(remembered.title)) {
            lastFocusedByAgent.set(agentName, { ...remembered, at: Date.now() });
            return resolve(true);
          }
        }
        const child = spawn('wmctrl', ['-a', mapping.linux]);
        child.on('close', (code) => {
          if (code === 0) {
            lastFocusedByAgent.set(agentName, {
              pid: 0,
              title: mapping.linux,
              at: Date.now()
            });
            return resolve(true);
          }
          try {
            spawn(mapping.linux, [], { detached: true, stdio: 'ignore' }).unref();
            lastFocusedByAgent.set(agentName, {
              pid: 0,
              title: mapping.linux,
              at: Date.now()
            });
            resolve(true);
          } catch {
            resolve(false);
          }
        });
        child.on('error', () => {
          try {
            spawn(mapping.linux, [], { detached: true, stdio: 'ignore' }).unref();
            resolve(true);
          } catch {
            resolve(false);
          }
        });
      })();
      return;
    }

    resolve(false);
  });
}

/**
 * Parse PowerShell focus stdout ("ok:<pid>:<title>") into lastFocusedByAgent.
 * @param {string} agentName
 * @param {string} stdout
 */
/**
 * Fallback when Jump cannot find a window: open Windows Terminal's WSL profile
 * (or `wsl.exe -d`) so we do not pretend a Windows `C:\` folder is the project.
 * @param {string} distro
 * @returns {Promise<boolean>}
 */
function tryFocusWslProfile(distro) {
  const name = String(distro || '').trim();
  if (!name) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(ok));
    };
    try {
      const wt = spawn('wt.exe', ['-p', name], { detached: true, stdio: 'ignore' });
      wt.on('error', () => {
        try {
          const wsl = spawn('wsl.exe', ['-d', name], { detached: true, stdio: 'ignore' });
          wsl.on('error', () => done(false));
          wsl.on('spawn', () => {
            try { wsl.unref(); } catch { /* ignore */ }
            done(true);
          });
        } catch {
          done(false);
        }
      });
      wt.on('spawn', () => {
        try { wt.unref(); } catch { /* ignore */ }
        done(true);
      });
    } catch {
      done(false);
    }
  });
}

function rememberFocusedFromStdout(agentName, stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const m = line.match(/^ok:(\d+):(.*)$/);
  if (!m) {
    lastFocusedByAgent.set(agentName, { pid: 0, title: '', at: Date.now() });
    return;
  }
  lastFocusedByAgent.set(agentName, {
    pid: Number(m[1]) || 0,
    title: String(m[2] || '').slice(0, 200),
    at: Date.now()
  });
}

/** @param {string|null|undefined} cwd */
function projectFolderName(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Agents that support headless dispatch: resuming a live session
 * non-interactively (`args`) or starting a brand-new session (`newArgs`).
 * `prefix` is the AgentNotch session-id prefix; the native resume id is the
 * remainder (Codex prefers session.resumeId captured from session_meta).
 */
const DISPATCH_AGENTS = {
  'Claude Code': {
    bin: 'claude',
    prefix: 'claude-',
    args: (id, text) => ['-p', '--resume', id, text],
    newArgs: (text) => ['-p', text]
  },
  'Codex': {
    bin: 'codex',
    prefix: 'codex-',
    args: (id, text) => ['exec', '--skip-git-repo-check', 'resume', id, text],
    newArgs: (text) => ['exec', '--skip-git-repo-check', text]
  },
  'Grok': {
    bin: 'grok',
    prefix: 'grok-',
    args: (id, text) => ['-r', id, '-p', text],
    newArgs: (text) => ['-p', text]
  },
  'OpenCode': {
    bin: 'opencode',
    prefix: 'opencode-',
    args: (id, text) => ['run', '-s', id, text],
    newArgs: (text) => ['run', text]
  }
};

const DISPATCH_AGENT_NAMES = Object.freeze(Object.keys(DISPATCH_AGENTS));

/** Prefix for dispatch targets that mean "start a new session for this agent". */
const NEW_TARGET_PREFIX = 'new:';

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
function nativeIdFromSession(session, spec) {
  if (session.resumeId && NATIVE_ID_RE.test(session.resumeId)) {
    return session.resumeId;
  }
  const prefixName = spec.prefix.replace(/-$/, '');
  const parsed = parseTaggedSessionId(session.id, prefixName);
  let nativeId = parsed.nativeId || session.id.slice(spec.prefix.length);
  if (session.agent === 'Codex') {
    const m = String(nativeId).match(UUID_RE);
    if (m) nativeId = m[0];
  }
  if (!nativeId || !NATIVE_ID_RE.test(nativeId)) return null;
  return nativeId;
}

function buildResumeCommand(session, text) {
  if (!session || typeof session.id !== 'string') return null;
  const spec = DISPATCH_AGENTS[session.agent];
  if (!spec || !session.id.startsWith(spec.prefix)) return null;

  const nativeId = nativeIdFromSession(session, spec);
  if (!nativeId) return null;

  const cwd = typeof session.cwd === 'string' ? session.cwd.trim() : '';
  return { bin: spec.bin, args: spec.args(nativeId, text), cwd };
}

/**
 * Wrap a local resume command in `wsl.exe` when the session lives in WSL.
 * Pure enough for tests — pass probed `{ distro, linuxHome }`.
 *
 * @param {{bin:string, args:string[], cwd:string}|null} cmd
 * @param {object|null|undefined} session
 * @param {{ distro: string, linuxHome?: string }|null} [wslInfo]
 */
function planDispatchCommand(cmd, session, wslInfo) {
  if (!cmd) return null;
  if (process.platform !== 'win32' || !wslInfo || !wslInfo.distro) return cmd;
  if (!isWslBackedSession(session)) return cmd;
  const linuxCwd = toLinuxCwd(session && session.cwd, wslInfo);
  if (!linuxCwd || !linuxCwd.startsWith('/')) return cmd;
  return {
    bin: 'wsl.exe',
    args: ['-d', wslInfo.distro, '--cd', linuxCwd, '--', cmd.bin, ...cmd.args],
    cwd: os.homedir(),
    viaWsl: true,
    wsl: { distro: wslInfo.distro, linuxCwd }
  };
}

function canRunDispatch(cmd) {
  if (!cmd) return false;
  if (cmd.viaWsl) return Boolean(cmd.wsl && cmd.wsl.linuxCwd);
  return Boolean(cmd.cwd && isDirectory(cmd.cwd));
}

/**
 * Build the headless command that starts a brand-new session for an agent.
 * Pure — exported for tests.
 *
 * @param {string} agentName
 * @param {string} text — first prompt of the new session
 * @param {string} cwd  — working directory to start in
 * @returns {{bin:string, args:string[], cwd:string}|null}
 */
function buildNewSessionCommand(agentName, text, cwd) {
  const spec = DISPATCH_AGENTS[agentName];
  if (!spec) return null;
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : os.homedir();
  return { bin: spec.bin, args: spec.newArgs(text), cwd: dir };
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const DISPATCH_LOG_DIR = path.join(os.homedir(), '.agent-notch', 'logs', 'dispatch');
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
  ensurePrivateDir(DISPATCH_LOG_DIR);
  pruneDispatchLogs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeBin = String(bin || 'cli').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  const logPath = path.join(DISPATCH_LOG_DIR, `${stamp}-${safeBin}.log`);
  return { logPath, fd: fs.openSync(logPath, 'a', 0o600) };
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
    const { logPath, fd } = openDispatchLog(cmd.viaWsl ? 'wsl' : cmd.bin);

    let file;
    let args;
    let spawnOpts = { shell: false };
    if (cmd.viaWsl) {
      // Linux CLIs live inside the distro — do not resolve Windows .cmd shims.
      file = 'wsl.exe';
      args = cmd.args;
    } else {
      const planned = planWindowsCliLaunch(resolveCli(cmd.bin), cmd.args);
      file = planned.file;
      args = planned.args;
      spawnOpts = planned.spawnOpts || spawnOpts;
    }

    let child;
    let graceTimer = null;
    try {
      child = spawn(file, args, {
        cwd: cmd.cwd,
        windowsHide: true,
        detached: true,
        stdio: ['ignore', fd, fd],
        shell: false,
        ...spawnOpts
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

module.exports = {
  AgentManager,
  buildResumeCommand,
  buildNewSessionCommand,
  planDispatchCommand,
  canRunDispatch,
  DISPATCH_AGENT_NAMES
};
