import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {migrate, saveWorkspace} from '../server/auth.ts';
import {dayPlanReminders} from '../server/dayplan.ts';
import {createMcpServer} from '../server/mcp.ts';
import {guarded} from '../server/tokens.ts';
import {checkEntries, entryDone} from '../src/daycheck.ts';
import {boxesFor, carryLines, copyBox} from '../src/dayweek.ts';
import {personDay, rollTodayStatuses} from '../server/todaystatus.ts';
import {addDays} from '../src/dates.ts';

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

test('day planner: Remind all reminds every box, carries over to other days, and turns off', () => {
  const {t, david, sam} = setup();
  t.updateDayPlan(david.id, '2026-11-14', {tz: 'UTC', blocks: [{id: 'a', text: 'Bookkeeping', start: '16:00', minutes: 30}, {id: 'b', text: 'Done one', start: '16:00', minutes: 30, done: true}]});
  assert.equal(t.dayPlan(david.id, '2026-11-14').remindAll, false, 'off by default');
  dayPlanReminders(t, new Date('2026-11-14T16:01:00Z'));
  assert.equal(t.listNotifications(david.id).length, 0, 'boxes stay quiet without a bell or Remind all');
  t.updateDayPlan(david.id, '2026-11-14', {remindAll: true});
  assert.equal(t.dayPlan(david.id, '2026-11-15').remindAll, true, 'carries over to the next day');
  assert.equal(t.dayPlan(sam.id, '2026-11-14').remindAll, false, 'only for that person');
  dayPlanReminders(t, new Date('2026-11-14T16:02:00Z'));
  dayPlanReminders(t, new Date('2026-11-14T16:03:00Z'));
  const n = t.listNotifications(david.id);
  assert.equal(n.length, 1, 'once, and not for a box already done');
  assert.match(n[0].text, /Bookkeeping/);
  t.updateDayPlan(david.id, '2026-11-15', {tz: 'UTC', blocks: [{id: 'c', text: 'Pay Collin', start: '19:00', minutes: 30}]});
  dayPlanReminders(t, new Date('2026-11-15T19:01:00Z'));
  assert.equal(t.listNotifications(david.id).length, 2, 'the next day reminds too');
  t.updateDayPlan(david.id, '2026-11-15', {remindAll: false, blocks: [{id: 'd', text: 'Later', start: '20:00', minutes: 30}]});
  dayPlanReminders(t, new Date('2026-11-15T20:01:00Z'));
  assert.equal(t.listNotifications(david.id).length, 2, 'off again: per-box bells only');
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

test('day planner: a box checked off before lines were linked still shows its brain dump line done', () => {
  // Saved before check-offs were shared: only the box has done. The dump line with its text shows done too.
  const plan = {top: [], dump: [{id: 'd', text: 'Meeting with Collin'}, {id: 'o', text: 'Other'}], blocks: [{id: 'b', text: 'meeting with collin', done: true}]};
  const none = () => undefined;
  assert.ok(entryDone(plan, plan.dump[0], none), 'the line follows its checked box');
  assert.ok(!entryDone(plan, plan.dump[1], none));
  // Unchecking any of them clears them all.
  const r = checkEntries(plan, 'd', false, none)!;
  assert.ok(!entryDone(r.plan, r.plan.dump[0], none) && !entryDone(r.plan, r.plan.blocks[0], none));
});

test('day planner week: a box copied to another day is a fresh box at the same time', () => {
  const b = {id: 'b1', text: 'Write report', itemId: 'it1', start: '10:00', minutes: 90, done: true, remind: true, notified: true, eventId: 'ev1', planned: {start: '09:00', minutes: 60}, fitted: true, color: '5', note: 'n', links: ['x']};
  const c = copyBox(b, () => 'new1');
  assert.deepEqual(c, {id: 'new1', text: 'Write report', itemId: 'it1', start: '10:00', minutes: 90, remind: true, color: '5', note: 'n', links: ['x']});
  assert.equal(copyBox(b, () => 'n2', '14:30').start, '14:30');
});

test('day planner: open brain dump lines from earlier days roll over, not tasks, done lines or ones already here', () => {
  const none = () => undefined;
  const earlier = [
    {date: '2026-11-16', plan: {top: [], dump: [{id: 'a', text: 'Call bank'}, {id: 'b', text: 'Task line', itemId: 'it'}, {id: 'c', text: 'Done one', done: true}, {id: 'd', text: 'Boxed and checked'}], blocks: [{id: 'x', text: 'boxed and checked', done: true}]}},
    {date: '2026-11-15', plan: {top: [], dump: [{id: 'e', text: 'call bank'}, {id: 'f', text: 'Buy stamps'}, {id: 'g', text: 'Already today'}], blocks: []}},
  ];
  const today = {top: [], dump: [{id: 'h', text: 'already today'}], blocks: []};
  const got = carryLines(earlier, today, none);
  assert.deepEqual(got.map(x => [x.date, x.entry.text]), [['2026-11-16', 'Call bank'], ['2026-11-15', 'Buy stamps']], 'newest copy of a line wins; one per text');
});

test('day planner: a line or task shows which boxes it is already in on the day', () => {
  const task = (id: string) => id === 't1' ? {title: 'Write report', completed: false} : undefined;
  const blocks = [{id: 'b2', text: 'Write report', itemId: 't1', start: '14:00', minutes: 60}, {id: 'b1', text: 'write  REPORT', start: '09:00', minutes: 30},
    {id: 'b3', text: 'Lunch', start: '12:00', minutes: 60}];
  assert.deepEqual(boxesFor(blocks, {text: 'Write report', itemId: 't1'}, task).map(b => b.id), ['b1', 'b2'], 'the task box and a plain box with its title, earliest first');
  assert.deepEqual(boxesFor(blocks, {text: 'write report'}, task).map(b => b.id), ['b1', 'b2'], 'a plain line matches by text and by the task title');
  assert.deepEqual(boxesFor(blocks, {text: 'Dinner'}, task), []);
});

test('day planner: a task boxed on today goes to Today; next day, not done and not boxed, back to To do', () => {
  const {t, david, sam} = setup();
  const statuses = [{id: 'backlog', name: 'Backlog', category: 'todo', color: '#999'}, {id: 'todo', name: 'To do', category: 'todo', color: '#999'},
    {id: 'today', name: 'Today', category: 'doing', color: '#999'}, {id: 'doing', name: 'Doing', category: 'doing', color: '#999'}, {id: 'done', name: 'Done', category: 'done', color: '#999'}] as const;
  const p = t.createProject({name: 'Sales', key: 'SAL', statuses: statuses.map(s => ({...s}))});
  const mk = (title: string, status = 'todo', who = [david.id]) => t.createItem({projectId: p.id, title, status, assignees: who}, david.id);
  const a = mk('Call Collin'), b = mk('Email samples', 'backlog'), c = mk('Already doing', 'doing'), later = mk('Later task');
  const noToday = t.createProject({name: 'Plain', key: 'PL'}), x = t.createItem({projectId: noToday.id, title: 'No Today status', assignees: [david.id]}, david.id);
  const day = personDay(t, david.id), next = addDays(day, 1);
  t.updateDayPlan(david.id, day, {blocks: [a, b, c, x].map((i, n) => ({id: 'b' + n, text: '', itemId: i.id, start: `1${n}:00`, minutes: 30}))});
  t.updateDayPlan(david.id, next, {blocks: [{id: 'n1', text: '', itemId: later.id, start: '09:00', minutes: 30}]});
  assert.deepEqual([a, b, c, x, later].map(i => t.item(i.id).status), ['today', 'today', 'doing', x.status, 'todo'], 'boxed today: To do and Backlog go to Today; Doing, spaces without Today and other days untouched');

  // The first run after an upgrade only marks the day, so work already in Today is not moved back at once.
  const noon = (d: string) => new Date(`${d}T19:00:00Z`);
  rollTodayStatuses(t, noon(day));
  assert.equal(t.item(a.id).status, 'today');
  // Next day: Call Collin is boxed again (stays), Email samples is not (back to To do), a done task stays done, the planned-ahead one flips to Today.
  t.updateDayPlan(david.id, next, {blocks: [{id: 'n1', text: '', itemId: later.id, start: '09:00', minutes: 30}, {id: 'n2', text: '', itemId: a.id, start: '10:00', minutes: 30}]});
  const shared = mk('Shared with Sam', 'today', [david.id, sam.id]);
  t.updateDayPlan(sam.id, next, {blocks: [{id: 's1', text: '', itemId: shared.id, start: '09:00', minutes: 30}]});
  const fin = mk('Finished', 'today'); t.updateItem(fin.id, {status: 'done'}, david.id);
  rollTodayStatuses(t, noon(next));
  assert.deepEqual([a, b, later, shared, fin].map(i => t.item(i.id).status), ['today', 'todo', 'today', 'today', 'done'],
    'kept when boxed today (by any assignee); back to To do when not; planned-ahead tasks arrive in Today; done stays done');
  // Once a day: a second run the same day changes nothing, even after a manual move to Today.
  t.updateItem(b.id, {status: 'today'}, david.id);
  rollTodayStatuses(t, noon(next));
  assert.equal(t.item(b.id).status, 'today');
});

test('day planner roll over: the newest copy of a line decides, so lines brought over are not offered again or lost on undo', () => {
  const none = () => undefined;
  // Brought over yesterday and finished there: the older open copy is not offered again.
  const earlier = [
    {date: '2026-11-16', plan: {top: [], dump: [{id: 'n', text: 'Call bank', done: true}, {id: 'm', text: 'Made a task', itemId: 'it'}], blocks: []}},
    {date: '2026-11-15', plan: {top: [], dump: [{id: 'o', text: 'call bank'}, {id: 'p', text: 'made a task'}, {id: 'q', text: 'Still open'}], blocks: []}},
  ];
  assert.deepEqual(carryLines(earlier, {top: [], dump: [], blocks: []}, none).map(x => x.entry.text), ['Still open']);
  // Bringing over leaves the earlier day as it was: with the line on today it is not offered; undone, it is offered again.
  assert.deepEqual(carryLines(earlier, {top: [], dump: [{id: 'r', text: 'Still open'}], blocks: []}, none), []);
});

test('Today status: boxing a task only changes its status when the person may edit tasks in that space', () => {
  const {t, david, sam} = setup();
  const p = t.createProject({name: 'Sales', key: 'SAL', statuses: [{id: 'todo', name: 'To do', category: 'todo', color: '#999'}, {id: 'today', name: 'Today', category: 'doing', color: '#999'}, {id: 'done', name: 'Done', category: 'done', color: '#999'}]});
  const it = t.createItem({projectId: p.id, title: 'Look only', assignees: [sam.id]}, david.id);
  t.db.prepare("update people set role = 'viewer' where id = ?").run(sam.id);
  saveWorkspace(t.db, {requireLogin: true});
  t.updateDayPlan(sam.id, personDay(t, sam.id), {blocks: [{id: 'v', text: '', itemId: it.id, start: '09:00', minutes: 30}]});
  assert.equal(t.item(it.id).status, 'todo', 'a viewer boxing a task does not move it');
});
