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
