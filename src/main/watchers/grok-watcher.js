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
} = require('./base-watcher');
const { getText, normalizePlan, buildActivity } = require('./session-utils');

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
    /** @type {Map<string, { updates?: number, events?: number }>} */
    this._lastFileSize = new Map();
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

        const sessionId = `grok-${sessionEntry.name}`;
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
      const signalFile = fs.existsSync(eventsFile) ? eventsFile : updatesFile;
      const isActive = isFileActive(signalFile, 90000);
      if (!isActive && (existing.status === 'working' || existing.status === 'permission-request')) {
        this._updateSession(sessionId, {
          ...existing,
          status: 'idle',
          currentTool: null,
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
      model: model || null
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

function emptyUpdateState() {
  return {
    taskName: '',
    status: 'idle',
    currentTool: null,
    lastMessage: '',
    userPrompt: '',
    permissionRequest: null,
    question: null,
    startTime: null,
    lastTime: null,
    toolCalls: [],
    toolDetails: [],
    recentMessages: [],
    recentThoughts: [],
    lastThought: '',
    plan: [],
    isActive: false,
    turnComplete: false
  };
}

/**
 * Merge events + updates into a single live status.
 * Completion (idle) wins over leftover tool/phase "working" signals.
 */
function mergeGrokStatus({ eventState, updateState, isActive }) {
  let status = updateState.status || 'idle';
  let currentTool = updateState.currentTool || null;
  let permissionRequest = updateState.permissionRequest || null;

  const eventStatus = eventState && eventState.status;
  const eventIdle = eventStatus === 'idle' || (eventState && eventState.turnComplete);
  const updateIdle = updateState.status === 'idle' || updateState.turnComplete;

  if (eventState) {
    if (eventState.permissionRequest) {
      permissionRequest = eventState.permissionRequest;
    }

    if (eventStatus === 'permission-request') {
      status = 'permission-request';
    } else if (eventStatus === 'needs-attention') {
      status = 'needs-attention';
    } else if (eventIdle || updateIdle) {
      // Either source reporting turn complete → idle (do not keep working)
      status = 'idle';
      currentTool = null;
      permissionRequest = null;
    } else if (eventStatus === 'working' || updateState.status === 'working') {
      status = 'working';
    }

    // Tool label: only while still working / awaiting permission
    if (status === 'working' || status === 'permission-request') {
      if (eventState.currentTool) {
        const eventTool = eventState.currentTool;
        const updateTool = updateState.currentTool || '';
        if (
          updateTool &&
          (updateTool === eventTool ||
            updateTool.startsWith(eventTool + ':') ||
            updateTool.startsWith(eventTool + ' '))
        ) {
          currentTool = updateTool;
        } else if (eventTool.includes('…') || eventTool.includes('...')) {
          currentTool = updateTool || eventTool;
        } else {
          currentTool = eventTool;
        }
      }
    }
  } else if (updateIdle) {
    status = 'idle';
    currentTool = null;
  }

  // Stale files: if nothing has been written recently, force idle
  if (!isActive && (status === 'working' || status === 'permission-request')) {
    status = 'idle';
    currentTool = null;
    permissionRequest = null;
  }

  if (status === 'idle') {
    currentTool = null;
  }

  return { status, currentTool, permissionRequest };
}

/**
 * Parse ACP-style Grok updates.jsonl entries.
 * Supports both native ACP session/update envelopes and legacy flat shapes.
 */
function analyzeGrokEntries(entries, sessionId, filePath, fileTimes, summaryTitle = '') {
  let taskName = summaryTitle || '';
  let status = 'idle';
  let currentTool = null;
  let lastMessage = '';
  let userPrompt = '';
  let startTime = null;
  let lastTime = null;
  let toolCalls = [];
  /** @type {Array<{name:string, detail?:string, at?:number}>} */
  let toolDetails = [];
  /** @type {Array<{text:string, at?:number}>} */
  let recentMessages = [];
  /** @type {Array<{text:string, at?:number}>} */
  let recentThoughts = [];
  let plan = [];
  let permissionRequest = null;
  let question = null;
  let messageBuf = '';
  let thoughtBuf = '';
  let userBuf = '';
  let turnComplete = false;

  const flushMessageBuf = (at) => {
    const text = messageBuf.trim();
    if (!text) return;
    // Keep a longer window for the live activity feed (still capped)
    lastMessage = text.length > 4000 ? text.slice(-4000) : text;
    recentMessages.push({ text: lastMessage, at });
    if (recentMessages.length > 24) recentMessages = recentMessages.slice(-24);
    messageBuf = '';
  };

  const flushThoughtBuf = (at) => {
    const text = thoughtBuf.trim();
    if (!text) return;
    const capped = text.length > 3000 ? text.slice(-3000) : text;
    recentThoughts.push({ text: capped, at });
    if (recentThoughts.length > 20) recentThoughts = recentThoughts.slice(-20);
    thoughtBuf = '';
  };

  for (const entry of entries) {
    const ts = resolveTimestamp(entry);
    if (ts) {
      if (!startTime || ts < startTime) startTime = ts;
      if (!lastTime || ts > lastTime) lastTime = ts;
    }

    // ── ACP envelope: method session/update (or _x.ai/session/update) ──
    const update = getAcpUpdate(entry);
    if (update) {
      const kind = update.sessionUpdate || update.type || '';
      const at = ts || lastTime;

      if (kind === 'user_message_chunk') {
        const text = extractChunkText(update);
        if (text) {
          // New user turn — previous turn is no longer complete
          turnComplete = false;
          userBuf += text;
          userPrompt = userBuf;
          if (!taskName) taskName = extractTaskName(userPrompt);
          status = 'working';
        }
        continue;
      }

      if (kind === 'agent_message_chunk') {
        const text = extractChunkText(update);
        if (text) {
          // Visible reply starts — seal any prior thinking segment
          flushThoughtBuf(at);
          turnComplete = false;
          messageBuf += text;
          // Soft cap buffer while streaming; final text still flushed on tool/turn end
          if (messageBuf.length > 12000) {
            messageBuf = messageBuf.slice(-8000);
          }
          lastMessage = messageBuf.trim().length > 4000
            ? messageBuf.trim().slice(-4000)
            : messageBuf.trim();
          status = 'working';
        }
        continue;
      }

      if (kind === 'agent_thought_chunk') {
        // Reasoning stream — same source the agent UI shows as "thinking"
        const text = extractChunkText(update);
        if (text) {
          turnComplete = false;
          thoughtBuf += text;
          if (thoughtBuf.length > 10000) {
            thoughtBuf = thoughtBuf.slice(-8000);
          }
          status = 'working';
        } else {
          turnComplete = false;
          status = 'working';
        }
        continue;
      }

      if (kind === 'tool_call') {
        flushThoughtBuf(at);
        flushMessageBuf(at);
        const name = extractToolName(update);
        const input = update.rawInput || update.input || update.arguments;
        const detail = formatToolInput(name, input);
        const filePath = extractToolFilePath(input);
        currentTool = detail || name;
        toolCalls.push(name);
        toolDetails.push({
          name,
          detail: detail || name,
          filePath: filePath || undefined,
          kind: classifyToolKind(name, input),
          at
        });
        if (toolDetails.length > 40) toolDetails = toolDetails.slice(-40);
        turnComplete = false;
        status = 'working';
        continue;
      }

      if (kind === 'tool_call_update') {
        const st = (update.status || '').toLowerCase();
        if (st === 'in_progress' || st === 'pending' || st === 'running') {
          turnComplete = false;
          status = 'working';
          if (!currentTool && update.title) currentTool = update.title;
        } else if (st === 'completed' || st === 'failed' || st === 'cancelled' || st === 'error') {
          // Stay working until the turn ends
          turnComplete = false;
          status = 'working';
        }
        continue;
      }

      if (kind === 'plan' || kind === 'plan_update') {
        const items = update.entries || update.items || update.plan || update.content;
        if (Array.isArray(items)) plan = normalizePlan(items);
        turnComplete = false;
        status = 'working';
        continue;
      }

      if (kind === 'task_backgrounded') {
        flushThoughtBuf(at);
        flushMessageBuf(at);
        const cmd = update.command || update.title || 'background task';
        currentTool = `run_terminal_command: ${truncate(String(cmd), 100)}`;
        toolCalls.push('run_terminal_command');
        toolDetails.push({
          name: 'run_terminal_command',
          detail: currentTool,
          kind: 'terminal',
          at
        });
        if (toolDetails.length > 40) toolDetails = toolDetails.slice(-40);
        turnComplete = false;
        status = 'working';
        continue;
      }

      if (kind === 'permission_request' || kind === 'confirmation_request') {
        flushThoughtBuf(at);
        turnComplete = false;
        status = 'permission-request';
        permissionRequest = {
          tool: update.tool || update.toolName || update.title || 'tool',
          filePath: update.file_path || update.filePath || '',
          input: update.rawInput || update.input || null
        };
        continue;
      }

      // Turn finished — Grok emits this on the updates stream (not events.jsonl)
      if (kind === 'turn_completed' || kind === 'turn_ended' || kind === 'session_ended') {
        flushThoughtBuf(at);
        flushMessageBuf(at);
        turnComplete = true;
        status = 'idle';
        currentTool = null;
        permissionRequest = null;
        continue;
      }

      // Recap arrives after completion — treat as idle and prefer its summary text
      if (kind === 'session_recap') {
        flushThoughtBuf(at);
        flushMessageBuf(at);
        const summaryText = update.summary || update.text || extractChunkText(update);
        if (summaryText) {
          lastMessage = String(summaryText).trim().slice(0, 4000);
          recentMessages.push({ text: lastMessage, at });
          if (recentMessages.length > 24) recentMessages = recentMessages.slice(-24);
        }
        turnComplete = true;
        status = 'idle';
        currentTool = null;
        continue;
      }

      // Unknown ACP kinds: only treat as working if we are mid-turn
      if (kind && !turnComplete) {
        status = 'working';
      }
      continue;
    }

    // ── Legacy / flat entry shapes ───────────────────
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
    const entryType = entry.type || payload.type || '';
    const role = payload.role || entry.role || '';

    if (role === 'user' || entryType === 'user' || entryType === 'human' || entryType === 'user_message') {
      const content = getText(payload.content || entry.content || payload.message || entry.message);
      if (!userPrompt && content) {
        userPrompt = content;
        if (!taskName) taskName = extractTaskName(content);
      }
    }

    if (role === 'assistant' || entryType === 'assistant' || entryType === 'agent_message' || entryType === 'response') {
      const content = getText(payload.content || entry.content || payload.message || entry.message);
      if (content) {
        lastMessage = content.length > 2000 ? content.slice(-2000) : content;
        recentMessages.push({ text: lastMessage, at: ts });
        if (recentMessages.length > 24) recentMessages = recentMessages.slice(-24);
        status = 'working';
        turnComplete = false;
      }

      const tc = payload.tool_calls || payload.function_calls || entry.tool_calls || entry.function_calls || [];
      if (Array.isArray(tc) && tc.length > 0) {
        const lastTool = tc[tc.length - 1];
        const name = lastTool.function?.name || lastTool.name || lastTool.type || 'tool';
        const args = lastTool.function?.arguments || lastTool.arguments || lastTool.input || lastTool.rawInput;
        let parsedArgs = args;
        if (typeof args === 'string') {
          try { parsedArgs = JSON.parse(args); } catch { parsedArgs = null; }
        }
        const detail = formatToolInput(name, parsedArgs) || name;
        currentTool = detail;
        toolCalls.push(name);
        toolDetails.push({
          name,
          detail,
          filePath: extractToolFilePath(parsedArgs) || undefined,
          kind: classifyToolKind(name, parsedArgs),
          at: ts
        });
        if (toolDetails.length > 40) toolDetails = toolDetails.slice(-40);
        status = 'working';
        turnComplete = false;
      }

      if (payload.finish_reason === 'stop' || payload.stop_reason === 'end_turn' ||
          entryType === 'task_complete' || entryType === 'done' || payload.done === true) {
        turnComplete = true;
        status = 'idle';
        currentTool = null;
      }
    }

    if (entryType === 'tool_call' || entryType === 'function_call' || entryType === 'tool_use') {
      const name = payload.name || payload.function?.name || entry.name || 'tool';
      const input = payload.input || payload.arguments || payload.rawInput || entry.input;
      const detail = formatToolInput(name, input) || name;
      currentTool = detail;
      toolCalls.push(name);
      toolDetails.push({
        name,
        detail,
        filePath: extractToolFilePath(input) || undefined,
        kind: classifyToolKind(name, input),
        at: ts
      });
      if (toolDetails.length > 40) toolDetails = toolDetails.slice(-40);
      status = 'working';
    }

    if (role === 'tool' || entryType === 'tool_result' || entryType === 'function_call_output') {
      status = 'working';
    }

    if (entryType === 'permission_request' || entryType === 'confirmation_request') {
      status = 'permission-request';
      permissionRequest = {
        tool: payload.tool || payload.name || 'tool',
        filePath: payload.file_path || '',
        input: payload.input || null
      };
    }

    const candidatePlan = payload.plan || entry.plan || (entryType === 'plan_update' ? payload.items : null);
    if (Array.isArray(candidatePlan)) plan = normalizePlan(candidatePlan);
  }

  // Flush completed streams; keep open thoughtBuf as live lastThought mid-turn
  if (turnComplete) {
    flushThoughtBuf(lastTime);
  }
  flushMessageBuf(lastTime);

  const liveThought = thoughtBuf.trim()
    ? (thoughtBuf.trim().length > 3000 ? thoughtBuf.trim().slice(-3000) : thoughtBuf.trim())
    : '';

  const isActive = filePath ? isFileActive(filePath, 90000) : true;
  if (turnComplete) {
    status = 'idle';
    currentTool = null;
  } else if (!isActive && status === 'working') {
    status = 'idle';
    currentTool = null;
  }

  if (!startTime) startTime = fileTimes.startTime;
  if (!lastTime) lastTime = fileTimes.lastTime;
  const duration = startTime && lastTime ? lastTime - startTime : 0;

  // Dedupe tool lists, keep a long recent window for the live feed
  toolCalls = uniqueTail(toolCalls, 24);
  toolDetails = toolDetails.slice(-40);

  return {
    taskName: taskName || 'Grok session',
    status,
    currentTool,
    lastMessage: lastMessage ? lastMessage.substring(0, 4000) : '',
    userPrompt: userPrompt ? userPrompt.substring(0, 600) : '',
    permissionRequest,
    question,
    duration,
    durationFormatted: formatDuration(duration),
    startTime,
    lastTime,
    lastActivityAt: fileTimes.lastTime,
    terminal: 'Terminal',
    toolCalls,
    toolDetails,
    recentMessages,
    recentThoughts,
    lastThought: liveThought,
    activity: buildRichActivity({
      lastMessage,
      recentMessages,
      recentThoughts,
      lastThought: liveThought,
      toolCalls,
      toolDetails,
      status,
      at: fileTimes.lastTime
    }),
    plan,
    isActive: status === 'working' || status === 'permission-request',
    turnComplete
  };
}

/**
 * Lightweight timeline from events.jsonl.
 */
function analyzeGrokEvents(entries) {
  let status = null;
  let currentTool = null;
  let phase = null;
  let phaseLabel = null;
  let permissionRequest = null;
  const toolCalls = [];
  let pendingPermission = null;
  let turnComplete = false;
  let model = null;

  for (const entry of entries) {
    const type = entry.type || '';
    const toolName = entry.tool_name || entry.toolName || entry.tool || null;
    if (entry.model_id || entry.modelId || entry.model) {
      model = entry.model_id || entry.modelId || entry.model;
    }

    switch (type) {
      case 'phase_changed':
        phase = entry.phase || phase;
        phaseLabel = phaseToLabel(phase);
        if (phase === 'permission_prompt') {
          turnComplete = false;
          status = 'permission-request';
        } else if (
          phase === 'tool_execution' ||
          phase === 'streaming_reasoning' ||
          phase === 'streaming_response' ||
          phase === 'streaming_text' ||
          phase === 'streaming' ||
          phase === 'waiting_for_model' ||
          phase === 'planning'
        ) {
          // Active model/tool work — but do not un-complete a finished turn
          // solely because the last phase event was streaming_text before turn_ended
          if (!turnComplete) {
            status = 'working';
          }
        } else if (phase === 'idle' || phase === 'done' || phase === 'completed') {
          turnComplete = true;
          status = 'idle';
          currentTool = null;
        }
        break;

      case 'tool_started':
        turnComplete = false;
        if (toolName) {
          currentTool = toolName;
          toolCalls.push(toolName);
        }
        status = 'working';
        break;

      case 'tool_completed':
        if (!turnComplete) {
          // Keep showing last tool until the turn ends
          if (toolName) currentTool = toolName;
          status = 'working';
        }
        break;

      case 'permission_requested':
        turnComplete = false;
        status = 'permission-request';
        pendingPermission = {
          tool: toolName || 'tool',
          filePath: entry.file_path || '',
          input: entry.input || null
        };
        permissionRequest = pendingPermission;
        if (toolName) currentTool = toolName;
        break;

      case 'permission_resolved':
        permissionRequest = null;
        pendingPermission = null;
        // After allow/deny, stay working unless the turn already completed
        if (!turnComplete) {
          if (entry.decision === 'deny' || entry.decision === 'denied') {
            // Deny may end the tool attempt but agent often continues
            status = 'working';
          } else {
            status = 'working';
          }
        }
        break;

      case 'turn_started':
      case 'loop_started':
      case 'first_token':
        turnComplete = false;
        status = 'working';
        if (entry.model_id || entry.modelId || entry.model) {
          model = entry.model_id || entry.modelId || entry.model;
        }
        break;

      // Grok Build emits turn_ended (not turn_completed) on events.jsonl
      case 'turn_ended':
      case 'turn_completed':
      case 'session_ended': {
        const outcome = (entry.outcome || entry.stop_reason || '').toLowerCase();
        // cancelled / error still means the turn is done from the notch's perspective
        turnComplete = true;
        status = outcome === 'error' || outcome === 'failed' ? 'needs-attention' : 'idle';
        currentTool = null;
        permissionRequest = null;
        pendingPermission = null;
        break;
      }

      case 'error':
        status = 'needs-attention';
        break;

      default:
        break;
    }
  }

  // If the last phase is permission and never resolved, keep it
  if (!turnComplete && phase === 'permission_prompt' && pendingPermission) {
    status = 'permission-request';
    permissionRequest = pendingPermission;
  }

  // When turn completed, never surface a stale tool/phase as current work
  if (turnComplete) {
    status = status === 'needs-attention' ? 'needs-attention' : 'idle';
    currentTool = null;
  } else if (status === 'working' && !currentTool && phaseLabel) {
    currentTool = phaseLabel;
  }

  return {
    status,
    currentTool,
    phase,
    phaseLabel,
    permissionRequest,
    toolCalls: uniqueTail(toolCalls, 8),
    turnComplete,
    model
  };
}

function getAcpUpdate(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.params && entry.params.update && typeof entry.params.update === 'object') {
    return entry.params.update;
  }
  if (entry.update && typeof entry.update === 'object' && entry.update.sessionUpdate) {
    return entry.update;
  }
  if (entry.sessionUpdate) return entry;
  return null;
}

function extractChunkText(update) {
  if (!update) return '';
  if (typeof update.content === 'string') return update.content;
  if (update.content && typeof update.content === 'object') {
    if (typeof update.content.text === 'string') return update.content.text;
    return getText(update.content);
  }
  if (typeof update.text === 'string') return update.text;
  return getText(update.message || update.delta);
}

function extractToolName(update) {
  if (!update) return 'tool';
  const metaTool = update._meta && (update._meta['x.ai/tool'] || update._meta.tool);
  if (metaTool && metaTool.name) return metaTool.name;
  if (update.title) return String(update.title);
  if (update.name) return String(update.name);
  if (update.toolName) return String(update.toolName);
  return 'tool';
}

function formatToolInput(name, input) {
  if (!input || typeof input !== 'object') return name;
  const cmd = input.command || input.cmd;
  if (cmd) return `${name}: ${truncate(String(cmd).replace(/\s+/g, ' '), 120)}`;

  const file =
    input.target_file ||
    input.target_directory ||
    input.file_path ||
    input.path ||
    input.url ||
    input.cwd;
  if (file) {
    // Keep enough path context so the feed feels like the terminal
    const norm = String(file).replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    const base = parts.length > 3 ? parts.slice(-3).join('/') : parts.join('/');
    return `${name}: ${truncate(base, 80)}`;
  }

  if (input.pattern) return `${name}: ${truncate(String(input.pattern), 64)}`;
  if (input.query) return `${name}: ${truncate(String(input.query), 64)}`;
  if (input.prompt) return `${name}: ${truncate(String(input.prompt), 64)}`;
  if (input.old_string) {
    const target = input.file_path || input.target_file || input.path;
    if (target) {
      const base = String(target).replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
      return `${name}: ${base}`;
    }
    return `${name}: edit`;
  }
  if (input.content && typeof input.content === 'string') {
    return `${name}: write ${truncate(String(input.content).split('\n')[0], 48)}`;
  }

  return name;
}

/** Best-effort file path from tool input for the activity feed. */
function extractToolFilePath(input) {
  if (!input || typeof input !== 'object') return '';
  const file =
    input.target_file ||
    input.target_directory ||
    input.file_path ||
    input.path ||
    input.url ||
    '';
  return file ? String(file) : '';
}

/** Classify tool for UI row styling (file / terminal / search / tool). */
function classifyToolKind(name, input) {
  const n = String(name || '').toLowerCase();
  if (
    n.includes('terminal') ||
    n.includes('bash') ||
    n.includes('shell') ||
    n === 'run' ||
    n === 'exec' ||
    (input && (input.command || input.cmd))
  ) {
    return 'terminal';
  }
  if (
    n.includes('search_replace') ||
    n.includes('write') ||
    n.includes('edit') ||
    n.includes('str_replace') ||
    n.includes('read_file') ||
    n.includes('read') ||
    n.includes('apply_patch') ||
    n.includes('create_file') ||
    (input && (input.target_file || input.file_path || input.old_string || input.content))
  ) {
    return 'file';
  }
  if (n.includes('grep') || n.includes('search') || n.includes('glob') || n.includes('find')) {
    return 'search';
  }
  return 'tool';
}

function phaseToLabel(phase) {
  if (!phase) return null;
  const map = {
    tool_execution: 'Running tools…',
    streaming_reasoning: 'Thinking…',
    streaming_response: 'Responding…',
    streaming_text: 'Responding…',
    streaming: 'Streaming…',
    waiting_for_model: 'Waiting for model…',
    permission_prompt: 'Awaiting permission',
    planning: 'Planning…',
    idle: 'Idle',
    done: 'Done',
    completed: 'Done'
  };
  return map[phase] || phase.replace(/_/g, ' ');
}

function resolveTimestamp(entry) {
  // ACP uses unix seconds sometimes (e.g. 1784375341)
  const candidates = [
    entry.timestamp,
    entry.created_at,
    entry.ts,
    entry.time,
    entry.params && entry.params._meta && entry.params._meta.agentTimestampMs,
    entry._meta && entry._meta.agentTimestampMs
  ];
  for (const ts of candidates) {
    if (ts == null) continue;
    if (typeof ts === 'number') {
      // ms if > year 2001 in ms, else treat as seconds
      return ts > 1e12 ? ts : ts * 1000;
    }
    const t = new Date(ts).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  return null;
}

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function uniqueTail(arr, n) {
  const out = [];
  const seen = new Set();
  for (let i = arr.length - 1; i >= 0 && out.length < n; i--) {
    const v = arr[i];
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.unshift(v);
  }
  return out;
}

function mergeUniqueTail(a, b, n) {
  return uniqueTail([...(a || []), ...(b || [])], n);
}

function buildRichActivity({
  lastMessage,
  recentMessages,
  recentThoughts,
  lastThought,
  toolCalls,
  toolDetails,
  terminalSnippet,
  phaseLabel,
  status,
  at
}) {
  /** @type {Array<{text:string, at?:number, kind?:string, filePath?:string, tool?:string}>} */
  const activity = [];

  const cleanText = (raw, max = 2500) => {
    const cleaned = String(raw || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    if (!cleaned) return '';
    return cleaned.length > max ? cleaned.slice(-max) : cleaned;
  };

  // Reasoning / thinking segments (what the agent UI shows as thinking)
  const thoughts = Array.isArray(recentThoughts) ? recentThoughts.slice(-16) : [];
  for (const t of thoughts) {
    const text = cleanText(typeof t === 'string' ? t : t.text, 2500);
    if (!text) continue;
    activity.push({
      text,
      at: (typeof t === 'object' && t.at) || at,
      kind: 'thinking'
    });
  }

  // Live thinking buffer not yet sealed into recentThoughts
  if (lastThought) {
    const live = cleanText(lastThought, 2500);
    const lastThink = [...activity].reverse().find(a => a.kind === 'thinking');
    const lastText = lastThink ? lastThink.text : '';
    if (live && live !== lastText && !lastText.endsWith(live) && !live.endsWith(lastText)) {
      activity.push({ text: live, at, kind: 'thinking' });
    } else if (live && lastThink && live.length > lastText.length && live.startsWith(lastText.slice(0, 40))) {
      lastThink.text = live;
      lastThink.at = at;
    } else if (live && !lastThink) {
      activity.push({ text: live, at, kind: 'thinking' });
    }
  }

  // Full chronological tool stream (file edits, reads, terminal, search)
  const details = Array.isArray(toolDetails) ? toolDetails.slice(-36) : [];
  if (details.length) {
    for (const d of details) {
      activity.push({
        text: d.detail || `Used ${d.name}`,
        at: d.at || at,
        kind: d.kind || classifyToolKind(d.name),
        filePath: d.filePath,
        tool: d.name
      });
    }
  } else {
    for (const tool of (toolCalls || []).slice(-16)) {
      activity.push({
        text: String(tool),
        at,
        kind: classifyToolKind(tool),
        tool: String(tool)
      });
    }
  }

  if (terminalSnippet) {
    // Always surface the latest terminal output when present
    activity.push({
      text: truncate(String(terminalSnippet).replace(/\s+/g, ' '), 400),
      at,
      kind: 'terminal',
      tool: 'run_terminal_command'
    });
  }

  const msgs = Array.isArray(recentMessages) && recentMessages.length
    ? recentMessages.slice(-16)
    : [];

  for (const m of msgs) {
    const text = cleanText(typeof m === 'string' ? m : (m.text || ''), 2500);
    if (!text) continue;
    activity.push({
      text,
      at: (typeof m === 'object' && m.at) || at,
      kind: 'message'
    });
  }

  // Live streaming text may not be flushed into recentMessages yet
  if (lastMessage) {
    const live = cleanText(lastMessage, 2500);
    const lastMsgEntry = [...activity].reverse().find(a => a.kind === 'message');
    const lastText = lastMsgEntry ? lastMsgEntry.text : '';
    if (live && live !== lastText && !lastText.endsWith(live) && !live.endsWith(lastText)) {
      activity.push({ text: live, at, kind: 'message' });
    } else if (live && lastMsgEntry && live.length > lastText.length && live.startsWith(lastText.slice(0, 40))) {
      // Replace stale shorter message with longer streamed version
      lastMsgEntry.text = live;
      lastMsgEntry.at = at;
    } else if (live && !lastMsgEntry) {
      activity.push({ text: live, at, kind: 'message' });
    }
  }

  const hasThoughts = thoughts.length > 0 || Boolean(lastThought);
  if (!activity.length && phaseLabel) {
    activity.push({ text: phaseLabel, at, kind: 'phase' });
  } else if (status === 'working' && phaseLabel && !details.length && !msgs.length && !hasThoughts) {
    activity.push({ text: phaseLabel, at, kind: 'phase' });
  }

  // Sort chronologically when timestamps exist; stable for missing at
  activity.sort((a, b) => {
    const ta = a.at || 0;
    const tb = b.at || 0;
    if (ta !== tb) return ta - tb;
    // thinking → tools → terminal → visible message (agent-UI order)
    const rank = { phase: 0, thinking: 1, tool: 2, file: 2, search: 2, terminal: 3, message: 4 };
    return (rank[a.kind] || 2) - (rank[b.kind] || 2);
  });

  // Keep a long live window (UI scrolls)
  return activity.slice(-56);
}

/**
 * Parse Grok chat_history.jsonl for full assistant replies and user prompts.
 * This is the best source of complete agent text (updates stream is chunked/tailed).
 */
function analyzeChatHistory(entries) {
  let userPrompt = '';
  let lastMessage = '';
  /** @type {Array<{text:string, at?:number}>} */
  let recentMessages = [];
  const toolCalls = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const type = entry.type || entry.role || '';

    if (type === 'user') {
      const text = getText(entry.content || entry.message);
      if (!text) continue;
      // Prefer explicit user_query blocks; skip system reminders / user_info
      const queryMatch = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
      if (queryMatch && queryMatch[1].trim()) {
        userPrompt = queryMatch[1].trim();
      } else if (
        !userPrompt &&
        !text.includes('<system-reminder>') &&
        !text.includes('<user_info>') &&
        !text.includes('<agent_skills>') &&
        text.trim().length > 0
      ) {
        userPrompt = text.trim();
      }
      continue;
    }

    if (type === 'assistant') {
      const text = typeof entry.content === 'string'
        ? entry.content
        : getText(entry.content || entry.message);
      if (text && text.trim()) {
        lastMessage = text.trim();
        recentMessages.push({
          text: lastMessage.length > 2000 ? lastMessage.slice(-2000) : lastMessage
        });
        if (recentMessages.length > 20) recentMessages = recentMessages.slice(-20);
      }
      if (Array.isArray(entry.tool_calls)) {
        for (const tc of entry.tool_calls) {
          const name = tc.name || tc.function?.name || tc.type;
          if (name) toolCalls.push(name);
        }
      }
    }
  }

  return {
    userPrompt: userPrompt ? userPrompt.substring(0, 600) : '',
    lastMessage: lastMessage ? lastMessage.substring(0, 2000) : '',
    recentMessages,
    toolCalls: uniqueTail(toolCalls, 24)
  };
}

/**
 * Read the head of chat_history.jsonl to recover the user prompt when only a tail was parsed.
 */
function readChatUserPromptHead(filePath, maxBytes = 200_000) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const len = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return analyzeChatHistory(parseJSONL(buf.toString('utf-8'))).userPrompt;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Read the beginning of a large updates.jsonl to recover the user prompt
 * (which is usually only at the start of the session stream).
 */
function readUserPromptHead(filePath, maxBytes = 120_000) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const len = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      const entries = parseJSONL(buf.toString('utf-8'));
      let userBuf = '';
      for (const entry of entries) {
        const update = getAcpUpdate(entry);
        if (!update) continue;
        if (update.sessionUpdate === 'user_message_chunk') {
          userBuf += extractChunkText(update);
        } else if (userBuf && update.sessionUpdate !== 'user_message_chunk') {
          // End of the opening user message block
          break;
        }
      }
      return userBuf ? userBuf.substring(0, 400) : '';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Read a short snippet from the newest non-empty terminal log.
 */
function readLatestTerminalSnippet(terminalDir) {
  try {
    if (!fs.existsSync(terminalDir)) return '';
    const files = fs.readdirSync(terminalDir)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const full = path.join(terminalDir, f);
        try {
          const st = fs.statSync(full);
          return { full, mtime: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter(f => f.size > 0)
      .sort((a, b) => b.mtime - a.mtime);

    if (!files.length) return '';
    const target = files[0];
    // Read last ~6KB safely (file may be locked on Windows)
    const fd = fs.openSync(target.full, 'r');
    try {
      const start = Math.max(0, target.size - 6144);
      const len = target.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      let text = buf.toString('utf-8');
      // Drop NULs / mostly-binary garbage from locked partial writes
      if (!text || /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 200))) return '';
      const lines = text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        // Skip lines that look like byte dumps or pure hex noise
        .filter(l => {
          if (/^[\d,\s]+$/.test(l) && l.length > 40) return false;
          if ((l.match(/,/g) || []).length > 20 && /,\d+,/.test(l)) return false;
          return true;
        });
      if (!lines.length) return '';
      // Keep several lines so the feed looks like terminal output
      const tail = lines.slice(-8).join('\n');
      return tail.trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

module.exports = {
  GrokWatcher,
  analyzeGrokEntries,
  analyzeGrokEvents,
  analyzeChatHistory,
  mergeGrokStatus,
  formatToolInput,
  extractToolName,
  classifyToolKind,
  extractToolFilePath
};
