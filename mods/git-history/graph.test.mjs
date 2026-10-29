import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph } from './graph.js';

test('empty and linear histories use zero and one lanes', () => {
  assert.deepEqual(layoutGraph([]), { cols: [], colors: [], segments: [], lanes: 0 });
  const graph = layoutGraph([{ hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }]);
  assert.deepEqual(graph.cols, [0, 0, 0]);
  assert.deepEqual(graph.colors, [0, 0, 0]);
  assert.equal(graph.lanes, 1);
  assert.deepEqual(graph.segments.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2]), [[0, 0, 0, 1], [0, 1, 0, 2]]);
});

test('merge graph joins each parent and retains branch lanes', () => {
  const nodes = [
    { hash: 'merge', parents: ['main', 'feature'] },
    { hash: 'feature', parents: ['root'] },
    { hash: 'main', parents: ['root'] },
    { hash: 'root', parents: [] },
  ];
  const graph = layoutGraph(nodes);
  assert.deepEqual(graph.cols, [0, 1, 0, 1]);
  assert.equal(graph.lanes, 2);
  for (let row = 0; row < nodes.length; row++) {
    for (const parent of nodes[row].parents) {
      const parentRow = nodes.findIndex(node => node.hash === parent);
      assert.ok(graph.segments.some(segment => segment.y1 === row && segment.x1 === graph.cols[row]));
      assert.ok(graph.segments.some(segment => segment.y2 === parentRow && segment.x2 === graph.cols[parentRow]));
    }
  }
  for (const segment of graph.segments) {
    assert.ok(segment.y2 > segment.y1);
    if (segment.x1 !== segment.x2) assert.equal(segment.y2 - segment.y1, 1);
  }
});

test('unloaded parents continue through the last loaded row', () => {
  const graph = layoutGraph([{ hash: 'c', parents: ['outside'] }, { hash: 'b', parents: [] }]);
  assert.ok(graph.segments.some(segment => segment.y2 === 2));
  assert.equal(graph.cols.length, 2);
});

test('octopus merges allocate distinct parent lanes without mutating nodes', () => {
  const nodes = [
    { hash: 'm', parents: ['a', 'b', 'c'] },
    { hash: 'c', parents: ['root'] },
    { hash: 'b', parents: ['root'] },
    { hash: 'a', parents: ['root'] },
    { hash: 'root', parents: [] },
  ];
  const original = JSON.stringify(nodes);
  const graph = layoutGraph(nodes);
  assert.equal(graph.lanes, 3);
  assert.equal(new Set(graph.cols.slice(1, 4)).size, 3);
  assert.equal(JSON.stringify(nodes), original);
});
