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

  // Focus mode: suppress sound + toast globally; bar truth / reveal stay
  focusMode: false,

  // Per-agent mute: mute sound + toast only for these agent ids
  // ids: 'claude' | 'codex' | 'cursor' | 'antigravity' | 'grok' | 'opencode'
  mutedAgents: [],

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

  // Usage limits glance (rate/credit remaining)
  showLimitOnNotch: true, // crit-only chip on collapsed bar
  notifyOnLimitCrit: true, // soft toast/notify when crossing crit (never auto-opens panel)
  notifyOnLimitWarn: false, // off by default — quieter

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
