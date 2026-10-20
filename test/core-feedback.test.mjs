import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFeedback, feedbackWeight, rankItemsByScore } from '../src/core/feedback.js';
import { decayWeight, normalizeDecay } from '../src/core/decay.js';

const NOW = Date.parse('2026-10-21T00:00:00+08:00');
const DAY = 24 * 60 * 60 * 1000;

test('feedback aggregation honours the window, signals and both id shapes', () => {
  const rows = [
    { id: 'a', signal: 'useful', at: NOW - 1 * DAY },
    { id: 'a', signal: 'useful', at: NOW - 2 * DAY },
    { id: 'a', signal: 'wrong', at: NOW - 3 * DAY },
    { noteIds: ['a', 'b'], signal: 'corrected', at: NOW - 4 * DAY },
    { id: 'b', signal: 'stale', at: NOW - 200 * DAY },
    { id: 'c', signal: 'invented', at: NOW },
    { id: 'd', signal: 'useful', at: NOW - 100 * DAY },
  ];
  const map = aggregateFeedback(rows, { days: 30, now: NOW });
  assert.deepEqual(map.get('a'), { useful: 2, wrong: 1, stale: 0, corrected: 1 });
  assert.deepEqual(map.get('b'), { useful: 0, wrong: 0, stale: 0, corrected: 1 });
  assert.equal(map.has('c'), false);
  assert.equal(map.has('d'), false, 'outside the window');
});

test('feedback weight is capped and asymmetric', () => {
  assert.equal(feedbackWeight(undefined), 1);
  assert.equal(feedbackWeight({ useful: 99 }), 1.09);
  assert.equal(feedbackWeight({ wrong: 99 }), 0.52);
  assert.equal(feedbackWeight({ wrong: 1, stale: 1 }), 0.76);
  assert.equal(feedbackWeight({ corrected: 99 }), 0.76);
});

test('ranking is a stable sort on the supplied score', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ranked = rankItemsByScore(items, (item) => ({ a: 1, b: 3, c: 1 }[item.id]));
  assert.deepEqual(ranked.map((i) => i.id), ['b', 'a', 'c']);
});

test('decay fades old notes but never retires them', () => {
  const fresh = { id: 'x', valid_from: new Date(NOW).toISOString() };
  assert.equal(decayWeight(fresh, { now: NOW }), 1);
  const year = { id: 'y', valid_from: new Date(NOW - 365 * DAY).toISOString() };
  assert.equal(decayWeight(year, { now: NOW }), 0.6, 'floor applies at one year with 180d half-life');
  assert.ok(Math.abs(decayWeight(year, { now: NOW, halfLifeDays: 3650, floor: 0 }) - 0.5 ** 0.1) < 1e-9);
  assert.equal(decayWeight({ id: 'z', trust: 'user_stated', valid_from: new Date(NOW - 999 * DAY).toISOString() }, { now: NOW }), 1);
  assert.equal(decayWeight({ id: 'e', evergreen: true }, { now: NOW }), 1);
});

test('decay options are validated instead of silently producing NaN weights', () => {
  assert.equal(normalizeDecay(false), null);
  assert.equal(normalizeDecay({ halfLifeDays: 0 }), null);
  assert.deepEqual(normalizeDecay({ halfLifeDays: 90 }), { halfLifeDays: 90, floor: 0.6 });
  assert.deepEqual(normalizeDecay(30), { halfLifeDays: 180, floor: 0.6 });
  assert.deepEqual(normalizeDecay({ days: 10, floor: 5 }), { halfLifeDays: 10, floor: 1 });
});
