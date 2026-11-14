// Day planner scenarios in a real browser, on a fresh demo server with its own data.
// Run: node tests/e2e/planner.e2e.cjs   (needs Playwright; starts and stops its own server on port 5199)
// Each scenario is one of the things people do; a failure names it. Add a scenario for every bug found.
const {spawn} = require('node:child_process');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {chromium} = require('playwright');

const PORT = 5199, BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => { results.push({name, ok, detail}); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));
/** Real hands keep moving a little at the target; headless Chromium only delivers dragover on moves. */
const jiggle = async (page, x, y) => { for (let i = 0; i < 4; i++) { await page.mouse.move(x + (i % 2), y + (i % 2)); await wait(60); } };

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-e2e-'));
  const server = spawn('npx', ['vite', '--mode', 'demo', '--port', String(PORT), '--strictPort'], {cwd: join(__dirname, '../..'),
    env: {...process.env, TASKS_DB: join(dir, 'tasks.db'), TASKS_BACKUPS: join(dir, 'backups'), TASKS_NO_SYNC: '1'}, stdio: 'ignore', detached: true});
  let browser;
  try {
    try { await fetch(BASE + '/api/people'); throw new Error(`Port ${PORT} is already in use; stop that server first`); } catch (e) { if (/already in use/.test(e.message)) throw e; }
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/people')).ok) break; } catch { /* starting */ } await wait(500); }
    const api = (path, init = {}, me) => fetch(BASE + '/api' + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(me ? {'x-person': me} : {})}, body: init.body ? JSON.stringify(init.body) : undefined}).then(r => r.json());
    const people = await api('/people');
    const me = people.find(p => p.kind !== 'ai').id;
    const spaces = (await api('/projects', {}, me)).filter(p => !p.settings.rollup);
    const space = spaces[0].id;
    // A task that the brain dump should find.
    const survey = await api('/items', {method: 'POST', body: {projectId: space, title: 'Evaluate customer survey results'}}, me);
    const today = new Date(); const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    browser = await chromium.launch();
    const page = await browser.newPage({viewport: {width: 1500, height: 950}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(([id, s]) => { localStorage.setItem('me:main', id); localStorage.setItem('me', id); localStorage.setItem('day-space', s); localStorage.removeItem('day-design'); }, [me, space]);
    await page.goto(BASE + '/#/day');
    await page.waitForSelector('.dp-grid');
    const plan = () => api(`/day/${date}`, {}, me);
    const dump = page.locator('.dp-dumpsec textarea');

    // 1. Brain dump takes lines.
    await dump.fill('eval survey'); await dump.press('Enter');
    await dump.fill('do laundry'); await dump.press('Enter');
    await dump.fill('call distributors'); await dump.press('Enter');
    await wait(700);
    check('brain dump adds lines', (await plan()).dump.length === 3);

    // 2. Match shows a few chips, not a list of every task, and tying one updates the task.
    await page.getByRole('button', {name: /Match off/}).click();
    const chips = page.locator('.dp-sug:not(.none)');
    check('match shows at most 3 suggestions per line', (await chips.count()) <= 9 && (await chips.count()) >= 1, `${await chips.count()} chips`);
    await page.locator('.dp-sug', {hasText: 'Evaluate customer survey'}).first().click();
    await wait(800);
    const linked = (await plan()).dump.find(e => e.itemId === survey.id);
    const task = (await api('/items?open=true', {}, me)).find(i => i.id === survey.id);
    check('tying a line links it to the task', !!linked);
    check('tying a line puts the task on your day (assigned, due today if no date)', task.assignees.includes(me) && task.due === date, `${task.assignees.join(',')} ${task.due}`);

    // 3. Reorder the dump by dragging, with a drop line shown first.
    const rows = () => page.locator('.dp-dumpsec .dp-entry .dp-text').allInnerTexts();
    const before = await rows();
    const last = page.locator('.dp-dumpsec .dp-entry').last(), first = page.locator('.dp-dumpsec .dp-entry').first();
    await last.hover(); await page.mouse.down();
    const lb0 = await last.boundingBox(); await page.mouse.move(lb0.x + 30, lb0.y - 6, {steps: 3}); await wait(150);
    const fb = await first.boundingBox();
    await page.mouse.move(fb.x + 40, fb.y + 4, {steps: 8});
    const showsLine = await page.locator('.dp-entry.drop-before, .dp-entry.drop-after').count();
    await page.mouse.up(); await wait(700);
    const after = await rows();
    check('dragging in a list shows where it will land', showsLine > 0);
    check('dump lines can be reordered', after[0] === before[before.length - 1], `${before.join(' | ')} -> ${after.join(' | ')}`);

    // 4. Drag a line into Top 3, with the section lit up before the drop.
    const laundry = page.locator('.dp-dumpsec .dp-entry', {hasText: 'do laundry'});
    await laundry.hover(); await page.mouse.down();
    const lb = await laundry.boundingBox(); await page.mouse.move(lb.x + 30, lb.y - 20, {steps: 4}); await wait(150);
    const tb = await page.locator('.dp-top').boundingBox();
    await page.mouse.move(tb.x + 60, tb.y + tb.height - 12, {steps: 8}); await jiggle(page, tb.x + 60, tb.y + tb.height - 12);
    const lit = await page.locator('.dp-top.drop-on, .dp-dropzone.on').count();
    await page.mouse.up(); await wait(700);
    const p4 = await plan();
    check('Top 3 shows it will take the drop', lit > 0);
    check('dragging into Top 3 moves the line there', p4.top.some(e => e.text === 'do laundry') && !p4.dump.some(e => e.text === 'do laundry'));

    // 5. Drag onto the day: a preview at the snapped time, then a box there.
    const call = page.locator('.dp-dumpsec .dp-entry', {hasText: 'call distributors'});
    await call.hover(); await page.mouse.down();
    const grid = page.locator('.dp-grid'); const gb = await grid.boundingBox();
    await page.locator('.dp-day').evaluate(el => { el.scrollTop = 0; });
    const gb2 = await grid.boundingBox();
    await page.mouse.move(gb2.x + 300, gb2.y + 200, {steps: 10});
    const preview = await page.locator('.dp-ghost.drop').count();
    await page.mouse.up(); await wait(700);
    const box = (await plan()).blocks.find(b => b.text === 'call distributors');
    check('dragging onto the day previews the time', preview > 0);
    check('dropping makes a time box', !!box, box ? box.start : 'none');
    void gb;

    // 6. A plain box has a play button; pressing it makes a task and starts the timer.
    const boxEl = page.locator('.dp-block', {hasText: 'call distributors'});
    const play = boxEl.locator('button[title^="Start a timer"]');
    check('plain boxes have a play button', (await play.count()) === 1);
    if (await play.count()) { await play.click(); await wait(1200); }
    const b6 = (await plan()).blocks.find(b => b.text.toLowerCase().includes('call distributors'));
    const running = await api(`/time/running?person=${me}`, {}, me);
    check('play turns the box into a task and times it', !!b6?.itemId && running?.itemId === b6.itemId);

    // 7. Clicking the box body opens the side editor; a click on the day then only closes it.
    await page.locator('.dp-block', {hasText: 'call distributors'}).click({position: {x: 200, y: 30}});
    check('clicking a box opens its editor', await page.locator('.dp-editor').isVisible());
    const nBoxes = (await plan()).blocks.length;
    await page.mouse.move(gb2.x + 300, gb2.y + 600); await page.mouse.down(); await page.mouse.up(); await wait(700);
    check('with the editor open, a click on the day closes it and makes no box', !(await page.locator('.dp-editor').count()) && (await plan()).blocks.length === nBoxes);

    // 8. Create tasks, then Ctrl+Z takes them away again.
    await dump.fill('write article'); await dump.press('Enter'); await wait(500);
    page.once('dialog', d => d.accept());
    await page.getByRole('button', {name: /Create tasks/}).click(); await wait(1500);
    const made = (await plan()).dump.find(e => e.text.toLowerCase().includes('write article'))?.itemId;
    check('Create tasks makes a task for a new line', !!made);
    await page.locator('body').click({position: {x: 5, y: 5}});
    await page.keyboard.press('Control+z'); await wait(1500);
    const gone = !(await api('/items', {}, me)).some(i => i.id === made);
    check('Ctrl+Z undoes Create tasks', gone && !(await plan()).dump.find(e => e.text.toLowerCase().includes('write article'))?.itemId);

    // 9. The day runs to midnight; early hours fold open; now is marked.
    check('the day goes to 12am', (await page.locator('.dp-hour', {hasText: /^11pm$/}).count()) === 1);
    await page.locator('.dp-early').click(); await wait(300);
    check('early hours fold open', (await page.locator('.dp-hour', {hasText: /^12am$/}).count()) === 1);
    check('now is marked with a red line', (await page.locator('.dp-now').count()) === 1);

    // 10. Box titles are editable, for tasks too.
    await page.locator('.dp-block').first().click({position: {x: 250, y: 30}});
    const title = page.locator('.dp-editor .dp-etitle');
    check('box editor has an editable title', (await title.count()) === 1 && await title.isEditable());

    // 11. Fit to my time: boxes move to logged time, the plan stays as an outline, logged work with no box gets one, Ctrl+Z undoes.
    await page.keyboard.press('Escape');
    const fitTask = await api('/items', {method: 'POST', body: {projectId: space, title: 'Fit me', assignees: [me]}}, me);
    const extra = await api('/items', {method: 'POST', body: {projectId: space, title: 'Surprise work', assignees: [me]}}, me);
    const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
    const p11 = await plan();
    await api(`/day/${date}`, {method: 'PUT', body: {blocks: [...p11.blocks, {id: 'fitbox', text: '', itemId: fitTask.id, start: '15:00', minutes: 60}]}}, me);
    await api('/time', {method: 'POST', body: {itemId: fitTask.id, person: me, start: at(15, 20), end: at(16, 5)}}, me);
    await api('/time', {method: 'POST', body: {itemId: extra.id, person: me, start: at(17, 0), end: at(17, 30)}}, me);
    await page.reload(); await page.waitForSelector('.dp-grid'); await wait(800);
    await page.getByRole('button', {name: /Fit to my time/}).click();
    await page.getByRole('button', {name: /^Whole day/}).click(); await wait(1200);
    const p11b = await plan(), fb2 = p11b.blocks.find(b => b.id === 'fitbox');
    check('Fit to my time moves a box to when the work was logged', fb2 && fb2.start === '15:20' && fb2.minutes === 45 && fb2.planned?.start === '15:00', JSON.stringify(fb2));
    check('logged work with no box gets one', p11b.blocks.some(b => b.itemId === extra.id && b.start === '17:00' && b.minutes === 30));
    check('the planned time shows as an outline, with a planned vs logged summary', (await page.locator('.dp-planned').count()) >= 1 && (await page.locator('.dp-fitinfo').count()) === 1);
    await page.locator('body').click({position: {x: 5, y: 5}}); await page.keyboard.press('Control+z'); await wait(1200);
    check('Ctrl+Z puts the plan back after a fit', (await plan()).blocks.find(b => b.id === 'fitbox')?.start === '15:00');

    check('no page errors', !errors.length, errors.join('; '));
  } catch (e) {
    check('scenario run finished', false, e.message);
  } finally {
    await browser?.close();
    try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
    rmSync(dir, {recursive: true, force: true});
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
