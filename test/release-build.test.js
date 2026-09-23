const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planReleaseBuild, resolveTarget } = require('../scripts/release-build');

describe('release build signing', () => {
  it('resolves the host platform when no target is passed', () => {
    assert.equal(resolveTarget(undefined, 'win32'), 'win');
    assert.equal(resolveTarget(undefined, 'darwin'), 'mac');
    assert.equal(resolveTarget(undefined, 'linux'), 'linux');
    assert.equal(resolveTarget('mac', 'win32'), 'mac');
    assert.throws(() => resolveTarget('ios'), /Unknown build target/);
  });

  it('builds Windows unsigned when no certificate is set', () => {
    const source = { PATH: 'kept', APPLE_ID: '' };
    const plan = planReleaseBuild('win', source);
    assert.equal(plan.signed, false);
    assert.deepEqual(plan.args, ['--win', '--publish', 'never']);
    assert.equal(plan.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.equal(plan.env.WIN_CSC_LINK, undefined);
    assert.equal(plan.env.PATH, 'kept');
    assert.equal(source.PATH, 'kept');
  });

  it('gives Windows only the Windows certificate', () => {
    const plan = planReleaseBuild('win', {
      WIN_CSC_LINK: 'win.pfx',
      WIN_CSC_KEY_PASSWORD: 'win-secret',
      MAC_CSC_LINK: 'mac.p12',
      MAC_CSC_KEY_PASSWORD: 'mac-secret',
      CSC_LINK: 'generic.pfx',
      APPLE_ID: 'dev@example.com'
    });
    assert.equal(plan.signed, true);
    assert.equal(plan.env.WIN_CSC_LINK, 'win.pfx');
    assert.equal(plan.env.WIN_CSC_KEY_PASSWORD, 'win-secret');
    assert.equal(plan.env.CSC_LINK, undefined);
    assert.equal(plan.env.MAC_CSC_LINK, undefined);
    assert.equal(plan.env.APPLE_ID, undefined);
    assert.equal(plan.env.CSC_IDENTITY_AUTO_DISCOVERY, undefined);
  });

  it('uses a lone CSC_LINK for the platform being built', () => {
    const win = planReleaseBuild('win', { CSC_LINK: 'only.pfx', CSC_KEY_PASSWORD: 'pw' });
    assert.equal(win.signed, true);
    assert.equal(win.env.WIN_CSC_LINK, 'only.pfx');
    assert.equal(win.env.WIN_CSC_KEY_PASSWORD, 'pw');

    const mac = planReleaseBuild('mac', { CSC_LINK: 'only.p12', CSC_KEY_PASSWORD: 'pw' });
    assert.equal(mac.signed, true);
    assert.equal(mac.env.CSC_LINK, 'only.p12');
    assert.equal(mac.args.includes('-c.mac.identity=null'), false);
  });

  it('does not sign macOS with a Windows certificate', () => {
    const plan = planReleaseBuild('mac', {
      WIN_CSC_LINK: 'win.pfx',
      APPLE_ID: 'dev@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
      APPLE_TEAM_ID: ''
    });
    assert.equal(plan.signed, false);
    assert.equal(plan.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.ok(plan.args.includes('-c.mac.identity=null'));
    assert.equal(plan.env.APPLE_ID, undefined);
    assert.equal(plan.env.CSC_LINK, undefined);
  });

  it('keeps Apple notarization credentials only for a signed mac build', () => {
    const plan = planReleaseBuild('mac', {
      MAC_CSC_LINK: 'mac.p12',
      MAC_CSC_KEY_PASSWORD: 'mac-secret',
      WIN_CSC_LINK: 'win.pfx',
      APPLE_ID: 'dev@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
      APPLE_TEAM_ID: 'TEAMID',
      APPLE_API_KEY: ''
    });
    assert.equal(plan.signed, true);
    assert.equal(plan.env.CSC_LINK, 'mac.p12');
    assert.equal(plan.env.CSC_KEY_PASSWORD, 'mac-secret');
    assert.equal(plan.env.WIN_CSC_LINK, undefined);
    assert.equal(plan.env.APPLE_ID, 'dev@example.com');
    assert.equal(plan.env.APPLE_APP_SPECIFIC_PASSWORD, 'app-password');
    assert.equal(plan.env.APPLE_TEAM_ID, 'TEAMID');
    assert.equal(plan.env.APPLE_API_KEY, undefined);
    assert.equal(plan.args.includes('-c.mac.identity=null'), false);
  });

  it('never signs the Linux build', () => {
    const plan = planReleaseBuild('linux', {
      WIN_CSC_LINK: 'win.pfx',
      MAC_CSC_LINK: 'mac.p12',
      APPLE_ID: 'dev@example.com'
    });
    assert.equal(plan.signed, false);
    assert.deepEqual(plan.args, ['--linux', '--publish', 'never']);
    assert.equal(plan.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.equal(plan.env.WIN_CSC_LINK, undefined);
    assert.equal(plan.env.MAC_CSC_LINK, undefined);
    assert.equal(plan.env.APPLE_ID, undefined);
  });
});
