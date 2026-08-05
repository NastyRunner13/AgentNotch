const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script — exposes safe APIs to the renderer via contextBridge.
 * The renderer cannot access Node.js or Electron APIs directly.
 */
contextBridge.exposeInMainWorld('agentNotch', {
  // Sessions
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  onSessionsUpdate: (callback) => {
    const handler = (_, sessions) => callback(sessions);
    ipcRenderer.on('sessions-update', handler);
    return () => ipcRenderer.removeListener('sessions-update', handler);
  },

  // Usage limits (local rate/credit snapshots)
  getUsageLimits: () => ipcRenderer.invoke('get-usage-limits'),
  onUsageUpdate: (callback) => {
    const handler = (_, usage) => callback(usage);
    ipcRenderer.on('usage-update', handler);
    return () => ipcRenderer.removeListener('usage-update', handler);
  },
  onLimitAlert: (callback) => {
    const handler = (_, alerts) => callback(alerts);
    ipcRenderer.on('limit-alert', handler);
    return () => ipcRenderer.removeListener('limit-alert', handler);
  },

  // Usage dashboard (token/cost buckets + session-time aggregates)
  getUsageStats: () => ipcRenderer.invoke('get-usage-stats'),

  // Conversation insights (intent / work type / complexity / specificity)
  getInsights: () => ipcRenderer.invoke('get-insights'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('set-settings', settings),
  getAgentDetection: () => ipcRenderer.invoke('get-agent-detection'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  getHotkeyInfo: () => ipcRenderer.invoke('get-hotkey-info'),
  onHotkeyRegisterResult: (callback) => {
    const handler = (_, result) => callback(result);
    ipcRenderer.on('hotkey-register-result', handler);
    return () => ipcRenderer.removeListener('hotkey-register-result', handler);
  },
  onDisplaysChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('displays-changed', handler);
    return () => ipcRenderer.removeListener('displays-changed', handler);
  },
  /** Partial settings push from main (focus mode, muted agents, etc.) */
  onSettingsChanged: (callback) => {
    const handler = (_, settings) => callback(settings);
    ipcRenderer.on('settings-changed', handler);
    return () => ipcRenderer.removeListener('settings-changed', handler);
  },

  // Actions
  approvePermission: (sessionId) => ipcRenderer.invoke('approve-permission', sessionId),
  denyPermission: (sessionId) => ipcRenderer.invoke('deny-permission', sessionId),
  answerQuestion: (sessionId, answer) => ipcRenderer.invoke('answer-question', sessionId, answer),
  jumpToTerminal: (sessionId) => ipcRenderer.invoke('jump-to-terminal', sessionId),
  /** Open a folder path in the OS file manager */
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  /** Copy text to the system clipboard */
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  dismissSession: (sessionId) => ipcRenderer.invoke('dismiss-session', sessionId),
  /** Mute sound + toast for a session: preset '15m' | '1h' | 'until-idle' */
  snoozeSession: (sessionId, preset) => ipcRenderer.invoke('snooze-session', sessionId, preset),
  clearSnooze: (sessionId) => ipcRenderer.invoke('clear-snooze', sessionId),
  /** Clear this attention episode from the queue (session stays) */
  dismissAttention: (sessionId) => ipcRenderer.invoke('dismiss-attention', sessionId),
  /** Put a dismissed attention episode back in the queue */
  clearAttentionAck: (sessionId) => ipcRenderer.invoke('clear-attention-ack', sessionId),

  // Claude remote approve (PermissionRequest hook)
  installClaudePermissionHook: () => ipcRenderer.invoke('install-claude-permission-hook'),
  uninstallClaudePermissionHook: () => ipcRenderer.invoke('uninstall-claude-permission-hook'),
  getClaudePermissionHookStatus: () => ipcRenderer.invoke('get-claude-permission-hook-status'),

  // Platform / app info
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Notch control
  toggleNotch: () => ipcRenderer.invoke('toggle-notch'),
  showNotch: () => ipcRenderer.invoke('show-notch'),
  hideNotch: () => ipcRenderer.invoke('hide-notch'),
  setNotchPinned: (pinned) => ipcRenderer.invoke('set-notch-pinned', Boolean(pinned)),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  getNotchState: () => ipcRenderer.invoke('get-notch-state'),
  onNotchState: (callback) => {
    const handler = (_, state) => callback(state);
    ipcRenderer.on('notch-state', handler);
    return () => ipcRenderer.removeListener('notch-state', handler);
  },
  onAutoHideState: (callback) => {
    const handler = (_, hidden) => callback(hidden);
    ipcRenderer.on('autohide-state', handler);
    return () => ipcRenderer.removeListener('autohide-state', handler);
  },
  onOpenView: (callback) => {
    const handler = (_, view) => callback(view);
    ipcRenderer.on('open-view', handler);
    return () => ipcRenderer.removeListener('open-view', handler);
  },
  setHovering: (hovering) => ipcRenderer.send('notch-hover', Boolean(hovering)),

  // History
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  pinHistory: (historyId, pinned) => ipcRenderer.invoke('pin-history', historyId, Boolean(pinned)),
  dispatchFromHistory: (historyId, prompt) =>
    ipcRenderer.invoke('dispatch-from-history', historyId, prompt),
  focusAgent: (agentName) => ipcRenderer.invoke('focus-agent', agentName),

  // Task dispatch — sends a message into a live session (continues that chat)
  dispatchTask: (sessionId, prompt) => ipcRenderer.invoke('dispatch-task', sessionId, prompt)
});
