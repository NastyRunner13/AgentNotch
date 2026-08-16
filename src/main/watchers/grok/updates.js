const { extractTaskName, formatDuration, isFileActive } = require('../base-watcher');
const { getText, normalizePlan } = require('../session-utils');
const { preferUserPrompt } = require('../../lib/prompt-clean');
const {
  getAcpUpdate,
  extractChunkText,
  extractToolName,
  formatToolInput,
  extractToolFilePath,
  classifyToolKind,
  resolveTimestamp,
  truncate,
  uniqueTail,
  buildRichActivity
} = require('./helpers');

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
          userPrompt = preferUserPrompt(userPrompt, userBuf);
          if (userPrompt && !taskName) taskName = extractTaskName(userPrompt);
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
      if (content) {
        userPrompt = preferUserPrompt(userPrompt, content);
        if (userPrompt && !taskName) taskName = extractTaskName(userPrompt);
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

module.exports = {
  emptyUpdateState,
  analyzeGrokEntries
};
