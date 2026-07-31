const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  limitLevel,
  pickCritLimit,
  detectLimitCrossings,
  LIMIT_WARN_PERCENT,
  LIMIT_CRIT_PERCENT
} = require('../src/main/usage-limits');

describe('limitLevel', () => {
  it('returns null for missing values', () => {
    assert.equal(limitLevel(null), null);
    assert.equal(limitLevel(undefined), null);
    assert.equal(limitLevel(NaN), null);
  });

  it('maps bands at thresholds', () => {
    assert.equal(limitLevel(LIMIT_WARN_PERCENT - 1), 'ok');
    assert.equal(limitLevel(LIMIT_WARN_PERCENT), 'warn');
    assert.equal(limitLevel(LIMIT_CRIT_PERCENT - 1), 'warn');
    assert.equal(limitLevel(LIMIT_CRIT_PERCENT), 'crit');
    assert.equal(limitLevel(100), 'crit');
  });
});

describe('pickCritLimit', () => {
  it('picks highest crit agent', () => {
    const items = [
      { id: 'a', available: true, usedPercent: 90, short: 'A' },
      { id: 'b', available: true, usedPercent: 95, short: 'B' },
      { id: 'c', available: true, usedPercent: 70, short: 'C' },
      { id: 'd', available: false, usedPercent: 99, short: 'D' }
    ];
    const best = pickCritLimit(items);
    assert.equal(best.id, 'b');
  });

  it('returns null when nothing is crit', () => {
    assert.equal(pickCritLimit([{ id: 'a', available: true, usedPercent: 50 }]), null);
  });
});

describe('detectLimitCrossings', () => {
  it('fires once per agent/window/band', () => {
    const state = new Map();
    const prev = [{ id: 'codex', available: true, usedPercent: 50, resetsAt: 100 }];
    const cur = [{ id: 'codex', short: 'Codex', name: 'Codex', available: true, usedPercent: 90, resetsAt: 100 }];

    const first = detectLimitCrossings(cur, prev, state, { notifyCrit: true, notifyWarn: false });
    assert.equal(first.length, 1);
    assert.equal(first[0].band, 'crit');
    assert.equal(first[0].usedPercent, 90);

    const second = detectLimitCrossings(cur, cur, state, { notifyCrit: true });
    assert.equal(second.length, 0);
  });

  it('respects notifyCrit off', () => {
    const state = new Map();
    const cur = [{ id: 'grok', short: 'Grok', available: true, usedPercent: 92, resetsAt: 1 }];
    const alerts = detectLimitCrossings(cur, null, state, { notifyCrit: false, notifyWarn: false });
    assert.equal(alerts.length, 0);
  });

  it('can notify warn when enabled', () => {
    const state = new Map();
    const prev = [{ id: 'codex', available: true, usedPercent: 10, resetsAt: 0 }];
    const cur = [{ id: 'codex', short: 'Codex', available: true, usedPercent: 65, resetsAt: 0 }];
    const alerts = detectLimitCrossings(cur, prev, state, { notifyCrit: false, notifyWarn: true });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].band, 'warn');
  });
});
