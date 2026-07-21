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

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('set-settings', settings),
  getAgentDetection: () => ipcRenderer.invoke('get-agent-detection'),

  // Actions
  approvePermission: (sessionId) => ipcRenderer.invoke('approve-permission', sessionId),
  denyPermission: (sessionId) => ipcRenderer.invoke('deny-permission', sessionId),
  answerQuestion: (sessionId, answer) => ipcRenderer.invoke('answer-question', sessionId, answer),
  jumpToTerminal: (sessionId) => ipcRenderer.invoke('jump-to-terminal', sessionId),

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

  // Task dispatch — sends a message into a live session (continues that chat)
  dispatchTask: (sessionId, prompt) => ipcRenderer.invoke('dispatch-task', sessionId, prompt)
});
