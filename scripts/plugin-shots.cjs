// Real screenshots for the built-in plugins, taken from the demo workspace in a real browser.
// Run: node scripts/plugin-shots.cjs   (needs Playwright; starts and stops its own demo server on port 5197)
// Writes public/plugin-shots/*.jpg, which the built-in plugin manifests (server/plugins.ts) point at.
const {spawn} = require('node:child_process');
const {mkdtempSync, mkdirSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {chromium} = require('playwright');

const PORT = 5197, BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(__dirname, '../public/plugin-shots');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  mkdirSync(OUT, {recursive: true});
  const dir = mkdtempSync(join(tmpdir(), 'cadence-shots-'));
  const server = spawn('npx', ['vite', '--mode', 'demo', '--port', String(PORT), '--strictPort'], {cwd: join(__dirname, '..'),
    env: {...process.env, TASKS_DB: join(dir, 'tasks.db'), TASKS_BACKUPS: join(dir, 'backups'), TASKS_NO_SYNC: '1'}, stdio: 'ignore', detached: true});
  let browser;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/people')).ok) break; } catch { /* starting */ } await wait(500); }
    const api = (path, init = {}, me) => fetch(BASE + '/api' + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(me ? {'x-person': me} : {})}, body: init.body ? JSON.stringify(init.body) : undefined}).then(r => r.json());
    const people = await api('/people');
    const me = people.find(p => p.kind !== 'ai').id;
    const spaces = (await api('/projects', {}, me)).filter(p => !p.settings.rollup);
    const today = new Date().toISOString().slice(0, 10);
    // A planned day: top 3, a brain dump and time boxes from the demo tasks.
    const mine = (await api(`/items?assignee=${me}&open=true`, {}, me)).slice(0, 6);
    await api(`/day/${today}`, {method: 'PUT', body: {top: mine.slice(0, 3).map((i, n) => ({id: 't' + n, text: i.title, itemId: i.id})),
      dump: [{id: 'd1', text: 'Call the venue about booth power'}, {id: 'd2', text: 'Ask finance for the Q4 numbers'}, {id: 'd3', text: 'Book flights for the trade show'}]}}, me);
    await api(`/day/${today}/auto`, {method: 'POST', body: {from: '08:00'}}, me);
    // A workflow board.
    const board = await api('/boards', {method: 'POST', body: {name: 'New customer onboarding', projectId: spaces[0].id, nodes: [
      {id: 'a', kind: 'terminal', x: 0, y: 160, text: 'Order signed'}, {id: 'b', kind: 'task', x: 300, y: 40, text: 'Create the account'},
      {id: 'c', kind: 'task', x: 300, y: 280, text: 'Schedule training'}, {id: 'd', kind: 'decision', x: 620, y: 160, text: 'Ready to ship?'},
      {id: 'e', kind: 'task', x: 920, y: 160, text: 'Ship the first order'}],
      edges: [{id: 'e1', from: 'a', to: 'b'}, {id: 'e2', from: 'a', to: 'c'}, {id: 'e3', from: 'b', to: 'd'}, {id: 'e4', from: 'c', to: 'd'}, {id: 'e5', from: 'd', to: 'e', label: 'Yes'}]}}, me);
    // The sprint view set added to the first space.
    const views = [];
    for (const v of [{name: 'Board', kind: 'board', config: {groupBy: 'status'}}, {name: 'Open work', kind: 'list', config: {hideDone: true}}])
      views.push(await api('/views', {method: 'POST', body: {projectId: spaces[0].id, ...v}}, me));

    browser = await chromium.launch();
    const shot = async (name, hash, opts = {}) => {
      const ctx = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 1, colorScheme: opts.dark ? 'dark' : 'light'});
      const page = await ctx.newPage();
      await page.addInitScript(([id, ap]) => { localStorage.setItem('me:main', id); localStorage.setItem('me', id); localStorage.setItem('appearance', JSON.stringify(ap)); localStorage.setItem('side-w', '248'); },
        [me, {theme: opts.dark ? 'dark' : 'light', density: 'comfortable', accent: '#6d5dfc', font: 'md'}]);
      if (opts.before) await opts.before();
      await page.goto(`${BASE}/#${hash}`);
      await wait(2200);
      if (opts.wait) await page.waitForSelector(opts.wait, {timeout: 15000}).catch(() => {});
      await wait(600);
      await page.screenshot({path: join(OUT, name + '.jpg'), type: 'jpeg', quality: 82});
      await ctx.close();
      if (opts.after) await opts.after();
      console.log('saved', name);
    };
    const plug = (id, on) => api(`/plugins/${id}/install` + (on ? '' : '?scope=me'), {method: on ? 'POST' : 'DELETE', body: on ? {scope: 'me'} : undefined}, me);

    if (!board.id) throw new Error('Board not made: ' + JSON.stringify(board));
    await shot('day-planner', '/day', {wait: '.dp-grid'});
    await shot('whiteboards', `/boards/${board.id}`, {wait: '.wb-node'});
    await shot('midnight', '/mywork', {dark: true, before: () => plug('cadence.midnight', true), after: () => plug('cadence.midnight', false)});
    await shot('paper', '/mywork', {before: () => plug('cadence.paper', true), after: () => plug('cadence.paper', false)});
    await shot('focus-page', '/x/cadence.focus-board/focus', {before: () => plug('cadence.focus-board', true), after: () => plug('cadence.focus-board', false)});
    const b = views.find(v => v.kind === 'board');
    if (b) await shot('sprint-views', `/p/${spaces[0].id}/${b.id}`, {wait: '.card'});
  } finally {
    if (browser) await browser.close();
    try { process.kill(-server.pid); } catch { /* gone */ }
  }
})().catch(e => { console.error(e); process.exit(1); });
