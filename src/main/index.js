const { app, BrowserWindow, ipcMain, screen, shell, clipboard, globalShortcut, Notification } = require('electron');
const path = require('path');
const { createTray, updateTrayIcon, updateTrayMenu } = require('./tray');
const { AgentManager, DISPATCH_AGENT_NAMES } = require('./agent-manager');
const { installConsoleCapture, closeLogger } = require('./logger');
const {
  channelsForSessions,
  clampAutohideDelayMs,
  normalizeNotchAlign,
  filterLimitAlertsForDelivery
} = require('./attention-policy');

// Mirror all main-process console.* output to ~/.agent-notch/logs/
installConsoleCapture();

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let agentManager = null;
let isExpanded = false;
let isAutoHidden = false;
let autoHideTimer = null;
let notchAnimationTimer = null;
/** @type {string|null} last successfully registered accelerator */
let registeredHotkey = null;

// Notch dimensions
const NOTCH_WIDTH_COLLAPSED = 420;
const NOTCH_WIDTH_EXPANDED = 600;
const NOTCH_HEIGHT_COLLAPSED = 40;
const NOTCH_HEIGHT_EXPANDED = 560;
const NOTCH_HEIGHT_HIDDEN = 4; // Visible peek strip when auto-hidden
/** Offset from workArea.y so only the peek strip remains (true slide-up hide). */
const NOTCH_HIDDEN_Y_OFFSET = -(NOTCH_HEIGHT_COLLAPSED - NOTCH_HEIGHT_HIDDEN);
const NOTCH_EXPAND_DURATION = 420;   // Smooth ease-out expand (no overshoot bounce)
const NOTCH_COLLAPSE_DURATION = 300; // Smooth deceleration
const NOTCH_SHOW_DURATION = 320;     // Slide-down reveal from hidden strip
const NOTCH_HIDE_DURATION = 340;     // Slide-up into hidden strip
const FRAME_INTERVAL = 8;            // ~120fps for silky smooth animation
const NOTCH_EDGE_MARGIN = 24;

function stopNotchAnimation() {
  if (notchAnimationTimer) {
    clearTimeout(notchAnimationTimer);
    notchAnimationTimer = null;
  }
}

function getSettingsSafe() {
  return agentManager ? agentManager.getSettings() : {};
}

function resolveTargetDisplay(settings) {
  const displays = screen.getAllDisplays();
  const id = settings && settings.notchDisplayId;
  if (id && displays.some((d) => d.id === id)) {
    return displays.find((d) => d.id === id);
  }
  return screen.getPrimaryDisplay();
}

function getNotchX(width, settings) {
  const display = resolveTargetDisplay(settings || getSettingsSafe());
  const { x, width: areaW } = display.workArea;
  const align = normalizeNotchAlign(settings?.notchAlign ?? getSettingsSafe().notchAlign);
  if (align === 'left') return Math.round(x + NOTCH_EDGE_MARGIN);
  if (align === 'right') return Math.round(x + areaW - width - NOTCH_EDGE_MARGIN);
  return Math.round(x + (areaW - width) / 2);
}

/** Visible top of notch (work area top) or tucked peek position. */
function getNotchY(hidden, settings) {
  const display = resolveTargetDisplay(settings || getSettingsSafe());
  const top = display.workArea.y;
  return hidden ? top + NOTCH_HIDDEN_Y_OFFSET : top;
}

/** @deprecated name kept for call sites — display-aware horizontal placement */
function getCenteredX(width) {
  return getNotchX(width, getSettingsSafe());
}

function setNotchBounds(width, height, y) {
  if (!mainWindow) return;
  stopNotchAnimation();
  const settings = getSettingsSafe();
  const resolvedY = typeof y === 'number' ? y : getNotchY(false, settings);
  mainWindow.setBounds({
    x: getNotchX(width, settings),
    y: resolvedY,
    width,
    height
  });
}

function defaultHotkeyAccelerator() {
  return process.platform === 'darwin' ? 'Command+Shift+A' : 'Control+Shift+A';
}

function resolveHotkeyAccelerator(settings) {
  const custom = settings && typeof settings.globalHotkey === 'string'
    ? settings.globalHotkey.trim()
    : '';
  return custom || defaultHotkeyAccelerator();
}

function onGlobalHotkey() {
  if (!mainWindow) return;
  if (isAutoHidden) {
    showNotch();
    expandNotch();
  } else {
    toggleNotch();
  }
  if (mainWindow) mainWindow.focus();
}

/**
 * Register (or re-register) the notch toggle hotkey.
 * @returns {{ ok: boolean, accelerator: string, error?: string }}
 */
function registerNotchHotkey(settings) {
  const accelerator = resolveHotkeyAccelerator(settings || getSettingsSafe());
  try {
    globalShortcut.unregisterAll();
    registeredHotkey = null;
    const ok = globalShortcut.register(accelerator, onGlobalHotkey);
    if (!ok) {
      console.warn('[AgentNotch] Global shortcut already in use:', accelerator);
      // Fall back to default if custom failed
      if (accelerator !== defaultHotkeyAccelerator()) {
        const fallback = defaultHotkeyAccelerator();
        const fbOk = globalShortcut.register(fallback, onGlobalHotkey);
        if (fbOk) {
          registeredHotkey = fallback;
          return { ok: false, accelerator, error: 'Hotkey in use — using default', fallback };
        }
      }
      return { ok: false, accelerator, error: 'Hotkey in use' };
    }
    registeredHotkey = accelerator;
    return { ok: true, accelerator };
  } catch (err) {
    console.warn('[AgentNotch] Could not register global shortcut:', err.message);
    return { ok: false, accelerator, error: err.message };
  }
}

function listDisplaysForSettings() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    primary: d.id === primaryId,
    bounds: d.bounds,
    workArea: d.workArea
  }));
}

/** If preferred display disappeared, fall back to primary and persist. */
function ensureDisplayStillAvailable() {
  if (!agentManager) return;
  const settings = agentManager.getSettings();
  const id = settings.notchDisplayId;
  if (!id) return;
  const exists = screen.getAllDisplays().some((d) => d.id === id);
  if (!exists) {
    agentManager.updateSettings({ notchDisplayId: 0 });
  }
}

/**
 * Smooth deceleration — fast start, gentle landing. No overshoot.
 */
function easeOutQuint(progress) {
  const shifted = progress - 1;
  return 1 + shifted ** 5;
}

/**
 * Exponential ease-out for slide-down show — responsive start, gentle tail.
 */
function easeOutExpo(progress) {
  return progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
}

/**
 * Ease-in for slide-up hide — slow start, accelerates away.
 */
function easeInCubic(progress) {
  return progress ** 3;
}

/**
 * Animate window bounds. Interpolates width, height, and y from current bounds.
 * @param {{ width: number, height: number, y?: number }} target
 */
function animateNotchBounds(target, duration, easing, onComplete) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  stopNotchAnimation();
  const { width: startWidth, height: startHeight, y: startY } = mainWindow.getBounds();
  const targetWidth = target.width;
  const targetHeight = target.height;
  const targetY = typeof target.y === 'number' ? target.y : getNotchY(false);
  const startedAt = Date.now();

  const tick = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      notchAnimationTimer = null;
      return;
    }

    const elapsed = Date.now() - startedAt;
    const progress = Math.min(elapsed / duration, 1);
    const easedProgress = easing(progress);
    const width = Math.round(startWidth + (targetWidth - startWidth) * easedProgress);
    const height = Math.round(startHeight + (targetHeight - startHeight) * easedProgress);
    const y = Math.round(startY + (targetY - startY) * easedProgress);

    mainWindow.setBounds({
      x: getNotchX(width),
      y,
      width,
      height
    });

    if (progress < 1) {
      notchAnimationTimer = setTimeout(tick, FRAME_INTERVAL);
    } else {
      notchAnimationTimer = null;
      if (typeof onComplete === 'function') onComplete();
    }
  };

  tick();
}

function createWindow() {
  const settings = getSettingsSafe();
  const x = getNotchX(NOTCH_WIDTH_COLLAPSED, settings);
  const y = getNotchY(false, settings);

  mainWindow = new BrowserWindow({
    width: NOTCH_WIDTH_COLLAPSED,
    height: NOTCH_HEIGHT_COLLAPSED,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer] [${level}] ${message} (at ${path.basename(sourceId)}:${line})`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Start autohide timer
    scheduleAutoHide();
  });

  mainWindow.on('blur', () => {
    if (isExpanded) {
      collapseNotch();
    }
    // Start autohide when losing focus
    scheduleAutoHide();
  });

  mainWindow.on('focus', () => {
    cancelAutoHide();
  });

  mainWindow.on('closed', () => {
    stopNotchAnimation();
    mainWindow = null;
  });

}

function expandNotch() {
  if (!mainWindow || isExpanded) return;
  isExpanded = true;
  isAutoHidden = false;
  cancelAutoHide();

  mainWindow.webContents.send('notch-state', 'expanded');
  // Smooth ease-out expand — no overshoot bounce (avoids Windows setBounds jitter)
  animateNotchBounds(
    { width: NOTCH_WIDTH_EXPANDED, height: NOTCH_HEIGHT_EXPANDED, y: getNotchY(false) },
    NOTCH_EXPAND_DURATION,
    easeOutQuint
  );
}

function collapseNotch() {
  if (!mainWindow || !isExpanded) return;
  isExpanded = false;

  mainWindow.webContents.send('notch-state', 'collapsed');
  animateNotchBounds(
    { width: NOTCH_WIDTH_COLLAPSED, height: NOTCH_HEIGHT_COLLAPSED, y: getNotchY(false) },
    NOTCH_COLLAPSE_DURATION,
    easeOutQuint
  );

  // Start autohide timer
  scheduleAutoHide();
}

function toggleNotch() {
  if (isAutoHidden) {
    showNotch();
    return;
  }
  if (isExpanded) {
    collapseNotch();
  } else {
    expandNotch();
  }
}

function showNotch() {
  if (!mainWindow) return;
  isAutoHidden = false;
  cancelAutoHide();
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.webContents.send('notch-state', 'collapsed');
  mainWindow.webContents.send('autohide-state', false);
  // Slide down from peek strip into collapsed bar
  animateNotchBounds(
    { width: NOTCH_WIDTH_COLLAPSED, height: NOTCH_HEIGHT_COLLAPSED, y: getNotchY(false) },
    NOTCH_SHOW_DURATION,
    easeOutExpo
  );
}

function hideNotch() {
  if (!mainWindow || isExpanded || isAutoHidden) return;
  isAutoHidden = true;
  mainWindow.webContents.send('notch-state', 'hidden');
  mainWindow.webContents.send('autohide-state', true);
  // Slide up: keep full collapsed height, move y off-screen so only peek strip remains
  animateNotchBounds(
    {
      width: NOTCH_WIDTH_COLLAPSED,
      height: NOTCH_HEIGHT_COLLAPSED,
      y: getNotchY(true)
    },
    NOTCH_HIDE_DURATION,
    easeInCubic,
    () => {
      // Keep interactive so hover-reveal works on the peek strip
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setIgnoreMouseEvents(false);
      }
    }
  );
}

/**
 * Pinned notches never auto-hide — the user asked for a persistent strip.
 */
function isNotchPinned() {
  return agentManager ? Boolean(agentManager.getSettings().notchPinned) : false;
}

/**
 * Arm the idle timer. Visibility is interaction-driven only: agent
 * activity never holds the bar down. The bar tucks away unless the panel
 * is expanded or the user pinned it. Delay comes from settings (default 4s).
 */
function scheduleAutoHide() {
  cancelAutoHide();
  const delay = clampAutohideDelayMs(getSettingsSafe().autohideDelayMs);
  autoHideTimer = setTimeout(() => {
    if (isExpanded || isNotchPinned()) return;
    hideNotch();
  }, delay);
}

function cancelAutoHide() {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
}

function showAndExpand() {
  if (!mainWindow) return;
  if (isAutoHidden) showNotch();
  if (!isExpanded) expandNotch();
  mainWindow.focus();
}

function openSettings() {
  showAndExpand();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-view', 'settings');
  }
}

function applyLoginItemSetting(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath
    });
  } catch (err) {
    console.error('[AgentNotch] Failed to set login item:', err.message);
  }
}

function playAttentionAlert() {
  try {
    shell.beep();
  } catch {
    // ignore
  }
}

function showAttentionNotification(sessions) {
  if (!Notification.isSupported()) return;
  const first = sessions[0];
  if (!first) return;

  const title = first.status === 'permission-request'
    ? `${first.agent} needs permission`
    : first.status === 'question'
      ? `${first.agent} has a question`
      : `${first.agent} needs attention`;

  const n = new Notification({
    title: 'AgentNotch',
    body: `${title}: ${first.taskName || 'Session'}`,
    silent: true // we handle sound separately
  });
  n.on('click', () => {
    showAndExpand();
  });
  n.show();
}

function showDoneNotification(sessions) {
  if (!Notification.isSupported()) return;
  const first = sessions[0];
  if (!first) return;

  const snippet = first.lastMessage
    ? String(first.lastMessage).replace(/\s+/g, ' ').trim().slice(0, 120)
    : (first.taskName || 'Session finished');

  const n = new Notification({
    title: 'AgentNotch',
    body: `${first.agent} done: ${snippet}`,
    silent: true
  });
  n.on('click', () => {
    showAndExpand();
  });
  n.show();
}

// Re-place on display / settings changes (preserve expanded / collapsed / hidden)
function repositionNotch() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  ensureDisplayStillAvailable();
  const settings = getSettingsSafe();
  const width = isExpanded ? NOTCH_WIDTH_EXPANDED : NOTCH_WIDTH_COLLAPSED;
  const height = isExpanded ? NOTCH_HEIGHT_EXPANDED : NOTCH_HEIGHT_COLLAPSED;
  const y = getNotchY(isAutoHidden && !isExpanded, settings);
  stopNotchAnimation();
  mainWindow.setBounds({
    x: getNotchX(width, settings),
    y,
    width,
    height
  });
}

app.whenReady().then(() => {
  createWindow();

  // Initialize agent manager (after window — settings drive placement / hotkey)
  agentManager = new AgentManager();

  tray = createTray({
    onShow: () => {
      if (mainWindow) {
        if (isAutoHidden) showNotch();
        toggleNotch();
        mainWindow.focus();
      }
    },
    onSettings: () => openSettings(),
    onToggleFocus: (enabled) => {
      if (!agentManager) return;
      agentManager.updateSettings({ focusMode: Boolean(enabled) });
    },
    focusMode: agentManager.getSettings().focusMode
  });

  // Apply launch-at-startup + place notch using persisted display/align
  applyLoginItemSetting(agentManager.getSettings().launchAtStartup);
  repositionNotch();

  agentManager.on('sessions-update', (sessions) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sessions-update', sessions);
    }

    // Session activity never reveals or holds the bar — visibility is
    // driven by user interaction (hover/click/hotkey) and by done/attention
    // events below. The idle timer owns hiding.

    // Update tray icon based on session states
    const hasAttention = sessions.some(s =>
      s.status === 'needs-attention' ||
      s.status === 'permission-request' ||
      s.status === 'question'
    );
    const hasWorking = sessions.some(s => s.status === 'working');
    const activeCount = sessions.filter(s => s.status !== 'stopped').length;
    const workingCount = sessions.filter(s => s.status === 'working').length;
    const idleCount = sessions.filter(s => s.status === 'idle').length;

    updateTrayIcon(tray, {
      hasAttention,
      hasWorking,
      activeCount,
      workingCount,
      idleCount,
      focusMode: Boolean(agentManager.getSettings().focusMode)
    });
  });

  agentManager.on('attention', (sessions) => {
    // Never pop the panel open — expanding is a user action (bar click, tray,
    // hotkey, notification click). Policy gates reveal / sound / toast only.
    const settings = agentManager.getSettings();
    const channels = channelsForSessions(settings, sessions);
    if (channels.reveal) {
      if (isAutoHidden) showNotch();
      scheduleAutoHide();
    }
    if (channels.sound) {
      playAttentionAlert();
    }
    if (channels.notify) {
      const unfocused = !mainWindow || !mainWindow.isFocused();
      if (unfocused) {
        showAttentionNotification(sessions);
      }
    }
  });

  agentManager.on('done', (sessions) => {
    // Agent finished — do NOT open the panel. Policy may silence toast/reveal.
    const settings = agentManager.getSettings();
    const channels = channelsForSessions(settings, sessions, 'done');
    if (channels.reveal) {
      if (isAutoHidden) showNotch();
      scheduleAutoHide();
    }
    if (channels.sound) {
      playAttentionAlert();
    }
    if (channels.notify) {
      const unfocused = !mainWindow || !mainWindow.isFocused();
      if (unfocused) {
        showDoneNotification(sessions);
      }
    }
  });

  agentManager.on('usage-update', (usage) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('usage-update', usage);
    }
  });

  agentManager.on('limit-alert', (alerts) => {
    // Soft only — never open the panel. Sound is not used for limits.
    // Focus + per-agent mute silence toast/notify; bar chips stay via usage-update.
    const settings = agentManager.getSettings();
    const list = filterLimitAlertsForDelivery(alerts, settings);
    if (list.length === 0) return;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('limit-alert', list);
    }

    // Master notify gate — toast only; bar truth stays
    if (settings.desktopNotifications === false) return;
    if (!Notification.isSupported()) return;

    for (const a of list) {
      if (!a) continue;
      if (a.band === 'crit' && settings.notifyOnLimitCrit === false) continue;
      if (a.band === 'warn' && settings.notifyOnLimitWarn !== true) continue;
      try {
        const n = new Notification({
          title: `${a.short || a.name} near limit`,
          body: `${a.usedPercent}% used${a.band === 'crit' ? ' — critical' : ''}`,
          silent: true
        });
        n.on('click', () => {
          // User action only — expand to Usage
          showAndExpand();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('open-view', 'usage');
          }
        });
        n.show();
      } catch {
        // ignore notification failures
      }
    }
  });

  agentManager.on('settings-changed', (settings) => {
    const prev = settings._prev || {};
    if (settings.launchAtStartup !== prev.launchAtStartup) {
      applyLoginItemSetting(settings.launchAtStartup);
    }
    if (settings.globalHotkey !== prev.globalHotkey) {
      const result = registerNotchHotkey(settings);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hotkey-register-result', result);
      }
    }
    if (
      settings.notchDisplayId !== prev.notchDisplayId ||
      settings.notchAlign !== prev.notchAlign
    ) {
      repositionNotch();
    }
    if (settings.autohideDelayMs !== prev.autohideDelayMs && !isExpanded && !isNotchPinned()) {
      scheduleAutoHide();
    }
    // Keep tray Focus checkbox + renderer settings in sync
    if (settings.focusMode !== prev.focusMode) {
      updateTrayMenu(tray, { focusMode: Boolean(settings.focusMode) });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings-changed', {
        focusMode: Boolean(settings.focusMode),
        mutedAgents: Array.isArray(settings.mutedAgents) ? settings.mutedAgents : [],
        showLimitOnNotch: settings.showLimitOnNotch !== false
      });
    }
  });

  agentManager.start();

  // Global hotkey to toggle notch (customizable via settings)
  registerNotchHotkey(agentManager.getSettings());

  // IPC Handlers
  ipcMain.handle('get-sessions', () => {
    return agentManager.getSessions();
  });

  ipcMain.handle('get-usage-limits', () => {
    return agentManager.getUsageLimits();
  });

  ipcMain.handle('get-usage-stats', () => {
    return agentManager.getUsageStats();
  });

  ipcMain.handle('get-insights', () => {
    return agentManager.getInsights();
  });

  ipcMain.handle('get-settings', () => {
    return agentManager.getSettings();
  });

  ipcMain.handle('get-agent-detection', () => {
    return agentManager.getAgentDetection();
  });

  ipcMain.handle('set-settings', (_, settings) => {
    agentManager.updateSettings(settings);
    return agentManager.getSettings();
  });

  ipcMain.handle('get-displays', () => {
    return listDisplaysForSettings();
  });

  ipcMain.handle('get-hotkey-info', () => {
    const settings = agentManager.getSettings();
    return {
      accelerator: registeredHotkey || resolveHotkeyAccelerator(settings),
      defaultAccelerator: defaultHotkeyAccelerator(),
      custom: Boolean(settings.globalHotkey && String(settings.globalHotkey).trim())
    };
  });

  // Session-id format validation — ids are prefixed slugs derived from on-disk filenames.
  // Reject anything that could be path-traversal or injection.
  const SESSION_ID_RE = /^[a-z][a-z0-9_-]*-[a-zA-Z0-9._~%-]{1,220}$/;
  function validateSessionId(id) {
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
      throw new Error(`Invalid session id: ${String(id).slice(0, 80)}`);
    }
  }

  ipcMain.handle('approve-permission', async (_, sessionId) => {
    validateSessionId(sessionId);
    return agentManager.approvePermission(sessionId);
  });

  ipcMain.handle('deny-permission', async (_, sessionId) => {
    validateSessionId(sessionId);
    return agentManager.denyPermission(sessionId);
  });

  ipcMain.handle('answer-question', async (_, sessionId, answer) => {
    validateSessionId(sessionId);
    return agentManager.answerQuestion(sessionId, answer);
  });

  ipcMain.handle('jump-to-terminal', async (_, sessionId) => {
    validateSessionId(sessionId);
    return agentManager.jumpToTerminal(sessionId);
  });

  // Open a project folder in the OS file manager (session cwd)
  ipcMain.handle('open-path', async (_, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return { success: false, message: 'No path provided' };
    }
    const p = targetPath.trim().slice(0, 1000);
    try {
      const err = await shell.openPath(p);
      if (err) return { success: false, message: err };
      return { success: true, message: 'Opened folder' };
    } catch (e) {
      return { success: false, message: e.message || 'Could not open path' };
    }
  });

  // Copy text to system clipboard (cwd, etc.)
  ipcMain.handle('copy-text', (_, text) => {
    if (typeof text !== 'string' || !text) {
      return { success: false, message: 'Nothing to copy' };
    }
    try {
      clipboard.writeText(text.slice(0, 8000));
      return { success: true, message: 'Copied' };
    } catch (e) {
      return { success: false, message: e.message || 'Copy failed' };
    }
  });

  ipcMain.handle('dismiss-session', async (_, sessionId) => {
    validateSessionId(sessionId);
    return agentManager.dismissSession(sessionId);
  });

  ipcMain.handle('snooze-session', async (_, sessionId, preset) => {
    validateSessionId(sessionId);
    return agentManager.snoozeSession(sessionId, preset);
  });

  ipcMain.handle('clear-snooze', async (_, sessionId) => {
    validateSessionId(sessionId);
    return agentManager.clearSnooze(sessionId);
  });

  ipcMain.handle('dismiss-attention', async (_, sessionId) => {
    validateSessionId(sessionId);
    return agentManager.dismissAttention(sessionId);
  });

  ipcMain.handle('clear-attention-ack', async (_, sessionId) => {
    validateSessionId(sessionId);
    return agentManager.clearAttentionAck(sessionId);
  });

  ipcMain.handle('install-claude-permission-hook', () => {
    return agentManager.installClaudePermissionHook();
  });

  ipcMain.handle('uninstall-claude-permission-hook', () => {
    return agentManager.uninstallClaudePermissionHook();
  });

  ipcMain.handle('get-claude-permission-hook-status', () => {
    return agentManager.getClaudePermissionHookStatus();
  });

  ipcMain.handle('get-platform', () => {
    return process.platform;
  });

  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // Notch toggle from renderer
  ipcMain.handle('toggle-notch', () => {
    toggleNotch();
    return isExpanded;
  });

  ipcMain.handle('get-notch-state', () => {
    if (isAutoHidden) return 'hidden';
    return isExpanded ? 'expanded' : 'collapsed';
  });

  // Show notch (from autohidden state)
  ipcMain.handle('show-notch', () => {
    showNotch();
    return true;
  });

  // Manual hide from the bar's arrow button — tuck the notch away right now
  ipcMain.handle('hide-notch', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (isExpanded) collapseNotch();
    cancelAutoHide();
    hideNotch();
    return true;
  });

  // Pin toggle from the bar — pinned notches never auto-hide. Pinning while
  // hidden pulls the bar back down and keeps it; unpinning re-arms the idle
  // timer.
  ipcMain.handle('set-notch-pinned', (_, pinned) => {
    agentManager.updateSettings({ notchPinned: Boolean(pinned) });
    const isPinned = Boolean(agentManager.getSettings().notchPinned);
    if (isPinned) {
      cancelAutoHide();
      if (isAutoHidden) showNotch();
    } else if (!isExpanded) {
      scheduleAutoHide();
    }
    return isPinned;
  });

  ipcMain.handle('open-settings', () => {
    openSettings();
    return true;
  });

  ipcMain.on('notch-hover', (_, hovering) => {
    if (hovering) {
      if (isAutoHidden) showNotch();
      cancelAutoHide();
    } else if (!isExpanded) {
      scheduleAutoHide();
    }
  });

  // History
  ipcMain.handle('get-history', () => {
    return agentManager.getHistory();
  });

  ipcMain.handle('clear-history', () => {
    return agentManager.clearHistory();
  });

  ipcMain.handle('pin-history', (_, historyId, pinned) => {
    if (typeof historyId !== 'string' || !historyId) {
      throw new Error('Invalid history id');
    }
    return agentManager.pinHistory(historyId, Boolean(pinned));
  });

  ipcMain.handle('dispatch-from-history', async (_, historyId, prompt) => {
    if (typeof historyId !== 'string' || !historyId) {
      throw new Error('Invalid history id');
    }
    if (prompt != null && typeof prompt !== 'string') {
      throw new Error('Invalid dispatch prompt');
    }
    if (typeof prompt === 'string' && prompt.length > 8000) {
      throw new Error('Dispatch prompt too long (max 8000 chars)');
    }
    return agentManager.dispatchFromHistory(historyId, prompt);
  });

  ipcMain.handle('focus-agent', async (_, agentName) => {
    if (typeof agentName !== 'string' || !agentName.trim()) {
      throw new Error('Invalid agent name');
    }
    return agentManager.focusAgentByName(agentName.trim());
  });

  // Task dispatch — targets a live session (resumes that chat) or starts a
  // new session via `new:<Agent>` targets.
  ipcMain.handle('dispatch-task', async (_, sessionId, prompt) => {
    if (typeof sessionId === 'string' && sessionId.startsWith('new:')) {
      const agentName = sessionId.slice(4);
      if (!DISPATCH_AGENT_NAMES.includes(agentName)) {
        throw new Error(`Invalid dispatch agent: ${agentName.slice(0, 40)}`);
      }
    } else {
      validateSessionId(sessionId);
    }
    if (typeof prompt !== 'string') {
      throw new Error('Invalid dispatch prompt');
    }
    if (prompt.length > 8000) {
      throw new Error('Dispatch prompt too long (max 8000 chars)');
    }
    return agentManager.dispatchTask(sessionId, prompt);
  });

  // Re-place on display geometry / add / remove
  screen.on('display-metrics-changed', () => {
    ensureDisplayStillAvailable();
    repositionNotch();
  });
  screen.on('display-removed', () => {
    ensureDisplayStillAvailable();
    repositionNotch();
  });
  screen.on('display-added', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('displays-changed');
    }
  });
});

app.on('window-all-closed', () => {
  // Keep the app running in the tray
  if (process.platform !== 'darwin') {
    // On Windows/Linux, don't quit
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('before-quit', () => {
  if (agentManager) {
    agentManager.stop();
  }
  closeLogger();
});

// Focus existing window when second instance launched
app.on('second-instance', () => {
  if (mainWindow) {
    if (isAutoHidden) {
      showNotch();
    }
    if (!isExpanded) {
      expandNotch();
    }
    mainWindow.focus();
  }
});
