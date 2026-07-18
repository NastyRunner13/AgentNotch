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

/**
 * Watches Antigravity (Google DeepMind) IDE sessions.
 *
 * Path:
 *   ~/.gemini/antigravity-ide/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
 */
class AntigravityWatcher extends BaseWatcher {
  constructor(options = {}) {
    super('Antigravity', { pollInterval: 3000, ...options });
    this.geminiDir = options.geminiDir || path.join(os.homedir(), '.gemini');
    this.brainDir = path.join(this.geminiDir, 'antigravity-ide', 'brain');
    this._lastFileSize = new Map();
  }

  _start() {
    console.log(`[Antigravity] Watching ${this.brainDir}`);
    if (fs.existsSync(this.brainDir)) {
      this.watchDirs(this.brainDir);
    }
  }

  _stop() {
    this._lastFileSize.clear();
  }

  async _poll() {
    if (!fs.existsSync(this.brainDir)) return;

    const activeFiles = new Set();

    try {
      const conversations = fs.readdirSync(this.brainDir, { withFileTypes: true });

      for (const conv of conversations) {
        if (!conv.isDirectory()) continue;
        if (conv.name.startsWith('.') || conv.name === 'tempmediaStorage') continue;

        const transcriptPath = path.join(
          this.brainDir, conv.name,
          '.system_generated', 'logs', 'transcript.jsonl'
        );

        if (!fs.existsSync(transcriptPath)) continue;

        const sessionId = `antigravity-${conv.name}`;

        if (!isFileActive(transcriptPath, 12 * 60 * 60 * 1000)) continue;

        activeFiles.add(sessionId);

        try {
          await this._processTranscript(transcriptPath, sessionId, conv.name);
        } catch {
          // Skip individual file errors silently
        }
      }
    } catch {
      // Brain dir unreadable
    }

    for (const [id] of this.sessions) {
      if (id.startsWith('antigravity-') && !activeFiles.has(id)) {
        this._removeSession(id);
      }
    }
  }

  async _processTranscript(filePath, sessionId, conversationId) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch { return; }

    const lastSize = this._lastFileSize.get(filePath) || 0;

    if (stat.size <= lastSize && this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId);
      const isActive = isFileActive(filePath, 60000);
      if (!isActive && existing.status === 'working') {
        this._updateSession(sessionId, { ...existing, status: 'idle', currentTool: null });
      }
      return;
    }

    const read = readJsonlEfficient(filePath);
    if (!read) return;
    this._lastFileSize.set(filePath, read.size);

    const entries = parseJSONL(read.content);
    if (entries.length === 0) return;

    const fileTimes = getDurationFromFile(filePath);
    const sessionData = analyzeAntigravityEntries(entries, sessionId, conversationId, filePath, fileTimes);

    this._updateSession(sessionId, sessionData);
  }
}

function analyzeAntigravityEntries(entries, sessionId, conversationId, filePath, fileTimes) {
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
  let permissionRequest = null;
  let question = null;

  for (const entry of entries) {
    const ts = entry.created_at || entry.timestamp || entry.ts;
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

    if (entry.type === 'USER_INPUT' || entry.source === 'USER_EXPLICIT') {
      const content = typeof entry.content === 'string'
        ? entry.content
        : (entry.message || '');
      if (content) {
        if (!userPrompt) {
          userPrompt = content;
          taskName = extractTaskName(content);
        }
      }
    }

    if (entry.type === 'PLANNER_RESPONSE' || entry.source === 'MODEL') {
      const content = typeof entry.content === 'string' ? entry.content : '';

      if (content) {
        lastMessage = content.length > 1200 ? content.substring(content.length - 1200) : content;
        status = 'working';
        timeline.push({
          text: lastMessage,
          at,
          kind: 'message'
        });
      }

      if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
        for (const tc of entry.tool_calls) {
          const toolName = tc.name || tc.function?.name || 'tool';
          const args = tc.arguments || tc.args || {};

          let toolLabel = toolName;
          let kind = 'tool';
          if (args.TargetFile) {
            toolLabel = `${toolName}: ${path.basename(args.TargetFile)}`;
            kind = 'file';
          } else if (args.AbsolutePath) {
            toolLabel = `${toolName}: ${path.basename(args.AbsolutePath)}`;
            kind = 'file';
          } else if (args.CommandLine) {
            const cmd = String(args.CommandLine).replace(/\s+/g, ' ').substring(0, 100);
            toolLabel = `run_terminal_command: ${cmd}`;
            kind = 'terminal';
          } else if (args.Query) {
            toolLabel = `search: ${String(args.Query).substring(0, 48)}`;
            kind = 'search';
          } else if (args.DirectoryPath) {
            toolLabel = `${toolName}: ${path.basename(args.DirectoryPath)}`;
            kind = 'file';
          } else if (args.SearchPath) {
            toolLabel = `${toolName}: ${path.basename(args.SearchPath)}`;
            kind = 'search';
          }

          toolCalls.push(toolLabel);
          currentTool = toolLabel;
          timeline.push({ text: toolLabel, at, kind, tool: toolName });
        }
        status = 'working';
      }
    }

    if (entry.type === 'SYSTEM' || entry.source === 'SYSTEM') {
      if (entry.status === 'ERROR') {
        status = 'needs-attention';
      }
    }

    if (entry.status === 'ERROR') {
      status = 'needs-attention';
    }
  }

  const isActive = filePath ? isFileActive(filePath, 60000) : true;

  if (!isActive && status === 'working') {
    status = 'idle';
  }

  if (!startTime) startTime = fileTimes.startTime;
  if (!lastTime) lastTime = fileTimes.lastTime;
  const duration = startTime && lastTime ? lastTime - startTime : 0;

  return {
    taskName: taskName || 'Antigravity session',
    status,
    currentTool,
    lastMessage: lastMessage ? lastMessage.substring(0, 2000) : '',
    userPrompt: userPrompt ? userPrompt.substring(0, 600) : '',
    permissionRequest,
    question,
    duration,
    durationFormatted: formatDuration(duration),
    startTime,
    lastTime,
    lastActivityAt: fileTimes.lastTime,
    terminal: 'Antigravity',
    conversationId,
    toolCalls: toolCalls.slice(-24),
    activity: timeline.slice(-40),
    isActive
  };
}

module.exports = { AntigravityWatcher, analyzeAntigravityEntries };
