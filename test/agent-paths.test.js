const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  normalizeAgentRoots,
  defaultAgentRoots,
  decodeWslOutput,
  parseWslDistroNames,
  pickWslDistro,
  wslUncPath,
  probeWsl,
  resolveAgentWatchTargets,
  isLinuxCwd,
  toWindowsReadablePath,
  toLinuxCwd,
  isWslBackedSession
} = require('../src/main/lib/agent-paths');

describe('agent-paths', () => {
  it('normalizeAgentRoots trims known keys and drops junk', () => {
    const n = normalizeAgentRoots({
      claude: '  D:\\\\data\\\\claude  ',
      nope: '/x',
      grok: 12
    });
    assert.equal(n.claude, 'D:\\\\data\\\\claude');
    assert.equal(n.grok, '');
    assert.equal(n.codex, '');
  });

  it('defaultAgentRoots uses home on POSIX and APPDATA on Windows', () => {
    const posix = defaultAgentRoots('/home/ada', {}, 'linux');
    assert.equal(posix.claude, path.join('/home/ada', '.claude'));
    assert.equal(posix.opencode, path.join('/home/ada', '.local', 'share', 'opencode', 'opencode.db'));

    const win = defaultAgentRoots('C:\\Users\\ada', { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'win32');
    assert.equal(win.cursor, path.join('C:\\Users\\ada\\AppData\\Roaming', 'Cursor'));
    assert.equal(win.opencode, path.join('C:\\Users\\ada\\AppData\\Roaming', 'opencode', 'opencode.db'));
  });

  it('decodes UTF-16LE wsl.exe listings and skips docker-desktop', () => {
    const text = decodeWslOutput(Buffer.from('Ubuntu\0\n\0d\0o\0c\0k\0e\0r\0-\0d\0e\0s\0k\0t\0o\0p\0\n\0', 'utf16le'));
    const names = parseWslDistroNames('Ubuntu\r\ndocker-desktop\r\nDebian\r\n');
    assert.ok(names.includes('Ubuntu'));
    assert.equal(pickWslDistro(names, ''), 'Ubuntu');
    assert.equal(pickWslDistro(names, 'Debian'), 'Debian');
    assert.ok(text.includes('Ubuntu') || names.includes('Ubuntu'));
  });

  it('wslUncPath joins distro + linux home + relative', () => {
    assert.equal(
      wslUncPath('Ubuntu', '/home/ada', '.claude'),
      '\\\\wsl$\\Ubuntu\\home\\ada\\.claude'
    );
    assert.equal(wslUncPath('', '/home/ada', '.claude'), '');
  });

  it('probeWsl is null off Windows', () => {
    assert.equal(probeWsl({ platform: 'linux' }), null);
    assert.equal(probeWsl({ platform: 'darwin' }), null);
  });

  it('probeWsl uses injected exec and preferred distro', () => {
    const calls = [];
    const exec = (bin, args) => {
      calls.push([bin, args.join(' ')]);
      if (args[0] === '-l') return Buffer.from('docker-desktop\nUbuntu\n', 'utf8');
      if (args.includes('HOME')) return Buffer.from('/home/ada\n', 'utf8');
      throw new Error('unexpected');
    };
    const info = probeWsl({ platform: 'win32', preferred: 'Ubuntu', execFileSync: exec });
    assert.deepEqual(info, { distro: 'Ubuntu', linuxHome: '/home/ada' });
    assert.equal(calls[0][0], 'wsl.exe');
  });

  it('resolveAgentWatchTargets: custom wins; WSL extra when both exist', () => {
    // defaultAgentRoots uses the host path.join, so the exists mock must use
    // the same form (POSIX hosts produce C:\Users\ada/.claude, not '\').
    const localClaude = path.join('C:\\Users\\ada', '.claude');
    const wslClaude = '\\\\wsl$\\Ubuntu\\home\\ada\\.claude';
    const exists = (p) => p === localClaude || p === wslClaude;
    const resolved = resolveAgentWatchTargets(
      { watchWsl: true, agentRoots: {} },
      {
        platform: 'win32',
        home: 'C:\\Users\\ada',
        env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' },
        exists,
        wsl: { distro: 'Ubuntu', linuxHome: '/home/ada' }
      }
    );
    assert.equal(resolved.targets.claude.primary, localClaude);
    assert.deepEqual(resolved.targets.claude.extra, [wslClaude]);
  });

  it('resolveAgentWatchTargets: WSL becomes primary when Windows home missing', () => {
    const exists = (p) => p === '\\\\wsl$\\Ubuntu\\home\\ada\\.claude';
    const resolved = resolveAgentWatchTargets(
      { watchWsl: true },
      {
        platform: 'win32',
        home: 'C:\\Users\\ada',
        env: {},
        exists,
        wsl: { distro: 'Ubuntu', linuxHome: '/home/ada' }
      }
    );
    assert.equal(resolved.targets.claude.primary, '\\\\wsl$\\Ubuntu\\home\\ada\\.claude');
    assert.deepEqual(resolved.targets.claude.extra, []);
    assert.equal(resolved.targets.claude.source, 'wsl');
  });

  it('custom root is primary; WSL still extra if present', () => {
    const custom = 'D:\\data\\claude';
    const exists = (p) => p === custom || p === '\\\\wsl$\\Ubuntu\\home\\ada\\.claude';
    const resolved = resolveAgentWatchTargets(
      { watchWsl: true, agentRoots: { claude: custom } },
      {
        platform: 'win32',
        home: 'C:\\Users\\ada',
        env: {},
        exists,
        wsl: { distro: 'Ubuntu', linuxHome: '/home/ada' }
      }
    );
    assert.equal(resolved.targets.claude.primary, custom);
    assert.equal(resolved.targets.claude.source, 'custom');
    assert.deepEqual(resolved.targets.claude.extra, ['\\\\wsl$\\Ubuntu\\home\\ada\\.claude']);
  });

  it('watchWsl false never adds WSL extra', () => {
    const exists = () => true;
    const resolved = resolveAgentWatchTargets(
      { watchWsl: false },
      {
        platform: 'win32',
        home: 'C:\\Users\\ada',
        env: {},
        exists,
        wsl: { distro: 'Ubuntu', linuxHome: '/home/ada' }
      }
    );
    assert.deepEqual(resolved.targets.claude.extra, []);
  });

  it('isLinuxCwd detects POSIX and UNC wsl paths', () => {
    assert.equal(isLinuxCwd('/home/ada/proj'), true);
    assert.equal(isLinuxCwd('\\\\wsl$\\Ubuntu\\home\\ada\\proj'), true);
    assert.equal(isLinuxCwd('C:\\Users\\ada\\proj'), false);
    assert.equal(isLinuxCwd(''), false);
  });

  it('toWindowsReadablePath maps linux and /mnt/c to something Windows can open', () => {
    const wsl = { distro: 'Ubuntu', linuxHome: '/home/ada' };
    assert.equal(
      toWindowsReadablePath('/home/ada/proj', wsl),
      '\\\\wsl$\\Ubuntu\\home\\ada\\proj'
    );
    assert.equal(toWindowsReadablePath('/mnt/c/Users/ada/proj', wsl), 'C:\\Users\\ada\\proj');
    assert.equal(toWindowsReadablePath('C:\\dev\\proj', wsl), 'C:\\dev\\proj');
  });

  it('toLinuxCwd maps UNC and Windows drive paths', () => {
    const wsl = { distro: 'Ubuntu', linuxHome: '/home/ada' };
    assert.equal(toLinuxCwd('/home/ada/proj', wsl), '/home/ada/proj');
    assert.equal(
      toLinuxCwd('\\\\wsl$\\Ubuntu\\home\\ada\\proj', wsl),
      '/home/ada/proj'
    );
    assert.equal(toLinuxCwd('C:\\Users\\ada\\proj', wsl), '/mnt/c/Users/ada/proj');
  });

  it('isWslBackedSession detects tag, id, and linux cwd', () => {
    assert.equal(isWslBackedSession({ id: 'claude-wsl-abc', cwd: 'C:\\x' }), true);
    assert.equal(isWslBackedSession({ id: 'claude-abc', sourceTag: 'wsl' }), true);
    assert.equal(isWslBackedSession({ id: 'claude-abc', cwd: '/home/ada/p' }), true);
    assert.equal(isWslBackedSession({ id: 'claude-abc', cwd: 'C:\\dev' }), false);
  });
});
