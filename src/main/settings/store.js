const path = require('path');
const os = require('os');
const { DEFAULT_SETTINGS } = require('./settings-defaults');

/**
 * Thin wrapper around electron-store for app settings.
 * History stays in a separate JSON file (can grow large).
 */
function createSettingsStore() {
  // electron-store v10 is ESM-first; CJS require exposes { default: ElectronStore }
  const StoreModule = require('electron-store');
  const ElectronStore = StoreModule.default || StoreModule;

  return new ElectronStore({
    name: 'settings',
    cwd: path.join(os.homedir(), '.agent-notch'),
    defaults: { ...DEFAULT_SETTINGS }
  });
}

module.exports = { createSettingsStore };
