import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchFilter, countRules, countAllRules} from '../src/FilterBuilder.tsx';
import type {FilterGroup, Item, Project} from '../src/types.ts';

const project = {statuses: [{id: 'todo', category: 'todo'}, {id: 'done', category: 'done'}], fields: [], types: ['Task']} as unknown as Project;
const ctx = {project, today: '2026-11-12', currentSprint: null};
const item = (status: string, priority: number) => ({id: status + priority, status, priority, assignees: [], tags: [], fields: {}, type: 'Task', title: 't', created: '', updated: ''}) as unknown as Item;
const a = item('todo', 1), b = item('done', 3);

test('a switched-off filter is kept but not applied', () => {
  const g: FilterGroup = {join: 'and', rules: [{field: 'status', op: 'is', value: 'todo'}, {field: 'priority', op: 'is', value: '3', off: true}]};
  assert.deepEqual([a, b].filter(i => matchFilter(i, g, ctx)).map(i => i.id), ['todo1'], 'only the status rule applies');
  assert.equal(countRules(g), 1, 'the toolbar counts rules that are on');
  assert.equal(countAllRules(g), 2, 'the off rule is still saved');
  const allOff: FilterGroup = {...g, rules: g.rules.map(r => ({...r, off: true}))};
  assert.equal([a, b].filter(i => matchFilter(i, allOff, ctx)).length, 2, 'everything off shows everything');
  assert.equal([a, b].filter(i => matchFilter(i, {...g, off: true}, ctx)).length, 2, 'the master switch turns all filters off');
  assert.equal(countRules({...g, off: true}), 0);
  const nested: FilterGroup = {join: 'or', rules: [{field: 'status', op: 'is', value: 'done'}, {join: 'and', off: true, rules: [{field: 'priority', op: 'is', value: '1'}]}]};
  assert.deepEqual([a, b].filter(i => matchFilter(i, nested, ctx)).map(i => i.id), ['done3'], 'an off group is skipped in an or');
});
