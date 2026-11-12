import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rollupSpaces, rollupTarget} from '../src/rollup.ts';
import type {Project} from '../src/types.ts';

const sp = (id: string, sort: number, rollup?: {include: string[] | null}) => ({id, name: id, key: id.toUpperCase(), sort, settings: rollup ? {rollup} : {}}) as unknown as Project;

test('items added in a rollup go to the picked space, else its first space', () => {
  const ps = [sp('all', -1, {include: null}), sp('b', 2), sp('a', 1), sp('some', 0, {include: ['b']})];
  assert.deepEqual(rollupSpaces(ps, ps[0]).map(p => p.id), ['a', 'b'], 'real spaces in sidebar order, no rollups');
  assert.equal(rollupTarget(ps, {}, 'all')?.id, 'a', 'first space by default');
  assert.equal(rollupTarget(ps, {rollupAdd: {all: 'b'}}, 'all')?.id, 'b', 'your pick wins');
  assert.equal(rollupTarget(ps, {rollupAdd: {all: 'gone'}}, 'all')?.id, 'a', 'a deleted pick falls back');
  assert.equal(rollupTarget(ps, {rollupAdd: {some: 'a'}}, 'some')?.id, 'b', 'a pick outside the rollup is ignored');
  assert.equal(rollupTarget(ps, {}, 'a'), undefined, 'normal spaces are left alone');
});
