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
const { getText, normalizePlan, buildActivity, classifyActivityTool } = require('./session-utils');

/**
 * Watches OpenAI Codex CLI session JSONL files.
 *
 * Codex stores sessions at:
 *   ~/.codex/sessions/ (organized by date subdirectories)
 */
class CodexWatcher extends BaseWatcher {
  constructor(options = {}) {
    super('Codex', { pollInterval: 3000, ...options });
    this.codexDir = options.codexDir || path.join(os.homedir(), '.codex');
    this._lastFileSize = new Map();
    this._sessionFilePath = new Map();
  }

  _start() {
    const sessionsDir = path.join(this.codexDir, 'sessions');
    console.log(`[Codex] Watching ${this.codexDir}`);
    if (fs.existsSync(sessionsDir)) {
      this.watchDirs(sessionsDir);
    }
  }

  _stop() {
    this._lastFileSize.clear();
    this._sessionFilePath.clear();
  }

  async _poll() {
    const sessionsDir = path.join(this.codexDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) return;

    const activeFiles = new Set();

    try {
      this._scanDirectory(sessionsDir, activeFiles);
    } catch {
      // Directory unreadable
    }

    for (const [id] of this.sessions) {
      if (id.startsWith('codex-') && !activeFiles.has(id)) {
        this._removeSession(id);
      }
    }
  }

  _scanDirectory(dir, activeFiles, depth = 0) {
    if (depth > 3) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          this._scanDirectory(fullPath, activeFiles, depth + 1);
        } else if (entry.name.endsWith('.jsonl')) {
          if (!isFileActive(fullPath, 12 * 60 * 60 * 1000)) continue;

          const sessionId = `codex-${path.basename(entry.name, '.jsonl')}`;
          activeFiles.add(sessionId);

          try {
            this._processSessionFile(fullPath, sessionId);
          } catch {
            // Skip individual file errors
          }
        }
      }
    } catch {
      // Directory unreadable
    }
  }

  _processSessionFile(filePath, sessionId) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch { return; }

    const lastSize = this._lastFileSize.get(filePath) || 0;

    if (stat.size <= lastSize && this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId);
      const isActive = isFileActive(filePath, 60000);
      if (!isActive && existing.status === 'working') {
        this._updateSession(sessionId, { ...existing, status: 'idle', currentTool: null, isActive: false });
      }
      return;
    }

    const read = readJsonlEfficient(filePath);
    if (!read) return;
    this._lastFileSize.set(filePath, read.size);
    this._sessionFilePath.set(sessionId, filePath);

    const entries = parseJSONL(read.content);
    if (entries.length === 0) return;

    const fileTimes = getDurationFromFile(filePath);
    const sessionData = analyzeCodexEntries(entries, sessionId, filePath, fileTimes);

    this._updateSession(sessionId, sessionData);
  }

  _onSessionRemoved(id) {
    const fp = this._sessionFilePath.get(id);
    if (fp) {
      this._lastFileSize.delete(fp);
      this._sessionFilePath.delete(id);
    }
  }
}

function analyzeCodexEntries(entries, sessionId, filePath, fileTimes) {
  let taskName = '';
  let status = 'idle';
  let currentTool = null;
  let lastMessage = '';
  let userPrompt = '';
  let startTime = null;
  let lastTime = null;
  let toolCalls = [];
  /** @type {Array<{text:string, at?:number, kind?:string, tool?:string}>} */
  let timeline = [];
  let plan = [];
  let model = null;
  let rateLimit = null;

  for (const entry of entries) {
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
    const ts = entry.timestamp || entry.created_at || entry.ts;
    let at = null;
    if (ts) {
      const t = typeof ts === 'number'
        ? (ts > 1e12 ? ts : ts * 1000)
        : new Date(ts).getTime();
      if (!isNaN(t) && t > 0) {
        at = t;
        if (!startTime || t < startTime) startTime = t;
        if (!lastTime || t > lastTime) lastTime = t;
      }
    }

    if (typeof payload.model === 'string' && payload.model) {
      model = payload.model;
    }
    if (entry.type === 'session_meta' && typeof payload.model === 'string') {
      model = payload.model;
    }

    if (payload.type === 'token_count' && payload.rate_limits) {
      const primary = payload.rate_limits.primary;
      if (primary && primary.used_percent != null) {
        rateLimit = {
          usedPercent: primary.used_percent,
          windowMinutes: primary.window_minutes,
          resetsAt: primary.resets_at,
          planType: payload.rate_limits.plan_type || null,
          model,
          updatedAt: ts
            ? (typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(ts))
            : Date.now()
        };
      }
      if (payload.info && payload.info.model_context_window && rateLimit) {
        rateLimit.contextWindow = payload.info.model_context_window;
        if (payload.info.last_token_usage) {
          rateLimit.contextUsed = payload.info.last_token_usage.total_tokens;
        }
      }
    }

    if (payload.type === 'task_complete') {
      status = 'idle';
      currentTool = null;
      if (payload.last_agent_message) {
        lastMessage = getText(payload.last_agent_message);
        if (lastMessage) {
          timeline.push({
            text: lastMessage.length > 1200 ? lastMessage.slice(-1200) : lastMessage,
            at,
            kind: 'message'
          });
        }
      }
    }

    if (payload.role === 'user' || entry.role === 'user' || entry.type === 'user' || entry.type === 'human') {
      const content = getText(payload.content || entry.content || payload.message || entry.message);
      if (!userPrompt && content) {
        userPrompt = content;
        taskName = extractTaskName(content);
      }
    }

    if (payload.type === 'user_message' && payload.message) {
      const content = getText(payload.message);
      if (!userPrompt && content) {
        userPrompt = content;
        taskName = extractTaskName(content);
      }
    }

    if (payload.type === 'agent_message' && payload.message) {
      lastMessage = getText(payload.message);
      status = 'working';
      if (lastMessage) {
        timeline.push({
          text: lastMessage.length > 1200 ? lastMessage.slice(-1200) : lastMessage,
          at,
          kind: 'message'
        });
      }
    }

    if (payload.role === 'assistant' || entry.role === 'assistant' || entry.type === 'assistant' || entry.type === 'agent_message') {
      const content = getText(payload.content || entry.content || payload.message || entry.message);

      if (content) {
        lastMessage = content;
        status = 'working';
        timeline.push({
          text: content.length > 1200 ? content.slice(-1200) : content,
          at,
          kind: 'message'
        });
      }

      const tc = payload.tool_calls || payload.function_calls || entry.tool_calls || entry.function_calls || [];
      if (Array.isArray(tc) && tc.length > 0) {
        const lastTool = tc[tc.length - 1];
        currentTool = lastTool.function?.name || lastTool.name || 'tool';
        toolCalls.push(currentTool);
        timeline.push({
          text: currentTool,
          at,
          kind: classifyActivityTool(currentTool),
          tool: currentTool
        });
        status = 'working';
      }

      if (payload.finish_reason === 'stop' || payload.stop_reason === 'end_turn' || payload.type === 'task_complete') {
        status = 'idle';
        currentTool = null;
      }
    }

    if (payload.type === 'function_call' || payload.type === 'tool_call') {
      const name = payload.name || payload.function?.name || 'tool';
      let label = name;
      const args = payload.arguments || payload.input || payload.params;
      let parsed = args;
      if (typeof args === 'string') {
        try { parsed = JSON.parse(args); } catch { parsed = null; }
      }
      if (parsed && typeof parsed === 'object') {
        if (parsed.command || parsed.cmd) {
          label = `run_terminal_command: ${String(parsed.command || parsed.cmd).replace(/\s+/g, ' ').slice(0, 100)}`;
        } else if (parsed.path || parsed.file_path || parsed.target_file) {
          const fp = parsed.path || parsed.file_path || parsed.target_file;
          label = `${name}: ${String(fp).split(/[/\\]/).pop()}`;
        }
      }
      currentTool = label;
      toolCalls.push(label);
      timeline.push({
        text: label,
        at,
        kind: classifyActivityTool(label),
        tool: name
      });
      status = 'working';
    }

    if (payload.type === 'custom_tool_call') {
      const name = payload.name || 'tool';
      currentTool = name;
      toolCalls.push(name);
      timeline.push({
        text: name,
        at,
        kind: classifyActivityTool(name),
        tool: name
      });
      status = 'working';
      if (name === 'update_plan') {
        const parsedPlan = parsePlanInput(payload.input);
        if (parsedPlan.length) plan = parsedPlan;
      }
    }

    if (entry.role === 'tool' || entry.type === 'tool_result' || payload.type === 'function_call_output') {
      status = 'working';
    }

    const candidatePlan = payload.plan || entry.plan || (payload.type === 'plan_update' ? payload.items : null);
    if (Array.isArray(candidatePlan)) plan = normalizePlan(candidatePlan);
  }

  const isActive = filePath ? isFileActive(filePath, 60000) : true;
  if (!isActive && status === 'working') {
    status = 'idle';
  }

  if (!startTime) startTime = fileTimes.startTime;
  if (!lastTime) lastTime = fileTimes.lastTime;
  const duration = startTime && lastTime ? lastTime - startTime : 0;

  const activity = timeline.length
    ? timeline.slice(-40)
    : buildActivity(lastMessage, toolCalls, lastTime || fileTimes.lastTime);

  return {
    taskName: taskName || 'Codex session',
    status,
    currentTool,
    lastMessage: lastMessage ? lastMessage.substring(0, 2000) : '',
    userPrompt: userPrompt ? userPrompt.substring(0, 600) : '',
    permissionRequest: null,
    question: null,
    duration,
    durationFormatted: formatDuration(duration),
    startTime,
    lastTime,
    lastActivityAt: fileTimes.lastTime,
    terminal: 'Terminal',
    toolCalls: toolCalls.slice(-24),
    activity,
    plan,
    isActive,
    model,
    rateLimit
  };
}

function parsePlanInput(input) {
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    return Array.isArray(parsed && parsed.plan) ? normalizePlan(parsed.plan) : [];
  } catch {
    return [];
  }
}

module.exports = { CodexWatcher, analyzeCodexEntries };
