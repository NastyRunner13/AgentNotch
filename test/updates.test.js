const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CHECK_INTERVAL_MS,
  createUpdateController,
  updateReadyMessage
} = require('../src/main/updates');
const { DEFAULT_SETTINGS } = require('../src/main/settings/settings-defaults');

function fakeUpdater() {
  const handlers = {};
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    calls: 0,
    handlers,
    on(event, fn) { handlers[event] = fn; },
    checkForUpdates() {
      this.calls += 1;
      return Promise.resolve(null);
    }
  };
}

function controller(overrides = {}) {
  const updater = overrides.autoUpdater || fakeUpdater();
  const scheduled = [];
  const cleared = [];
  const notes = [];
  const logs = [];
  const api = createUpdateController({
    autoUpdater: updater,
    isPackaged: overrides.isPackaged !== undefined ? overrides.isPackaged : true,
    isEnabled: overrides.isEnabled || (() => true),
    notify: (body) => notes.push(body),
    log: (message) => logs.push(message),
    schedule(fn, ms) {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    clear(timer) { cleared.push(timer); }
  });
  return { api, updater, scheduled, cleared, notes, logs };
}

describe('update checks', () => {
  it('defaults the settings flag on', () => {
    assert.equal(DEFAULT_SETTINGS.checkForUpdates, true);
  });

  it('names the version that will install on quit', () => {
    assert.equal(updateReadyMessage('1.3.1'), 'Version 1.3.1 is ready. It installs when you quit.');
    assert.equal(updateReadyMessage(''), 'An update is ready. It installs when you quit.');
  });

  it('does nothing before the app is packaged', () => {
    const { api, updater, scheduled } = controller({ isPackaged: false });
    api.start();
    assert.equal(updater.calls, 0);
    assert.equal(scheduled.length, 0);
  });

  it('does nothing when the setting is off', () => {
    const { api, updater } = controller({ isEnabled: () => false });
    api.start();
    assert.equal(updater.calls, 0);
  });

  it('checks once at start and again on the interval', () => {
    const { api, updater, scheduled } = controller();
    api.start();
    assert.equal(updater.calls, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, CHECK_INTERVAL_MS);
    scheduled[0].fn();
    assert.equal(updater.calls, 2);
    assert.equal(scheduled.length, 1);
  });

  it('notifies only after the installer has downloaded', () => {
    const { api, updater, notes } = controller();
    api.start();
    assert.equal(notes.length, 0);
    updater.handlers['update-downloaded']({ version: '1.4.0' });
    assert.deepEqual(notes, ['Version 1.4.0 is ready. It installs when you quit.']);
    const calls = updater.calls;
    api.check();
    assert.equal(updater.calls, calls);
  });

  it('logs a failed check and does not notify', async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates = () => Promise.reject(new Error('offline'));
    const { api, notes, logs } = controller({ autoUpdater: updater });
    api.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notes.length, 0);
    assert.deepEqual(logs, ['offline']);
  });

  it('turning the setting off cancels the timer and the quit install', () => {
    const { api, updater, cleared } = controller();
    api.start();
    api.setEnabled(false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.deepEqual(cleared, [1]);
    const calls = updater.calls;
    api.check();
    assert.equal(updater.calls, calls);
  });
});
