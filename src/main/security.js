/**
 * Shared security helpers for the Electron main process.
 * Keep this module free of AgentManager / window state so it stays unit-testable.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const SESSION_ID_RE = /^[a-z][a-z0-9_-]*-[a-zA-Z0-9._~%-]{1,220}$/;
const HISTORY_ID_RE = /^[A-Za-z0-9._~%-]{1,240}$/;
const WSL_DISTRO_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_PROMPT_CHARS = 8000;
const MAX_PATH_CHARS = 1000;
const MIN_POLL_MS = 1500;
const MAX_POLL_MS = 60_000;
const DEFAULT_POLL_MS = 3000;

const FOCUS_AGENT_NAMES = Object.freeze([
  'Claude Code',
  'Codex',
  'Cursor',
  'Antigravity',
  'Grok',
  'OpenCode'
]);

const HOTKEY_MODIFIERS = new Set([
  'CommandOrControl',
  'Command',
  'Cmd',
  'Control',
  'Ctrl',
  'CmdOrCtrl',
  'Alt',
  'Option',
  'AltGr',
  'Shift',
  'Super',
  'Meta'
]);

const HOTKEY_KEY = /^(F(?:[1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|[A-Za-z0-9])$/;

function rendererIndexPath() {
  return path.resolve(__dirname, '..', 'renderer', 'index.html');
}

function isAppRendererUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  try {
    const filePath = fileURLToPath(url);
    return path.resolve(filePath) === rendererIndexPath();
  } catch {
    return false;
  }
}

function hardenWebContents(contents) {
  if (!contents || typeof contents.setWindowOpenHandler !== 'function') return;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockForeign = (event, nextUrl) => {
    if (!isAppRendererUrl(nextUrl)) event.preventDefault();
  };
  contents.on('will-navigate', blockForeign);
  contents.on('will-redirect', blockForeign);
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function installAppWebSecurity(app) {
  if (!app || typeof app.on !== 'function') return;
  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents);
  });
}

function installSessionSecurity(electronSession) {
  if (!electronSession || !electronSession.defaultSession) return;
  const ses = electronSession.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  if (typeof ses.setDevicePermissionHandler === 'function') {
    ses.setDevicePermissionHandler(() => false);
  }
  ses.on('will-download', (event) => {
    event.preventDefault();
  });
}

function assertTrustedIpcSender(event, mainWindow) {
  if (!event || !event.sender) {
    throw new Error('Unauthorized IPC sender');
  }
  if (!mainWindow || (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed())) {
    throw new Error('App window is not available');
  }
  if (event.sender !== mainWindow.webContents) {
    throw new Error('Unauthorized IPC sender');
  }
}

function validateSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
    throw new Error(`Invalid session id: ${String(id).slice(0, 80)}`);
  }
  return id;
}

function validateHistoryId(id) {
  if (typeof id !== 'string' || !HISTORY_ID_RE.test(id)) {
    throw new Error('Invalid history id');
  }
  return id;
}

function validateFocusAgentName(name) {
  if (typeof name !== 'string' || !FOCUS_AGENT_NAMES.includes(name)) {
    throw new Error('Invalid agent name');
  }
  return name;
}

function normalizeDispatchPrompt(value) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw new Error('Invalid dispatch prompt');
  }
  if (value.length > MAX_PROMPT_CHARS) {
    throw new Error(`Dispatch prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
  }
  return value;
}

function sanitizeWslDistro(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s) return '';
  return WSL_DISTRO_RE.test(s) ? s : '';
}

function sanitizeHotkey(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s) return '';
  if (s.length > 80) return '';
  const parts = s.split('+');
  if (parts.length < 2 || parts.length > 5) return '';
  if (!HOTKEY_MODIFIERS.has(parts[0])) return '';
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i];
    if (HOTKEY_MODIFIERS.has(token) || HOTKEY_KEY.test(token)) continue;
    return '';
  }
  return parts.join('+');
}

function clampPollInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(n)));
}

function looksLikeUrlNotPath(p) {
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false;
  if (p.startsWith('\\\\') || p.startsWith('//')) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p);
}

function isOverbroadRoot(p) {
  try {
    const resolved = path.resolve(p);
    const root = path.parse(resolved).root;
    const stripped = resolved.replace(/[\\/]+$/, '');
    const rootStripped = String(root || '').replace(/[\\/]+$/, '');
    if (!rootStripped) return stripped === '' || stripped === '/' || stripped === '\\';
    return stripped.toLowerCase() === rootStripped.toLowerCase();
  } catch {
    return true;
  }
}

function sanitizeConfigurablePath(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim().slice(0, 500);
  if (!s || s.includes('\0')) return '';
  if (looksLikeUrlNotPath(s)) return '';
  if (isOverbroadRoot(s)) return '';
  return s;
}

function sanitizeAgentRoots(roots) {
  const keys = ['claude', 'codex', 'cursor', 'antigravity', 'grok', 'opencode'];
  const out = {};
  const src = roots && typeof roots === 'object' && !Array.isArray(roots) ? roots : {};
  for (const key of keys) {
    out[key] = sanitizeConfigurablePath(typeof src[key] === 'string' ? src[key] : '');
  }
  return out;
}

/**
 * Only directories may be opened. Files (including .exe/.lnk/.cmd) are refused
 * so a poisoned session cwd cannot execute via shell.openPath.
 */
function resolveOpenableDirectory(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    return { ok: false, message: 'No path provided' };
  }
  const raw = targetPath.trim().slice(0, MAX_PATH_CHARS);
  if (raw.includes('\0')) {
    return { ok: false, message: 'Invalid path' };
  }
  if (looksLikeUrlNotPath(raw)) {
    return { ok: false, message: 'Refusing to open URL' };
  }
  try {
    const resolved = path.resolve(raw);
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) {
      return { ok: false, message: 'Only folders can be opened' };
    }
    return { ok: true, path: resolved };
  } catch {
    return { ok: false, message: 'Path not found' };
  }
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows may ignore */ }
}

function assertNotSymlink(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw new Error('Refusing to write through symlink');
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

function writePrivateFile(filePath, data) {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  assertNotSymlink(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows may ignore */ }
}

/**
 * Quote one argv element for `cmd.exe /s /c` so metacharacters stay data.
 * Used only as a fallback when an npm .cmd shim cannot be resolved to node.
 */
function quoteCmdExeArg(value) {
  const s = String(value).replace(/\u0000/g, '');
  // Neutralize cmd percent/caret expansion, then wrap and double quotes.
  const neutralized = s.replace(/\^/g, '^^').replace(/%/g, '%%');
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function buildCmdExeInvoke(scriptPath, argv) {
  const inner = [scriptPath, ...(Array.isArray(argv) ? argv : [])]
    .map(quoteCmdExeArg)
    .join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${inner}"`],
    spawnOpts: { windowsVerbatimArguments: true, shell: false }
  };
}

/**
 * npm .cmd shims typically end with one of:
 *   "%_prog%" "%dp0%\node_modules\…\cli.js" %*
 *   "%dp0%\node_modules\…\tool.exe" %*
 * Resolve that target and spawn it directly so user text never crosses cmd.exe.
 */
function tryResolveNpmCmdShim(cmdPath) {
  if (typeof cmdPath !== 'string' || !cmdPath) return null;
  let text;
  try {
    text = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/"%dp0%\\([^"\r\n]+\.(?:js|cjs|mjs|exe))"/i);
  if (!m) return null;
  const target = path.normalize(path.join(path.dirname(cmdPath), m[1]));
  const lower = target.toLowerCase();
  const isExe = lower.endsWith('.exe');
  const isScript = lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs');
  if (!isExe && !isScript) return null;
  try {
    if (!fs.statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  if (isExe) {
    return { file: target, prefixArgs: [] };
  }
  const localNode = path.join(path.dirname(cmdPath), 'node.exe');
  let nodeFile = 'node.exe';
  try {
    if (fs.statSync(localNode).isFile()) nodeFile = localNode;
  } catch {
    // fall through — spawn will look up node.exe on PATH
  }
  return { file: nodeFile, prefixArgs: [target] };
}

/**
 * Plan a Windows CLI launch that never feeds unsanitized user args to cmd.exe
 * when we can resolve the npm shim, and quotes them if we cannot.
 *
 * @param {{ file: string, viaCmd: boolean }} cli
 * @param {string[]} args
 */
function planWindowsCliLaunch(cli, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!cli || !cli.file) {
    throw new Error('Missing CLI path');
  }
  if (!cli.viaCmd) {
    return { file: cli.file, args: argv, spawnOpts: { shell: false } };
  }
  const shim = tryResolveNpmCmdShim(cli.file);
  if (shim) {
    return {
      file: shim.file,
      args: [...shim.prefixArgs, ...argv],
      spawnOpts: { shell: false }
    };
  }
  return buildCmdExeInvoke(cli.file, argv);
}

function appRendererFileUrl() {
  return pathToFileURL(rendererIndexPath()).href;
}

module.exports = {
  SESSION_ID_RE,
  HISTORY_ID_RE,
  MAX_PROMPT_CHARS,
  MIN_POLL_MS,
  MAX_POLL_MS,
  DEFAULT_POLL_MS,
  FOCUS_AGENT_NAMES,
  isAppRendererUrl,
  rendererIndexPath,
  appRendererFileUrl,
  hardenWebContents,
  installAppWebSecurity,
  installSessionSecurity,
  assertTrustedIpcSender,
  validateSessionId,
  validateHistoryId,
  validateFocusAgentName,
  normalizeDispatchPrompt,
  sanitizeWslDistro,
  sanitizeHotkey,
  clampPollInterval,
  looksLikeUrlNotPath,
  isOverbroadRoot,
  sanitizeConfigurablePath,
  sanitizeAgentRoots,
  resolveOpenableDirectory,
  ensurePrivateDir,
  assertNotSymlink,
  writePrivateFile,
  quoteCmdExeArg,
  buildCmdExeInvoke,
  tryResolveNpmCmdShim,
  planWindowsCliLaunch
};
