const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  springOmega,
  stepSpringAxis,
  isSpringSettled,
  clampFrameDt
} = require('../src/main/lib/notch-motion');

describe('notch-motion springs', () => {
  it('maps response to ω = 2π / response', () => {
    assert.ok(Math.abs(springOmega(0.4) - (2 * Math.PI) / 0.4) < 1e-9);
  });

  it('rejects non-positive response', () => {
    assert.throws(() => springOmega(0), /positive/);
    assert.throws(() => springOmega(-1), /positive/);
  });

  it('settles on the target without overshoot when critically damped', () => {
    const omega = springOmega(0.4);
    let pos = 40;
    let vel = 0;
    const target = 560;
    let maxPos = pos;
    for (let i = 0; i < 240; i++) {
      const next = stepSpringAxis(pos, vel, target, 1 / 120, omega, 1);
      pos = next.pos;
      vel = next.vel;
      if (pos > maxPos) maxPos = pos;
    }
    assert.ok(isSpringSettled(pos, vel, target, 0.6, 10));
    assert.ok(maxPos <= target + 0.75, `overshot to ${maxPos}`);
  });

  it('carries velocity through a mid-flight retarget (no brick wall)', () => {
    const omega = springOmega(0.4);
    let pos = 40;
    let vel = 0;
    let target = 560;
    for (let i = 0; i < 20; i++) {
      const next = stepSpringAxis(pos, vel, target, 1 / 120, omega, 1);
      pos = next.pos;
      vel = next.vel;
    }
    assert.ok(vel > 0, 'should be moving toward expand');
    const velAtInterrupt = vel;
    target = 40;
    const next = stepSpringAxis(pos, vel, target, 1 / 120, omega, 1);
    // Velocity is blended by the damper, not zeroed — first frame after
    // reverse still travels in the old direction (momentum), then turns.
    assert.ok(next.vel > 0, 'first reverse frame must inherit expand velocity');
    assert.ok(next.vel < velAtInterrupt, 'damper must start bleeding speed');
  });

  it('clamps runaway frame deltas', () => {
    assert.equal(clampFrameDt(0), 1 / 1000);
    assert.ok(clampFrameDt(2) <= 1 / 30 + 1e-9);
    assert.ok(clampFrameDt(0.008) > 0.007);
  });
});
