/**
 * Always-allow memory — local JSON, keyed by agent + tool + project.
 * Does not store command args (too brittle, easy to over-allow).
 *
 * File: ~/.agent-notch/permission-memory.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const AGENT_IDS = new Set(['claude', 'codex', 'cursor', 'antigravity', 'grok', 'opencode']);

const AGENT_NAME_TO_ID = Object.freeze({
  'Claude Code': 'claude',
  Claude: 'claude',
  Codex: 'codex',
  Cursor: 'cursor',
  Antigravity: 'antigravity',
  Grok: 'grok',
  OpenCode: 'opencode'
});

function defaultMemoryPath() {
  return path.join(os.homedir(), '.agent-notch', 'permission-memory.json');
}

function agentIdFromName(nameOrId) {
  if (typeof nameOrId !== 'string' || !nameOrId) return '';
  const raw = nameOrId.trim();
  if (AGENT_IDS.has(raw)) return raw;
  return AGENT_NAME_TO_ID[raw] || raw.toLowerCase();
}

function toolKey(tool) {
  return String(tool || '').trim().toLowerCase();
}

function projectKey(cwdOrName) {
  const raw = String(cwdOrName || '').trim();
  if (!raw) return '';
  const parts = raw.split(/[/\\]/).filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : raw;
  return base.toLowerCase();
}

/**
 * @param {{ agent?: string, tool?: string, project?: string, cwd?: string }} input
 * @returns {{ agent: string, tool: string, project: string }|null}
 */
function normalizeEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const agent = agentIdFromName(input.agent);
  const tool = toolKey(input.tool);
  const project = projectKey(input.project || input.cwd);
  if (!agent || !tool || !project) return null;
  return { agent, tool, project };
}

function entryKey(entry) {
  return `${entry.agent}|${entry.tool}|${entry.project}`;
}

function emptyStore() {
  return { version: 1, entries: [] };
}

/**
 * @param {string} [filePath]
 * @returns {{ version: number, entries: Array<{ agent: string, tool: string, project: string, at?: number }> }}
 */
function load(filePath = defaultMemoryPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyStore();
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    const seen = new Set();
    const out = [];
    for (const item of entries) {
      const n = normalizeEntry(item);
      if (!n) continue;
      const k = entryKey(n);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...n, at: Number(item.at) || 0 });
    }
    return { version: 1, entries: out };
  } catch {
    return emptyStore();
  }
}

/**
 * @param {{ version?: number, entries?: Array<object> }} store
 * @param {string} [filePath]
 */
function save(store, filePath = defaultMemoryPath()) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    entries: Array.isArray(store && store.entries) ? store.entries : []
  };
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return payload;
}

/**
 * @param {{ entries?: Array<object> }} store
 * @param {{ agent?: string, tool?: string, project?: string, cwd?: string }} candidate
 * @returns {boolean}
 */
function matches(store, candidate) {
  const n = normalizeEntry(candidate);
  if (!n) return false;
  const k = entryKey(n);
  const list = store && Array.isArray(store.entries) ? store.entries : [];
  return list.some((e) => entryKey(e) === k);
}

/**
 * @param {{ entries?: Array<object> }} store
 * @param {{ agent?: string, tool?: string, project?: string, cwd?: string }} candidate
 * @param {number} [now]
 */
function remember(store, candidate, now = Date.now()) {
  const n = normalizeEntry(candidate);
  if (!n) return store || emptyStore();
  const next = {
    version: 1,
    entries: Array.isArray(store && store.entries) ? [...store.entries] : []
  };
  const k = entryKey(n);
  const idx = next.entries.findIndex((e) => entryKey(e) === k);
  const row = { ...n, at: now };
  if (idx >= 0) next.entries[idx] = row;
  else next.entries.push(row);
  return next;
}

/**
 * @param {{ entries?: Array<object> }} store
 * @param {{ agent?: string, tool?: string, project?: string, cwd?: string }} candidate
 */
function forget(store, candidate) {
  const n = normalizeEntry(candidate);
  const next = {
    version: 1,
    entries: Array.isArray(store && store.entries) ? [...store.entries] : []
  };
  if (!n) return next;
  const k = entryKey(n);
  next.entries = next.entries.filter((e) => entryKey(e) !== k);
  return next;
}

function clearAll() {
  return emptyStore();
}

module.exports = {
  defaultMemoryPath,
  agentIdFromName,
  toolKey,
  projectKey,
  normalizeEntry,
  entryKey,
  load,
  save,
  matches,
  remember,
  forget,
  clearAll
};
