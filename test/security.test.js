const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateSessionId,
  validateHistoryId,
  validateFocusAgentName,
  normalizeDispatchPrompt,
  sanitizeWslDistro,
  sanitizeHotkey,
  clampPollInterval,
  isOverbroadRoot,
  sanitizeConfigurablePath,
  sanitizeAgentRoots,
  resolveOpenableDirectory,
  writePrivateFile,
  assertNotSymlink,
  quoteCmdExeArg,
  buildCmdExeInvoke,
  tryResolveNpmCmdShim,
  planWindowsCliLaunch,
  isAppRendererUrl,
  rendererIndexPath,
  assertTrustedIpcSender,
  MAX_PROMPT_CHARS,
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  MAX_POLL_MS
} = require('../src/main/security/security');

describe('validateSessionId', () => {
  it('accepts watcher-style ids', () => {
    assert.equal(
      validateSessionId('claude-123e4567-e89b-42d3-a456-426614174000'),
      'claude-123e4567-e89b-42d3-a456-426614174000'
    );
    assert.equal(validateSessionId('codex-rollout-abc.def'), 'codex-rollout-abc.def');
    assert.equal(validateSessionId('claude-pending-123e4567-e89b-42d3-a456-426614174000').startsWith('claude-pending-'), true);
  });

  it('rejects path traversal and injection', () => {
    assert.throws(() => validateSessionId('../etc/passwd'), /Invalid session id/);
    assert.throws(() => validateSessionId('claude-abc & whoami'), /Invalid session id/);
    assert.throws(() => validateSessionId('claude-abc;rm -rf /'), /Invalid session id/);
    assert.throws(() => validateSessionId(''), /Invalid session id/);
    assert.throws(() => validateSessionId(null), /Invalid session id/);
  });
});

describe('validateHistoryId', () => {
  it('accepts session-like and short archive ids', () => {
    assert.equal(validateHistoryId('claude-abc'), 'claude-abc');
    assert.equal(validateHistoryId('a1'), 'a1');
  });

  it('rejects separators and spaces', () => {
    assert.throws(() => validateHistoryId('..\\windows'), /Invalid history id/);
    assert.throws(() => validateHistoryId('id with space'), /Invalid history id/);
    assert.throws(() => validateHistoryId(''), /Invalid history id/);
  });
});

describe('validateFocusAgentName', () => {
  it('allowlists known harnesses', () => {
    assert.equal(validateFocusAgentName('Claude Code'), 'Claude Code');
    assert.equal(validateFocusAgentName('OpenCode'), 'OpenCode');
  });

  it('rejects unknown names', () => {
    assert.throws(() => validateFocusAgentName('cmd.exe'), /Invalid agent name/);
    assert.throws(() => validateFocusAgentName('Claude'), /Invalid agent name/);
  });
});

describe('normalizeDispatchPrompt', () => {
  it('allows empty and typical prompts', () => {
    assert.equal(normalizeDispatchPrompt(''), '');
    assert.equal(normalizeDispatchPrompt('fix the bug & ship it'), 'fix the bug & ship it');
    assert.equal(normalizeDispatchPrompt(null), '');
  });

  it('rejects non-strings and oversize', () => {
    assert.throws(() => normalizeDispatchPrompt({ x: 1 }), /Invalid dispatch prompt/);
    assert.throws(() => normalizeDispatchPrompt('x'.repeat(MAX_PROMPT_CHARS + 1)), /too long/);
  });
});

describe('settings sanitizers', () => {
  it('accepts a real WSL distro name and drops shell junk', () => {
    assert.equal(sanitizeWslDistro('Ubuntu-22.04'), 'Ubuntu-22.04');
    assert.equal(sanitizeWslDistro('Ubuntu; calc.exe'), '');
    assert.equal(sanitizeWslDistro(''), '');
  });

  it('accepts Electron accelerators and rejects junk', () => {
    assert.equal(sanitizeHotkey('Control+Shift+A'), 'Control+Shift+A');
    assert.equal(sanitizeHotkey('CommandOrControl+Alt+F12'), 'CommandOrControl+Alt+F12');
    assert.equal(sanitizeHotkey(''), '');
    assert.equal(sanitizeHotkey('A'), '');
    assert.equal(sanitizeHotkey('Control+Shift+A & calc'), '');
    assert.equal(sanitizeHotkey('Control+Shift+\nA'), '');
  });

  it('clamps poll interval', () => {
    assert.equal(clampPollInterval(3000), 3000);
    assert.equal(clampPollInterval(0), MIN_POLL_MS);
    assert.equal(clampPollInterval(999999), MAX_POLL_MS);
    assert.equal(clampPollInterval('nope'), DEFAULT_POLL_MS);
  });

  it('rejects drive roots and URLs as configurable paths', () => {
    assert.equal(isOverbroadRoot(path.parse(process.cwd()).root), true);
    assert.equal(sanitizeConfigurablePath('https://evil.example/x'), '');
    assert.equal(sanitizeConfigurablePath('file:///C:/Windows/System32'), '');
    assert.ok(sanitizeConfigurablePath(os.homedir()).length > 0);
    assert.equal(sanitizeConfigurablePath('ok\0bad'), '');
  });

  it('sanitizes agent root maps without prototype keys', () => {
    const out = sanitizeAgentRoots({
      claude: os.homedir(),
      extra: '/tmp',
      __proto__: { polluted: true }
    });
    assert.equal(out.claude, os.homedir());
    assert.equal(out.codex, '');
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'extra'), false);
  });
});

describe('resolveOpenableDirectory', () => {
  let dir;
  let file;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-open-'));
    file = path.join(dir, 'payload.exe');
    fs.writeFileSync(file, 'not-an-exe');
  });

  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('allows a real directory', () => {
    const res = resolveOpenableDirectory(dir);
    assert.equal(res.ok, true);
    assert.equal(res.path, path.resolve(dir));
  });

  it('refuses files so openPath cannot execute them', () => {
    const res = resolveOpenableDirectory(file);
    assert.equal(res.ok, false);
    assert.match(res.message, /folders/i);
  });

  it('refuses URLs and empty input', () => {
    assert.equal(resolveOpenableDirectory('https://example.com').ok, false);
    assert.equal(resolveOpenableDirectory('').ok, false);
    assert.equal(resolveOpenableDirectory(null).ok, false);
  });
});

describe('writePrivateFile', () => {
  it('writes a file and refuses to follow an existing symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-priv-'));
    const target = path.join(dir, 'secret.txt');
    const dest = path.join(dir, 'settings.json');
    fs.writeFileSync(target, 'keep-me');
    try {
      fs.symlinkSync(target, dest);
    } catch {
      // Windows without Developer Mode cannot create file symlinks
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    assert.throws(() => writePrivateFile(dest, 'pwned'), /symlink/i);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep-me');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('assertNotSymlink is a no-op when the path is missing', () => {
    assert.equal(assertNotSymlink(path.join(os.tmpdir(), 'agent-notch-missing-nope.json')), undefined);
  });
});

describe('Windows CLI launch planning', () => {
  it('quotes cmd metacharacters so they stay inside one argument', () => {
    const q = quoteCmdExeArg('say "hi" & calc.exe');
    assert.equal(q.startsWith('"'), true);
    assert.equal(q.endsWith('"'), true);
    assert.ok(q.includes('""hi""'));
    assert.ok(q.includes('&'));
  });

  it('builds cmd /d /s /c with an outer quote pair', () => {
    const planned = buildCmdExeInvoke('C:\\npm\\claude.cmd', ['-p', 'fix & calc']);
    assert.match(planned.file, /cmd\.exe$/i);
    assert.deepEqual(planned.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(planned.args[3].startsWith('"'), true);
    assert.equal(planned.args[3].endsWith('"'), true);
    assert.equal(planned.spawnOpts.windowsVerbatimArguments, true);
    assert.equal(planned.spawnOpts.shell, false);
  });

  it('resolves an npm .cmd shim to node + the js entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-shim-'));
    const jsRel = path.join('node_modules', 'fake-cli', 'cli.js');
    const jsPath = path.join(dir, jsRel);
    fs.mkdirSync(path.dirname(jsPath), { recursive: true });
    fs.writeFileSync(jsPath, 'console.log("ok")');
    const cmdPath = path.join(dir, 'claude.cmd');
    fs.writeFileSync(cmdPath, [
      '@ECHO off',
      'SETLOCAL',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${jsRel}" %*`
    ].join('\r\n'));

    const shim = tryResolveNpmCmdShim(cmdPath);
    assert.ok(shim);
    assert.equal(shim.prefixArgs[0], path.normalize(jsPath));

    const planned = planWindowsCliLaunch({ file: cmdPath, viaCmd: true }, ['-p', 'x & y']);
    assert.deepEqual(planned.args.slice(-2), ['-p', 'x & y']);
    assert.equal(planned.args[0], path.normalize(jsPath));
    assert.equal(planned.spawnOpts.shell, false);
    assert.equal(planned.spawnOpts.windowsVerbatimArguments, undefined);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves an npm .cmd shim that launches a nested .exe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-shimexe-'));
    const exeRel = path.join('node_modules', 'fake-cli', 'bin', 'tool.exe');
    const exePath = path.join(dir, exeRel);
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, 'MZ');
    const cmdPath = path.join(dir, 'opencode.cmd');
    fs.writeFileSync(cmdPath, `"%dp0%\\${exeRel}"   %*\r\n`);

    const shim = tryResolveNpmCmdShim(cmdPath);
    assert.ok(shim);
    assert.equal(shim.file, path.normalize(exePath));
    assert.deepEqual(shim.prefixArgs, []);

    const planned = planWindowsCliLaunch({ file: cmdPath, viaCmd: true }, ['run', 'x & y']);
    assert.equal(planned.file, path.normalize(exePath));
    assert.deepEqual(planned.args, ['run', 'x & y']);
    assert.equal(planned.spawnOpts.shell, false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes argv through when the CLI is a real .exe', () => {
    const planned = planWindowsCliLaunch(
      { file: 'C:\\tools\\claude.exe', viaCmd: false },
      ['-p', 'a & b']
    );
    assert.equal(planned.file, 'C:\\tools\\claude.exe');
    assert.deepEqual(planned.args, ['-p', 'a & b']);
    assert.equal(planned.spawnOpts.shell, false);
  });
});

describe('isAppRendererUrl', () => {
  it('accepts only the local renderer index.html', () => {
    const { pathToFileURL } = require('url');
    const ok = pathToFileURL(rendererIndexPath()).href;
    assert.equal(isAppRendererUrl(ok), true);
    assert.equal(isAppRendererUrl('https://example.com'), false);
    assert.equal(isAppRendererUrl('file:///C:/Windows/System32/calc.exe'), false);
  });
});

describe('assertTrustedIpcSender', () => {
  it('requires the event to come from the main window', () => {
    const sender = { id: 1 };
    const win = { isDestroyed: () => false, webContents: sender };
    assert.equal(assertTrustedIpcSender({ sender }, win), undefined);
    assert.throws(() => assertTrustedIpcSender({ sender: { id: 2 } }, win), /Unauthorized/);
    assert.throws(() => assertTrustedIpcSender({ sender }, { isDestroyed: () => true, webContents: sender }), /not available/);
  });
});
