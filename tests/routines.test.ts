import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {createMcpServer} from '../server/mcp.ts';
import {guarded} from '../server/tokens.ts';
import {migrate} from '../server/auth.ts';
import {perWeek} from '../src/recur.ts';

function setup(today = '2026-11-11') {
  let day = today;
  const t = new Tasks(openDb(':memory:'), () => day);
  migrate(t.db);
  const david = t.createPerson({name: 'David', email: 'd@x.test'});
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  return {t, david, p, setDay: (d: string) => { day = d; }};
}

test('routines: skip moves to the next date, pause hides from open lists, resume rolls forward, end stops repeating', () => {
  const {t, david, p, setDay} = setup();
  const weekly = t.createItem({projectId: p.id, title: 'Weekly check', assignees: [david.id], due: '2026-11-16', start: '2026-11-15', estimate: 0.5, tags: ['routine', 'SOP-07.2', 'auto-job'], recur: {every: 1, unit: 'week', mode: 'schedule'}}, david.id);
  t.createItem({projectId: p.id, title: 'One-off', due: '2026-11-20'}, david.id);
  assert.equal(t.listRoutines().length, 1);

  const skipped = t.routine(weekly.id, 'skip', david.id);
  assert.equal(skipped.due, '2026-11-23');
  assert.equal(skipped.start, '2026-11-22', 'start moves with due');

  const paused = t.routine(weekly.id, 'pause', david.id);
  assert.equal(paused.recur?.paused, true);
  assert.equal(paused.sprint, null);
  assert.ok(!t.listItems({open: true}).some(i => i.id === weekly.id), 'paused routine leaves open lists');
  assert.equal(t.listRoutines().length, 1, 'but stays on the routines list');

  setDay('2026-12-09');
  const resumed = t.routine(weekly.id, 'resume', david.id);
  assert.equal(resumed.recur?.paused, undefined);
  assert.equal(resumed.due, '2026-12-14', 'comes back on its next date from today, not overdue');
  assert.ok(t.listItems({open: true}).some(i => i.id === weekly.id));

  const ended = t.routine(weekly.id, 'end', david.id);
  assert.equal(ended.recur, null);
  assert.equal(t.listRoutines().length, 0);
  assert.throws(() => t.routine(weekly.id, 'skip', david.id), /not an open repeating item/);
});

test('routines: skip refuses the last occurrence; nth-weekday rules keep their weekday', () => {
  const {t, david, p} = setup();
  const last = t.createItem({projectId: p.id, title: 'Two left', due: '2026-12-01', recur: {every: 1, unit: 'month', mode: 'schedule', count: 1}}, david.id);
  assert.throws(() => t.routine(last.id, 'skip', david.id), /last one/);
  const nth = t.createItem({projectId: p.id, title: '2nd Monday', due: '2026-12-14', recur: {every: 1, unit: 'month', mode: 'schedule', monthBy: 'nth'}}, david.id);
  assert.equal(t.routine(nth.id, 'skip', david.id).due, '2027-01-11');
});

test('routines: per-week load counts weekdays, weeks, months', () => {
  assert.equal(perWeek({every: 1, unit: 'week', mode: 'schedule', weekdays: [1, 2, 3, 4, 5]}), 5);
  assert.equal(perWeek({every: 2, unit: 'week', mode: 'schedule'}), 0.5);
  assert.ok(Math.abs(perWeek({every: 1, unit: 'month', mode: 'schedule'}) - 12 / 52) < 1e-9);
});

test('routines over MCP: pause a whole SOP by tag, list paused ones', async () => {
  const {t, david, p} = setup();
  for (const title of ['A', 'B']) t.createItem({projectId: p.id, title, due: '2026-11-16', tags: ['SOP-06.2'], recur: {every: 1, unit: 'week', mode: 'schedule'}}, david.id);
  t.createItem({projectId: p.id, title: 'C', due: '2026-11-16', tags: ['SOP-07.1'], recur: {every: 1, unit: 'week', mode: 'schedule'}}, david.id);
  const server = createMcpServer(guarded(t, david.id), david.id);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'test', version: '1'});
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({name, arguments: args});
    const text = (r.content as {text: string}[])[0].text;
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const out = await call('set_routine', {tag: 'SOP-06.2', action: 'pause'});
  assert.equal(out.length, 2);
  assert.ok(out.every((x: {paused: boolean}) => x.paused));
  const paused = await call('list_routines', {paused: true});
  assert.deepEqual(paused.map((x: {title: string}) => x.title).sort(), ['A', 'B']);
  assert.equal((await call('list_routines', {paused: false})).length, 1);
});

test('routines: delay moves only this copy; the next stays on schedule', () => {
  const {t, david, p} = setup();
  const w = t.createItem({projectId: p.id, title: 'Weekly', due: '2026-11-16', recur: {every: 1, unit: 'week', mode: 'schedule'}}, david.id);
  const d = t.routine(w.id, 'delay', david.id, {to: '2026-11-19'});
  assert.equal(d.due, '2026-11-19');
  assert.equal(d.recur?.slot, '2026-11-16');
  const done = p.statuses.find(s => s.category === 'done')!.id;
  t.updateItem(w.id, {status: done}, david.id);
  const next = t.listRoutines().find(i => i.title === 'Weekly')!;
  assert.equal(next.due, '2026-11-23', 'next copy counts from the original slot');
  assert.equal(next.recur?.slot, undefined);
});

test('routines: wait hides a routine until the work it waits on is done, then it starts', () => {
  const {t, david, p, setDay} = setup();
  const hire = t.createItem({projectId: p.id, title: 'Hire first W-2 employee', due: '2026-12-15'}, david.id);
  const payroll = t.createItem({projectId: p.id, title: 'Weekly payroll check', assignees: [david.id], due: '2026-11-18', recur: {every: 1, unit: 'week', mode: 'schedule'}}, david.id);
  const waiting = t.routine(payroll.id, 'wait', david.id, {on: [hire.id]});
  assert.equal(waiting.recur?.waiting, true);
  assert.ok(!t.listItems({open: true}).some(i => i.id === payroll.id));
  setDay('2027-01-05');
  t.updateItem(hire.id, {status: p.statuses.find(s => s.category === 'done')!.id}, david.id);
  const live = t.item(payroll.id);
  assert.equal(live.recur?.waiting, undefined);
  assert.ok(live.due! >= '2027-01-05', 'starts on its next date from today');
  assert.ok(t.listItems({open: true}).some(i => i.id === payroll.id));
});

test('archive, snooze and restore keep items out of open lists without deleting them', () => {
  const {t, david, p, setDay} = setup();
  const idea = t.createItem({projectId: p.id, title: 'Maybe another conference'}, david.id);
  t.archiveItem(idea.id, {kind: 'idea', reason: 'Not sure we will go'}, david.id);
  assert.ok(!t.listItems({open: true}).some(i => i.id === idea.id));
  assert.equal(t.listParked().length, 1);
  t.restoreItem(idea.id, david.id);
  assert.ok(t.listItems({open: true}).some(i => i.id === idea.id));
  t.snoozeItem(idea.id, '2026-12-01', david.id);
  assert.ok(!t.listItems({open: true}).some(i => i.id === idea.id));
  setDay('2026-12-01');
  assert.ok(t.listItems({open: true}).some(i => i.id === idea.id), 'comes back on its date');
});

test('renaming a space key keeps old item keys working', () => {
  const {t, david} = setup();
  const nt = t.createProject({name: 'Gen Business', key: 'NT'});
  const it = t.createItem({projectId: nt.id, title: 'Something'}, david.id);
  t.updateProject(nt.id, {key: 'gen'});
  assert.equal(t.project(nt.id).key, 'GEN');
  assert.equal(t.findItem(`GEN-${it.number}`).id, it.id);
  assert.equal(t.findItem(`NT-${it.number}`).id, it.id);
  assert.throws(() => t.createProject({name: 'Other', key: 'X1'}) && t.updateProject(t.listProjects().find(x => x.key === 'X1')!.id, {key: 'NT'}), /already used/);
});
