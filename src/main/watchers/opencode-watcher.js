const path = require('path');
const os = require('os');
const fs = require('fs');
const { BaseWatcher, formatDuration, extractTaskName } = require('./base-watcher');
const { classifyActivityTool } = require('./session-utils');

/**
 * OpencodeWatcher — monitors OpenCode sessions via its SQLite WAL database.
 *
 * OpenCode stores everything in a single SQLite database:
 *   Linux/macOS: ~/.local/share/opencode/opencode.db
 *   Windows:     %APPDATA%\opencode\opencode.db  or  %LOCALAPPDATA%\opencode\opencode.db
 *
 * Tables of interest:
 *   session  — id, title, model (JSON), time_created, time_updated
 *   message  — id, session_id, data (JSON: {role, modelID, ...})
 *   part     — id, message_id, session_id, data (JSON: {type, tool, state:{status}, input})
 *
 * Live permission requests are NOT persisted in the DB, so we report
 * working/idle + activity + model — no remote approve.
 *
 * node:sqlite is available in Node ≥22.5.0 (Electron 36's bundled Node).
 * We wrap all DB access in try/catch and degrade gracefully if unavailable.
 */

/** Probe candidate paths in order and return the first that exists. */
function resolveDbPath() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'opencode', 'opencode.db') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db') : null,
    path.join(home, 'Library', 'Application Support', 'opencode', 'opencode.db') // macOS fallback
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // skip
    }
  }
  return candidates[0]; // Return first candidate even if not found yet
}

/** Try to load node:sqlite — returns null if unavailable (older Node/Electron). */
function tryLoadSqlite() {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
}

const sqlite = tryLoadSqlite();

/**
 * Derive the current tool label from an OpenCode part row's data JSON.
 * Mirrors the label conventions used by Codex watcher for consistency.
 */
function labelFromPart(data) {
  if (!data) return null;
  const type = data.type || '';
  const toolName = data.tool || data.toolName || '';

  if (type === 'tool' || type === 'tool-invocation') {
    const input = data.input || data.state?.input || {};
    if (toolName.toLowerCase().includes('bash') || toolName.toLowerCase().includes('exec')) {
      const cmd = typeof input.command === 'string'
        ? input.command.replace(/\s+/g, ' ').slice(0, 100)
        : (typeof input === 'string' ? input.slice(0, 100) : '');
      return cmd ? `bash: ${cmd}` : toolName;
    }
    const fp = input.file_path || input.filePath || input.path || '';
    if (fp) {
      return `${toolName}: ${String(fp).split(/[/\\]/).pop()}`;
    }
    return toolName || null;
  }
  return null;
}

/**
 * Pure function: derive session state from DB row data.
 * Exported for unit tests.
 *
 * @param {object} sessionRow   — row from `session` table
 * @param {object[]} messages   — rows from `message` table for this session
 * @param {object[]} parts      — rows from `part` table for this session
 * @param {number} now          — Date.now()
 * @param {number} staleMs      — threshold to demote working→idle (default 60s)
 * @returns {object}            — session state object
 */
function analyzeOpencodeSession(sessionRow, messages, parts, now, staleMs = 60_000) {
  const sessionId = `opencode-${sessionRow.id}`;
  const startTime = Number(sessionRow.time_created) || now;
  const lastTime = Number(sessionRow.time_updated) || startTime;
  const duration = Math.max(0, lastTime - startTime);

  // Parse model from session JSON field (real shape: {"id":"kimi-k3","providerID":...})
  let model = null;
  try {
    const modelData = typeof sessionRow.model === 'string'
      ? JSON.parse(sessionRow.model)
      : sessionRow.model;
    model = modelData?.modelID || modelData?.id || modelData?.name || null;
  } catch {
    // ignore
  }

  // Tokens / cost live as plain columns on the session row
  const tokens = {
    input: Number(sessionRow.tokens_input) || 0,
    output: Number(sessionRow.tokens_output) || 0,
    reasoning: Number(sessionRow.tokens_reasoning) || 0,
    cacheRead: Number(sessionRow.tokens_cache_read) || 0,
    cacheWrite: Number(sessionRow.tokens_cache_write) || 0
  };
  const cost = Number(sessionRow.cost) || 0;

  // Message roles by id — message/part text lives in part rows, role in message.data
  const roleByMessageId = new Map();
  for (const m of messages || []) {
    try {
      const d = typeof m.data === 'string' ? JSON.parse(m.data) : (m.data || {});
      if (m.id && d.role) roleByMessageId.set(String(m.id), d.role);
    } catch {
      // skip
    }
  }

  // Derive status from parts
  let status = 'idle';
  let currentTool = null;
  const toolCalls = [];
  const activity = [];
  let firstUserText = '';
  let lastAssistantText = '';

  // Chronological order — prefer row timestamps; string ids are time-ordered as fallback
  const sortedParts = [...parts].sort((a, b) => {
    const ta = Number(a.time_created) || 0;
    const tb = Number(b.time_created) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });

  for (const part of sortedParts) {
    let data;
    try {
      data = typeof part.data === 'string' ? JSON.parse(part.data) : (part.data || {});
    } catch {
      continue;
    }

    const type = data.type || '';
    const state = data.state || {};
    const at = Number(part.time_created) || lastTime;
    const role = roleByMessageId.get(String(part.message_id)) || '';

    // OpenCode multi-step turns look like:
    //   step-start → reasoning/text/tools → step-finish(reason=tool-calls)
    //   → more steps… → step-finish(reason=stop)
    // Only reason=stop ends the turn. Intermediate step-finish must stay working
    // or the UI flickers "Finished" on every streamed event.
    if (type === 'step-start') {
      status = 'working';
      continue;
    }

    if (type === 'step-finish') {
      const reason = data.reason || '';
      if (reason === 'tool-calls') {
        // Model finished a generation step but will continue with tools / more steps
        status = 'working';
        currentTool = null;
      } else {
        // reason === 'stop' (or unknown terminal) → agent turn completed
        status = 'idle';
        currentTool = null;
      }
      continue;
    }

    if (type === 'tool' || type === 'tool-invocation') {
      const toolStatus = state.status || '';
      const label = labelFromPart(data);

      if (toolStatus === 'running' || toolStatus === 'pending') {
        status = 'working';
        currentTool = label;
      } else if (toolStatus === 'completed' || toolStatus === 'error') {
        // Tool done — agent usually continues with the next step. Stay working
        // if we already were; don't flip to idle here (step-finish reason=stop does that).
        status = 'working';
        if (currentTool && label && currentTool === label) currentTool = null;
      }

      if (label) {
        toolCalls.push(label);
        activity.push({
          text: label,
          at,
          kind: classifyActivityTool(label),
          tool: data.tool || label
        });
      }
      continue;
    }

    if (type === 'text' || type === 'reasoning') {
      const text = typeof data.text === 'string' ? data.text : '';
      if (text.trim()) {
        if (type === 'text' && role === 'user' && !firstUserText) {
          firstUserText = text.trim();
        }
        if (type === 'text' && role === 'assistant') {
          lastAssistantText = text.trim();
          status = 'working';
        }
        if (type === 'reasoning') {
          // Thinking stream while the agent is mid-turn
          status = 'working';
        }
        activity.push({
          text: text.slice(0, 1200),
          at,
          kind: type === 'reasoning' ? 'thinking' : 'message'
        });
      }
    }
  }

  // Staleness demote: if the last DB update was too long ago, demote working → idle
  const msSinceUpdate = now - lastTime;
  if (status === 'working' && msSinceUpdate > staleMs) {
    status = 'idle';
    currentTool = null;
  }

  // Task name: OpenCode auto-title, else first user message, else generic
  const taskName = (sessionRow.title && sessionRow.title.trim())
    ? sessionRow.title.trim()
    : (firstUserText ? extractTaskName(firstUserText) : 'OpenCode session');

  // Last assistant text part is the real "latest reply"; fall back to a
  // message.data.content scan for older/alternate schema shapes
  let lastMessage = lastAssistantText.slice(0, 500);
  if (!lastMessage) {
    for (let i = messages.length - 1; i >= 0; i--) {
      try {
        const msgData = typeof messages[i].data === 'string'
          ? JSON.parse(messages[i].data)
          : (messages[i].data || {});
        if (msgData.role === 'assistant') {
          const content = typeof msgData.content === 'string'
            ? msgData.content
            : '';
          if (content.trim()) {
            lastMessage = content.slice(0, 500);
            break;
          }
        }
      } catch {
        // skip
      }
    }
  }

  return {
    id: sessionId,
    agent: 'OpenCode',
    taskName,
    status,
    currentTool,
    lastMessage,
    userPrompt: '',
    duration,
    durationFormatted: formatDuration(duration),
    startTime,
    lastTime,
    lastActivityAt: lastTime,
    terminal: 'Terminal',
    toolCalls: toolCalls.slice(-30),
    activity: activity.slice(-40),
    isActive: status === 'working',
    model,
    tokens,
    cost,
    cwd: typeof sessionRow.directory === 'string' ? sessionRow.directory : ''
  };
}

class OpencodeWatcher extends BaseWatcher {
  constructor(options = {}) {
    super('OpenCode', { pollInterval: 3000, ...options });
    this.dbPath = options.dbPath || resolveDbPath();
    this._lastChangeToken = '';
  }

  _start() {
    if (!sqlite) {
      console.warn('[OpenCode] node:sqlite not available — watcher inactive. Requires Node ≥22.5');
      return;
    }
    console.log(`[OpenCode] Watching DB at ${this.dbPath}`);
    // Watch the directory containing the DB for WAL writes
    const dbDir = path.dirname(this.dbPath);
    if (fs.existsSync(dbDir)) {
      this.watchDirs(dbDir);
    }
  }

  _stop() {
    this._lastChangeToken = '';
  }

  /**
   * Change token across the db AND its WAL sidecars. In WAL mode, writes land
   * in opencode.db-wal between checkpoints, so the main db file's mtime alone
   * can stay stale for minutes — gating on it would miss live updates.
   * Returns null when the db doesn't exist yet.
   */
  _changeToken() {
    let dbStat;
    try {
      dbStat = fs.statSync(this.dbPath);
    } catch {
      return null;
    }
    let newest = dbStat.mtimeMs;
    let walSize = 0;
    for (const suffix of ['-wal', '-shm']) {
      try {
        const st = fs.statSync(this.dbPath + suffix);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (suffix === '-wal') walSize = st.size;
      } catch {
        // sidecar absent — fine
      }
    }
    return `${newest}:${walSize}`;
  }

  async _poll() {
    if (!sqlite) return;

    const token = this._changeToken();
    if (!token) return; // Not installed yet
    if (token === this._lastChangeToken) return;

    try {
      await this._pollDb(token);
    } catch (err) {
      // Defensive: DB schema may change; degrade to "no sessions"
      console.warn('[OpenCode] DB poll failed:', err.message);
    }
  }

  async _pollDb(changeToken) {
    const db = new sqlite.DatabaseSync(this.dbPath, { open: true, readOnly: true });
    try {
      const now = Date.now();
      const cutoff = now - 12 * 60 * 60 * 1000; // 12 hours

      // Query active sessions. Prefer the full column set (tokens/cost);
      // fall back to the minimal set so older schemas still track sessions.
      let sessionRows;
      try {
        sessionRows = db.prepare(
          'SELECT id, title, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, directory FROM session WHERE time_updated > ? ORDER BY time_updated DESC LIMIT 50'
        ).all(cutoff);
      } catch {
        try {
          sessionRows = db.prepare(
            'SELECT id, title, model, time_created, time_updated FROM session WHERE time_updated > ? ORDER BY time_updated DESC LIMIT 50'
          ).all(cutoff);
        } catch {
          // Table may not exist in all schema versions
          return;
        }
      }

      // Work for this change token is about to be done — record it so the
      // next poll can skip when nothing new was written.
      this._lastChangeToken = changeToken;

      // console.log(`[OpenCode] Poll: ${sessionRows.length} session(s) in 12h window`);
      const activeIds = new Set();

      for (const row of sessionRows) {
        const sessionId = `opencode-${row.id}`;
        activeIds.add(sessionId);

        try {
          // Fetch messages and parts for this session (timestamps feed the activity feed)
          let messages = [];
          let parts = [];
          try {
            const msgStmt = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY id');
            messages = msgStmt.all(row.id);
          } catch { /* no message table */ }

          try {
            const partStmt = db.prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY id');
            parts = partStmt.all(row.id);
          } catch { /* no part table */ }

          const sessionData = analyzeOpencodeSession(row, messages, parts, now);
          this._updateSession(sessionId, sessionData);
        } catch (err) {
          console.warn(`[OpenCode] Failed to process session ${row.id}:`, err.message);
        }
      }

      // Remove sessions that have vanished from recent activity
      for (const [id] of this.sessions) {
        if (id.startsWith('opencode-') && !activeIds.has(id)) {
          this._removeSession(id);
        }
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

module.exports = { OpencodeWatcher, analyzeOpencodeSession, resolveDbPath };
