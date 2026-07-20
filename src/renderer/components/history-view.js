/**
 * History view component — renders past sessions grouped by date.
 */

/** Agent logo filenames under assets/icons/ (relative to the renderer HTML). */
const AGENT_LOGOS = {
  'Claude Code': 'claude-code.png',
  'Codex': 'codex.png',
  'Cursor': 'cursor.png',
  'Antigravity': 'antigravity.png',
  'Grok': 'grok-build.png',
  'OpenCode': 'opencode.png'
};

const LOGO_BASE = '../../assets/icons';

/**
 * Agent logo for history entries.
 * Falls back to a monogram when the agent is unknown.
 */
function getHistoryLogo(agentName, size = 16) {
  const file = AGENT_LOGOS[agentName];
  if (file) {
    const src = `${LOGO_BASE}/${file}`;
    return `<img class="history-logo" src="${src}" width="${size}" height="${size}" alt="" draggable="false" />`;
  }
  const letter = escapeHtml(String(agentName || '?').trim().charAt(0).toUpperCase() || '?');
  return `<span class="history-logo history-logo-fallback" aria-hidden="true">${letter}</span>`;
}

function escapeHtml(text) {
  // Explicit String() cast so falsy values like 0 are preserved (not treated as empty)
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m} ${ampm}`;
}

function getDateLabel(ts) {
  if (!ts) return 'Unknown';
  const now = new Date();
  const d = new Date(ts);

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const sessionDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (sessionDate.getTime() === today.getTime()) return 'Today';
  if (sessionDate.getTime() === yesterday.getTime()) return 'Yesterday';

  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function renderHistoryView(history, expandedId = null) {
  if (!history || history.length === 0) return '';

  // Group by date
  const groups = new Map();
  for (const entry of history) {
    const label = getDateLabel(entry.archivedAt || entry.lastTime);
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(entry);
  }

  let html = '';

  for (const [dateLabel, entries] of groups) {
    html += `<div class="history-date-group">
      <div class="history-date-label">${dateLabel}</div>`;

    for (const entry of entries) {
      const cleanTask = (entry.taskName || 'Untitled').replace(/<[^>]+>/g, '').trim();
      const isExpanded = entry.id === expandedId;
      const prompt = entry.userPrompt ? `<div><span>Prompt</span>${escapeHtml(entry.userPrompt)}</div>` : '';
      const activity = entry.lastMessage ? `<div><span>Last activity</span>${escapeHtml(entry.lastMessage)}</div>` : '';
      const tools = entry.toolCalls && entry.toolCalls.length
        ? `<div><span>Tools</span><div class="history-tools">${entry.toolCalls.map(tool => `<code>${escapeHtml(tool)}</code>`).join('')}</div></div>`
        : '';

      html += `
        <article class="history-entry ${isExpanded ? 'expanded' : ''}" data-id="${escapeHtml(entry.id)}">
          ${getHistoryLogo(entry.agent, 16)}
          <div class="history-info">
            <span class="history-name">${escapeHtml(cleanTask)}</span>
            <span class="history-sub">${escapeHtml(entry.agent)}</span>
          </div>
          <div class="history-meta">
            <span class="history-duration">${escapeHtml(entry.durationFormatted || '—')}</span>
            <span class="history-time">${formatTime(entry.archivedAt || entry.lastTime)}</span>
          </div>
          <div class="history-detail">
            <div class="history-detail-inner">
              ${prompt}${activity}${tools}
            </div>
          </div>
        </article>`;
    }

    html += '</div>';
  }

  html += `<button class="history-clear-btn" id="btn-clear-history">
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
    Clear History
  </button>`;

  return html;
}
