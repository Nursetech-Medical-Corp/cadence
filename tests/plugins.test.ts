import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {apiMiddleware} from '../server/api.ts';
import {migrate, saveWorkspace} from '../server/auth.ts';
import {BUILTIN, PluginCatalog, checkManifest, contrast, listInstalls, migratePluginInstalls} from '../server/plugins.ts';
import {guarded} from '../server/tokens.ts';

process.env.TASKS_BACKUPS = mkdtempSync(join(tmpdir(), 'tasks-plugins-'));

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const base = (extra: Record<string, unknown> = {}) => ({id: 'acme.blue', name: 'Blue', version: '1.0.0', description: 'Blue accent', contributes: {theme: {light: {accent: '#1d4ed8'}}}, ...extra});

test('a plugin is data only: values outside the allow list are refused', () => {
  for (const b of BUILTIN) assert.doesNotThrow(() => checkManifest(b, {builtin: true}), b.id);
  for (const b of BUILTIN) assert.ok(b.highlights?.length && b.changelog?.length && b.screenshots?.length, `${b.id} has highlights, a changelog and screenshots`);
  assert.equal(checkManifest(base({icon: PNG, screenshots: [PNG]})).contributes.theme!.light!.accent, '#1d4ed8');
  const bad: [unknown, RegExp][] = [
    [base({contributes: {theme: {light: {accent: 'red; } body { display: none'}}}}), /color/],
    [base({contributes: {theme: {light: {accent: 'url(https://evil.test/x)'}}}}), /color/],
    [base({contributes: {theme: {light: {'font-family': 'x'}}}}), /may set only/],
    [base({icon: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4='}), /icon/],
    [base({screenshots: ['https://evil.test/shot.png']}), /screenshot/],
    [base({id: '../etc'}), /id/],
    [base({contributes: {}}), /contribute something/],
    [base({contributes: {features: ['shell']}}), /features/],
    [base({contributes: {pages: [{id: 'p', title: 'P', blocks: [{type: 'html', html: '<script>'}]}]}}), /Block type/],
    [base({contributes: {setup: {spaces: [{name: 'X', statuses: [{id: 'a', name: 'A', category: 'todo'}]}]}}}), /done status/],
    [base({version: 'latest'}), /version/],
    [base({contributes: {theme: {light: {text: '#dddddd'}}}}), /too hard to read/],
    [base({contributes: {theme: {dark: {bg: '#ffffff'}}}}), /too hard to read/],
    [base({contributes: {theme: {light: {accent: '#ffe066'}}}}), /button text/],
    [base({screenshots: ['/plugin-shots/day-planner.jpg']}), /screenshot/],
    [base({changelog: [{version: '1.0.0', date: 'yesterday', notes: 'x'}]}), /date/],
    [base({highlights: ['x'.repeat(300)]}), /highlight/],
  ];
  for (const [m, re] of bad) assert.throws(() => checkManifest(m), re);
  assert.ok(contrast('#000000', '#ffffff')! > 20 && contrast('#ffffff', '#ffffff') === 1);
  const clean = checkManifest({...base(), evil: 'x', contributes: {theme: {light: {accent: '#1d4ed8'}}, extra: 1}}) as unknown as Record<string, unknown>;
  assert.equal(clean.evil, undefined, 'unknown keys are dropped');
});

test('catalog: drafts are private, ids belong to their maker, review lists them for everyone', () => {
  const c = new PluginCatalog(openDb(':memory:'));
  c.save(base(), 'a@x.test');
  assert.ok(c.list('a@x.test').some(e => e.id === 'acme.blue'), 'the maker sees the draft');
  assert.ok(!c.list('b@x.test').some(e => e.id === 'acme.blue'), 'others do not');
  assert.throws(() => c.save(base(), 'b@x.test'), /belongs to someone else/);
  assert.throws(() => c.save(base({id: 'cadence.fake'}), 'a@x.test'), /built-in/);
  assert.throws(() => c.submit('acme.blue', 'b@x.test'), /your own/);
  c.submit('acme.blue', 'a@x.test');
  assert.ok(c.list('r@x.test', '', true).some(e => e.id === 'acme.blue' && e.status === 'pending'), 'the reviewer sees pending ones');
  c.review('acme.blue', true, 'ok');
  assert.ok(c.list('b@x.test', 'blue').some(e => e.id === 'acme.blue'), 'listed and found by search');
  c.save(base({version: '1.1.0', description: 'Bluer'}), 'a@x.test');
  assert.equal(c.get('acme.blue', 'a@x.test').status, 'pending', 'a new version goes back to review');
  assert.throws(() => c.save(base({version: '1.0.0'}), 'a@x.test'), /already published/);
});

test('installs: for me or the workspace, off without removing, settings checked, old workspaces keep built-in modules', () => {
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-16');
  migrate(tasks.db);
  const boss = tasks.createPerson({name: 'Boss', email: 'boss@co.test'}), rep = tasks.createPerson({name: 'Rep', email: 'rep@co.test'});
  tasks.db.prepare('update people set admin = 1 where id = ?').run(boss.id);
  tasks.db.prepare('update people set admin = 0, role = ? where id = ?').run('viewer', rep.id);
  const p = tasks.createProject({name: 'Ops'});
  tasks.createItem({projectId: p.id, title: 'Existing work'});
  migratePluginInstalls(tasks.db);
  assert.deepEqual(listInstalls(tasks.db, null).map(i => i.id).sort(), ['cadence.day-planner', 'cadence.whiteboards'], 'the day planner and whiteboards start installed');
  tasks.uninstallPlugin('cadence.whiteboards', 'workspace', boss.id);
  migratePluginInstalls(tasks.db);
  assert.deepEqual(listInstalls(tasks.db, null).map(i => i.id), ['cadence.day-planner'], 'a removed one stays removed');

  tasks.savePlugin({...base(), contributes: {theme: {light: {accent: '#1d4ed8'}}, settings: [{key: 'tone', label: 'Tone', type: 'select', options: ['calm', 'bold']}]}}, rep.id);
  assert.throws(() => tasks.installPlugin('acme.blue', 'workspace', rep.id), /approved/, 'drafts never go workspace wide');
  assert.throws(() => tasks.installPlugin('acme.blue', 'me', boss.id), /No such plugin/, 'others cannot see a draft');
  tasks.installPlugin('acme.blue', 'me', rep.id);
  assert.ok(tasks.plugins(rep.id).installed.some(i => i.id === 'acme.blue' && i.scope === 'me'));
  assert.ok(!tasks.plugins(boss.id).installed.some(i => i.id === 'acme.blue'), 'my install is mine only');
  tasks.setPlugin('acme.blue', 'me', rep.id, {enabled: false, settings: {tone: 'bold'}});
  const off = tasks.plugins(rep.id).installed.find(i => i.id === 'acme.blue')!;
  assert.equal(off.enabled, false); assert.equal(off.settings.tone, 'bold');
  assert.throws(() => tasks.setPlugin('acme.blue', 'me', rep.id, {settings: {nope: 1}}), /no setting/);
  tasks.uninstallPlugin('acme.blue', 'me', rep.id);
  assert.ok(!tasks.plugins(rep.id).installed.some(i => i.id === 'acme.blue'));

  // Tokens: anyone installs for themselves; only admins install for everyone.
  const g = guarded(tasks, rep.id);
  assert.doesNotThrow(() => g.installPlugin('cadence.midnight', 'me', rep.id));
  assert.throws(() => g.installPlugin('cadence.midnight', 'workspace', rep.id), /Only admins/);
  assert.throws(() => g.installPlugin('cadence.midnight', 'me', boss.id), /your own/);
  assert.throws(() => g.reviewPlugin('acme.blue', true, '', rep.id), /not available/);
  assert.doesNotThrow(() => guarded(tasks, boss.id).installPlugin('cadence.midnight', 'workspace', boss.id));
});

test('plugin API: store, check, save, install, turn off, review by the server owner', async () => {
  process.env.CADENCE_REQUIRE_LOGIN = '1';
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-16');
  migrate(tasks.db);
  saveWorkspace(tasks.db, {requireLogin: true});
  const mw = apiMiddleware(tasks);
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; cookie?: string} = {}) => {
    const r = await fetch(url + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.cookie ? {cookie: init.cookie} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    const o = (await call('/auth/setup', {method: 'POST', body: {name: 'Boss', email: 'boss@co.test', password: 'boss password'}})).cookie!;
    const store = (await call('/plugins?q=theme', {cookie: o})).json;
    assert.ok(store.catalog.some((c: {id: string}) => c.id === 'cadence.midnight'), 'search finds built-in themes');
    assert.equal(store.reviewer, true, 'the server owner reviews');
    assert.equal((await call('/plugins/check', {method: 'POST', body: {manifest: base({contributes: {theme: {light: {accent: 'javascript:alert(1)'}}}})}, cookie: o})).status, 400);
    assert.equal((await call('/plugins', {method: 'POST', body: {manifest: base()}, cookie: o})).status, 200);
    assert.equal((await call('/plugins/acme.blue/install', {method: 'POST', body: {scope: 'me'}, cookie: o})).status, 200);
    assert.equal((await call('/plugins/acme.blue/install', {method: 'PATCH', body: {scope: 'me', enabled: false}, cookie: o})).status, 200);
    const boot = (await call('/bootstrap', {cookie: o})).json;
    assert.ok(boot.plugins.some((i: {id: string; enabled: boolean}) => i.id === 'acme.blue' && !i.enabled), 'bootstrap carries installs, off ones too');
    assert.equal((await call('/plugins/acme.blue/submit', {method: 'POST', cookie: o})).status, 200);
    assert.equal((await call('/plugins/acme.blue/review', {method: 'POST', body: {approve: true}, cookie: o})).status, 200);
    assert.equal((await call('/plugins/acme.blue/install', {method: 'POST', body: {scope: 'workspace'}, cookie: o})).status, 200);
    const info = (await call('/plugins/acme.blue', {cookie: o})).json;
    assert.equal(info.status, 'listed');
    assert.ok(info.effects.some((e: string) => /no code/.test(e)));
    assert.deepEqual(info.installed.map((i: {scope: string}) => i.scope).sort(), ['me', 'workspace']);
  } finally { server.close(); delete process.env.CADENCE_REQUIRE_LOGIN; }
});
