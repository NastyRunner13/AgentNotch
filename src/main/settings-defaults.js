/**
 * Canonical app settings defaults.
 * store.js and AgentManager both use this so whitelist + electron-store stay in sync.
 */

const DEFAULT_SETTINGS = {
  enableClaude: true,
  enableCodex: true,
  enableCursor: true,
  enableAntigravity: true,
  enableGrok: true,
  enableOpencode: true,

  // Master switches (Settings UI top-level)
  soundAlerts: true,
  desktopNotifications: true,
  launchAtStartup: false,

  // Attention matrix — event × channel (masters gate delivery; see attention-policy.js)
  notifyOnPermission: true,
  notifyOnQuestion: true,
  notifyOnNeedsAttention: true,
  notifyOnDone: true,
  soundOnPermission: true,
  soundOnQuestion: true,
  soundOnNeedsAttention: true,
  soundOnDone: false,

  // Collapsed bar slide-down (never expands the panel)
  revealOnAttention: true,
  revealOnDone: true,

  // Notch behavior
  notchPinned: false,
  autohideDelayMs: 4000,
  notchDisplayId: 0, // 0 = primary display
  notchAlign: 'center', // 'left' | 'center' | 'right'
  globalHotkey: '', // empty = platform default Control/Command+Shift+A

  pollInterval: 3000
};

/** Keys seeded from masters when missing from an upgraded settings file. */
const ATTENTION_NOTIFY_KEYS = [
  'notifyOnPermission',
  'notifyOnQuestion',
  'notifyOnNeedsAttention',
  'notifyOnDone'
];

const ATTENTION_SOUND_KEYS = [
  'soundOnPermission',
  'soundOnQuestion',
  'soundOnNeedsAttention'
  // soundOnDone intentionally excluded from master bulk-on (default stays false)
];

module.exports = {
  DEFAULT_SETTINGS,
  ATTENTION_NOTIFY_KEYS,
  ATTENTION_SOUND_KEYS
};
