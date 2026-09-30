const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  BaseWatcher,
  extractTaskName,
  formatDuration,
  isFileActive
} = require('./base-watcher');
const { buildActivity, classifyActivityTool, taggedSessionId } = require('./session-utils');
const { preferUserPrompt } = require('../lib/prompt-clean');

/**
 * Watches Claude Code session JSONL files for real-time status.
 *
 * Claude Code stores sessions at:
 *   ~/.claude/projects/<project-hash>/sessions/<session-id>.jsonl
 * (and sometimes flat .jsonl under project dirs)
 */
class ClaudeWatcher extends BaseWatcher {
  constructor(options = {}) {
    super('Claude Code', { pollInterval: 2000, ...options });
    this.claudeDir = options.claudeDir || path.join(os.homedir(), '.claude');
    this.sourceTag = typeof options.sourceTag === 'string' ? options.sourceTag : '';
    this._missingLogged = false;
  }

  _start() {
    const projectsDir = path.join(this.claudeDir, 'projects');
    console.log(`[Claude Code] Watching ${this.claudeDir}`);
    if (!fs.existsSync(projectsDir) && !this._missingLogged) {
      console.log(`[Claude Code] No projects dir yet at ${projectsDir}`);
      this._missingLogged = true;
    }
    this.watchDirs([projectsDir, this.claudeDir].filter(p => fs.existsSync(p)));
  }

  async _poll() {
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) return;

    const activeFiles = new Set();

    try {
      const projects = fs.readdirSync(projectsDir, { withFileTypes: true });

      for (const project of projects) {
        if (!project.isDirectory()) continue;

        // Common layouts: projects/<hash>/sessions/*.jsonl or projects/<hash>/*.jsonl
        const candidates = [
          path.join(projectsDir, project.name, 'sessions'),
          path.join(projectsDir, project.name)
        ];

        for (const sessionsDir of candidates) {
          if (!fs.existsSync(sessionsDir)) continue;

          try {
            const sessionFiles = fs.readdirSync(sessionsDir)
              .filter(f => f.endsWith('.jsonl'));

            for (const file of sessionFiles) {
              const filePath = path.join(sessionsDir, file);
              const nativeId = path.basename(file, '.jsonl');
              const sessionId = taggedSessionId('claude', nativeId, this.sourceTag);

              if (!isFileActive(filePath, 12 * 60 * 60 * 1000)) continue;

              activeFiles.add(sessionId);

              try {
                await this._processSessionFile(filePath, sessionId, project.name, nativeId);
              } catch (err) {
                this.reportReadError(err);
                // Skip individual file errors
              }
            }
          } catch (err) {
            this.reportReadError(err);
            // Skip unreadable session dirs
          }
        }
      }
    } catch (err) {
      this.reportReadError(err);
      // Projects dir unreadable
    }

    if (this._readError) return;
    for (const [id] of this.sessions) {
      if (id.startsWith('claude-') && !activeFiles.has(id)) {
        this._removeSession(id);
      }
    }
  }

  async _processSessionFile(filePath, sessionId, projectHash, nativeId) {
    const sessionData = this._readJsonlSession(sessionId, filePath, (entries, state, fileTimes) =>
      this._analyzeEntries(entries, sessionId, projectHash, filePath, fileTimes, state));
    if (!sessionData) return;
    this._updateSession(sessionId, {
      ...sessionData,
      resumeId: nativeId || sessionData.resumeId || '',
      sourceTag: this.sourceTag || ''
    });
  }

  _analyzeEntries(entries, sessionId, projectHash, filePath, fileTimes, state = {}) {
    let { taskName = '', status = 'idle', currentTool = null, lastMessage = '',
      permissionRequest = null, question = null, startTime = null, lastTime = null,
      userPrompt = '', terminal = 'Terminal', model = null, cwd = null } = state;
    let toolCalls = [...(state.toolCalls || [])];
    /** @type {Array<{text:string, at?:number, kind?:string, filePath?:string, tool?:string}>} */
    let timeline = [...(state.timeline || [])];
    // Cumulative token usage summed from message.usage (Anthropic per-turn
    // shape). Deduped by message id — streaming writes repeat the same
    // message across lines and must not double count.
    const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...state.tokens };
    const seenUsageIds = state.seenUsageIds || new Set();

    for (const entry of entries) {
      // Claude transcript records carry the session's working directory
      if (!cwd && typeof entry.cwd === 'string' && entry.cwd) {
        cwd = entry.cwd;
      }

      const ts = entry.timestamp || entry.created_at;
      let at = null;
      if (ts) {
        const t = new Date(ts).getTime();
        if (!isNaN(t) && t > 0) {
          at = t;
          if (!startTime || t < startTime) startTime = t;
          if (!lastTime || t > lastTime) lastTime = t;
        }
      }

      const type = entry.type || entry.role || '';

      // Capture model when present on transcript entries
      if (typeof entry.model === 'string' && entry.model) {
        model = entry.model;
      } else if (entry.message && typeof entry.message.model === 'string') {
        model = entry.message.model;
      }

      // Human / user messages
      if ((type === 'human' || type === 'user') && (entry.message || entry.content)) {
        const content = typeof entry.message === 'string'
          ? entry.message
          : (entry.message?.content || entry.content || '');
        const text = typeof content === 'string' ? content : '';
        if (text) {
          userPrompt = preferUserPrompt(userPrompt, text);
          if (userPrompt) taskName = extractTaskName(userPrompt);
        }
      }

      if (type === 'assistant' && entry.message) {
        if (typeof entry.message.model === 'string' && entry.message.model) {
          model = entry.message.model;
        }
        const usage = entry.message.usage;
        if (usage && typeof usage === 'object') {
          const msgId = typeof entry.message.id === 'string' ? entry.message.id : null;
          if (!msgId || !seenUsageIds.has(msgId)) {
            if (msgId) seenUsageIds.add(msgId);
            tokens.input += Number(usage.input_tokens) || 0;
            tokens.output += Number(usage.output_tokens) || 0;
            tokens.cacheRead += Number(usage.cache_read_input_tokens) || 0;
            tokens.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
          }
        }
        if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if ((block.type === 'thinking' || block.type === 'redacted_thinking') && (block.thinking || block.text)) {
              const thinkText = block.thinking || block.text || '';
              if (thinkText) {
                status = 'working';
                timeline.push({
                  text: thinkText.length > 2500 ? thinkText.slice(-2500) : thinkText,
                  at,
                  kind: 'thinking'
                });
              }
            }
            if (block.type === 'text' && block.text) {
              lastMessage = block.text;
              status = 'working';
              timeline.push({
                text: block.text.length > 2500 ? block.text.slice(-2500) : block.text,
                at,
                kind: 'message'
              });
            }
            if (block.type === 'tool_use') {
              let toolLabel = block.name;
              let filePathHint = '';
              status = 'working';

              if (block.input) {
                if (block.input.file_path) {
                  filePathHint = block.input.file_path;
                  toolLabel = `${block.name}: ${path.basename(block.input.file_path)}`;
                } else if (block.input.path) {
                  filePathHint = block.input.path;
                  toolLabel = `${block.name}: ${path.basename(block.input.path)}`;
                } else if (block.input.command) {
                  toolLabel = `run_terminal_command: ${String(block.input.command).replace(/\s+/g, ' ').slice(0, 100)}`;
                } else if (block.input.query) {
                  toolLabel = `search: ${String(block.input.query).slice(0, 48)}`;
                } else if (block.input.pattern) {
                  toolLabel = `grep: ${String(block.input.pattern).slice(0, 48)}`;
                }
              }
              currentTool = toolLabel;
              toolCalls.push(toolLabel);
              timeline.push({
                text: toolLabel,
                at,
                kind: classifyActivityTool(toolLabel),
                filePath: filePathHint || undefined,
                tool: block.name
              });
            }
          }
        } else {
          const content = typeof entry.message === 'string'
            ? entry.message
            : (entry.message.content || '');
          if (content) {
            lastMessage = content;
            status = 'working';
            timeline.push({
              text: String(content).length > 1200 ? String(content).slice(-1200) : String(content),
              at,
              kind: 'message'
            });
          }
        }

        if (entry.message.stop_reason === 'end_turn') {
          status = 'idle';
          currentTool = null;
        }
      }

      if (type === 'tool_result') {
        status = 'working';
      }

      if (type === 'permission_request' || (entry.tool_use && entry.needs_approval)) {
        status = 'permission-request';
        permissionRequest = {
          tool: entry.tool || entry.tool_use?.name || 'Unknown',
          input: entry.input || entry.tool_use?.input || {},
          filePath: entry.file_path || entry.tool_use?.input?.file_path || ''
        };
      }

      if (type === 'ask_user' || type === 'question') {
        status = 'question';
        question = {
          text: entry.question || entry.message || '',
          options: entry.options || []
        };
      }
    }

    Object.assign(state, { taskName, status, currentTool, lastMessage, permissionRequest,
      question, startTime, lastTime, userPrompt, terminal, model, cwd, tokens, seenUsageIds,
      toolCalls: toolCalls.slice(-24), timeline: timeline.slice(-56) });

    // File freshness is for isActive only — do not demote working→idle.
    // Stall detection owns "no new activity" while the last event still says working.
    const isActive = filePath ? isFileActive(filePath, 60000) : true;

    if (!startTime) startTime = fileTimes.startTime;
    if (!lastTime) lastTime = fileTimes.lastTime;
    const duration = startTime && lastTime ? lastTime - startTime : 0;

    // Prefer full timeline; fall back to compact builder
    const activity = timeline.length
      ? timeline.slice(-56)
      : buildActivity(lastMessage, toolCalls, lastTime || fileTimes.lastTime);

    return {
      taskName: taskName || 'Claude Code session',
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
      terminal,
      projectHash,
      toolCalls: toolCalls.slice(-24),
      activity,
      isActive,
      model,
      cwd,
      // Cumulative usage survives appended batches; IDs dedupe streamed repeats.
      tokens
    };
  }
}

// Export analyzer for tests
function analyzeClaudeEntries(entries, filePath = '', fileTimes = { startTime: 0, lastTime: 0 }) {
  const w = new ClaudeWatcher();
  return w._analyzeEntries(entries, 'test', 'proj', filePath, fileTimes);
}

module.exports = { ClaudeWatcher, analyzeClaudeEntries };
