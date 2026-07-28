/**
 * Conversation Insights — intent, work type, task complexity, and prompt
 * specificity from locally classified session records (main/insights.js).
 * Follows the usage dashboard's visual language: dense hairline rows, one
 * stacked composition bar, categorical dots, mono numbers, quiet footnote.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const INSIGHT_RANGES = [
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
  { days: 0, label: 'All' }
];

/** Category identity — display order doubles as the tie-break priority. */
const CATEGORY_META = {
  feature:      { label: 'Features',     color: '#60A5FA' },
  bugfix:       { label: 'Bug fixes',    color: '#EF4444' },
  testing:      { label: 'Testing',      color: '#4ADE80' },
  refactor:     { label: 'Refactors',    color: '#A78BFA' },
  architecture: { label: 'Architecture', color: '#22D3EE' },
  styling:      { label: 'UI & Styling', color: '#F472B6' },
  data:         { label: 'Data & DB',    color: '#34D399' },
  devops:       { label: 'DevOps',       color: '#F59E0B' },
  performance:  { label: 'Performance',  color: '#FBBF24' },
  security:     { label: 'Security',     color: '#F87171' },
  docs:         { label: 'Docs',         color: '#9CA3AF' },
  review:       { label: 'Review',       color: '#93C5FD' },
  exploration:  { label: 'Exploration',  color: '#6B7280' },
  general:      { label: 'General',      color: '#555555' }
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);
/** Rows beyond this fold into "Other" so the list stays scannable. */
const MAX_CATEGORY_ROWS = 8;

const AREA_META = {
  frontend:  { label: 'Frontend',   color: '#60A5FA' },
  backend:   { label: 'Backend',    color: '#34D399' },
  fullstack: { label: 'Full-stack', color: '#A78BFA' },
  data:      { label: 'Data',       color: '#22D3EE' },
  devops:    { label: 'DevOps',     color: '#F59E0B' },
  mobile:    { label: 'Mobile',     color: '#F472B6' },
  docs:      { label: 'Docs',       color: '#9CA3AF' },
  general:   { label: 'General',    color: '#6B7280' }
};

/** Band thresholds mirror main/insights.js (COMPLEXITY_BANDS / SPECIFICITY_BANDS). */
const COMPLEXITY_META = [
  { id: 'simple',   label: 'Simple',   max: 24,  color: '#4ADE80' },
  { id: 'moderate', label: 'Moderate', max: 49,  color: '#60A5FA' },
  { id: 'complex',  label: 'Complex',  max: 74,  color: '#F59E0B' },
  { id: 'deep',     label: 'Deep',     max: 100, color: '#EF4444' }
];
const SPECIFICITY_META = [
  { id: 'vague',   label: 'Vague',   max: 34,  color: '#F59E0B' },
  { id: 'clear',   label: 'Clear',   max: 64,  color: '#60A5FA' },
  { id: 'precise', label: 'Precise', max: 100, color: '#4ADE80' }
];

function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtPct(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${Math.round(ratio * 100)}%`;
}

function bandFor(score, meta) {
  for (const b of meta) {
    if (score <= b.max) return b.id;
  }
  return meta[meta.length - 1].id;
}

function bandLabel(score, meta) {
  const id = bandFor(score, meta);
  return meta.find(b => b.id === id).label;
}

/**
 * Aggregate per-session records into the view model for a range.
 * rangeDays 0 = all records.
 */
export function buildInsightsModel(data, rangeDays) {
  const records = Array.isArray(data?.records) ? data.records : [];
  const cutoff = rangeDays > 0 ? Date.now() - rangeDays * DAY_MS : 0;
  const ranged = records.filter(r => r && Number.isFinite(r.ts) && r.ts >= cutoff);

  const catCount = new Map();
  const areaCount = new Map();
  const langCount = new Map();
  const complexity = { simple: 0, moderate: 0, complex: 0, deep: 0 };
  const specificity = { vague: 0, clear: 0, precise: 0 };
  const agents = new Set();
  let complexitySum = 0;
  let specificitySum = 0;
  let wordsSum = 0;

  for (const r of ranged) {
    const cat = CATEGORY_META[r.category] ? r.category : 'general';
    catCount.set(cat, (catCount.get(cat) || 0) + 1);
    const area = AREA_META[r.area] ? r.area : 'general';
    areaCount.set(area, (areaCount.get(area) || 0) + 1);
    for (const lang of Array.isArray(r.langs) ? r.langs : []) {
      langCount.set(lang, (langCount.get(lang) || 0) + 1);
    }
    complexity[bandFor(Number(r.complexity) || 0, COMPLEXITY_META)]++;
    specificity[bandFor(Number(r.specificity) || 0, SPECIFICITY_META)]++;
    complexitySum += Number(r.complexity) || 0;
    specificitySum += Number(r.specificity) || 0;
    wordsSum += Number(r.words) || 0;
    if (r.agent) agents.add(r.agent);
  }

  const total = ranged.length;
  const sortedCats = [...catCount.entries()]
    .sort((a, b) => (b[1] - a[1]) || (CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0])));

  const categories = [];
  let folded = 0;
  for (const [id, count] of sortedCats) {
    if (categories.length < MAX_CATEGORY_ROWS) {
      categories.push({ id, count, share: total ? count / total : 0, ...CATEGORY_META[id] });
    } else {
      folded += count;
    }
  }
  if (folded > 0) {
    categories.push({
      id: 'other', label: 'Other', color: '#3a3a3a',
      count: folded, share: total ? folded / total : 0
    });
  }

  const areas = [...areaCount.entries()]
    .map(([id, count]) => ({ id, count, share: total ? count / total : 0, ...AREA_META[id] }))
    .sort((a, b) => b.count - a.count);

  const langs = [...langCount.entries()]
    .map(([lang, count]) => ({ lang, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const avgComplexity = total ? complexitySum / total : 0;
  const avgSpecificity = total ? specificitySum / total : 0;

  return {
    total,
    agents: agents.size,
    categories,
    areas,
    langs,
    complexity,
    specificity,
    avgComplexity,
    avgSpecificity,
    complexityLabel: bandLabel(avgComplexity, COMPLEXITY_META),
    specificityLabel: bandLabel(avgSpecificity, SPECIFICITY_META),
    avgWords: total ? wordsSum / total : 0,
    topCategory: categories[0] || null,
    topArea: areas[0] || null,
    vagueShare: total ? specificity.vague / total : 0,
    empty: total === 0
  };
}

/** Stable fingerprint — skips flicker-prone rebuilds on poll. */
export function insightsFingerprint(data, rangeDays) {
  return JSON.stringify(buildInsightsModel(data, rangeDays)) + `\x1d${rangeDays}`;
}

/* ── Sections ─────────────────────────────────────────── */

function renderSummary(model) {
  const items = [
    { value: String(model.total), label: `Session${model.total === 1 ? '' : 's'}` },
    { value: model.topCategory ? model.topCategory.label : '—', label: 'Top intent' },
    { value: model.topArea ? model.topArea.label : '—', label: 'Work type' },
    { value: String(Math.round(model.avgComplexity)), label: 'Avg complexity', title: `Average task complexity — ${model.complexityLabel}` },
    { value: String(Math.round(model.avgSpecificity)), label: 'Avg specificity', title: `Average prompt specificity — ${model.specificityLabel}` }
  ];
  return `<div class="usage-summary"><div class="usage-summary-row" role="list">
    ${items.map(i => `<div class="usage-stat" role="listitem"${i.title ? ` title="${escapeHtml(i.title)}"` : ''}>
      <span class="usage-stat-value">${escapeHtml(i.value)}</span>
      <span class="usage-stat-label">${escapeHtml(i.label)}</span>
    </div>`).join('')}
  </div></div>`;
}

function renderIntent(model) {
  if (!model.categories.length) return '';
  const bar = model.categories.map(c =>
    `<span class="usage-mix-seg" style="width:${(c.share * 100).toFixed(2)}%;background:${c.color}" title="${escapeHtml(c.label)} — ${c.count} (${fmtPct(c.share)})"></span>`
  ).join('');

  const rows = model.categories.map(c => `<div class="insight-row">
    <span class="insight-dot" style="background:${c.color}"></span>
    <span class="insight-label">${escapeHtml(c.label)}</span>
    <span class="insight-count">${c.count}</span>
    <span class="insight-pct">${fmtPct(c.share)}</span>
    <span class="insight-bar" aria-hidden="true"><span style="width:${(c.share * 100).toFixed(2)}%;background:${c.color}"></span></span>
  </div>`).join('');

  return `<div class="usage-section">
    <h4 class="usage-eyebrow">Intent distribution</h4>
    <div class="insight-mix">
      <div class="usage-mix-bar" role="img" aria-label="Intent distribution across ${model.total} sessions">${bar}</div>
      <div class="insight-rows">${rows}</div>
    </div>
  </div>`;
}

function renderWorkType(model) {
  if (!model.areas.length) return '';
  const rows = model.areas.map(a => `<div class="insight-row">
    <span class="insight-dot" style="background:${a.color}"></span>
    <span class="insight-label">${escapeHtml(a.label)}</span>
    <span class="insight-count">${a.count}</span>
    <span class="insight-pct">${fmtPct(a.share)}</span>
    <span class="insight-bar" aria-hidden="true"><span style="width:${(a.share * 100).toFixed(2)}%;background:${a.color}"></span></span>
  </div>`).join('');

  const langs = model.langs.length
    ? `<div class="insight-langs">${model.langs.map(l =>
        `<span class="insight-lang" title="${l.count} session${l.count === 1 ? '' : 's'}">${escapeHtml(l.lang)}</span>`).join('')}</div>`
    : '';

  return `<div class="usage-section">
    <h4 class="usage-eyebrow">Work type</h4>
    <div class="insight-rows">${rows}</div>
    ${langs}
  </div>`;
}

function renderBandSection(eyebrow, bands, meta, avg, avgLabel, extraNote = '') {
  const total = Object.values(bands).reduce((s, n) => s + n, 0);
  if (!total) return '';
  const rows = meta.map(b => {
    const count = bands[b.id] || 0;
    const share = count / total;
    return `<div class="insight-band">
      <span class="insight-band-label">${escapeHtml(b.label)}</span>
      <span class="insight-band-bar" aria-hidden="true"><span style="width:${(share * 100).toFixed(2)}%;background:${b.color}"></span></span>
      <span class="insight-band-val">${count} · ${fmtPct(share)}</span>
    </div>`;
  }).join('');

  return `<div class="usage-section">
    <h4 class="usage-eyebrow">${escapeHtml(eyebrow)}</h4>
    <div class="insight-bands">${rows}</div>
    <p class="insight-avg">avg <span class="insight-avg-num">${Math.round(avg)}</span> · ${escapeHtml(avgLabel)}${extraNote}</p>
  </div>`;
}

export function renderInsightsView(data, rangeDays) {
  const model = buildInsightsModel(data, rangeDays);

  const rangeToggle = `<div class="usage-range" role="tablist" aria-label="Insights range">
    ${INSIGHT_RANGES.map(r => `<button type="button" class="usage-range-btn${r.days === rangeDays ? ' active' : ''}"
      data-insight-range="${r.days}" role="tab" aria-selected="${r.days === rangeDays}">${r.label}</button>`).join('')}
  </div>`;

  if (model.empty) {
    return `${rangeToggle}
      <div class="empty-state usage-empty">
        <p class="empty-title">No conversations in this range</p>
        <p class="empty-desc">Insights build from sessions with prompts as agents work. Classification runs locally on this machine.</p>
      </div>`;
  }

  const specificityNote = model.vagueShare >= 0.4
    ? ` <span class="insight-tip">— name files, expected behavior, and constraints to raise it</span>`
    : '';

  const footnote = `<p class="usage-footnote">Classified on-device from prompts, tool calls, and session time — nothing leaves this machine. Sessions without prompts are excluded.</p>`;

  return `${rangeToggle}
    ${renderSummary(model)}
    ${renderIntent(model)}
    ${renderWorkType(model)}
    ${renderBandSection('Task complexity', model.complexity, COMPLEXITY_META, model.avgComplexity, model.complexityLabel)}
    ${renderBandSection('Prompt specificity', model.specificity, SPECIFICITY_META, model.avgSpecificity, model.specificityLabel, specificityNote)}
    ${footnote}`;
}
