import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {apiMiddleware} from '../server/api.ts';

process.env.TASKS_BACKUPS = mkdtempSync(join(tmpdir(), 'tasks-personal-'));

export async function harness() {
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-10');
  const mw = apiMiddleware(tasks);
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; cookie?: string; person?: string} = {}) => {
    const r = await fetch(base + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.cookie ? {cookie: init.cookie} : {}), ...(init.person ? {'x-person': init.person} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0]};
  };
  const team = (await call('/team')).json;
  const [admin, member] = [team.people.find((p: {admin: boolean}) => p.admin), team.people.find((p: {admin: boolean}) => !p.admin)];
  await call(`/team/${admin.id}`, {method: 'PATCH', body: {email: 'admin@x.test', password: 'correct horse'}, person: admin.id});
  await call(`/team/${member.id}`, {method: 'PATCH', body: {email: 'member@x.test', password: 'member pass', role: 'contributor'}, person: admin.id});
  await call('/workspace', {method: 'PUT', body: {requireLogin: true}, person: admin.id});
  const a = (await call('/auth/login', {method: 'POST', body: {email: 'admin@x.test', password: 'correct horse'}})).cookie!;
  const m = (await call('/auth/login', {method: 'POST', body: {email: 'member@x.test', password: 'member pass'}})).cookie!;
  return {tasks, server, call, admin, member, a, m};
}

test('personal spaces: any member makes one, it stays private (even from admins) until shared', async () => {
  const {server, call, admin, member, a, m} = await harness();
  try {
    assert.equal((await call('/projects', {method: 'POST', body: {name: 'Team thing'}, cookie: m})).status, 403, 'members cannot make shared spaces');
    const mine = (await call('/projects', {method: 'POST', body: {name: 'My notes', personal: true}, cookie: m}));
    assert.equal(mine.status, 201);
    const pid = mine.json.id;
    assert.ok((await call('/projects', {cookie: m})).json.some((p: {id: string}) => p.id === pid));
    assert.ok(!(await call('/projects', {cookie: a})).json.some((p: {id: string}) => p.id === pid), 'admin does not see it');
    assert.equal((await call(`/projects/${pid}`, {cookie: a})).status, 403);
    const item = await call('/items', {method: 'POST', body: {projectId: pid, title: 'Private idea'}, cookie: m});
    assert.equal(item.status, 201);
    assert.ok(!(await call('/bootstrap', {cookie: a})).json.items.some((i: {id: string}) => i.id === item.json.id));

    const settings = mine.json.settings;
    // Admin cannot take it over from outside; owner cannot drop themselves.
    assert.equal((await call(`/projects/${pid}`, {method: 'PATCH', body: {settings: {...settings, access: {...settings.access, members: {[admin.id]: 'admin'}}}}, cookie: a})).status, 403);
    assert.equal((await call(`/projects/${pid}`, {method: 'PATCH', body: {settings: {...settings, access: {...settings.access, members: {[admin.id]: 'admin'}}}}, cookie: m})).status, 403);
    // Owner shares with the admin as a viewer.
    const shared = await call(`/projects/${pid}`, {method: 'PATCH', body: {settings: {...settings, access: {...settings.access, members: {...settings.access.members, [admin.id]: 'viewer'}}}}, cookie: m});
    assert.equal(shared.status, 200);
    assert.ok((await call('/projects', {cookie: a})).json.some((p: {id: string}) => p.id === pid), 'admin sees it once shared');
    assert.equal((await call('/items', {method: 'POST', body: {projectId: pid, title: 'Admin edit'}, cookie: a})).status, 403, 'shared as viewer means viewer, even for admins');
    // Owner can delete their own personal space.
    assert.equal((await call(`/projects/${pid}`, {method: 'DELETE', cookie: m})).status, 200);
  } finally { server.close(); }
});
