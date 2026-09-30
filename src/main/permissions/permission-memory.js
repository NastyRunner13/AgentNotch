/**
 * Always-allow memory, keyed by agent + tool + full project path + source home.
 * A rule covers every invocation of that tool within its scope.
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
  const raw = typeof cwdOrName === 'string' ? cwdOrName : '';
  if (!raw || raw.includes('\0')) return '';
  const windows = /^[a-z]:[/\\]/i.test(raw) || /^(\\\\|\/\/)[^/\\]/.test(raw);
  // Do not resolve '..' lexically across a possible symlink, or guess a cwd
  // for legacy basename-only rules. Preserve case for case-sensitive folders.
  if (raw.split(windows ? /[/\\]/ : /\//).includes('..')) return '';
  if (!windows && !path.posix.isAbsolute(raw)) return '';
  let normalized = windows
    ? path.win32.normalize(raw).replace(/\\/g, '/').replace(/^[a-z]:/i, drive => drive.toUpperCase())
    : path.posix.normalize(raw);
  normalized = normalized.replace(/\/+$/, '') || '/';
  return /^[A-Z]:$/.test(normalized) ? `${normalized}/` : normalized;
}

/**
 * @param {{ agent?: string, tool?: string, project?: string, cwd?: string, source?: string }} input
 * @returns {{ agent: string, tool: string, project: string, source: string }|null}
 */
function normalizeEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const agent = agentIdFromName(input.agent);
  const tool = toolKey(input.tool);
  const project = projectKey(input.project || input.cwd);
  const source = input.source == null || input.source === 'local' ? 'local' : projectKey(input.source);
  if (!AGENT_IDS.has(agent) || !tool || !project || !source) return null;
  return { agent, tool, project, source };
}

function entryKey(entry) {
  return JSON.stringify([entry.agent, entry.tool, entry.project, entry.source]);
}

function emptyStore() {
  return { version: 2, entries: [] };
}

/**
 * @param {string} [filePath]
 * @returns {{ version: number, entries: Array<{ agent: string, tool: string, project: string, source: string, at?: number }> }}
 */
function load(filePath = defaultMemoryPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Version 1 stored only folder names. There is no safe path migration.
    if (!raw || raw.version !== 2) return emptyStore();
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
    return { version: 2, entries: out };
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
    version: 2,
    entries: store?.version === 2 && Array.isArray(store.entries) ? store.entries : []
  };
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return payload;
}

/**
 * @param {{ version?: number, entries?: Array<object> }} store
 * @param {{ agent?: string, tool?: string, project?: string, cwd?: string, source?: string }} candidate
 * @returns {boolean}
 */
function matches(store, candidate) {
  if (store?.version !== 2) return false;
  const n = normalizeEntry(candidate);
  if (!n) return false;
  const k = entryKey(n);
  const list = store && Array.isArray(store.entries) ? store.entries : [];
  return list.some((e) => entryKey(e) === k);
}

/**
 * @param {{ version?: number, entries?: Array<object> }} store
 * @param {{ agent?: string, tool?: string, project?: string, cwd?: string, source?: string }} candidate
 * @param {number} [now]
 */
function remember(store, candidate, now = Date.now()) {
  const n = normalizeEntry(candidate);
  if (!n) return store?.version === 2 ? store : emptyStore();
  const next = {
    version: 2,
    entries: store?.version === 2 && Array.isArray(store.entries) ? [...store.entries] : []
  };
  const k = entryKey(n);
  const idx = next.entries.findIndex((e) => entryKey(e) === k);
  const row = { ...n, at: now };
  if (idx >= 0) next.entries[idx] = row;
  else next.entries.push(row);
  return next;
}

/**
 * @param {{ version?: number, entries?: Array<object> }} store
 * @param {{ agent?: string, tool?: string, project?: string, cwd?: string, source?: string }} candidate
 */
function forget(store, candidate) {
  const n = normalizeEntry(candidate);
  const next = {
    version: 2,
    entries: store?.version === 2 && Array.isArray(store.entries) ? [...store.entries] : []
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
