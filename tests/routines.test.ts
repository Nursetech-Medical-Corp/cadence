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
