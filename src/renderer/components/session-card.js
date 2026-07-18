/**
 * Unified session card — expandable with inline approve/ask actions.
 * Shows session status, tool activity, and actions all in one component.
 */

const AGENT_COLORS = {
  'Claude Code': { main: '#D97757', bright: '#E8956E', class: 'agent-claude' },
  'Codex': { main: '#10B981', bright: '#34D399', class: 'agent-codex' },
  'Cursor': { main: '#06B6D4', bright: '#22D3EE', class: 'agent-cursor' },
  'Antigravity': { main: '#4285F4', bright: '#669DF6', class: 'agent-antigravity' },
  'Grok': { main: '#EF4444', bright: '#F87171', class: 'agent-grok' }
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
    // Status is shown by the running animation beside the icon.
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

function getPixelPet(status, agentName) {
  const colors = AGENT_COLORS[agentName] || { main: '#60A5FA', bright: '#93C5FD' };
  const isIdle = status === 'idle' || status === 'stopped';
  const mainColor = isIdle ? '#4ADE80' : colors.main;
  const brightColor = isIdle ? '#86EFAC' : colors.bright;

  return `<svg width="24" height="14" viewBox="0 0 13 8" shape-rendering="crispEdges">
    <rect x="2" y="2" width="1" height="1" fill="${brightColor}"/>
    <rect x="5" y="2" width="1" height="1" fill="${brightColor}"/>
    <rect x="1" y="3" width="6" height="1" fill="${mainColor}"/>
    <rect x="2" y="3" width="1" height="1" fill="#000"/>
    <rect x="5" y="3" width="1" height="1" fill="#000"/>
    <rect x="1" y="4" width="6" height="1" fill="${mainColor}"/>
    <rect x="2" y="5" width="2" height="1" fill="${mainColor}"/>
    <rect x="5" y="5" width="2" height="1" fill="${mainColor}"/>
  </svg>`;
}

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
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

function activityKindLabel(kind, tool) {
  const k = (kind || '').toLowerCase();
  const t = String(tool || '').toLowerCase();
  if (k === 'message') return 'msg';
  if (k === 'terminal' || t.includes('terminal') || t.includes('bash')) return 'term';
  if (k === 'file') {
    if (t.includes('write') || t.includes('create')) return 'write';
    if (t.includes('read')) return 'read';
    if (t.includes('edit') || t.includes('replace') || t.includes('patch')) return 'edit';
    return 'file';
  }
  if (k === 'search' || t.includes('grep') || t.includes('search')) return 'find';
  if (k === 'phase') return '…';
  return 'tool';
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

  // Cap very long rows; messages get more room than tool lines
  const max = kind === 'message' ? 900 : kind === 'terminal' ? 500 : 220;
  if (text.length > max) {
    text = `${text.slice(0, max - 1)}…`;
  }
  return text;
}

function renderActivity(session) {
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

  const stream = (updates.length ? updates : fallback).slice(-48);
  if (!stream.length) return '';

  // Chronological (oldest → newest) so it feels like a live terminal log
  const sorted = [...stream].sort((a, b) => {
    const ta = (typeof a === 'object' && a.at) || 0;
    const tb = (typeof b === 'object' && b.at) || 0;
    return ta - tb;
  });

  const rows = sorted.map((update, i) => {
    const isLast = i === sorted.length - 1;
    const kind = typeof update === 'object' && update.kind ? update.kind : 'tool';
    const tool = typeof update === 'object' ? (update.tool || '') : '';
    const text = formatActivityText(update);
    const at = typeof update === 'string' ? session.lastActivityAt : update.at;
    const kindClass = kind ? ` activity-${kind}` : '';
    const liveClass = isLast && session.status === 'working' ? ' activity-live' : '';
    const badge = activityKindLabel(kind, tool);
    const title = typeof update === 'object' && update.filePath
      ? escapeHtml(update.filePath)
      : escapeHtml(String(typeof update === 'object' ? (update.tool || text) : text).slice(0, 200));

    // Preserve newlines for multi-line terminal / message blocks
    const htmlText = escapeHtml(text).replace(/\n/g, '<br>');

    return `<div class="activity-row${kindClass}${liveClass}" title="${title}">
      <span class="activity-badge" aria-hidden="true">${escapeHtml(badge)}</span>
      <span class="activity-text">${htmlText}</span>
      <time class="activity-time" title="${escapeHtml(formatClock(at))}">${escapeHtml(formatRelativeTime(at))}</time>
    </div>`;
  }).join('');

  const count = stream.length;
  const countLabel = count === 1 ? '1 event' : `${count} events`;

  return `<section class="session-activity-block">
    <div class="session-activity-header">
      <div class="session-prompt-label">Live activity</div>
      <span class="session-activity-count">${escapeHtml(countLabel)}</span>
    </div>
    <div class="activity-list activity-live-feed" data-activity-feed="1">${rows}</div>
  </section>`;
}

/**
 * Compact agent icon for the collapsed bar, with a status animation
 * beside the pet when the session is still running.
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
      : '';

  // Spinner sits beside the icon so "still running" is obvious at a glance
  const runIndicator = isWorking
    ? `<span class="agent-run-indicator" aria-hidden="true" title="Running">
         <span class="agent-run-spinner"></span>
       </span>`
    : isAttention
      ? `<span class="agent-run-indicator attention" aria-hidden="true" title="Needs attention">
           <span class="agent-run-pulse"></span>
         </span>`
      : '';

  return `<div class="agent-icon-wrap ${statusClass}" style="color: ${colors.main}" title="${escapeHtml(session.agent)}: ${escapeHtml(session.taskName)}${escapeHtml(toolHint)}">
    <div class="agent-icon ${statusClass}">
      ${getPixelPet(session.status, session.agent)}
    </div>
    ${runIndicator}
  </div>`;
}

export function renderSessionCard(session, index = 0) {
  const agent = AGENT_COLORS[session.agent] || { main: '#60A5FA', class: 'agent-claude' };
  const statusInfo = getStatusInfo(session);
  const needsAttention = ['permission-request', 'question', 'needs-attention'].includes(session.status);
  const delay = index * 50;

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

  detailContent += renderActivity(session);
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
      <button class="btn-jump" data-session-id="${session.id}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        Jump to ${escapeHtml(session.terminal || 'Terminal')}
      </button>
    </div>`;

  const isWorking = session.status === 'working';
  const petIndicator = isWorking
    ? `<span class="session-run-indicator" aria-label="Running" title="Still running">
         <span class="session-run-spinner"></span>
       </span>`
    : needsAttention
      ? `<span class="session-run-indicator attention" aria-label="Needs attention" title="Needs attention">
           <span class="session-run-pulse"></span>
         </span>`
      : session.status === 'idle'
        ? `<span class="session-run-indicator idle" aria-label="Finished" title="Finished">
             <span class="session-run-check"></span>
           </span>`
        : '';

  return `
    <div class="session-card ${needsAttention ? 'attention' : ''}"
         data-session-id="${session.id}"
         data-status="${session.status}"
         role="button"
         tabindex="0"
         aria-expanded="false"
         aria-label="${escapeHtml(session.agent)}: ${escapeHtml(session.taskName)}"
         style="animation-delay: ${delay}ms">
      <div class="session-header">
        <div class="session-pet-wrap ${isWorking ? 'working' : needsAttention ? 'attention' : session.status === 'idle' ? 'idle' : ''}">
          <div class="session-pet">
            ${getPixelPet(session.status, session.agent)}
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
        <button class="btn-deny" data-session-id="${session.id}" title="${denyTitle}">Deny <kbd>Ctrl+N</kbd></button>
        <button class="btn-allow" data-session-id="${session.id}" title="${allowTitle}">Allow <kbd>Ctrl+Y</kbd></button>
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
              data-session-id="${session.id}"
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
