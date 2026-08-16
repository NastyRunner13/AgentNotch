const { formatDuration, extractTaskName, parseJSONL } = require('../base-watcher');
const { buildActivity, classifyActivityTool } = require('../session-utils');
const { preferUserPrompt } = require('../../lib/prompt-clean');
const { LIVE_WRITE_MS } = require('./paths');
const { toolLabelFromBubble, extractSummaryText } = require('./tools');

/**
 * Map Cursor composer status fields → AgentNotch session status.
 * @param {object} data — composerData blob
 * @param {{ now?: number, liveWriteMs?: number }} [opts]
 * @returns {'working'|'idle'|'needs-attention'}
 */
function mapCursorStatus(data, opts = {}) {
  if (!data || typeof data !== 'object') return 'idle';
  const now = opts.now || Date.now();
  const liveWriteMs = opts.liveWriteMs ?? LIVE_WRITE_MS;
  const raw = String(data.status || '').toLowerCase();

  if (Array.isArray(data.generatingBubbleIds) && data.generatingBubbleIds.length > 0) {
    return 'working';
  }
  if (data.isReadingLongFile) return 'working';

  if (
    raw === 'generating' ||
    raw === 'running' ||
    raw === 'in_progress' ||
    raw === 'in-progress' ||
    raw === 'streaming' ||
    raw === 'working' ||
    raw === 'thinking' ||
    raw === 'pending'
  ) {
    return 'working';
  }

  if (
    raw === 'aborted' ||
    raw === 'error' ||
    raw === 'failed' ||
    raw === 'cancelled' ||
    raw === 'canceled'
  ) {
    return 'needs-attention';
  }

  // Some Cursor builds leave status as "none" while a turn is mid-flight and
  // only flip lastUpdatedAt. Treat very recent agentic writes as working.
  if (raw === 'none' || raw === '') {
    const last = Number(data.lastUpdatedAt) || 0;
    if (data.isAgentic && last > 0 && now - last < liveWriteMs) {
      return 'working';
    }
  }

  return 'idle';
}

/**
 * Pure analyzer: turn a composerData blob (+ optional bubbles / transcript) into a session.
 *
 * @param {object} composer — globalStorage composerData:* JSON
 * @param {object} [meta]
 * @param {string} [meta.cwd]
 * @param {string} [meta.workspaceId]
 * @param {Array<object>} [meta.bubbles] — recent bubble objects (order preserved)
 * @param {object|null} [meta.transcript] — analyzeCursorTranscript result
 * @param {number} [meta.now]
 * @returns {object}
 */
function analyzeCursorComposer(composer, meta = {}) {
  const now = meta.now || Date.now();
  const composerId = composer.composerId || composer.id || 'unknown';
  const sessionId = `cursor-${composerId}`;

  const startTime = Number(composer.createdAt) || now;
  const lastTime = Number(composer.lastUpdatedAt) || startTime;
  const duration = Math.max(0, lastTime - startTime);

  let status = mapCursorStatus(composer, { now });
  let currentTool = null;
  let userPrompt = '';
  let lastMessage = '';
  const toolCalls = [];
  /** @type {Array<{text:string, at?:number, kind?:string, tool?:string}>} */
  const timeline = [];

  // Bubbles: type 1 = user, type 2 = assistant
  const bubbles = Array.isArray(meta.bubbles) ? meta.bubbles : [];
  for (const b of bubbles) {
    if (!b) continue;
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const tool = toolLabelFromBubble(b);
    const at = Number(b.createdAt) || lastTime;

    if (b.type === 1 && text) {
      userPrompt = preferUserPrompt(userPrompt, text);
    }
    if (b.type === 2 && text) {
      lastMessage = text;
      timeline.push({
        text: text.length > 1200 ? text.slice(-1200) : text,
        at,
        kind: 'message'
      });
    }
    if (tool) {
      toolCalls.push(tool);
      timeline.push({
        text: tool,
        at,
        kind: classifyActivityTool(tool),
        tool
      });
      if (status === 'working') currentTool = tool;
    }
  }

  // Transcript overlay (optional richer tool stream)
  const tr = meta.transcript;
  if (tr) {
    if (tr.userPrompt) userPrompt = preferUserPrompt(userPrompt, tr.userPrompt);
    if (tr.lastMessage) lastMessage = tr.lastMessage;
    for (const t of tr.toolCalls || []) {
      if (t) toolCalls.push(t);
    }
    for (const a of tr.activity || []) {
      if (a && a.text) timeline.push(a);
    }
    if (tr.currentTool && status === 'working') currentTool = tr.currentTool;
    // Transcript mtime is fresher → prefer its status when more recent
    if (tr.lastTime && tr.lastTime >= lastTime - 2000) {
      if (tr.status === 'working') status = 'working';
      else if (tr.status === 'needs-attention' && status === 'idle') status = 'needs-attention';
    }
  }

  // Subtitle / summary when bubbles empty
  if (!lastMessage && typeof composer.subtitle === 'string' && composer.subtitle.trim()) {
    lastMessage = composer.subtitle.trim();
  }
  if (!lastMessage) {
    const summary = extractSummaryText(composer.latestConversationSummary);
    if (summary) lastMessage = summary.slice(0, 2000);
  }

  const nameFromComposer =
    (typeof composer.name === 'string' && composer.name.trim()) ||
    extractTaskName(userPrompt) ||
    (composer.unifiedMode === 'agent' || composer.isAgentic ? 'Cursor agent' : 'Cursor chat');

  let model =
    (composer.modelConfig && composer.modelConfig.modelName) ||
    composer.modelName ||
    null;
  if (model && String(model).toLowerCase() === 'default') model = null;

  // Token usage when bubbles report it (Cursor rarely exposes cumulative totals)
  let tokens = null;
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const tc = bubbles[i]?.tokenCount;
    if (tc && (tc.inputTokens || tc.outputTokens)) {
      tokens = {
        input: Number(tc.inputTokens) || 0,
        output: Number(tc.outputTokens) || 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      };
      break;
    }
  }

  const filesChanged =
    Number(composer.filesChangedCount) ||
    Object.keys(composer.codeBlockData || {}).length ||
    0;

  if (status === 'working' && !currentTool && filesChanged > 0) {
    currentTool = `Editing · ${filesChanged} file${filesChanged === 1 ? '' : 's'}`;
  }

  const activity = timeline.length
    ? timeline.slice(-40)
    : buildActivity(lastMessage, toolCalls, lastTime);

  const cwd = meta.cwd || '';

  return {
    taskName: nameFromComposer,
    status,
    currentTool: status === 'working' ? currentTool : null,
    lastMessage: lastMessage ? lastMessage.substring(0, 2000) : '',
    userPrompt: userPrompt ? userPrompt.substring(0, 600) : '',
    permissionRequest: null,
    question: null,
    duration,
    durationFormatted: formatDuration(duration),
    startTime,
    lastTime,
    lastActivityAt: lastTime,
    terminal: 'Cursor',
    toolCalls: toolCalls.slice(-24),
    activity,
    plan: [],
    isActive: status === 'working' || status === 'needs-attention',
    model,
    rateLimit: null,
    cwd,
    tokens,
    tokensCumulative: false,
    resumeId: composerId,
    unifiedMode: composer.unifiedMode || null,
    filesChangedCount: filesChanged,
    contextUsagePercent:
      typeof composer.contextUsagePercent === 'number' ? composer.contextUsagePercent : null
  };
}

/**
 * Parse a Cursor agent-transcript file (plain text export or JSONL).
 * @param {string} content
 * @param {{ mtime?: number, now?: number }} [opts]
 * @returns {object}
 */
function analyzeCursorTranscript(content, opts = {}) {
  const now = opts.now || Date.now();
  const mtime = opts.mtime || now;
  const toolCalls = [];
  /** @type {Array<{text:string, at?:number, kind?:string, tool?:string}>} */
  const activity = [];
  let userPrompt = '';
  let lastMessage = '';
  let currentTool = null;
  let status = 'idle';

  if (!content || !String(content).trim()) {
    return {
      status: 'idle',
      userPrompt: '',
      lastMessage: '',
      currentTool: null,
      toolCalls: [],
      activity: [],
      lastTime: mtime
    };
  }

  const trimmed = String(content).trim();

  // JSONL path (one JSON object per line)
  if (trimmed.startsWith('{') || trimmed.includes('\n{')) {
    const entries = parseJSONL(trimmed);
    if (entries.length > 0) {
      for (const entry of entries) {
        const role = entry.role || entry.type || '';
        const text =
          typeof entry.text === 'string'
            ? entry.text
            : typeof entry.content === 'string'
              ? entry.content
              : typeof entry.message === 'string'
                ? entry.message
                : '';

        if ((role === 'user' || role === 'human' || entry.type === 1) && text) {
          userPrompt = preferUserPrompt(userPrompt, text.trim());
        }
        if ((role === 'assistant' || role === 'ai' || entry.type === 2) && text) {
          lastMessage = text.trim();
          status = 'working';
        }

        const toolName =
          entry.tool_name ||
          entry.toolName ||
          entry.name ||
          (entry.tool_calls && entry.tool_calls[0]?.function?.name) ||
          (entry.toolCall && entry.toolCall.name) ||
          '';
        const toolArgs =
          entry.tool_input ||
          entry.input ||
          entry.arguments ||
          (entry.tool_calls && entry.tool_calls[0]?.function?.arguments) ||
          null;

        if (toolName || entry.toolCall || entry.tool_calls) {
          let label = toolName || 'tool';
          if (toolArgs && typeof toolArgs === 'object') {
            const cmd = toolArgs.command || toolArgs.cmd;
            const fp = toolArgs.path || toolArgs.file_path || toolArgs.target_file;
            if (cmd) label = `Shell: ${String(cmd).replace(/\s+/g, ' ').slice(0, 80)}`;
            else if (fp) label = `${label}: ${String(fp).split(/[/\\]/).pop()}`;
          } else if (typeof toolArgs === 'string' && toolArgs.length < 120) {
            label = `${label}: ${toolArgs}`;
          }
          toolCalls.push(label);
          activity.push({ text: label, at: mtime, kind: classifyActivityTool(label), tool: label });
          currentTool = label;
          status = 'working';
        }
      }

      // Keep last transcript status. Quiet working is a stall, not Finished.

      return {
        status,
        userPrompt: userPrompt.slice(0, 600),
        lastMessage: lastMessage.slice(0, 2000),
        currentTool: status === 'working' ? currentTool : null,
        toolCalls: toolCalls.slice(-24),
        activity: activity.slice(-40),
        lastTime: mtime
      };
    }
  }

  // Plain-text transcript export:
  //   user:
  //   <user_query>...</user_query>
  //   A:
  //   [Tool call] Shell
  //     command: ...
  const lines = trimmed.split(/\r?\n/);
  let mode = ''; // 'user' | 'assistant'
  let buf = [];

  const flush = () => {
    const block = buf.join('\n').trim();
    buf = [];
    if (!block) return;
    if (mode === 'user') {
      const q = block.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
      userPrompt = preferUserPrompt(userPrompt, (q ? q[1] : block).trim());
    } else if (mode === 'assistant') {
      lastMessage = block;
      // Tool calls embedded in assistant block
      const toolRe = /\[Tool call\]\s*(\S+)([\s\S]*?)(?=\[Tool (?:call|result)\]|$)/gi;
      let m;
      while ((m = toolRe.exec(block)) !== null) {
        const name = m[1];
        const body = m[2] || '';
        const cmd = body.match(/command:\s*(.+)/i);
        const desc = body.match(/description:\s*(.+)/i);
        let label = name;
        if (cmd) label = `Shell: ${cmd[1].replace(/\s+/g, ' ').slice(0, 80)}`;
        else if (desc) label = `${name}: ${desc[1].slice(0, 60)}`;
        toolCalls.push(label);
        activity.push({ text: label, at: mtime, kind: classifyActivityTool(label), tool: label });
        currentTool = label;
      }
      status = 'working';
    }
  };

  for (const line of lines) {
    if (/^user:\s*$/i.test(line) || /^user:\s+/i.test(line)) {
      flush();
      mode = 'user';
      const rest = line.replace(/^user:\s*/i, '');
      buf = rest ? [rest] : [];
      continue;
    }
    if (/^A:\s*$/i.test(line) || /^A:\s+/i.test(line) || /^assistant:\s*$/i.test(line)) {
      flush();
      mode = 'assistant';
      const rest = line.replace(/^(A|assistant):\s*/i, '');
      buf = rest ? [rest] : [];
      continue;
    }
    if (/^\[Tool call\]/i.test(line)) {
      if (mode !== 'assistant') {
        flush();
        mode = 'assistant';
        buf = [];
      }
      buf.push(line);
      continue;
    }
    buf.push(line);
  }
  flush();

  if (toolCalls.length || lastMessage) {
    status = 'working';
  }

  return {
    status,
    userPrompt: userPrompt.slice(0, 600),
    lastMessage: lastMessage.slice(0, 2000),
    currentTool: status === 'working' ? currentTool : null,
    toolCalls: toolCalls.slice(-24),
    activity: activity.slice(-40),
    lastTime: mtime
  };
}

module.exports = {
  mapCursorStatus,
  analyzeCursorComposer,
  analyzeCursorTranscript
};
