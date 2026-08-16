const { fileUrlToPath } = require('./paths');

/**
 * Short human label for Cursor tool names.
 * @param {string} name
 * @returns {string}
 */
function humanizeCursorToolName(name) {
  const n = String(name || '').trim();
  if (!n) return 'tool';
  return n
    .replace(/^run_terminal_command$/i, 'Shell')
    .replace(/^shell$/i, 'Shell')
    .replace(/^codebase_search$/i, 'Search')
    .replace(/^grep$/i, 'Grep')
    .replace(/^read_file$/i, 'Read')
    .replace(/^write$/i, 'Write')
    .replace(/^search_replace$/i, 'Edit')
    .replace(/^edit_file$/i, 'Edit')
    .replace(/^web_search$/i, 'Web')
    .replace(/_/g, ' ');
}

/**
 * Parse tool args from Cursor toolFormerData (rawArgs preferred).
 * @param {object} tfd
 * @returns {object|null}
 */
function parseToolFormerArgs(tfd) {
  if (!tfd || typeof tfd !== 'object') return null;
  const candidates = [tfd.rawArgs, tfd.params, tfd.arguments, tfd.input];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'object' && !Array.isArray(c)) return c;
    if (typeof c === 'string' && c.trim()) {
      try {
        const parsed = JSON.parse(c);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // Not JSON — only useful if it looks like a command path
      }
    }
  }
  return null;
}

/**
 * Extract a short tool / activity label from a bubble or transcript line.
 * @param {object} bubble
 * @returns {string|null}
 */
function toolLabelFromBubble(bubble) {
  if (!bubble || typeof bubble !== 'object') return null;

  const tfd = bubble.toolFormerData || bubble.toolCall || bubble.tool_call;
  if (tfd && typeof tfd === 'object') {
    const name = tfd.name || tfd.toolName || '';
    // toolFormer.tool is often a numeric enum — ignore unless name missing
    const labelName = name || (typeof tfd.tool === 'string' ? tfd.tool : '');
    if (labelName) {
      const args = parseToolFormerArgs(tfd);
      if (args) {
        const cmd = args.command || args.cmd;
        if (cmd) {
          return `Shell: ${String(cmd).replace(/\s+/g, ' ').slice(0, 80)}`;
        }
        const fp =
          args.path ||
          args.file_path ||
          args.target_file ||
          args.targetFile ||
          args.relativeWorkspacePath ||
          args.filePath;
        if (fp && typeof fp === 'string') {
          return `${humanizeCursorToolName(labelName)}: ${String(fp).split(/[/\\]/).pop()}`;
        }
        const q = args.query || args.pattern || args.search_term || args.searchTerm;
        if (q && typeof q === 'string') {
          return `${humanizeCursorToolName(labelName)}: ${q.replace(/\s+/g, ' ').slice(0, 48)}`;
        }
      }
      return humanizeCursorToolName(labelName);
    }
  }

  // codeBlocks with an explicit path/uri (skip content-only suggestion blocks)
  if (Array.isArray(bubble.codeBlocks) && bubble.codeBlocks.length) {
    for (let i = bubble.codeBlocks.length - 1; i >= 0; i--) {
      const block = bubble.codeBlocks[i];
      if (!block || typeof block !== 'object') continue;
      const uri =
        (typeof block.uri === 'string' && block.uri) ||
        (typeof block.filePath === 'string' && block.filePath) ||
        (typeof block.path === 'string' && block.path) ||
        (typeof block.relativeWorkspacePath === 'string' && block.relativeWorkspacePath) ||
        '';
      if (!uri) continue;
      const base = String(fileUrlToPath(uri) || uri).split(/[/\\]/).pop();
      if (base && base !== '[object Object]') return `Edit: ${base}`;
    }
  }

  if (Array.isArray(bubble.fileLinks) && bubble.fileLinks.length) {
    const last = bubble.fileLinks[bubble.fileLinks.length - 1];
    const display =
      (typeof last?.displayName === 'string' && last.displayName) ||
      (typeof last?.path === 'string' && last.path) ||
      (typeof last?.uri === 'string' && last.uri) ||
      '';
    if (display) {
      const base = String(display).split(/[/\\]/).pop();
      return base ? `File: ${base}` : null;
    }
  }

  return null;
}

/**
 * Flatten Cursor's nested conversation summary shapes to a string.
 * @param {unknown} field
 * @returns {string}
 */
function extractSummaryText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field.trim();
  if (typeof field === 'object') {
    // latestConversationSummary: { summary: string | { summary: string }, ... }
    if (typeof field.summary === 'string') return field.summary.trim();
    if (field.summary && typeof field.summary === 'object' && typeof field.summary.summary === 'string') {
      return field.summary.summary.trim();
    }
  }
  return '';
}

module.exports = {
  humanizeCursorToolName,
  parseToolFormerArgs,
  toolLabelFromBubble,
  extractSummaryText
};
