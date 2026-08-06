/**
 * Settings panel initialization.
 * Binds toggles, attention matrix, notch placement, and hotkey capture via IPC.
 */

const MASTER_TOGGLES = {
  'set-claude': 'enableClaude',
  'set-codex': 'enableCodex',
  'set-cursor': 'enableCursor',
  'set-antigravity': 'enableAntigravity',
  'set-grok': 'enableGrok',
  'set-opencode': 'enableOpencode',
  'set-focus': 'focusMode',
  'set-sound': 'soundAlerts',
  'set-notifications': 'desktopNotifications',
  'set-startup': 'launchAtStartup',
  'set-limit-notch': 'showLimitOnNotch',
  'set-limit-notify-crit': 'notifyOnLimitCrit',
  'set-show-model': 'showSessionModel',
  'set-show-cwd': 'showSessionCwd',
  'set-show-activity': 'showSessionActivity',
  'set-auto-collapse': 'autoCollapseFinished'
};

/** Element id → mute agent id (settings.mutedAgents) */
const MUTE_TOGGLES = {
  'mute-claude': 'claude',
  'mute-codex': 'codex',
  'mute-cursor': 'cursor',
  'mute-antigravity': 'antigravity',
  'mute-grok': 'grok',
  'mute-opencode': 'opencode'
};

const MATRIX_TOGGLES = {
  'set-notify-permission': 'notifyOnPermission',
  'set-notify-question': 'notifyOnQuestion',
  'set-notify-needs': 'notifyOnNeedsAttention',
  'set-notify-done': 'notifyOnDone',
  'set-sound-permission': 'soundOnPermission',
  'set-sound-question': 'soundOnQuestion',
  'set-sound-needs': 'soundOnNeedsAttention',
  'set-sound-done': 'soundOnDone'
};

const AUTOHIDE_PRESETS = [2000, 4000, 8000, 15000];

/** @type {boolean} */
let capturingHotkey = false;
/** @type {(e: KeyboardEvent) => void | null} */
let hotkeyKeyHandler = null;

export function initSettings(app) {
  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettingsView(app);
    });
  }

  if (window.agentNotch) {
    window.agentNotch.getSettings().then((settings) => {
      applySettings(settings);
    });

    window.agentNotch.getAppVersion().then((version) => {
      const el = document.querySelector('.settings-version');
      if (el && version) {
        el.textContent = `AgentNotch v${version}`;
      }
    }).catch(() => {});

    refreshClaudeHookStatus();
    refreshDisplays();
    refreshHotkeyInfo();

    if (window.agentNotch.onDisplaysChanged) {
      window.agentNotch.onDisplaysChanged(() => refreshDisplays());
    }
    if (window.agentNotch.onHotkeyRegisterResult) {
      window.agentNotch.onHotkeyRegisterResult((result) => {
        if (!result) return;
        refreshHotkeyInfo();
        if (app?.showToast && result.ok === false) {
          app.showToast(result.error || 'Hotkey not available', 'error');
        } else if (app?.showToast && result.ok) {
          app.showToast(`Hotkey: ${formatAccelerator(result.accelerator)}`, 'ok');
        }
      });
    }
  }

  // Agent + master preference toggles
  for (const [elId, settingKey] of Object.entries(MASTER_TOGGLES)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    el.addEventListener('change', () => {
      persistSettings({ [settingKey]: el.checked }, app);
    });
  }

  // Per-agent mute (sound/toast only)
  for (const [elId, agentId] of Object.entries(MUTE_TOGGLES)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    el.addEventListener('change', async () => {
      const current = await window.agentNotch.getSettings().catch(() => null);
      const list = Array.isArray(current?.mutedAgents) ? [...current.mutedAgents] : [];
      const next = new Set(list);
      if (el.checked) next.add(agentId);
      else next.delete(agentId);
      persistSettings({ mutedAgents: [...next] }, app);
    });
  }

  // Attention matrix
  for (const [elId, settingKey] of Object.entries(MATRIX_TOGGLES)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    el.addEventListener('change', () => {
      persistSettings({ [settingKey]: el.checked }, app);
    });
  }

  // Tray / main can flip focus mode — keep Settings + bar chip in sync
  if (window.agentNotch?.onSettingsChanged) {
    window.agentNotch.onSettingsChanged((partial) => {
      if (!partial) return;
      if (partial.focusMode !== undefined) {
        const el = document.getElementById('set-focus');
        if (el) el.checked = Boolean(partial.focusMode);
      }
      if (Array.isArray(partial.mutedAgents)) {
        applyMutedAgents(partial.mutedAgents);
        if (app) app.mutedAgents = [...partial.mutedAgents];
      }
      if (app) {
        if (partial.focusMode !== undefined) {
          app.focusMode = Boolean(partial.focusMode);
          if (typeof app.renderFocusChip === 'function') app.renderFocusChip();
        }
        if (partial.showLimitOnNotch !== undefined) {
          app.showLimitOnNotch = partial.showLimitOnNotch !== false;
          if (typeof app.renderNotchLimitChip === 'function') app.renderNotchLimitChip();
        }
      }
    });
  }

  // Notch controls
  const displayEl = document.getElementById('set-display');
  if (displayEl) {
    displayEl.addEventListener('change', () => {
      const id = Number(displayEl.value);
      persistSettings({ notchDisplayId: Number.isFinite(id) ? id : 0 }, app);
    });
  }

  const alignEl = document.getElementById('set-align');
  if (alignEl) {
    alignEl.addEventListener('change', () => {
      persistSettings({ notchAlign: alignEl.value }, app);
    });
  }

  const autohideEl = document.getElementById('set-autohide');
  if (autohideEl) {
    autohideEl.addEventListener('change', () => {
      const ms = Number(autohideEl.value);
      persistSettings({ autohideDelayMs: Number.isFinite(ms) ? ms : 4000 }, app);
    });
  }

  // Sessions appearance
  const densityEl = document.getElementById('set-card-density');
  if (densityEl) {
    densityEl.addEventListener('change', () => {
      const v = densityEl.value === 'compact' ? 'compact' : 'comfortable';
      persistSettings({ cardDensity: v }, app).then(() => {
        if (app && typeof app.applySessionAppearance === 'function') {
          app.applySessionAppearance({ cardDensity: v });
        }
      });
    });
  }

  const groupEl = document.getElementById('set-session-group');
  if (groupEl) {
    groupEl.addEventListener('change', () => {
      const v = ['status', 'agent', 'project'].includes(groupEl.value) ? groupEl.value : 'status';
      persistSettings({ sessionGroupBy: v }, app).then(() => {
        if (app && typeof app.applySessionAppearance === 'function') {
          app.applySessionAppearance({ sessionGroupBy: v });
        }
      });
    });
  }

  // Dispatch defaults
  const defAgentEl = document.getElementById('set-default-dispatch-agent');
  if (defAgentEl) {
    defAgentEl.addEventListener('change', () => {
      persistSettings({ defaultDispatchAgent: defAgentEl.value || '' }, app).then(() => {
        if (app && typeof app.applyDispatchDefaults === 'function') {
          app.applyDispatchDefaults({ defaultDispatchAgent: defAgentEl.value || '' });
        }
      });
    });
  }

  const defCwdEl = document.getElementById('set-default-project-cwd');
  if (defCwdEl) {
    let cwdTimer = null;
    const saveCwd = () => {
      const v = String(defCwdEl.value || '').trim();
      persistSettings({ defaultProjectCwd: v }, app).then(() => {
        if (app && typeof app.applyDispatchDefaults === 'function') {
          app.applyDispatchDefaults({ defaultProjectCwd: v });
        }
      });
    };
    defCwdEl.addEventListener('change', saveCwd);
    defCwdEl.addEventListener('blur', saveCwd);
    defCwdEl.addEventListener('input', () => {
      clearTimeout(cwdTimer);
      cwdTimer = setTimeout(saveCwd, 600);
    });
  }

  const captureBtn = document.getElementById('btn-hotkey-capture');
  if (captureBtn) {
    captureBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startHotkeyCapture(app);
    });
  }

  const resetBtn = document.getElementById('btn-hotkey-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      stopHotkeyCapture();
      persistSettings({ globalHotkey: '' }, app).then(() => refreshHotkeyInfo());
      if (app?.showToast) app.showToast('Hotkey reset to default', 'ok');
    });
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
  document.querySelectorAll('.ntab:not(.ntab-icon)').forEach((t) => t.classList.remove('active'));
  refreshClaudeHookStatus();
  refreshDisplays();
  refreshHotkeyInfo();
  if (window.agentNotch) {
    window.agentNotch.getSettings().then(applySettings);
  }
}

async function persistSettings(update, app) {
  if (!window.agentNotch?.setSettings) return null;
  try {
    const next = await window.agentNotch.setSettings(update);
    if (next) {
      applySettings(next);
      if (app) {
        app.showLimitOnNotch = next.showLimitOnNotch !== false;
        app.focusMode = Boolean(next.focusMode);
        app.mutedAgents = Array.isArray(next.mutedAgents) ? [...next.mutedAgents] : [];
        if (typeof app.applySessionAppearance === 'function') {
          app.applySessionAppearance(next);
        }
        if (typeof app.applyDispatchDefaults === 'function') {
          app.applyDispatchDefaults(next);
        }
        if (typeof app.renderNotchLimitChip === 'function') {
          app.renderNotchLimitChip();
        }
        if (typeof app.renderFocusChip === 'function') {
          app.renderFocusChip();
        }
        if (update.focusMode !== undefined && app.showToast) {
          app.showToast(
            next.focusMode ? 'Focus mode on — alerts quiet' : 'Focus mode off',
            'ok'
          );
        }
      }
    }
    return next;
  } catch (err) {
    if (app?.showToast) app.showToast(err.message || 'Could not save settings', 'error');
    return null;
  }
}

function applyMutedAgents(mutedAgents) {
  const set = new Set(Array.isArray(mutedAgents) ? mutedAgents : []);
  for (const [elId, agentId] of Object.entries(MUTE_TOGGLES)) {
    const el = document.getElementById(elId);
    if (el) el.checked = set.has(agentId);
  }
}

function applySettings(settings) {
  if (!settings) return;

  for (const [elId, key] of Object.entries(MASTER_TOGGLES)) {
    const el = document.getElementById(elId);
    if (el && settings[key] !== undefined) {
      el.checked = Boolean(settings[key]);
    }
  }

  applyMutedAgents(settings.mutedAgents);

  for (const [elId, key] of Object.entries(MATRIX_TOGGLES)) {
    const el = document.getElementById(elId);
    if (el && settings[key] !== undefined) {
      el.checked = Boolean(settings[key]);
    }
  }

  const alignEl = document.getElementById('set-align');
  if (alignEl && settings.notchAlign) {
    alignEl.value = settings.notchAlign;
  }

  const autohideEl = document.getElementById('set-autohide');
  if (autohideEl && settings.autohideDelayMs != null) {
    const ms = Number(settings.autohideDelayMs);
    // Snap to nearest preset for the select control
    let best = AUTOHIDE_PRESETS[1];
    let bestDiff = Infinity;
    for (const p of AUTOHIDE_PRESETS) {
      const d = Math.abs(p - ms);
      if (d < bestDiff) {
        bestDiff = d;
        best = p;
      }
    }
    autohideEl.value = String(best);
  }

  const displayEl = document.getElementById('set-display');
  if (displayEl && settings.notchDisplayId != null) {
    const id = String(settings.notchDisplayId || 0);
    // Prefer matching option; 0 means primary — resolve after displays load
    if ([...displayEl.options].some((o) => o.value === id)) {
      displayEl.value = id;
    } else if (settings.notchDisplayId === 0) {
      const primary = [...displayEl.options].find((o) => o.dataset.primary === '1');
      if (primary) displayEl.value = primary.value;
    }
  }

  const densityEl = document.getElementById('set-card-density');
  if (densityEl && settings.cardDensity) {
    densityEl.value = settings.cardDensity === 'compact' ? 'compact' : 'comfortable';
  }

  const groupEl = document.getElementById('set-session-group');
  if (groupEl && settings.sessionGroupBy) {
    groupEl.value = ['status', 'agent', 'project'].includes(settings.sessionGroupBy)
      ? settings.sessionGroupBy
      : 'status';
  }

  const defAgentEl = document.getElementById('set-default-dispatch-agent');
  if (defAgentEl && settings.defaultDispatchAgent !== undefined) {
    defAgentEl.value = settings.defaultDispatchAgent || '';
  }

  const defCwdEl = document.getElementById('set-default-project-cwd');
  if (defCwdEl && settings.defaultProjectCwd !== undefined) {
    defCwdEl.value = settings.defaultProjectCwd || '';
  }

  // Dim matrix when masters off
  const matrix = document.getElementById('interrupt-matrix');
  if (matrix) {
    const soundOn = settings.soundAlerts !== false;
    const notifyOn = settings.desktopNotifications !== false;
    matrix.querySelectorAll('[id^="set-sound-"]').forEach((el) => {
      el.disabled = !soundOn;
    });
    matrix.querySelectorAll('[id^="set-notify-"]').forEach((el) => {
      el.disabled = !notifyOn;
    });
    matrix.classList.toggle('is-muted', !soundOn && !notifyOn);
  }
}

async function refreshDisplays() {
  const select = document.getElementById('set-display');
  if (!select || !window.agentNotch?.getDisplays) return;

  let selectedId = select.value;
  try {
    const settings = await window.agentNotch.getSettings();
    if (settings?.notchDisplayId != null) {
      selectedId = String(settings.notchDisplayId || 0);
    }
  } catch {
    // keep current
  }

  try {
    const displays = await window.agentNotch.getDisplays();
    select.innerHTML = '';
    for (const d of displays || []) {
      const opt = document.createElement('option');
      opt.value = String(d.primary ? 0 : d.id);
      // Store real id for non-primary; primary always saved as 0
      if (d.primary) {
        opt.value = '0';
        opt.dataset.primary = '1';
        opt.dataset.displayId = String(d.id);
      } else {
        opt.value = String(d.id);
        opt.dataset.displayId = String(d.id);
      }
      opt.textContent = d.primary
        ? `${d.label || 'Display'} (Primary)`
        : (d.label || `Display ${d.id}`);
      select.appendChild(opt);
    }

    // Restore selection: 0 = primary, else match id
    if (selectedId === '0' || selectedId === '') {
      const primary = [...select.options].find((o) => o.dataset.primary === '1');
      if (primary) select.value = primary.value;
    } else if ([...select.options].some((o) => o.value === selectedId)) {
      select.value = selectedId;
    } else {
      const primary = [...select.options].find((o) => o.dataset.primary === '1');
      if (primary) select.value = primary.value;
    }
  } catch {
    // ignore
  }
}

async function refreshHotkeyInfo() {
  const btn = document.getElementById('btn-hotkey-capture');
  const resetBtn = document.getElementById('btn-hotkey-reset');
  const hint = document.getElementById('hotkey-hint');
  if (!btn || !window.agentNotch?.getHotkeyInfo) return;

  try {
    const info = await window.agentNotch.getHotkeyInfo();
    const label = formatAccelerator(info.accelerator || info.defaultAccelerator);
    if (!capturingHotkey) {
      btn.textContent = label;
      btn.classList.remove('is-capturing');
    }
    if (resetBtn) {
      resetBtn.hidden = !info.custom;
    }
    if (hint && !capturingHotkey) {
      hint.textContent = `Toggle notch: ${label}. Click the button to change.`;
    }
  } catch {
    // ignore
  }
}

function formatAccelerator(accel) {
  if (!accel) return 'Ctrl+Shift+A';
  return String(accel)
    .replace(/Command/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Cmd/g, '⌘')
    .replace(/\+/g, '+');
}

function startHotkeyCapture(app) {
  const btn = document.getElementById('btn-hotkey-capture');
  const hint = document.getElementById('hotkey-hint');
  if (!btn) return;

  stopHotkeyCapture();
  capturingHotkey = true;
  btn.textContent = 'Press shortcut…';
  btn.classList.add('is-capturing');
  if (hint) hint.textContent = 'Press a combo with Ctrl/⌘ or Alt. Esc to cancel.';

  hotkeyKeyHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      stopHotkeyCapture();
      refreshHotkeyInfo();
      return;
    }

    // Wait for a non-modifier key
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    const accel = eventToAccelerator(e);
    if (!accel) {
      if (app?.showToast) app.showToast('Include Ctrl/⌘ or Alt with a key', 'error');
      return;
    }

    stopHotkeyCapture();
    persistSettings({ globalHotkey: accel }, app).then(() => refreshHotkeyInfo());
  };

  window.addEventListener('keydown', hotkeyKeyHandler, true);
}

function stopHotkeyCapture() {
  capturingHotkey = false;
  const btn = document.getElementById('btn-hotkey-capture');
  if (btn) btn.classList.remove('is-capturing');
  if (hotkeyKeyHandler) {
    window.removeEventListener('keydown', hotkeyKeyHandler, true);
    hotkeyKeyHandler = null;
  }
}

/**
 * Map a KeyboardEvent to an Electron accelerator string.
 * Requires at least one of Ctrl/Meta/Alt (Shift alone is not enough).
 */
function eventToAccelerator(e) {
  const parts = [];
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  if (e.ctrlKey) parts.push('Control');
  if (e.metaKey) parts.push(isMac ? 'Command' : 'Super');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    return null; // require a real modifier beyond Shift
  }

  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (key.startsWith('Arrow')) key = key.replace('Arrow', '');
  else if (key === 'Escape') return null;

  // Normalize common names to Electron accelerators
  const map = {
    '+': 'Plus',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert'
  };
  key = map[key] || key;

  // Reject pure modifier leftovers
  if (!key || ['Control', 'Shift', 'Alt', 'Meta', 'Command'].includes(key)) return null;

  parts.push(key);
  return parts.join('+');
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
