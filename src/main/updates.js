'use strict';

/** How often a packaged app asks GitHub whether a newer release exists. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function updateReadyMessage(version) {
  const v = typeof version === 'string' ? version.trim() : '';
  return v
    ? `Version ${v} is ready. It installs when you quit.`
    : 'An update is ready. It installs when you quit.';
}

/**
 * Quiet update check. The panel stays closed. A notification fires only after
 * the installer has downloaded, and the new version is applied on quit.
 *
 * @param {{
 *   autoUpdater: { autoDownload: boolean, autoInstallOnAppQuit: boolean, on: Function, checkForUpdates: Function },
 *   isPackaged: boolean | (() => boolean),
 *   isEnabled: () => boolean,
 *   notify?: (body: string) => void,
 *   log?: (message: string) => void,
 *   schedule?: (fn: Function, ms: number) => any,
 *   clear?: (timer: any) => void
 * }} deps
 */
function createUpdateController(deps) {
  const schedule = deps.schedule || setInterval;
  const clear = deps.clear || clearInterval;
  const packaged = () => (typeof deps.isPackaged === 'function' ? deps.isPackaged() : Boolean(deps.isPackaged));
  /** @type {boolean|undefined} setEnabled wins over the settings read until the next call. */
  let override;
  const enabled = () => (override !== undefined ? override : deps.isEnabled() !== false);
  let timer = null;
  let downloaded = false;
  let bound = false;

  function report(err) {
    if (typeof deps.log !== 'function') return;
    const message = err && err.message ? err.message : String(err || 'update check failed');
    deps.log(message);
  }

  function bind() {
    if (bound) return;
    bound = true;
    deps.autoUpdater.autoDownload = true;
    deps.autoUpdater.autoInstallOnAppQuit = true;
    deps.autoUpdater.on('update-downloaded', (info) => {
      downloaded = true;
      const version = info && (info.version || info.releaseName);
      if (typeof deps.notify === 'function') deps.notify(updateReadyMessage(version));
    });
    deps.autoUpdater.on('error', report);
  }

  function check() {
    if (!packaged() || !enabled() || downloaded) return;
    bind();
    Promise.resolve(deps.autoUpdater.checkForUpdates()).catch(report);
  }

  function stop() {
    if (timer != null) clear(timer);
    timer = null;
  }

  function start() {
    if (!packaged() || !enabled()) return;
    check();
    if (timer != null) return;
    timer = schedule(check, CHECK_INTERVAL_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function setEnabled(on) {
    override = on !== false;
    if (!override) {
      stop();
      deps.autoUpdater.autoInstallOnAppQuit = false;
      return;
    }
    deps.autoUpdater.autoInstallOnAppQuit = true;
    start();
  }

  return { start, stop, setEnabled, check };
}

module.exports = {
  CHECK_INTERVAL_MS,
  createUpdateController,
  updateReadyMessage
};
