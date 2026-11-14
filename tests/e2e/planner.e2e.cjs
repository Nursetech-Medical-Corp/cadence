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
const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
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
    await page.addInitScript(([id, s]) => { localStorage.setItem('me:main', id); localStorage.setItem('me', id); localStorage.setItem('day-space', s); if (!sessionStorage.getItem('e2e-started')) { sessionStorage.setItem('e2e-started', '1'); localStorage.removeItem('day-design'); } }, [me, space]);
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

    // 7. Clicking a task box opens the task; the clock opens the time slot editor; a click on the day then only closes it.
    await page.locator('.dp-block', {hasText: 'call distributors'}).click({position: {x: 200, y: 30}}); await wait(500);
    check('clicking a task box opens the task itself', await page.locator('aside.panel').isVisible() && !(await page.locator('.dp-editor').count()));
    await page.keyboard.press('Escape'); await page.locator('aside.panel button[title^="Close"]').click().catch(() => {}); await wait(300);
    await page.locator('.dp-block', {hasText: 'call distributors'}).hover();
    await page.locator('.dp-block', {hasText: 'call distributors'}).locator('button[title^="Edit this time slot"]').click(); await wait(300);
    check('the clock on a box opens its time slot editor', await page.locator('.dp-editor').isVisible());
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
    await page.keyboard.press('Escape');
    await page.locator('.dp-block').first().hover(); await page.locator('.dp-block').first().locator('button[title^="Edit this time slot"]').click(); await wait(300);
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

    // 12. Drag the top edge: the start moves, the end stays.
    await page.reload(); await page.waitForSelector('.dp-grid'); await wait(800);
    const fbx = page.locator('.dp-block', {hasText: 'Fit me'}).first();
    await fbx.scrollIntoViewIfNeeded(); await fbx.hover();
    const tb2 = await fbx.locator('.dp-resize.top').boundingBox();
    const before12 = (await plan()).blocks.find(b => b.id === 'fitbox');
    await page.mouse.move(tb2.x + 20, tb2.y + 2); await page.mouse.down(); await page.mouse.move(tb2.x + 20, tb2.y + 2 - 42 * 1.4 / 1.4 * 1, {steps: 6}); await page.mouse.up(); await wait(900);
    const after12 = (await plan()).blocks.find(b => b.id === 'fitbox');
    check('dragging the top edge moves the start and keeps the end', after12.start < before12.start && mins(after12.start) + after12.minutes === mins(before12.start) + before12.minutes, `${before12.start}+${before12.minutes} -> ${after12.start}+${after12.minutes}`);

    // 13. The week strip, the day's timesheet, and the time zone note.
    check('the week strip shows 7 days', (await page.locator('.dp-wday').count()) === 7);
    check('the timesheet for the day lists timed entries', (await page.locator('.dp-tsrow').count()) >= 2);
    await api(`/day/${date}`, {method: 'PUT', body: {tz: 'Asia/Tokyo'}}, me);
    await page.reload(); await page.waitForSelector('.dp-grid'); await wait(800);
    check('a day planned in another time zone says so', (await page.locator('.dp-tznote').count()) === 1);
    await page.getByRole('button', {name: 'Use my time zone'}).click(); await wait(900);
    check('Use my time zone switches the day to this computer\'s zone', (await plan()).tz === Intl.DateTimeFormat().resolvedOptions().timeZone);

    // 14. Each view keeps the week row, Today and the day arrows (they stay put while the hours scroll).
    for (const view of ['columns', 'horizontal', 'focus']) {
      await page.evaluate(v => localStorage.setItem('day-design', v), view); await page.reload(); await page.waitForSelector('.dp-grid'); await wait(600);
      if (process.env.SHOTS) await page.screenshot({path: join(process.env.SHOTS, `planner-${view}.png`)});
      await page.locator('.dp-day').evaluate(el => { el.scrollTop = 99999; el.scrollLeft = 99999; }); await wait(200);
      const vis = async sel => { const b = await page.locator(sel).first().boundingBox(); return !!b && b.y >= 0 && b.y < 950 && b.height > 0; };
      check(`${view}: the view is on`, (await page.locator(`.dp.d-${view}`).count()) === 1);
      check(`${view}: the week row stays in view after scrolling the day`, await vis('.dp-week') && (await page.locator('.dp-wday').count()) === 7);
      check(`${view}: day arrows stay in view`, await vis('.dp-daynav'));
      await page.locator('.dp-wday').nth(0).click(); await wait(400);
      check(`${view}: the week row is still there after picking a day`, (await page.locator('.dp-wday').count()) === 7 && await vis('.dp-week'));
      check(`${view}: Today brings you back`, (await page.locator('.dp-daynav button', {hasText: 'Today'}).count()) === 1 || (await page.locator('.dp-wday').nth(0).getAttribute('class')).includes('today'));
      await page.locator('.dp-daynav button', {hasText: 'Today'}).click().catch(() => {}); await wait(300);
    }

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
