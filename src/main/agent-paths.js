/**
 * Resolve on-disk agent data roots: defaults, custom Settings paths, and WSL.
 * Pure helpers accept injected exists / probe so tests do not call wsl.exe.
 */

'use strict';

const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const AGENT_ROOT_KEYS = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'grok',
  'opencode'
]);

const SKIP_DISTRO = /docker-desktop/i;

function emptyRoots() {
  return {
    claude: '',
    codex: '',
    cursor: '',
    antigravity: '',
    grok: '',
    opencode: ''
  };
}

/**
 * @param {unknown} value
 * @returns {{ claude: string, codex: string, cursor: string, antigravity: string, grok: string, opencode: string }}
 */
function normalizeAgentRoots(value) {
  const out = emptyRoots();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of AGENT_ROOT_KEYS) {
    if (typeof value[key] === 'string') {
      out[key] = value[key].trim().slice(0, 500);
    }
  }
  return out;
}

/**
 * Default local roots (Windows home / macOS / Linux) — not WSL.
 * @param {string} [home]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
function defaultAgentRoots(home = os.homedir(), env = process.env, platform = process.platform) {
  const cursorUserData = platform === 'win32'
    ? (env.APPDATA
      ? path.join(env.APPDATA, 'Cursor')
      : path.join(home, 'AppData', 'Roaming', 'Cursor'))
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Cursor')
      : (env.XDG_CONFIG_HOME
        ? path.join(env.XDG_CONFIG_HOME, 'Cursor')
        : path.join(home, '.config', 'Cursor'));

  const opencodeDb = platform === 'win32'
    ? (env.APPDATA
      ? path.join(env.APPDATA, 'opencode', 'opencode.db')
      : path.join(home, 'AppData', 'Roaming', 'opencode', 'opencode.db'))
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'opencode', 'opencode.db')
      : path.join(home, '.local', 'share', 'opencode', 'opencode.db');

  return {
    claude: path.join(home, '.claude'),
    codex: path.join(home, '.codex'),
    grok: path.join(home, '.grok'),
    antigravity: path.join(home, '.gemini'),
    cursor: cursorUserData,
    opencode: opencodeDb
  };
}

/** Linux-side relative paths from $HOME for WSL UNC joins. */
const WSL_HOME_REL = Object.freeze({
  claude: '.claude',
  codex: '.codex',
  grok: '.grok',
  antigravity: '.gemini',
  cursor: '',
  opencode: path.posix.join('.local', 'share', 'opencode', 'opencode.db')
});

/**
 * Decode `wsl.exe -l` output (often UTF-16LE).
 * @param {Buffer|string} buf
 * @returns {string}
 */
function decodeWslOutput(buf) {
  if (typeof buf === 'string') return buf;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
  if (buf.length >= 2 && buf[1] === 0) {
    return buf.toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  return buf.toString('utf8');
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function parseWslDistroNames(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, '').trim())
    .filter(Boolean);
}

/**
 * @param {string[]} names
 * @param {string} [preferred]
 * @returns {string}
 */
function pickWslDistro(names, preferred) {
  const list = Array.isArray(names) ? names : [];
  const usable = list.filter((n) => n && !SKIP_DISTRO.test(n));
  const want = String(preferred || '').trim();
  if (want && usable.includes(want)) return want;
  return usable[0] || '';
}

/**
 * `\\wsl$\Ubuntu\home\user` (+ optional relative posix path).
 * @param {string} distro
 * @param {string} linuxHome  e.g. /home/alice
 * @param {string} [relPosix] e.g. .claude
 */
function wslUncPath(distro, linuxHome, relPosix = '') {
  const d = String(distro || '').trim();
  const home = String(linuxHome || '').trim();
  if (!d || !home) return '';
  const homeWin = home.replace(/^\/+/, '').replace(/\//g, '\\');
  let p = `\\\\wsl$\\${d}\\${homeWin}`;
  const rel = String(relPosix || '').replace(/^\/+/, '').replace(/\//g, '\\');
  if (rel) p = `${p}\\${rel}`;
  return p;
}

/**
 * Probe WSL for a usable distro + $HOME. Returns null off Windows or on failure.
 * @param {{
 *   platform?: NodeJS.Platform,
 *   preferred?: string,
 *   execFileSync?: typeof execFileSync
 * }} [opts]
 * @returns {{ distro: string, linuxHome: string }|null}
 */
function probeWsl(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return null;
  const exec = opts.execFileSync || execFileSync;
  try {
    const raw = exec('wsl.exe', ['-l', '-q'], {
      encoding: 'buffer',
      timeout: 4000,
      windowsHide: true
    });
    const names = parseWslDistroNames(decodeWslOutput(raw));
    const distro = pickWslDistro(names, opts.preferred);
    if (!distro) return null;
    const homeRaw = exec('wsl.exe', ['-d', distro, '--', 'printenv', 'HOME'], {
      encoding: 'buffer',
      timeout: 4000,
      windowsHide: true
    });
    const linuxHome = decodeWslOutput(homeRaw).replace(/\u0000/g, '').trim().split(/\r?\n/)[0] || '';
    if (!linuxHome.startsWith('/')) return null;
    return { distro, linuxHome };
  } catch {
    return null;
  }
}

/**
 * @typedef {{ primary: string, extra: string[], source: 'custom'|'default'|'wsl' }} AgentWatchTarget
 */

/**
 * Resolve primary + extra (WSL) roots per agent.
 *
 * @param {object} settings
 * @param {{
 *   platform?: NodeJS.Platform,
 *   home?: string,
 *   env?: NodeJS.ProcessEnv,
 *   exists?: (p: string) => boolean,
 *   wsl?: { distro: string, linuxHome: string }|null
 * }} [opts]
 */
function resolveAgentWatchTargets(settings, opts = {}) {
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  const exists = typeof opts.exists === 'function'
    ? opts.exists
    : (p) => {
      try { return require('fs').existsSync(p); } catch { return false; }
    };

  const defaults = defaultAgentRoots(home, env, platform);
  const custom = normalizeAgentRoots(settings && settings.agentRoots);
  const watchWsl = platform === 'win32' && (settings ? settings.watchWsl !== false : true);
  const wsl = watchWsl ? (opts.wsl || null) : null;

  /** @type {Record<string, AgentWatchTarget>} */
  const out = {};

  for (const key of AGENT_ROOT_KEYS) {
    const customPath = custom[key];
    const def = defaults[key];
    let wslPath = '';
    if (wsl && WSL_HOME_REL[key]) {
      wslPath = wslUncPath(wsl.distro, wsl.linuxHome, WSL_HOME_REL[key]);
    }

    if (customPath) {
      out[key] = {
        primary: customPath,
        extra: (wslPath && wslPath !== customPath && exists(wslPath)) ? [wslPath] : [],
        source: 'custom'
      };
      continue;
    }

    const defExists = exists(def);
    const wslExists = Boolean(wslPath && exists(wslPath));

    if (defExists && wslExists && wslPath !== def) {
      out[key] = { primary: def, extra: [wslPath], source: 'default' };
    } else if (!defExists && wslExists) {
      out[key] = { primary: wslPath, extra: [], source: 'wsl' };
    } else {
      out[key] = { primary: def, extra: [], source: 'default' };
    }
  }

  return {
    targets: out,
    watchWsl,
    wslDistro: wsl ? wsl.distro : '',
    wslHome: wsl ? wsl.linuxHome : ''
  };
}

/**
 * True when a cwd looks like a Linux/WSL path (not a Windows drive path).
 * @param {string} [cwd]
 */
function isLinuxCwd(cwd) {
  const s = String(cwd || '').trim();
  if (!s) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return false;
  if (s.startsWith('\\\\wsl$\\') || s.startsWith('//wsl$/')) return true;
  return s.startsWith('/');
}

function isWslUnc(cwd) {
  const s = String(cwd || '').replace(/\//g, '\\');
  return s.startsWith('\\\\wsl$\\');
}

/**
 * Map a session cwd to something Windows Node can `stat` / open
 * (`C:\…` or `\\wsl$\Distro\…`). Leaves ordinary Windows paths alone.
 *
 * @param {string} [cwd]
 * @param {{ distro: string, linuxHome?: string }|null} [wsl]
 */
function toWindowsReadablePath(cwd, wsl) {
  const s = String(cwd || '').trim();
  if (!s) return '';
  if (/^[A-Za-z]:[\\/]/.test(s)) return s;
  if (isWslUnc(s) || s.startsWith('//wsl$/')) {
    return s.replace(/\//g, '\\');
  }
  const mnt = s.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mnt) {
    return `${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`;
  }
  if (s.startsWith('/') && wsl && wsl.distro) {
    return wslUncPath(wsl.distro, s);
  }
  return s;
}

/**
 * Map a session cwd to a Linux path for `wsl.exe --cd`.
 *
 * @param {string} [cwd]
 * @param {{ distro: string, linuxHome?: string }|null} [wsl]
 */
function toLinuxCwd(cwd, wsl) {
  const s = String(cwd || '').trim();
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  const unc = s.replace(/\//g, '\\');
  const m = unc.match(/^\\\\wsl\$\\[^\\]+\\(.*)$/i);
  if (m) return `/${m[1].replace(/\\/g, '/')}`;
  const win = s.match(/^([A-Za-z]):[\\/](.*)$/);
  if (win && wsl) {
    return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
  }
  return '';
}

/**
 * Session lives in WSL (extra watcher, tagged id, or Linux/UNC cwd).
 * @param {object|null|undefined} session
 */
function isWslBackedSession(session) {
  if (!session) return false;
  if (session.sourceTag === 'wsl' || session.source === 'wsl') return true;
  if (/^(claude|codex|grok|antigravity|opencode|cursor)-wsl-/i.test(String(session.id || ''))) {
    return true;
  }
  return isLinuxCwd(session.cwd);
}

module.exports = {
  AGENT_ROOT_KEYS,
  WSL_HOME_REL,
  normalizeAgentRoots,
  defaultAgentRoots,
  decodeWslOutput,
  parseWslDistroNames,
  pickWslDistro,
  wslUncPath,
  probeWsl,
  resolveAgentWatchTargets,
  isLinuxCwd,
  isWslUnc,
  toWindowsReadablePath,
  toLinuxCwd,
  isWslBackedSession
};
