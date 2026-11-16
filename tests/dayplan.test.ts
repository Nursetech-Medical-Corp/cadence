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
import {entryDone} from '../src/daycheck.ts';

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
  assert.deepEqual([empty.top, empty.dump, empty.blocks, empty.dayStart, empty.dayEnd, empty.slot], [[], [], [], 9, 17, 30], 'a new day starts from working hours');
  assert.throws(() => t.updateDayPlan(david.id, '2026-11-14', {tz: 'Mars/Base'}), /time zone/);
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
    blocks: [{id: 'm', text: '2PM meeting', start: '09:00', minutes: 60}], dayStart: 6, dayEnd: 22, tz: 'America/Denver'});
  const plan = t.autoSchedule(david.id, '2026-11-14', {from: '08:10'});
  const at = (title: string) => plan.blocks.find(b => b.text === title);
  assert.equal(at('Write article')!.start, '08:30', 'starts at the next slot after now, top 3 first');
  assert.equal(at('Develop feature')!.start, '10:00', 'skips the meeting');
  assert.equal(at('Evaluate survey')!.minutes, 60, 'uses the estimate');
  assert.equal(at('read book')!.start, '11:30');
  assert.ok(!at('old'), 'done lines are left out');
  assert.equal(at('Write article')!.at, '2026-11-14T15:30:00.000Z', 'reminder time comes from the plan time zone');
  assert.equal(t.autoSchedule(david.id, '2026-11-14', {from: '08:10'}).blocks.length, plan.blocks.length, 'running it again adds nothing');
  void due; void late;
});

test('day planner: lines that name a time go at that time', () => {
  const {t, david} = setup();
  t.updateDayPlan(david.id, '2026-11-14', {dayStart: 6, dump: [{id: 'a', text: '2PM meeting'}, {id: 'b', text: 'standup 09:15'}, {id: 'c', text: 'laundry'}]});
  const plan = t.autoSchedule(david.id, '2026-11-14', {from: '08:00'});
  assert.equal(plan.blocks.find(b => b.text === '2PM meeting')!.start, '14:00');
  assert.equal(plan.blocks.find(b => b.text === 'standup 09:15')!.start, '09:15');
  assert.equal(plan.blocks.find(b => b.text === 'laundry')!.start, '08:00');
});

test('day planner: reminders fire once at the start, again after a move', () => {
  const {t, david} = setup();
  t.updateDayPlan(david.id, '2026-11-14', {tz: 'America/Denver', blocks: [{id: 'r', text: 'Call Tim', start: '09:00', minutes: 30, remind: true}]});
  dayPlanReminders(t, new Date('2026-11-14T15:59:00Z'));
  assert.equal(t.listNotifications(david.id).length, 0, 'not yet');
  dayPlanReminders(t, new Date('2026-11-14T16:01:00Z'));
  dayPlanReminders(t, new Date('2026-11-14T16:02:00Z'));
  const n = t.listNotifications(david.id);
  assert.equal(n.length, 1);
  assert.equal(n[0].kind, 'reminder');
  assert.match(n[0].text, /Call Tim/);
  t.updateDayPlan(david.id, '2026-11-14', {blocks: [{id: 'r', text: 'Call Tim', start: '09:30', minutes: 30, remind: true}]});
  dayPlanReminders(t, new Date('2026-11-14T16:31:00Z'));
  assert.equal(t.listNotifications(david.id).length, 2);
});

test('day planner: fit boxes to logged time, up to now or all day', () => {
  const {t, david, p} = setup();
  const a = t.createItem({projectId: p.id, title: 'Write report', assignees: [david.id]}, david.id);
  const b = t.createItem({projectId: p.id, title: 'Email Sam', assignees: [david.id]}, david.id);
  const c = t.createItem({projectId: p.id, title: 'Unplanned fix', assignees: [david.id]}, david.id);
  t.updateDayPlan(david.id, '2026-11-14', {tz: 'UTC', blocks: [{id: 'a', text: '', itemId: a.id, start: '09:00', minutes: 60}, {id: 'b', text: '', itemId: b.id, start: '13:00', minutes: 30}]});
  // Times are UTC here (offset 0): report 9:20 to 10:05 and 10:10 to 10:30 (joined), fix 11:00 to 11:40, email 13:10 to 13:25.
  const log = (item: string, s: string, e: string) => t.logTime({itemId: item, person: david.id, start: `2026-11-14T${s}:00Z`, end: `2026-11-14T${e}:00Z`});
  log(a.id, '09:20', '10:05'); log(a.id, '10:10', '10:30'); log(c.id, '11:00', '11:40'); log(b.id, '13:10', '13:25');
  const noon = t.fitDayToLogged(david.id, '2026-11-14', {upTo: '2026-11-14T12:00:00Z', offsetMinutes: 0});
  const box = (id: string) => noon.plan.blocks.find(x => x.id === id)!;
  assert.deepEqual([box('a').start, box('a').minutes, box('a').planned], ['09:20', 70, {start: '09:00', minutes: 60}], 'sessions under 10 minutes apart join');
  assert.equal(box('b').start, '13:00', 'after the cutoff nothing moves');
  const fix = noon.plan.blocks.find(x => x.itemId === c.id)!;
  assert.deepEqual([fix.start, fix.minutes, fix.fitted], ['11:00', 40, true], 'logged work with no box gets one');
  assert.deepEqual([noon.summary.plannedMinutes, noon.summary.loggedMinutes, noon.summary.added], [60, 110, 1]);
  const day = t.fitDayToLogged(david.id, '2026-11-14', {offsetMinutes: 0});
  assert.deepEqual([day.plan.blocks.find(x => x.id === 'b')!.start, day.plan.blocks.find(x => x.id === 'b')!.minutes], ['13:10', 15]);
  assert.equal(day.plan.blocks.find(x => x.id === 'a')!.planned!.start, '09:00', 'fitting again keeps the first plan');
  assert.equal(day.plan.blocks.filter(x => x.itemId === c.id).length, 1, 'fitting again adds nothing twice');
});

test('day planner: time zones and working hours', () => {
  const {t, david} = setup();
  const p = t.updateDayPlan(david.id, '2026-07-01', {tz: 'America/Denver', blocks: [{id: 'x', text: 'Standup', start: '09:00', minutes: 15}]});
  assert.equal(p.blocks[0].at, '2026-07-01T15:00:00.000Z', 'summer time is used in July');
  const moved = t.updateDayPlan(david.id, '2026-07-01', {tz: 'America/New_York'});
  assert.equal(moved.blocks[0].start, '09:00', 'box times are wall-clock times in the plan zone');
  assert.equal(moved.blocks[0].at, '2026-07-01T13:00:00.000Z', 'changing the zone moves the moment (reminders follow)');
  const later = t.autoSchedule(david.id, '2030-01-07', {});
  void later;
  t.updateDayPlan(david.id, '2030-01-07', {dump: [{id: 'd', text: 'Write plan'}]});
  assert.equal(t.autoSchedule(david.id, '2030-01-07', {}).blocks.find(b => b.text === 'Write plan')!.start, '09:00', 'another day starts at the start of working hours, not 6am');
});

test('day planner over MCP: only your own day', async () => {
  const {t, david, sam} = setup();
  const server = createMcpServer(guarded(t, david.id), david.id);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'test', version: '1'});
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({name, arguments: args}); const text = (r.content as {text: string}[])[0].text; if (r.isError) throw new Error(text); return JSON.parse(text); };
  await call('update_day_plan', {dump: [{text: 'Call Tim'}], top: [{text: 'Develop feature'}]});
  await call('update_day_plan', {dayStart: 6});
  const s = await call('schedule_day', {from: '07:00'});
  assert.equal(s.blocks.length, 2);
  assert.equal((await call('get_day_plan', {})).blocks[0].start, '07:00');
  assert.throws(() => guarded(t, david.id).dayPlan(sam.id, '2026-11-14'), /own/);
});

test('day planner: a reminder minutes before the start, once; changing the lead arms it again', () => {
  const {t, david} = setup();
  // 09:00 Denver is 16:00 UTC; 10 minutes before is 15:50 UTC.
  t.updateDayPlan(david.id, '2026-11-14', {tz: 'America/Denver', blocks: [{id: 'r', text: 'Board call', start: '09:00', minutes: 60, remind: true, remindBefore: 10}]});
  assert.equal(t.dayPlan(david.id, '2026-11-14').blocks[0].remindBefore, 10, 'the lead time is kept');
  dayPlanReminders(t, new Date('2026-11-14T15:49:00Z'));
  assert.equal(t.listNotifications(david.id).length, 0, 'not 11 minutes before');
  dayPlanReminders(t, new Date('2026-11-14T15:50:30Z'));
  dayPlanReminders(t, new Date('2026-11-14T15:55:00Z'));
  const n = t.listNotifications(david.id);
  assert.equal(n.length, 1, 'once');
  assert.match(n[0].text, /^In 10 min \(09:00, 60 min\): Board call/);
  t.updateDayPlan(david.id, '2026-11-14', {blocks: [{id: 'r', text: 'Board call', start: '09:00', minutes: 60, remind: true, remindBefore: 60}]});
  dayPlanReminders(t, new Date('2026-11-14T15:56:00Z'));
  assert.equal(t.listNotifications(david.id).length, 1, 'an hour-before reminder that is already past by more than 15 minutes stays quiet');
  t.updateDayPlan(david.id, '2026-11-14', {blocks: [{id: 'r', text: 'Board call', start: '09:00', minutes: 60, remind: true, remindBefore: 5}]});
  dayPlanReminders(t, new Date('2026-11-14T15:56:00Z'));
  assert.equal(t.listNotifications(david.id).length, 2, 'a new lead time arms it again');
  assert.match(t.listNotifications(david.id)[0].text, /^In 5 min/);
  t.updateDayPlan(david.id, '2026-11-14', {blocks: [{id: 'r', text: 'Board call', start: '09:00', minutes: 60, remind: false, remindBefore: 30}]});
  assert.equal(t.dayPlan(david.id, '2026-11-14').blocks[0].remindBefore, undefined, 'no lead time without a reminder');
});

test('day planner: checking a line off marks it done everywhere it shows, and its task', () => {
  const {t, david, p} = setup();
  const d = '2026-11-14';
  const tim = t.createItem({projectId: p.id, title: 'Call Tim', assignees: [david.id]}, david.id);
  t.updateDayPlan(david.id, d, {
    top: [{id: 't1', text: 'Call Tim'}, {id: 't2', text: 'Lunch'}],
    dump: [{id: 'd1', text: '  call   tim '}, {id: 'd2', text: 'laundry'}],
    blocks: [{id: 'b1', text: '', itemId: tim.id, start: '10:00', minutes: 30}, {id: 'b2', text: 'lunch', start: '12:00', minutes: 60}]});
  // The bug: checking the box off left the same line in the top 3 and the brain dump open.
  let plan = t.checkDayEntry(david.id, d, 'b1');
  assert.ok(t.item(tim.id).completed, 'the task the box stands for is done');
  assert.deepEqual([plan.top[0].done, plan.dump[0].done, plan.dump[1].done, plan.top[1].done], [true, true, undefined, undefined], 'same text in the top 3 and the dump, nothing else');
  // Back on, from the top 3 line (plain text that matches the task): the task reopens and the flags clear.
  plan = t.checkDayEntry(david.id, d, 't1', false);
  assert.ok(!t.item(tim.id).completed, 'unchecking a matching line reopens the task');
  assert.deepEqual([plan.top[0].done, plan.dump[0].done], [undefined, undefined]);
  // Plain lines only: a box and a priority with the same text, no task touched.
  plan = t.checkDayEntry(david.id, d, 'b2');
  assert.deepEqual([plan.blocks[1].done, plan.top[1].done], [true, true]);
  assert.ok(!t.item(tim.id).completed);
  // Flip without done: checks it back on.
  assert.equal(t.checkDayEntry(david.id, d, 't2').blocks[1].done, undefined);
  // A task finished elsewhere (the task panel) shows done on the plain lines with its text.
  t.updateItem(tim.id, {status: p.statuses.find(s => s.category === 'done')!.id}, david.id);
  const shown = t.dayPlan(david.id, d), info = (id: string) => { const it = t.item(id); return {title: it.title, completed: !!it.completed}; };
  assert.ok(entryDone(shown, shown.top[0], info) && entryDone(shown, shown.dump[0], info), 'plain lines follow the task with their text');
  assert.ok(!entryDone(shown, shown.dump[1], info));
  assert.throws(() => t.checkDayEntry(david.id, d, 'nope'), /No line/);
});

test('day planner: a check never completes the wrong task, and agent rules still apply', () => {
  const {t, david, p} = setup();
  const d = '2026-11-14';
  const a = t.createItem({projectId: p.id, title: 'Email'}, david.id), b = t.createItem({projectId: p.id, title: 'Email'}, david.id);
  t.updateDayPlan(david.id, d, {dump: [{id: 'x', text: 'email'}], blocks: [{id: 'ba', text: '', itemId: a.id, start: '09:00', minutes: 30}, {id: 'bb', text: '', itemId: b.id, start: '10:00', minutes: 30}]});
  const plan = t.checkDayEntry(david.id, d, 'x');
  assert.ok(!t.item(a.id).completed && !t.item(b.id).completed, 'a line matching two tasks completes neither');
  assert.equal(plan.dump[0].done, true);
  assert.ok(!t.item(b.id).completed && t.checkDayEntry(david.id, d, 'ba') && t.item(a.id).completed && !t.item(b.id).completed, 'a task box completes only its own task');
  // An agent planning its own day still cannot mark work done.
  const bot = t.createPerson({name: 'helper-bot'});
  t.db.prepare("update people set kind = 'ai' where id = ?").run(bot.id);
  const job = t.createItem({projectId: p.id, title: 'Draft notes'}, david.id);
  t.updateDayPlan(bot.id, d, {top: [{id: 'j', text: '', itemId: job.id}]});
  assert.throws(() => t.checkDayEntry(bot.id, d, 'j', true, bot.id), /cannot mark work done/);
  assert.ok(!t.item(job.id).completed);
  assert.equal(t.dayPlan(bot.id, d).top[0].done, undefined, 'nothing changes when the task refuses');
});

test('day planner: check_day_entry over MCP, and a token needs edit on the task', async () => {
  const {t, david, sam, p} = setup();
  const tim = t.createItem({projectId: p.id, title: 'Call Tim'}, david.id);
  const server = createMcpServer(guarded(t, david.id), david.id);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'test', version: '1'});
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({name, arguments: args}); const text = (r.content as {text: string}[])[0].text; if (r.isError) throw new Error(text); return JSON.parse(text); };
  await call('update_day_plan', {top: [{id: 'p1', text: 'Call Tim'}], blocks: [{id: 'k', item: tim.id, start: '09:00', minutes: 30}]});
  const plan = await call('check_day_entry', {id: 'p1'});
  assert.equal(plan.top[0].done, true);
  assert.ok(t.item(tim.id).completed, 'the task is completed through MCP too');
  assert.throws(() => guarded(t, david.id).checkDayEntry(sam.id, '2026-11-14', 'p1'), /own/);
  // Sam can only view the space: checking off a line tied to its task is refused.
  const fin = t.createProject({name: 'Fin', key: 'FIN'});
  t.updateProject(fin.id, {settings: {...t.project(fin.id).settings, access: {default: 'none', members: {[sam.id]: 'viewer'}}}});
  const report = t.createItem({projectId: fin.id, title: 'Read report'}, david.id);
  t.updateDayPlan(sam.id, '2026-11-14', {top: [{id: 'r', text: 'Read report'}], blocks: [{id: 'rb', text: '', itemId: report.id, start: '09:00', minutes: 30}]});
  assert.throws(() => guarded(t, sam.id).checkDayEntry(sam.id, '2026-11-14', 'r'), /edit/);
  assert.ok(!t.item(report.id).completed);
});
