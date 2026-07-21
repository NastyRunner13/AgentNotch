/**
 * Unified session card — expandable with inline approve/ask actions.
 * Shows session status, tool activity, and actions all in one component.
 */

const AGENT_COLORS = {
  'Claude Code': { main: '#D97757', bright: '#E8956E', class: 'agent-claude' },
  'Codex': { main: '#10B981', bright: '#34D399', class: 'agent-codex' },
  'Cursor': { main: '#06B6D4', bright: '#22D3EE', class: 'agent-cursor' },
  'Antigravity': { main: '#4285F4', bright: '#669DF6', class: 'agent-antigravity' },
  'Grok': { main: '#EF4444', bright: '#F87171', class: 'agent-grok' },
  'OpenCode': { main: '#8B5CF6', bright: '#A78BFA', class: 'agent-opencode' }
};

function getStatusInfo(session) {
  if (session.status === 'permission-request') {
    const tool = session.permissionRequest?.tool || session.currentTool;
    return {
      dotClass: 'attention',
      textClass: 'attention',
      text: tool ? `Allow ${humanizeTool(tool)}?` : 'Awaiting permission'
    };
  }
  if (session.status === 'question') {
    return { dotClass: 'attention', textClass: 'attention', text: 'Waiting for answer' };
  }
  if (session.status === 'needs-attention') {
    return { dotClass: 'attention', textClass: 'attention', text: 'Needs attention' };
  }
  if (session.status === 'working') {
    // Status is shown by the harness logo animation.
    // Keep a short activity hint — never raw "exec" / phase keywords.
    const hint = activityHint(session);
    return {
      dotClass: 'working',
      textClass: 'working',
      text: hint || 'Running'
    };
  }
  if (session.status === 'idle') {
    if (session.lastMessage) {
      return {
        dotClass: 'idle',
        textClass: 'idle',
        text: oneLine(session.lastMessage, 64)
      };
    }
    return { dotClass: 'idle', textClass: 'idle', text: 'Finished' };
  }
  return { dotClass: 'idle', textClass: 'idle', text: session.status };
}

/** Short human activity line for working sessions (no exec/done keywords). */
function activityHint(session) {
  const tool = session.currentTool;
  if (tool && !isPhaseLabel(tool) && !isNoiseTool(tool)) {
    return humanizeTool(tool);
  }
  if (session.lastMessage) {
    return oneLine(session.lastMessage, 72);
  }
  return '';
}

function isPhaseLabel(text) {
  if (!text) return false;
  return /…$|\.\.\.$|Thinking|Responding|Streaming|Waiting|Planning|Running tools|^exec$|^done$/i.test(text);
}

/** Tool names that are noise in the status line (animation covers "still running"). */
function isNoiseTool(text) {
  if (!text) return true;
  const t = String(text).trim().toLowerCase();
  return t === 'exec' || t === 'done' || t === 'tool' || t === 'bash' || t === 'run';
}

function humanizeTool(tool) {
  if (!tool) return '';
  let s = String(tool).trim();
  // run_terminal_command: ls → terminal · ls
  const term = s.match(/^run_terminal_command:\s*(.+)$/i);
  if (term) return `Terminal · ${oneLine(term[1], 48)}`;
  s = s
    .replace(/^run_terminal_command$/i, 'Terminal')
    .replace(/^search_replace$/i, 'Editing')
    .replace(/^write$/i, 'Writing file')
    .replace(/^read_file$/i, 'Reading')
    .replace(/^web_search$/i, 'Searching web')
    .replace(/^grep$/i, 'Searching code')
    .replace(/_/g, ' ');
  return oneLine(s, 56);
}

function oneLine(text, max = 80) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Harness logo filenames under assets/icons/ (relative to the renderer HTML). */
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
 * Harness brand logo for bar + session cards.
 * Falls back to a tiny monogram when the agent is unknown.
 */
function getAgentLogo(agentName, size = 20) {
  const file = AGENT_LOGOS[agentName];
  if (file) {
    const src = `${LOGO_BASE}/${file}`;
    return `<img class="agent-logo" src="${src}" width="${size}" height="${size}" alt="" draggable="false" />`;
  }

  // Unknown harness — monogram from first letter
  const letter = escapeHtml(String(agentName || '?').trim().charAt(0).toUpperCase() || '?');
  return `<span class="agent-logo agent-logo-fallback" aria-hidden="true">${letter}</span>`;
}

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Lightweight, safe markdown for agent thinking / replies in the live feed.
 * Escapes HTML first, then applies a small subset agents commonly emit.
 * Supports: fenced code, inline code, headings, bold/italic, lists, paragraphs.
 */
function renderMarkdownLite(src) {
  let text = String(src || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  /** @type {Array<{lang:string, code:string}>} */
  const fences = [];
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = fences.length;
    fences.push({
      lang: String(lang || '').trim().slice(0, 24),
      code: String(code || '').replace(/\n$/, '')
    });
    return `\n\n\u0000FENCE${i}\u0000\n\n`;
  });

  text = escapeHtml(text);

  // Headings (after escape so content is safe)
  text = text.replace(/^#{6}\s+(.+)$/gm, '<div class="md-h md-h6">$1</div>');
  text = text.replace(/^#{5}\s+(.+)$/gm, '<div class="md-h md-h5">$1</div>');
  text = text.replace(/^#{4}\s+(.+)$/gm, '<div class="md-h md-h4">$1</div>');
  text = text.replace(/^#{3}\s+(.+)$/gm, '<div class="md-h md-h3">$1</div>');
  text = text.replace(/^#{2}\s+(.+)$/gm, '<div class="md-h md-h2">$1</div>');
  text = text.replace(/^#\s+(.+)$/gm, '<div class="md-h md-h1">$1</div>');

  // Horizontal rules
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr class="md-hr" />');

  // Unordered / ordered list items
  text = text.replace(/^[\t ]*[-*•]\s+(.+)$/gm, '<div class="md-li">$1</div>');
  text = text.replace(/^[\t ]*\d+\.\s+(.+)$/gm, '<div class="md-li md-ol">$1</div>');

  // Bold then italic (escaped asterisks stay as * in source → we match \*)
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');

  // Restore fenced code blocks
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_, idx) => {
    const block = fences[Number(idx)];
    if (!block) return '';
    const langAttr = block.lang ? ` data-lang="${escapeHtml(block.lang)}"` : '';
    return `<pre class="md-code"${langAttr}><code>${escapeHtml(block.code)}</code></pre>`;
  });

  // Split into blocks on blank lines; keep structural HTML intact
  const parts = text.split(/\n{2,}/).map((part) => {
    const p = part.trim();
    if (!p) return '';
    if (
      p.startsWith('<pre') ||
      p.startsWith('<div class="md-h') ||
      p.startsWith('<div class="md-li') ||
      p.startsWith('<hr')
    ) {
      // Multi-li groups: join consecutive list items already split? keep as-is
      return p.replace(/\n(?!<)/g, '\n');
    }
    // Single newlines inside a paragraph → <br>
    return `<p class="md-p">${p.replace(/\n/g, '<br>')}</p>`;
  });

  // Collapse adjacent list items into a list wrapper for spacing
  let html = parts.filter(Boolean).join('\n');
  html = html.replace(
    /((?:<div class="md-li[^"]*">[\s\S]*?<\/div>\n?)+)/g,
    (block) => `<div class="md-list">${block}</div>`
  );

  return html;
}

function formatClock(timestamp) {
  if (!timestamp) return 'just now';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'just now';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit'
  }).format(date);
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'just now';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Pretty-print model ids for the session tag row (e.g. grok-4.5 → Grok 4.5). */
function formatModelLabel(model) {
  if (!model) return '';
  const raw = String(model).trim();
  if (!raw) return '';
  // Keep short ids compact
  if (raw.length <= 18) {
    return raw
      .replace(/^grok-/i, 'Grok ')
      .replace(/^claude[- ]?/i, 'Claude ')
      .replace(/^gpt-/i, 'GPT-');
  }
  return raw.length > 22 ? `${raw.slice(0, 21)}…` : raw;
}

function renderPlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return '';

  const items = plan.slice(0, 6).map(item => {
    const step = typeof item === 'string' ? item : (item.step || item.title || item.text || 'Untitled step');
    const status = typeof item === 'string' ? 'pending' : (item.status || 'pending');
    const state = ['completed', 'in_progress', 'pending'].includes(status) ? status : 'pending';
    const label = state === 'completed' ? 'Done' : state === 'in_progress' ? 'In progress' : 'Up next';
    return `<li class="plan-step ${state}">
      <span class="plan-marker" aria-hidden="true"></span>
      <span class="plan-step-text">${escapeHtml(step)}</span>
      <span class="plan-step-state">${label}</span>
    </li>`;
  }).join('');

  return `<section class="session-plan">
    <div class="session-prompt-label">Current plan</div>
    <ol class="plan-list">${items}</ol>
  </section>`;
}

/**
 * Mono glyph per activity kind — a scannable type marker for the stream's
 * leading column. Deliberately chroma-free: kind is shape, not color.
 */
function activityGlyph(kind, tool) {
  const k = (kind || '').toLowerCase();
  const t = String(tool || '').toLowerCase();
  if (k === 'thinking') return '…';
  if (k === 'message') return '›';
  if (k === 'terminal' || t.includes('terminal') || t.includes('bash')) return '$';
  if (k === 'file') {
    if (t.includes('write') || t.includes('create')) return '+';
    if (t.includes('read')) return '→';
    if (t.includes('edit') || t.includes('replace') || t.includes('patch')) return '~';
    return '≡';
  }
  if (k === 'search' || t.includes('grep') || t.includes('search')) return '*';
  return '▸';
}

function formatActivityText(update) {
  if (typeof update === 'string') {
    return String(update).replace(/<[^>]+>/g, '').trim();
  }
  const raw = update.text || update.message || update.label || 'Activity updated';
  let text = String(raw).replace(/<[^>]+>/g, '').trim();
  const kind = (update.kind || '').toLowerCase();
  const tool = update.tool || '';

  // Humanize tool prefixes so the feed reads like a terminal log
  if (kind === 'file' || kind === 'tool' || kind === 'search' || kind === 'terminal') {
    text = text
      .replace(/^run_terminal_command:\s*/i, '')
      .replace(/^search_replace:\s*/i, '')
      .replace(/^write:\s*/i, '')
      .replace(/^read_file:\s*/i, '')
      .replace(/^grep:\s*/i, '')
      .replace(/^web_search:\s*/i, '')
      .replace(/^list_dir:\s*/i, '')
      .replace(/^Used\s+/i, '');
  }

  // Prefer short path from filePath when detail is just a tool name
  if (update.filePath && (kind === 'file' || kind === 'search')) {
    const base = String(update.filePath).replace(/\\/g, '/').split('/').filter(Boolean).slice(-3).join('/');
    if (!text.includes(base) && text.length < 24) {
      text = base;
    }
  }

  // Cap very long rows — thinking + messages get room for full agent prose
  const max =
    kind === 'thinking' ? 2200 :
    kind === 'message' ? 2200 :
    kind === 'terminal' ? 500 :
    220;
  if (text.length > max) {
    text = `${text.slice(0, max - 1)}…`;
  }
  return text;
}

/** Rows longer than this collapse behind a "Show more" fold by default. */
const FOLD_MIN_CHARS = 260;

/**
 * Stable identity for an activity event across poll-driven re-renders.
 * Watchers grow a streaming event by appending text, so the first chars
 * (not the tail or timestamp) are the stable part of a long entry.
 */
function activityFoldKey(sessionId, kind, text) {
  const head = String(text).replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${sessionId}|${kind}|${head}`;
}

function renderActivity(session, expandedKeys) {
  const updates = Array.isArray(session.activity) ? session.activity : [];
  const fallback = [];

  // If watcher only sent toolCalls + lastMessage, synthesize a stream
  if (!updates.length && Array.isArray(session.toolCalls)) {
    for (const t of session.toolCalls.slice(-16)) {
      fallback.push({
        text: t,
        at: session.lastActivityAt || session.lastTime,
        kind: /terminal|bash|run\(/i.test(t) ? 'terminal' : /\.(js|ts|css|py|md)\b|edit|write|read/i.test(t) ? 'file' : 'tool',
        tool: t
      });
    }
  }
  if (!updates.length && session.lastMessage) {
    fallback.push({
      text: session.lastMessage,
      at: session.lastActivityAt || session.lastTime,
      kind: 'message'
    });
  }

  const stream = (updates.length ? updates : fallback).slice(-56);

  // Phase labels ("Thinking…", "Running tools…") are transient state, not
  // events. Keep them out of the stream; the latest one becomes the quiet
  // live footer pinned under the feed while the agent works.
  let latestPhase = '';
  const events = [];
  for (const u of stream) {
    const kind = typeof u === 'object' && u.kind ? u.kind : 'tool';
    if (kind === 'phase') {
      latestPhase = formatActivityText(u);
      continue;
    }
    events.push(u);
  }

  const isWorking = session.status === 'working';
  const footer = isWorking ? renderPhaseFooter(latestPhase || activityHint(session)) : '';

  if (!events.length) {
    // Turn just started (only phase labels so far): footer alone says "live".
    if (!footer) return '';
    return `<section class="session-activity-block">
      <div class="session-activity-header">
        <div class="session-prompt-label">Live activity</div>
      </div>
      ${footer}
    </section>`;
  }

  // Chronological (oldest → newest) so it feels like a live agent transcript
  const sorted = [...events].sort((a, b) => {
    const ta = (typeof a === 'object' && a.at) || 0;
    const tb = (typeof b === 'object' && b.at) || 0;
    if (ta !== tb) return ta - tb;
    const rank = { thinking: 1, tool: 2, file: 2, search: 2, terminal: 3, message: 4 };
    const ka = typeof a === 'object' ? a.kind : 'tool';
    const kb = typeof b === 'object' ? b.kind : 'tool';
    return (rank[ka] || 2) - (rank[kb] || 2);
  });

  const rows = sorted.map((update, i) => {
    const isLast = i === sorted.length - 1;
    const isLive = isLast && isWorking;
    const kind = typeof update === 'object' && update.kind ? update.kind : 'tool';
    const tool = typeof update === 'object' ? (update.tool || '') : '';
    const text = formatActivityText(update);
    const at = typeof update === 'string' ? session.lastActivityAt : update.at;
    const isProse = kind === 'thinking' || kind === 'message';
    const kindClass = kind ? ` activity-${kind}` : '';
    const proseClass = isProse ? ' activity-prose' : '';
    const liveClass = isLive ? ' activity-live' : '';
    // The live row trades its kind glyph for a blinking caret — "agent is here"
    const marker = isLive
      ? '<span class="activity-caret" aria-hidden="true"></span>'
      : `<span class="activity-glyph" aria-hidden="true">${escapeHtml(activityGlyph(kind, tool))}</span>`;
    const title = typeof update === 'object' && update.filePath
      ? escapeHtml(update.filePath)
      : escapeHtml(String(typeof update === 'object' ? (update.tool || text) : text).slice(0, 280));

    // Thinking + agent replies: render markdown (headers, code, lists, bold)
    // Tools / terminal: plain escaped mono lines
    const htmlText = isProse
      ? renderMarkdownLite(text)
      : escapeHtml(text).replace(/\n/g, '<br>');

    // Long harness output (thinking / replies / terminal dumps) folds by
    // default: first ~3 lines visible, "Show more" reveals the full text.
    const newlineCount = (text.match(/\n/g) || []).length;
    const needsFold = text.length > FOLD_MIN_CHARS || newlineCount >= 4;
    let foldClass = '';
    let foldToggle = '';
    if (needsFold) {
      const foldKey = activityFoldKey(session.id, kind, text);
      const isOpen = Boolean(expandedKeys && expandedKeys.has(foldKey));
      foldClass = isOpen ? ' activity-fold-open' : ' activity-folded';
      foldToggle = `<button class="activity-toggle" type="button" data-fold-key="${escapeHtml(foldKey)}" aria-expanded="${isOpen}">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        <span class="activity-toggle-label">${isOpen ? 'Show less' : 'Show more'}</span>
      </button>`;
    }

    return `<div class="activity-row${kindClass}${proseClass}${liveClass}${foldClass}" title="${title}">
      ${marker}
      <div class="activity-text${isProse ? ' activity-md' : ''}">${htmlText}</div>
      <time class="activity-time" title="${escapeHtml(formatClock(at))}">${escapeHtml(formatRelativeTime(at))}</time>
      ${foldToggle}
    </div>`;
  }).join('');

  const count = sorted.length;
  const countLabel = count === 1 ? '1 event' : `${count} events`;

  return `<section class="session-activity-block">
    <div class="session-activity-header">
      <div class="session-prompt-label">Live activity</div>
      <span class="session-activity-count">${escapeHtml(countLabel)}</span>
    </div>
    <div class="activity-list activity-live-feed" data-activity-feed="1">${rows}</div>
    ${footer}
  </section>`;
}

/** Quiet "current action" line pinned under the feed while the agent works. */
function renderPhaseFooter(text) {
  const label = oneLine(String(text || '').replace(/\s+/g, ' ').trim() || 'Working', 96);
  return `<div class="activity-phase-footer">
    <span class="activity-phase-dot" aria-hidden="true"></span>
    <span class="activity-phase-text">${escapeHtml(label)}</span>
  </div>`;
}

/**
 * Compact harness logo for the collapsed bar.
 * No logo animation — running = bright, completed = dull.
 */
export function getAgentBarIcon(session) {
  const colors = AGENT_COLORS[session.agent] || { main: '#60A5FA' };
  const isAttention = ['permission-request', 'question', 'needs-attention'].includes(session.status);
  const isWorking = session.status === 'working';
  const statusClass = isAttention ? 'attention' : isWorking ? 'working' : 'idle';

  const toolHint = session.currentTool && !isNoiseTool(session.currentTool)
    ? ` — ${humanizeTool(session.currentTool)}`
    : isWorking
      ? ' — running'
      : session.status === 'idle'
        ? ' — finished'
        : '';

  // Static amber dot for attention only (logo itself never animates)
  const runIndicator = isAttention
    ? `<span class="agent-run-indicator attention" aria-hidden="true" title="Needs attention">
         <span class="agent-run-pulse"></span>
       </span>`
    : '';

  return `<div class="agent-icon-wrap ${statusClass}" style="color: ${colors.main}" title="${escapeHtml(session.agent)}: ${escapeHtml(session.taskName)}${escapeHtml(toolHint)}">
    <div class="agent-icon ${statusClass}">
      ${getAgentLogo(session.agent, 18)}
    </div>
    ${runIndicator}
  </div>`;
}

/**
 * @param {object} session
 * @param {number} [index]
 * @param {{ animateIn?: boolean, expandedActivity?: Set<string> }} [options]
 *   animateIn only for brand-new cards (avoids poll flicker);
 *   expandedActivity holds fold keys of long activity rows the user opened.
 */
export function renderSessionCard(session, index = 0, options = {}) {
  const agent = AGENT_COLORS[session.agent] || { main: '#60A5FA', class: 'agent-claude' };
  const statusInfo = getStatusInfo(session);
  const needsAttention = ['permission-request', 'question', 'needs-attention'].includes(session.status);
  const isWorking = session.status === 'working';
  const delay = index * 50;
  const animateIn = options.animateIn !== false && options.animateIn !== undefined
    ? options.animateIn
    : false;

  // Build expandable detail content
  let detailContent = '';

  // User prompt
  if (session.userPrompt) {
    const cleanPrompt = session.userPrompt.replace(/<[^>]+>/g, '').trim();
    if (cleanPrompt) {
      detailContent += `
        <div>
          <div class="session-prompt-label">Prompt</div>
          <div class="session-prompt">${escapeHtml(cleanPrompt)}</div>
        </div>`;
    }
  }

  detailContent += renderActivity(session, options.expandedActivity);
  detailContent += renderPlan(session.plan);

  // Recent tools only when the live feed is empty (feed already shows tools)
  const hasActivityFeed = Array.isArray(session.activity) && session.activity.length > 0;
  if (!hasActivityFeed && session.toolCalls && session.toolCalls.length > 0) {
    const toolsHtml = session.toolCalls.map(t =>
      `<span class="session-tool">${escapeHtml(t)}</span>`
    ).join('');
    detailContent += `
      <div>
        <div class="session-prompt-label">Recent Tools</div>
        <div class="session-tools">${toolsHtml}</div>
      </div>`;
  }

  // Inline approval
  if (session.status === 'permission-request' && session.permissionRequest) {
    const pr = session.permissionRequest;
    detailContent += renderInlineApproval(session, pr);
  }

  // Inline question
  if (session.status === 'question' && session.question) {
    detailContent += renderInlineQuestion(session);
  }

  // Actions
  detailContent += `
    <div class="session-actions">
      <button class="btn-jump" data-session-id="${escapeHtml(session.id)}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        Jump to ${escapeHtml(session.terminal || 'Terminal')}
      </button>
    </div>`;

  // Logo stays still (bright/dull via CSS); static side cues for attention / finished
  const petIndicator = needsAttention
    ? `<span class="session-run-indicator attention" aria-label="Needs attention" title="Needs attention">
         <span class="session-run-pulse"></span>
       </span>`
    : session.status === 'idle'
      ? `<span class="session-run-indicator idle" aria-label="Finished" title="Finished">
           <span class="session-run-check"></span>
         </span>`
      : '';

  // Multicolor laser that sweeps active (working) session windows.
  // Poll-driven list rebuilds recreate these nodes, which would restart the
  // CSS animations from 0% and freeze the sweep at the left edge. Negative
  // animation-delay keyed to wall-clock time keeps the phase continuous.
  const now = Date.now();
  const sessionLaser = isWorking
    ? `<div class="session-laser" aria-hidden="true">
         <span class="session-laser-beam" style="animation-delay: -${now % 2400}ms"></span>
         <span class="session-laser-glow" style="animation-delay: -${now % 3200}ms"></span>
         <span class="session-laser-edge" style="animation-delay: -${now % 2800}ms"></span>
       </div>`
    : '';

  const cardClasses = [
    'session-card',
    needsAttention ? 'attention' : '',
    isWorking ? 'is-working' : '',
    animateIn ? 'card-enter' : 'card-static'
  ].filter(Boolean).join(' ');

  return `
    <div class="${cardClasses}"
         data-session-id="${escapeHtml(session.id)}"
         data-status="${escapeHtml(session.status)}"
         role="button"
         tabindex="0"
         aria-expanded="false"
         aria-label="${escapeHtml(session.agent)}: ${escapeHtml(session.taskName)}"
         style="${animateIn ? `animation-delay: ${delay}ms` : ''}">
      ${sessionLaser}
      <div class="session-header">
        <div class="session-pet-wrap ${isWorking ? 'working' : needsAttention ? 'attention' : session.status === 'idle' ? 'idle' : ''}"
             style="color: ${agent.main}">
          <div class="session-pet">
            ${getAgentLogo(session.agent, 22)}
          </div>
          ${petIndicator}
        </div>
        <div class="session-meta">
          <div class="session-row-top">
            <span class="session-name">${escapeHtml(session.taskName)}</span>
            <span class="session-tag ${agent.class}">${escapeHtml(session.agent)}</span>
            ${session.model ? `<span class="session-model" title="Model">${escapeHtml(formatModelLabel(session.model))}</span>` : ''}
            <span class="session-duration">${escapeHtml(session.durationFormatted)}</span>
          </div>
          <div class="session-status-line">
            <span class="session-status-text ${statusInfo.textClass}">${escapeHtml(statusInfo.text)}</span>
            <span class="session-last-seen">${escapeHtml(formatRelativeTime(session.lastActivityAt || session.lastTime))}</span>
          </div>
        </div>
      </div>
      <div class="session-detail">
        <div class="session-detail-inner">
          ${detailContent}
        </div>
      </div>
    </div>`;
}

function renderInlineApproval(session, pr) {
  const remote = Boolean(session.remoteApprove || pr.remote);
  const fileName = pr.filePath ? pr.filePath.split(/[/\\]/).pop() : '';

  let diffHtml = '';
  if (pr.input) {
    const content =
      pr.input.content ||
      pr.input.code ||
      pr.input.diff ||
      pr.input.command ||
      pr.input.description ||
      '';
    if (content) {
      const lines = String(content).split('\n').slice(0, 6);
      diffHtml = lines.map((line, i) => {
        let cls = 'ctx';
        if (line.startsWith('+')) cls = 'add';
        else if (line.startsWith('-')) cls = 'del';
        return `<div class="diff-line ${cls}"><span class="diff-ln">${i + 1}</span>${escapeHtml(line)}</div>`;
      }).join('');
      diffHtml = `<div class="approval-diff">${diffHtml}</div>`;
    }
  }

  const denyTitle = remote ? 'Deny from AgentNotch' : 'Open agent to deny';
  const allowTitle = remote ? 'Approve from AgentNotch' : 'Open agent to approve';
  const hint = remote
    ? 'Approves or denies in Claude Code without leaving the notch.'
    : session.agent === 'Claude Code'
      ? 'Opens Claude — or install the remote-approve hook in Settings for in-notch Allow/Deny.'
      : 'Opens the agent so you can approve or deny there.';

  return `
    <div class="session-approval ${remote ? 'remote' : 'focus-only'}">
      <div class="approval-info">
        <span class="approval-icon">⚠</span>
        <span class="approval-name">${escapeHtml(pr.tool)}</span>
        ${pr.filePath ? `<span class="approval-path">${escapeHtml(pr.filePath)}</span>` : ''}
        ${remote ? '<span class="approval-badge" title="Remote approve via Claude hook">Notch</span>' : ''}
      </div>
      ${diffHtml}
      <div class="approval-btns">
        <button class="btn-deny" data-session-id="${escapeHtml(session.id)}" title="${denyTitle}">Deny <kbd>Ctrl+N</kbd></button>
        <button class="btn-allow" data-session-id="${escapeHtml(session.id)}" title="${allowTitle}">Allow <kbd>Ctrl+Y</kbd></button>
      </div>
      <p class="approval-hint">${hint}</p>
    </div>`;
}

function renderInlineQuestion(session) {
  const q = session.question;
  if (!q) return '';

  const options = (q.options || []).map((opt, i) => {
    const shortcut = i < 9 ? `Ctrl+${i + 1}` : '';
    const label = typeof opt === 'string' ? opt : (opt.label || opt.value || String(opt));
    const value = typeof opt === 'string' ? opt : (opt.value || opt.label || String(i));
    return `
      <button class="ask-option"
              data-session-id="${escapeHtml(session.id)}"
              data-answer="${escapeHtml(value)}">
        ${shortcut ? `<span class="ask-option-num">${shortcut}</span>` : ''}
        <span>${escapeHtml(label)}</span>
      </button>`;
  }).join('');

  return `
    <div class="session-question">
      <div class="question-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" opacity="0.9">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
        </svg>
        ${escapeHtml(session.agent)} asks
      </div>
      <div class="question-text">${escapeHtml(q.text)}</div>
      ${options ? `<div class="question-options">${options}</div>` : ''}
    </div>`;
}
