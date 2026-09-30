const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function age(at, now) {
  if (!at) return 'not yet';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function renderTrackingHealth(rows, now = Date.now()) {
  if (!Array.isArray(rows) || !rows.length) return '<p class="settings-hint">Tracking information is unavailable.</p>';
  const labels = { disabled: 'Off', checking: 'Checking', missing: 'No session data', error: 'Read error', watching: 'Reading session files', polling: 'Polling session files' };
  return rows.map(row => {
    const state = Object.hasOwn(labels, row.state) ? row.state : 'checking';
    const detail = state === 'disabled' ? 'Enable this agent above to monitor it.'
      : row.error || (row.watchError ? 'File events are unavailable. Periodic reads keep tracking active.'
        : row.sessionCount ? `${row.sessionCount} observed session${row.sessionCount === 1 ? '' : 's'}. Status is inferred from local data.`
          : 'Source is readable. Start a session in this agent to verify incoming activity.');
    return `<div class="tracking-row" data-health-state="${state}">
      <div class="tracking-row-title"><span>${escape(row.agent)}${row.source !== 'Local' ? ` <span class="tracking-source">${escape(row.source)}</span>` : ''}</span><span class="tracking-state">${labels[state]}</span></div>
      <p class="tracking-detail">${escape(state === 'checking' ? 'Waiting for the first source check.' : detail)}</p>
      ${state !== 'disabled' ? `<p class="tracking-times">Checked ${age(row.checkedAt, now)} · Last activity ${age(row.lastEventAt, now)}</p>
      ${state === 'error' || state === 'missing' ? `<p class="tracking-times">Last successful read ${age(row.lastSuccessAt, now)}</p>` : ''}
      ${(row.paths || []).map(p => `<code class="tracking-path">${escape(p)}</code>`).join('')}` : ''}
    </div>`;
  }).join('');
}

export function updateTrackingHealth(rows) {
  const list = document.getElementById('tracking-health-list');
  if (list) list.innerHTML = renderTrackingHealth(rows);
  const warning = document.getElementById('tracking-warning');
  const failures = (rows || []).filter(r => r.state === 'error' || (r.state === 'missing' && r.lastSuccessAt));
  if (warning) {
    warning.hidden = failures.length === 0;
    warning.textContent = failures.length ? `Tracking issue with ${[...new Set(failures.map(r => r.agent))].join(', ')} · Check setup` : '';
  }
}

export async function refreshTrackingHealth() {
  if (!window.agentNotch?.getTrackingHealth) return;
  try { updateTrackingHealth(await window.agentNotch.getTrackingHealth()); }
  catch {
    const status = document.getElementById('tracking-check-status');
    if (status) status.textContent = 'Could not read tracking health. Try Check setup again.';
  }
}
