const path = require('path');
const os = require('os');

/** How long a finished composer stays visible after last update (ms). */
const RECENT_MS = 12 * 60 * 60 * 1000;
/** After Cursor exits, keep recent sessions briefly so "done" can fire (ms). */
const POST_EXIT_GRACE_MS = 3 * 60 * 1000;
/** Consider a composer "live" (working) if generating / recently written (ms). */
const LIVE_WRITE_MS = 90_000;

/**
 * node:sqlite is available in Node ≥22.5 (Electron 36). Degrade gracefully.
 * @returns {{ DatabaseSync: typeof import('node:sqlite').DatabaseSync } | null}
 */
function tryLoadSqlite() {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
}

const sqlite = tryLoadSqlite();

/**
 * Resolve Cursor user-data roots across platforms.
 * @returns {{ globalDb: string, workspaceRoot: string, projectsRoot: string }}
 */
function resolveCursorPaths() {
  const home = os.homedir();
  const platform = os.platform();

  let userData;
  if (platform === 'win32') {
    userData = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'Cursor')
      : path.join(home, 'AppData', 'Roaming', 'Cursor');
  } else if (platform === 'darwin') {
    userData = path.join(home, 'Library', 'Application Support', 'Cursor');
  } else {
    userData = process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'Cursor')
      : path.join(home, '.config', 'Cursor');
  }

  return {
    globalDb: path.join(userData, 'User', 'globalStorage', 'state.vscdb'),
    workspaceRoot: path.join(userData, 'User', 'workspaceStorage'),
    projectsRoot: path.join(home, '.cursor', 'projects')
  };
}

/**
 * Convert a VS Code / Cursor file:// URI to a local filesystem path.
 * @param {string} uri
 * @returns {string}
 */
function fileUrlToPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  let s = uri.trim();
  if (!s.startsWith('file:')) return s;

  try {
    // URL handles percent-encoding; file:///c%3A/... → /c:/... on Windows
    const u = new URL(s);
    let p = decodeURIComponent(u.pathname || '');
    // Windows: /C:/Users/... → C:\Users\...
    if (os.platform() === 'win32') {
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      p = p.replace(/\//g, path.sep);
    }
    return p;
  } catch {
    // Fallback: strip file:// and decode
    s = s.replace(/^file:\/\//i, '');
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep raw
    }
    if (os.platform() === 'win32' && /^\/[A-Za-z]:/.test(s)) s = s.slice(1);
    return s.replace(/\//g, path.sep);
  }
}

/**
 * Decode a ~/.cursor/projects/<slug> name into a human project label.
 * @param {string} slug
 * @returns {string}
 */
function projectSlugToLabel(slug) {
  if (!slug) return '';
  // Common pattern: c-Users-name-... or Users-name-...
  const parts = String(slug).split('-').filter(Boolean);
  if (parts.length === 0) return slug;
  return parts[parts.length - 1] || slug;
}

module.exports = {
  RECENT_MS,
  POST_EXIT_GRACE_MS,
  LIVE_WRITE_MS,
  tryLoadSqlite,
  sqlite,
  resolveCursorPaths,
  fileUrlToPath,
  projectSlugToLabel
};
