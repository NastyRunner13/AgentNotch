'use strict';

/**
 * Build the current platform installer.
 *
 * Signing is env-driven so a laptop keychain is never picked up by accident,
 * and a Windows certificate is never handed to the macOS build:
 *   WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD  — Windows Authenticode
 *   MAC_CSC_LINK / MAC_CSC_KEY_PASSWORD  — Apple Developer ID
 *   CSC_LINK / CSC_KEY_PASSWORD          — used only when it is the only cert
 *   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *     or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER — notarize a signed mac build
 */

const { spawnSync } = require('child_process');

const APPLE_KEYS = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER'
];

const SIGNING_KEYS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'MAC_CSC_LINK',
  'MAC_CSC_KEY_PASSWORD',
  'CSC_IDENTITY_AUTO_DISCOVERY',
  ...APPLE_KEYS
];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function resolveTarget(arg, platform = process.platform) {
  if (arg === 'win' || arg === 'mac' || arg === 'linux') return arg;
  if (arg) throw new Error(`Unknown build target: ${arg}`);
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

/**
 * Pick the certificate that belongs to this target.
 * A Windows cert and a macOS cert may both be present in CI. Each build
 * may see only its own.
 */
function certFor(target, env) {
  if (target === 'win') {
    const win = nonEmpty(env.WIN_CSC_LINK);
    if (win) {
      return { link: win, password: nonEmpty(env.WIN_CSC_KEY_PASSWORD) || nonEmpty(env.CSC_KEY_PASSWORD) };
    }
    if (!nonEmpty(env.MAC_CSC_LINK)) {
      const generic = nonEmpty(env.CSC_LINK);
      if (generic) return { link: generic, password: nonEmpty(env.CSC_KEY_PASSWORD) };
    }
    return null;
  }
  if (target === 'mac') {
    const mac = nonEmpty(env.MAC_CSC_LINK);
    if (mac) {
      return { link: mac, password: nonEmpty(env.MAC_CSC_KEY_PASSWORD) || nonEmpty(env.CSC_KEY_PASSWORD) };
    }
    if (!nonEmpty(env.WIN_CSC_LINK)) {
      const generic = nonEmpty(env.CSC_LINK);
      if (generic) return { link: generic, password: nonEmpty(env.CSC_KEY_PASSWORD) };
    }
    return null;
  }
  return null;
}

function planReleaseBuild(target, sourceEnv) {
  if (target !== 'win' && target !== 'mac' && target !== 'linux') {
    throw new Error(`Unknown build target: ${target}`);
  }
  const env = { ...sourceEnv };
  for (const key of SIGNING_KEYS) delete env[key];

  const args = [`--${target}`, '--publish', 'never'];
  const cert = certFor(target, sourceEnv);
  if (!cert) {
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    if (target === 'mac') args.push('-c.mac.identity=null');
    return { args, env, signed: false };
  }

  if (target === 'win') {
    env.WIN_CSC_LINK = cert.link;
    if (cert.password) env.WIN_CSC_KEY_PASSWORD = cert.password;
    return { args, env, signed: true };
  }

  env.CSC_LINK = cert.link;
  if (cert.password) env.CSC_KEY_PASSWORD = cert.password;
  for (const key of APPLE_KEYS) {
    const value = nonEmpty(sourceEnv[key]);
    if (value) env[key] = value;
  }
  return { args, env, signed: true };
}

function main() {
  const target = resolveTarget(process.argv[2]);
  const plan = planReleaseBuild(target, process.env);
  const cli = require.resolve('electron-builder/cli.js');
  const result = spawnSync(process.execPath, [cli, ...plan.args], {
    stdio: 'inherit',
    env: plan.env
  });
  process.exit(result.status == null ? 1 : result.status);
}

if (require.main === module) main();

module.exports = {
  certFor,
  planReleaseBuild,
  resolveTarget
};
