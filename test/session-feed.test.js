const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  projectBase,
  buildSessionDisambiguation,
  filterSessions,
  groupSessions,
  collectFilterOptions
} = require('../src/main/session-feed-utils');

describe('projectBase', () => {
  it('returns the last path segment', () => {
    assert.equal(projectBase('C:\\Users\\dev\\agent-notch'), 'agent-notch');
    assert.equal(projectBase('/home/u/proj/foo'), 'foo');
    assert.equal(projectBase(''), '');
    assert.equal(projectBase(null), '');
  });
});

describe('buildSessionDisambiguation', () => {
  it('keeps short agent label for a single session', () => {
    const map = buildSessionDisambiguation([
      { id: 'c1', agent: 'Claude Code', taskName: 'fix', cwd: '/a/agent-notch' }
    ]);
    assert.equal(map.get('c1').agentLabel, 'Claude');
    assert.equal(map.get('c1').instanceTotal, 1);
  });

  it('disambiguates by project when folders differ', () => {
    const map = buildSessionDisambiguation([
      { id: 'c1', agent: 'Claude Code', cwd: '/a/agent-notch' },
      { id: 'c2', agent: 'Claude Code', cwd: '/b/other-app' }
    ]);
    assert.equal(map.get('c1').agentLabel, 'Claude · agent-notch');
    assert.equal(map.get('c2').agentLabel, 'Claude · other-app');
    assert.equal(map.get('c1').instanceTotal, 2);
  });

  it('falls back to #N when projects do not disambiguate', () => {
    const map = buildSessionDisambiguation([
      { id: 'g1', agent: 'Grok', cwd: '' },
      { id: 'g2', agent: 'Grok', cwd: null }
    ]);
    assert.equal(map.get('g1').agentLabel, 'Grok #1');
    assert.equal(map.get('g2').agentLabel, 'Grok #2');
  });
});

describe('filterSessions', () => {
  const list = [
    { id: '1', agent: 'Codex', cwd: '/p/alpha' },
    { id: '2', agent: 'Grok', cwd: '/p/beta' },
    { id: '3', agent: 'Codex', cwd: '/p/beta' }
  ];

  it('filters by agent', () => {
    assert.equal(filterSessions(list, { agent: 'Codex' }).length, 2);
  });

  it('filters by project basename', () => {
    assert.equal(filterSessions(list, { project: 'beta' }).length, 2);
  });

  it('combines filters', () => {
    const hit = filterSessions(list, { agent: 'Codex', project: 'beta' });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, '3');
  });
});

describe('groupSessions', () => {
  const list = [
    { id: '1', agent: 'Claude Code', status: 'working', cwd: '/a/foo' },
    { id: '2', agent: 'Grok', status: 'idle', cwd: '/a/foo' },
    { id: '3', agent: 'Grok', status: 'permission-request', attentionAcknowledged: false, cwd: '/b/bar' }
  ];

  it('groups by status with Needs you first', () => {
    const groups = groupSessions(list, 'status');
    assert.equal(groups[0].label, 'Needs you');
    assert.equal(groups[0].sessions[0].id, '3');
    assert.ok(groups.some((g) => g.label === 'Running'));
    assert.ok(groups.some((g) => g.label === 'Finished'));
  });

  it('groups by agent', () => {
    const groups = groupSessions(list, 'agent');
    assert.equal(groups.length, 2);
    assert.ok(groups.some((g) => g.label === 'Claude' || g.label === 'Claude Code'));
  });

  it('groups by project', () => {
    const groups = groupSessions(list, 'project');
    assert.equal(groups.length, 2);
    assert.ok(groups.some((g) => g.label === 'foo'));
    assert.ok(groups.some((g) => g.label === 'bar'));
  });
});

describe('collectFilterOptions', () => {
  it('returns unique agents and projects', () => {
    const { agents, projects } = collectFilterOptions([
      { agent: 'Grok', cwd: '/x/a' },
      { agent: 'Claude Code', cwd: '/x/b' },
      { agent: 'Grok', cwd: '/x/a' }
    ]);
    assert.deepEqual(agents, ['Claude Code', 'Grok']);
    assert.deepEqual(projects, ['a', 'b']);
  });
});
