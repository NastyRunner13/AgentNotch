const { parseJSONL, formatDuration, getDurationFromFile, isFileActive } = require('./base-watcher');

/**
 * Shared helpers for agent JSONL watchers.
 */

function getText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(part => part && (part.text || part.content || part.value || ''))
    .filter(Boolean)
    .join('\n');
}

function normalizePlan(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
    step: typeof item === 'string' ? item : (item.step || item.title || item.text || ''),
    status: typeof item === 'string' ? 'pending' : (item.status || 'pending')
  })).filter(item => item.step);
}

/**
 * Build a chronological activity timeline for session cards.
 * Prefer richer per-watcher timelines when available; this is the shared fallback.
 * @param {string} lastMessage
 * @param {string[]} toolCalls
 * @param {number} at
 * @param {Array<{text?:string, at?:number, kind?:string}>} [extra]
 */
function buildActivity(lastMessage, toolCalls, at, extra = []) {
  const activity = [];

  for (const tool of (toolCalls || []).slice(-20)) {
    const text = String(tool || '').trim();
    if (!text) continue;
    activity.push({
      text,
      at,
      kind: classifyActivityTool(text),
      tool: text
    });
  }

  for (const item of extra || []) {
    if (!item) continue;
    const text = typeof item === 'string' ? item : (item.text || item.message || '');
    if (!text) continue;
    activity.push({
      text: String(text).length > 1200 ? String(text).slice(-1200) : String(text),
      at: (typeof item === 'object' && item.at) || at,
      kind: (typeof item === 'object' && item.kind) || 'message',
      filePath: typeof item === 'object' ? item.filePath : undefined,
      tool: typeof item === 'object' ? item.tool : undefined
    });
  }

  if (lastMessage) {
    const msg = String(lastMessage);
    activity.push({
      text: msg.length > 1200 ? msg.slice(-1200) : msg,
      at,
      kind: 'message'
    });
  }

  return activity.slice(-40);
}

function classifyActivityTool(label) {
  const n = String(label || '').toLowerCase();
  if (n.includes('terminal') || n.includes('bash') || n.includes('shell') || n.startsWith('run(') || n.includes('run_terminal')) {
    return 'terminal';
  }
  if (
    n.includes('edit') ||
    n.includes('write') ||
    n.includes('read') ||
    n.includes('search_replace') ||
    n.includes('str_replace') ||
    n.includes('apply_patch') ||
    /\.(js|ts|tsx|jsx|py|go|rs|css|html|md|json|yml|yaml)\b/i.test(n)
  ) {
    return 'file';
  }
  if (n.includes('grep') || n.includes('search') || n.includes('glob') || n.includes('find')) {
    return 'search';
  }
  return 'tool';
}

module.exports = {
  getText,
  normalizePlan,
  buildActivity,
  classifyActivityTool,
  parseJSONL,
  formatDuration,
  getDurationFromFile,
  isFileActive
};
