// Outbound webhooks, the automation triggers and actions built on them, and inbound actions.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {startWebhooks} from '../server/webhooks.ts';
import {migrateAiWork} from '../server/aiwork.ts';
import {migrateApprovals} from '../server/approvals.ts';
import {apiMiddleware} from '../server/api.ts';
import {createToken} from '../server/tokens.ts';
import {HOOK_EVENTS} from '../src/hooks.ts';
import type {Rule} from '../src/types.ts';

process.env.TASKS_BACKUPS = mkdtempSync(join(tmpdir(), 'tasks-hooks-'));
const TODAY = '2026-11-10'; // a Tuesday
type Sent = {url: string; headers: Record<string, string>; body: string; json: any};

function setup(today = () => TODAY) {
  const t = new Tasks(openDb(':memory:'), today);
  migrateAiWork(t);
  migrateApprovals(t);
  const dave = t.createPerson({name: 'David'}), sam = t.createPerson({name: 'Sam Lee'});
  const p = t.createProject({name: 'Web', key: 'WEB'});
  const sent: Sent[] = [], state = {fail: 0, safe: true};
  const hooks = startWebhooks(t, {timer: false, safe: async () => state.safe, send: async (url, init) => {
    sent.push({url, ...init, json: JSON.parse(init.body)});
    if (state.fail > 0) { state.fail--; return {ok: false, status: 500}; }
    return {ok: true, status: 200};
  }});
  const names: string[] = [];
  t.onEvent(e => names.push(e.event));
  const hook = (scope: string, h: Record<string, unknown>) => t.setWebhooks(scope, {webhooks: [...t.webhooks(scope).webhooks, {name: 'Hook', events: [], active: true, ...h}]}).webhooks.at(-1)!;
  const rule = (r: Partial<Rule> & Pick<Rule, 'trigger' | 'actions'>): Rule => ({id: 'r' + Math.random().toString(36).slice(2, 8), name: 'Rule', enabled: true, conditions: [], ...r});
  const setRules = (rules: Rule[]) => t.updateProject(p.id, {settings: {...t.project(p.id).settings, automations: rules}}).settings.automations;
  return {t, dave, sam, p, sent, state, hooks, names, hook, rule, setRules};
}

test('a space webhook gets a signed envelope, only for the events it lists; the secret never comes back', async () => {
  const {t, dave, p, sent, hooks, hook} = setup();
  const h = hook(p.id, {name: 'Zap', url: 'https://example.test/in', secret: 's3cret', events: ['item.created']});
  assert.equal(h.hasSecret, true);
  assert.ok(!JSON.stringify(t.project(p.id).settings).includes('s3cret'), 'the secret is kept out of the space settings');
  const item = t.createItem({projectId: p.id, title: 'First'}, dave.id);
  t.updateItem(item.id, {title: 'Renamed'}, dave.id);
  await hooks.run();
  assert.equal(sent.length, 1);
  const {headers, body, json} = sent[0];
  assert.equal(headers['x-cadence-event'], 'item.created');
  assert.equal(headers['x-cadence-delivery'], json.id);
  assert.equal(headers['x-cadence-signature'], 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex'));
  assert.deepEqual(Object.keys(json).slice(0, 7), ['id', 'event', 'at', 'workspace', 'project', 'item', 'actor']);
  assert.deepEqual([json.event, json.workspace, json.project, json.item.title, json.actor], ['item.created', 'main', {id: p.id, key: 'WEB', name: 'Web'}, 'First', dave.id]);
  // Saving the list again without a secret keeps it; an empty one removes it.
  assert.equal(t.setWebhooks(p.id, {webhooks: t.webhooks(p.id).webhooks}).webhooks[0].hasSecret, true);
  assert.equal(t.setWebhooks(p.id, {webhooks: [{...t.webhooks(p.id).webhooks[0], secret: ''}]}).webhooks[0].hasSecret, undefined);
  t.createItem({projectId: p.id, title: 'Unsigned'}, dave.id);
  await hooks.run();
  assert.equal(sent[1].headers['x-cadence-signature'], undefined);
  assert.throws(() => hook(p.id, {url: 'ftp://nope'}), /http/);
  assert.throws(() => hook(p.id, {url: 'https://example.test', events: ['item.exploded']}), /Unknown webhook event/);
});

test('old {id, url, events} webhooks keep working and get the events they got before', async () => {
  const {t, dave, sent, hooks} = setup();
  const old = t.createProject({name: 'Old', key: 'OLD', settings: {webhooks: [{id: 'a1', url: 'https://example.test/old', events: []}]}});
  const i = t.createItem({projectId: old.id, title: 'A'}, dave.id);
  t.addComment(i.id, dave.id, 'hello');
  t.updateItem(i.id, {status: 'done'}, dave.id);
  await hooks.run();
  assert.deepEqual(sent.map(s => s.json.event).sort(), ['item.completed', 'item.created', 'item.updated']);
  assert.deepEqual(sent.find(s => s.json.event === 'item.updated')!.json.changes.after.status, 'done');
});

test('workspace webhooks hear every space except private ones; switched off means silent', async () => {
  const {t, dave, p, sent, hooks, hook} = setup();
  hook('workspace', {name: 'All', url: 'https://example.test/all', events: ['item.created', 'project.created']});
  hook('workspace', {name: 'Off', url: 'https://example.test/off', active: false});
  const other = t.createProject({name: 'Ops', key: 'OPS'});
  const mine = t.createProject({name: 'Mine', key: 'MINE', settings: {access: {default: 'none', members: {[dave.id]: 'admin'}, private: true}}});
  for (const pid of [p.id, other.id, mine.id]) t.createItem({projectId: pid, title: 'X'}, dave.id);
  await hooks.run();
  assert.ok(sent.every(s => s.url.endsWith('/all')));
  assert.deepEqual(sent.map(s => `${s.json.event} ${s.json.project.key}`), ['project.created OPS', 'item.created WEB', 'item.created OPS']);
});

test('failed deliveries retry after 1, 5 and 30 minutes with the same body, then stop; the log shows each', async () => {
  const {t, dave, p, sent, state, hooks, hook} = setup();
  const h = hook(p.id, {url: 'https://example.test/flaky', events: ['item.created']});
  state.fail = 2;
  t.createItem({projectId: p.id, title: 'Retry me'}, dave.id);
  const t0 = Date.now();
  await hooks.run(t0);
  assert.deepEqual(t.hookDeliveries(p.id, h.id).map(d => [d.status, d.attempts, d.code]), [['pending', 1, 500]]);
  await hooks.run(t0 + 30_000);
  assert.equal(sent.length, 1, 'not before a minute has passed');
  await hooks.run(t0 + 61_000);
  assert.equal(t.hookDeliveries(p.id, h.id)[0].attempts, 2);
  await hooks.run(t0 + 3 * 60_000);
  assert.equal(sent.length, 2, 'the second retry waits 5 minutes');
  await hooks.run(t0 + 7 * 60_000);
  assert.deepEqual(t.hookDeliveries(p.id, h.id).map(d => [d.status, d.attempts, d.code, d.error]), [['ok', 3, 200, null]]);
  assert.equal(new Set(sent.map(s => s.body)).size, 1, 'every attempt sends the same body');
  assert.equal(new Set(sent.map(s => s.headers['x-cadence-delivery'])).size, 1);

  state.fail = 99;
  t.createItem({projectId: p.id, title: 'Never'}, dave.id);
  for (const min of [0, 2, 8, 40, 80]) await hooks.run(t0 + min * 60_000);
  const d = t.hookDeliveries(p.id, h.id)[0];
  assert.deepEqual([d.status, d.attempts], ['failed', 4]);
  // Private and local addresses are refused, not retried.
  state.safe = false;
  t.createItem({projectId: p.id, title: 'Blocked'}, dave.id);
  await hooks.run();
  assert.match(t.hookDeliveries(p.id, h.id)[0].error ?? '', /private or local/);
  assert.equal(t.hookDeliveries(p.id, h.id)[0].status, 'failed');
  // Deliveries older than 14 days are pruned.
  t.db.prepare('update hook_deliveries set created = ?').run(new Date(Date.now() - 15 * 86400_000).toISOString());
  hooks.prune();
  assert.equal(t.hookDeliveries(p.id).length, 0);
});

test('a test event goes to one endpoint only', async () => {
  const {t, dave, p, sent, hooks, hook} = setup();
  const a = hook(p.id, {name: 'A', url: 'https://example.test/a', events: ['item.deleted']});
  hook(p.id, {name: 'B', url: 'https://example.test/b'});
  const d = t.testWebhook(p.id, a.id, dave.id);
  assert.deepEqual([d.event, d.status], ['webhook.test', 'pending']);
  await hooks.run();
  assert.deepEqual(sent.filter(s => s.json.event === 'webhook.test').map(s => [s.url, s.json.hook.name]), [['https://example.test/a', 'A']]);
  assert.equal(t.hookDeliveries(p.id, a.id)[0].status, 'ok');
});

test('changes, comments, time, sprints and routines each say what happened', () => {
  const {t, dave, sam, p, names} = setup();
  const said = (f: () => unknown) => { names.length = 0; f(); return names.filter(n => n !== 'notification.created' && n !== 'automation.ran'); };
  const i = t.createItem({projectId: p.id, title: 'A', assignees: [dave.id], due: '2026-11-20'}, dave.id);
  assert.deepEqual(said(() => t.updateItem(i.id, {status: 'done'}, dave.id)), ['item.updated', 'item.status_changed', 'item.completed']);
  assert.deepEqual(said(() => t.updateItem(i.id, {status: 'todo'}, dave.id)), ['item.updated', 'item.status_changed', 'item.reopened']);
  assert.deepEqual(said(() => t.updateItem(i.id, {assignees: [sam.id], due: '2026-11-21', priority: 2}, dave.id)), ['item.updated', 'item.assigned', 'item.unassigned', 'item.due_changed', 'item.priority_changed']);
  const parent = t.createItem({projectId: p.id, title: 'Parent'}, dave.id);
  assert.deepEqual(said(() => t.updateItem(i.id, {parentId: parent.id}, dave.id)), ['item.updated', 'item.moved']);
  assert.deepEqual(said(() => t.archiveItem(i.id, {}, dave.id)), ['item.updated', 'item.archived']);
  assert.deepEqual(said(() => t.restoreItem(i.id, dave.id)), ['item.updated', 'item.unarchived']);
  let c = t.addComment(i.id, dave.id, 'first');
  assert.deepEqual(said(() => { c = t.addComment(i.id, dave.id, 'Look @Sam'); }), ['comment.created', 'mention.created']);
  assert.deepEqual(said(() => t.resolveComment(c.id, dave.id, true)), ['comment.resolved']);
  assert.deepEqual(said(() => t.logTime({itemId: i.id, person: dave.id, minutes: 30})), ['time.logged']);
  assert.deepEqual(said(() => t.startTimer(i.id, dave.id)), ['timer.started']);
  const s = t.createSprint({projectId: p.id});
  t.updateItem(i.id, {sprint: s.id}, dave.id);
  assert.deepEqual(said(() => t.rolloverSprint(s.id, dave.id)), ['item.updated', 'sprint.rolled_over']);
  assert.deepEqual(said(() => t.requestApproval(i.id, dave.id, [sam.id], 'approved')).filter(n => n.startsWith('approval')), ['approval.requested']);
  const again = t.createItem({projectId: p.id, title: 'Weekly', due: TODAY, recur: {every: 1, unit: 'week', mode: 'schedule', reopen: true}}, dave.id);
  assert.deepEqual(said(() => t.updateItem(again.id, {status: 'done'}, dave.id)), ['item.updated', 'item.status_changed', 'item.completed', 'item.reopened', 'routine.spawned']);
  assert.deepEqual(said(() => t.routine(again.id, 'skip', dave.id)).at(-1), 'routine.skipped');
  assert.deepEqual(said(() => t.routine(again.id, 'end', dave.id)).at(-1), 'routine.ended');
  assert.deepEqual(said(() => t.deleteItem(i.id, dave.id)), ['item.deleted']);
  assert.deepEqual(said(() => t.deleteProject(p.id)), ['project.deleted']);
  for (const n of names) assert.ok(HOOK_EVENTS.some(e => e.key === n), `${n} is in the catalog`);
});

test('date events are sent once per item and date, and again when the date moves', () => {
  let today = TODAY;
  const {t, dave, p, names} = setup(() => today);
  const dated = () => names.filter(n => /^(item\.(due_|overdue|start_)|sprint\.)/.test(n));
  const i = t.createItem({projectId: p.id, title: 'A', due: '2026-11-12', start: '2026-11-11'}, dave.id);
  t.createSprint({projectId: p.id, start: '2026-11-10', end: '2026-11-13'});
  t.periodic(); t.periodic();
  assert.deepEqual(dated(), ['item.due_soon', 'sprint.started']); // 2 days left: the 3-day notice
  today = '2026-11-11'; names.length = 0; t.periodic(); t.periodic();
  assert.deepEqual(dated(), ['item.due_soon', 'item.start_reached', 'sprint.ending_soon']); // the 1-day notice
  today = '2026-11-12'; names.length = 0; t.periodic();
  assert.deepEqual(dated(), ['item.due_today']);
  today = '2026-11-14'; names.length = 0; t.periodic(); t.periodic();
  assert.deepEqual(dated(), ['item.overdue', 'sprint.ended']);
  t.updateItem(i.id, {due: '2026-11-13'}, dave.id); names.length = 0; t.periodic();
  assert.deepEqual(dated(), ['item.overdue'], 'a new due date is a new event');
  t.setWebhooks('workspace', {dueSoonDays: [7]});
  t.updateItem(i.id, {due: '2026-11-20'}, dave.id); names.length = 0; t.periodic();
  assert.deepEqual(dated(), ['item.due_soon']);
  assert.throws(() => t.setWebhooks('workspace', {dueSoonDays: [0]}), /whole numbers/);
});

test('upgrading a workspace does not replay dates that already passed', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tasks-upgrade-')), 'tasks.db');
  const old = new Tasks(openDb(file), () => TODAY);
  const p = old.createProject({name: 'Old', key: 'OLD', settings: {automations: [{id: 'late', name: 'Late', enabled: true, trigger: {kind: 'due-passed'}, conditions: [], actions: [{kind: 'tag', value: 'late'}]}]}});
  const i = old.createItem({projectId: p.id, title: 'Overdue for a while', due: '2026-11-01'});
  // As the version before left it: the rule ran once for this item, and the newer tables are not there.
  old.db.prepare('insert into rule_runs (rule_id, item_id) values (?, ?)').run('late', i.id);
  old.db.exec('drop table event_runs; drop table rule_fires');
  old.db.close();
  const t = new Tasks(openDb(file), () => TODAY);
  const names: string[] = [];
  t.onEvent(e => names.push(e.event));
  t.periodic();
  assert.deepEqual([t.item(i.id).tags, names.includes('item.overdue')], [[], false]);
  const j = t.createItem({projectId: p.id, title: 'Late from now on', due: '2026-11-09'});
  names.length = 0; t.periodic();
  assert.deepEqual([t.item(j.id).tags, names.filter(n => n === 'item.overdue').length], [['late'], 1]);
  t.db.close();
});

test('rules are checked when saved', () => {
  const {t, p, rule, setRules} = setup();
  const bad = (r: unknown, re: RegExp) => assert.throws(() => setRules([r as Rule]), re);
  bad(rule({trigger: {kind: 'exploded'} as never, actions: [{kind: 'tag', value: 'x'}]}), /unknown trigger "exploded"/);
  bad(rule({trigger: {kind: 'status', to: 'nope'}, actions: [{kind: 'tag', value: 'x'}]}), /status "nope" is not in this space/);
  bad(rule({trigger: {kind: 'due-soon', days: 0}, actions: [{kind: 'tag', value: 'x'}]}), /days must be a whole number/);
  bad(rule({trigger: {kind: 'review', to: 'meh'}, actions: [{kind: 'tag', value: 'x'}]}), /review state must be one of/);
  bad(rule({trigger: {kind: 'created'}, actions: [{kind: 'launch', value: 'x'} as never]}), /unknown action "launch"/);
  bad(rule({trigger: {kind: 'created'}, actions: [{kind: 'webhook', value: 'javascript:alert(1)'}]}), /webhook needs a URL/);
  bad(rule({trigger: {kind: 'created'}, actions: [{kind: 'priority', value: 9}]}), /priority must be 0 to 4/);
  bad(rule({trigger: {kind: 'created'}, actions: [{kind: 'assign', value: 'nobody'}]}), /person id/);
  bad(rule({trigger: {kind: 'created'}, actions: []}), /at least one action/);
  assert.equal(setRules([rule({trigger: {kind: 'created'}, actions: [{kind: 'tag', value: 'new'}]})]).length, 1);
  // Unrelated settings still save when nothing about the rules changed.
  assert.equal(t.updateProject(p.id, {settings: {...t.project(p.id).settings, autoRollover: true}}).settings.autoRollover, true);
});

test('the webhook action posts the rule, trigger and item, signed, through the delivery log', async () => {
  const {t, dave, p, sent, hooks, rule, setRules} = setup();
  const [r] = setRules([rule({name: 'Done to CRM', trigger: {kind: 'completed'}, actions: [{kind: 'webhook', value: 'https://example.test/crm', secret: 'k1'}]})]);
  assert.deepEqual(r.actions, [{kind: 'webhook', value: 'https://example.test/crm', hasSecret: true}]);
  const i = t.createItem({projectId: p.id, title: 'Ship'}, dave.id);
  t.updateItem(i.id, {status: 'done'}, dave.id);
  await hooks.run();
  assert.equal(sent.length, 1);
  const {json, headers, body} = sent[0];
  assert.deepEqual([json.event, json.rule, json.trigger, json.item.status, json.project.key], ['automation.webhook', {id: r.id, name: 'Done to CRM'}, {kind: 'completed'}, 'done', 'WEB']);
  assert.equal(headers['x-cadence-signature'], 'sha256=' + createHmac('sha256', 'k1').update(body).digest('hex'));
  assert.deepEqual(t.hookDeliveries(p.id).map(d => [d.hook, d.event, d.status]), [[`rule:${r.id}`, 'automation.webhook', 'ok']]);
});

test('date rules run once per date and again when the date changes', () => {
  let today = TODAY;
  const {t, dave, p, rule, setRules} = setup(() => today);
  setRules([
    rule({trigger: {kind: 'due-passed'}, actions: [{kind: 'tag', value: 'late'}]}),
    rule({trigger: {kind: 'due-soon', days: 2}, actions: [{kind: 'tag', value: 'soon'}]}),
    rule({trigger: {kind: 'due-today'}, actions: [{kind: 'tag', value: 'today'}]}),
    rule({trigger: {kind: 'overdue-by', days: 3}, actions: [{kind: 'tag', value: 'very-late'}]}),
    rule({trigger: {kind: 'start-reached'}, actions: [{kind: 'tag', value: 'started'}]}),
  ]);
  const i = t.createItem({projectId: p.id, title: 'A', due: '2026-11-13', start: '2026-11-12'}, dave.id);
  const tags = () => t.item(i.id).tags.join(' ');
  const clear = () => t.updateItem(i.id, {tags: []}, dave.id);
  t.periodic(); assert.equal(tags(), '');
  today = '2026-11-11'; t.periodic(); assert.equal(tags(), 'soon');
  today = '2026-11-12'; t.periodic(); assert.equal(tags(), 'soon started');
  today = '2026-11-13'; t.periodic(); assert.equal(tags(), 'soon started today');
  today = '2026-11-14'; t.periodic(); assert.equal(tags(), 'soon started today late');
  clear(); t.periodic(); assert.equal(tags(), '', 'not again for the same due date');
  today = '2026-11-16'; t.periodic(); assert.equal(tags(), 'very-late');
  // The due date moves: every date rule is armed again.
  clear(); t.updateItem(i.id, {due: '2026-11-18'}, dave.id);
  today = '2026-11-17'; t.periodic(); assert.equal(tags(), 'soon');
  today = '2026-11-19'; t.periodic(); assert.equal(tags(), 'soon late');
});

test('comment, unassign and review triggers; an inbound trigger passes its data to the webhook action', async () => {
  const {t, dave, sam, p, sent, hooks, rule, setRules} = setup();
  t.db.prepare("update people set kind = 'ai' where id = ?").run(sam.id);
  setRules([
    rule({trigger: {kind: 'comment-added'}, actions: [{kind: 'tag', value: 'talk'}]}),
    rule({trigger: {kind: 'unassigned'}, actions: [{kind: 'tag', value: 'dropped'}]}),
    rule({trigger: {kind: 'review', to: 'submitted'}, actions: [{kind: 'tag', value: 'check-me'}]}),
    rule({name: 'Deploy', trigger: {kind: 'webhook-received', key: 'deploy'}, actions: [{kind: 'webhook', value: 'https://example.test/out'}, {kind: 'priority', value: 1}]}),
  ]);
  const i = t.createItem({projectId: p.id, title: 'A', assignees: [dave.id, sam.id]}, dave.id);
  t.addComment(i.id, dave.id, 'hi');
  t.updateItem(i.id, {assignees: [sam.id]}, dave.id);
  t.submitWork(i.id, sam.id, 'Did it');
  assert.deepEqual(t.item(i.id).tags, ['talk', 'dropped', 'check-me']);
  assert.deepEqual(t.triggerHook(p.id, 'other', {}), {ran: []});
  assert.equal(t.triggerHook(p.id, 'deploy', {data: {version: '1.2'}}).ran[0].name, 'Deploy');
  t.triggerHook(p.id, 'deploy', {item: 'WEB-1', data: {version: '1.3'}});
  await hooks.run();
  assert.deepEqual(sent.map(s => [s.json.event, s.json.trigger, s.json.data, s.json.item?.title ?? null]),
    [['automation.webhook', {kind: 'webhook-received', key: 'deploy'}, {version: '1.2'}, null], ['automation.webhook', {kind: 'webhook-received', key: 'deploy'}, {version: '1.3'}, 'A']]);
  assert.equal(t.item(i.id).priority, 1, 'with an item, the other actions run on it');
});

test('a waiting routine tells the outside the moment its wait is over, and can be started at once', () => {
  const {t, dave, p, names, rule, setRules} = setup();
  setRules([
    rule({trigger: {kind: 'routine-resumed'}, actions: [{kind: 'webhook', value: 'https://example.test/started'}]}),
    rule({trigger: {kind: 'webhook-received', key: 'start-now'}, actions: [{kind: 'routine-resume'}]}),
  ]);
  const hire = t.createItem({projectId: p.id, title: 'Hire'}, dave.id);
  const mk = () => t.createItem({projectId: p.id, title: 'Payroll', due: '2026-11-01', recur: {every: 1, unit: 'month', mode: 'schedule'}}, dave.id);
  const a = mk(), b = mk();
  for (const r of [a, b]) assert.equal(t.routine(r.id, 'wait', dave.id, {on: [hire.id]}).recur?.waiting, true);
  assert.equal(names.filter(n => n === 'routine.waiting').length, 2);
  const pending = () => (t.db.prepare("select count(*) as n from hook_deliveries where event = 'automation.webhook'").get() as {n: number}).n;
  // By hand (the routine-resume action, here from an inbound trigger): no waiting for the hire.
  t.triggerHook(p.id, 'start-now', {item: b.id});
  assert.equal(t.item(b.id).recur?.waiting, undefined);
  assert.equal(pending(), 1);
  // By itself: finishing the hire releases the other one inside the same call.
  names.length = 0;
  t.updateItem(hire.id, {status: 'done'}, dave.id);
  assert.ok(names.includes('routine.resumed'));
  assert.equal(pending(), 2, 'queued before the completing call returns');
  // Its date is the next one on schedule from today, not today: that is how wait works.
  assert.deepEqual([t.item(a.id).recur?.waiting, t.item(a.id).due], [undefined, '2026-12-01']);
});

test('inbound actions run MCP tools as the token person', async () => {
  const tasks = new Tasks(openDb(':memory:'), () => TODAY);
  const mw = apiMiddleware(tasks);
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api/hooks/in/`;
  try {
    const admin = tasks.db.prepare('select id from people where admin = 1').get() as {id: string};
    const {token} = createToken(tasks.db, admin.id, 'zap');
    const call = async (action: string, body: unknown, auth: string | null = `Bearer ${token}`, query = '') => {
      const r = await fetch(base + action + query, {method: 'POST', headers: {'content-type': 'application/json', ...(auth ? {authorization: auth} : {})}, body: JSON.stringify(body)});
      return {status: r.status, json: await r.json()};
    };
    assert.equal((await call('create_item', {project: 'GS', title: 'No token'}, null)).status, 401);
    assert.equal((await call('create_item', {project: 'GS', title: 'Bad token'}, 'Bearer tt_wrong')).status, 401);
    assert.equal((await call('create_item', {project: 'GS', title: 'Token in URL'}, null, `?key=${token}`)).status, 401);
    const unknown = await call('explode', {});
    assert.equal(unknown.status, 404);
    assert.ok(unknown.json.actions.includes('create_item') && unknown.json.actions.includes('trigger'));
    const bad = await call('create_item', {project: 'GS'});
    assert.equal(bad.status, 400);
    assert.ok(bad.json.fields.some((f: {name: string; required: boolean}) => f.name === 'title' && f.required));
    assert.match(bad.json.problems.join(' '), /title/);

    const made = await call('create_item', {project: 'GS', title: 'From a webhook', due: '2026-11-20'});
    assert.deepEqual([made.status, made.json.title, made.json.createdBy], [200, 'From a webhook', admin.id]);
    assert.equal((await call('add_comment', {item: made.json.id, body: 'Synced'})).status, 200);
    assert.equal((await call('log_time', {item: made.json.id, minutes: 15})).json.minutes, 15);
    assert.equal((await call('complete_item', {item: made.json.id})).json.status, 'done');
    assert.equal((await call('get_item', {item: 'GS-999'})).status, 404);

    const gs = tasks.listProjects().find(p => p.key === 'GS')!;
    tasks.updateProject(gs.id, {settings: {...gs.settings, automations: [{id: 'r1', name: 'Flag', enabled: true, trigger: {kind: 'webhook-received', key: 'flag'}, conditions: [], actions: [{kind: 'tag', value: 'flagged'}]}]}});
    const fired = await call('trigger', {project: 'GS', key: 'flag', item: made.json.id, source: 'crm'});
    assert.deepEqual([fired.status, fired.json.ran], [200, [{id: 'r1', name: 'Flag'}]]);
    assert.ok(tasks.item(made.json.id).tags.includes('flagged'));

    // A member without the settings permission cannot read or change endpoints through the same door.
    const sam = tasks.listPeople().find(x => x.name === 'Sam')!;
    tasks.db.prepare("update people set role = 'viewer', admin = 0 where id = ?").run(sam.id);
    const viewer = `Bearer ${createToken(tasks.db, sam.id, 'v').token}`;
    assert.equal((await call('list_webhooks', {project: 'GS'}, viewer)).status, 403);
    assert.equal((await call('list_webhooks', {}, viewer)).status, 403);
    assert.equal((await call('create_item', {project: 'GS', title: 'Nope'}, viewer)).status, 403);
    assert.equal((await call('list_webhooks', {}, `Bearer ${token}`)).json.events.length, HOOK_EVENTS.length);
  } finally { server.close(); }
});
