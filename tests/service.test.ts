import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {createMcpServer} from '../server/mcp.ts';
import {parseQuickAdd} from '../src/quickadd.ts';

const TODAY = '2026-11-10'; // a Tuesday
function setup() {
  const t = new Tasks(openDb(':memory:'), () => TODAY);
  const dave = t.createPerson({name: 'David'}), sam = t.createPerson({name: 'Sam Lee'});
  const p = t.createProject({name: 'Web', key: 'WEB', types: ['Epic', 'Feature', 'Story', 'Task', 'Bug']});
  return {t, dave, sam, p};
}

test('quick add parses people, priority, tags, dates, estimate, recurrence', () => {
  const people = [{id: 's', name: 'Sam Lee', email: null, color: ''}];
  const r = parseQuickAdd('Call vendor @sam !high #ops due:fri start:tomorrow ~90m every:2w', people, TODAY);
  assert.deepEqual(r, {title: 'Call vendor', assignees: ['s'], priority: 2, tags: ['ops'], due: '2026-11-13', start: '2026-11-11', estimate: 1.5, recur: {every: 2, unit: 'week', mode: 'schedule'}});
  assert.equal(parseQuickAdd('email bob@x.com @nobody', people, TODAY).title, 'email bob@x.com @nobody');
});

test('assigning notifies the assignee, not the actor', () => {
  const {t, dave, sam, p} = setup();
  const i = t.createItem({projectId: p.id, title: 'A', assignees: [dave.id, sam.id]}, dave.id);
  assert.equal(t.listNotifications(dave.id).length, 0);
  assert.match(t.listNotifications(sam.id)[0].text, /assigned you WEB-1/);
  t.updateItem(i.id, {assignees: [sam.id]}, dave.id);
  assert.equal(t.listNotifications(sam.id).length, 1, 'no repeat for existing assignee');
});

test('comments notify watchers and mentions; completion notifies creator', () => {
  const {t, dave, sam, p} = setup();
  const i = t.createItem({projectId: p.id, title: 'A', assignees: [sam.id]}, dave.id);
  t.addComment(i.id, sam.id, 'Done soon, @David please review');
  const n = t.listNotifications(dave.id);
  assert.equal(n.length, 1);
  assert.equal(n[0].kind, 'mention');
  t.updateItem(i.id, {status: 'done'}, sam.id);
  assert.equal(t.listNotifications(dave.id)[0].kind, 'completed');
  t.markRead(dave.id);
  assert.equal(t.listNotifications(dave.id, true).length, 0);
});

test('completing a recurring item creates the next one exactly once', () => {
  const {t, p} = setup();
  const i = t.createItem({projectId: p.id, title: 'Review', due: '2026-11-12', start: '2026-11-11', recur: {every: 1, unit: 'week', mode: 'schedule'}});
  t.updateItem(i.id, {status: 'done'});
  t.updateItem(i.id, {status: 'todo'});
  t.updateItem(i.id, {status: 'done'});
  const all = t.listItems({projectId: p.id});
  assert.equal(all.length, 2);
  const next = all.find(x => x.id !== i.id)!;
  assert.equal(next.due, '2026-11-19');
  assert.equal(next.start, '2026-11-18');
  assert.equal(next.completed, null);
});

test('after-completion recurrence counts from today; months clamp', () => {
  const {t, p} = setup();
  const a = t.createItem({projectId: p.id, title: 'Water plants', due: '2026-11-01', recur: {every: 3, unit: 'day', mode: 'completion'}});
  t.updateItem(a.id, {status: 'done'});
  const b = t.createItem({projectId: p.id, title: 'Rent', due: '2027-01-31', recur: {every: 1, unit: 'month', mode: 'schedule'}});
  t.updateItem(b.id, {status: 'done'});
  const titles = Object.fromEntries(t.listItems({open: true}).map(x => [x.title, x.due]));
  assert.equal(titles['Water plants'], '2026-11-13');
  assert.equal(titles['Rent'], '2027-02-28');
});

test('recurrence: weekdays, nth weekday, skip weekends, end after count, reopen', async () => {
  const {nextOccurrence, upcoming} = await import('../src/recur.ts');
  // 2026-11-10 is a Tuesday.
  assert.equal(nextOccurrence({every: 1, unit: 'week', mode: 'schedule', weekdays: [1, 3]}, '2026-11-10'), '2026-11-11');
  assert.equal(nextOccurrence({every: 1, unit: 'week', mode: 'schedule', weekdays: [1, 3]}, '2026-11-11'), '2026-11-16');
  assert.deepEqual(upcoming({every: 2, unit: 'week', mode: 'schedule', weekdays: [2]}, '2026-11-10', 2), ['2026-11-24', '2026-12-08']);
  assert.equal(nextOccurrence({every: 1, unit: 'month', mode: 'schedule', monthBy: 'nth'}, '2026-11-10'), '2026-12-08', '2nd Tuesday');
  assert.equal(nextOccurrence({every: 1, unit: 'month', mode: 'schedule', monthBy: 'nth'}, '2026-11-24'), '2026-12-29', 'last Tuesday');
  assert.equal(nextOccurrence({every: 1, unit: 'day', mode: 'schedule', skipWeekends: true}, '2026-11-13'), '2026-11-16');
  assert.equal(nextOccurrence({every: 1, unit: 'year', mode: 'schedule'}, '2026-11-10'), '2027-11-10');
  assert.deepEqual(upcoming({every: 1, unit: 'day', mode: 'schedule', count: 2}, '2026-11-10'), ['2026-11-11', '2026-11-12']);

  const {t, p} = setup();
  const a = t.createItem({projectId: p.id, title: 'Standup', due: TODAY, recur: {every: 1, unit: 'day', mode: 'schedule', count: 1}});
  t.updateItem(a.id, {status: 'done'});
  const second = t.listItems({projectId: p.id, open: true});
  assert.equal(second.length, 1);
  assert.equal(second[0].recur, null, 'last occurrence has no rule');
  t.updateItem(second[0].id, {status: 'done'});
  assert.equal(t.listItems({projectId: p.id, open: true}).length, 0, 'count reached, nothing new');

  const b = t.createItem({projectId: p.id, title: 'Water plants', due: TODAY, recur: {every: 1, unit: 'week', mode: 'schedule', reopen: true}});
  t.updateItem(b.id, {status: 'done'});
  const again = t.item(b.id);
  assert.equal(again.completed, null);
  assert.equal(again.due, '2026-11-17');
});

test('history saves every change and reverts edits, creates and deletes', () => {
  const {t, dave, p} = setup();
  const a = t.createItem({projectId: p.id, title: 'A', due: '2026-11-12'}, dave.id);
  const kid = t.createItem({projectId: p.id, title: 'Kid', parentId: a.id}, dave.id);
  t.updateItem(a.id, {due: '2026-11-20', title: 'A2'}, dave.id);
  const edit = t.listActivity({itemId: a.id})[0];
  assert.equal(edit.kind, 'update');
  assert.deepEqual(edit.before, {due: '2026-11-12', title: 'A'});
  t.revert(edit.id);
  assert.equal(t.item(a.id).due, '2026-11-12');
  assert.equal(t.item(a.id).title, 'A');
  t.deleteItem(a.id, dave.id);
  const del = t.listActivity({projectId: p.id}).find(x => x.kind === 'delete')!;
  assert.deepEqual(t.revert(del.id), {restored: 2});
  assert.equal(t.item(kid.id).parentId, a.id, 'same ids come back');
  const created = t.listActivity({itemId: kid.id}).find(x => x.kind === 'create')!;
  t.revert(created.id);
  assert.throws(() => t.item(kid.id), /not found/);
});

test('subitems inherit chosen parent fields; apply to children pushes changes down', () => {
  const {t, dave, sam, p} = setup();
  const s1 = t.createSprint({projectId: p.id, start: '2026-11-09'});
  t.updateProject(p.id, {settings: {...t.project(p.id).settings, inherit: ['sprint', 'assignees', 'priority', 'tags']}});
  const parent = t.createItem({projectId: p.id, title: 'Story', sprint: s1.id, assignees: [dave.id], priority: 2, tags: ['web']});
  const kid = t.quickAdd({projectId: p.id, text: 'Task #extra', parentId: parent.id});
  assert.equal(kid.sprint, s1.id);
  assert.deepEqual(kid.assignees, [dave.id]);
  assert.equal(kid.priority, 2);
  assert.deepEqual(kid.tags.sort(), ['extra', 'web']);
  const own = t.quickAdd({projectId: p.id, text: 'Own @sam', parentId: parent.id});
  assert.deepEqual(own.assignees, [sam.id], 'explicit value wins');
  t.updateItem(parent.id, {priority: 1});
  assert.equal(t.applyToChildren(parent.id, ['priority']).updated, 2);
  assert.equal(t.item(kid.id).priority, 1);
});

test('item and project templates', () => {
  const {t, p} = setup();
  const root = t.createItem({projectId: p.id, title: 'Release', type: 'Feature', start: '2026-11-10', due: '2026-11-13'});
  t.createItem({projectId: p.id, title: 'QA', parentId: root.id});
  t.createItem({projectId: p.id, title: 'Deploy', parentId: root.id});
  const tpl = t.saveItemTemplate(root.id, 'Release checklist');
  const made = t.useItemTemplate(tpl.id, p.id, null, null, {title: 'Release 2', due: '2026-12-04'});
  assert.equal(made.title, 'Release 2');
  assert.equal(made.start, '2026-12-01', 'keeps the duration');
  assert.deepEqual(t.listItems({parentId: made.id}).map(i => i.title), ['QA', 'Deploy']);
  t.updateProject(p.id, {settings: {...t.project(p.id).settings, autoRollover: true}});
  const pt = t.saveProjectTemplate(p.id, 'Web setup', false);
  const np = t.createProjectFromTemplate(pt.id, 'Web 2');
  assert.equal(np.settings.autoRollover, true);
  assert.equal(t.listViews(np.id).length, t.listViews(p.id).length);
  assert.equal(t.listItems({projectId: np.id}).length, 0);
});

test('automations: status rule, close parent when all children close, due-passed once', () => {
  const {t, dave, p} = setup();
  t.updateProject(p.id, {settings: {...t.project(p.id).settings, automations: [
    {id: 'r1', name: 'Bugs go to Dave', enabled: true, trigger: {kind: 'created'}, conditions: [{field: 'type', value: 'Bug'}], actions: [{kind: 'assign', value: dave.id}, {kind: 'priority', value: 1}]},
    {id: 'r2', name: 'Close parent', enabled: true, trigger: {kind: 'completed'}, conditions: [], actions: [{kind: 'parent-status', value: 'done'}]},
    {id: 'r3', name: 'Overdue tag', enabled: true, trigger: {kind: 'due-passed'}, conditions: [], actions: [{kind: 'tag', value: 'late'}]},
  ]}});
  const bug = t.createItem({projectId: p.id, title: 'Crash', type: 'Bug'});
  assert.deepEqual(t.item(bug.id).assignees, [dave.id]);
  assert.equal(t.item(bug.id).priority, 1);
  const story = t.createItem({projectId: p.id, title: 'Story'});
  const k1 = t.createItem({projectId: p.id, title: 'k1', parentId: story.id});
  const k2 = t.createItem({projectId: p.id, title: 'k2', parentId: story.id});
  t.updateItem(k1.id, {status: 'done'});
  assert.equal(t.item(story.id).completed, null, 'not until all are done');
  t.updateItem(k2.id, {status: 'done'});
  assert.ok(t.item(story.id).completed);
  const late = t.createItem({projectId: p.id, title: 'Late', due: '2026-11-01'});
  t.periodic(); t.periodic();
  assert.deepEqual(t.item(late.id).tags, ['late']);
});

test('quick add sprint shortcuts', () => {
  const {t, p} = setup();
  const s1 = t.createSprint({projectId: p.id, start: '2026-11-09'});
  assert.equal(t.quickAdd({projectId: p.id, text: 'A sprint:now'}).sprint, s1.id);
  const b = t.quickAdd({projectId: p.id, text: 'B sprint:next'});
  assert.ok(b.sprint && b.sprint !== s1.id, 'creates the next sprint');
});

test('AI work loop: claim, accept, log, submit, send back, resubmit, approve', async () => {
  const {migrateAiWork} = await import('../server/aiwork.ts');
  const {t, dave, p} = setup();
  migrateAiWork(t);
  const bot = t.createPerson({name: 'Claude'});
  t.db.prepare("update people set kind = 'ai' where id = ?").run(bot.id);
  const task = t.createItem({projectId: p.id, title: 'Research vendor pricing', fields: {worker: 'ai'}}, dave.id);
  const human = t.createItem({projectId: p.id, title: 'Sign contract', fields: {worker: 'human'}});
  assert.throws(() => t.claimTask(human.id, bot.id), /marked for a human/);
  assert.deepEqual(t.aiQueue(bot.id).map(x => x.item.title), ['Research vendor pricing']);
  t.claimTask(task.id, bot.id, 'I can do this today');
  assert.throws(() => t.submitWork(task.id, bot.id, 'early'), /accepts your claim/);
  t.decideClaim(task.id, dave.id, true);
  assert.deepEqual(t.item(task.id).assignees, [bot.id]);
  assert.equal(t.item(task.id).status, 'doing');
  t.logWork(task.id, bot.id, 'link', 'Price sheet', 'https://example.com/prices');
  t.submitWork(task.id, bot.id, 'Found 3 vendors', 'Could not reach vendor C');
  assert.equal(t.item(task.id).status, 'review');
  t.reviewWork(task.id, dave.id, false, 'Add shipping costs');
  assert.equal((t.item(task.id).fields.review as {state: string}).state, 'changes');
  assert.match(t.listComments(task.id)[0].body, /shipping/);
  t.submitWork(task.id, bot.id, 'Added shipping');
  assert.throws(() => t.updateItem(task.id, {status: 'done'}, bot.id), /cannot mark work done/);
  t.reviewWork(task.id, dave.id, true);
  assert.ok(t.item(task.id).completed);
  const kinds = t.workLog(task.id).map(e => e.kind);
  assert.deepEqual(kinds, ['note', 'review', 'link', 'result', 'missed', 'review', 'result', 'review']);
});

test('template packs: gallery install with worker flags and offsets, export without people, import', () => {
  const {t, dave, p} = setup();
  const r = t.installPack({gallery: 'Vendor onboarding'}, p.id);
  assert.equal(r.installed, 1);
  const made = t.useItemTemplate(r.templates[0].id, p.id, null, null, {title: 'Acme Medical', due: '2026-11-24'});
  assert.equal(made.title, 'Onboard vendor: Acme Medical');
  const kids = t.listItems({parentId: made.id}).sort((a, b) => a.sort - b.sort);
  assert.equal(kids.length, 8);
  assert.equal(kids[0].fields.worker, 'ai');
  assert.equal(kids[3].fields.worker, 'human');
  assert.equal(kids[0].due, '2026-11-10', 'offset 0 from start');
  t.updateItem(made.id, {assignees: [dave.id]});
  const saved = t.saveItemTemplate(made.id, 'Mine');
  const pack = JSON.parse(JSON.stringify(t.exportPack([saved.id], 'Share')));
  assert.ok(!JSON.stringify(pack).includes(dave.id), 'people stripped');
  assert.equal(t.installPack(pack).installed, 1);
  assert.throws(() => t.installPack({app: 'x'} as never), /Not a Cadence template pack/);
  const routines = t.installPack({gallery: 'Business and compliance routines'});
  assert.ok(routines.installed >= 10);
});

test('email to task and cumulative flow', () => {
  const {t, sam, p} = setup();
  const it = t.fromEmail({projectId: p.id, subject: 'Fwd: Renew COI @sam due:fri', body: 'Please renew.', from: 'broker@x.com'}, null);
  assert.equal(it.title, 'Renew COI');
  assert.deepEqual(it.assignees, [sam.id]);
  assert.ok(it.tags.includes('email'));
  assert.match(it.body, /broker@x.com/);
  t.updateItem(it.id, {status: 'doing'});
  const flow = t.flow(p.id, 3);
  assert.equal(flow.length, 3);
  const last = flow.at(-1)!;
  assert.equal(last.doing, 1);
});

test('approvals: request, sign with password, changes keep it open, AI cannot sign, workflow rules block closing', async () => {
  const {migrateApprovals} = await import('../server/approvals.ts');
  const {migrateAiWork} = await import('../server/aiwork.ts');
  const {hashPassword} = await import('../server/auth.ts');
  const {t, dave, sam, p} = setup();
  migrateApprovals(t); migrateAiWork(t);
  for (const col of ['password text']) { try { t.db.exec(`alter table people add column ${col}`); } catch { /* exists */ } }
  t.db.prepare('update people set password = ? where id = ?').run(hashPassword('dave password'), dave.id);
  t.updateProject(p.id, {settings: {...t.project(p.id).settings, workflow: {Task: {required: ['assignees', 'estimate'], requireApproval: true, transitions: {todo: ['doing'], doing: ['review', 'todo'], review: ['done', 'doing']}}}}});
  const it = t.createItem({projectId: p.id, title: 'Design review'});
  assert.throws(() => t.updateItem(it.id, {status: 'done'}), /cannot move from To do to Done/);
  t.updateItem(it.id, {status: 'doing'}); t.updateItem(it.id, {status: 'review'});
  assert.throws(() => t.updateItem(it.id, {status: 'done'}), /add an owner, an estimate/);
  t.updateItem(it.id, {assignees: [sam.id], estimate: 2});
  assert.throws(() => t.updateItem(it.id, {status: 'done'}), /Request approval first/);
  const [ap] = t.requestApproval(it.id, sam.id, [dave.id], 'approved');
  const bot = t.createPerson({name: 'Bot'}); t.db.prepare("update people set kind = 'ai' where id = ?").run(bot.id);
  assert.throws(() => t.requestApproval(it.id, sam.id, [bot.id], 'approved'), /cannot be approvers/);
  assert.throws(() => t.signApproval(ap.id, sam.id, 'approved'), /named approver/);
  assert.throws(() => t.signApproval(ap.id, dave.id, 'approved', '', 'wrong'), /Password is wrong/);
  t.signApproval(ap.id, dave.id, 'approved', 'Looks right', 'dave password');
  assert.equal(t.approvalState(it.id)?.complete, true);
  t.updateItem(it.id, {title: 'Design review v2'});
  assert.throws(() => t.updateItem(it.id, {status: 'done'}), /changed after it was signed/);
  const [ap2] = t.requestApproval(it.id, sam.id, [dave.id], 'approved');
  t.signApproval(ap2.id, dave.id, 'approved', '', 'dave password');
  t.updateItem(it.id, {status: 'done'});
  assert.ok(t.item(it.id).completed);
  const signed = t.listApprovals({itemId: it.id}).filter(a => a.decision === 'approved');
  assert.ok(signed.every(a => a.passwordChecked && a.signerName === 'David' && a.fingerprint));
});

test('nesting rejects cycles and delete removes descendants', () => {
  const {t, p} = setup();
  const a = t.createItem({projectId: p.id, title: 'Epic'});
  const b = t.createItem({projectId: p.id, title: 'Story', parentId: a.id});
  const c = t.createItem({projectId: p.id, title: 'Task', parentId: b.id});
  assert.throws(() => t.updateItem(a.id, {parentId: c.id}), /under itself/);
  assert.equal(t.deleteItem(a.id).deleted, 3);
});

test('invalid status is rejected with valid options', () => {
  const {t, p} = setup();
  assert.throws(() => t.createItem({projectId: p.id, title: 'x', status: 'nope'}), /Valid: todo, doing, review, done/);
});

test('my work buckets by due date', () => {
  const {t, dave, p} = setup();
  for (const [title, due] of [['late', '2026-11-01'], ['now', TODAY], ['soon', '2026-11-14'], ['far', '2027-01-01'], ['none', null]] as const)
    t.createItem({projectId: p.id, title, due, assignees: [dave.id]});
  const w = t.myWork(dave.id);
  assert.deepEqual(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v.map(i => i.title)])),
    {overdue: ['late'], today: ['now'], thisWeek: ['soon'], later: ['far'], noDate: ['none']});
});

test('timer: one running per person, stop records the time', () => {
  const {t, dave, p} = setup();
  const a = t.createItem({projectId: p.id, title: 'A'}), b = t.createItem({projectId: p.id, title: 'B'});
  t.startTimer(a.id, dave.id);
  t.db.prepare('update time_entries set start = ? where end is null').run(new Date(Date.now() - 120_000).toISOString());
  t.startTimer(b.id, dave.id);
  assert.equal(t.runningTimer(dave.id)?.itemId, b.id);
  assert.ok(Math.abs(t.listTime({itemId: a.id})[0].minutes! - 2) < 0.05);
});

test('MCP: agent creates, updates by key and summarizes', async () => {
  const {t, p} = setup();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createMcpServer(t, 'David').connect(st);
  const client = new Client({name: 'test', version: '1'});
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({name, arguments: args});
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  const created = await call('quick_add', {project: 'WEB', lines: ['Plan launch @sam !urgent due:fri', 'Write copy']});
  assert.equal(created.length, 2);
  await call('update_item', {item: 'WEB-2', parent: 'WEB-1', assignees: ['Sam']});
  const got = await call('get_item', {item: 'WEB-1'});
  assert.equal(got.children[0].title, 'Write copy');
  const sum = await call('project_summary', {project: 'WEB'});
  assert.equal(sum.openByPerson['Sam Lee'], 2);
  await assert.rejects(call('update_item', {item: 'WEB-1', status: 'bogus'}), /Valid/);
  assert.equal(t.listItems({projectId: p.id}).length, 2);
});

test('dependencies reject loops and are cleaned up on delete', () => {
  const {t, p} = setup();
  const a = t.createItem({projectId: p.id, title: 'A'}), b = t.createItem({projectId: p.id, title: 'B'}), c = t.createItem({projectId: p.id, title: 'C'});
  t.updateItem(b.id, {deps: [a.id]});
  t.updateItem(c.id, {deps: [b.id]});
  assert.throws(() => t.updateItem(a.id, {deps: [c.id]}), /loop/);
  assert.throws(() => t.updateItem(a.id, {deps: [a.id]}), /loop/);
  t.deleteItem(b.id);
  assert.deepEqual(t.item(c.id).deps, []);
});

test('start after due is rejected', () => {
  const {t, p} = setup();
  const a = t.createItem({projectId: p.id, title: 'A', start: '2026-11-10', due: '2026-11-12'});
  assert.throws(() => t.updateItem(a.id, {start: '2026-11-20'}), /Start must be/);
});

test('sprints chain dates, burndown tracks completion, delete returns items to backlog', () => {
  const {t, p} = setup();
  const s1 = t.createSprint({projectId: p.id, start: '2026-11-09'});
  const s2 = t.createSprint({projectId: p.id});
  assert.equal(s1.end, '2026-11-22');
  assert.equal(s2.start, '2026-11-23');
  assert.equal(t.currentSprint(p.id)?.id, s1.id);
  const a = t.createItem({projectId: p.id, title: 'A', sprint: s1.id, estimate: 3});
  t.createItem({projectId: p.id, title: 'B', sprint: s1.id, estimate: 5});
  t.updateItem(a.id, {status: 'done'});
  const burn = t.burndown(s1.id);
  assert.equal(burn.length, 14);
  assert.equal(burn[0].ideal, 2);
  const today = burn.find(x => x.date === TODAY)!;
  assert.equal(today.remaining, 1);
  assert.equal(today.remainingHours, 5);
  assert.ok(Number.isNaN(burn.at(-1)!.remaining), 'future days are blank');
  t.deleteSprint(s1.id);
  assert.equal(t.item(a.id).sprint, null);
});

test('rollover moves unfinished sprint work to the next sprint', () => {
  const {t, p} = setup();
  const s1 = t.createSprint({projectId: p.id, start: '2026-11-09'});
  const a = t.createItem({projectId: p.id, title: 'A', sprint: s1.id});
  const b = t.createItem({projectId: p.id, title: 'B', sprint: s1.id});
  t.updateItem(a.id, {status: 'done'});
  const r = t.rolloverSprint(s1.id);
  assert.equal(r.moved, 1);
  assert.equal(t.item(b.id).sprint, r.to.id);
  assert.equal(t.item(a.id).sprint, s1.id, 'done work stays');
});

test('projects get default views; views are editable', () => {
  const {t, p} = setup();
  const views = t.listViews(p.id);
  assert.deepEqual(views.map(v => v.kind), ['list', 'table', 'board', 'gantt', 'calendar', 'backlog', 'sprint']);
  const v = t.updateView(views[1].id, {name: 'Bugs', config: {types: ['Bug']}});
  assert.equal(t.listViews(p.id)[1].name, 'Bugs');
  t.deleteView(v.id);
  assert.equal(t.listViews(p.id).length, 6);
});

test('export and import round trip, with a snapshot taken before restore', async () => {
  const {mkdtempSync, existsSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  process.env.TASKS_BACKUPS = mkdtempSync(join(tmpdir(), 'tasks-bk-'));
  const {exportAll, importAll} = await import('../server/backup.ts');
  const {t, p} = setup();
  t.createItem({projectId: p.id, title: 'Keep me', recur: {every: 1, unit: 'week', mode: 'schedule'}});
  t.listViews(p.id);
  const dump = JSON.parse(JSON.stringify(exportAll(t.db)));
  t.createItem({projectId: p.id, title: 'Added after export'});
  const r = importAll(t.db, dump);
  assert.ok(existsSync(r.snapshotBefore));
  assert.deepEqual(t.listItems({projectId: p.id}).map(i => i.title), ['Keep me']);
  assert.equal(t.listViews(p.id).length, 7);
  assert.throws(() => importAll(t.db, {} as never), /Not a Cadence export/);
});

test('backup retention keeps recent, then one per day, week and month', async () => {
  const {retention} = await import('../server/backup.ts');
  const snaps = Array.from({length: 120}, (_, n) => ({name: `s${n}`, bytes: 1, reason: 'auto', created: new Date(Date.UTC(2026, 10, 10, 12) - n * 12 * 3600_000).toISOString()}));
  snaps.push({name: 'manual', bytes: 1, reason: 'manual', created: '2025-01-01T00:00:00.000Z'});
  const kept = retention(snaps, {enabled: true, intervalHours: 12, keepRecent: 4, keepDaily: 7, keepWeekly: 4, keepMonthly: 3}).filter(s => s.keptAs);
  assert.ok(kept.some(s => s.name === 'manual'), 'manual never pruned');
  assert.equal(kept.filter(s => s.keptAs === 'recent').length, 4);
  assert.ok(kept.length < 25, `kept ${kept.length}`);
  const months = new Set(kept.filter(s => s.reason === 'auto').map(s => s.created.slice(0, 7)));
  assert.equal(months.size, 3);
});

test('QA2: AI cannot accept or approve, people hear about claims, copies drop review state, keys stay unique', async () => {
  const {migrateAiWork} = await import('../server/aiwork.ts');
  const {t, dave, p} = setup();
  migrateAiWork(t);
  const bot = t.createPerson({name: 'Claude'});
  t.db.prepare("update people set kind = 'ai' where id = ?").run(bot.id);
  const task = t.createItem({projectId: p.id, title: 'Draft SOP', fields: {worker: 'ai'}}, dave.id);
  t.claimTask(task.id, bot.id);
  assert.match(t.listNotifications(dave.id)[0].text, /asked to take/);
  assert.throws(() => t.decideClaim(task.id, bot.id, true), /Only a person/);
  t.decideClaim(task.id, dave.id, true);
  t.submitWork(task.id, bot.id, 'Done');
  assert.throws(() => t.reviewWork(task.id, bot.id, true), /Only a person/);
  const tpl = t.saveItemTemplate(task.id, 'SOP');
  assert.equal(JSON.stringify(tpl.data).includes('"review"'), false);
  const again = t.createProject({name: 'Web two', key: 'WEB'});
  assert.equal(again.key, 'WEB2');
  assert.throws(() => t.updateProject(again.id, {key: 'WEB'}), /already used/);
  const dup = t.createItem({projectId: p.id, title: 'x', assignees: [dave.id, dave.id]});
  assert.deepEqual(dup.assignees, [dave.id]);
});

test('templates: build from scratch, relative dates, steps follow parent or previous step, edit and validate', () => {
  const {t, p} = setup();
  const tpl = t.createTemplate({kind: 'item', name: 'Launch', data: {type: 'Feature', title: 'Launch {name}', days: 20, children: [
    {type: 'Task', title: 'Plan', anchor: 'start', offset: 0, days: 2},
    {type: 'Task', title: 'Build', anchor: 'after', offset: 0, days: 5},
    {type: 'Task', title: 'Fixed review', anchor: 'none'},
  ]}});
  const made = t.useItemTemplate(tpl.id, p.id, null, null, {title: 'v2', start: '2026-12-01'});
  assert.equal(made.title, 'Launch v2');
  assert.equal(made.due, '2026-12-21');
  const [plan, build, review] = t.listItems({parentId: made.id}).sort((a, b) => a.sort - b.sort);
  assert.deepEqual([plan.start, plan.due, build.start, build.due, review.due], ['2026-12-01', '2026-12-03', '2026-12-04', '2026-12-09', null]);
  assert.deepEqual(build.deps, [plan.id]);
  t.updateItem(made.id, {start: '2026-12-08', due: '2026-12-28'});
  assert.equal(t.item(plan.id).start, '2026-12-08', 'moves with parent');
  assert.equal(t.item(build.id).start, '2026-12-11', 'follows the step before it');
  t.updateItem(plan.id, {due: '2026-12-12'});
  assert.equal(t.item(build.id).start, '2026-12-13', 'plan ran 2 days long, build slides 2 days');
  const saved = t.saveItemTemplate(made.id, 'Again');
  const kids = (saved.data as {children: {anchor: string; offset?: number}[]}).children;
  assert.deepEqual(kids.map(k => k.anchor), ['start', 'after', 'none']);
  assert.throws(() => t.updateTemplate(tpl.id, {data: {title: ''}}), /needs a title/);
  assert.throws(() => t.updateTemplate(tpl.id, {data: {title: 'x', anchor: 'soon'}}), /start, after or none/);
  t.updateTemplate(tpl.id, {name: 'Launch plan'});
  assert.equal(t.getTemplate(tpl.id).name, 'Launch plan');
  const proj = t.createTemplate({kind: 'project', name: 'Board setup'});
  assert.throws(() => t.updateTemplate(proj.id, {data: {...(proj.data as object), statuses: [{id: 'a', name: 'A', category: 'todo'}]}}), /done category/);
  assert.equal(t.duplicateTemplate(proj.id).name, 'Board setup (copy)');
});

test('formula columns: math, text, logic, dates and clear errors', async () => {
  const {evalFormula} = await import('../src/formula.ts');
  const cols: Record<string, string | number | boolean | null> = {cost: 12.5, qty: 4, done: false, due: '2026-11-20', name: 'Acme'};
  const get = (n: string) => { if (!(n.toLowerCase() in cols)) throw new Error(`No column named {${n}}`); return cols[n.toLowerCase()]; };
  const f = (s: string) => evalFormula(s, get, '2026-11-10');
  assert.equal(f('{Cost} * {Qty}'), 50);
  assert.equal(f('round({Cost} / 3, 2)'), 4.17);
  assert.equal(f('if({Done}, 0, days(today(), {Due}))'), 10);
  assert.equal(f('"Vendor: " + {Name}'), 'Vendor: Acme');
  assert.equal(f('{Qty} > 3 && !{Done}'), true);
  assert.equal(f('dateAdd({Due}, 15)'), '2026-12-05');
  assert.equal(f('{Cost} / 0'), null);
  assert.throws(() => f('{Missing} + 1'), /No column named/);
  assert.throws(() => f('nope(1)'), /Unknown function/);
  assert.throws(() => f('1 +'), /ends too soon/);
});

test('files as tasks: one task per file, file attached, listed per project; bad types refused and cleaned up', async () => {
  const {migrateAiWork} = await import('../server/aiwork.ts');
  const {mkdtempSync} = await import('node:fs'); const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const {t, dave, p} = setup();
  migrateAiWork(t);
  t.dataDir = mkdtempSync(join(tmpdir(), 'tasks-files-'));
  const data = Buffer.from('%PDF-1.4 test').toString('base64');
  const it = t.fileTask(p.id, dave.id, {name: 'Supplier_quality-agreement.pdf', mime: 'application/pdf', data});
  assert.equal(it.title, 'Supplier quality agreement');
  assert.deepEqual(it.tags, ['file']);
  assert.equal(t.itemFiles(it.id).length, 1);
  const doc = t.fileTask(p.id, dave.id, {name: 'Budget.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data});
  assert.deepEqual(t.projectFiles(p.id).map(f => f.name).sort(), ['Budget.xlsx', 'Supplier_quality-agreement.pdf']);
  const before = t.listItems({projectId: p.id}).length;
  assert.throws(() => t.fileTask(p.id, dave.id, {name: 'run.exe', mime: 'application/x-msdownload', data}), /Allowed files/);
  assert.equal(t.listItems({projectId: p.id}).length, before, 'no empty task left behind');
  void doc;
});

test('QA3: AI cannot fake review or create done work; rollups take no items; rules, sprints and templates validated', async () => {
  const {migrateAiWork} = await import('../server/aiwork.ts');
  const {t, dave, p} = setup();
  migrateAiWork(t);
  const bot = t.createPerson({name: 'Bot'});
  t.db.prepare("update people set kind = 'ai' where id = ?").run(bot.id);
  const task = t.createItem({projectId: p.id, title: 'Research', fields: {worker: 'ai'}}, dave.id);
  t.claimTask(task.id, bot.id);
  assert.throws(() => t.updateItem(task.id, {fields: {...t.item(task.id).fields, review: {state: 'accepted', by: bot.id, agent: bot.id, at: ''}}}, bot.id), /review state/);
  assert.throws(() => t.createItem({projectId: p.id, title: 'Sneaky', status: 'done'}, bot.id), /already done/);
  t.decideClaim(task.id, dave.id, true);
  t.submitWork(task.id, bot.id, 'Report');
  assert.equal((t.item(task.id).fields.review as {state: string}).state, 'submitted', 'the review tools still work');

  const roll = t.createRollup();
  assert.throws(() => t.createItem({projectId: roll.id, title: 'x'}), /shows work from other projects/);
  assert.throws(() => t.createItem({projectId: p.id, title: 'x', recur: {every: 0, unit: 'day', mode: 'schedule'}}), /from 1 to 1000/);
  assert.throws(() => t.createItem({projectId: p.id, title: 'x', recur: {every: 1, unit: 'decade' as never, mode: 'schedule'}}), /unit/);
  t.createSprint({projectId: p.id, name: 'S1', start: '2026-11-02', end: '2026-11-15'});
  assert.throws(() => t.createSprint({projectId: p.id, name: 'S2', start: '2026-11-10', end: '2026-11-20'}), /cannot overlap/);
  assert.throws(() => t.updateProject(p.id, {settings: {...t.project(p.id).settings, color: 'url(https://x.test/a.png)'}}), /Color/);
  const dup = t.updateItem(task.id, {assignees: [dave.id, dave.id]});
  assert.deepEqual(dup.assignees, [dave.id]);

  const before = t.listItems({projectId: p.id}).length;
  const bad = t.createTemplate({kind: 'item', name: 'ok', data: {type: 'Task', title: 'Parent', children: [{title: 'Step'}]}});
  t.db.prepare('update templates set data = ? where id = ?').run(JSON.stringify({type: 'Task', title: 'Parent', children: [{title: 'Fine'}, {title: 'Broken', priority: 99}]}), bad.id);
  assert.throws(() => t.useItemTemplate(bad.id, p.id, null), /Priority/);
  assert.equal(t.listItems({projectId: p.id}).length, before, 'nothing left behind');

  const parent = t.createItem({projectId: p.id, title: 'Parent', due: '2026-11-12'});
  const child = t.createItem({projectId: p.id, title: 'Child', parentId: parent.id, due: '2026-11-20', fields: {follow: 'parent'}});
  t.updateItem(parent.id, {start: '2026-11-12', due: '2026-11-20'}, null, {keep: true});
  assert.equal(t.item(child.id).due, '2026-11-20', 'stretching the parent leaves children in place');
});

test('view templates: save a view with its settings, add it to another project, reject bad data', () => {
  const {t, p} = setup();
  const v = t.createView({projectId: p.id, name: 'My board', kind: 'board', config: {groupBy: 'assignee', hideDone: true, sprint: 'x', baselines: []}});
  const tpl = t.saveViewTemplate(v.id, 'Team board', p.id);
  assert.deepEqual((tpl.data as {config: object}).config, {groupBy: 'assignee', hideDone: true});
  const other = t.createProject({name: 'Ops'});
  const made = t.useViewTemplate(tpl.id, other.id);
  assert.equal(made.kind, 'board');
  assert.equal(made.config.groupBy, 'assignee');
  assert.throws(() => t.createTemplate({kind: 'view', name: 'x', data: {name: 'x', kind: 'spreadsheet'}}), /View kind/);
});

test('assigned comments: notify the assignee, list until resolved', () => {
  const {t, dave, sam, p} = setup();
  const i = t.createItem({projectId: p.id, title: 'Budget'}, dave.id);
  const c = t.addComment(i.id, dave.id, 'Can you check the Q3 number?', sam.id);
  assert.match(t.listNotifications(sam.id)[0].text, /assigned you a comment/);
  assert.deepEqual(t.assignedComments(sam.id).map(x => x.id), [c.id]);
  t.resolveComment(c.id, sam.id, true);
  assert.equal(t.assignedComments(sam.id).length, 0);
  assert.ok(t.listComments(i.id)[0].resolved);
  assert.throws(() => t.addComment(i.id, dave.id, 'x', 'nobody'), /Unknown person|not found/i);
});

test('date shifting: skip weekends, and overlap-only mode for steps that follow', () => {
  const {t, p} = setup();
  t.updateProject(p.id, {settings: {...t.project(p.id).settings, dates: {skipWeekends: true}}});
  const parent = t.createItem({projectId: p.id, title: 'P', start: '2026-11-09', due: '2026-11-13'});
  const child = t.createItem({projectId: p.id, title: 'C', parentId: parent.id, start: '2026-11-10', due: '2026-11-11', fields: {follow: 'parent'}});
  t.updateItem(parent.id, {start: '2026-11-13', due: '2026-11-17'}); // +4 days: child would start Sat 11-14
  assert.deepEqual([t.item(child.id).start, t.item(child.id).due], ['2026-11-16', '2026-11-17'], 'Saturday rolls to Monday, length kept');
  t.updateProject(p.id, {settings: {...t.project(p.id).settings, dates: {shift: 'overlap'}}});
  const a = t.createItem({projectId: p.id, title: 'A', start: '2026-11-02', due: '2026-11-04'});
  const b = t.createItem({projectId: p.id, title: 'B', start: '2026-11-10', due: '2026-11-12', deps: [a.id], fields: {follow: 'previous'}});
  t.updateItem(a.id, {due: '2026-11-06'});
  assert.equal(t.item(b.id).start, '2026-11-10', 'still room, so B stays');
  t.updateItem(a.id, {due: '2026-11-11'});
  assert.equal(t.item(b.id).start, '2026-11-12', 'now overlapping, B starts the day after A');
});

test('timesheet: minutes per task per day; setting a day replaces its entries; zero clears', () => {
  const {t, dave, p} = setup();
  const a = t.createItem({projectId: p.id, title: 'A'});
  t.logTime({itemId: a.id, person: dave.id, minutes: 30, date: '2026-11-10'});
  t.logTime({itemId: a.id, person: dave.id, minutes: 15, date: '2026-11-10'});
  const week = t.timesheet(dave.id, '2026-11-09');
  assert.deepEqual(week.rows, [{itemId: a.id, minutes: [0, 45, 0, 0, 0, 0, 0]}]);
  t.setDayMinutes(dave.id, a.id, '2026-11-10', 120);
  assert.deepEqual(t.timesheet(dave.id, '2026-11-09').rows[0].minutes, [0, 120, 0, 0, 0, 0, 0]);
  t.setDayMinutes(dave.id, a.id, '2026-11-10', 0);
  assert.equal(t.timesheet(dave.id, '2026-11-09').rows.length, 0);
  assert.throws(() => t.setDayMinutes(dave.id, a.id, '2026-11-10', 2000), /0 to 24 hours/);
});

test('views: private views hidden from others, reorder in one call, templates drop owner and lock', () => {
  const {t, dave, sam, p} = setup();
  const before = t.listViews(p.id).length;
  const mine = t.createView({projectId: p.id, name: 'Mine', kind: 'list', config: {privateTo: dave.id, locked: true, hideDone: true}});
  assert.equal(t.listViews(p.id, sam.id).length, before);
  assert.equal(t.listViews(p.id, dave.id).length, before + 1);
  const ids = t.listViews(p.id).map(v => v.id).reverse();
  assert.deepEqual(t.reorderViews(p.id, ids).map(v => v.id), ids);
  const tpl = t.saveViewTemplate(mine.id, '', p.id);
  assert.deepEqual((tpl.data as {config: object}).config, {hideDone: true});
});

test('time: log by start and end, totals per item for the column, bad ranges refused', () => {
  const {t, dave, p} = setup();
  const i = t.createItem({projectId: p.id, title: 'Timed'}, dave.id);
  const e = t.logTime({itemId: i.id, person: dave.id, start: '2026-11-10T15:00:00.000Z', end: '2026-11-10T16:30:00.000Z', note: 'review'});
  assert.equal(e.minutes, 90);
  t.logTime({itemId: i.id, person: dave.id, minutes: 30});
  assert.deepEqual(t.timeTotals(i.id), {[i.id]: 120});
  assert.equal(t.timeTotals()[i.id], 120);
  assert.throws(() => t.logTime({itemId: i.id, person: dave.id, start: '2026-11-10T16:00:00Z', end: '2026-11-10T15:00:00Z'}), /end after the start/);
  assert.throws(() => t.logTime({itemId: i.id, person: dave.id, start: 'soon', end: 'later'}), /must be times/);
  assert.throws(() => t.logTime({itemId: i.id, person: dave.id, minutes: 0}), /positive/);
});

test('timing: AI work is timed from its first step to submit, reviews are timed, seconds are kept', async () => {
  const {migrateAiWork} = await import('../server/aiwork.ts');
  const {t, dave, p} = setup();
  migrateAiWork(t);
  const bot = t.createPerson({name: 'secretary-bot-1'});
  t.db.prepare("update people set kind = 'ai' where id = ?").run(bot.id);
  const task = t.createItem({projectId: p.id, title: 'Draft the summary', fields: {worker: 'ai'}}, dave.id);
  const back = (secs: number) => t.db.prepare('update time_entries set start = ? where end is null').run(new Date(Date.now() - secs * 1000).toISOString());
  t.claimTask(task.id, bot.id);
  t.decideClaim(task.id, dave.id, true);
  assert.equal(t.runningTimer(bot.id), null, 'accepting does not start the clock');
  t.logWork(task.id, bot.id, 'step', 'Read the sources');
  assert.equal(t.runningTimer(bot.id)?.itemId, task.id, 'first step starts it');
  back(95);
  t.submitWork(task.id, bot.id, 'Summary written, 2 pages');
  const ai = t.listTime({itemId: task.id, person: bot.id})[0];
  assert.ok(Math.abs(ai.minutes! - 95 / 60) < 0.05, 'kept to the second, not rounded up to whole minutes');
  assert.match(ai.note!, /^Submitted: Summary written/);
  // A person reviews: their review clock stops on the decision.
  t.startTimer(task.id, dave.id, 'review');
  back(40);
  t.reviewWork(task.id, dave.id, true, 'Looks good');
  const rv = t.listTime({itemId: task.id, person: dave.id})[0];
  assert.equal(rv.kind, 'review');
  assert.equal(rv.note, 'Review: approved');
  // A stop under a second leaves nothing behind.
  t.startTimer(task.id, dave.id);
  assert.equal(t.stopTimer(dave.id), null);
  assert.equal(t.listTime({itemId: task.id, person: dave.id}).length, 1);
});
