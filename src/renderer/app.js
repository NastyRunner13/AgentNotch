import { renderSessionCard, getAgentBarIcon } from './components/session-card.js';
import { renderHistoryView } from './components/history-view.js';
import { initSettings, openSettingsView } from './components/settings-panel.js';

/**
 * AgentNotch — Main Renderer Application
 * Integrates autohide, single-window unified UI, expandable sessions,
 * date-grouped history, and task dispatch.
 */
class App {
  constructor() {
    this.sessions = [];
    this.history = [];
    this.usageLimits = [];
    this.currentView = 'sessions';
    this.isExpanded = false;
    this.isAutoHidden = false;
    this.initialized = false;
    this.expandedSessionId = null;
    this.expandedHistoryId = null;
    /** Track which session ids were already in attention to avoid re-locking on every update */
    this._prevAttentionIds = new Set();
    this._clearHistoryPendingConfirm = false;
    /** Fingerprints to skip full DOM rebuilds that restart animations (flicker) */
    this._lastBarFp = '';
    this._lastSessionsFp = '';
    this._lastUsageFp = '';
    this._knownSessionIds = new Set();
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    // Notch bar click — toggle expand/collapse or reveal if autohidden
    const notchBar = document.getElementById('notch-bar');
    if (notchBar) {
      const activateNotchBar = () => {
        if (this.isAutoHidden) {
          if (window.agentNotch) window.agentNotch.showNotch();
        } else {
          this.toggleNotch();
        }
      };
      notchBar.addEventListener('click', activateNotchBar);
      notchBar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activateNotchBar();
        }
      });

      // Hover to reveal autohidden notch
      notchBar.addEventListener('mouseenter', () => {
        if (this.isAutoHidden && window.agentNotch) {
          window.agentNotch.showNotch();
        }
      });
    }

    const appEl = document.getElementById('app');
    if (appEl) {
      appEl.addEventListener('mouseenter', () => {
        if (window.agentNotch) window.agentNotch.setHovering(true);
      });
      appEl.addEventListener('mouseleave', () => {
        if (window.agentNotch) window.agentNotch.setHovering(false);
      });
    }

    // Tab navigation
    this.initTabs();

    // Settings panel bindings
    initSettings(this);

    // Task dispatch bar bindings
    this.initDispatch();

    // Keyboard shortcuts (when notch is expanded)
    this.initKeyboardShortcuts();

    // Subscribe to IPC events from main process
    if (window.agentNotch) {
      window.agentNotch.onNotchState((state) => {
        this.isExpanded = state === 'expanded';
        this.isAutoHidden = state === 'hidden';
        this.updateNotchClass();
      });

      window.agentNotch.onAutoHideState((hidden) => {
        this.isAutoHidden = hidden;
        this.updateNotchClass();
      });

      window.agentNotch.onSessionsUpdate((sessions) => {
        this.sessions = sessions;
        // Only auto-focus the attention session when it NEWLY enters attention
        // (not on every update) so the user can keep a different card expanded.
        const ATTENTION = ['permission-request', 'question', 'needs-attention'];
        const newlyAttention = sessions.find(s =>
          ATTENTION.includes(s.status) && !this._prevAttentionIds.has(s.id)
        );
        if (newlyAttention) {
          this.expandedSessionId = newlyAttention.id;
        }
        // Update the tracked set
        const currentAttentionIds = new Set(
          sessions.filter(s => ATTENTION.includes(s.status)).map(s => s.id)
        );
        this._prevAttentionIds = currentAttentionIds;
        this.render();
      });

      if (window.agentNotch.onUsageUpdate) {
        window.agentNotch.onUsageUpdate((usage) => {
          this.usageLimits = usage || [];
          this.renderUsageBar();
        });
      }

      if (window.agentNotch.onOpenView) {
        window.agentNotch.onOpenView((view) => {
          if (view === 'settings') {
            openSettingsView(this);
          } else if (view) {
            this.switchView(view);
            document.querySelectorAll('.ntab:not(.ntab-icon)').forEach(t => {
              t.classList.toggle('active', t.dataset.tab === view);
            });
          }
        });
      }

      // Initialize state
      let state = 'collapsed';
      try {
        state = await window.agentNotch.getNotchState();
      } catch {
        // fall back to collapsed
      }
      this.isExpanded = state === 'expanded';
      this.isAutoHidden = state === 'hidden';
      this.updateNotchClass();

      let sessions;
      try {
        sessions = await window.agentNotch.getSessions();
      } catch (err) {
        sessions = [];
        this.showToast(`Failed to load sessions: ${err.message}`, 'error');
      }
      this.sessions = sessions || [];
      if (window.agentNotch.getUsageLimits) {
        try {
          this.usageLimits = (await window.agentNotch.getUsageLimits()) || [];
        } catch {
          this.usageLimits = [];
        }
      }
      this.render();
    } else {
      // Dev mode fallback
      this.sessions = getMockSessions();
      this.usageLimits = getMockUsageLimits();
      this.render();
    }
  }

  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (!this.isExpanded) return;

      // Ignore when typing in inputs
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      const attentionSession = this.getAttentionSession();

      if (e.key === 'y' || e.key === 'Y') {
        if (attentionSession && attentionSession.status === 'permission-request') {
          e.preventDefault();
          this.handleApprove(attentionSession.id);
        }
        return;
      }

      if (e.key === 'n' || e.key === 'N') {
        if (attentionSession && attentionSession.status === 'permission-request') {
          e.preventDefault();
          this.handleDeny(attentionSession.id);
        }
        return;
      }

      if (e.key >= '1' && e.key <= '9') {
        if (attentionSession && attentionSession.status === 'question' && attentionSession.question) {
          const idx = parseInt(e.key, 10) - 1;
          const options = attentionSession.question.options || [];
          if (options[idx] !== undefined) {
            e.preventDefault();
            const opt = options[idx];
            const value = typeof opt === 'string' ? opt : (opt.value || opt.label || String(idx));
            this.handleAnswer(attentionSession.id, value);
          }
        }
      }
    });
  }

  getAttentionSession() {
    // Prefer expanded session if it needs attention
    if (this.expandedSessionId) {
      const expanded = this.sessions.find(s => s.id === this.expandedSessionId);
      if (expanded && ['permission-request', 'question', 'needs-attention'].includes(expanded.status)) {
        return expanded;
      }
    }
    return this.sessions.find(s =>
      ['permission-request', 'question', 'needs-attention'].includes(s.status)
    ) || null;
  }

  async handleApprove(sessionId) {
    if (!window.agentNotch) return;
    let res;
    try {
      res = await window.agentNotch.approvePermission(sessionId);
    } catch (err) {
      this.showToast(`Approve failed: ${err.message || 'main process error'}`, 'error');
      return;
    }
    if (res && !res.success) {
      this.showToast(res.message || 'Approve failed', 'error');
    } else if (res?.remote) {
      this.showToast(res.message || 'Approved', 'ok');
    } else if (res?.message) {
      this.showToast(res.message, 'info');
    }
  }

  async handleDeny(sessionId) {
    if (!window.agentNotch) return;
    let res;
    try {
      res = await window.agentNotch.denyPermission(sessionId);
    } catch (err) {
      this.showToast(`Deny failed: ${err.message || 'main process error'}`, 'error');
      return;
    }
    if (res && !res.success) {
      this.showToast(res.message || 'Deny failed', 'error');
    } else if (res?.remote) {
      this.showToast(res.message || 'Denied', 'ok');
    } else if (res?.message) {
      this.showToast(res.message, 'info');
    }
  }

  showToast(message, kind = 'info') {
    if (!message) return;
    let el = document.getElementById('notch-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'notch-toast';
      el.className = 'notch-toast';
      el.setAttribute('role', 'status');
      const panel = document.getElementById('notch-panel') || document.getElementById('app');
      if (panel) panel.appendChild(el);
      else document.body.appendChild(el);
    }
    el.textContent = message;
    el.dataset.kind = kind;
    el.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.classList.remove('visible');
    }, 3200);
  }

  async handleAnswer(sessionId, answer) {
    if (!window.agentNotch) return;
    try {
      const res = await window.agentNotch.answerQuestion(sessionId, answer);
      if (res && !res.success) {
        this.showToast(res.message || 'Answer failed', 'error');
      }
    } catch (err) {
      this.showToast(`Answer failed: ${err.message || 'main process error'}`, 'error');
    }
  }

  toggleNotch() {
    if (window.agentNotch) {
      window.agentNotch.toggleNotch();
    } else {
      this.isExpanded = !this.isExpanded;
      this.updateNotchClass();
    }
  }

  updateNotchClass() {
    const appEl = document.getElementById('app');
    if (!appEl) return;

    appEl.className = 'notch';
    if (this.isExpanded) {
      appEl.classList.add('expanded');
    } else if (this.isAutoHidden) {
      appEl.classList.add('hidden');
    } else {
      appEl.classList.add('collapsed');
    }
  }

  initTabs() {
    const tabs = document.querySelectorAll('.ntab:not(.ntab-icon)');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        const viewName = tab.dataset.tab;
        if (!viewName) return;

        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.switchView(viewName);
      });
    });
  }

  switchView(viewName) {
    this.currentView = viewName;

    document.querySelectorAll('.view').forEach(v => {
      v.classList.toggle('active', v.id === `view-${viewName}`);
    });

    if (viewName === 'history') {
      this.loadHistory();
    } else {
      this.render();
    }
  }

  async loadHistory() {
    if (window.agentNotch) {
      try {
        this.history = await window.agentNotch.getHistory();
      } catch (err) {
        this.history = [];
        this.showToast(`Failed to load history: ${err.message}`, 'error');
      }
    } else {
      this.history = getMockHistory();
    }
    this.render();
  }

  initDispatch() {
    const input = document.getElementById('dispatch-input');
    const agentSelect = document.getElementById('dispatch-agent');
    const btn = document.getElementById('dispatch-btn');

    if (!input || !agentSelect || !btn) return;

    const handleDispatch = async () => {
      const prompt = input.value.trim();
      const agent = agentSelect.value;

      if (!prompt) return;

      input.disabled = true;
      btn.disabled = true;

      try {
        if (window.agentNotch) {
          const res = await window.agentNotch.dispatchTask(agent, prompt);
          if (res && res.success) {
            input.value = '';
            // Switch view back to sessions to see the new agent spawn
            this.switchView('sessions');
            const tabs = document.querySelectorAll('.ntab:not(.ntab-icon)');
            tabs.forEach(t => {
              t.classList.toggle('active', t.dataset.tab === 'sessions');
            });
          } else {
            this.showToast(`Dispatch failed: ${res ? res.message : 'Unknown error'}`, 'error');
          }
        } else {
          // Dev mode stub
          input.value = '';
        }
      } catch (err) {
        this.showToast(`Error: ${err.message}`, 'error');
      } finally {
        input.disabled = false;
        btn.disabled = false;
        input.focus();
      }
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDispatch();
    });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        handleDispatch();
      }
    });

    input.addEventListener('click', (e) => {
      // Prevent notch collapse/expand on clicking the input
      e.stopPropagation();
    });

    agentSelect.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  /**
   * Stable fingerprint of what the UI actually shows.
   * Used to skip full innerHTML rebuilds that restart CSS animations (flicker).
   */
  _sessionFingerprint(sessions) {
    return sessions.map(s => {
      const act = Array.isArray(s.activity) ? s.activity : [];
      const lastAct = act.length ? act[act.length - 1] : null;
      const actKey = lastAct
        ? `${lastAct.at || ''}|${String(lastAct.text || '').slice(0, 80)}|${act.length}`
        : '0';
      const plan = Array.isArray(s.plan) ? s.plan : [];
      const planKey = plan.map(p => `${p.step || ''}:${p.status || ''}`).join(',');
      return [
        s.id,
        s.status,
        s.agent,
        s.taskName || '',
        s.currentTool || '',
        String(s.lastMessage || '').slice(0, 120),
        s.durationFormatted || '',
        actKey,
        planKey,
        s.permissionRequest?.requestId || '',
        s.question?.prompt || s.question?.text || ''
      ].join('\x1f');
    }).join('\x1e');
  }

  _barFingerprint(sessions) {
    return sessions.map(s => [
      s.id,
      s.status,
      s.agent,
      s.taskName || '',
      s.currentTool || '',
      String(s.lastMessage || '').slice(0, 80)
    ].join('\x1f')).join('\x1e');
  }

  /** Multicolor laser beam — active while any agent is working. */
  updateLaserState() {
    const appEl = document.getElementById('app');
    const notchLaser = document.getElementById('notch-laser');
    if (!appEl) return;

    const active = this.sessions.filter(s => s.status !== 'stopped');
    const working = active.some(s => s.status === 'working');
    const attention = active.some(s =>
      ['permission-request', 'question', 'needs-attention'].includes(s.status)
    );

    appEl.classList.toggle('laser-active', working);
    appEl.classList.toggle('laser-attention', attention && !working);

    if (notchLaser) {
      notchLaser.hidden = !working;
      notchLaser.setAttribute('aria-hidden', working ? 'false' : 'true');
    }
  }

  render() {
    this.renderNotchBar();
    this.renderUsageBar();
    if (this.currentView === 'sessions') {
      this.renderSessions();
    } else if (this.currentView === 'history') {
      this.renderHistory();
    }
    this.updateBadges();
    this.updateLaserState();
  }

  renderUsageBar() {
    const bar = document.getElementById('usage-bar');
    if (!bar) return;

    const items = Array.isArray(this.usageLimits) ? this.usageLimits : [];

    // Only show usage for harnesses with a live session — if OpenCode is the
    // only agent running, its chip is the only one shown. No sessions → no bar.
    const activeAgents = new Set(
      this.sessions.filter(s => s.status !== 'stopped').map(s => s.agent)
    );
    const visible = activeAgents.size > 0
      ? items.filter(u => activeAgents.has(u.name) || activeAgents.has(u.short))
      : [];

    const fp = visible.map(u =>
      `${u.id || u.name}|${u.usedPercent ?? 'na'}|${u.available ? 1 : 0}|${u.resetsLabel || ''}`
    ).join(';');
    if (fp === this._lastUsageFp && bar.dataset.rendered === '1') return;
    this._lastUsageFp = fp;
    bar.dataset.rendered = '1';

    if (visible.length === 0) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    bar.style.display = '';

    bar.innerHTML = visible.map(u => {
      const name = escapeHtml(u.short || u.name || u.id || '?');
      const color = u.color || '#888';
      const titleParts = [
        u.name || name,
        u.available && u.usedPercent != null ? `${u.usedPercent}% used` : (u.note || 'Limit not available'),
        u.remainingPercent != null ? `${u.remainingPercent}% left` : null,
        u.model ? `model ${u.model}` : null,
        u.plan || null,
        u.resetsLabel ? `resets ${u.resetsLabel}` : null
      ].filter(Boolean);
      const title = escapeHtml(titleParts.join(' · '));

      if (!u.available || u.usedPercent == null) {
        return `<span class="usage-chip" title="${title}">
          <span class="usage-chip-dot" style="background:${color}"></span>
          <span class="usage-chip-name">${name}</span>
          <span class="usage-chip-pct na">n/a</span>
        </span>`;
      }

      const pct = Math.max(0, Math.min(100, Math.round(Number(u.usedPercent))));
      const level = pct >= 85 ? 'crit' : pct >= 60 ? 'warn' : 'ok';
      return `<span class="usage-chip" title="${title}">
        <span class="usage-chip-dot" style="background:${color}"></span>
        <span class="usage-chip-name">${name}</span>
        <span class="usage-chip-pct ${level}">${pct}%</span>
        <span class="usage-chip-meter" style="color:${color}" aria-hidden="true"><span style="width:${pct}%"></span></span>
      </span>`;
    }).join('');
  }

  renderNotchBar() {
    const iconsContainer = document.getElementById('notch-agents');
    const statusTextEl = document.getElementById('notch-status-text');
    const statRunningEl = document.getElementById('stat-running');
    const statDoneEl = document.getElementById('stat-done');

    if (!iconsContainer) return;

    const activeSessions = this.sessions.filter(s => s.status !== 'stopped');
    const runningCount = activeSessions.filter(s => s.status === 'working').length;
    const doneCount = activeSessions.filter(s => s.status === 'idle').length;
    const barFp = this._barFingerprint(activeSessions);

    // Skip full icon rebuild when nothing visible changed
    if (barFp !== this._lastBarFp) {
      this._lastBarFp = barFp;

      if (activeSessions.length === 0) {
        iconsContainer.innerHTML = '';
        if (statusTextEl) {
          statusClass(statusTextEl, '');
          statusTextEl.textContent = 'AgentNotch';
          statusTextEl.removeAttribute('title');
        }
      } else {
        iconsContainer.innerHTML = activeSessions.map(s => getAgentBarIcon(s)).join('');

        if (statusTextEl) {
          const needsAttention = activeSessions.find(s =>
            ['permission-request', 'question', 'needs-attention'].includes(s.status)
          );
          const running = activeSessions.find(s => s.status === 'working');

          if (needsAttention) {
            statusClass(statusTextEl, 'attention');
            statusTextEl.textContent = needsAttention.status === 'permission-request'
              ? `${needsAttention.agent} needs permission`
              : `${needsAttention.agent} asks a question`;
            statusTextEl.removeAttribute('title');
          } else if (running) {
            statusClass(statusTextEl, 'working');
            const tool = running.currentTool || '';
            const noise = /^(exec|done|tool|bash|run)$/i.test(tool.trim())
              || /…$|\.\.\.$|Thinking|Responding|Streaming|Waiting|Planning|Running tools/i.test(tool);
            const detail = (!noise && tool)
              || running.lastMessage
              || `${running.agent} running`;
            const line = String(detail).replace(/\s+/g, ' ').trim();
            statusTextEl.textContent = line.length > 52 ? `${line.slice(0, 51)}…` : line;
            statusTextEl.title = line;
          } else {
            statusClass(statusTextEl, 'idle');
            const finished = activeSessions.find(s => s.status === 'idle' && s.lastMessage);
            if (finished && activeSessions.length === 1) {
              const line = String(finished.lastMessage).replace(/\s+/g, ' ').trim();
              statusTextEl.textContent = line.length > 52 ? `${line.slice(0, 51)}…` : line;
              statusTextEl.title = line;
            } else {
              statusTextEl.textContent = `${activeSessions.length} agent${activeSessions.length > 1 ? 's' : ''} finished`;
              statusTextEl.removeAttribute('title');
            }
          }
        }
      }
    }

    // Render active/done indicators
    if (statRunningEl) {
      const num = statRunningEl.querySelector('.stat-num');
      if (num) num.textContent = runningCount;
      statRunningEl.style.display = runningCount > 0 ? '' : 'none';
    }
    if (statDoneEl) {
      const num = statDoneEl.querySelector('.stat-num');
      if (num) num.textContent = doneCount;
      statDoneEl.style.display = doneCount > 0 ? '' : 'none';
    }
  }

  renderSessions() {
    const list = document.getElementById('sessions-list');
    const empty = document.getElementById('empty-state');

    if (!list) return;

    const activeSessions = this.sessions.filter(s => s.status !== 'stopped');
    const sessionsFp = this._sessionFingerprint(activeSessions) + `\x1d${this.expandedSessionId || ''}`;

    // Skip full card rebuild when content is unchanged (stops poll-driven flicker)
    if (sessionsFp === this._lastSessionsFp && list.dataset.bound === '1') {
      return;
    }
    this._lastSessionsFp = sessionsFp;

    if (activeSessions.length === 0) {
      list.innerHTML = '';
      list.dataset.bound = '0';
      this._knownSessionIds.clear();
      if (empty) empty.style.display = '';
      this.updateEmptyDetection();
      return;
    }

    if (empty) empty.style.display = 'none';

    // Preserve activity-feed scroll for the expanded session (live follow)
    let prevFeedScroll = null;
    if (this.expandedSessionId) {
      const prevFeed = list.querySelector(
        `.session-card[data-session-id="${CSS.escape(this.expandedSessionId)}"] .activity-live-feed`
      );
      if (prevFeed) {
        const nearBottom = (prevFeed.scrollHeight - prevFeed.scrollTop - prevFeed.clientHeight) < 48;
        prevFeedScroll = { nearBottom, top: prevFeed.scrollTop };
      }
    }

    const prevIds = this._knownSessionIds;
    const nextIds = new Set(activeSessions.map(s => s.id));

    // Render unified cards — only brand-new sessions get entrance animation
    list.innerHTML = activeSessions.map((session, i) => {
      const isNew = !prevIds.has(session.id);
      return renderSessionCard(session, i, { animateIn: isNew });
    }).join('');

    this._knownSessionIds = nextIds;
    list.dataset.bound = '1';

    // Restore expanded class
    if (this.expandedSessionId) {
      const card = list.querySelector(`.session-card[data-session-id="${CSS.escape(this.expandedSessionId)}"]`);
      if (card) {
        card.classList.add('expanded');
        card.setAttribute('aria-expanded', 'true');
      }
    } else if (activeSessions.length > 0) {
      // Auto-expand first card if none selected
      const firstCard = list.querySelector('.session-card');
      if (firstCard) {
        this.expandedSessionId = firstCard.dataset.sessionId;
        firstCard.classList.add('expanded');
        firstCard.setAttribute('aria-expanded', 'true');
        // Fingerprint included expandedSessionId — keep in sync without re-render loop
        this._lastSessionsFp = this._sessionFingerprint(activeSessions) + `\x1d${this.expandedSessionId}`;
      }
    }

    // Keep live activity feed pinned to the latest event (unless user scrolled up)
    if (this.expandedSessionId) {
      const feed = list.querySelector(
        `.session-card[data-session-id="${CSS.escape(this.expandedSessionId)}"] .activity-live-feed`
      );
      if (feed) {
        if (!prevFeedScroll || prevFeedScroll.nearBottom) {
          feed.scrollTop = feed.scrollHeight;
        } else {
          feed.scrollTop = prevFeedScroll.top;
        }
      }
    }

    // Attach card expansion toggle (click + keyboard)
    const toggleCard = (target) => {
      const sessionId = target.dataset.sessionId;
      const isCurrentlyExpanded = target.classList.contains('expanded');

      list.querySelectorAll('.session-card').forEach(c => {
        c.classList.remove('expanded');
        c.setAttribute('aria-expanded', 'false');
      });

      if (!isCurrentlyExpanded) {
        target.classList.add('expanded');
        target.setAttribute('aria-expanded', 'true');
        this.expandedSessionId = sessionId;
        this._lastSessionsFp = this._sessionFingerprint(activeSessions) + `\x1d${sessionId}`;
        // Pin live feed to latest after expand
        requestAnimationFrame(() => {
          const feed = target.querySelector('.activity-live-feed');
          if (feed) feed.scrollTop = feed.scrollHeight;
        });
      } else {
        this.expandedSessionId = null;
        this._lastSessionsFp = this._sessionFingerprint(activeSessions) + '\x1d';
      }
    };

    list.querySelectorAll('.session-card').forEach(card => {
      if (card.classList.contains('expanded')) {
        card.setAttribute('aria-expanded', 'true');
      }
      card.addEventListener('click', (e) => {
        // Don't toggle when selecting text in the activity feed / prompt
        if (e.target.closest('.activity-live-feed, .session-prompt, .approval-diff, button, a, input, select, textarea')) {
          e.stopPropagation();
          return;
        }
        toggleCard(e.currentTarget);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleCard(e.currentTarget);
        }
      });
    });

    // Attach inline action listeners (stopPropagation is key here so card doesn't toggle)
    list.querySelectorAll('.btn-allow').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sessionId;
        if (sid) this.handleApprove(sid);
      });
    });

    list.querySelectorAll('.btn-deny').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sessionId;
        if (sid) this.handleDeny(sid);
      });
    });

    list.querySelectorAll('.ask-option').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sessionId;
        const answer = btn.dataset.answer;
        if (sid) this.handleAnswer(sid, answer);
      });
    });

    list.querySelectorAll('.btn-jump').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sessionId;
        if (sid && window.agentNotch) {
          Promise.resolve(window.agentNotch.jumpToTerminal(sid))
            .catch((err) => this.showToast(`Jump failed: ${err.message || 'main process error'}`, 'error'));
        }
      });
    });
  }

  renderHistory() {
    const list = document.getElementById('history-list');
    const empty = document.getElementById('history-empty');

    if (!list) return;

    if (this.history.length === 0) {
      list.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }

    if (empty) empty.style.display = 'none';
    list.innerHTML = renderHistoryView(this.history, this.expandedHistoryId);

    // Clear history button
    const clearBtn = document.getElementById('btn-clear-history');
    if (clearBtn) {
      clearBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!this._clearHistoryPendingConfirm) {
          // First click: show toast asking to confirm
          this._clearHistoryPendingConfirm = true;
          this.showToast('Click Clear History again to confirm', 'info');
          setTimeout(() => { this._clearHistoryPendingConfirm = false; }, 4000);
        } else {
          // Second click within 4s: execute
          this._clearHistoryPendingConfirm = false;
          try {
            if (window.agentNotch) {
              await window.agentNotch.clearHistory();
            }
            this.history = [];
            this.renderHistory();
          } catch (err) {
            this.showToast(`Clear failed: ${err.message}`, 'error');
          }
        }
      });
    }

    // Click history entry to expand tools / prompt detail
    list.querySelectorAll('.history-entry').forEach(entry => {
      entry.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = entry.dataset.id;
        this.expandedHistoryId = this.expandedHistoryId === id ? null : id;
        this.renderHistory();
      });
    });
  }

  updateBadges() {
    const sessionsBadge = document.getElementById('sessions-badge');
    const activeSessions = this.sessions.filter(s => s.status !== 'stopped');
    const attentionCount = activeSessions.filter(s =>
      ['permission-request', 'question', 'needs-attention'].includes(s.status)
    ).length;

    if (sessionsBadge) {
      if (attentionCount > 0) {
        sessionsBadge.textContent = attentionCount;
        sessionsBadge.style.display = '';
      } else {
        sessionsBadge.style.display = 'none';
      }
    }
  }

  async updateEmptyDetection() {
    const el = document.getElementById('empty-detection');
    if (!el || !window.agentNotch?.getAgentDetection) return;
    try {
      const d = await window.agentNotch.getAgentDetection();
      const labels = [
        ['Claude', d.claude],
        ['Codex', d.codex],
        ['Cursor', d.cursor],
        ['Antigravity', d.antigravity],
        ['Grok', d.grok],
        ['OpenCode', d.opencode]
      ];
      el.textContent = labels
        .map(([name, ok]) => `${name}: ${ok ? 'data found' : 'not detected'}`)
        .join(' · ');
    } catch {
      el.textContent = '';
    }
  }
}

function statusClass(el, cls) {
  el.classList.remove('working', 'idle', 'attention');
  if (cls) el.classList.add(cls);
}

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Mock data helpers for local development/preview */
function getMockSessions() {
  return [
    {
      id: 'claude-abc123',
      agent: 'Claude Code',
      taskName: 'fix auth bug',
      status: 'working',
      currentTool: 'Edit(middleware.ts)',
      lastMessage: 'Found the issue — token validation skips expiry check.',
      userPrompt: 'fix the auth bug in middleware',
      duration: 1620000,
      durationFormatted: '27m',
      terminal: 'Terminal',
      model: 'opus',
      toolCalls: ['Read(package.json)', 'Search(verify)', 'Edit(middleware.ts)'],
      permissionRequest: {
        tool: 'Edit',
        filePath: 'src/auth/middleware.ts',
        input: {
          content: 'const verify = (token) => {\n- jwt.verify(token);\n+ if (!token) throw new AuthError("missing");\n+ return jwt.verify(token, secret);\n}'
        }
      }
    },
    {
      id: 'grok-mock-1',
      agent: 'Grok',
      taskName: 'Add usage bar',
      status: 'working',
      currentTool: 'Edit(app.js)',
      lastMessage: 'Wiring usage limits into the expanded top bar.',
      userPrompt: 'show usage limits and model tag',
      duration: 420000,
      durationFormatted: '7m',
      terminal: 'Terminal',
      model: 'grok-4.5',
      toolCalls: ['Read(app.js)', 'Edit(app.js)']
    },
    {
      id: 'antigravity-9f1a',
      agent: 'Antigravity',
      taskName: 'refactor database layer',
      status: 'question',
      currentTool: null,
      lastMessage: 'Let me double check database schema…',
      userPrompt: 'refactor database connections to use a singleton pool',
      duration: 360000,
      durationFormatted: '6m',
      terminal: 'Antigravity',
      toolCalls: ['List(db/)', 'Read(db/client.ts)'],
      question: {
        text: 'Should we target Production, Staging, or Local Database config?',
        options: ['Production', 'Staging', 'Local only']
      }
    },
    {
      id: 'cursor-main',
      agent: 'Cursor',
      taskName: 'Cursor IDE',
      status: 'idle',
      currentTool: null,
      lastMessage: 'Cursor is running',
      userPrompt: '',
      duration: 18000000,
      durationFormatted: '5h',
      terminal: 'Cursor',
      toolCalls: []
    }
  ];
}

function getMockUsageLimits() {
  return [
    { id: 'claude', short: 'Claude', name: 'Claude Code', color: '#D97757', available: false, usedPercent: null, model: 'opus', note: 'Limit not exposed locally' },
    { id: 'codex', short: 'Codex', name: 'Codex', color: '#10B981', available: true, usedPercent: 10, remainingPercent: 90, plan: 'go', model: 'gpt-5.6-terra' },
    { id: 'cursor', short: 'Cursor', name: 'Cursor', color: '#06B6D4', available: false, usedPercent: null, note: 'Limit not available locally' },
    { id: 'antigravity', short: 'Gemini', name: 'Antigravity', color: '#4285F4', available: false, usedPercent: null },
    { id: 'grok', short: 'Grok', name: 'Grok', color: '#EF4444', available: true, usedPercent: 22, remainingPercent: 78, plan: 'X Premium', model: 'grok-4.5' }
  ];
}

function getMockHistory() {
  return [
    {
      id: 'claude-mock-hist-1',
      agent: 'Claude Code',
      taskName: 'run tests and fix styling',
      userPrompt: 'run test suite and check styling rules',
      status: 'idle',
      durationFormatted: '12m',
      lastTime: Date.now() - 3600000,
      archivedAt: Date.now() - 3600000,
      toolCalls: ['run(npm test)', 'search(eslint.config.js)']
    },
    {
      id: 'codex-mock-hist-2',
      agent: 'Codex',
      taskName: 'add signup validation',
      userPrompt: 'add email and password validation to register router',
      status: 'idle',
      durationFormatted: '25m',
      lastTime: Date.now() - 86400000,
      archivedAt: Date.now() - 86400000,
      toolCalls: ['search(routes/)', 'write(routes/auth.js)']
    }
  ];
}

const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());
