/**
 * Critically damped notch springs — Apple "response + damping ratio"
 * mapped to a second-order ODE. No overshoot at damping = 1.0
 * (Windows setBounds jitter + product Calm personality).
 *
 * ω = 2π / response
 * x'' + 2ζω x' + ω² x = 0
 */

function springOmega(responseSec) {
  const response = Number(responseSec);
  if (!Number.isFinite(response) || response <= 0) {
    throw new RangeError('spring response must be a positive number of seconds');
  }
  return (2 * Math.PI) / response;
}

/**
 * Integrate one 1-D spring step.
 * @returns {{ pos: number, vel: number }}
 */
function stepSpringAxis(pos, vel, target, dtSec, omega, zeta = 1) {
  const dt = Math.min(Math.max(Number(dtSec) || 0, 0), 1 / 30);
  const x = pos - target;
  const acc = -omega * omega * x - 2 * zeta * omega * vel;
  const nextVel = vel + acc * dt;
  const nextPos = pos + nextVel * dt;
  return { pos: nextPos, vel: nextVel };
}

function isSpringSettled(pos, vel, target, posEps = 0.5, velEps = 8) {
  return Math.abs(pos - target) < posEps && Math.abs(vel) < velEps;
}

/** Clamp a frame delta so a stalled tick cannot explode the integrator. */
function clampFrameDt(dtSec) {
  return Math.min(Math.max(Number(dtSec) || 0, 1 / 1000), 1 / 30);
}

module.exports = {
  springOmega,
  stepSpringAxis,
  isSpringSettled,
  clampFrameDt
};
