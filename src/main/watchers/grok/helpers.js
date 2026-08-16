const { getText } = require('../session-utils');

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

module.exports = {
  getAcpUpdate,
  extractChunkText,
  extractToolName,
  formatToolInput,
  extractToolFilePath,
  classifyToolKind,
  phaseToLabel,
  resolveTimestamp,
  truncate,
  uniqueTail,
  mergeUniqueTail,
  buildRichActivity
};
