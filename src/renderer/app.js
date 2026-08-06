import { renderSessionCard, getAgentBarIcon, renderSessionSectionHeader } from './components/session-card.js';
import { renderHistoryView } from './components/history-view.js';
import { renderUsageView, usageFingerprint, pickCritLimit } from './components/usage-view.js';
import { renderInsightsView, insightsFingerprint } from './components/insights-view.js';
import { initSettings, openSettingsView } from './components/settings-panel.js';

/** Agents whose sessions can receive dispatched messages (mirror of main process). */
const DISPATCHABLE_AGENT_LIST = ['Claude Code', 'Codex', 'Grok', 'OpenCode'];
const DISPATCHABLE_AGENTS = new Set(DISPATCHABLE_AGENT_LIST);

/** Compact option label: `Claude · fix auth bug · agent-notch` (disambiguates multi-session). */
function dispatchLabel(session, labels) {
  const meta = labels && labels.get(session.id);
  const agent = meta?.agentLabel
    || (session.agent === 'Claude Code' ? 'Claude' : session.agent);
  const task = String(session.taskName || 'session').replace(/\s+/g, ' ').trim();
  const short = task.length > 34 ? `${task.slice(0, 33)}…` : task;
  const dir = session.cwd ? String(session.cwd).split(/[\\/]/).filter(Boolean).pop() : '';
  // Avoid double project when agentLabel already includes it
  if (meta?.instanceTotal > 1 && meta.project && String(agent).includes(meta.project)) {
    return `${agent} · ${short}`;
  }
  return dir ? `${agent} · ${short} · ${dir}` : `${agent} · ${short}`;
}

/** Project folder basename from a cwd path. */
function projectBase(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Clearer agent tags when multiple sessions share one harness.
 * @returns {Map<string, { agentLabel: string, instanceIndex: number, instanceTotal: number, project: string }>}
 */
function buildSessionDisambiguation(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  /** @type {Map<string, typeof list>} */
  const byAgent = new Map();
  for (const s of list) {
    if (!s?.id) continue;
    const agent = s.agent || 'Agent';
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(s);
  }
  /** @type {Map<string, { agentLabel: string, instanceIndex: number, instanceTotal: number, project: string }>} */
  const out = new Map();
  for (const [agent, group] of byAgent) {
    const short = agent === 'Claude Code' ? 'Claude' : agent;
    const total = group.length;
    group.forEach((s, i) => {
      const project = projectBase(s.cwd);
      const idx = i + 1;
      let agentLabel = short;
      if (total > 1) {
        const projects = group.map((g) => projectBase(g.cwd)).filter(Boolean);
        const uniqueProjects = new Set(projects);
        if (project && uniqueProjects.size > 1) {
          agentLabel = `${short} · ${project}`;
        } else if (project && uniqueProjects.size === total) {
          agentLabel = `${short} · ${project}`;
        } else {
          agentLabel = `${short} #${idx}`;
        }
      }
      out.set(s.id, { agentLabel, instanceIndex: idx, instanceTotal: total, project });
    });
  }
  return out;
}

/** Short harness name for multi-attention bar copy. */
function shortAgentName(agent) {
  if (agent === 'Claude Code') return 'Claude';
  return String(agent || 'Agent');
}

const ATTENTION_STATUSES = ['permission-request', 'question', 'needs-attention'];

/** Active attention queue (unacked) — priority order matches main sort. */
function isInAttentionQueue(session) {
  return Boolean(
    session &&
    ATTENTION_STATUSES.includes(session.status) &&
    !session.attentionAcknowledged
  );
}

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
    /** Usage dashboard data + selected range (days) + burn chart metric */
    this.usageStats = null;
    this.usageRange = 7;
    this.usageChartMode = 'tokens';
    this._usageStatsFetchedAt = 0;
    this._lastUsageViewFp = '\x00init';
    /** Conversation insights data + selected range (days; 0 = all) */
    this.insights = null;
    this.insightsRange = 30;
    this._insightsFetchedAt = 0;
    this._lastInsightsFp = '\x00init';
    this.currentView = 'sessions';
    this.isExpanded = false;
    this.isAutoHidden = false;
    this.isPinned = false;
    this.initialized = false;
    this.expandedSessionId = null;
    this.expandedHistoryId = null;
    /** History search query (client-side filter) */
    this.historyQuery = '';
    this._historyContinuing = false;
    /** Track which session ids were already in attention to avoid re-locking on every update */
    this._prevAttentionIds = new Set();
    this._clearHistoryPendingConfirm = false;
    /** Fingerprints to skip full DOM rebuilds that restart animations (flicker) */
    this._lastBarFp = '\x00init';
    this._lastSessionsFp = '\x00init';
    this._lastUsageFp = '';
    this._knownSessionIds = new Set();
    /** Fold keys of long activity rows the user expanded (survives poll rebuilds) */
    this.expandedActivityKeys = new Set();
    /** Dispatch target dropdown state */
    this._dispatchFp = '';
    this._dispatching = false;
    /** Settings subset used by notch limit chip */
    this.showLimitOnNotch = true;
    /** Focus mode — sound/toast suppressed; bar still truthful */
    this.focusMode = false;
    /** Per-agent mute ids (sound/toast only; bar still truthful) */
    this.mutedAgents = [];
    /** Session feed appearance (from settings) */
    this.cardDensity = 'comfortable';
    this.showSessionModel = true;
    this.showSessionCwd = true;
    this.showSessionActivity = true;
    this.autoCollapseFinished = true;
    this.sessionGroupBy = 'status';
    /** Ephemeral feed filters (toolbar) */
    this.feedFilterAgent = 'all';
    this.feedFilterProject = 'all';
    /** Sessions the user explicitly expanded while finished (skip auto-collapse) */
    this._userPinnedExpand = new Set();
    /** Dispatch defaults */
    this.defaultDispatchAgent = '';
    this.defaultProjectCwd = '';
    this._dispatchLandedTimer = null;
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    console.log('[Renderer] App initializing...');

    try {
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

    // Bar controls — pin keeps the notch on screen; arrow tucks it away now.
    // stopPropagation (click AND keydown) so the bar's expand toggle never fires.
    const pinBtn = document.getElementById('btn-pin');
    if (pinBtn) {
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setPinned(!this.isPinned);
      });
      pinBtn.addEventListener('keydown', (e) => e.stopPropagation());
    }

    const hideBtn = document.getElementById('btn-hide');
    if (hideBtn) {
      hideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.agentNotch && window.agentNotch.hideNotch) {
          window.agentNotch.hideNotch();
        }
      });
      hideBtn.addEventListener('keydown', (e) => e.stopPropagation());
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

    // Session feed toolbar (group / filter)
    this.initSessionsToolbar();

    // Task dispatch bar bindings
    this.initDispatch();

    // Keyboard shortcuts (when notch is expanded)
    this.initKeyboardShortcuts();

    // Load appearance + dispatch defaults once
    if (window.agentNotch?.getSettings) {
      window.agentNotch.getSettings().then((settings) => {
        if (!settings) return;
        this.applySessionAppearance(settings);
        this.applyDispatchDefaults(settings);
        this.showLimitOnNotch = settings.showLimitOnNotch !== false;
        this.focusMode = Boolean(settings.focusMode);
        this.mutedAgents = Array.isArray(settings.mutedAgents) ? [...settings.mutedAgents] : [];
      }).catch(() => {});
    }

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
        // Only auto-focus the attention session when it NEWLY enters the queue
        // (not on every update) so the user can keep a different card expanded.
        const newlyAttention = sessions.find(s =>
          isInAttentionQueue(s) && !this._prevAttentionIds.has(s.id)
        );
        if (newlyAttention) {
          this.expandedSessionId = newlyAttention.id;
        }
        // Track active queue membership (episode acks drop out)
        const currentAttentionIds = new Set(
          sessions.filter(s => isInAttentionQueue(s)).map(s => s.id)
        );
        this._prevAttentionIds = currentAttentionIds;
        this._maybeRefreshUsageStats();
        this.render();
      });

      if (window.agentNotch.onUsageUpdate) {
        window.agentNotch.onUsageUpdate((usage) => {
          this.usageLimits = usage || [];
          this.renderUsageBar();
          this.renderNotchLimitChip();
          if (this.currentView === 'usage') {
            this._lastUsageViewFp = '\x00force';
            this.renderUsageDashboard();
          }
        });
      }

      if (window.agentNotch.onLimitAlert) {
        window.agentNotch.onLimitAlert((alerts) => {
          // Focus + per-agent mute suppress interrupt toasts; crit chips stay on the bar
          if (this.focusMode) return;
          const muted = new Set(Array.isArray(this.mutedAgents) ? this.mutedAgents : []);
          const list = Array.isArray(alerts) ? alerts : [];
          for (const a of list) {
            if (!a) continue;
            if (a.id && muted.has(a.id)) continue;
            const label = a.short || a.name || 'Agent';
            const band = a.band === 'crit' ? 'critical' : 'high';
            this.showToast(`${label} ${a.usedPercent}% used (${band})`, a.band === 'crit' ? 'error' : 'info');
          }
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

      // Reflect the persisted pin setting on the bar
      try {
        const s = await window.agentNotch.getSettings();
        this.isPinned = Boolean(s && s.notchPinned);
        this.showLimitOnNotch = s?.showLimitOnNotch !== false;
        this.focusMode = Boolean(s && s.focusMode);
        this.mutedAgents = Array.isArray(s?.mutedAgents) ? [...s.mutedAgents] : [];
      } catch {
        this.isPinned = false;
        this.showLimitOnNotch = true;
        this.focusMode = false;
        this.mutedAgents = [];
      }
      this.updateBarControls();
      this.renderFocusChip();

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
    } catch (err) {
      console.error('[Renderer] Init error:', err);
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

      // Attention queue navigation (Ctrl+] next, Ctrl+[ previous)
      if (e.key === ']' || e.key === '[') {
        e.preventDefault();
        this.cycleAttentionQueue(e.key === ']' ? 1 : -1);
        return;
      }

      // Dismiss current attention episode from queue (session stays)
      if ((e.key === 'd' || e.key === 'D') && e.shiftKey) {
        const target = this.getAttentionSession();
        if (target && isInAttentionQueue(target)) {
          e.preventDefault();
          this.handleDismissAttention(target.id);
        }
        return;
      }

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

  /** Active (unacked) attention queue in list order. */
  getAttentionQueue() {
    return this.sessions.filter(s => isInAttentionQueue(s) && s.status !== 'stopped');
  }

  /**
   * Prefer expanded queue member; else head of the attention queue.
   * Used by Ctrl+Y/N/1-9 and dismiss-attention.
   */
  getAttentionSession() {
    if (this.expandedSessionId) {
      const expanded = this.sessions.find(s => s.id === this.expandedSessionId);
      if (expanded && isInAttentionQueue(expanded)) {
        return expanded;
      }
    }
    return this.getAttentionQueue()[0] || null;
  }

  /**
   * Expand the next/previous item in the attention queue and scroll it into view.
   * @param {1|-1} delta
   */
  cycleAttentionQueue(delta) {
    const queue = this.getAttentionQueue();
    if (queue.length === 0) {
      this.showToast('Nothing needs you right now', 'info');
      return;
    }

    // Switch to Sessions tab so the card is visible
    if (this.currentView !== 'sessions') {
      this.switchView('sessions');
      document.querySelectorAll('.ntab:not(.ntab-icon)').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === 'sessions');
      });
    }

    let idx = queue.findIndex(s => s.id === this.expandedSessionId);
    if (idx < 0) {
      idx = delta > 0 ? 0 : queue.length - 1;
    } else {
      idx = (idx + delta + queue.length) % queue.length;
    }

    const target = queue[idx];
    this.expandedSessionId = target.id;
    this._lastSessionsFp = '\x00force';
    this.renderSessions();

    requestAnimationFrame(() => {
      const card = document.querySelector(
        `.session-card[data-session-id="${CSS.escape(target.id)}"]`
      );
      if (card) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        try { card.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    });

    if (queue.length > 1) {
      this.showToast(
        `${idx + 1}/${queue.length} · ${shortAgentName(target.agent)}`,
        'info'
      );
    }
  }

  async handleDismissAttention(sessionId) {
    if (!window.agentNotch?.dismissAttention) return;
    try {
      const res = await window.agentNotch.dismissAttention(sessionId);
      if (res && res.success) {
        // Advance to next remaining queue item if we cleared the focused one
        const queue = this.getAttentionQueue().filter(s => s.id !== sessionId);
        if (this.expandedSessionId === sessionId) {
          this.expandedSessionId = queue[0]?.id || null;
        }
        this.showToast(res.message || 'Cleared from queue', 'ok');
      } else {
        this.showToast((res && res.message) || 'Could not clear attention', 'error');
      }
    } catch (err) {
      this.showToast(`Clear failed: ${err.message || 'main process error'}`, 'error');
    }
  }

  async handleRestoreAttention(sessionId) {
    if (!window.agentNotch?.clearAttentionAck) return;
    try {
      const res = await window.agentNotch.clearAttentionAck(sessionId);
      if (res && res.success) {
        this.expandedSessionId = sessionId;
        this.showToast(res.message || 'Back in queue', 'ok');
      } else {
        this.showToast((res && res.message) || 'Could not restore', 'error');
      }
    } catch (err) {
      this.showToast(`Restore failed: ${err.message || 'main process error'}`, 'error');
    }
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

  /**
   * Pin toggle — optimistic UI, main process is the source of truth.
   * Pinned notches never auto-hide; unpinning re-arms the idle timer.
   */
  async setPinned(pinned) {
    this.isPinned = pinned;
    this.updateBarControls();
    if (!window.agentNotch || !window.agentNotch.setNotchPinned) return;
    try {
      const actual = await window.agentNotch.setNotchPinned(pinned);
      this.isPinned = Boolean(actual);
      this.updateBarControls();
    } catch (err) {
      this.isPinned = !pinned;
      this.updateBarControls();
      this.showToast(`Pin failed: ${err.message}`, 'error');
    }
  }

  /** Reflect pin state on the bar: active pin; tuck-away arrow only when unpinned. */
  updateBarControls() {
    const pinBtn = document.getElementById('btn-pin');
    const hideBtn = document.getElementById('btn-hide');
    if (pinBtn) {
      pinBtn.classList.toggle('active', this.isPinned);
      pinBtn.setAttribute('aria-pressed', String(this.isPinned));
      pinBtn.title = this.isPinned
        ? 'Pinned — click to let the notch auto-hide'
        : 'Pin — keep the notch on screen';
    }
    if (hideBtn) {
      hideBtn.hidden = this.isPinned;
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
    } else if (viewName === 'usage') {
      this.loadUsageStats();
    } else if (viewName === 'insights') {
      this.loadInsights();
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

  async loadUsageStats() {
    if (window.agentNotch && window.agentNotch.getUsageStats) {
      try {
        this.usageStats = await window.agentNotch.getUsageStats();
        this._usageStatsFetchedAt = Date.now();
      } catch (err) {
        this.usageStats = this.usageStats || { updatedAt: Date.now(), buckets: [], sessionTime: [] };
        this.showToast(`Failed to load usage: ${err.message}`, 'error');
      }
    } else {
      // Dev mode fallback
      this.usageStats = getMockUsageStats();
      this._usageStatsFetchedAt = Date.now();
    }
    this.render();
  }

  /**
   * Throttled refresh while the usage view is open — piggybacks on the
   * sessions poll so the dashboard tracks live token burn without a
   * dedicated push channel.
   */
  _maybeRefreshUsageStats() {
    if (this.currentView === 'usage') {
      if (Date.now() - this._usageStatsFetchedAt < 15000) return;
      this.loadUsageStats();
    } else if (this.currentView === 'insights') {
      if (Date.now() - this._insightsFetchedAt < 30000) return;
      this.loadInsights();
    }
  }

  async loadInsights() {
    if (window.agentNotch && window.agentNotch.getInsights) {
      try {
        this.insights = await window.agentNotch.getInsights();
        this._insightsFetchedAt = Date.now();
      } catch (err) {
        this.insights = this.insights || { updatedAt: Date.now(), records: [] };
        this.showToast(`Failed to load insights: ${err.message}`, 'error');
      }
    } else {
      // Dev mode fallback
      this.insights = getMockInsights();
      this._insightsFetchedAt = Date.now();
    }
    this.render();
  }

  renderInsights() {
    const container = document.getElementById('insights-list');
    if (!container) return;

    const data = this.insights || { updatedAt: 0, records: [] };
    const fp = insightsFingerprint(data, this.insightsRange);
    if (fp === this._lastInsightsFp && container.dataset.bound === '1') return;
    this._lastInsightsFp = fp;
    container.dataset.bound = '1';

    container.innerHTML = renderInsightsView(data, this.insightsRange);

    container.querySelectorAll('.usage-range-btn[data-insight-range]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const days = parseInt(btn.dataset.insightRange, 10);
        if (!Number.isFinite(days) || days === this.insightsRange) return;
        this.insightsRange = days;
        this.renderInsights();
      });
    });
  }

  renderUsageDashboard() {
    const container = document.getElementById('usage-list');
    if (!container) return;

    const stats = this.usageStats || { updatedAt: 0, buckets: [], sessionTime: [] };
    const limitsFp = (this.usageLimits || [])
      .map((u) => `${u.id}|${u.usedPercent ?? 'na'}|${u.available ? 1 : 0}`)
      .join(';');
    const fp = `${usageFingerprint(stats, this.usageRange, this.usageChartMode)}|${limitsFp}`;
    if (fp === this._lastUsageViewFp && container.dataset.bound === '1') return;
    this._lastUsageViewFp = fp;
    container.dataset.bound = '1';

    container.innerHTML = renderUsageView(
      stats,
      this.usageRange,
      this.usageChartMode,
      this.usageLimits
    );

    container.querySelectorAll('.usage-range-btn[data-range]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const days = parseInt(btn.dataset.range, 10);
        if (!Number.isFinite(days) || days === this.usageRange) return;
        this.usageRange = days;
        this.renderUsageDashboard();
      });
    });

    container.querySelectorAll('.usage-range-btn[data-chart-mode]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = btn.dataset.chartMode;
        if (!mode || mode === this.usageChartMode) return;
        this.usageChartMode = mode;
        this.renderUsageDashboard();
      });
    });
  }

  /**
   * Apply session feed appearance settings and re-render.
   * @param {object} partial
   */
  applySessionAppearance(partial) {
    if (!partial) return;
    if (partial.cardDensity !== undefined) {
      this.cardDensity = partial.cardDensity === 'compact' ? 'compact' : 'comfortable';
    }
    if (partial.showSessionModel !== undefined) {
      this.showSessionModel = partial.showSessionModel !== false;
    }
    if (partial.showSessionCwd !== undefined) {
      this.showSessionCwd = partial.showSessionCwd !== false;
    }
    if (partial.showSessionActivity !== undefined) {
      this.showSessionActivity = partial.showSessionActivity !== false;
    }
    if (partial.autoCollapseFinished !== undefined) {
      this.autoCollapseFinished = partial.autoCollapseFinished !== false;
    }
    if (partial.sessionGroupBy !== undefined) {
      const g = partial.sessionGroupBy;
      this.sessionGroupBy = ['status', 'agent', 'project'].includes(g) ? g : 'status';
      const groupSel = document.getElementById('feed-group-by');
      if (groupSel && groupSel.value !== this.sessionGroupBy) {
        groupSel.value = this.sessionGroupBy;
      }
    }
    // Force feed rebuild with new density / fields
    this._lastSessionsFp = '\x00force';
    if (this.initialized) this.renderSessions();
  }

  /**
   * Apply dispatch default agent / project path.
   * @param {object} partial
   */
  applyDispatchDefaults(partial) {
    if (!partial) return;
    if (partial.defaultDispatchAgent !== undefined) {
      this.defaultDispatchAgent = String(partial.defaultDispatchAgent || '');
    }
    if (partial.defaultProjectCwd !== undefined) {
      this.defaultProjectCwd = String(partial.defaultProjectCwd || '');
    }
    this._dispatchFp = ''; // rebuild targets so default selection can apply
    if (this.initialized) this.updateDispatchTargets();
  }

  initSessionsToolbar() {
    const groupSel = document.getElementById('feed-group-by');
    const agentSel = document.getElementById('feed-filter-agent');
    const projectSel = document.getElementById('feed-filter-project');

    if (groupSel) {
      groupSel.value = this.sessionGroupBy;
      groupSel.addEventListener('change', (e) => {
        e.stopPropagation();
        const v = groupSel.value;
        this.sessionGroupBy = ['status', 'agent', 'project'].includes(v) ? v : 'status';
        // Persist as default grouping
        if (window.agentNotch?.setSettings) {
          window.agentNotch.setSettings({ sessionGroupBy: this.sessionGroupBy }).catch(() => {});
        }
        this._lastSessionsFp = '\x00force';
        this.renderSessions();
      });
      groupSel.addEventListener('click', (e) => e.stopPropagation());
    }

    if (agentSel) {
      agentSel.addEventListener('change', (e) => {
        e.stopPropagation();
        this.feedFilterAgent = agentSel.value || 'all';
        this._lastSessionsFp = '\x00force';
        this.renderSessions();
      });
      agentSel.addEventListener('click', (e) => e.stopPropagation());
    }

    if (projectSel) {
      projectSel.addEventListener('change', (e) => {
        e.stopPropagation();
        this.feedFilterProject = projectSel.value || 'all';
        this._lastSessionsFp = '\x00force';
        this.renderSessions();
      });
      projectSel.addEventListener('click', (e) => e.stopPropagation());
    }
  }

  /**
   * Refresh filter dropdown options from live sessions (preserve selection when possible).
   * @param {object[]} activeSessions
   */
  updateFeedFilterOptions(activeSessions) {
    const agentSel = document.getElementById('feed-filter-agent');
    const projectSel = document.getElementById('feed-filter-project');
    const toolbar = document.getElementById('sessions-toolbar');

    const agents = [];
    const agentSeen = new Set();
    const projects = [];
    const projectSeen = new Set();
    for (const s of activeSessions) {
      if (s.agent && !agentSeen.has(s.agent)) {
        agentSeen.add(s.agent);
        agents.push(s.agent);
      }
      const base = projectBase(s.cwd);
      if (base && !projectSeen.has(base)) {
        projectSeen.add(base);
        projects.push(base);
      }
    }
    agents.sort((a, b) => a.localeCompare(b));
    projects.sort((a, b) => a.localeCompare(b));

    if (toolbar) {
      toolbar.hidden = activeSessions.length < 2;
    }

    if (agentSel) {
      const prev = this.feedFilterAgent;
      agentSel.innerHTML = '<option value="all">All</option>';
      for (const a of agents) {
        const opt = document.createElement('option');
        opt.value = a;
        opt.textContent = a === 'Claude Code' ? 'Claude' : a;
        agentSel.appendChild(opt);
      }
      if (prev !== 'all' && agents.includes(prev)) {
        agentSel.value = prev;
        this.feedFilterAgent = prev;
      } else {
        agentSel.value = 'all';
        this.feedFilterAgent = 'all';
      }
    }

    if (projectSel) {
      const prev = this.feedFilterProject;
      projectSel.innerHTML = '<option value="all">All</option>';
      for (const p of projects) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        projectSel.appendChild(opt);
      }
      if (prev !== 'all' && projects.includes(prev)) {
        projectSel.value = prev;
        this.feedFilterProject = prev;
      } else {
        projectSel.value = 'all';
        this.feedFilterProject = 'all';
      }
    }
  }

  initDispatch() {
    const input = document.getElementById('dispatch-input');
    const agentSelect = document.getElementById('dispatch-agent');
    const btn = document.getElementById('dispatch-btn');

    if (!input || !agentSelect || !btn) return;

    const handleDispatch = async () => {
      const prompt = input.value.trim();
      const sessionId = agentSelect.value;

      if (!prompt || !sessionId) return;

      this._dispatching = true;
      input.disabled = true;
      agentSelect.disabled = true;
      btn.disabled = true;
      btn.classList.remove('dispatch-success');

      try {
        if (window.agentNotch) {
          const res = await window.agentNotch.dispatchTask(sessionId, prompt);
          if (res && res.success) {
            input.value = '';
            this.flashDispatchLanded(res.message || 'Landed');
            this.showToast(res.message || 'Landed in session', 'ok');
            // Switch view back to sessions to watch the session work
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
          this.flashDispatchLanded('Dispatched (preview)');
        }
      } catch (err) {
        this.showToast(`Error: ${err.message}`, 'error');
      } finally {
        this._dispatching = false;
        this.updateDispatchTargets();
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

    agentSelect.addEventListener('change', () => {
      this.updateDispatchPlaceholder();
    });

    this.updateDispatchTargets();
  }

  /**
   * Brief visual confirmation that a prompt landed in a session.
   * @param {string} [message]
   */
  flashDispatchLanded(message) {
    const bar = document.getElementById('dispatch-bar');
    const btn = document.getElementById('dispatch-btn');
    if (bar) {
      bar.classList.add('dispatch-landed');
      bar.title = message || 'Prompt landed';
    }
    if (btn) {
      btn.classList.add('dispatch-success');
      const icon = btn.querySelector('.dispatch-btn-icon');
      const check = btn.querySelector('.dispatch-btn-check');
      if (icon) icon.hidden = true;
      if (check) check.hidden = false;
    }
    clearTimeout(this._dispatchLandedTimer);
    this._dispatchLandedTimer = setTimeout(() => {
      if (bar) {
        bar.classList.remove('dispatch-landed');
        bar.removeAttribute('title');
      }
      if (btn) {
        btn.classList.remove('dispatch-success');
        const icon = btn.querySelector('.dispatch-btn-icon');
        const check = btn.querySelector('.dispatch-btn-check');
        if (icon) icon.hidden = false;
        if (check) check.hidden = true;
      }
    }, 1600);
  }

  /**
   * Populate the dispatch dropdown with live sessions (one entry per running
   * agent chat) plus "new session" entries per agent. Rebuilds only when the
   * option set changes so polling never collapses an open dropdown; the
   * current selection is preserved when possible.
   */
  updateDispatchTargets() {
    const select = document.getElementById('dispatch-agent');
    const input = document.getElementById('dispatch-input');
    const btn = document.getElementById('dispatch-btn');
    if (!select || !input || !btn) return;

    const targets = this.sessions.filter(s => DISPATCHABLE_AGENTS.has(s.agent));
    const labels = buildSessionDisambiguation(targets);

    // Best-known working directory per agent (sessions arrive recency-sorted)
    const dirByAgent = new Map();
    const defaultBase = projectBase(this.defaultProjectCwd);
    for (const s of this.sessions) {
      if (!dirByAgent.has(s.agent) && s.cwd) {
        const base = projectBase(s.cwd);
        if (base) dirByAgent.set(s.agent, base);
      }
    }

    const fp = targets.map(s => s.id).join('\x1e') + '\x1f' +
      DISPATCHABLE_AGENT_LIST.map(a => dirByAgent.get(a) || '').join('\x1e') +
      `\x1f${this.defaultDispatchAgent}\x1f${defaultBase}`;

    if (fp !== this._dispatchFp) {
      const prev = select.value;
      this._dispatchFp = fp;
      select.innerHTML = '';

      const liveGroup = document.createElement('optgroup');
      liveGroup.label = 'Active sessions';
      if (targets.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.textContent = 'No active sessions';
        liveGroup.appendChild(opt);
      } else {
        for (const s of targets) {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = dispatchLabel(s, labels);
          opt.title = `${s.agent} — ${s.taskName || 'session'}${s.cwd ? `\n${s.cwd}` : ''}`;
          liveGroup.appendChild(opt);
        }
      }
      select.appendChild(liveGroup);

      const newGroup = document.createElement('optgroup');
      newGroup.label = 'Start new session';
      for (const agent of DISPATCHABLE_AGENT_LIST) {
        const opt = document.createElement('option');
        opt.value = `new:${agent}`;
        const name = agent === 'Claude Code' ? 'Claude' : agent;
        // Prefer configured default project basename, else last-used for agent
        const dir = defaultBase || dirByAgent.get(agent);
        const isDefault = this.defaultDispatchAgent === agent;
        opt.textContent = dir
          ? `+ New ${name} · ${dir}${isDefault ? ' ★' : ''}`
          : `+ New ${name}${isDefault ? ' ★' : ''}`;
        opt.title = `Start a new ${agent} session${dir ? ` in ${dir}` : ''}${isDefault ? ' (default)' : ''}`;
        newGroup.appendChild(opt);
      }
      select.appendChild(newGroup);

      const stillThere = Array.from(select.options).some(o => o.value === prev && !o.disabled);
      if (stillThere) {
        select.value = prev;
      } else if (targets.length) {
        select.value = targets[0].id;
      } else if (this.defaultDispatchAgent && DISPATCHABLE_AGENTS.has(this.defaultDispatchAgent)) {
        select.value = `new:${this.defaultDispatchAgent}`;
      } else {
        select.value = `new:${DISPATCHABLE_AGENT_LIST[0]}`;
      }
    }

    const disabled = this._dispatching;
    select.disabled = disabled;
    input.disabled = disabled;
    btn.disabled = disabled;
    this.updateDispatchPlaceholder();
  }

  updateDispatchPlaceholder() {
    const select = document.getElementById('dispatch-agent');
    const input = document.getElementById('dispatch-input');
    if (!select || !input) return;
    const isNew = (select.value || '').startsWith('new:');
    if (isNew) {
      const dir = projectBase(this.defaultProjectCwd);
      input.placeholder = dir
        ? `Prompt for new session in ${dir}…`
        : 'Prompt for the new session…';
    } else {
      input.placeholder = 'Message this session…';
    }
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
      // Snooze remaining minutes so chip labels refresh on the poll boundary
      const snoozeKey = s.snoozed
        ? (s.snoozeUntilIdle ? 'idle' : `t${Math.ceil((Number(s.snoozeUntil) - Date.now()) / 60000)}`)
        : '0';
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
        s.question?.prompt || s.question?.text || '',
        snoozeKey,
        s.attentionAcknowledged ? '1' : '0',
        s.queueIndex || 0,
        s.queueTotal || 0
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
      String(s.lastMessage || '').slice(0, 80),
      s.snoozed ? '1' : '0',
      s.attentionAcknowledged ? '1' : '0',
      s.queueIndex || 0
    ].join('\x1f')).join('\x1e');
  }

  /** Multicolor laser beam — active while any agent is working. */
  updateLaserState() {
    const appEl = document.getElementById('app');
    const notchLaser = document.getElementById('notch-laser');
    if (!appEl) return;

    const active = this.sessions.filter(s => s.status !== 'stopped');
    const working = active.some(s => s.status === 'working');
    const attention = active.some(s => isInAttentionQueue(s));

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
    } else if (this.currentView === 'usage') {
      this.renderUsageDashboard();
    } else if (this.currentView === 'insights') {
      this.renderInsights();
    }
    this.updateBadges();
    this.updateLaserState();
    this.updateDispatchTargets();
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
    const brandEl = document.getElementById('notch-brand');
    const statRunningEl = document.getElementById('stat-running');
    const statDoneEl = document.getElementById('stat-done');

    if (!iconsContainer) return;

    const activeSessions = this.sessions.filter(s => s.status !== 'stopped');
    const runningCount = activeSessions.filter(s => s.status === 'working').length;
    const attentionSessions = activeSessions.filter(s => isInAttentionQueue(s));
    const attentionCount = attentionSessions.length;
    // "Done" = a real completed agent run. Bare process placeholders
    // (e.g. "Cursor IDE is open") have no prompt/tools and don't count.
    const isCompletedRun = (s) =>
      s.status === 'idle' && (s.userPrompt || (s.toolCalls && s.toolCalls.length > 0));
    const doneCount = activeSessions.filter(isCompletedRun).length;
    const barFp = this._barFingerprint(activeSessions);

    // Skip full icon rebuild when nothing visible changed
    if (barFp !== this._lastBarFp) {
      this._lastBarFp = barFp;

      if (activeSessions.length === 0) {
        iconsContainer.innerHTML = '';
        if (brandEl) brandEl.hidden = false;
        if (statusTextEl) {
          statusClass(statusTextEl, '');
          statusTextEl.textContent = 'AgentNotch';
          statusTextEl.removeAttribute('title');
        }
      } else {
        iconsContainer.innerHTML = activeSessions.map(s => getAgentBarIcon(s)).join('');
        if (brandEl) brandEl.hidden = true;

        if (statusTextEl) {
          const needsAttention = attentionSessions[0];
          const running = activeSessions.find(s => s.status === 'working');

          if (needsAttention) {
            statusClass(statusTextEl, 'attention');
            const agent = shortAgentName(needsAttention.agent);
            let detail;
            if (needsAttention.status === 'permission-request') {
              detail = `${agent} needs permission`;
            } else if (needsAttention.status === 'question') {
              detail = `${agent} asks a question`;
            } else {
              detail = `${agent} needs you`;
            }

            if (attentionCount > 1) {
              // Queue command center: position + head of queue
              const pos = needsAttention.queueIndex || 1;
              statusTextEl.textContent = `${pos} of ${attentionCount} · ${detail}`;
              statusTextEl.title = attentionSessions
                .map((s, i) => {
                  const n = s.queueIndex || (i + 1);
                  return `${n}. ${s.agent}: ${s.taskName || s.status}`;
                })
                .join('\n');
            } else {
              statusTextEl.textContent = detail;
              statusTextEl.removeAttribute('title');
            }
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
            // Counts live on the right pills — center carries the latest result
            const finished = activeSessions.find(s => isCompletedRun(s) && s.lastMessage)
              || activeSessions.find(s => s.status === 'idle' && s.lastMessage);
            if (finished) {
              const line = String(finished.lastMessage).replace(/\s+/g, ' ').trim();
              statusTextEl.textContent = line.length > 52 ? `${line.slice(0, 51)}…` : line;
              statusTextEl.title = line;
            } else {
              statusTextEl.textContent = doneCount > 1
                ? `${doneCount} agents complete`
                : 'Agent complete';
              statusTextEl.removeAttribute('title');
            }
          }
        }
      }
    }

    // Render active / attention / done indicators
    const statAttentionEl = document.getElementById('stat-attention');
    if (statAttentionEl) {
      const num = statAttentionEl.querySelector('.stat-num');
      if (num) num.textContent = attentionCount;
      statAttentionEl.style.display = attentionCount > 0 ? '' : 'none';
    }
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

    this.renderNotchLimitChip(attentionCount);
    this.renderFocusChip();
  }

  /**
   * Quiet "focus" pill when Focus mode is on — bar truth stays; this only
   * signals that sound/toast are suppressed.
   */
  renderFocusChip() {
    const el = document.getElementById('stat-focus');
    if (!el) return;
    el.style.display = this.focusMode ? '' : 'none';
  }

  /**
   * Crit-only limit chip on the collapsed bar. Attention always outranks it
   * (hidden when something needs the user). Gated by showLimitOnNotch.
   * @param {number} [attentionCount]
   */
  renderNotchLimitChip(attentionCount) {
    const el = document.getElementById('stat-limit');
    if (!el) return;

    const att = attentionCount != null
      ? attentionCount
      : this.sessions.filter((s) => isInAttentionQueue(s)).length;

    if (!this.showLimitOnNotch || att > 0) {
      el.style.display = 'none';
      return;
    }

    const crit = pickCritLimit(this.usageLimits);
    if (!crit) {
      el.style.display = 'none';
      return;
    }

    const pct = Math.max(0, Math.min(100, Math.round(Number(crit.usedPercent))));
    const name = crit.short || crit.name || 'Agent';
    const num = el.querySelector('.stat-num');
    const label = el.querySelector('.stat-label');
    if (num) num.textContent = `${pct}%`;
    if (label) label.textContent = name;
    el.title = `${crit.name || name} ${pct}% used — near limit`;
    el.style.display = '';
  }

  renderSessions() {
    const list = document.getElementById('sessions-list');
    const empty = document.getElementById('empty-state');

    if (!list) return;

    const activeSessions = this.sessions.filter(s => s.status !== 'stopped');
    const appearanceKey = [
      this.cardDensity,
      this.showSessionModel ? '1' : '0',
      this.showSessionCwd ? '1' : '0',
      this.showSessionActivity ? '1' : '0',
      this.autoCollapseFinished ? '1' : '0',
      this.sessionGroupBy,
      this.feedFilterAgent,
      this.feedFilterProject
    ].join('|');
    const sessionsFp = this._sessionFingerprint(activeSessions) +
      `\x1d${this.expandedSessionId || ''}\x1d${appearanceKey}`;

    // Skip full card rebuild when content is unchanged (stops poll-driven flicker)
    if (sessionsFp === this._lastSessionsFp && list.dataset.bound === '1') {
      return;
    }
    this._lastSessionsFp = sessionsFp;

    if (activeSessions.length === 0) {
      list.innerHTML = '';
      list.dataset.bound = '0';
      this._knownSessionIds.clear();
      this._userPinnedExpand.clear();
      const toolbar = document.getElementById('sessions-toolbar');
      if (toolbar) toolbar.hidden = true;
      if (empty) empty.style.display = '';
      this.updateEmptyDetection();
      return;
    }

    if (empty) empty.style.display = 'none';
    this.updateFeedFilterOptions(activeSessions);

    // Apply ephemeral filters
    let filtered = activeSessions;
    if (this.feedFilterAgent && this.feedFilterAgent !== 'all') {
      filtered = filtered.filter((s) => s.agent === this.feedFilterAgent);
    }
    if (this.feedFilterProject && this.feedFilterProject !== 'all') {
      filtered = filtered.filter((s) => projectBase(s.cwd) === this.feedFilterProject);
    }

    // Forget fold expansions for sessions that are gone
    if (this.expandedActivityKeys.size) {
      const liveIds = new Set(activeSessions.map(s => s.id));
      for (const k of this.expandedActivityKeys) {
        const sid = k.slice(0, k.indexOf('|'));
        if (!liveIds.has(sid)) this.expandedActivityKeys.delete(k);
      }
    }
    // Forget user pins for sessions that left
    if (this._userPinnedExpand.size) {
      const liveIds = new Set(activeSessions.map(s => s.id));
      for (const id of this._userPinnedExpand) {
        if (!liveIds.has(id)) this._userPinnedExpand.delete(id);
      }
    }

    // Auto-collapse finished: drop expand when session is idle and user didn't pin it
    if (this.autoCollapseFinished && this.expandedSessionId) {
      const exp = activeSessions.find((s) => s.id === this.expandedSessionId);
      if (exp && exp.status === 'idle' && !this._userPinnedExpand.has(exp.id) && !isInAttentionQueue(exp)) {
        this.expandedSessionId = null;
      }
    }

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
    const labels = buildSessionDisambiguation(activeSessions);

    const cardOptions = (session, isNew) => ({
      animateIn: isNew,
      expandedActivity: this.expandedActivityKeys,
      density: this.cardDensity,
      showModel: this.showSessionModel,
      showCwd: this.showSessionCwd,
      showActivity: this.showSessionActivity,
      agentLabel: labels.get(session.id)?.agentLabel || session.agent,
      projectLabel: labels.get(session.id)?.project || projectBase(session.cwd)
    });

    /** @type {Array<{ label: string, variant: string, sessions: object[], hint?: string }>} */
    let groups = [];
    const groupBy = this.sessionGroupBy;

    if (groupBy === 'agent') {
      /** @type {Map<string, object[]>} */
      const map = new Map();
      for (const s of filtered) {
        const key = s.agent || 'Agent';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(s);
      }
      groups = [...map.entries()].map(([key, sess]) => ({
        label: key === 'Claude Code' ? 'Claude' : key,
        variant: 'idle',
        sessions: sess
      }));
    } else if (groupBy === 'project') {
      /** @type {Map<string, object[]>} */
      const map = new Map();
      for (const s of filtered) {
        const base = projectBase(s.cwd) || 'Unknown project';
        if (!map.has(base)) map.set(base, []);
        map.get(base).push(s);
      }
      groups = [...map.entries()]
        .sort((a, b) => {
          if (a[0] === 'Unknown project') return 1;
          if (b[0] === 'Unknown project') return -1;
          return a[0].localeCompare(b[0]);
        })
        .map(([key, sess]) => ({ label: key, variant: 'idle', sessions: sess }));
    } else {
      // status (default)
      const needsYou = filtered.filter(s => isInAttentionQueue(s));
      const ackedAttention = filtered.filter(
        s => ATTENTION_STATUSES.includes(s.status) && s.attentionAcknowledged
      );
      const running = filtered.filter(s => s.status === 'working');
      const finished = filtered.filter(
        s => !ATTENTION_STATUSES.includes(s.status) && s.status !== 'working'
      );
      if (needsYou.length) {
        groups.push({
          label: 'Needs you',
          variant: 'attention',
          sessions: needsYou,
          hint: needsYou.length > 1 ? 'Ctrl+] next · Ctrl+Shift+D clear' : ''
        });
      }
      if (ackedAttention.length) {
        groups.push({ label: 'Cleared', variant: 'acked', sessions: ackedAttention });
      }
      if (running.length) {
        groups.push({ label: 'Running', variant: 'working', sessions: running });
      }
      if (finished.length) {
        groups.push({ label: 'Finished', variant: 'idle', sessions: finished });
      }
    }

    const showSections = groups.length > 1 ||
      (groups[0] && groups[0].variant === 'attention' && groups[0].sessions.length > 1);

    let html = '';
    let idx = 0;
    if (filtered.length === 0) {
      html = `<div class="sessions-filter-empty">No sessions match this filter.</div>`;
    } else {
      for (const g of groups) {
        if (showSections && g.label) {
          html += renderSessionSectionHeader(g.label, g.sessions.length, g.variant, {
            hint: g.hint || ''
          });
        }
        html += g.sessions.map((session, i) => {
          const isNew = !prevIds.has(session.id);
          return renderSessionCard(session, idx + i, cardOptions(session, isNew));
        }).join('');
        idx += g.sessions.length;
      }
    }

    list.innerHTML = html;

    this._knownSessionIds = nextIds;
    list.dataset.bound = '1';

    // Restore expanded class / choose default expand
    const pickAutoExpandId = () => {
      // Prefer attention → working; finished only if auto-collapse is off
      const fromFiltered = filtered.length ? filtered : activeSessions;
      const att = fromFiltered.find((s) => isInAttentionQueue(s));
      if (att) return att.id;
      const work = fromFiltered.find((s) => s.status === 'working');
      if (work) return work.id;
      if (!this.autoCollapseFinished && fromFiltered[0]) return fromFiltered[0].id;
      return null;
    };

    if (this.expandedSessionId) {
      const card = list.querySelector(`.session-card[data-session-id="${CSS.escape(this.expandedSessionId)}"]`);
      if (card) {
        card.classList.add('expanded');
        card.setAttribute('aria-expanded', 'true');
      } else {
        // Filtered out or gone
        this.expandedSessionId = pickAutoExpandId();
        if (this.expandedSessionId) {
          const c = list.querySelector(`.session-card[data-session-id="${CSS.escape(this.expandedSessionId)}"]`);
          if (c) {
            c.classList.add('expanded');
            c.setAttribute('aria-expanded', 'true');
          }
        }
      }
    } else if (filtered.length > 0) {
      const autoId = pickAutoExpandId();
      if (autoId) {
        this.expandedSessionId = autoId;
        const firstCard = list.querySelector(`.session-card[data-session-id="${CSS.escape(autoId)}"]`);
        if (firstCard) {
          firstCard.classList.add('expanded');
          firstCard.setAttribute('aria-expanded', 'true');
        }
      }
    }

    // Keep fingerprint in sync after auto-expand
    this._lastSessionsFp = this._sessionFingerprint(activeSessions) +
      `\x1d${this.expandedSessionId || ''}\x1d${appearanceKey}`;

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
        // User opened a finished card — pin so auto-collapse won't close it
        const sess = activeSessions.find((s) => s.id === sessionId);
        if (sess && sess.status === 'idle') {
          this._userPinnedExpand.add(sessionId);
        } else {
          this._userPinnedExpand.delete(sessionId);
        }
        this._lastSessionsFp = this._sessionFingerprint(activeSessions) +
          `\x1d${sessionId}\x1d${appearanceKey}`;
        // Pin live feed to latest after expand
        requestAnimationFrame(() => {
          const feed = target.querySelector('.activity-live-feed');
          if (feed) feed.scrollTop = feed.scrollHeight;
        });
      } else {
        this.expandedSessionId = null;
        this._userPinnedExpand.delete(sessionId);
        this._lastSessionsFp = this._sessionFingerprint(activeSessions) +
          `\x1d\x1d${appearanceKey}`;
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
        // Inner controls (fold toggle, allow/deny, options) handle their own keys
        if (e.target.closest('button, a, input, select, textarea')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleCard(e.currentTarget);
        }
      });
    });

    // Attach inline action listeners (stopPropagation is key here so card doesn't toggle)
    list.querySelectorAll('.activity-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.activity-row');
        if (!row) return;
        const isOpen = row.classList.toggle('activity-fold-open');
        row.classList.toggle('activity-folded', !isOpen);
        btn.setAttribute('aria-expanded', String(isOpen));
        const label = btn.querySelector('.activity-toggle-label');
        if (label) label.textContent = isOpen ? 'Show less' : 'Show more';
        const key = btn.dataset.foldKey;
        if (key) {
          if (isOpen) this.expandedActivityKeys.add(key);
          else this.expandedActivityKeys.delete(key);
        }
      });
    });

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
            .then((res) => {
              // Quiet on success — stickiness is the feature; only surface failures
              if (res && res.success === false) {
                this.showToast(res.message || 'Could not focus agent', 'error');
              }
            })
            .catch((err) => this.showToast(`Jump failed: ${err.message || 'main process error'}`, 'error'));
        }
      });
    });

    list.querySelectorAll('.btn-open-folder').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cwd = btn.dataset.cwd;
        if (!cwd || !window.agentNotch?.openPath) return;
        try {
          const res = await window.agentNotch.openPath(cwd);
          if (res && res.success) {
            this.showToast('Opened project folder', 'ok');
          } else {
            this.showToast((res && res.message) || 'Could not open folder', 'error');
          }
        } catch (err) {
          this.showToast(`Open failed: ${err.message || 'error'}`, 'error');
        }
      });
    });

    list.querySelectorAll('.btn-copy-cwd').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cwd = btn.dataset.cwd;
        if (!cwd) return;
        try {
          if (window.agentNotch?.copyText) {
            const res = await window.agentNotch.copyText(cwd);
            if (res && res.success === false) {
              this.showToast(res.message || 'Copy failed', 'error');
              return;
            }
          } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(cwd);
          }
          this.showToast('Path copied', 'ok');
        } catch (err) {
          this.showToast(`Copy failed: ${err.message || 'error'}`, 'error');
        }
      });
    });

    list.querySelectorAll('.btn-dismiss').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sessionId;
        if (!sid || !window.agentNotch || !window.agentNotch.dismissSession) return;
        try {
          const res = await window.agentNotch.dismissSession(sid);
          if (res && res.success) {
            if (this.expandedSessionId === sid) this.expandedSessionId = null;
            this.showToast(res.message || 'Moved to history', 'ok');
          } else {
            this.showToast((res && res.message) || 'Could not remove session', 'error');
          }
        } catch (err) {
          this.showToast(`Remove failed: ${err.message || 'main process error'}`, 'error');
        }
      });
    });

    // Clear attention from queue (session stays)
    list.querySelectorAll('.btn-clear-attention').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sessionId;
        if (sid) this.handleDismissAttention(sid);
      });
    });

    list.querySelectorAll('.btn-restore-attention, .attention-ack-chip').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sessionId;
        if (sid) this.handleRestoreAttention(sid);
      });
    });

    // Snooze menu toggle
    list.querySelectorAll('.btn-snooze').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrap = btn.closest('.snooze-menu-wrap');
        if (!wrap) return;
        const menu = wrap.querySelector('.snooze-menu');
        if (!menu) return;
        const open = menu.hidden;
        // Close other open menus first
        list.querySelectorAll('.snooze-menu').forEach(m => {
          m.hidden = true;
          const b = m.closest('.snooze-menu-wrap')?.querySelector('.btn-snooze');
          if (b) b.setAttribute('aria-expanded', 'false');
        });
        menu.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
      });
    });

    list.querySelectorAll('.snooze-option').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sessionId;
        const preset = btn.dataset.preset;
        if (!sid || !preset || !window.agentNotch?.snoozeSession) return;
        try {
          const res = await window.agentNotch.snoozeSession(sid, preset);
          if (res && res.success) {
            this.showToast(res.message || 'Alerts muted', 'ok');
          } else {
            this.showToast((res && res.message) || 'Could not snooze', 'error');
          }
        } catch (err) {
          this.showToast(`Snooze failed: ${err.message || 'main process error'}`, 'error');
        }
      });
    });

    const clearSnooze = async (sid) => {
      if (!sid || !window.agentNotch?.clearSnooze) return;
      try {
        const res = await window.agentNotch.clearSnooze(sid);
        if (res && res.success) {
          this.showToast(res.message || 'Snooze cleared', 'ok');
        } else {
          this.showToast((res && res.message) || 'Could not clear snooze', 'error');
        }
      } catch (err) {
        this.showToast(`Clear snooze failed: ${err.message || 'main process error'}`, 'error');
      }
    };

    list.querySelectorAll('.btn-clear-snooze').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearSnooze(btn.dataset.sessionId);
      });
    });

    list.querySelectorAll('.snooze-chip').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearSnooze(btn.dataset.sessionId);
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
    list.innerHTML = renderHistoryView(this.history, this.expandedHistoryId, {
      query: this.historyQuery
    });

    // Search — preserve focus + caret across re-renders
    const searchEl = document.getElementById('history-search');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        this.historyQuery = searchEl.value || '';
        const start = searchEl.selectionStart;
        const end = searchEl.selectionEnd;
        this.renderHistory();
        const again = document.getElementById('history-search');
        if (again) {
          again.focus();
          try {
            again.setSelectionRange(start, end);
          } catch {
            // ignore
          }
        }
      });
      searchEl.addEventListener('click', (e) => e.stopPropagation());
      searchEl.addEventListener('keydown', (e) => e.stopPropagation());
    }

    // Clear history button
    const clearBtn = document.getElementById('btn-clear-history');
    if (clearBtn) {
      clearBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!this._clearHistoryPendingConfirm) {
          this._clearHistoryPendingConfirm = true;
          this.showToast('Click Clear History again to confirm', 'info');
          setTimeout(() => { this._clearHistoryPendingConfirm = false; }, 4000);
        } else {
          this._clearHistoryPendingConfirm = false;
          try {
            if (window.agentNotch) {
              await window.agentNotch.clearHistory();
            }
            this.history = [];
            this.historyQuery = '';
            this.renderHistory();
          } catch (err) {
            this.showToast(`Clear failed: ${err.message}`, 'error');
          }
        }
      });
    }

    // Pin / unpin
    list.querySelectorAll('.btn-history-pin').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.historyId;
        const nextPinned = btn.dataset.pinned !== '1';
        if (!id || !window.agentNotch?.pinHistory) return;
        try {
          const res = await window.agentNotch.pinHistory(id, nextPinned);
          if (res?.success && Array.isArray(res.history)) {
            this.history = res.history;
          } else if (res?.success) {
            this.history = await window.agentNotch.getHistory();
          } else {
            this.showToast(res?.message || 'Could not update pin', 'error');
            return;
          }
          this.renderHistory();
        } catch (err) {
          this.showToast(err.message || 'Pin failed', 'error');
        }
      });
    });

    // Continue from history
    list.querySelectorAll('.btn-history-continue').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.continueFromHistory(btn.dataset.historyId, btn);
      });
    });

    list.querySelectorAll('.history-continue-input').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', async (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          await this.continueFromHistory(input.dataset.historyId, input);
        }
      });
    });

    // Jump / focus agent
    list.querySelectorAll('.btn-history-jump').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.historyId;
        const agent = btn.dataset.agent;
        try {
          // Prefer live session jump when still present
          const live = this.sessions.find((s) => s.id === id);
          let res;
          if (live && window.agentNotch?.jumpToTerminal) {
            res = await window.agentNotch.jumpToTerminal(id);
          } else if (window.agentNotch?.focusAgent && agent) {
            res = await window.agentNotch.focusAgent(agent);
          } else {
            this.showToast('Cannot focus agent', 'error');
            return;
          }
          if (res?.success) {
            this.showToast(res.message || 'Focused', 'ok');
          } else {
            this.showToast(res?.message || 'Focus failed', 'error');
          }
        } catch (err) {
          this.showToast(err.message || 'Focus failed', 'error');
        }
      });
    });

    // Expand/collapse — ignore clicks on actions / pin / inputs
    list.querySelectorAll('.history-entry').forEach((entryEl) => {
      entryEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-stop-expand], .btn-history-pin, .history-actions, .history-continue-input, button, input')) {
          return;
        }
        e.stopPropagation();
        const id = entryEl.dataset.id;
        this.expandedHistoryId = this.expandedHistoryId === id ? null : id;
        this.renderHistory();
      });
    });
  }

  async continueFromHistory(historyId, sourceEl) {
    if (!historyId || this._historyContinuing) return;
    if (!window.agentNotch?.dispatchFromHistory) {
      this.showToast('Continue is not available', 'error');
      return;
    }

    const row = sourceEl?.closest?.('.history-entry');
    const input = row?.querySelector?.('.history-continue-input');
    const prompt = (input?.value || '').trim();

    this._historyContinuing = true;
    if (sourceEl && 'disabled' in sourceEl) sourceEl.disabled = true;
    try {
      const res = await window.agentNotch.dispatchFromHistory(historyId, prompt);
      if (res?.success) {
        this.showToast(res.message || 'Continued', 'ok');
        // Refresh sessions after headless resume/new
        if (window.agentNotch.getSessions) {
          try {
            this.sessions = (await window.agentNotch.getSessions()) || this.sessions;
          } catch {
            // ignore
          }
        }
      } else {
        this.showToast(res?.message || 'Could not continue', 'error');
      }
    } catch (err) {
      this.showToast(err.message || 'Continue failed', 'error');
    } finally {
      this._historyContinuing = false;
      if (sourceEl && 'disabled' in sourceEl) sourceEl.disabled = false;
    }
  }

  updateBadges() {
    const sessionsBadge = document.getElementById('sessions-badge');
    const activeSessions = this.sessions.filter(s => s.status !== 'stopped');
    const attentionCount = activeSessions.filter(s => isInAttentionQueue(s)).length;

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
      id: 'codex-done-1',
      agent: 'Codex',
      taskName: 'add signup validation',
      status: 'idle',
      currentTool: null,
      lastMessage: 'Added email and password validation to the register router.',
      userPrompt: 'add email and password validation to register router',
      duration: 1500000,
      durationFormatted: '25m',
      terminal: 'Terminal',
      model: 'gpt-5-codex',
      toolCalls: ['search(routes/)', 'write(routes/auth.js)']
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
    { id: 'codex', short: 'Codex', name: 'Codex', color: '#10B981', available: true, usedPercent: 88, remainingPercent: 12, plan: 'go', model: 'gpt-5.6-terra', resetsLabel: 'in 2h' },
    { id: 'cursor', short: 'Cursor', name: 'Cursor', color: '#06B6D4', available: false, usedPercent: null, note: 'Limit not available locally' },
    { id: 'antigravity', short: 'Gemini', name: 'Antigravity', color: '#4285F4', available: false, usedPercent: null },
    { id: 'grok', short: 'Grok', name: 'Grok', color: '#EF4444', available: true, usedPercent: 62, remainingPercent: 38, plan: 'X Premium', model: 'grok-4.5' }
  ];
}

/** Mock usage dashboard data for local development/preview */
function getMockUsageStats() {
  const day = (offset) => {
    const d = new Date(Date.now() - offset * 86400000);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  };
  const bucket = (offset, agent, model, input, output, cacheRead, cacheWrite, sessions, cost, costActual = false) => ({
    day: day(offset),
    agent,
    model,
    input,
    output,
    reasoning: 0,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    sessions,
    cost,
    costActual,
    costKnown: true
  });
  return {
    updatedAt: Date.now(),
    buckets: [
      bucket(0, 'Claude Code', 'claude-opus-4', 42000, 118000, 690000, 38000, 2, 3.41),
      bucket(0, 'Claude Code', 'claude-sonnet-4', 18000, 46000, 210000, 9000, 1, 0.72),
      bucket(0, 'Codex', 'gpt-5-codex', 96000, 31000, 124000, 0, 1, 0.44),
      bucket(1, 'Claude Code', 'claude-opus-4', 61000, 204000, 980000, 52000, 3, 5.18),
      bucket(1, 'OpenCode', 'gemini-2.5-pro', 130000, 48000, 0, 0, 2, 0.64, true),
      bucket(2, 'Codex', 'gpt-5-codex', 201000, 74000, 312000, 0, 2, 1.06),
      bucket(4, 'Claude Code', 'claude-sonnet-4', 30000, 88000, 410000, 21000, 2, 1.47),
      bucket(6, 'OpenCode', 'grok-code-fast', 540000, 96000, 0, 0, 1, 0.25, true)
    ],
    sessionTime: [
      { day: day(0), agent: 'Claude Code', sessions: 3, ms: 7380000 },
      { day: day(0), agent: 'Codex', sessions: 1, ms: 1740000 },
      { day: day(1), agent: 'Claude Code', sessions: 3, ms: 10500000 },
      { day: day(1), agent: 'OpenCode', sessions: 2, ms: 2760000 },
      { day: day(2), agent: 'Codex', sessions: 2, ms: 4980000 },
      { day: day(2), agent: 'Grok', sessions: 1, ms: 1500000 },
      { day: day(4), agent: 'Claude Code', sessions: 2, ms: 6120000 },
      { day: day(6), agent: 'OpenCode', sessions: 1, ms: 2280000 }
    ]
  };
}

/** Mock conversation insights for local development/preview */
function getMockInsights() {
  const rec = (offset, agent, taskName, category, area, langs, complexity, specificity, words, tools, durationMs) => {
    const ts = Date.now() - offset * 86400000 - 3600000;
    const d = new Date(ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { id: `mock-${taskName.slice(0, 12)}-${offset}`, agent, ts, day, taskName, category, area, langs, complexity, specificity, words, tools, durationMs };
  };
  return {
    updatedAt: Date.now(),
    records: [
      rec(0, 'Claude Code', 'fix auth bug', 'bugfix', 'backend', ['TypeScript'], 46, 36, 6, 9, 1620000),
      rec(0, 'Codex', 'add signup validation', 'feature', 'backend', ['JavaScript'], 38, 44, 9, 6, 1500000),
      rec(1, 'Claude Code', 'notch slide animation', 'styling', 'frontend', ['CSS', 'JavaScript'], 30, 40, 8, 5, 900000),
      rec(1, 'OpenCode', 'write parser tests', 'testing', 'backend', ['JavaScript'], 42, 52, 11, 8, 1200000),
      rec(2, 'Claude Code', 'refactor db pool', 'refactor', 'data', ['TypeScript', 'SQL'], 55, 41, 8, 12, 2100000),
      rec(3, 'Grok', 'add usage bar', 'feature', 'frontend', ['JavaScript', 'CSS'], 35, 30, 6, 7, 420000),
      rec(4, 'Codex', 'ci deploy pipeline', 'devops', 'devops', ['YAML', 'Shell'], 48, 47, 10, 6, 1500000),
      rec(5, 'Claude Code', 'plugin architecture design', 'architecture', 'backend', ['TypeScript'], 62, 58, 24, 4, 2700000),
      rec(6, 'Antigravity', 'explain watcher flow', 'exploration', 'general', [], 18, 24, 5, 2, 300000),
      rec(8, 'Claude Code', 'optimize burn chart render', 'performance', 'frontend', ['JavaScript'], 44, 50, 9, 7, 1320000),
      rec(10, 'OpenCode', 'sanitize user input', 'security', 'backend', ['Python'], 33, 46, 7, 5, 780000),
      rec(12, 'Codex', 'update readme setup', 'docs', 'docs', ['Markdown'], 16, 38, 6, 2, 480000),
      rec(14, 'Claude Code', 'users table migration', 'data', 'data', ['SQL'], 40, 49, 8, 6, 1080000),
      rec(20, 'Grok', 'fix toast z-index', 'bugfix', 'frontend', ['CSS'], 22, 33, 5, 3, 360000)
    ]
  };
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
      cwd: 'C:\\dev\\agent-notch',
      pinned: true,
      pinnedAt: Date.now() - 1000,
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
      cwd: 'C:\\dev\\webapp',
      toolCalls: ['search(routes/)', 'write(routes/auth.js)']
    },
    {
      id: 'cursor-mock-hist-3',
      agent: 'Cursor',
      taskName: 'IDE open — exploration',
      userPrompt: '',
      status: 'idle',
      durationFormatted: '—',
      lastTime: Date.now() - 172800000,
      archivedAt: Date.now() - 172800000,
      cwd: 'C:\\dev\\notes',
      toolCalls: []
    }
  ];
}

const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());
