/**
 * Settings panel initialization.
 * Binds toggle switches to app settings via IPC.
 */

export function initSettings(app) {
  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettingsView(app);
    });
  }

  // Load settings and apply to checkboxes
  if (window.agentNotch) {
    window.agentNotch.getSettings().then(settings => {
      applySettings(settings);
    });

    window.agentNotch.getAppVersion().then(version => {
      const el = document.querySelector('.settings-version');
      if (el && version) {
        el.textContent = `AgentNotch v${version}`;
      }
    }).catch(() => {});

    refreshClaudeHookStatus();
  }

  // Bind change events
  const toggles = {
    'set-claude': 'enableClaude',
    'set-codex': 'enableCodex',
    'set-cursor': 'enableCursor',
    'set-antigravity': 'enableAntigravity',
    'set-grok': 'enableGrok',
    'set-sound': 'soundAlerts',
    'set-notifications': 'desktopNotifications',
    'set-startup': 'launchAtStartup'
  };

  for (const [elId, settingKey] of Object.entries(toggles)) {
    const el = document.getElementById(elId);
    if (el) {
      el.addEventListener('change', () => {
        const update = { [settingKey]: el.checked };
        if (window.agentNotch) {
          window.agentNotch.setSettings(update);
        }
      });
    }
  }

  const installBtn = document.getElementById('btn-install-claude-hook');
  if (installBtn) {
    installBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.agentNotch?.installClaudePermissionHook) return;
      installBtn.disabled = true;
      try {
        const res = await window.agentNotch.installClaudePermissionHook();
        await refreshClaudeHookStatus();
        if (app?.showToast) {
          app.showToast(res?.message || (res?.success ? 'Hook installed' : 'Install failed'), res?.success ? 'ok' : 'error');
        }
      } catch (err) {
        if (app?.showToast) app.showToast(err.message || 'Install failed', 'error');
      } finally {
        installBtn.disabled = false;
      }
    });
  }

  const uninstallBtn = document.getElementById('btn-uninstall-claude-hook');
  if (uninstallBtn) {
    uninstallBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.agentNotch?.uninstallClaudePermissionHook) return;
      uninstallBtn.disabled = true;
      try {
        const res = await window.agentNotch.uninstallClaudePermissionHook();
        await refreshClaudeHookStatus();
        if (app?.showToast) {
          app.showToast(res?.message || 'Hook removed', res?.success ? 'ok' : 'error');
        }
      } catch (err) {
        if (app?.showToast) app.showToast(err.message || 'Remove failed', 'error');
      } finally {
        uninstallBtn.disabled = false;
      }
    });
  }
}

export function openSettingsView(app) {
  if (!app) return;
  app.switchView('settings');
  document.querySelectorAll('.ntab:not(.ntab-icon)').forEach(t => t.classList.remove('active'));
  refreshClaudeHookStatus();
}

function applySettings(settings) {
  if (!settings) return;

  const mappings = {
    'set-claude': 'enableClaude',
    'set-codex': 'enableCodex',
    'set-cursor': 'enableCursor',
    'set-antigravity': 'enableAntigravity',
    'set-grok': 'enableGrok',
    'set-sound': 'soundAlerts',
    'set-notifications': 'desktopNotifications',
    'set-startup': 'launchAtStartup'
  };

  for (const [elId, key] of Object.entries(mappings)) {
    const el = document.getElementById(elId);
    if (el && settings[key] !== undefined) {
      el.checked = settings[key];
    }
  }
}

async function refreshClaudeHookStatus() {
  const statusEl = document.getElementById('claude-hook-status');
  const detailEl = document.getElementById('claude-hook-detail');
  const installBtn = document.getElementById('btn-install-claude-hook');
  const uninstallBtn = document.getElementById('btn-uninstall-claude-hook');
  if (!statusEl || !window.agentNotch?.getClaudePermissionHookStatus) return;

  try {
    const status = await window.agentNotch.getClaudePermissionHookStatus();
    if (status.installed) {
      statusEl.textContent = 'Hook installed';
      statusEl.dataset.state = 'ok';
      if (installBtn) installBtn.textContent = 'Reinstall hook';
      if (uninstallBtn) uninstallBtn.hidden = false;
    } else {
      statusEl.textContent = 'Hook not installed';
      statusEl.dataset.state = 'off';
      if (installBtn) installBtn.textContent = 'Install hook';
      if (uninstallBtn) uninstallBtn.hidden = true;
    }
    if (detailEl) {
      const parts = [];
      if (status.bridgeExists) parts.push('Bridge ready');
      if (status.pendingCount > 0) parts.push(`${status.pendingCount} pending`);
      if (status.settingsPath) parts.push(status.settingsPath);
      detailEl.textContent = parts.join(' · ');
    }
  } catch {
    statusEl.textContent = 'Could not read hook status';
    statusEl.dataset.state = 'off';
  }
}
