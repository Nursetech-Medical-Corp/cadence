import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {apiMiddleware} from '../server/api.ts';
import {capsFor, getWorkspace, migrate, saveWorkspace} from '../server/auth.ts';
import {exportAll, importAll} from '../server/backup.ts';
import {jobRoleGrant, joinByDomain, type JobRole} from '../server/jobroles.ts';
import {guarded} from '../server/tokens.ts';

process.env.TASKS_BACKUPS = mkdtempSync(join(tmpdir(), 'tasks-jobroles-'));

const setup = () => {
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-10');
  migrate(tasks.db);
  const boss = tasks.createPerson({name: 'Boss', email: 'boss@co.test'}), rep = tasks.createPerson({name: 'Rep', email: 'rep@co.test'});
  tasks.db.prepare('update people set admin = 1 where id = ?').run(boss.id);
  tasks.db.prepare('update people set admin = 0, role = ? where id = ?').run('viewer', rep.id);
  const fin = tasks.createProject({name: 'Finance'}), sal = tasks.createProject({name: 'Sales'}), rnd = tasks.createProject({name: 'R&D'});
  saveWorkspace(tasks.db, {requireLogin: true});
  return {tasks, boss, rep, fin, sal, rnd};
};
const can = (t: Tasks, person: string, pid: string) => capsFor(t.db, person, (t.project(pid).settings as {access?: never}).access, true, pid);

test('job role grant: strongest level wins, none only when every job role says none, silence falls through', () => {
  const jr: JobRole[] = [{id: 'a', name: 'A', spaces: {p1: 'viewer'}, others: 'inherit'}, {id: 'b', name: 'B', spaces: {p1: 'editor', p2: 'none'}, others: 'none'}];
  assert.deepEqual(jobRoleGrant(jr, ['a', 'b'], 'p1'), ['viewer', 'editor']);
  assert.equal(jobRoleGrant(jr, ['b'], 'p2'), 'none');
  assert.equal(jobRoleGrant(jr, ['a'], 'p2'), undefined, 'a says nothing about p2');
  assert.equal(jobRoleGrant(jr, ['b'], 'p3'), 'none', 'others: none covers unlisted spaces');
  assert.equal(jobRoleGrant(jr, [], 'p1'), undefined);
});

test('job roles decide space access; a per-person entry on the space still wins; admins and personal spaces', () => {
  const {tasks, boss, rep, fin, sal, rnd} = setup();
  saveWorkspace(tasks.db, {jobRoles: [{id: 'sales-rep', name: 'Sales rep', spaces: {[sal.id]: 'editor', [fin.id]: 'none'}, others: 'inherit'}] as never});
  // Before the person has the job role: their default level (viewer) everywhere.
  assert.ok(can(tasks, rep.id, fin.id).has('view'));
  tasks.db.prepare('update people set job_roles = ? where id = ?').run('["sales-rep"]', rep.id);
  assert.equal(can(tasks, rep.id, fin.id).size, 0, 'Finance closed by the job role');
  assert.ok(can(tasks, rep.id, sal.id).has('edit'), 'Sales opened at Editor');
  assert.ok(can(tasks, rep.id, rnd.id).has('view') && !can(tasks, rep.id, rnd.id).has('edit'), 'unlisted space falls back to the default level');
  // A per-person entry on the space overrides the job role.
  tasks.updateProject(fin.id, {settings: {...tasks.project(fin.id).settings, access: {default: 'inherit', members: {[rep.id]: 'commenter'}}}});
  assert.ok(can(tasks, rep.id, fin.id).has('comment'));
  // Admins pass shared spaces but not someone else's personal space, and job roles never open personal spaces.
  const mine = tasks.createProject({name: 'Rep notes', settings: {access: {default: 'none', members: {[rep.id]: 'admin'}, private: true}}});
  saveWorkspace(tasks.db, {jobRoles: [{id: 'sales-rep', name: 'Sales rep', spaces: {[mine.id]: 'editor'}, others: 'editor'}] as never});
  assert.equal(can(tasks, boss.id, mine.id).size, 0, 'admin cannot open a personal space');
  assert.ok(can(tasks, boss.id, fin.id).has('settings'));
  // Unknown levels are refused.
  assert.throws(() => saveWorkspace(tasks.db, {jobRoles: [{name: 'X', spaces: {[sal.id]: 'boss-mode'}}] as never}), /Unknown level/);
});

test('exports for admins leave out personal spaces; restoring such a file keeps them', () => {
  const {tasks, rep, sal} = setup();
  const mine = tasks.createProject({name: 'Private plans', settings: {access: {default: 'none', members: {[rep.id]: 'admin'}, private: true}}});
  const secret = tasks.createItem({projectId: mine.id, title: 'My secret plan'});
  tasks.addComment(secret.id, rep.id, 'only me');
  tasks.createItem({projectId: sal.id, title: 'Shared work'});
  const dump = exportAll(tasks.db, {skipPrivate: true}) as unknown as {privateExcluded?: boolean; tables: Record<string, {id: string; title?: string}[]>};
  assert.equal(dump.privateExcluded, true);
  assert.ok(!dump.tables.projects.some(p => p.id === mine.id), 'personal space left out');
  assert.ok(!dump.tables.items.some(i => i.id === secret.id) && dump.tables.items.some(i => i.title === 'Shared work'));
  assert.ok(!(tasks.exportWorkspace() as unknown as {tables: {items: {id: string}[]}}).tables.items.some(i => i.id === secret.id), 'export tool too');
  // Full snapshots still have everything; restoring the admin file keeps the personal space and its comments.
  assert.ok((exportAll(tasks.db) as unknown as {tables: {items: {id: string}[]}}).tables.items.some(i => i.id === secret.id));
  importAll(tasks.db, dump as never);
  assert.equal(tasks.item(secret.id).title, 'My secret plan');
  assert.equal(tasks.listComments(secret.id).length, 1);
});

test('job roles over the API: admin sets them, people get them by edit or invite, members see only their spaces', async () => {
  process.env.CADENCE_REQUIRE_LOGIN = '1';
  const {tasks, boss, rep, fin, sal} = setup();
  const mw = apiMiddleware(tasks);
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; cookie?: string} = {}) => {
    const r = await fetch(base + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.cookie ? {cookie: init.cookie} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    const o = (await call('/auth/setup', {method: 'POST', body: {name: 'Boss', email: 'boss@co.test', password: 'boss password'}})).cookie!;
    const jobRoles = [{name: 'Sales rep', spaces: {[sal.id]: 'editor', [fin.id]: 'none'}}, {name: 'Finance', spaces: {[fin.id]: 'editor'}}];
    assert.equal((await call('/workspace', {method: 'PUT', body: {jobRoles}, cookie: o})).status, 200);
    const team = (await call('/team', {cookie: o})).json;
    const ids = team.jobRoles.map((j: {id: string}) => j.id);
    assert.deepEqual(ids, ['sales-rep', 'finance']);
    // The list keeps the order the admin drags it into.
    const team0 = (await call('/team', {cookie: o})).json.jobRoles;
    assert.equal((await call('/workspace', {method: 'PUT', body: {jobRoles: [...team0].reverse()}, cookie: o})).status, 200);
    assert.deepEqual((await call('/team', {cookie: o})).json.jobRoles.map((j: {id: string}) => j.id), ['finance', 'sales-rep']);
    assert.equal((await call('/workspace', {method: 'PUT', body: {jobRoles: team0}, cookie: o})).status, 200);
    assert.equal((await call(`/team/${rep.id}`, {method: 'PATCH', body: {jobRoles: ['nope']}, cookie: o})).status, 400);
    assert.equal((await call(`/team/${rep.id}`, {method: 'PATCH', body: {jobRoles: ['sales-rep'], password: 'rep password'}, cookie: o})).status, 200);
    const r = (await call('/auth/login', {method: 'POST', body: {email: 'rep@co.test', password: 'rep password'}})).cookie!;
    const keys = (await call('/projects', {cookie: r})).json.map((p: {id: string}) => p.id);
    assert.ok(keys.includes(sal.id) && !keys.includes(fin.id), 'the sales rep sees Sales, not Finance');
    // Members cannot change job roles; they see names only.
    assert.equal((await call(`/team/${rep.id}`, {method: 'PATCH', body: {jobRoles: ['finance']}, cookie: r})).status, 403);
    assert.equal((await call('/workspace', {method: 'PUT', body: {jobRoles: []}, cookie: r})).status, 403);
    assert.ok((await call('/team', {cookie: r})).json.jobRoles.every((j: object) => !('spaces' in j)));
    // The read-only tool for agents: full setup for admins, names and their own for everyone else.
    assert.equal(guarded(tasks, boss.id).jobRoles().jobRoles[0].spaces[0].level, 'editor');
    const limited = guarded(tasks, rep.id).jobRoles();
    assert.deepEqual(limited.people.map(p => p.id), [rep.id]);
    assert.ok(!('spaces' in limited.jobRoles[0]));
    // Invites carry job roles into the workspace.
    const inv = (await call('/invites', {method: 'POST', body: {email: 'fin@co.test', role: 'viewer', jobRoles: ['finance']}, cookie: o})).json;
    assert.deepEqual(inv.jobRoles, ['finance']);
    assert.equal((await call('/invites', {method: 'POST', body: {email: 'x@co.test', role: 'viewer', jobRoles: ['ghost']}, cookie: o})).status, 400);
    const secret = inv.link.split('/invite/')[1];
    assert.equal((await call(`/invites/${secret}/accept`, {method: 'POST', body: {name: 'Fin', password: 'fin password'}})).status, 200);
    const fp = (await call('/team', {cookie: o})).json.people.find((p: {email: string}) => p.email === 'fin@co.test');
    assert.deepEqual(fp.jobRoles, ['finance']);
    // Company domain: levels other than admin only, domains must look like domains.
    assert.equal((await call('/workspace', {method: 'PUT', body: {domainJoin: {domains: ['co.test'], level: 'admin'}}, cookie: o})).status, 400);
    assert.equal((await call('/workspace', {method: 'PUT', body: {domainJoin: {domains: ['not a domain'], level: 'viewer'}}, cookie: o})).status, 400);
    assert.equal((await call('/workspace', {method: 'PUT', body: {domainJoin: {domains: ['@CO.test'], level: 'contributor', jobRoles: ['sales-rep']}}, cookie: o})).status, 200);
    assert.deepEqual(getWorkspace(tasks.db).domainJoin, {domains: ['co.test'], level: 'contributor', jobRoles: ['sales-rep']});
  } finally { server.close(); delete process.env.CADENCE_REQUIRE_LOGIN; }
});

test('domain join adds Google-verified company emails once, with the starting level and job roles; turned-off people stay out', () => {
  const {tasks, rep} = setup();
  saveWorkspace(tasks.db, {jobRoles: [{id: 'va', name: 'VA', spaces: {}, others: 'inherit'}] as never, domainJoin: {domains: ['co.test'], level: 'commenter', jobRoles: ['va']}});
  const read = (db: typeof tasks.db) => getWorkspace(db).domainJoin;
  assert.equal(joinByDomain([tasks], 'new@other.test', read), 0, 'other domains are ignored');
  assert.equal(joinByDomain([tasks], 'New@CO.test', read), 1);
  const p = tasks.db.prepare("select role, job_roles from people where email = 'new@co.test'").get() as {role: string; job_roles: string};
  assert.deepEqual([p.role, JSON.parse(p.job_roles)], ['commenter', ['va']]);
  assert.equal(joinByDomain([tasks], 'new@co.test', read), 0, 'only once');
  tasks.db.prepare('update people set active = 0 where id = ?').run(rep.id);
  assert.equal(joinByDomain([tasks], 'rep@co.test', read), 0, 'someone an admin turned off does not come back');
});

test('members add their own workspaces; the owner can turn it off', async () => {
  const {resetWorkspaceCache} = await import('../server/workspaces.ts');
  const prevDb = process.env.TASKS_DB;
  process.env.TASKS_DB = join(mkdtempSync(join(tmpdir(), 'tasks-ws-')), 'tasks.db');
  resetWorkspaceCache();
  process.env.CADENCE_REQUIRE_LOGIN = '1';
  const mw = apiMiddleware(); // every workspace in its own database, as on a server
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; cookie?: string; ws?: string} = {}) => {
    const r = await fetch(base + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.cookie ? {cookie: init.cookie} : {}), ...(init.ws ? {'x-workspace': init.ws} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    const o = (await call('/auth/setup', {method: 'POST', body: {name: 'Owner', email: 'owner@co.test', password: 'owner password'}})).cookie!;
    const inv = (await call('/invites', {method: 'POST', body: {email: 'sam@co.test', role: 'contributor'}, cookie: o})).json;
    await call(`/invites/${inv.link.split('/invite/')[1]}/accept`, {method: 'POST', body: {name: 'Sam', password: 'sam password'}});
    const s = (await call('/auth/login', {method: 'POST', body: {email: 'sam@co.test', password: 'sam password'}})).cookie!;
    const made = await call('/workspaces', {method: 'POST', body: {name: 'Sam personal'}, cookie: s});
    assert.equal(made.status, 201, 'a member adds a workspace of their own');
    assert.ok((await call('/workspaces', {cookie: s})).json.list.some((w: {id: string}) => w.id === made.json.id));
    assert.ok(!(await call('/workspaces', {cookie: o})).json.list.some((w: {id: string}) => w.id === made.json.id), 'the company admin is not in it');
    assert.equal((await call('/bootstrap', {cookie: o, ws: made.json.id})).status, 403, 'and cannot open it');
    assert.equal((await call('/auth/server', {method: 'PUT', body: {memberWorkspaces: 'off'}, cookie: o})).status, 200);
    assert.equal((await call('/workspaces', {method: 'POST', body: {name: 'Another'}, cookie: s})).status, 403);
    assert.equal((await call('/workspaces', {method: 'POST', body: {name: 'Admin one'}, cookie: o})).status, 201, 'admins still can');
  } finally {
    server.close(); delete process.env.CADENCE_REQUIRE_LOGIN;
    if (prevDb === undefined) delete process.env.TASKS_DB; else process.env.TASKS_DB = prevDb;
    resetWorkspaceCache();
  }
});
