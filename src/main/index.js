const { app, BrowserWindow, ipcMain, screen, shell, globalShortcut, Notification } = require('electron');
const path = require('path');
const { createTray, updateTrayIcon } = require('./tray');
const { AgentManager } = require('./agent-manager');
const { installConsoleCapture, closeLogger } = require('./logger');

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

// Notch dimensions
const NOTCH_WIDTH_COLLAPSED = 420;
const NOTCH_WIDTH_EXPANDED = 600;
const NOTCH_HEIGHT_COLLAPSED = 40;
const NOTCH_HEIGHT_EXPANDED = 560;
const NOTCH_HEIGHT_HIDDEN = 4; // Visible peek strip when auto-hidden
/** Negative y so only the peek strip remains on-screen (true slide-up hide). */
const NOTCH_HIDDEN_Y = -(NOTCH_HEIGHT_COLLAPSED - NOTCH_HEIGHT_HIDDEN);
const NOTCH_EXPAND_DURATION = 420;   // Smooth ease-out expand (no overshoot bounce)
const NOTCH_COLLAPSE_DURATION = 300; // Smooth deceleration
const NOTCH_SHOW_DURATION = 320;     // Slide-down reveal from hidden strip
const NOTCH_HIDE_DURATION = 340;     // Slide-up into hidden strip
const FRAME_INTERVAL = 8;            // ~120fps for silky smooth animation

function stopNotchAnimation() {
  if (notchAnimationTimer) {
    clearTimeout(notchAnimationTimer);
    notchAnimationTimer = null;
  }
}

function getCenteredX(width) {
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
  return Math.round((screenWidth - width) / 2);
}

function setNotchBounds(width, height, y = 0) {
  if (!mainWindow) return;
  stopNotchAnimation();
  mainWindow.setBounds({
    x: getCenteredX(width),
    y,
    width,
    height
  });
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
  const targetY = target.y ?? 0;
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
      x: getCenteredX(width),
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
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.workAreaSize;
  const x = Math.round((screenWidth - NOTCH_WIDTH_COLLAPSED) / 2);

  mainWindow = new BrowserWindow({
    width: NOTCH_WIDTH_COLLAPSED,
    height: NOTCH_HEIGHT_COLLAPSED,
    x: x,
    y: 0,
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
    { width: NOTCH_WIDTH_EXPANDED, height: NOTCH_HEIGHT_EXPANDED, y: 0 },
    NOTCH_EXPAND_DURATION,
    easeOutQuint
  );
}

function collapseNotch() {
  if (!mainWindow || !isExpanded) return;
  isExpanded = false;

  mainWindow.webContents.send('notch-state', 'collapsed');
  animateNotchBounds(
    { width: NOTCH_WIDTH_COLLAPSED, height: NOTCH_HEIGHT_COLLAPSED, y: 0 },
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
    { width: NOTCH_WIDTH_COLLAPSED, height: NOTCH_HEIGHT_COLLAPSED, y: 0 },
    NOTCH_SHOW_DURATION,
    easeOutExpo
  );
}

function hideNotch() {
  if (!mainWindow || isExpanded) return;
  isAutoHidden = true;
  mainWindow.webContents.send('notch-state', 'hidden');
  mainWindow.webContents.send('autohide-state', true);
  // Slide up: keep full collapsed height, move y off-screen so only peek strip remains
  animateNotchBounds(
    {
      width: NOTCH_WIDTH_COLLAPSED,
      height: NOTCH_HEIGHT_COLLAPSED,
      y: NOTCH_HIDDEN_Y
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
 * True when any live agent session should pin the notch open.
 * Working agents stay visible; idle-only can autohide.
 */
function hasPinnedSessions(sessions) {
  return sessions.some(s =>
    s.status === 'working' ||
    s.status === 'permission-request' ||
    s.status === 'question' ||
    s.status === 'needs-attention'
  );
}

function scheduleAutoHide() {
  cancelAutoHide();
  autoHideTimer = setTimeout(() => {
    // Don't autohide if expanded or if agents are still running / need you
    if (isExpanded) return;
    const sessions = agentManager ? agentManager.getSessions() : [];
    if (hasPinnedSessions(sessions)) return;
    hideNotch();
  }, 4000); // 4 second idle
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

// Re-center on display changes (preserve expanded / collapsed / hidden y)
function repositionNotch() {
  if (!mainWindow) return;
  const width = isExpanded ? NOTCH_WIDTH_EXPANDED : NOTCH_WIDTH_COLLAPSED;
  const y = isAutoHidden && !isExpanded ? NOTCH_HIDDEN_Y : 0;
  mainWindow.setPosition(getCenteredX(width), y, false);
}

app.whenReady().then(() => {
  createWindow();

  tray = createTray({
    onShow: () => {
      if (mainWindow) {
        if (isAutoHidden) showNotch();
        toggleNotch();
        mainWindow.focus();
      }
    },
    onSettings: () => openSettings()
  });

  // Initialize agent manager
  agentManager = new AgentManager();

  // Apply launch-at-startup from persisted settings
  applyLoginItemSetting(agentManager.getSettings().launchAtStartup);

  agentManager.on('sessions-update', (sessions) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sessions-update', sessions);
    }

    // Update tray icon based on session states
    const hasAttention = sessions.some(s =>
      s.status === 'needs-attention' ||
      s.status === 'permission-request' ||
      s.status === 'question'
    );
    const hasWorking = sessions.some(s => s.status === 'working');
    const pinned = hasPinnedSessions(sessions);
    const activeCount = sessions.filter(s => s.status !== 'stopped').length;
    const workingCount = sessions.filter(s => s.status === 'working').length;
    const idleCount = sessions.filter(s => s.status === 'idle').length;

    updateTrayIcon(tray, {
      hasAttention,
      hasWorking,
      activeCount,
      workingCount,
      idleCount
    });

    // While any agent is working or needs attention: stay visible and cancel autohide.
    // When everything is idle: allow autohide again (collapsed only).
    if (pinned) {
      if (isAutoHidden) showNotch();
      cancelAutoHide();
    } else if (!isExpanded && !isAutoHidden) {
      scheduleAutoHide();
    }
  });

  agentManager.on('attention', (sessions) => {
    // Always pop the notch open so the user can approve / answer
    showAndExpand();
    const settings = agentManager.getSettings();
    if (settings.soundAlerts) {
      playAttentionAlert();
    }
    if (settings.desktopNotifications !== false) {
      const unfocused = !mainWindow || !mainWindow.isFocused();
      if (unfocused) {
        showAttentionNotification(sessions);
      }
    }
  });

  agentManager.on('done', (sessions) => {
    // Agent finished implementing — surface the notch with the result
    showAndExpand();
    const settings = agentManager.getSettings();
    if (settings.desktopNotifications !== false) {
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

  agentManager.on('settings-changed', (settings) => {
    if (settings.launchAtStartup !== undefined) {
      applyLoginItemSetting(settings.launchAtStartup);
    }
  });

  agentManager.start();

  // Global hotkey to toggle notch
  try {
    const accelerator = process.platform === 'darwin' ? 'Command+Shift+A' : 'Control+Shift+A';
    globalShortcut.register(accelerator, () => {
      if (!mainWindow) return;
      if (isAutoHidden) {
        showNotch();
        expandNotch();
      } else {
        toggleNotch();
      }
      if (mainWindow) mainWindow.focus();
    });
  } catch (err) {
    console.warn('[AgentNotch] Could not register global shortcut:', err.message);
  }

  // IPC Handlers
  ipcMain.handle('get-sessions', () => {
    return agentManager.getSessions();
  });

  ipcMain.handle('get-usage-limits', () => {
    return agentManager.getUsageLimits();
  });

  ipcMain.handle('get-settings', () => {
    return agentManager.getSettings();
  });

  ipcMain.handle('get-agent-detection', () => {
    return agentManager.getAgentDetection();
  });

  ipcMain.handle('set-settings', (_, settings) => {
    agentManager.updateSettings(settings);
    return true;
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

  // Task dispatch
  ipcMain.handle('dispatch-task', async (_, agent, prompt) => {
    return agentManager.dispatchTask(agent, prompt);
  });

  // Re-center on display geometry change
  screen.on('display-metrics-changed', repositionNotch);
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
