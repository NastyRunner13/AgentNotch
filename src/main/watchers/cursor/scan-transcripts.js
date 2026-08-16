const fs = require('fs');
const path = require('path');
const { formatDuration, extractTaskName, readJsonlEfficient } = require('../base-watcher');
const { projectSlugToLabel, RECENT_MS, POST_EXIT_GRACE_MS } = require('./paths');
const { analyzeCursorTranscript } = require('./analyze');

/**
 * Optional agent-transcript overlay for a composer id.
 * @param {object} watcher
 * @param {string} composerId
 * @param {string} cwd
 * @returns {object|null}
 */
function findTranscriptForComposer(watcher, composerId, cwd) {
  if (!fs.existsSync(watcher.projectsRoot)) return null;

  // Direct match: projects/*/agent-transcripts/<composerId>.{txt,jsonl}
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(watcher.projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const ent of projectDirs) {
    if (!ent.isDirectory()) continue;
    const tdir = path.join(watcher.projectsRoot, ent.name, 'agent-transcripts');
    if (!fs.existsSync(tdir)) continue;
    for (const ext of ['.jsonl', '.txt']) {
      const p = path.join(tdir, `${composerId}${ext}`);
      if (fs.existsSync(p)) candidates.push(p);
    }
    // Also scan for files whose name starts with composerId
    try {
      for (const f of fs.readdirSync(tdir)) {
        if (f.startsWith(composerId) && (f.endsWith('.jsonl') || f.endsWith('.txt'))) {
          candidates.push(path.join(tdir, f));
        }
      }
    } catch {
      // ignore
    }
  }

  if (candidates.length === 0) return null;

  // Prefer newest mtime
  let best = null;
  let bestMtime = 0;
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= bestMtime) {
        bestMtime = st.mtimeMs;
        best = p;
      }
    } catch {
      // ignore
    }
  }
  if (!best) return null;

  try {
    const st = fs.statSync(best);
    const read = best.endsWith('.jsonl')
      ? readJsonlEfficient(best)
      : { content: fs.readFileSync(best, 'utf8'), size: st.size };
    if (!read) return null;
    return analyzeCursorTranscript(read.content, {
      mtime: st.mtimeMs,
      now: Date.now()
    });
  } catch {
    return null;
  }
}

/**
 * Standalone transcript sessions not already covered by composer ids.
 * @param {object} watcher
 * @param {number} now
 * @param {boolean} isRunning
 * @param {Array<{id:string}>} composerSessions
 * @returns {Array<object>}
 */
function scanTranscripts(watcher, now, isRunning, composerSessions) {
  if (!fs.existsSync(watcher.projectsRoot)) return [];

  const covered = new Set(
    (composerSessions || []).map((s) => String(s.id).replace(/^cursor-/, ''))
  );
  const out = [];

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(watcher.projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const ent of projectDirs) {
    if (!ent.isDirectory()) continue;
    const tdir = path.join(watcher.projectsRoot, ent.name, 'agent-transcripts');
    if (!fs.existsSync(tdir)) continue;

    let files;
    try {
      files = fs.readdirSync(tdir, { withFileTypes: true });
    } catch {
      continue;
    }

    // Best-effort cwd from project slug is weak; leave empty unless we have path
    const projectLabel = projectSlugToLabel(ent.name);

    for (const f of files) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith('.jsonl') && !f.name.endsWith('.txt')) continue;
      // Skip subagent nests (directories handled separately if needed)
      const base = f.name.replace(/\.(jsonl|txt)$/i, '');
      if (covered.has(base)) continue;

      const full = path.join(tdir, f.name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }

      if (now - st.mtimeMs > RECENT_MS) continue;
      if (!isRunning && now - st.mtimeMs > POST_EXIT_GRACE_MS) continue;
      // Skip tiny empty stubs
      if (st.size < 8) continue;

      try {
        const read = f.name.endsWith('.jsonl')
          ? readJsonlEfficient(full)
          : { content: fs.readFileSync(full, 'utf8') };
        if (!read || !read.content) continue;
        const tr = analyzeCursorTranscript(read.content, {
          mtime: st.mtimeMs,
          now
        });

        // Only surface if there is a real prompt/activity
        if (!tr.userPrompt && !tr.lastMessage && tr.toolCalls.length === 0) continue;

        const sessionId = `cursor-tx-${base}`;
        const taskName =
          extractTaskName(tr.userPrompt) ||
          (projectLabel ? `Cursor · ${projectLabel}` : 'Cursor agent');

        const duration = Math.max(0, st.mtimeMs - (st.birthtimeMs || st.mtimeMs));
        out.push({
          id: sessionId,
          taskName,
          status: tr.status,
          currentTool: tr.currentTool,
          lastMessage: tr.lastMessage,
          userPrompt: tr.userPrompt,
          permissionRequest: null,
          question: null,
          duration,
          durationFormatted: formatDuration(duration),
          startTime: st.birthtimeMs || st.mtimeMs,
          lastTime: st.mtimeMs,
          lastActivityAt: st.mtimeMs,
          terminal: 'Cursor',
          toolCalls: tr.toolCalls,
          activity: tr.activity,
          plan: [],
          isActive: tr.status === 'working',
          model: null,
          cwd: '',
          resumeId: base
        });
      } catch {
        // skip file
      }
    }
  }

  out.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
  return out.slice(0, 12);
}

module.exports = {
  findTranscriptForComposer,
  scanTranscripts
};
