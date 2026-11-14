// Whiteboard scenarios in a real browser, on a fresh demo server with its own data.
// Run: node tests/e2e/whiteboard.e2e.cjs   (needs Playwright; starts and stops its own server on port 5199)
// Each scenario is one of the things people do; a failure names it. Add a scenario for every bug found.
const {spawn} = require('node:child_process');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {chromium} = require('playwright');

const PORT = 5198, BASE = `http://127.0.0.1:${PORT}`;
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
    const board = await api('/boards', {method: 'POST', body: {name: 'Test flow', projectId: space, nodes: [
      {id: 'a', kind: 'task', x: 0, y: 0, text: 'First'}, {id: 'b', kind: 'task', x: 400, y: 0, text: 'Second'}, {id: 'c', kind: 'task', x: 0, y: 300, text: 'Third'}]}}, me);
    browser = await chromium.launch();
    const page = await browser.newPage({viewport: {width: 1500, height: 950}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(id => { localStorage.setItem('me:main', id); localStorage.setItem('me', id); }, me);
    await page.goto(`${BASE}/#/boards/${board.id}`);
    await page.waitForSelector('.wb-node');
    await wait(600);
    const get = () => api(`/boards/${board.id}`, {}, me);
    const box = id => page.locator(`[data-node="${id}"]`).boundingBox();

    // 1. Connect by dropping NEAR a card, not exactly on it: the arrow snaps.
    const a = await box('a'), b = await box('b');
    await page.locator('[data-node="a"]').hover();
    const port = await page.locator('[data-node="a"] .wb-port.p-r').boundingBox();
    await page.mouse.move(port.x + 6, port.y + 6); await page.mouse.down();
    await page.mouse.move(b.x - 14, b.y + b.height / 2, {steps: 12});
    const lit = await page.locator('[data-node="b"].snap').count();
    await page.mouse.up(); await wait(900);
    check('a card lights up when an arrow will snap to it', lit === 1);
    check('dropping an arrow near a card connects it', (await get()).edges.some(e => e.from === 'a' && e.to === 'b'));

    // 2. Left drag on empty board box-selects.
    await page.mouse.move(a.x - 40, a.y - 40); await page.mouse.down(); await page.mouse.move(b.x + b.width + 20, b.y + b.height + 20, {steps: 8}); await page.mouse.up(); await wait(200);
    check('left drag on the board box-selects', (await page.locator('.wb-node.sel').count()) === 2);

    // 3. Middle drag pans; the cards stay where they are on the board.
    const before = await box('c');
    await page.mouse.move(700, 700); await page.mouse.down({button: 'middle'}); await page.mouse.move(800, 760, {steps: 6}); await page.mouse.up({button: 'middle'}); await wait(200);
    const afterPan = await box('c');
    check('middle drag pans the board', Math.round(afterPan.x - before.x) === 100 && Math.round(afterPan.y - before.y) === 60, `${afterPan.x - before.x}, ${afterPan.y - before.y}`);
    check('panning moves no cards', JSON.stringify((await get()).nodes.find(n => n.id === 'c')) === JSON.stringify((await get()).nodes.find(n => n.id === 'c')) && (await get()).nodes.find(n => n.id === 'c').x === 0);

    // 4. Shift+wheel scrolls sideways.
    const w0 = await box('c');
    await page.mouse.move(700, 600); await page.keyboard.down('Shift'); await page.mouse.wheel(0, 120); await page.keyboard.up('Shift'); await wait(200);
    const w1 = await box('c');
    check('Shift+wheel scrolls sideways', Math.round(w1.x - w0.x) !== 0 && Math.round(w1.y - w0.y) === 0, `${w1.x - w0.x}, ${w1.y - w0.y}`);

    // 5. Tables: add one, type in cells with Tab.
    await page.getByRole('button', {name: /^Table$/}).click(); await wait(400);
    const cell = page.locator('.wb-table td').first();
    await cell.dblclick(); await page.keyboard.type('Pat'); await page.keyboard.press('Tab'); await page.keyboard.type('Sales'); await page.keyboard.press('Enter'); await wait(900);
    const table = (await get()).nodes.find(n => n.kind === 'table');
    check('tables take typing, Tab moves to the next cell', table && table.table[1][0] === 'Pat' && table.table[1][1] === 'Sales', JSON.stringify(table?.table));

    // 6. Decisions label their arrows Yes, then No.
    await page.locator('.wb-canvas').click({position: {x: 600, y: 120}});
    await page.getByRole('button', {name: /^Decision$/}).click(); await wait(300);
    await page.keyboard.press('Escape'); await page.locator('.wb-canvas').click({position: {x: 40, y: 800}}); await wait(300);
    const dId = (await get()).nodes.find(n => n.kind === 'decision').id;
    for (const to of ['b', 'c']) {
      await page.locator(`[data-node="${dId}"]`).hover();
      const pp = await page.locator(`[data-node="${dId}"] .wb-port.p-r`).boundingBox();
      const t = await box(to);
      await page.mouse.move(pp.x + 6, pp.y + 6); await page.mouse.down(); await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, {steps: 10}); await page.mouse.up(); await wait(700);
    }
    const labels = (await get()).edges.filter(e => e.from === dId).map(e => e.label);
    check('arrows out of a decision are labeled Yes then No', labels.join(',') === 'Yes,No', labels.join(','));

    // 7. Titles: a new board opens with one.
    check('the toolbar has flow and note tools', (await page.getByRole('button', {name: /Start\/stop/}).count()) === 1 && (await page.getByRole('button', {name: /^Info$/}).count()) === 1);

    // 8. Import a Claude Whiteboards board through the page: sections, colored blocks, bold text, a table, labeled dashed elbow arrows.
    await page.goto(`${BASE}/#/boards`); await page.waitForSelector('.wb-new'); await wait(400);
    await page.getByRole('button', {name: /^Import$/}).click();
    await page.locator('.wb-import textarea').fill(JSON.stringify([
      {id: 't', type: 'text', x: 0, y: 0, size: 'title', text: 'Imported flow'},
      {id: 'f', type: 'container', x: -40, y: 120, w: 900, h: 300, text: '1. How it connects'},
      {id: 'a', type: 'shape', kind: 'rounded', x: 0, y: 160, w: 220, h: 100, color: 'blue', text: '**Cadence**\n- tasks\n- approvals'},
      {id: 'b', type: 'shape', kind: 'hexagon', x: 400, y: 260, w: 220, h: 100, color: 'green', text: 'Agent'},
      {id: 'x', type: 'arrow', from: 'a', to: 'b', fromSide: 'right', toSide: 'left', label: 'wake', dash: true},
      {id: 'tb', type: 'table', x: 0, y: 460, cols: {c1: {at: 1, w: 80}, c2: {at: 2, w: 240}}, rows: {r1: {at: 1, c1: '#', c2: 'When'}, r2: {at: 2, c1: 'W1', c2: 'New email'}}},
      {id: 's', type: 'stroke', x: 0, y: 0, points: [0, 0, 5, 5]},
    ]));
    await page.locator('.wb-import').getByRole('button', {name: /^Import$/}).click(); await wait(1500);
    check('import opens the new board', /#\/boards\/\w+/.test(page.url()) && (await page.locator('.wb-node').count()) === 5);
    check('imported text keeps bold and lists', (await page.locator('.wb-node b', {hasText: 'Cadence'}).count()) === 1 && (await page.locator('.wb-node li').count()) === 2, `${await page.locator('.wb-node b', {hasText: 'Cadence'}).count()} bold, ${(await page.locator('.wb-node li').allInnerTexts()).join('|')} items`);
    check('imported tables keep their header and column widths', (await page.locator('.wb-table th').count()) === 2 && (await page.locator('.wb-table col').count()) === 2);
    const d = await page.locator('.wb-edges path[stroke-dasharray]').first().getAttribute('d');
    check('imported arrows are dashed right-angle lines with their label', /H/.test(d || '') && (await page.locator('.wb-elabel', {hasText: 'wake'}).count()) === 1, d);
    check('section titles sit above their frame', await page.locator('.wb-node.k-frame .wb-frame-title').evaluate(el => el.getBoundingClientRect().bottom <= el.parentElement.getBoundingClientRect().top + 1));

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
