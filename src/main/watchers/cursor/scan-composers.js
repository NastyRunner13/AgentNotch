const fs = require('fs');
const path = require('path');
const { sqlite, fileUrlToPath, RECENT_MS, POST_EXIT_GRACE_MS } = require('./paths');
const { parseDbJson, dbChangeToken } = require('./db');
const { mapCursorStatus, analyzeCursorComposer } = require('./analyze');
const { findTranscriptForComposer } = require('./scan-transcripts');

/**
 * @param {object} watcher
 * @param {number} now
 * @param {boolean} isRunning
 * @returns {Array<object>}
 */
function scanComposers(watcher, now, isRunning) {
  if (!sqlite) return [];
  if (!fs.existsSync(watcher.globalDb)) return [];

  const token = dbChangeToken(watcher.globalDb);
  // Always re-read when process presence flips or token changes; also re-read
  // periodically via safety poll even if token matches (status may age out).
  void token;

  /** @type {Map<string, string>} */
  const cwdById = new Map();
  refreshWorkspaceIndex(watcher, cwdById);

  let db;
  try {
    db = new sqlite.DatabaseSync(watcher.globalDb, { open: true, readOnly: true });
  } catch (err) {
    console.warn('[Cursor] Failed to open global state.vscdb:', err.message);
    return [];
  }

  const results = [];
  try {
    let rows;
    try {
      rows = db
        .prepare(
          "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
        )
        .all();
    } catch (err) {
      console.warn('[Cursor] cursorDiskKV query failed:', err.message);
      return [];
    }

    for (const row of rows) {
      if (!row || row.value == null) continue;
      const composer = parseDbJson(row.value);
      if (!composer || !composer.composerId) continue;

      const last = Number(composer.lastUpdatedAt) || Number(composer.createdAt) || 0;
      const status = mapCursorStatus(composer, { now });
      const isLive = status === 'working' || status === 'needs-attention';

      // Filter noise: empty drafts with no activity
      const hasContent =
        (Array.isArray(composer.fullConversationHeadersOnly) &&
          composer.fullConversationHeadersOnly.length > 0) ||
        (typeof composer.name === 'string' && composer.name.trim()) ||
        (typeof composer.subtitle === 'string' && composer.subtitle.trim()) ||
        isLive;

      if (!hasContent) continue;

      // Time window
      if (!isLive) {
        if (!last || now - last > RECENT_MS) continue;
        if (!isRunning && now - last > POST_EXIT_GRACE_MS) continue;
      } else if (!isRunning && last && now - last > POST_EXIT_GRACE_MS) {
        // Process gone and generation markers stale
        continue;
      }

      const cwd = cwdById.get(composer.composerId) || watcher._composerCwd.get(composer.composerId) || '';
      if (cwd) watcher._composerCwd.set(composer.composerId, cwd);

      const bubbles = loadRecentBubbles(db, composer, 12);
      const transcript = findTranscriptForComposer(watcher, composer.composerId, cwd);

      const analyzed = analyzeCursorComposer(composer, {
        cwd,
        bubbles,
        transcript,
        now
      });

      results.push({
        id: `cursor-${composer.composerId}`,
        ...analyzed
      });
    }
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  // Prefer newest first; cap to avoid flooding the feed
  results.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
  return results.slice(0, 24);
}

/**
 * Build composerId → workspace folder map from workspaceStorage.
 * @param {object} watcher
 * @param {Map<string, string>} cwdById
 */
function refreshWorkspaceIndex(watcher, cwdById) {
  if (!sqlite || !fs.existsSync(watcher.workspaceRoot)) return;

  let dirs;
  try {
    dirs = fs.readdirSync(watcher.workspaceRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const wsDir = path.join(watcher.workspaceRoot, ent.name);
    const dbPath = path.join(wsDir, 'state.vscdb');
    if (!fs.existsSync(dbPath)) continue;

    let folder = '';
    try {
      const wj = path.join(wsDir, 'workspace.json');
      if (fs.existsSync(wj)) {
        const raw = JSON.parse(fs.readFileSync(wj, 'utf8'));
        folder = fileUrlToPath(raw.folder || raw.workspace || '');
      }
    } catch {
      // ignore
    }

    let wdb;
    try {
      wdb = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
    } catch {
      continue;
    }
    try {
      const row = wdb
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get();
      const data = row ? parseDbJson(row.value) : null;
      const list = data && Array.isArray(data.allComposers) ? data.allComposers : [];
      for (const c of list) {
        const id = c.composerId || c.id;
        if (!id) continue;
        // Prefer workspace folder; fall back to any path fields on the entry
        const entryCwd =
          folder ||
          fileUrlToPath(c.workspaceUri || c.folder || '') ||
          '';
        if (entryCwd) {
          cwdById.set(id, entryCwd);
          watcher._composerCwd.set(id, entryCwd);
        }
      }
    } catch {
      // schema variance — skip workspace
    } finally {
      try {
        wdb.close();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Load the last N bubbles for a composer (header order).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} composer
 * @param {number} limit
 * @returns {object[]}
 */
function loadRecentBubbles(db, composer, limit = 12) {
  const headers = Array.isArray(composer.fullConversationHeadersOnly)
    ? composer.fullConversationHeadersOnly
    : [];
  if (headers.length === 0) return [];

  const slice = headers.slice(-limit);
  const bubbles = [];
  const composerId = composer.composerId;

  for (const h of slice) {
    const bid = h.bubbleId || h.id;
    if (!bid) continue;
    try {
      const row = db
        .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
        .get(`bubbleId:${composerId}:${bid}`);
      const b = row ? parseDbJson(row.value) : null;
      if (b) {
        // Preserve header type if bubble omits it
        if (b.type == null && h.type != null) b.type = h.type;
        bubbles.push(b);
      }
    } catch {
      // skip bubble
    }
  }
  return bubbles;
}

module.exports = {
  scanComposers,
  refreshWorkspaceIndex,
  loadRecentBubbles
};
