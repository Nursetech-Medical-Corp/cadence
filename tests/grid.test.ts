import {test} from 'node:test';
import assert from 'node:assert/strict';
import {place, settle} from '../src/DashGrid.tsx';

test('dashboard grid: moving a widget pushes overlaps down and keeps gaps', () => {
  const cells = [{id: 'a', x: 0, y: 0, w: 2, h: 3}, {id: 'b', x: 2, y: 0, w: 2, h: 3}, {id: 'c', x: 0, y: 3, w: 2, h: 3}];
  const moved = settle(cells.map(c => c.id === 'c' ? {...c, x: 2, y: 1} : c), 'c');
  assert.deepEqual(moved.find(c => c.id === 'c'), {id: 'c', x: 2, y: 1, w: 2, h: 3});
  assert.equal(moved.find(c => c.id === 'b')!.y, 4, 'b pushed below c');
  assert.equal(moved.find(c => c.id === 'a')!.y, 0, 'a untouched');
  const far = settle(cells.map(c => c.id === 'c' ? {...c, y: 10} : c), 'c');
  assert.equal(far.find(c => c.id === 'c')!.y, 10, 'gaps are allowed');
  assert.deepEqual(place(cells, 'd', 2, 2), {id: 'd', x: 4, y: 0, w: 2, h: 2});
});

test('critical path: the longest chain has no slack; side work with room does not', async () => {
  const {criticalPath} = await import('../src/critical.ts');
  const t = (id: string, start: string, due: string, deps: string[] = []) => ({id, start, due, deps, completed: null});
  const items = [
    t('a', '2026-11-02', '2026-11-04'), t('b', '2026-11-05', '2026-11-10', ['a']), t('c', '2026-11-11', '2026-11-12', ['b']),
    t('side', '2026-11-05', '2026-11-06', ['a']),
  ];
  assert.deepEqual([...criticalPath(items)].sort(), ['a', 'b', 'c']);
  assert.equal(criticalPath([]).size, 0);
});

test('sorting: status and dropdowns follow your arranged order, or A to Z when asked', async () => {
  const {sortItems} = await import('../src/Sorting.tsx');
  const project = {statuses: [{id: 'backlog', name: 'Backlog'}, {id: 'todo', name: 'To do'}, {id: 'doing', name: 'Doing'}], types: ['Task'],
    fields: [{id: 'size', name: 'Size', kind: 'select', options: ['Small', 'Medium', 'Large']}]} as never;
  const it = (title: string, status: string, size?: string) => ({id: title, title, status, type: 'Task', priority: 0, assignees: [], tags: [], fields: size ? {size} : {}, sort: 0}) as never;
  const items = [it('a', 'doing', 'Large'), it('b', 'backlog', 'Small'), it('c', 'todo', 'Medium')];
  const titles = (l: {title: string}[]) => l.map(x => x.title).join('');
  assert.equal(titles(sortItems(items, [{col: 'status', dir: 1}], project, {} as never)), 'bca', 'arranged order');
  assert.equal(titles(sortItems(items, [{col: 'status', dir: 1, by: 'alpha'}], project, {} as never)), 'bac', 'Backlog, Doing, To do');
  assert.equal(titles(sortItems(items, [{col: 'f:size', dir: 1}], project, {} as never)), 'bca', 'Small, Medium, Large');
  assert.equal(titles(sortItems(items, [{col: 'f:size', dir: 1, by: 'alpha'}], project, {} as never)), 'acb', 'Large, Medium, Small');
});

test('color rules: moving a rule changes which one wins', async () => {
  const {colorOf} = await import('../src/ColorRules.tsx');
  const {move} = await import('../src/components.tsx');
  const project = {statuses: [], types: ['Task'], fields: []} as never;
  const item = {id: 'a', title: 'a', status: 'todo', type: 'Task', priority: 2, assignees: [], tags: [], fields: {}, due: '2026-11-01', completed: null} as never;
  const high = {rule: {field: 'priority', op: 'is', value: '2'}, color: '#f97316'} as const, late = {rule: {field: 'due', op: 'before', value: 'today'}, color: '#ef4444'} as const;
  const other = {rule: {field: 'priority', op: 'is', value: '1'}, color: '#10b981'} as const;
  const rules = [high, other, late], ctx = {project, today: '2026-11-10'};
  assert.equal(colorOf(item, rules, ctx), '#f97316', 'first match wins');
  const moved = move(rules, 2, 0);
  assert.deepEqual(moved, [late, high, other]);
  assert.equal(colorOf(item, moved, ctx), '#ef4444', 'the rule dragged to the top now wins');
  assert.deepEqual(move(rules, 0, 2), [other, late, high], 'down');
  assert.deepEqual(move(rules, 0, -1), rules, 'off the top: unchanged');
  assert.deepEqual(move(rules, 2, 3), rules, 'off the bottom: unchanged');
  assert.deepEqual(rules, [high, other, late], 'the input list is not changed');
  const {activeColors} = await import('../src/ColorRules.tsx');
  assert.deepEqual(activeColors({colors: rules}), rules, 'colors are on by default');
  assert.equal(colorOf(item, activeColors({colors: rules, colorsOff: true}), ctx), undefined, 'switched off: no color, rules kept');
});

test('list rows: priority, assignee and status follow the saved order', async () => {
  const {rowFieldsOf} = await import('../src/viewProps.ts');
  assert.deepEqual(rowFieldsOf({}), ['priority', 'assignees', 'status'], 'default order');
  assert.deepEqual(rowFieldsOf({rowFields: ['status', 'priority', 'assignees']}), ['status', 'priority', 'assignees']);
  assert.deepEqual(rowFieldsOf({rowFields: ['status', 'due', 'status']}), ['status', 'priority', 'assignees'], 'unknown and repeated ids dropped, missing ones added');
});
