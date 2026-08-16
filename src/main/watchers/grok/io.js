const fs = require('fs');
const path = require('path');
const { parseJSONL } = require('../base-watcher');
const { getAcpUpdate, extractChunkText } = require('./helpers');
const { analyzeChatHistory } = require('./chat');

/**
 * Read the head of chat_history.jsonl to recover the user prompt when only a tail was parsed.
 */
function readChatUserPromptHead(filePath, maxBytes = 200_000) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const len = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return analyzeChatHistory(parseJSONL(buf.toString('utf-8'))).userPrompt;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Read the beginning of a large updates.jsonl to recover the user prompt
 * (which is usually only at the start of the session stream).
 */
function readUserPromptHead(filePath, maxBytes = 120_000) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const len = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      const entries = parseJSONL(buf.toString('utf-8'));
      let userBuf = '';
      for (const entry of entries) {
        const update = getAcpUpdate(entry);
        if (!update) continue;
        if (update.sessionUpdate === 'user_message_chunk') {
          userBuf += extractChunkText(update);
        } else if (userBuf && update.sessionUpdate !== 'user_message_chunk') {
          // End of the opening user message block
          break;
        }
      }
      return userBuf ? userBuf.substring(0, 400) : '';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Read a short snippet from the newest non-empty terminal log.
 */
function readLatestTerminalSnippet(terminalDir) {
  try {
    if (!fs.existsSync(terminalDir)) return '';
    const files = fs.readdirSync(terminalDir)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const full = path.join(terminalDir, f);
        try {
          const st = fs.statSync(full);
          return { full, mtime: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter(f => f.size > 0)
      .sort((a, b) => b.mtime - a.mtime);

    if (!files.length) return '';
    const target = files[0];
    // Read last ~6KB safely (file may be locked on Windows)
    const fd = fs.openSync(target.full, 'r');
    try {
      const start = Math.max(0, target.size - 6144);
      const len = target.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      let text = buf.toString('utf-8');
      // Drop NULs / mostly-binary garbage from locked partial writes
      if (!text || /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 200))) return '';
      const lines = text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        // Skip lines that look like byte dumps or pure hex noise
        .filter(l => {
          if (/^[\d,\s]+$/.test(l) && l.length > 40) return false;
          if ((l.match(/,/g) || []).length > 20 && /,\d+,/.test(l)) return false;
          return true;
        });
      if (!lines.length) return '';
      // Keep several lines so the feed looks like terminal output
      const tail = lines.slice(-8).join('\n');
      return tail.trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

module.exports = {
  readChatUserPromptHead,
  readUserPromptHead,
  readLatestTerminalSnippet
};
