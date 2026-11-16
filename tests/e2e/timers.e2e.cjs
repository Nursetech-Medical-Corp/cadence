// Timers: one running timer shows the same time everywhere, and starting or stopping it in one tab updates the others.
// Run: node tests/e2e/timers.e2e.cjs   (needs Playwright; starts and stops its own server on port 5198)
const {spawn} = require('node:child_process');
const {mkdtempSync} = require('node:fs');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {chromium} = require('playwright');

const PORT = 5198, BASE = `http://localhost:${PORT}`;
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`PASS  ${name}`); } else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-timers-'));
  const server = spawn('npx', ['vite', '--mode', 'demo', '--port', String(PORT), '--strictPort'], {cwd: join(__dirname, '../..'),
    env: {...process.env, TASKS_DB: join(dir, 'tasks.db'), TASKS_BACKUPS: join(dir, 'backups'), TASKS_NO_SYNC: '1'}, stdio: 'ignore', detached: true});
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/api/bootstrap'); break; } catch { await wait(500); } }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1400, height: 900}});
  const a = await ctx.newPage(), b = await ctx.newPage();
  const errors = [];
  for (const p of [a, b]) p.on('pageerror', e => errors.push(e.message));
  try {
    await a.goto(`${BASE}/#/mywork`); await b.goto(`${BASE}/#/day`);
    await a.waitForTimeout(1500); await b.waitForTimeout(1500);
    // Requests as the person the app runs as (open mode sends x-person).
    const call = (page, path, method = 'GET', body) => page.evaluate(([path, method, body]) => {
      const ws = sessionStorage.getItem('tasks-ws') ?? localStorage.getItem('tasks-ws') ?? 'main';
      const me = sessionStorage.getItem(`me:${ws}`) ?? localStorage.getItem(`me:${ws}`) ?? localStorage.getItem('me') ?? '';
      return fetch('/api' + path, {method, headers: {'content-type': 'application/json', 'x-person': me}, body: body === undefined ? undefined : JSON.stringify(body)}).then(r => r.json());
    }, [path, method, body]);
    const boot = await call(a, '/bootstrap');
    const item = boot.items.find(i => !i.completed && !i.parentId);
    // Some time already on the task, so "total" and "this run" differ.
    await call(a, '/time', 'POST', {itemId: item.id, minutes: 30});

    // 1. Start in tab A (from the focus bar flow): add to focus, start the timer there.
    await call(a, '/prefs', 'PUT', {key: 'focusList', value: [item.id]});
    await a.reload(); await a.waitForTimeout(1500);
    await a.locator('.focus-bar .fb-item').first().getByTitle('Start the timer on this task').click(); await a.waitForTimeout(1200);
    check('the timer starts from the focus bar', await a.locator('.timer-chip').isVisible());
    await b.waitForTimeout(1500);
    check('another tab shows it running within 2 seconds', await b.locator('.timer-chip').isVisible());

    // 2. Every clock for the task shows the same time: focus bar, top bar, focus view.
    await a.locator('.focus-bar .fb-item').first().getByTitle('Full page focus on this task').click(); await a.waitForTimeout(700);
    check('the full page focus opens from the focus bar', await a.locator('.fv-backdrop.full').isVisible());
    let same = true, seen = '';
    for (let k = 0; k < 6; k++) {
      const t = await a.evaluate(() => ['.focus-bar .fx-clock', '.timer-chip .clock', '.fv-clock'].map(s => document.querySelector(s)?.textContent ?? 'missing'));
      seen = t.join(' / ');
      if (new Set(t).size !== 1 || t.includes('missing')) { same = false; break; }
      await a.waitForTimeout(370);
    }
    check('the focus bar, top bar and focus view show the same time', same, seen);
    check('the clocks show the total on the task (30 min logged before)', /^0:3\d:\d\d$/.test(seen.split(' / ')[0]), seen);
    const bClock = await b.locator('.timer-chip .clock').textContent(), aClock = await a.locator('.timer-chip .clock').textContent();
    check('the other tab shows the same time', bClock === aClock, `${aClock} vs ${bClock}`);
    await a.locator('.fv-head').getByRole('button', {name: /Window/}).click(); await a.waitForTimeout(300);
    check('Window turns full page off', await a.locator('.fv-backdrop').isVisible() && !(await a.locator('.fv-backdrop.full').count()));

    // 3. Stop in the focus view; the other tab stops too.
    await a.locator('.fv').getByRole('button', {name: /Stop timer/}).click(); await a.waitForTimeout(1500);
    check('stopping in the focus view stops it here', !(await a.locator('.timer-chip').count()));
    check('and in the other tab within 2 seconds', !(await b.locator('.timer-chip').count()));

    // 4. A start made elsewhere (another device, through the server) reaches an open tab.
    await call(a, '/time/start', 'POST', {itemId: item.id});
    await b.waitForTimeout(2500);
    check('a start from another device shows in an open tab', await b.locator('.timer-chip').isVisible());
    await call(a, '/time/stop', 'POST', {});
    await b.waitForTimeout(2500);
    check('and its stop too', !(await b.locator('.timer-chip').count()));
    check('no page errors', !errors.length, errors.join('; '));
  } catch (e) {
    check('scenario run finished', false, e.message);
  } finally {
    await browser.close();
    process.kill(-server.pid);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
