import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {migrate} from '../server/auth.ts';
import {dayPlanReminders} from '../server/dayplan.ts';
import {createMcpServer} from '../server/mcp.ts';
import {guarded} from '../server/tokens.ts';

function setup() {
  const t = new Tasks(openDb(':memory:'), () => '2026-11-14');
  migrate(t.db);
  const david = t.createPerson({name: 'David', email: 'd@x.test'}), sam = t.createPerson({name: 'Sam', email: 's@x.test'});
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  return {t, david, sam, p};
}

test('day planner: top 3, brain dump, time boxes, validation', () => {
  const {t, david, p} = setup();
  const it = t.createItem({projectId: p.id, title: 'Call Tim', assignees: [david.id]}, david.id);
  const empty = t.dayPlan(david.id, '2026-11-14');
  assert.deepEqual([empty.top, empty.dump, empty.blocks, empty.dayStart, empty.dayEnd, empty.slot], [[], [], [], 6, 22, 30]);
  const plan = t.updateDayPlan(david.id, '2026-11-14', {top: [{id: 'a', text: '', itemId: it.id}], dump: [{id: 'b', text: 'do laundry'}],
    blocks: [{id: 'c', text: 'Lunch with Lisa', start: '12:00', minutes: 60, at: '2026-11-14T19:00:00Z', remind: true}]});
  assert.equal(plan.top[0].text, 'Call Tim', 'a task entry takes its title');
  assert.throws(() => t.updateDayPlan(david.id, '2026-11-14', {top: [{id: '1', text: 'a'}, {id: '2', text: 'b'}, {id: '3', text: 'c'}, {id: '4', text: 'd'}]}), /up to 3/);
  assert.throws(() => t.updateDayPlan(david.id, '2026-11-14', {blocks: [{id: 'x', text: 'x', start: '25:00', minutes: 30}]}), /09:30/);
  assert.throws(() => t.updateDayPlan(david.id, '2026-11-14', {slot: 20}), /15, 30 or 60/);
  assert.equal(t.dayPlan(david.id, '2026-11-15').blocks.length, 0, 'each day is its own page');
  const meet = t.updateDayPlan(david.id, '2026-11-14', {blocks: [{id: 'm', text: 'Team meeting', start: '14:00', minutes: 60, links: [it.id, 'OPS-1'], eventId: 'ev1', note: 'Agenda'}]});
  assert.deepEqual(meet.blocks[0].links, [it.id], 'tasks tied to a meeting box (keys work too)');
  assert.equal(meet.blocks[0].eventId, 'ev1');
});

test('day planner: schedule from now skips busy and done, uses estimates', () => {
  const {t, david, p} = setup();
  const due = t.createItem({projectId: p.id, title: 'Evaluate survey', assignees: [david.id], due: '2026-11-14', estimate: 1}, david.id);
  const late = t.createItem({projectId: p.id, title: 'Develop feature', assignees: [david.id], due: '2026-11-10'}, david.id);
  t.updateDayPlan(david.id, '2026-11-14', {top: [{id: 't', text: 'Write article'}], dump: [{id: 'd1', text: 'read book'}, {id: 'd2', text: 'old', done: true}],
    blocks: [{id: 'm', text: '2PM meeting', start: '09:00', minutes: 60}]});
  const plan = t.autoSchedule(david.id, '2026-11-14', {from: '08:10', offsetMinutes: -420});
  const at = (title: string) => plan.blocks.find(b => b.text === title);
  assert.equal(at('Write article')!.start, '08:30', 'starts at the next slot after now, top 3 first');
  assert.equal(at('Develop feature')!.start, '10:00', 'skips the meeting');
  assert.equal(at('Evaluate survey')!.minutes, 60, 'uses the estimate');
  assert.equal(at('read book')!.start, '11:30');
  assert.ok(!at('old'), 'done lines are left out');
  assert.equal(at('Write article')!.at, '2026-11-14T15:30:00.000Z', 'reminder time uses the offset');
  assert.equal(t.autoSchedule(david.id, '2026-11-14', {from: '08:10'}).blocks.length, plan.blocks.length, 'running it again adds nothing');
  void due; void late;
});

test('day planner: lines that name a time go at that time', () => {
  const {t, david} = setup();
  t.updateDayPlan(david.id, '2026-11-14', {dump: [{id: 'a', text: '2PM meeting'}, {id: 'b', text: 'standup 09:15'}, {id: 'c', text: 'laundry'}]});
  const plan = t.autoSchedule(david.id, '2026-11-14', {from: '08:00'});
  assert.equal(plan.blocks.find(b => b.text === '2PM meeting')!.start, '14:00');
  assert.equal(plan.blocks.find(b => b.text === 'standup 09:15')!.start, '09:15');
  assert.equal(plan.blocks.find(b => b.text === 'laundry')!.start, '08:00');
});

test('day planner: reminders fire once at the start, again after a move', () => {
  const {t, david} = setup();
  t.updateDayPlan(david.id, '2026-11-14', {blocks: [{id: 'r', text: 'Call Tim', start: '09:00', minutes: 30, at: '2026-11-14T16:00:00Z', remind: true}]});
  dayPlanReminders(t, new Date('2026-11-14T15:59:00Z'));
  assert.equal(t.listNotifications(david.id).length, 0, 'not yet');
  dayPlanReminders(t, new Date('2026-11-14T16:01:00Z'));
  dayPlanReminders(t, new Date('2026-11-14T16:02:00Z'));
  const n = t.listNotifications(david.id);
  assert.equal(n.length, 1);
  assert.equal(n[0].kind, 'reminder');
  assert.match(n[0].text, /Call Tim/);
  t.updateDayPlan(david.id, '2026-11-14', {blocks: [{id: 'r', text: 'Call Tim', start: '09:30', minutes: 30, at: '2026-11-14T16:30:00Z', remind: true}]});
  dayPlanReminders(t, new Date('2026-11-14T16:31:00Z'));
  assert.equal(t.listNotifications(david.id).length, 2);
});

test('day planner over MCP: only your own day', async () => {
  const {t, david, sam} = setup();
  const server = createMcpServer(guarded(t, david.id), david.id);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'test', version: '1'});
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({name, arguments: args}); const text = (r.content as {text: string}[])[0].text; if (r.isError) throw new Error(text); return JSON.parse(text); };
  await call('update_day_plan', {dump: [{text: 'Call Tim'}], top: [{text: 'Develop feature'}]});
  const s = await call('schedule_day', {from: '07:00'});
  assert.equal(s.blocks.length, 2);
  assert.equal((await call('get_day_plan', {})).blocks[0].start, '07:00');
  assert.throws(() => guarded(t, david.id).dayPlan(sam.id, '2026-11-14'), /own/);
});
