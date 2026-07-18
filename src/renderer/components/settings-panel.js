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
}

export function openSettingsView(app) {
  if (!app) return;
  app.switchView('settings');
  document.querySelectorAll('.ntab:not(.ntab-icon)').forEach(t => t.classList.remove('active'));
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
