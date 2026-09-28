const fs = require('fs');
const path = require('path');
const os = require('os');
const { writePrivateFile } = require('../security/security');

const WAITING = new Set(['permission-request', 'question', 'needs-attention']);
const MAX_OBSERVATION_GAP_MS = 30000;

function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Observed states only: no transcript content, inferred task success, or historical backfill. */
class PerformanceTracker {
  constructor({ dataPath = path.join(os.homedir(), '.agent-notch', 'performance-stats.json'), now = Date.now, enabled = true } = {}) {
    this.dataPath = dataPath;
    this.now = now;
    this.enabled = enabled;
    this.suspended = false;
    this.sessions = new Map();
    this.days = new Map();
    this.episodes = [];
    this.coverageStart = null;
    this.updatedAt = null;
    this.incompleteObservations = 0;
    this.saveTimer = null;
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      if (data.version === 1 && Array.isArray(data.days) && Array.isArray(data.episodes)) {
        this.days = new Map(data.days.map(row => [`${row.day}|${row.agent}`, row]));
        this.episodes = data.episodes;
        this.coverageStart = data.coverageStart;
        this.updatedAt = data.updatedAt;
        // A checkpoint is a closed observation boundary, never a resumable timer.
        this.incompleteObservations = (data.incompleteObservations || 0) + (data.openEpisodes || 0);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[Performance] Could not load observations:', err.message);
    }
    this._prune();
  }

  _bucket(timestamp, agent) {
    const day = dayKey(timestamp);
    const key = `${day}|${agent}`;
    if (!this.days.has(key)) this.days.set(key, { day, agent, workMs: 0, waitMs: 0, attentionEpisodes: 0, completedEpisodes: 0 });
    return this.days.get(key);
  }

  _prune() {
    const cutoff = new Date(this.now());
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 89);
    const firstDay = dayKey(cutoff.getTime());
    for (const [key, row] of this.days) if (row.day < firstDay) this.days.delete(key);
    this.episodes = this.episodes.filter(row => row.day >= firstDay);
    if (this.coverageStart !== null) this.coverageStart = Math.max(this.coverageStart, cutoff.getTime());
  }

  _checkpoint(state, timestamp) {
    const duration = timestamp - state.at;
    if (duration < 0 || duration > MAX_OBSERVATION_GAP_MS) return false;
    const field = state.status === 'working' ? 'workMs' : WAITING.has(state.status) ? 'waitMs' : null;
    if (field) {
      let from = state.at;
      while (from < timestamp) {
        const midnight = new Date(from);
        midnight.setHours(24, 0, 0, 0);
        const until = Math.min(timestamp, midnight.getTime());
        this._bucket(from, state.agent)[field] += until - from;
        from = until;
      }
      if (field === 'workMs' && state.episode) state.episode.workMs += duration;
    }
    state.at = timestamp;
    return true;
  }

  ingest(sessions) {
    if (!this.enabled || this.suspended) return;
    const timestamp = this.now();
    this.coverageStart ??= timestamp;
    const seen = new Set();
    for (const session of sessions) {
      if (!session || !session.id || !session.agent || seen.has(session.id)) continue;
      seen.add(session.id);
      let state = this.sessions.get(session.id);
      if (state && (state.agent !== session.agent || !this._checkpoint(state, timestamp))) {
        if (state.episode) this.incompleteObservations++;
        state = null;
      }
      const waiting = WAITING.has(session.status);
      const attentionKey = waiting ? session.attentionEpisodeKey || session.status : null;
      if (waiting && (!state || !WAITING.has(state.status) || state.attentionKey !== attentionKey)) {
        this._bucket(timestamp, session.agent).attentionEpisodes++;
      }
      let episode = state?.episode || null;
      if (session.status === 'working' && !episode) {
        // Only a directly observed idle -> working transition has a known start.
        episode = { workMs: 0, complete: state?.status === 'idle' };
      }
      if (episode && session.status === 'idle') {
        this._bucket(timestamp, session.agent).completedEpisodes++;
        if (episode.complete) this.episodes.push({ day: dayKey(timestamp), agent: session.agent, workMs: episode.workMs, complete: true });
        else this.incompleteObservations++;
        episode = null;
      } else if (episode && session.status !== 'working' && !waiting) {
        this.incompleteObservations++;
        episode = null;
      }
      this.sessions.set(session.id, { agent: session.agent, status: session.status, at: timestamp, attentionKey, episode });
    }
    for (const [id, state] of this.sessions) {
      if (seen.has(id)) continue;
      // Disappearance does not establish a completion or any additional interval.
      if (state.episode) this.incompleteObservations++;
      this.sessions.delete(id);
    }
    this.updatedAt = timestamp;
    this._prune();
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        try { this.flush(); } catch (err) { console.warn('[Performance] Could not save observations:', err.message); }
      }, 2000);
      this.saveTimer.unref?.();
    }
  }

  suspend() {
    const timestamp = this.now();
    for (const state of this.sessions.values()) {
      this._checkpoint(state, timestamp);
      if (state.episode) this.incompleteObservations++;
    }
    this.sessions.clear();
    this.suspended = true;
    this.flush();
  }

  resume() {
    this.suspended = false;
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.suspend();
    this.resume();
  }

  clear() {
    this.sessions.clear();
    this.days.clear();
    this.episodes = [];
    this.coverageStart = null;
    this.updatedAt = null;
    this.incompleteObservations = 0;
    this.flush();
    return this.getStats();
  }

  getStats() {
    this._prune();
    return {
      updatedAt: this.updatedAt,
      coverageStart: this.coverageStart,
      enabled: this.enabled,
      days: [...this.days.values()].map(row => ({ ...row })).sort((a, b) => b.day.localeCompare(a.day)),
      episodes: this.episodes.map(row => ({ ...row })),
      incompleteObservations: this.incompleteObservations
    };
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    writePrivateFile(this.dataPath, JSON.stringify({
      version: 1,
      ...this.getStats(),
      openEpisodes: [...this.sessions.values()].filter(state => state.episode).length
    }));
  }
}

module.exports = { PerformanceTracker, MAX_OBSERVATION_GAP_MS };
