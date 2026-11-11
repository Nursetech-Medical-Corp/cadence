import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {apiMiddleware} from '../server/api.ts';

process.env.TASKS_BACKUPS = mkdtempSync(join(tmpdir(), 'tasks-team-'));

test('team and permission setup is for admins; others see and change only their own account', async () => {
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
    const all = (await call('/team')).json.people;
    const admin = all.find((p: {admin: boolean}) => p.admin), member = all.find((p: {admin: boolean}) => !p.admin);
    await call(`/team/${admin.id}`, {method: 'PATCH', body: {email: 'boss@x.test', password: 'correct horse'}, person: admin.id});
    await call(`/team/${member.id}`, {method: 'PATCH', body: {email: 'member@x.test', password: 'member pass'}, person: admin.id});
    assert.equal((await call('/workspace', {method: 'PUT', body: {requireLogin: true}, person: admin.id})).status, 200);
    const a = (await call('/auth/login', {method: 'POST', body: {email: 'boss@x.test', password: 'correct horse'}})).cookie!;
    const v = (await call('/auth/login', {method: 'POST', body: {email: 'member@x.test', password: 'member pass'}})).cookie!;

    // Admin sees the whole team, the roles and the permission matrix.
    const at = (await call('/team', {cookie: a})).json;
    assert.equal(at.people.length, all.length);
    assert.ok(at.caps.length > 0 && at.roles.some((r: {caps?: string[]}) => r.caps?.length));
    assert.equal((await call('/workspace', {cookie: a})).status, 200);

    // A non-admin gets only their own row, role names without permissions, and no workspace settings.
    const vt = (await call('/team', {cookie: v})).json;
    assert.deepEqual(vt.people.map((p: {id: string}) => p.id), [member.id]);
    assert.deepEqual(vt.caps, []);
    assert.ok(vt.roles.length > 0 && vt.roles.every((r: object) => !('caps' in r)));
    assert.equal((await call('/workspace', {cookie: v})).status, 403);
    // The people list that assignee pickers use still has everyone.
    assert.equal((await call('/bootstrap', {cookie: v})).json.people.length, all.length);

    // Writes behind the admin sections are refused.
    assert.equal((await call(`/team/${admin.id}`, {method: 'PATCH', body: {name: 'Hacked'}, cookie: v})).status, 403);
    assert.equal((await call(`/team/${member.id}`, {method: 'PATCH', body: {admin: true}, cookie: v})).status, 403);
    assert.equal((await call(`/team/${member.id}`, {method: 'PATCH', body: {role: 'admin'}, cookie: v})).status, 403);
    assert.equal((await call('/workspace', {method: 'PUT', body: {roles: []}, cookie: v})).status, 403);
    assert.equal((await call('/workspace', {method: 'PUT', body: {features: {}}, cookie: v})).status, 403);
    assert.equal((await call('/invites', {cookie: v})).status, 403);
    assert.equal((await call('/invites', {method: 'POST', body: {email: 'new@x.test', role: 'editor'}, cookie: v})).status, 403);
    assert.equal((await call('/auth/server', {method: 'PUT', body: {signup: 'open'}, cookie: v})).status, 403);
    assert.equal((await call('/tokens', {method: 'POST', body: {person: admin.id, name: 'x'}, cookie: v})).status, 403);
    const adminTok = (await call('/tokens', {method: 'POST', body: {person: admin.id, name: 'Admin token'}, cookie: a})).json;
    assert.equal((await call(`/tokens/${adminTok.id}`, {method: 'DELETE', cookie: v})).status, 403);

    // Their own things still work: email toggle, password, own tokens.
    assert.equal((await call(`/team/${member.id}`, {method: 'PATCH', body: {notifyEmail: true}, cookie: v})).status, 200);
    assert.equal((await call(`/team/${member.id}`, {method: 'PATCH', body: {password: 'member pass 2', currentPassword: 'member pass'}, cookie: v})).status, 200);
    assert.equal((await call('/tokens', {method: 'POST', body: {person: member.id, name: 'Mine'}, cookie: v})).status, 201);
    const mine = (await call('/tokens', {cookie: v})).json;
    assert.ok(mine.length === 1 && mine.every((t: {person: string}) => t.person === member.id));
  } finally {
    server.close();
  }
});
