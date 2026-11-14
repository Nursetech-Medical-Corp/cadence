import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {migrate} from '../server/auth.ts';
import {guarded} from '../server/tokens.ts';
import {includedIn} from '../src/rollup.ts';

test('sub-spaces: nested, list spaces stay out of task lists, parent gets a relation column', () => {
  const t = new Tasks(openDb(':memory:'), () => '2026-11-14');
  migrate(t.db);
  const d = t.createPerson({name: 'David', email: 'd@x.test'});
  const fund = t.createProject({name: 'Fundraising', key: 'FUND'});
  const inv = t.createSubspace(fund.id, {name: 'Investors', kind: 'pipeline'});
  assert.equal(inv.settings.parent, fund.id);
  assert.equal(inv.settings.records, true);
  assert.deepEqual(inv.statuses.map(s => s.name), ['To contact', 'Contacted', 'Meeting', 'Committed', 'Passed']);
  assert.ok(inv.fields.some(f => f.id === 'amount' && f.kind === 'money'));
  assert.deepEqual(t.listViews(inv.id).map(v => v.kind), ['board', 'table', 'calendar']);
  const rel = t.project(fund.id).fields.find(f => f.id === `rel-${inv.id}`);
  assert.equal(rel?.kind, 'relation', 'fundraising tasks can point at investors');

  const pat = t.createItem({projectId: inv.id, title: 'Pat Lee', assignees: [d.id], due: '2026-11-14', fields: {amount: 50000}}, d.id);
  const task = t.createItem({projectId: fund.id, title: 'Send deck', assignees: [d.id], due: '2026-11-14', fields: {[`rel-${inv.id}`]: [pat.id]}}, d.id);
  const w = t.myWork(d.id);
  assert.deepEqual(w.today.map(i => i.title), ['Send deck'], 'records are not in My work');
  void task;

  const all = t.createRollup();
  const routines = {...all, settings: {...all.settings, rollup: {include: null, scope: 'routines' as const}}};
  const picked = {...all, settings: {...all.settings, rollup: {include: [inv.id]}}};
  assert.ok(!includedIn(all, t.listProjects()).some(p => p.id === inv.id), 'All spaces leaves list spaces out');
  assert.ok(includedIn(routines, t.listProjects()).some(p => p.id === inv.id), 'Routines still sees them');
  assert.ok(includedIn(picked, t.listProjects()).some(p => p.id === inv.id), 'a rollup that names it shows it');

  const tasksSub = t.createSubspace(fund.id, {name: 'Board prep'});
  assert.equal(tasksSub.settings.records, undefined);
  assert.throws(() => t.createSubspace(inv.id, {name: 'Deeper'}) && t.updateProject(tasksSub.id, {settings: {...tasksSub.settings, parent: inv.id}}), /one level/);
  assert.throws(() => t.updateProject(fund.id, {settings: {...fund.settings, parent: tasksSub.id}}), /sub-space|own/);
  assert.throws(() => guarded(t, t.createPerson({name: 'Guest'}).id).createSubspace(fund.id, {name: 'x'}), /settings/);
});
