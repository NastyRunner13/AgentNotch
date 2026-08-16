/**
 * Local git identity for a session cwd: branch, worktree name, optional PR #.
 * File reads only — no `git status`, no GitHub API.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** @type {Map<string, { mtime: number, value: object|null }>} */
const cache = new Map();

function projectBaseName(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * @param {string} headText
 * @returns {{ branch: string, detached: boolean }|null}
 */
function parseHead(headText) {
  const t = String(headText || '').replace(/^\uFEFF/, '').trim();
  if (!t) return null;
  const ref = t.match(/^ref:\s+refs\/heads\/(.+)$/i);
  if (ref) {
    const branch = ref[1].trim();
    return branch ? { branch, detached: false } : null;
  }
  if (/^[0-9a-f]{7,40}$/i.test(t)) {
    return { branch: t.slice(0, 7), detached: true };
  }
  return null;
}

/**
 * @param {string} text  contents of a `.git` *file* (worktree / submodule)
 * @returns {string|null} gitdir path
 */
function parseGitDirFile(text) {
  const m = String(text || '').match(/^gitdir:\s*(.+)\s*$/im);
  return m ? m[1].trim() : null;
}

/**
 * `.../.git/worktrees/oauth-wt` → `oauth-wt`
 * @param {string} gitdir
 */
function worktreeNameFromGitDir(gitdir) {
  const parts = String(gitdir || '').split(/[/\\]/).filter(Boolean);
  const i = parts.lastIndexOf('worktrees');
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  return '';
}

/**
 * Local-only PR number from `.git/config` (gh / merge-ref). No network.
 * @param {string} configText
 * @param {string} [branch]
 * @returns {number|null}
 */
function parseLocalPr(configText, branch) {
  const text = String(configText || '');
  if (!text) return null;

  if (!branch) return null;
  const escaped = String(branch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = text.match(new RegExp(
    `\\[branch\\s+"${escaped}"\\]([^\\[]*)`,
    'i'
  ));
  if (!section) return null;
  const pull = section[1].match(/refs\/pull\/(\d+)/i);
  return pull ? Number(pull[1]) : null;
}

function readFileSafe(p, io) {
  try {
    return io.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function statMtime(p, io) {
  try {
    return io.statSync(p).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function isDir(p, io) {
  try {
    return io.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p, io) {
  try {
    return io.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve `.git` (dir or worktree file) under cwd.
 * @returns {{ gitDir: string, worktree: string, headPath: string, configPath: string }|null}
 */
function resolveGitLayout(cwd, io) {
  const gitPath = io.join(cwd, '.git');
  if (isDir(gitPath, io)) {
    return {
      gitDir: gitPath,
      worktree: '',
      headPath: io.join(gitPath, 'HEAD'),
      configPath: io.join(gitPath, 'config')
    };
  }
  if (isFile(gitPath, io)) {
    const gitdir = parseGitDirFile(readFileSafe(gitPath, io));
    if (!gitdir) return null;
    const abs = io.isAbsolute(gitdir) ? gitdir : io.resolve(cwd, gitdir);
    const wt = worktreeNameFromGitDir(abs);
    // config lives in the common dir (parent of worktrees/<name>)
    const parts = abs.split(/[/\\]/).filter(Boolean);
    const wi = parts.lastIndexOf('worktrees');
    let common = abs;
    if (wi >= 0) {
      common = abs.slice(0, abs.toLowerCase().lastIndexOf(`${io.sep}worktrees${io.sep}`));
      if (!common) common = io.join(abs, '..', '..');
    }
    return {
      gitDir: abs,
      worktree: wt,
      headPath: io.join(abs, 'HEAD'),
      configPath: io.join(common, 'config')
    };
  }
  return null;
}

/**
 * @param {string} cwd
 * @param {{
 *   fs?: Pick<typeof fs, 'readFileSync'|'statSync'>,
 *   path?: Pick<typeof path, 'join'|'resolve'|'isAbsolute'|'sep'>,
 *   now?: number
 * }} [opts]
 * @returns {{ branch: string, worktree?: string, pr?: number }|null}
 */
function readGitContext(cwd, opts = {}) {
  const dir = typeof cwd === 'string' ? cwd.trim() : '';
  if (!dir) return null;

  const io = {
    readFileSync: (opts.fs || fs).readFileSync.bind(opts.fs || fs),
    statSync: (opts.fs || fs).statSync.bind(opts.fs || fs),
    join: (opts.path || path).join.bind(opts.path || path),
    resolve: (opts.path || path).resolve.bind(opts.path || path),
    isAbsolute: (opts.path || path).isAbsolute.bind(opts.path || path),
    sep: (opts.path || path).sep || path.sep
  };

  const layout = resolveGitLayout(dir, io);
  if (!layout) return null;

  const mtime = statMtime(layout.headPath, io);
  const cached = cache.get(dir);
  if (cached && cached.mtime === mtime) return cached.value;

  const head = parseHead(readFileSafe(layout.headPath, io));
  if (!head) {
    cache.set(dir, { mtime, value: null });
    return null;
  }

  const project = projectBaseName(dir);
  const worktree = layout.worktree && layout.worktree !== project ? layout.worktree : '';
  const pr = parseLocalPr(readFileSafe(layout.configPath, io), head.detached ? '' : head.branch);

  /** @type {{ branch: string, worktree?: string, pr?: number }} */
  const value = { branch: head.branch };
  if (worktree) value.worktree = worktree;
  if (pr) value.pr = pr;

  cache.set(dir, { mtime, value });
  return value;
}

function clearGitContextCache() {
  cache.clear();
}

module.exports = {
  parseHead,
  parseGitDirFile,
  worktreeNameFromGitDir,
  parseLocalPr,
  readGitContext,
  clearGitContextCache,
  projectBaseName
};
