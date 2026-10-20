import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCandidate, gridPoints, scoreRun } from '../src/core/tuning.js';

test('gridPoints expands the threshold grid as a cartesian product', () => {
  const points = gridPoints({ minRelevance: [0.1, 0.12], minCoverage: [0.3, 0.4, 0.5] });
  assert.equal(points.length, 6);
  assert.deepEqual(points[0], { minRelevance: 0.1, minCoverage: 0.3 });
  assert.ok(points.every((point) => typeof point.minRelevance === 'number'));
});

test('gridPoints ignores empty and non-numeric axes and de-duplicates values', () => {
  const points = gridPoints({ minScore: [0.1, 0.1, 'x', null], minCoverage: [] });
  assert.deepEqual(points, [{ minScore: 0.1 }]);
  assert.deepEqual(gridPoints({}), [{}]);
});

test('chooseCandidate only accepts points that never regress hit or false injects', () => {
  const baseline = { hit: 10, falseInjects: 2 };
  const evaluated = [
    { point: { minCoverage: 0.4 }, hit: 11, falseInjects: 3 }, // 命中多了，但误注入也多了
    { point: { minCoverage: 0.33 }, hit: 10, falseInjects: 2 }, // 完全一样
    { point: { minCoverage: 0.5 }, hit: 11, falseInjects: 1 }, // 严格更好
    { point: { minCoverage: 0.6 }, hit: 9, falseInjects: 0 }, // 命中退化
  ];
  const pick = chooseCandidate(baseline, evaluated);
  assert.equal(pick.hit, 11);
  assert.equal(pick.falseInjects, 1);
  assert.equal(pick.point.minCoverage, 0.5);
});

test('chooseCandidate breaks ties by lower false injects and more conservative coverage', () => {
  const baseline = { hit: 10, falseInjects: 3 };
  const evaluated = [
    { point: { minCoverage: 0.33 }, hit: 11, falseInjects: 2 },
    { point: { minCoverage: 0.5 }, hit: 11, falseInjects: 2 },
  ];
  assert.equal(chooseCandidate(baseline, evaluated).point.minCoverage, 0.5);
});

test('chooseCandidate returns null when nothing improves', () => {
  assert.equal(chooseCandidate({ hit: 10, falseInjects: 1 }, [{ point: {}, hit: 10, falseInjects: 1 }]), null);
  assert.equal(chooseCandidate({ hit: 0, falseInjects: 0 }, []), null);
});

test('scoreRun counts hits on source tasks and false injects on refusal tasks', () => {
  const tasks = [
    { id: 'f01', source: ['note-a.md'] },
    { id: 'f02', source: ['note-b.md'] },
    { id: 'r01' },
    { id: 'r02' },
  ];
  const runs = [
    { task_id: 'f01', hits: [{ id: 'note-a' }] },
    { task_id: 'f02', hits: [{ id: 'note-c' }] },
    { task_id: 'r01', hits: [{ id: 'note-z' }] },
    { task_id: 'r02', hits: [] },
  ];
  const score = scoreRun({ tasks, runs, k: 5 });
  assert.deepEqual(score, { hit: 1, positives: 2, refusals: 2, falseInjects: 1 });
});
