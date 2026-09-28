const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const duration = ms => ms < 60000 ? (ms > 0 ? '<1m' : '0m')
  : ms < 3600000 ? `${Math.floor(ms / 60000)}m` : `${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m`;

export function buildPerformanceModel(stats, rangeDays, agent = 'all', now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (rangeDays - 1));
  const firstDay = dayKey(start);
  const lastDay = dayKey(new Date(now));
  const rows = (stats?.days || []).filter(d => d.day >= firstDay && d.day <= lastDay && (agent === 'all' || d.agent === agent));
  const totals = { workMs: 0, waitMs: 0, attentionEpisodes: 0, completedEpisodes: 0 };
  const agents = new Map();
  const days = new Map();
  for (const row of rows) {
    if (!agents.has(row.agent)) agents.set(row.agent, { agent: row.agent, ...totals, workMs: 0, waitMs: 0, attentionEpisodes: 0, completedEpisodes: 0 });
    if (!days.has(row.day)) days.set(row.day, { day: row.day, workMs: 0, waitMs: 0 });
    for (const field of Object.keys(totals)) {
      const value = Math.max(0, Number(row[field]) || 0);
      totals[field] += value;
      agents.get(row.agent)[field] += value;
      if (field === 'workMs' || field === 'waitMs') days.get(row.day)[field] += value;
    }
  }
  const episodes = (stats?.episodes || []).filter(e => e.complete && e.day >= firstDay && e.day <= lastDay && (agent === 'all' || e.agent === agent));
  const median = values => {
    values.sort((a, b) => a - b);
    if (!values.length) return null;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  };
  return {
    totals, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    agents: [...agents.values()].sort((a, b) => b.workMs - a.workMs),
    medianWorkMs: median(episodes.map(e => e.workMs)), sampleSize: episodes.length,
    coverageStart: stats?.coverageStart || null, incompleteObservations: stats?.incompleteObservations || 0,
    enabled: stats?.enabled !== false, empty: rows.length === 0
  };
}

export function renderPerformanceView(stats, rangeDays, agent = 'all') {
  const model = buildPerformanceModel(stats, rangeDays, agent);
  const coverage = model.coverageStart ? new Date(model.coverageStart).toLocaleDateString() : 'collection starts';
  const note = `<p class="analytics-note">${model.enabled ? 'Observed locally' : 'Collection paused'} · Since ${escapeHtml(coverage)}. ${model.incompleteObservations ? `${model.incompleteObservations} incomplete observations; gaps excluded.` : 'Gaps are excluded.'}</p>`;
  if (model.empty) return `${note}<div class="empty-state usage-empty"><p class="empty-title">No performance observations yet</p><p class="empty-desc">${model.enabled ? 'Run an agent to start measuring work and waiting time. Older sessions are not reconstructed.' : 'Enable collection in Settings to measure future activity.'}</p></div>`;
  const values = [
    ['Working', duration(model.totals.workMs)], ['Waiting for you', duration(model.totals.waitMs)],
    ['Attention episodes', String(model.totals.attentionEpisodes)], ['Observed completions', String(model.totals.completedEpisodes)],
    ['Median work / episode', model.medianWorkMs == null ? '—' : duration(model.medianWorkMs)]
  ];
  const summary = `<div class="performance-summary">${values.map(([label, value]) => `<div class="usage-stat"><span class="usage-stat-value">${value}</span><span class="usage-stat-label">${label}</span></div>`).join('')}</div>`;
  // Keep a compact chart at 90 days; the table below retains daily values.
  const plotted = [];
  const step = rangeDays > 30 ? 7 : 1;
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - rangeDays + 1);
  for (let offset = 0; offset < rangeDays; offset += step) {
    const date = new Date(start); date.setDate(date.getDate() + offset);
    const end = new Date(date); end.setDate(end.getDate() + step);
    const rows = model.days.filter(d => d.day >= dayKey(date) && d.day < dayKey(end));
    plotted.push({ day: dayKey(date), workMs: rows.reduce((n, d) => n + d.workMs, 0), waitMs: rows.reduce((n, d) => n + d.waitMs, 0), observed: model.coverageStart && end.getTime() > model.coverageStart });
  }
  const max = Math.max(1, ...plotted.map(d => d.workMs + d.waitMs));
  const chart = `<div class="usage-section"><h3 class="analytics-heading">${step === 7 ? 'Weekly' : 'Daily'} work and waiting</h3><p class="analytics-note"><span class="performance-key work"></span>Working <span class="performance-key wait"></span>Waiting for you</p><div class="performance-chart" aria-label="Work and waiting timeline">${plotted.map(d => `<div class="performance-column" tabindex="0" aria-label="${d.day}: ${d.observed ? `${duration(d.workMs)} working, ${duration(d.waitMs)} waiting` : 'before collection'}" title="${d.day}: ${d.observed ? `${duration(d.workMs)} working, ${duration(d.waitMs)} waiting` : 'before collection'}"><div class="performance-bar${d.observed ? '' : ' unavailable'}"><span class="work" style="height:${d.workMs / max * 100}%"></span><span class="wait" style="height:${d.waitMs / max * 100}%"></span></div><span>${d.day.slice(8)}</span></div>`).join('')}</div><p class="analytics-note">${plotted[0].day} to ${dayKey(new Date())}. Dates before collection are unavailable.</p></div>`;
  const table = (rows, daily) => `<table class="analytics-table"><thead><tr><th>${daily ? 'Date' : 'Agent'}</th><th>Work</th><th>Wait</th>${daily ? '' : '<th>Completions</th>'}</tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${escapeHtml(daily ? row.day : row.agent)}</th><td>${duration(row.workMs)}</td><td>${duration(row.waitMs)}</td>${daily ? '' : `<td>${row.completedEpisodes}</td>`}</tr>`).join('')}</tbody></table>`;
  return `${note}${summary}${chart}<p class="analytics-note">Median uses ${model.sampleSize} fully observed completed episodes. Completion means a return to idle, not a verified successful task. Concurrent agents contribute separate time.</p><div class="usage-section"><h3 class="analytics-heading">By agent</h3>${table(model.agents, false)}</div><details class="analytics-details"><summary>Daily observations</summary>${table(model.days, true)}</details>`;
}
