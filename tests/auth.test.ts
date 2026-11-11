import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {apiMiddleware} from '../server/api.ts';

process.env.TASKS_BACKUPS = mkdtempSync(join(tmpdir(), 'tasks-auth-'));

test('sign in, roles and per-project access are enforced by the API', async () => {
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-10');
  const mw = apiMiddleware(tasks);
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; cookie?: string; person?: string} = {}) => {
    const r = await fetch(base + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.cookie ? {cookie: init.cookie} : {}), ...(init.person ? {'x-person': init.person} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    const team = (await call('/team')).json;
    const [admin, viewer] = [team.people.find((p: {admin: boolean}) => p.admin), team.people.find((p: {admin: boolean}) => !p.admin)];
    const project = tasks.listProjects().find(p => !p.settings.rollup)!;
    const item = tasks.listItems({projectId: project.id})[0];

    // Open mode: anything goes.
    assert.equal((await call(`/items/${item.id}`, {method: 'PATCH', body: {title: 'Open edit'}, person: viewer.id})).status, 200);
    // Turning on sign-in requires the admin to have credentials first.
    assert.equal((await call('/workspace', {method: 'PUT', body: {requireLogin: true}, person: admin.id})).status, 400);
    await call(`/team/${admin.id}`, {method: 'PATCH', body: {email: 'admin@x.test', password: 'correct horse'}, person: admin.id});
    await call(`/team/${viewer.id}`, {method: 'PATCH', body: {email: 'viewer@x.test', password: 'viewer pass', role: 'viewer'}, person: admin.id});
    assert.equal((await call('/workspace', {method: 'PUT', body: {requireLogin: true}, person: admin.id})).status, 200);

    assert.equal((await call('/bootstrap')).status, 401, 'no session');
    assert.equal((await call('/auth/login', {method: 'POST', body: {email: 'viewer@x.test', password: 'wrong one!'}})).status, 401);
    const v = (await call('/auth/login', {method: 'POST', body: {email: 'viewer@x.test', password: 'viewer pass'}})).cookie!;
    assert.equal((await call('/bootstrap', {cookie: v})).status, 200);
    const denied = await call(`/items/${item.id}`, {method: 'PATCH', body: {title: 'Viewer edit'}, cookie: v});
    assert.equal(denied.status, 403);
    assert.match(denied.json.error, /Edit items/);
    assert.equal((await call(`/items/${item.id}`, {method: 'PATCH', body: {title: 'x'}, person: admin.id, cookie: v})).status, 403, 'x-person is ignored once sign-in is on');

    const a = (await call('/auth/login', {method: 'POST', body: {email: 'admin@x.test', password: 'correct horse'}})).cookie!;
    // Per-project override: the viewer becomes an editor in this project only.
    const settings = {...tasks.project(project.id).settings, access: {default: 'inherit', members: {[viewer.id]: 'editor'}}};
    assert.equal((await call(`/projects/${project.id}`, {method: 'PATCH', body: {settings}, cookie: v})).status, 403, 'only admins change access');
    assert.equal((await call(`/projects/${project.id}`, {method: 'PATCH', body: {settings}, cookie: a})).status, 200);
    assert.equal((await call(`/items/${item.id}`, {method: 'PATCH', body: {title: 'Now allowed'}, cookie: v})).status, 200);
    // Hide a project from everyone without an explicit role.
    const other = tasks.listProjects()[1];
    await call(`/projects/${other.id}`, {method: 'PATCH', body: {settings: {...other.settings, access: {default: 'none', members: {}}}}, cookie: a});
    const boot = (await call('/bootstrap', {cookie: v})).json;
    assert.ok(!boot.projects.some((p: {id: string}) => p.id === other.id));
    assert.ok(!boot.items.some((i: {projectId: string}) => i.projectId === other.id));
    // Custom role: commenters can comment but not edit.
    await call(`/team/${viewer.id}`, {method: 'PATCH', body: {role: 'commenter'}, cookie: a});
    const third = tasks.listProjects()[2];
    const it3 = tasks.listItems({projectId: third.id})[0];
    assert.equal((await call(`/items/${it3.id}/comments`, {method: 'POST', body: {body: 'hi'}, cookie: v})).status, 201);
    assert.equal((await call(`/items/${it3.id}`, {method: 'DELETE', cookie: v})).status, 403);
    // Security regressions from docs/SECURITY-REVIEW.md
    const raw = (path: string, init: RequestInit) => fetch(base + path, init).then(r => r.status);
    assert.equal(await raw(`/items/${it3.id}`, {method: 'PATCH', headers: {'content-type': 'application/json', origin: 'http://evil.example', cookie: a}, body: '{"title":"x"}'}), 403, 'cross-origin write refused');
    assert.equal(await raw(`/items/${it3.id}`, {method: 'PATCH', headers: {'content-type': 'text/plain', cookie: a}, body: '{"title":"x"}'}), 415, 'non-JSON write refused');
    const hidden = tasks.listItems({projectId: other.id})[0];
    tasks.updateItem(hidden.id, {assignees: [viewer.id]});
    const mw2 = (await call('/my-work', {cookie: v})).json;
    assert.ok(!Object.values(mw2).flat().some((i: any) => i.projectId === other.id), 'my-work hides no-access projects');
    tasks.logTime({itemId: hidden.id, person: admin.id, minutes: 30});
    assert.ok(!(await call('/time', {cookie: v})).json.some((t: any) => t.itemId === hidden.id), 'time hides no-access projects');
    const ics = await (await fetch(base + `/calendar.ics?person=${viewer.id}`, {headers: {cookie: v}})).text();
    assert.ok(!ics.includes(hidden.title), 'calendar hides no-access projects');
    assert.equal((await call(`/items/${it3.id}`, {method: 'PATCH', body: {deps: [hidden.id]}, cookie: a})).status, 200, 'admin may link');
    await call(`/team/${viewer.id}`, {method: 'PATCH', body: {role: 'editor'}, cookie: a});
    assert.equal((await call(`/items/${it3.id}`, {method: 'PATCH', body: {deps: [hidden.id]}, cookie: v})).status, 403, 'cannot link to hidden items');
    await call(`/items/${it3.id}`, {method: 'PATCH', body: {createdBy: 'someone', number: 999}, cookie: v});
    assert.notEqual(tasks.item(it3.id).number, 999, 'protected fields ignored');
    assert.equal((await call(`/team/${viewer.id}`, {method: 'PATCH', body: {name: 'Evil' + String.fromCharCode(13, 10) + 'BEGIN:VEVENT'}, cookie: v})).status, 200);
    assert.ok(!tasks.listPeople().find(p => p.id === viewer.id)!.name.includes(String.fromCharCode(10)), 'control characters stripped from names');
    assert.equal((await call(`/team/${viewer.id}`, {method: 'PATCH', body: {email: 'admin@x.test'}, cookie: v})).status, 400, 'emails are unique');
    assert.equal((await call(`/team/${viewer.id}`, {method: 'PATCH', body: {password: 'new password 1'}, cookie: v})).status, 400, 'own password change needs the current one');
    assert.equal((await call('/activity?limit=abc', {cookie: a})).status, 200, 'bad numbers do not crash');
    assert.equal((await call('/auth/logout', {method: 'POST', cookie: v})).status, 200);
    assert.equal((await call('/bootstrap', {cookie: v})).status, 401);
  } finally { server.close(); }
});

test('invites: admin invites, link works once, sets a password and signs in; bad links refused', async () => {
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-10');
  const mw = apiMiddleware(tasks);
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; cookie?: string; person?: string} = {}) => {
    const r = await fetch(base + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.cookie ? {cookie: init.cookie} : {}), ...(init.person ? {'x-person': init.person} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    const team = (await call('/team')).json;
    const admin = team.people.find((p: {admin: boolean}) => p.admin);
    await call(`/team/${admin.id}`, {method: 'PATCH', body: {email: 'boss@x.test', password: 'correct horse'}, person: admin.id});
    assert.equal((await call('/workspace', {method: 'PUT', body: {requireLogin: true}, person: admin.id})).status, 200);
    const a = (await call('/auth/login', {method: 'POST', body: {email: 'boss@x.test', password: 'correct horse'}})).cookie!;
    assert.equal((await call('/invites', {method: 'POST', body: {email: 'not an email'}, cookie: a})).status, 400);
    const inv = (await call('/invites', {method: 'POST', body: {email: 'New.Person@x.test', role: 'viewer'}, cookie: a})).json;
    const secret = inv.link.split('#/invite/')[1];
    assert.equal((await call('/invites', {method: 'POST', body: {email: 'x@x.test'}})).status, 401, 'signed out cannot invite');
    const info = (await call(`/invites/${secret}`)).json;
    assert.equal(info.email, 'new.person@x.test');
    assert.equal((await call(`/invites/${secret.slice(0, -2)}xx`)).status, 404, 'a changed link is refused');
    assert.equal((await call(`/invites/${secret}/accept`, {method: 'POST', body: {name: 'New', password: 'short'}})).status, 400, 'weak password refused');
    const joined = await call(`/invites/${secret}/accept`, {method: 'POST', body: {name: 'New Person', password: 'a long password'}});
    assert.equal(joined.status, 200);
    assert.equal((await call('/bootstrap', {cookie: joined.cookie})).status, 200, 'signed in after joining');
    assert.equal((await call(`/invites/${secret}/accept`, {method: 'POST', body: {name: 'Again', password: 'a long password'}})).status, 400, 'link works once');
    const me = (await call('/auth/me', {cookie: joined.cookie})).json;
    assert.equal(me.person.name, 'New Person');
    assert.equal((await call('/invites', {cookie: joined.cookie})).status, 403, 'members who are not admins cannot see invites');
    assert.equal((await call('/auth/login', {method: 'POST', body: {email: 'new.person@x.test', password: 'a long password'}})).status, 200);
  } finally { server.close(); }
});
