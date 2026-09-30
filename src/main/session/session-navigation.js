const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { parseTaggedSessionId } = require('../watchers/session-utils');

const AGENTS = {
  'Claude Code': { prefix: 'claude', bin: 'claude', args: id => ['--resume', id] },
  Codex: { prefix: 'codex', bin: 'codex', args: id => ['resume', id] },
  Grok: { prefix: 'grok', bin: 'grok', args: id => ['-r', id] },
  OpenCode: { prefix: 'opencode', bin: 'opencode', args: id => ['--session', id] }
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function sessionNavigation(session, { platform = process.platform, wsl = null, preferTerminal = false } = {}) {
  const fallback = { kind: 'app', label: 'Open app', exact: false,
    hint: 'Opens the agent app. Select this conversation there; its original tab is not available.' };
  const spec = AGENTS[session?.agent];
  if (!spec || !session.id?.startsWith(spec.prefix + '-')) return fallback;
  const parsed = parseTaggedSessionId(session.id, spec.prefix);
  let id = session.resumeId || parsed.nativeId;
  if (session.agent === 'Codex' && !session.resumeId) id = String(id).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,219}$/.test(id) || id.includes('pending-')) return fallback;
  const cwd = typeof session.cwd === 'string' ? session.cwd : '';
  // Read the distribution from the actual source, rather than guessing which
  // WSL distribution owns a native session ID.
  const unc = String(session.sourceRoot || cwd).replace(/\//g, '\\').match(/^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\/i);
  const isWsl = platform === 'win32' && (Boolean(unc) || session.sourceTag === 'wsl' || parsed.sourceTag === 'wsl' || cwd.startsWith('/'));
  const distro = unc?.[1] || (isWsl ? wsl?.distro : '');
  const command = `${spec.bin} ${spec.args(id).join(' ')}`;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const sourceRoot = session.sourceRoot;
  const env = {};
  if (sourceRoot && (session.agent === 'Codex' || session.agent === 'Claude Code')) {
    let configRoot = (unc ? path.win32 : paths).dirname(sourceRoot);
    if (unc) configRoot = '/' + configRoot.replace(/^\\\\wsl(?:\$|\.localhost)\\[^\\]+\\/i, '').replace(/\\/g, '/');
    env[session.agent === 'Codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = configRoot;
  }
  const standardCodexRoot = paths.join(process.env.CODEX_HOME || paths.join(os.homedir(), '.codex'), 'sessions');
  const sameRoot = !sourceRoot || (platform === 'win32' ? paths.normalize(sourceRoot).toLowerCase() === paths.normalize(standardCodexRoot).toLowerCase() : paths.normalize(sourceRoot) === paths.normalize(standardCodexRoot));
  const canResume = Boolean(!session.trackingUnavailable && session.status === 'idle' && cwd && !/[\x00-\x1f]/.test(cwd) &&
    (isWsl ? distro : paths.isAbsolute(cwd)));
  if (!preferTerminal && session.agent === 'Codex' && UUID.test(id) && !isWsl && sameRoot) {
    return { kind: 'thread', exact: true, label: 'Open session',
      hint: 'Opens this exact local chat in the Codex app.', uri: `codex://threads/${id}`, nativeId: id, command, canResume };
  }
  if (!canResume) return { ...fallback, nativeId: id, command };
  return { kind: 'resume', exact: true, label: 'Resume session', nativeId: id, command,
    hint: 'Resumes this conversation in a new terminal. No prompt is sent.',
    bin: spec.bin, args: spec.args(id), cwd, distro: distro || null, env };
}

const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
const shQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

// Commands come only from sessionNavigation, never from renderer arguments.
function terminalLaunch(target, platform = process.platform) {
  let { bin, args, cwd } = target;
  const env = Object.entries(target.env || {});
  if (target.distro && platform === 'win32') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(target.distro)) throw new Error('Invalid WSL distribution');
    const unc = cwd.replace(/\//g, '\\').match(/^\\\\wsl(?:\$|\.localhost)\\[^\\]+\\(.*)$/i);
    if (unc) cwd = '/' + unc[1].replace(/\\/g, '/');
    if (!cwd.startsWith('/') || cwd.startsWith('//')) throw new Error('Cannot resolve this session’s WSL folder');
    args = ['-d', target.distro, '--cd', cwd, '--', ...(env.length ? ['env', ...env.map(([key, value]) => `${key}=${value}`)] : []), bin, ...args];
    bin = 'wsl.exe';
  }
  if (platform === 'win32') {
    // Encode the entire PowerShell program. Paths and IDs remain literal even
    // with apostrophes, semicolons, dollar signs, or shell metacharacters.
    const script = (target.distro ? '' : env.map(([key, value]) => `$env:${key}=${psQuote(value)}; `).join('') + `Set-Location -LiteralPath ${psQuote(cwd)} -ErrorAction Stop; `) +
      `& ${[bin, ...args].map(psQuote).join(' ')}`;
    return { bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath powershell.exe -WindowStyle Normal -ArgumentList '-NoProfile','-NoExit','-EncodedCommand','${Buffer.from(script, 'utf16le').toString('base64')}'`] };
  }
  const command = `cd ${shQuote(cwd)} && ${[...(env.length ? ['env', ...env.map(([key, value]) => `${key}=${value}`)] : []), bin, ...args].map(shQuote).join(' ')}`;
  if (platform === 'darwin') {
    const literal = JSON.stringify(command);
    return { bin: 'osascript', args: ['-e', `tell application "Terminal"\nactivate\ndo script ${literal}\nend tell`] };
  }
  return { bin: 'x-terminal-emulator', args: ['-e', 'sh', '-c', command] };
}

async function openSessionTarget(target, { openExternal, launch = spawn, platform = process.platform } = {}) {
  if (target.kind === 'thread') {
    await openExternal(target.uri);
    return { success: true, exact: true, message: 'Opened this session link in Codex.' };
  }
  if (target.kind !== 'resume') throw new Error('An exact session target is unavailable');
  const cmd = terminalLaunch(target, platform);
  await new Promise((resolve, reject) => {
    const child = launch(cmd.bin, cmd.args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Could not open the session terminal. Check that the terminal is installed.')));
    // Linux terminals can remain alive for the lifetime of the session.
    if (platform === 'linux') child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { success: true, exact: true, message: 'Opened a terminal to resume this session. No prompt was sent.' };
}

module.exports = { sessionNavigation, terminalLaunch, openSessionTarget };
