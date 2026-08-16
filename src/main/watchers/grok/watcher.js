const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  BaseWatcher,
  parseJSONL,
  extractTaskName,
  formatDuration,
  getDurationFromFile,
  isFileActive,
  readJsonlEfficient
} = require('../base-watcher');
const { normalizePlan, taggedSessionId } = require('../session-utils');
const { GrokLogTokenIndex } = require('../../usage/grok-usage');
const { emptyUpdateState, analyzeGrokEntries } = require('./updates');
const { analyzeGrokEvents, mergeGrokStatus } = require('./events');
const { analyzeChatHistory } = require('./chat');
const { mergeUniqueTail, buildRichActivity } = require('./helpers');
const {
  readChatUserPromptHead,
  readUserPromptHead,
  readLatestTerminalSnippet
} = require('./io');

/**
 * Watches xAI Grok Build CLI session files.
 *
 * Grok stores sessions at:
 *   ~/.grok/sessions/<url-encoded-cwd>/<session-id>/
 *     - updates.jsonl   (ACP session/update stream — can be large)
 *     - events.jsonl    (lightweight phase/tool timeline)
 *     - summary.json
 *     - plan.json
 *     - terminal/*.log  (command output for run_terminal_command)
 */
class GrokWatcher extends BaseWatcher {
  constructor(options = {}) {
    super('Grok', { pollInterval: 2000, ...options });
    this.grokDir = options.grokDir || path.join(os.homedir(), '.grok');
    this.sourceTag = typeof options.sourceTag === 'string' ? options.sourceTag : '';
    /** @type {Map<string, { updates?: number, events?: number }>} */
    this._lastFileSize = new Map();
    this._tokenIndex = options.tokenIndex || new GrokLogTokenIndex();
  }

  _start() {
    const sessionsDir = path.join(this.grokDir, 'sessions');
    console.log(`[Grok] Watching ${this.grokDir}`);
    if (fs.existsSync(sessionsDir)) {
      this.watchDirs(sessionsDir);
    }
  }

  _stop() {
    this._lastFileSize.clear();
  }

  _onSessionRemoved(id) {
    this._lastFileSize.delete(id);
  }

  async _poll() {
    this._tokenIndex.update(path.join(this.grokDir, 'logs', 'unified.jsonl'));
    const sessionsDir = path.join(this.grokDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) return;

    const activeFiles = new Set();

    try {
      this._scanSessionsDir(sessionsDir, activeFiles);
    } catch {
      // Directory unreadable
    }

    for (const [id] of this.sessions) {
      if (id.startsWith('grok-') && !activeFiles.has(id)) {
        this._removeSession(id);
      }
    }
  }

  _scanSessionsDir(sessionsDir, activeFiles) {
    let cwdDirs;
    try {
      cwdDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch { return; }

    for (const cwdEntry of cwdDirs) {
      if (!cwdEntry.isDirectory()) continue;

      let cwdDecoded = '';
      try {
        cwdDecoded = decodeURIComponent(cwdEntry.name);
      } catch {
        cwdDecoded = cwdEntry.name;
      }

      const cwdPath = path.join(sessionsDir, cwdEntry.name);
      let sessionDirs;
      try {
        sessionDirs = fs.readdirSync(cwdPath, { withFileTypes: true });
      } catch { continue; }

      for (const sessionEntry of sessionDirs) {
        if (!sessionEntry.isDirectory()) continue;

        const sessionPath = path.join(cwdPath, sessionEntry.name);
        const updatesFile = path.join(sessionPath, 'updates.jsonl');
        const eventsFile = path.join(sessionPath, 'events.jsonl');

        // Prefer events mtime if present (lighter signal); fall back to updates
        const signalFile = fs.existsSync(eventsFile) ? eventsFile
          : fs.existsSync(updatesFile) ? updatesFile
            : null;
        if (!signalFile) continue;
        if (!isFileActive(signalFile, 12 * 60 * 60 * 1000)) continue;

        const sessionId = taggedSessionId('grok', sessionEntry.name, this.sourceTag);
        activeFiles.add(sessionId);

        try {
          this._processSessionDir(sessionPath, sessionId, cwdDecoded);
        } catch {
          // Skip individual session errors
        }
      }
    }
  }

  _processSessionDir(sessionPath, sessionId, cwd) {
    const updatesFile = path.join(sessionPath, 'updates.jsonl');
    const eventsFile = path.join(sessionPath, 'events.jsonl');
    const chatHistoryFile = path.join(sessionPath, 'chat_history.jsonl');
    const summaryFile = path.join(sessionPath, 'summary.json');
    const planFile = path.join(sessionPath, 'plan.json');
    const terminalDir = path.join(sessionPath, 'terminal');

    const updatesSize = safeStatSize(updatesFile);
    const eventsSize = safeStatSize(eventsFile);
    const chatSize = safeStatSize(chatHistoryFile);
    const prev = this._lastFileSize.get(sessionId) || {};

    const unchanged =
      updatesSize === (prev.updates || 0) &&
      eventsSize === (prev.events || 0) &&
      chatSize === (prev.chat || 0) &&
      this.sessions.has(sessionId);

    if (unchanged) {
      const existing = this.sessions.get(sessionId);
      const grokTok = this._tokenIndex.get(path.basename(sessionPath));
      if (grokTok && grokTok.tokens) {
        this._updateSession(sessionId, {
          ...existing,
          tokens: grokTok.tokens,
          model: existing.model || grokTok.model || null
        });
      }
      const signalFile = fs.existsSync(eventsFile) ? eventsFile : updatesFile;
      const isActive = isFileActive(signalFile, 90000);
      // Working stays working so stall detection can fire.
      // Errored (needs-attention) still settles so a hung model wait does not
      // pin the notch forever after the files go cold.
      if (!isActive && existing.status === 'needs-attention') {
        this._updateSession(sessionId, {
          ...existing,
          status: 'idle',
          currentTool: null,
          permissionRequest: null,
          isActive: false
        });
      }
      return;
    }

    this._lastFileSize.set(sessionId, {
      updates: updatesSize,
      events: eventsSize,
      chat: chatSize
    });

    // ── summary ──────────────────────────────────────
    let summaryTitle = '';
    let summary = null;
    let model = null;
    try {
      if (fs.existsSync(summaryFile)) {
        summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'));
        summaryTitle =
          summary.generated_title ||
          summary.session_summary ||
          summary.title ||
          summary.name ||
          '';
        model =
          summary.current_model_id ||
          summary.model_id ||
          summary.model ||
          null;
      }
    } catch {
      // No summary available
    }

    // ── plan.json ────────────────────────────────────
    let planFromFile = [];
    try {
      if (fs.existsSync(planFile)) {
        const planData = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
        const items = planData.items || planData.steps || planData.todos || planData;
        planFromFile = normalizePlan(Array.isArray(items) ? items : []);
      }
    } catch {
      // ignore
    }

    // ── chat_history.jsonl (best source for full agent text) ──
    let chatState = null;
    if (fs.existsSync(chatHistoryFile)) {
      const chatRead = readJsonlEfficient(chatHistoryFile, 800_000, 400_000);
      if (chatRead) {
        chatState = analyzeChatHistory(parseJSONL(chatRead.content));
        // User prompt is near the start — recover from head if we only tailed
        if (!chatRead.full && !chatState.userPrompt) {
          const headPrompt = readChatUserPromptHead(chatHistoryFile);
          if (headPrompt) chatState.userPrompt = headPrompt;
        }
      }
    }

    // ── events.jsonl (authoritative lightweight status) ──
    let eventState = null;
    if (fs.existsSync(eventsFile)) {
      const eventsRead = readJsonlEfficient(eventsFile, 500_000, 200_000);
      if (eventsRead) {
        eventState = analyzeGrokEvents(parseJSONL(eventsRead.content));
        if (eventState && eventState.model) {
          model = eventState.model;
        }
      }
    }

    // ── updates.jsonl (ACP stream: tools, messages) ──
    // Tail only — full files can be 10MB+ of streaming tool output.
    let updateState = emptyUpdateState();
    if (fs.existsSync(updatesFile)) {
      const updatesRead = readJsonlEfficient(updatesFile, 1_200_000, 600_000);
      if (updatesRead) {
        updateState = analyzeGrokEntries(
          parseJSONL(updatesRead.content),
          sessionId,
          updatesFile,
          getDurationFromFile(updatesFile),
          summaryTitle
        );
        // Large files: user prompt is usually near the start — recover it
        if (!updatesRead.full && !updateState.userPrompt) {
          const headPrompt = readUserPromptHead(updatesFile);
          if (headPrompt) updateState.userPrompt = headPrompt;
        }
      }
    }

    // ── terminal output snippet ──────────────────────
    const terminalSnippet = readLatestTerminalSnippet(terminalDir);

    // Merge status carefully: completion (idle) must not be overwritten by a
    // leftover "working" signal from tools/phases that predate turn_ended.
    const signalFile = fs.existsSync(eventsFile) ? eventsFile
      : fs.existsSync(updatesFile) ? updatesFile
        : chatHistoryFile;
    const fileTimes = getDurationFromFile(signalFile || sessionPath);
    const isActive = signalFile ? isFileActive(signalFile, 90000) : false;

    const merged = mergeGrokStatus({ eventState, updateState, isActive });
    let { status, currentTool, permissionRequest } = merged;

    if (eventState && eventState.toolCalls && eventState.toolCalls.length) {
      updateState.toolCalls = mergeUniqueTail(
        updateState.toolCalls || [],
        eventState.toolCalls,
        24
      );
    }
    if (chatState && chatState.toolCalls && chatState.toolCalls.length) {
      updateState.toolCalls = mergeUniqueTail(
        updateState.toolCalls || [],
        chatState.toolCalls,
        24
      );
    }

    // While working, prefer live streaming updates; when idle, prefer complete chat_history text
    const live = status === 'working' || status === 'permission-request' || status === 'question';
    const lastMessage = live
      ? (updateState.lastMessage ||
        (chatState && chatState.lastMessage) ||
        (eventState && eventState.phaseLabel) ||
        '')
      : ((chatState && chatState.lastMessage) ||
        updateState.lastMessage ||
        (eventState && eventState.phaseLabel) ||
        '');

    const userPrompt =
      (chatState && chatState.userPrompt) ||
      updateState.userPrompt ||
      '';

    const recentMessages = live
      ? ((updateState.recentMessages && updateState.recentMessages.length
        ? updateState.recentMessages
        : chatState && chatState.recentMessages) || [])
      : ((chatState && chatState.recentMessages && chatState.recentMessages.length
        ? chatState.recentMessages
        : updateState.recentMessages) || []);

    const recentThoughts = (updateState.recentThoughts && updateState.recentThoughts.length)
      ? updateState.recentThoughts
      : [];
    const lastThought = updateState.lastThought || '';

    const activity = buildRichActivity({
      lastMessage,
      recentMessages,
      recentThoughts,
      lastThought,
      toolCalls: updateState.toolCalls,
      toolDetails: updateState.toolDetails,
      terminalSnippet,
      phaseLabel: eventState && eventState.phaseLabel,
      status,
      at: fileTimes.lastTime
    });

    const grokTok = this._tokenIndex.get(path.basename(sessionPath));
    const startTime = updateState.startTime || fileTimes.startTime ||
      (summary && summary.created_at ? Date.parse(summary.created_at) : null);
    const lastTime = fileTimes.lastTime || updateState.lastTime;
    const duration = startTime && lastTime ? Math.max(0, lastTime - startTime) : 0;

    const taskName =
      summaryTitle ||
      updateState.taskName ||
      (userPrompt ? extractTaskName(userPrompt) : '') ||
      'Grok session';

    this._updateSession(sessionId, {
      taskName,
      status,
      currentTool: status === 'idle' ? null : currentTool,
      lastMessage: lastMessage ? String(lastMessage).substring(0, 2000) : '',
      userPrompt: userPrompt ? String(userPrompt).substring(0, 600) : '',
      permissionRequest: status === 'permission-request' ? permissionRequest : null,
      question: updateState.question || null,
      duration,
      durationFormatted: formatDuration(duration),
      startTime,
      lastTime,
      lastActivityAt: lastTime,
      terminal: 'Terminal',
      toolCalls: (updateState.toolCalls || []).slice(-24),
      activity,
      plan: (planFromFile.length ? planFromFile : updateState.plan) || [],
      isActive: status === 'working' || status === 'permission-request' || status === 'question',
      cwd: cwd || (summary && summary.info && summary.info.cwd) || null,
      model: model || (grokTok && grokTok.model) || null,
      tokens: (grokTok && grokTok.tokens) || null,
      resumeId: path.basename(sessionPath),
      sourceTag: this.sourceTag || ''
    });
  }
}

function safeStatSize(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

module.exports = { GrokWatcher };
