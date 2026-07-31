/**
 * History view — past sessions with search, pin, and continue actions.
 */

/** Agents that can receive headless continue from history (mirror main). */
export const HISTORY_DISPATCHABLE = new Set([
  'Claude Code',
  'Codex',
  'Grok',
  'OpenCode'
]);

export const DEFAULT_CONTINUE_PROMPT = 'Continue from where we left off.';

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

/**
 * Client-side history search (task, agent, prompt, project folder).
 * @param {object[]} entries
 * @param {string} [query]
 * @returns {object[]}
 */
export function filterHistoryEntries(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list.slice();

  return list.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
    const base = cwd.split(/[/\\]/).filter(Boolean).pop() || '';
    const hay = [
      entry.taskName,
      entry.agent,
      entry.userPrompt,
      entry.lastMessage,
      cwd,
      base
    ]
      .map((v) => String(v || '').toLowerCase())
      .join('\n');
    return hay.includes(q);
  });
}

/**
 * @param {object[]} entries
 * @returns {{ pinned: object[], unpinned: object[] }}
 */
export function partitionPinnedHistory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const pinned = [];
  const unpinned = [];
  for (const entry of list) {
    if (entry && entry.pinned) pinned.push(entry);
    else if (entry) unpinned.push(entry);
  }
  pinned.sort((a, b) => (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0));
  return { pinned, unpinned };
}

export function projectFolderName(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * @param {object[]} history — newest-first from main
 * @param {string|null} [expandedId]
 * @param {{ query?: string }} [options]
 */
export function renderHistoryView(history, expandedId = null, options = {}) {
  const query = options.query || '';
  const filtered = filterHistoryEntries(history, query);

  if (!history || history.length === 0) return '';

  const toolbar = `
    <div class="history-toolbar">
      <label class="history-search-wrap" for="history-search">
        <svg class="history-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="search" id="history-search" class="history-search" placeholder="Search task, project, agent…" value="${escapeHtml(query)}" autocomplete="off" spellcheck="false" aria-label="Search history" />
      </label>
    </div>`;

  if (filtered.length === 0) {
    return `${toolbar}
      <div class="history-no-match" role="status">
        <p class="history-no-match-title">No matching history</p>
        <p class="history-no-match-desc">Try another agent, project folder, or task name.</p>
      </div>
      <button class="history-clear-btn" id="btn-clear-history" type="button">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        Clear History
      </button>`;
  }

  const { pinned, unpinned } = partitionPinnedHistory(filtered);

  let html = toolbar;

  if (pinned.length > 0) {
    html += `<div class="history-date-group">
      <div class="history-date-label">Pinned</div>`;
    for (const entry of pinned) {
      html += renderHistoryEntry(entry, expandedId);
    }
    html += '</div>';
  }

  // Group unpinned by date
  const groups = new Map();
  for (const entry of unpinned) {
    const label = getDateLabel(entry.archivedAt || entry.lastTime);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(entry);
  }

  for (const [dateLabel, entries] of groups) {
    html += `<div class="history-date-group">
      <div class="history-date-label">${dateLabel}</div>`;
    for (const entry of entries) {
      html += renderHistoryEntry(entry, expandedId);
    }
    html += '</div>';
  }

  html += `<button class="history-clear-btn" id="btn-clear-history" type="button">
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
    Clear History
  </button>`;

  return html;
}

function renderHistoryEntry(entry, expandedId) {
  const cleanTask = (entry.taskName || 'Untitled').replace(/<[^>]+>/g, '').trim();
  const isExpanded = entry.id === expandedId;
  const project = projectFolderName(entry.cwd);
  const subParts = [entry.agent, project].filter(Boolean);
  const prompt = entry.userPrompt
    ? `<div><span>Prompt</span>${escapeHtml(entry.userPrompt)}</div>`
    : '';
  const activity = entry.lastMessage
    ? `<div><span>Last activity</span>${escapeHtml(entry.lastMessage)}</div>`
    : '';
  const tools = entry.toolCalls && entry.toolCalls.length
    ? `<div><span>Tools</span><div class="history-tools">${entry.toolCalls.map(tool => `<code>${escapeHtml(tool)}</code>`).join('')}</div></div>`
    : '';

  const canContinue = HISTORY_DISPATCHABLE.has(entry.agent);
  const isPinned = Boolean(entry.pinned);
  const pinLabel = isPinned ? 'Unpin' : 'Pin';
  const pinTitle = isPinned ? 'Unpin from top of history' : 'Pin to top of history';

  const actions = `
    <div class="history-actions" data-stop-expand="1">
      <input type="text" class="history-continue-input" data-history-id="${escapeHtml(entry.id)}"
        placeholder="${escapeHtml(DEFAULT_CONTINUE_PROMPT)}"
        aria-label="Continue prompt" ${canContinue ? '' : 'disabled'} />
      <button type="button" class="btn-history-continue" data-history-id="${escapeHtml(entry.id)}"
        ${canContinue ? '' : 'disabled'}
        title="${canContinue ? 'Resume or continue this session' : 'This agent cannot receive messages from the notch'}">
        Continue
      </button>
      <button type="button" class="btn-history-jump" data-history-id="${escapeHtml(entry.id)}" data-agent="${escapeHtml(entry.agent || '')}"
        title="Focus ${escapeHtml(entry.agent || 'agent')}">
        Jump
      </button>
    </div>`;

  return `
    <article class="history-entry ${isExpanded ? 'expanded' : ''} ${isPinned ? 'is-pinned' : ''}" data-id="${escapeHtml(entry.id)}">
      ${getHistoryLogo(entry.agent, 16)}
      <div class="history-info">
        <span class="history-name">${escapeHtml(cleanTask)}</span>
        <span class="history-sub">${escapeHtml(subParts.join(' · '))}</span>
      </div>
      <div class="history-meta">
        <button type="button" class="btn-history-pin ${isPinned ? 'active' : ''}"
          data-history-id="${escapeHtml(entry.id)}" data-pinned="${isPinned ? '1' : '0'}"
          aria-label="${pinLabel}" aria-pressed="${isPinned ? 'true' : 'false'}"
          title="${pinTitle}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 17v5"/>
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>
          </svg>
        </button>
        <span class="history-duration">${escapeHtml(entry.durationFormatted || '—')}</span>
        <span class="history-time">${formatTime(entry.archivedAt || entry.lastTime)}</span>
      </div>
      <div class="history-detail">
        <div class="history-detail-inner">
          ${prompt}${activity}${tools}
          ${actions}
        </div>
      </div>
    </article>`;
}
