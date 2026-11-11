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

test('my data: export holds only what I can see; import restores personal spaces and layouts without duplicates', async () => {
  const {tasks, server, call, admin, a, m} = await harness();
  try {
    // A space only the admin can see.
    const secret = (await call('/projects', {method: 'POST', body: {name: 'Board only'}, cookie: a})).json;
    await call(`/projects/${secret.id}`, {method: 'PATCH', body: {settings: {...secret.settings, access: {default: 'none', members: {}}}}, cookie: a});
    await call('/items', {method: 'POST', body: {projectId: secret.id, title: 'Cap table'}, cookie: a});
    const mine = (await call('/projects', {method: 'POST', body: {name: 'My notes', personal: true}, cookie: m})).json;
    const parent = (await call('/items', {method: 'POST', body: {projectId: mine.id, title: 'Plan'}, cookie: m})).json;
    await call('/items', {method: 'POST', body: {projectId: mine.id, title: 'Step one', parentId: parent.id}, cookie: m});

    const dump = (await call('/me/export', {cookie: m})).json;
    assert.equal(dump.app, 'cadence-personal');
    assert.ok(!dump.spaces.some((s: {project: {id: string}}) => s.project.id === secret.id), 'no spaces I cannot see');
    assert.ok(dump.spaces.some((s: {project: {id: string}}) => s.project.id === mine.id));

    // Importing again changes nothing; after losing the space, it comes back with its tree.
    const again = (await call('/me/import', {method: 'POST', body: {data: dump}, cookie: m})).json;
    assert.equal(again.itemsAdded, 0); assert.equal(again.spacesCreated, 0);
    tasks.deleteProject(mine.id);
    const back = (await call('/me/import', {method: 'POST', body: {data: dump}, cookie: m})).json;
    assert.equal(back.spacesCreated, 1); assert.equal(back.itemsAdded, 2);
    const p = tasks.listProjects().find(x => x.name === 'My notes')!;
    assert.ok(p.settings.access?.private && p.settings.access.members[dump.person.id] === 'admin');
    const items = tasks.listItems({projectId: p.id});
    assert.equal(items.find(i => i.title === 'Step one')!.parentId, items.find(i => i.title === 'Plan')!.id);
    assert.ok(!(await call('/projects', {cookie: a})).json.some((x: {id: string}) => x.id === p.id), 'restored space is still private');
    assert.equal(admin.admin, true);
  } finally { server.close(); }
});

test('people without the views permission can still keep private views of their own', async () => {
  const {server, call, member, m, tasks} = await harness();
  try {
    const p = tasks.listProjects().find(x => !x.settings.rollup)!;
    assert.equal((await call('/views', {method: 'POST', body: {projectId: p.id, name: 'Team view', kind: 'list'}, cookie: m})).status, 403);
    const v = await call('/views', {method: 'POST', body: {projectId: p.id, name: 'Mine', kind: 'list', config: {privateTo: member.id}}, cookie: m});
    assert.equal(v.status, 201);
    assert.equal((await call(`/views/${v.json.id}`, {method: 'PATCH', body: {name: 'Mine 2', config: {...v.json.config, privateTo: member.id}}, cookie: m})).status, 200);
    assert.equal((await call(`/views/${v.json.id}`, {method: 'PATCH', body: {config: {...v.json.config, privateTo: undefined}}, cookie: m})).status, 403, 'cannot publish it to everyone');
    assert.equal((await call(`/views/${v.json.id}`, {method: 'DELETE', cookie: m})).status, 200);
  } finally { server.close(); }
});

test('rollbacks are for signed-in admins only; personal imports never touch what others can see', async () => {
  const {tasks, server, call, member, a, m} = await harness();
  try {
    const snaps = (await call('/backups', {method: 'POST', cookie: a})).json;
    const name = snaps.file.split('/').pop();
    assert.equal((await call('/backups/restore', {method: 'POST', body: {name}, cookie: m})).status, 403);
    assert.equal((await call('/backups/restore', {method: 'POST', body: {name: '../../etc/passwd'}, cookie: a})).status, 400);
    assert.equal((await call('/import', {method: 'POST', body: {}, cookie: m})).status, 403);
    const shared = tasks.listProjects().find(x => !x.settings.rollup)!;
    tasks.createItem({projectId: shared.id, title: 'Added later'});
    const r = await call('/backups/restore', {method: 'POST', body: {name}, cookie: a});
    assert.equal(r.status, 200);
    assert.ok(!tasks.listItems({projectId: shared.id}).some(i => i.title === 'Added later'), 'rolled back');

    // A personal space shared with someone else is not topped up by an import; a new one is made instead.
    const mine = (await call('/projects', {method: 'POST', body: {name: 'Shared notes', personal: true}, cookie: m})).json;
    await call('/items', {method: 'POST', body: {projectId: mine.id, title: 'One'}, cookie: m});
    const dump = (await call('/me/export', {cookie: m})).json;
    const admin = tasks.listPeople().find(p => p.id !== member.id)!;
    await call(`/projects/${mine.id}`, {method: 'PATCH', body: {settings: {...mine.settings, access: {...mine.settings.access, members: {...mine.settings.access.members, [admin.id]: 'editor'}}}}, cookie: m});
    const before = {shared: tasks.listItems({projectId: shared.id}).length, mine: tasks.listItems({projectId: mine.id}).length, views: tasks.listViews(shared.id).length};
    const rep = (await call('/me/import', {method: 'POST', body: {data: dump}, cookie: m})).json;
    assert.equal(rep.spacesCreated, 1);
    assert.ok(tasks.listProjects().some(x => x.name === 'Shared notes (restored)'));
    assert.deepEqual({shared: tasks.listItems({projectId: shared.id}).length, mine: tasks.listItems({projectId: mine.id}).length, views: tasks.listViews(shared.id).length}, before);
  } finally { server.close(); }
});
