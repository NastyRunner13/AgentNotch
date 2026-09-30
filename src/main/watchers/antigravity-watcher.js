const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  BaseWatcher,
  extractTaskName,
  formatDuration,
  isFileActive
} = require('./base-watcher');
const { taggedSessionId } = require('./session-utils');
const { preferUserPrompt } = require('../lib/prompt-clean');

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
    this.sourceTag = typeof options.sourceTag === 'string' ? options.sourceTag : '';
    this.brainDir = path.join(this.geminiDir, 'antigravity-ide', 'brain');
  }

  _start() {
    console.log(`[Antigravity] Watching ${this.brainDir}`);
    if (fs.existsSync(this.brainDir)) {
      this.watchDirs(this.brainDir);
    }
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

        const sessionId = taggedSessionId('antigravity', conv.name, this.sourceTag);

        if (!isFileActive(transcriptPath, 12 * 60 * 60 * 1000)) continue;

        activeFiles.add(sessionId);

        try {
          await this._processTranscript(transcriptPath, sessionId, conv.name);
        } catch (err) {
          this.reportReadError(err);
          // Skip individual file errors silently
        }
      }
    } catch (err) {
      this.reportReadError(err);
      // Brain dir unreadable
    }

    if (this._readError) return;
    for (const [id] of this.sessions) {
      if (id.startsWith('antigravity-') && !activeFiles.has(id)) {
        this._removeSession(id);
      }
    }
  }

  async _processTranscript(filePath, sessionId, conversationId) {
    const sessionData = this._readJsonlSession(sessionId, filePath, (entries, state, fileTimes) =>
      analyzeAntigravityEntries(entries, sessionId, conversationId, filePath, fileTimes, state));
    if (!sessionData) return;

    this._updateSession(sessionId, {
      ...sessionData,
      sourceTag: this.sourceTag || ''
    });
  }
}

function analyzeAntigravityEntries(entries, sessionId, conversationId, filePath, fileTimes, state = {}) {
  let { taskName = '', status = 'idle', currentTool = null, lastMessage = '', userPrompt = '',
    startTime = null, lastTime = null, permissionRequest = null, question = null } = state;
  let toolCalls = [...(state.toolCalls || [])];
  /** @type {Array<{text:string, at?:number, kind?:string, tool?:string}>} */
  let timeline = [...(state.timeline || [])];

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
        userPrompt = preferUserPrompt(userPrompt, content);
        if (userPrompt) taskName = extractTaskName(userPrompt);
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

  Object.assign(state, { taskName, status, currentTool, lastMessage, userPrompt,
    startTime, lastTime, permissionRequest, question,
    toolCalls: toolCalls.slice(-24), timeline: timeline.slice(-40) });
  const isActive = filePath ? isFileActive(filePath, 60000) : true;

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
