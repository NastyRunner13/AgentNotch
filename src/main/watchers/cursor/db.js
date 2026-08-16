const fs = require('fs');

/**
 * Read JSON blob from a SQLite value column (string or Buffer).
 * @param {unknown} value
 * @returns {object|null}
 */
function parseDbJson(value) {
  if (value == null) return null;
  try {
    const text =
      typeof value === 'string'
        ? value
        : Buffer.isBuffer(value)
          ? value.toString('utf8')
          : String(value);
    if (!text || text === 'null') return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Change token for a DB path + WAL sidecars (same idea as OpenCode watcher).
 * @param {string} dbPath
 * @returns {string|null}
 */
function dbChangeToken(dbPath) {
  let dbStat;
  try {
    dbStat = fs.statSync(dbPath);
  } catch {
    return null;
  }
  let newest = dbStat.mtimeMs;
  let walSize = 0;
  for (const suffix of ['-wal', '-shm']) {
    try {
      const st = fs.statSync(dbPath + suffix);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (suffix === '-wal') walSize = st.size;
    } catch {
      // absent
    }
  }
  return `${newest}:${walSize}`;
}

module.exports = {
  parseDbJson,
  dbChangeToken
};
