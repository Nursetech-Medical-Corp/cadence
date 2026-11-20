import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isUnder, nestUnder, placeBeside, type Patch} from '../src/nesting.ts';

const T = ['Project', 'Phase', 'Task', 'Subtask'];
const items = () => [
  {id: 'p1', parentId: null, type: 'Project', sort: 1},
  {id: 'p2', parentId: null, type: 'Project', sort: 2},
  {id: 'ph', parentId: 'p2', type: 'Phase', sort: 1},
  {id: 'tk', parentId: 'ph', type: 'Task', sort: 1},
  {id: 't2', parentId: null, type: 'Task', sort: 3},
  {id: 'odd', parentId: null, type: 'Bug', sort: 4},
];
const byId = (l: Patch[]): Record<string, Patch['patch']> => Object.fromEntries(l.map(x => [x.id, x.patch]));

test('nesting: a Project dropped on a Project becomes a Phase under it, and its subitems move down a level', () => {
  const r = byId(nestUnder(items(), 'p2', 'p1', T)!);
  assert.deepEqual(r.p2, {parentId: 'p1', sort: 1, type: 'Phase'});
  assert.deepEqual(r.ph, {type: 'Task'});
  assert.deepEqual(r.tk, {type: 'Subtask'});
});

test('nesting: dropped on a Task it becomes a Subtask; already deeper keeps its level; never past the last level', () => {
  assert.deepEqual(byId(nestUnder(items(), 'p1', 't2', T)!).p1, {parentId: 't2', sort: 1, type: 'Subtask'});
  const deep = [...items(), {id: 's', parentId: null, type: 'Subtask', sort: 9}];
  assert.deepEqual(byId(nestUnder(deep, 's', 'p1', T)!).s, {parentId: 'p1', sort: 1}, 'a Subtask under a Project stays a Subtask');
  const r = byId(nestUnder(items(), 'p2', 'tk', T) ?? []);
  assert.deepEqual(r, {}, 'not under its own subitem');
  const sub = byId(nestUnder(items(), 'p2', 't2', T)!);
  assert.deepEqual([sub.p2.type, sub.ph.type, sub.tk.type], ['Subtask', 'Subtask', 'Subtask'], 'subitems stop at the last level');
});

test('nesting: an item with a type outside the levels takes the level below; a target outside the levels keeps the type', () => {
  assert.deepEqual(byId(nestUnder(items(), 'odd', 'p1', T)!).odd, {parentId: 'p1', sort: 1, type: 'Phase'});
  assert.deepEqual(byId(nestUnder(items(), 't2', 'odd', T)!).t2, {parentId: 'odd', sort: 1});
  assert.equal(nestUnder(items(), 'p1', 'p1', T), null);
});

test('reordering beside a row keeps its parent and sorts between neighbours; never into itself', () => {
  assert.deepEqual(placeBeside(items(), 't2', 'p2', false), {id: 't2', patch: {parentId: null, sort: 1.5}});
  assert.deepEqual(placeBeside(items(), 't2', 'p2', true), {id: 't2', patch: {parentId: null, sort: 3}});
  assert.deepEqual(placeBeside(items(), 't2', 'tk', false), {id: 't2', patch: {parentId: 'ph', sort: 0}});
  assert.equal(placeBeside(items(), 'p2', 'tk', true), null);
  assert.ok(isUnder(items(), 'tk', 'p2') && !isUnder(items(), 'p1', 'p2'));
});


test('nesting and moving stay within one space (the All spaces rollup shows several)', () => {
  const l = [{id: 'a', parentId: null, type: 'Project', sort: 1, projectId: 'sales'}, {id: 'b', parentId: null, type: 'Task', sort: 2, projectId: 'finance'}, {id: 'c', parentId: 'a', type: 'Phase', sort: 1, projectId: 'sales'}];
  assert.equal(nestUnder(l, 'b', 'a', T), null);
  assert.equal(placeBeside(l, 'b', 'c', true), null);
  assert.ok(nestUnder(l, 'c', 'a', T) && placeBeside(l, 'a', 'c', false) === null, 'same space works; still never into itself');
});

test('update bar: finds the main script of a page, so an open tab knows when a newer version is live', async () => {
  const {mainScript} = await import('../src/UpdateBar.tsx');
  assert.equal(mainScript('<script type="module" crossorigin src="/assets/index-NFjdRxgC.js"></script><link href="/assets/index-9Y8.css">'), '/assets/index-NFjdRxgC.js');
  assert.equal(mainScript('<html>no build</html>'), null);
});
