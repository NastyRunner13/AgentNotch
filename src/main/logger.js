const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = process.env.AGENT_NOTCH_LOG_LEVEL
  ? (LEVELS[process.env.AGENT_NOTCH_LOG_LEVEL] ?? 2)
  : (process.env.NODE_ENV === 'production' ? 1 : 2);

// Captured at module load, before any console capture is installed.
const origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

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
  if (level === 'error') origConsole.error(line);
  else if (level === 'warn') origConsole.warn(line);
  else origConsole.log(line);

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

let consoleCaptured = false;

/**
 * Mirror all main-process console.* output into the daily log file.
 * Console behavior is unchanged; this only adds persistence.
 */
function installConsoleCapture() {
  if (consoleCaptured) return;
  consoleCaptured = true;

  const mirror = (level, args) => {
    try {
      const stream = ensureLogFile();
      if (!stream) return;
      const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${util.format(...args)}`;
      stream.write(line + '\n');
    } catch {
      // ignore file errors
    }
  };

  console.log = (...args) => { origConsole.log(...args); mirror('info', args); };
  console.warn = (...args) => { origConsole.warn(...args); mirror('warn', args); };
  console.error = (...args) => { origConsole.error(...args); mirror('error', args); };
}

/** Flush and close the log stream (call on app quit). */
function closeLogger() {
  if (logStream) {
    try {
      logStream.end();
    } catch {
      // ignore
    }
    logStream = null;
  }
}

module.exports = { createLogger, installConsoleCapture, closeLogger };
