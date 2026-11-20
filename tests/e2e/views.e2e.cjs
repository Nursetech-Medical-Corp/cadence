// Views: your own filters stick (also clearing one), Save for everyone keeps them, the header counts what the view shows,
// and the focus bar drags, snaps, shrinks and clears.
// Run: node tests/e2e/views.e2e.cjs   (needs Playwright; starts and stops its own server on port 5196)
const {spawn} = require('node:child_process');
const {mkdtempSync} = require('node:fs');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {chromium} = require('playwright');

const PORT = 5196, BASE = `http://localhost:${PORT}`;
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`PASS  ${name}`); } else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-views-'));
  const server = spawn('npx', ['vite', '--mode', 'demo', '--port', String(PORT), '--strictPort'], {cwd: join(__dirname, '../..'),
    env: {...process.env, TASKS_DB: join(dir, 'tasks.db'), TASKS_BACKUPS: join(dir, 'backups'), TASKS_NO_SYNC: '1'}, stdio: 'ignore', detached: true});
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/api/bootstrap'); break; } catch { await wait(500); } }
  const browser = await chromium.launch();
  const p = await browser.newPage({viewport: {width: 1400, height: 900}});
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  const call = (path, method = 'GET', body) => p.evaluate(([path, method, body]) => {
    const ws = sessionStorage.getItem('tasks-ws') ?? localStorage.getItem('tasks-ws') ?? 'main';
    const me = sessionStorage.getItem(`me:${ws}`) ?? localStorage.getItem(`me:${ws}`) ?? localStorage.getItem('me') ?? '';
    return fetch('/api' + path, {method, headers: {'content-type': 'application/json', 'x-person': me}, body: body === undefined ? undefined : JSON.stringify(body)}).then(r => r.json());
  }, [path, method, body]);
  const filterText = () => p.locator('.toolbar button', {hasText: 'ilter'}).first().innerText();
  const shown = async () => Number((await p.locator('.head-count b').innerText().catch(() => '-1')));
  try {
    await p.goto(`${BASE}/#/mywork`); await p.waitForTimeout(1500);
    const boot = await call('/bootstrap');
    const proj = boot.projects.find(x => !x.settings?.rollup);
    await p.goto(`${BASE}/#/p/${proj.id}/x`); await p.waitForTimeout(1200);
    await p.locator('.tabs button', {hasText: 'View'}).first().click(); await p.waitForTimeout(300);
    await p.locator('.pop-row', {hasText: 'Table'}).first().click(); await p.waitForTimeout(1200);
    const all = await shown();
    check('header: counts what the view shows', all > 0, String(all));

    // A rule that hides everything: status is a status nobody uses would be fragile, so filter by title text.
    await p.locator('.toolbar .search').fill('zzz-no-match'); await p.waitForTimeout(900);
    check('header: count follows the filter', await shown() === 0, String(await shown()));
    await p.locator('.toolbar .search').fill(''); await p.waitForTimeout(900);

    await p.locator('.toolbar button', {hasText: 'Filter'}).click(); await p.waitForTimeout(300);
    await p.locator('button', {hasText: 'Add rule'}).click(); await p.waitForTimeout(800);
    await p.keyboard.press('Escape'); await p.waitForTimeout(500);
    await p.reload(); await p.waitForTimeout(1800);
    check('views: your own filter is kept after a reload', /1 filter/.test(await filterText()) && await p.locator('.mine-note').count() === 1);

    await p.locator('.mine-note button', {hasText: 'Save for everyone'}).click(); await p.waitForTimeout(1000);
    await p.reload(); await p.waitForTimeout(1800);
    check('views: Save for everyone keeps the filter', /1 filter/.test(await filterText()) && !(await p.locator('.mine-note').count()));

    // Bug found: clearing a team filter for yourself came back after a reload (the cleared value was not saved).
    await p.locator('.toolbar button', {hasText: 'ilter'}).first().click(); await p.waitForTimeout(300);
    await p.locator('button', {hasText: 'Clear all'}).click(); await p.waitForTimeout(800); await p.keyboard.press('Escape');
    await p.reload(); await p.waitForTimeout(1800);
    check('views: clearing a filter for yourself is kept after a reload', (await filterText()).trim() === 'Filter', await filterText());
    await p.locator('.mine-note button', {hasText: 'Reset to team view'}).click(); await p.waitForTimeout(800);
    check('views: Reset to team view brings the team filter back', /1 filter/.test(await filterText()));

    // Focus bar: two tasks in focus, one running.
    const items = boot.items.filter(i => !i.completed && !i.parentId).slice(0, 2);
    await call('/prefs', 'PUT', {key: 'focusList', value: items.map(i => i.id)});
    await call('/time/start', 'POST', {itemId: items[0].id});
    await p.reload(); await p.waitForTimeout(1800);
    const bar = p.locator('.focus-bar');
    check('focus bar: starts at the top', await bar.evaluate(e => e.classList.contains('at-tc')));
    const g = await p.locator('.fb-grip').boundingBox();
    await p.mouse.move(g.x + 10, g.y + 8); await p.mouse.down();
    await p.mouse.move(900, 600, {steps: 6}); await p.mouse.move(1350, 860, {steps: 6}); await p.mouse.up(); await p.waitForTimeout(400);
    check('focus bar: dragged to the bottom right, it snaps there', await bar.evaluate(e => e.classList.contains('at-br')));
    const b = await bar.boundingBox();
    check('focus bar: snapped inside the window', b.x + b.width <= 1400 && b.y + b.height <= 900, JSON.stringify(b));
    await p.reload(); await p.waitForTimeout(1800);
    check('focus bar: its spot is kept after a reload', await bar.evaluate(e => e.classList.contains('at-br')));
    await p.locator('.fb-grip').dblclick(); await p.waitForTimeout(300);
    check('focus bar: double-click puts it back at the top', await bar.evaluate(e => e.classList.contains('at-tc')));
    await bar.locator('button[title^="Shrink"]').click(); await p.waitForTimeout(300);
    check('focus bar: shrink shows only the running task', await bar.locator('.fb-item').count() === 1);
    await bar.locator('button[title^="Show all"]').click(); await p.waitForTimeout(300);
    check('focus bar: show all brings both back', await bar.locator('.fb-item').count() === 2);
    await bar.locator('button[title^="Clear the others"]').click(); await p.waitForTimeout(800);
    check('focus bar: clear keeps the running task only', await bar.locator('.fb-item').count() === 1 && await bar.locator('.fb-item.on').count() === 1);
    await call('/time/stop', 'POST', {});

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
