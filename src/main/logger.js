const fs = require('fs');
const path = require('path');
const os = require('os');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = process.env.AGENT_NOTCH_LOG_LEVEL
  ? (LEVELS[process.env.AGENT_NOTCH_LOG_LEVEL] ?? 2)
  : (process.env.NODE_ENV === 'production' ? 1 : 2);

let logStream = null;

function ensureLogFile() {
  if (logStream) return logStream;
  try {
    const dir = path.join(os.homedir(), '.agent-notch', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `agent-notch-${new Date().toISOString().slice(0, 10)}.log`);
    logStream = fs.createWriteStream(file, { flags: 'a' });
  } catch {
    logStream = null;
  }
  return logStream;
}

function write(level, tag, message, err) {
  if ((LEVELS[level] ?? 2) > currentLevel) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${tag}] ${message}${err ? ` ${err.message || err}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  try {
    const stream = ensureLogFile();
    if (stream) stream.write(line + '\n');
  } catch {
    // ignore file errors
  }
}

function createLogger(tag) {
  return {
    error: (msg, err) => write('error', tag, msg, err),
    warn: (msg, err) => write('warn', tag, msg, err),
    info: (msg) => write('info', tag, msg),
    debug: (msg) => write('debug', tag, msg)
  };
}

module.exports = { createLogger };
