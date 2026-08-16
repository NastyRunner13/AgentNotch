/**
 * Pure helpers for session feed density, grouping, filtering, and labels.
 * Used by tests and mirrored in the renderer (no bundler shared import).
 */

/** @param {string|null|undefined} cwd */
function projectBase(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * When multiple live sessions share an agent, build clearer labels.
 * @param {Array<{id:string, agent:string, taskName?:string, cwd?:string}>} sessions
 * @returns {Map<string, { agentLabel: string, instanceIndex: number, instanceTotal: number, project: string }>}
 */
function buildSessionDisambiguation(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  /** @type {Map<string, typeof list>} */
  const byAgent = new Map();
  for (const s of list) {
    if (!s || !s.id) continue;
    const agent = s.agent || 'Agent';
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(s);
  }

  /** @type {Map<string, { agentLabel: string, instanceIndex: number, instanceTotal: number, project: string }>} */
  const out = new Map();
  for (const [agent, group] of byAgent) {
    const short = agent === 'Claude Code' ? 'Claude' : agent;
    const total = group.length;
    // Stable order within agent: original list order
    group.forEach((s, i) => {
      const project = projectBase(s.cwd);
      const idx = i + 1;
      let agentLabel = short;
      if (total > 1) {
        // Prefer project folder when it disambiguates; else #N
        const projects = group.map((g) => projectBase(g.cwd)).filter(Boolean);
        const uniqueProjects = new Set(projects);
        if (project && uniqueProjects.size === total) {
          agentLabel = `${short} · ${project}`;
        } else if (project && uniqueProjects.size > 1) {
          agentLabel = `${short} · ${project}`;
        } else {
          agentLabel = `${short} #${idx}`;
        }
      }
      out.set(s.id, {
        agentLabel,
        instanceIndex: idx,
        instanceTotal: total,
        project
      });
    });
  }
  return out;
}

/**
 * @param {Array<object>} sessions
 * @param {{ agent?: string, project?: string }} filter
 */
function filterSessions(sessions, filter = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const agent = filter.agent && filter.agent !== 'all' ? filter.agent : '';
  const project = filter.project && filter.project !== 'all' ? filter.project : '';
  return list.filter((s) => {
    if (agent && s.agent !== agent) return false;
    if (project) {
      const base = projectBase(s.cwd);
      if (base !== project && s.cwd !== project) return false;
    }
    return true;
  });
}

/**
 * Group sessions for section headers.
 * @param {Array<object>} sessions
 * @param {'status'|'agent'|'project'|'none'} groupBy
 * @returns {Array<{ key: string, label: string, variant: string, sessions: object[] }>}
 */
function groupSessions(sessions, groupBy = 'status') {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) return [];

  if (groupBy === 'none') {
    return [{ key: 'all', label: '', variant: 'idle', sessions: list }];
  }

  if (groupBy === 'agent') {
    /** @type {Map<string, object[]>} */
    const map = new Map();
    for (const s of list) {
      const key = s.agent || 'Agent';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    }
    return [...map.entries()].map(([key, sess]) => ({
      key: `agent:${key}`,
      label: key === 'Claude Code' ? 'Claude' : key,
      variant: 'idle',
      sessions: sess
    }));
  }

  if (groupBy === 'project') {
    /** @type {Map<string, object[]>} */
    const map = new Map();
    for (const s of list) {
      const base = projectBase(s.cwd) || 'Unknown project';
      if (!map.has(base)) map.set(base, []);
      map.get(base).push(s);
    }
    // Unknown last
    return [...map.entries()]
      .sort((a, b) => {
        if (a[0] === 'Unknown project') return 1;
        if (b[0] === 'Unknown project') return -1;
        return a[0].localeCompare(b[0]);
      })
      .map(([key, sess]) => ({
        key: `project:${key}`,
        label: key,
        variant: 'idle',
        sessions: sess
      }));
  }

  // status (default): Needs you → Cleared → Running → Finished
  const ATTENTION = new Set(['permission-request', 'question', 'needs-attention']);
  const needsYou = list.filter((s) => ATTENTION.has(s.status) && !s.attentionAcknowledged);
  const acked = list.filter((s) => ATTENTION.has(s.status) && s.attentionAcknowledged);
  const running = list.filter((s) => s.status === 'working');
  const finished = list.filter((s) => !ATTENTION.has(s.status) && s.status !== 'working');

  /** @type {Array<{ key: string, label: string, variant: string, sessions: object[], hint?: string }>} */
  const groups = [];
  if (needsYou.length) {
    groups.push({
      key: 'needs',
      label: 'Needs you',
      variant: 'attention',
      sessions: needsYou,
      hint: needsYou.length > 1 ? 'Ctrl+] next · Ctrl+Shift+D clear' : ''
    });
  }
  if (acked.length) {
    groups.push({ key: 'acked', label: 'Cleared', variant: 'acked', sessions: acked });
  }
  if (running.length) {
    groups.push({ key: 'running', label: 'Running', variant: 'working', sessions: running });
  }
  if (finished.length) {
    groups.push({ key: 'finished', label: 'Finished', variant: 'idle', sessions: finished });
  }
  return groups;
}

/**
 * Unique agent names and project folders present in the live list (for filter UI).
 * @param {Array<object>} sessions
 */
function collectFilterOptions(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const agents = [];
  const agentSeen = new Set();
  const projects = [];
  const projectSeen = new Set();
  for (const s of list) {
    if (s.agent && !agentSeen.has(s.agent)) {
      agentSeen.add(s.agent);
      agents.push(s.agent);
    }
    const base = projectBase(s.cwd);
    if (base && !projectSeen.has(base)) {
      projectSeen.add(base);
      projects.push(base);
    }
  }
  agents.sort((a, b) => a.localeCompare(b));
  projects.sort((a, b) => a.localeCompare(b));
  return { agents, projects };
}

module.exports = {
  projectBase,
  buildSessionDisambiguation,
  filterSessions,
  groupSessions,
  collectFilterOptions
};
