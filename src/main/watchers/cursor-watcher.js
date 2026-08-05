const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  BaseWatcher,
  formatDuration,
  extractTaskName,
  parseJSONL,
  isFileActive,
  readJsonlEfficient
} = require('./base-watcher');
const { buildActivity, classifyActivityTool } = require('./session-utils');

const execFileAsync = promisify(execFile);

/** How long a finished composer stays visible after last update (ms). */
const RECENT_MS = 12 * 60 * 60 * 1000;
/** After Cursor exits, keep recent sessions briefly so "done" can fire (ms). */
const POST_EXIT_GRACE_MS = 3 * 60 * 1000;
/** Consider a composer "live" (working) if generating / recently written (ms). */
const LIVE_WRITE_MS = 90_000;

/**
 * node:sqlite is available in Node ≥22.5 (Electron 36). Degrade gracefully.
 * @returns {{ DatabaseSync: typeof import('node:sqlite').DatabaseSync } | null}
 */
function tryLoadSqlite() {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
}

const sqlite = tryLoadSqlite();

/**
 * Resolve Cursor user-data roots across platforms.
 * @returns {{ globalDb: string, workspaceRoot: string, projectsRoot: string }}
 */
function resolveCursorPaths() {
  const home = os.homedir();
  const platform = os.platform();

  let userData;
  if (platform === 'win32') {
    userData = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'Cursor')
      : path.join(home, 'AppData', 'Roaming', 'Cursor');
  } else if (platform === 'darwin') {
    userData = path.join(home, 'Library', 'Application Support', 'Cursor');
  } else {
    userData = process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'Cursor')
      : path.join(home, '.config', 'Cursor');
  }

  return {
    globalDb: path.join(userData, 'User', 'globalStorage', 'state.vscdb'),
    workspaceRoot: path.join(userData, 'User', 'workspaceStorage'),
    projectsRoot: path.join(home, '.cursor', 'projects')
  };
}

/**
 * Convert a VS Code / Cursor file:// URI to a local filesystem path.
 * @param {string} uri
 * @returns {string}
 */
function fileUrlToPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  let s = uri.trim();
  if (!s.startsWith('file:')) return s;

  try {
    // URL handles percent-encoding; file:///c%3A/... → /c:/... on Windows
    const u = new URL(s);
    let p = decodeURIComponent(u.pathname || '');
    // Windows: /C:/Users/... → C:\Users\...
    if (os.platform() === 'win32') {
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      p = p.replace(/\//g, path.sep);
    }
    return p;
  } catch {
    // Fallback: strip file:// and decode
    s = s.replace(/^file:\/\//i, '');
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep raw
    }
    if (os.platform() === 'win32' && /^\/[A-Za-z]:/.test(s)) s = s.slice(1);
    return s.replace(/\//g, path.sep);
  }
}

/**
 * Decode a ~/.cursor/projects/<slug> name into a human project label.
 * @param {string} slug
 * @returns {string}
 */
function projectSlugToLabel(slug) {
  if (!slug) return '';
  // Common pattern: c-Users-name-... or Users-name-...
  const parts = String(slug).split('-').filter(Boolean);
  if (parts.length === 0) return slug;
  return parts[parts.length - 1] || slug;
}

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
 * Short human label for Cursor tool names.
 * @param {string} name
 * @returns {string}
 */
function humanizeCursorToolName(name) {
  const n = String(name || '').trim();
  if (!n) return 'tool';
  return n
    .replace(/^run_terminal_command$/i, 'Shell')
    .replace(/^shell$/i, 'Shell')
    .replace(/^codebase_search$/i, 'Search')
    .replace(/^grep$/i, 'Grep')
    .replace(/^read_file$/i, 'Read')
    .replace(/^write$/i, 'Write')
    .replace(/^search_replace$/i, 'Edit')
    .replace(/^edit_file$/i, 'Edit')
    .replace(/^web_search$/i, 'Web')
    .replace(/_/g, ' ');
}

/**
 * Parse tool args from Cursor toolFormerData (rawArgs preferred).
 * @param {object} tfd
 * @returns {object|null}
 */
function parseToolFormerArgs(tfd) {
  if (!tfd || typeof tfd !== 'object') return null;
  const candidates = [tfd.rawArgs, tfd.params, tfd.arguments, tfd.input];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'object' && !Array.isArray(c)) return c;
    if (typeof c === 'string' && c.trim()) {
      try {
        const parsed = JSON.parse(c);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // Not JSON — only useful if it looks like a command path
      }
    }
  }
  return null;
}

/**
 * Extract a short tool / activity label from a bubble or transcript line.
 * @param {object} bubble
 * @returns {string|null}
 */
function toolLabelFromBubble(bubble) {
  if (!bubble || typeof bubble !== 'object') return null;

  const tfd = bubble.toolFormerData || bubble.toolCall || bubble.tool_call;
  if (tfd && typeof tfd === 'object') {
    const name = tfd.name || tfd.toolName || '';
    // toolFormer.tool is often a numeric enum — ignore unless name missing
    const labelName = name || (typeof tfd.tool === 'string' ? tfd.tool : '');
    if (labelName) {
      const args = parseToolFormerArgs(tfd);
      if (args) {
        const cmd = args.command || args.cmd;
        if (cmd) {
          return `Shell: ${String(cmd).replace(/\s+/g, ' ').slice(0, 80)}`;
        }
        const fp =
          args.path ||
          args.file_path ||
          args.target_file ||
          args.targetFile ||
          args.relativeWorkspacePath ||
          args.filePath;
        if (fp && typeof fp === 'string') {
          return `${humanizeCursorToolName(labelName)}: ${String(fp).split(/[/\\]/).pop()}`;
        }
        const q = args.query || args.pattern || args.search_term || args.searchTerm;
        if (q && typeof q === 'string') {
          return `${humanizeCursorToolName(labelName)}: ${q.replace(/\s+/g, ' ').slice(0, 48)}`;
        }
      }
      return humanizeCursorToolName(labelName);
    }
  }

  // codeBlocks with an explicit path/uri (skip content-only suggestion blocks)
  if (Array.isArray(bubble.codeBlocks) && bubble.codeBlocks.length) {
    for (let i = bubble.codeBlocks.length - 1; i >= 0; i--) {
      const block = bubble.codeBlocks[i];
      if (!block || typeof block !== 'object') continue;
      const uri =
        (typeof block.uri === 'string' && block.uri) ||
        (typeof block.filePath === 'string' && block.filePath) ||
        (typeof block.path === 'string' && block.path) ||
        (typeof block.relativeWorkspacePath === 'string' && block.relativeWorkspacePath) ||
        '';
      if (!uri) continue;
      const base = String(fileUrlToPath(uri) || uri).split(/[/\\]/).pop();
      if (base && base !== '[object Object]') return `Edit: ${base}`;
    }
  }

  if (Array.isArray(bubble.fileLinks) && bubble.fileLinks.length) {
    const last = bubble.fileLinks[bubble.fileLinks.length - 1];
    const display =
      (typeof last?.displayName === 'string' && last.displayName) ||
      (typeof last?.path === 'string' && last.path) ||
      (typeof last?.uri === 'string' && last.uri) ||
      '';
    if (display) {
      const base = String(display).split(/[/\\]/).pop();
      return base ? `File: ${base}` : null;
    }
  }

  return null;
}

/**
 * Flatten Cursor's nested conversation summary shapes to a string.
 * @param {unknown} field
 * @returns {string}
 */
function extractSummaryText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field.trim();
  if (typeof field === 'object') {
    // latestConversationSummary: { summary: string | { summary: string }, ... }
    if (typeof field.summary === 'string') return field.summary.trim();
    if (field.summary && typeof field.summary === 'object' && typeof field.summary.summary === 'string') {
      return field.summary.summary.trim();
    }
  }
  return '';
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

    if (b.type === 1 && text && !userPrompt) {
      userPrompt = text;
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
    if (!userPrompt && tr.userPrompt) userPrompt = tr.userPrompt;
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

        if ((role === 'user' || role === 'human' || entry.type === 1) && text && !userPrompt) {
          userPrompt = text.trim();
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

      // Stale transcript → idle
      if (now - mtime > LIVE_WRITE_MS) {
        status = 'idle';
        currentTool = null;
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
    if (mode === 'user' && !userPrompt) {
      const q = block.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
      userPrompt = (q ? q[1] : block).trim();
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

  if (now - mtime > LIVE_WRITE_MS) {
    status = 'idle';
    currentTool = null;
  } else if (toolCalls.length || lastMessage) {
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

/**
 * Read JSON blob from a SQLite value column (string or Buffer).
 * @param {unknown} value
 * @returns {object|null}
 */
function parseDbJson(value) {
  if (value == null) return null;
  try {
    const text =
      typeof value === 'string'
        ? value
        : Buffer.isBuffer(value)
          ? value.toString('utf8')
          : String(value);
    if (!text || text === 'null') return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Change token for a DB path + WAL sidecars (same idea as OpenCode watcher).
 * @param {string} dbPath
 * @returns {string|null}
 */
function dbChangeToken(dbPath) {
  let dbStat;
  try {
    dbStat = fs.statSync(dbPath);
  } catch {
    return null;
  }
  let newest = dbStat.mtimeMs;
  let walSize = 0;
  for (const suffix of ['-wal', '-shm']) {
    try {
      const st = fs.statSync(dbPath + suffix);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (suffix === '-wal') walSize = st.size;
    } catch {
      // absent
    }
  }
  return `${newest}:${walSize}`;
}

/**
 * Watches Cursor IDE process + local composer state (SQLite) + agent transcripts.
 *
 * Cursor does not expose remote Allow/Deny; this deepens the *signal* so the
 * notch can show real agent sessions (working / done / project) instead of
 * a single "Cursor is open" placeholder.
 */
class CursorWatcher extends BaseWatcher {
  constructor(options = {}) {
    super('Cursor', { pollInterval: 4000, safetyPollInterval: 12000, ...options });
    const paths = options.paths || resolveCursorPaths();
    this.globalDb = options.globalDb || paths.globalDb;
    this.workspaceRoot = options.workspaceRoot || paths.workspaceRoot;
    this.projectsRoot = options.projectsRoot || paths.projectsRoot;
    this._startedAt = null;
    this._checking = false;
    this._globalToken = '';
    this._workspaceToken = '';
    /** @type {Map<string, string>} composerId → cwd */
    this._composerCwd = new Map();
    /** @type {Map<string, { size: number, mtime: number }>} */
    this._transcriptMeta = new Map();
  }

  _start() {
    console.log('[Cursor] Process + composer monitoring started');
    const watch = [];
    if (fs.existsSync(path.dirname(this.globalDb))) watch.push(path.dirname(this.globalDb));
    if (fs.existsSync(this.workspaceRoot)) watch.push(this.workspaceRoot);
    if (fs.existsSync(this.projectsRoot)) watch.push(this.projectsRoot);
    if (watch.length) this.watchDirs(watch);
  }

  _stop() {
    this._startedAt = null;
    this._globalToken = '';
    this._workspaceToken = '';
    this._composerCwd.clear();
    this._transcriptMeta.clear();
  }

  async _poll() {
    if (this._checking) return;
    this._checking = true;

    try {
      const isRunning = await this._checkProcess();
      const now = Date.now();
      const activeIds = new Set();

      if (isRunning && !this._startedAt) this._startedAt = now;
      if (!isRunning) this._startedAt = null;

      // Composer + transcript sessions when SQLite (or files) available
      const composerSessions = sqlite
        ? this._scanComposers(now, isRunning)
        : [];
      const transcriptSessions = this._scanTranscripts(now, isRunning, composerSessions);

      for (const s of composerSessions) {
        activeIds.add(s.id);
        this._updateSession(s.id, s);
      }
      for (const s of transcriptSessions) {
        if (activeIds.has(s.id)) continue; // composer session wins
        activeIds.add(s.id);
        this._updateSession(s.id, s);
      }

      // Fallback: IDE open, no rich sessions → presence-only card
      if (isRunning && activeIds.size === 0) {
        const sessionId = 'cursor-main';
        activeIds.add(sessionId);
        const duration = this._startedAt ? now - this._startedAt : 0;
        this._updateSession(sessionId, {
          taskName: 'Cursor IDE',
          status: 'idle',
          currentTool: null,
          lastMessage: sqlite
            ? 'Cursor is open — no recent agent sessions'
            : 'Cursor is open',
          userPrompt: '',
          permissionRequest: null,
          question: null,
          duration,
          durationFormatted: formatDuration(duration),
          startTime: this._startedAt || now,
          lastTime: now,
          lastActivityAt: now,
          terminal: 'Cursor',
          toolCalls: [],
          activity: [],
          isActive: true,
          cwd: '',
          model: null
        });
      }

      // Drop stale sessions
      for (const [id] of this.sessions) {
        if (!activeIds.has(id)) this._removeSession(id);
      }
    } finally {
      this._checking = false;
    }
  }

  /**
   * @param {number} now
   * @param {boolean} isRunning
   * @returns {Array<object>}
   */
  _scanComposers(now, isRunning) {
    if (!sqlite) return [];
    if (!fs.existsSync(this.globalDb)) return [];

    const token = dbChangeToken(this.globalDb);
    // Always re-read when process presence flips or token changes; also re-read
    // periodically via safety poll even if token matches (status may age out).
    void token;

    /** @type {Map<string, string>} */
    const cwdById = new Map();
    this._refreshWorkspaceIndex(cwdById);

    let db;
    try {
      db = new sqlite.DatabaseSync(this.globalDb, { open: true, readOnly: true });
    } catch (err) {
      console.warn('[Cursor] Failed to open global state.vscdb:', err.message);
      return [];
    }

    const results = [];
    try {
      let rows;
      try {
        rows = db
          .prepare(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
          )
          .all();
      } catch (err) {
        console.warn('[Cursor] cursorDiskKV query failed:', err.message);
        return [];
      }

      for (const row of rows) {
        if (!row || row.value == null) continue;
        const composer = parseDbJson(row.value);
        if (!composer || !composer.composerId) continue;

        const last = Number(composer.lastUpdatedAt) || Number(composer.createdAt) || 0;
        const status = mapCursorStatus(composer, { now });
        const isLive = status === 'working' || status === 'needs-attention';

        // Filter noise: empty drafts with no activity
        const hasContent =
          (Array.isArray(composer.fullConversationHeadersOnly) &&
            composer.fullConversationHeadersOnly.length > 0) ||
          (typeof composer.name === 'string' && composer.name.trim()) ||
          (typeof composer.subtitle === 'string' && composer.subtitle.trim()) ||
          isLive;

        if (!hasContent) continue;

        // Time window
        if (!isLive) {
          if (!last || now - last > RECENT_MS) continue;
          if (!isRunning && now - last > POST_EXIT_GRACE_MS) continue;
        } else if (!isRunning && last && now - last > POST_EXIT_GRACE_MS) {
          // Process gone and generation markers stale
          continue;
        }

        const cwd = cwdById.get(composer.composerId) || this._composerCwd.get(composer.composerId) || '';
        if (cwd) this._composerCwd.set(composer.composerId, cwd);

        const bubbles = this._loadRecentBubbles(db, composer, 12);
        const transcript = this._findTranscriptForComposer(composer.composerId, cwd);

        const analyzed = analyzeCursorComposer(composer, {
          cwd,
          bubbles,
          transcript,
          now
        });

        results.push({
          id: `cursor-${composer.composerId}`,
          ...analyzed
        });
      }
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }

    // Prefer newest first; cap to avoid flooding the feed
    results.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    return results.slice(0, 24);
  }

  /**
   * Build composerId → workspace folder map from workspaceStorage.
   * @param {Map<string, string>} cwdById
   */
  _refreshWorkspaceIndex(cwdById) {
    if (!sqlite || !fs.existsSync(this.workspaceRoot)) return;

    let dirs;
    try {
      dirs = fs.readdirSync(this.workspaceRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const wsDir = path.join(this.workspaceRoot, ent.name);
      const dbPath = path.join(wsDir, 'state.vscdb');
      if (!fs.existsSync(dbPath)) continue;

      let folder = '';
      try {
        const wj = path.join(wsDir, 'workspace.json');
        if (fs.existsSync(wj)) {
          const raw = JSON.parse(fs.readFileSync(wj, 'utf8'));
          folder = fileUrlToPath(raw.folder || raw.workspace || '');
        }
      } catch {
        // ignore
      }

      let wdb;
      try {
        wdb = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
      } catch {
        continue;
      }
      try {
        const row = wdb
          .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
          .get();
        const data = row ? parseDbJson(row.value) : null;
        const list = data && Array.isArray(data.allComposers) ? data.allComposers : [];
        for (const c of list) {
          const id = c.composerId || c.id;
          if (!id) continue;
          // Prefer workspace folder; fall back to any path fields on the entry
          const entryCwd =
            folder ||
            fileUrlToPath(c.workspaceUri || c.folder || '') ||
            '';
          if (entryCwd) {
            cwdById.set(id, entryCwd);
            this._composerCwd.set(id, entryCwd);
          }
        }
      } catch {
        // schema variance — skip workspace
      } finally {
        try {
          wdb.close();
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Load the last N bubbles for a composer (header order).
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {object} composer
   * @param {number} limit
   * @returns {object[]}
   */
  _loadRecentBubbles(db, composer, limit = 12) {
    const headers = Array.isArray(composer.fullConversationHeadersOnly)
      ? composer.fullConversationHeadersOnly
      : [];
    if (headers.length === 0) return [];

    const slice = headers.slice(-limit);
    const bubbles = [];
    const composerId = composer.composerId;

    for (const h of slice) {
      const bid = h.bubbleId || h.id;
      if (!bid) continue;
      try {
        const row = db
          .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
          .get(`bubbleId:${composerId}:${bid}`);
        const b = row ? parseDbJson(row.value) : null;
        if (b) {
          // Preserve header type if bubble omits it
          if (b.type == null && h.type != null) b.type = h.type;
          bubbles.push(b);
        }
      } catch {
        // skip bubble
      }
    }
    return bubbles;
  }

  /**
   * Optional agent-transcript overlay for a composer id.
   * @param {string} composerId
   * @param {string} cwd
   * @returns {object|null}
   */
  _findTranscriptForComposer(composerId, cwd) {
    if (!fs.existsSync(this.projectsRoot)) return null;

    // Direct match: projects/*/agent-transcripts/<composerId>.{txt,jsonl}
    let projectDirs;
    try {
      projectDirs = fs.readdirSync(this.projectsRoot, { withFileTypes: true });
    } catch {
      return null;
    }

    const candidates = [];
    for (const ent of projectDirs) {
      if (!ent.isDirectory()) continue;
      const tdir = path.join(this.projectsRoot, ent.name, 'agent-transcripts');
      if (!fs.existsSync(tdir)) continue;
      for (const ext of ['.jsonl', '.txt']) {
        const p = path.join(tdir, `${composerId}${ext}`);
        if (fs.existsSync(p)) candidates.push(p);
      }
      // Also scan for files whose name starts with composerId
      try {
        for (const f of fs.readdirSync(tdir)) {
          if (f.startsWith(composerId) && (f.endsWith('.jsonl') || f.endsWith('.txt'))) {
            candidates.push(path.join(tdir, f));
          }
        }
      } catch {
        // ignore
      }
    }

    if (candidates.length === 0) return null;

    // Prefer newest mtime
    let best = null;
    let bestMtime = 0;
    for (const p of candidates) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= bestMtime) {
          bestMtime = st.mtimeMs;
          best = p;
        }
      } catch {
        // ignore
      }
    }
    if (!best) return null;

    try {
      const st = fs.statSync(best);
      const read = best.endsWith('.jsonl')
        ? readJsonlEfficient(best)
        : { content: fs.readFileSync(best, 'utf8'), size: st.size };
      if (!read) return null;
      return analyzeCursorTranscript(read.content, {
        mtime: st.mtimeMs,
        now: Date.now()
      });
    } catch {
      return null;
    }
  }

  /**
   * Standalone transcript sessions not already covered by composer ids.
   * @param {number} now
   * @param {boolean} isRunning
   * @param {Array<{id:string}>} composerSessions
   * @returns {Array<object>}
   */
  _scanTranscripts(now, isRunning, composerSessions) {
    if (!fs.existsSync(this.projectsRoot)) return [];

    const covered = new Set(
      (composerSessions || []).map((s) => String(s.id).replace(/^cursor-/, ''))
    );
    const out = [];

    let projectDirs;
    try {
      projectDirs = fs.readdirSync(this.projectsRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const ent of projectDirs) {
      if (!ent.isDirectory()) continue;
      const tdir = path.join(this.projectsRoot, ent.name, 'agent-transcripts');
      if (!fs.existsSync(tdir)) continue;

      let files;
      try {
        files = fs.readdirSync(tdir, { withFileTypes: true });
      } catch {
        continue;
      }

      // Best-effort cwd from project slug is weak; leave empty unless we have path
      const projectLabel = projectSlugToLabel(ent.name);

      for (const f of files) {
        if (!f.isFile()) continue;
        if (!f.name.endsWith('.jsonl') && !f.name.endsWith('.txt')) continue;
        // Skip subagent nests (directories handled separately if needed)
        const base = f.name.replace(/\.(jsonl|txt)$/i, '');
        if (covered.has(base)) continue;

        const full = path.join(tdir, f.name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }

        if (now - st.mtimeMs > RECENT_MS) continue;
        if (!isRunning && now - st.mtimeMs > POST_EXIT_GRACE_MS) continue;
        // Skip tiny empty stubs
        if (st.size < 8) continue;

        try {
          const read = f.name.endsWith('.jsonl')
            ? readJsonlEfficient(full)
            : { content: fs.readFileSync(full, 'utf8') };
          if (!read || !read.content) continue;
          const tr = analyzeCursorTranscript(read.content, {
            mtime: st.mtimeMs,
            now
          });

          // Only surface if there is a real prompt/activity
          if (!tr.userPrompt && !tr.lastMessage && tr.toolCalls.length === 0) continue;

          const sessionId = `cursor-tx-${base}`;
          const taskName =
            extractTaskName(tr.userPrompt) ||
            (projectLabel ? `Cursor · ${projectLabel}` : 'Cursor agent');

          const duration = Math.max(0, st.mtimeMs - (st.birthtimeMs || st.mtimeMs));
          out.push({
            id: sessionId,
            taskName,
            status: tr.status,
            currentTool: tr.currentTool,
            lastMessage: tr.lastMessage,
            userPrompt: tr.userPrompt,
            permissionRequest: null,
            question: null,
            duration,
            durationFormatted: formatDuration(duration),
            startTime: st.birthtimeMs || st.mtimeMs,
            lastTime: st.mtimeMs,
            lastActivityAt: st.mtimeMs,
            terminal: 'Cursor',
            toolCalls: tr.toolCalls,
            activity: tr.activity,
            plan: [],
            isActive: tr.status === 'working',
            model: null,
            cwd: '',
            resumeId: base
          });
        } catch {
          // skip file
        }
      }
    }

    out.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    return out.slice(0, 12);
  }

  async _checkProcess() {
    try {
      const platform = os.platform();

      if (platform === 'win32') {
        const { stdout } = await execFileAsync(
          'tasklist',
          ['/FI', 'IMAGENAME eq Cursor.exe', '/NH'],
          { timeout: 3000, windowsHide: true, encoding: 'utf-8' }
        );
        return stdout.toLowerCase().includes('cursor.exe');
      }

      if (platform === 'darwin') {
        try {
          const { stdout } = await execFileAsync('pgrep', ['-x', 'Cursor'], {
            timeout: 3000,
            encoding: 'utf-8'
          });
          return stdout.trim().length > 0;
        } catch (err) {
          if (err && err.code === 1) return false;
          return false;
        }
      }

      if (platform === 'linux') {
        try {
          const { stdout } = await execFileAsync('pgrep', ['-xi', 'cursor'], {
            timeout: 3000,
            encoding: 'utf-8'
          });
          return stdout.trim().length > 0;
        } catch (err) {
          if (err && err.code === 1) return false;
          return false;
        }
      }

      return false;
    } catch {
      return false;
    }
  }
}

module.exports = {
  CursorWatcher,
  resolveCursorPaths,
  fileUrlToPath,
  mapCursorStatus,
  analyzeCursorComposer,
  analyzeCursorTranscript,
  projectSlugToLabel,
  parseDbJson,
  LIVE_WRITE_MS,
  RECENT_MS
};
