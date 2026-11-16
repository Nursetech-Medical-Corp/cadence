// Design check: on the main pages, no two buttons, fields or chips touch or overlap (at least 3px apart; tab strips excepted).
// Run: node tests/e2e/spacing.e2e.cjs   (needs Playwright; starts and stops its own server on port 5197)
const {spawn} = require('node:child_process');
const {mkdtempSync} = require('node:fs');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {chromium} = require('playwright');

const PORT = 5197, BASE = `http://localhost:${PORT}`;
const PAGES = ['#/mywork', '#/team', '#/approvals', '#/ai', '#/boards', '#/plugins', '#/plugins/cadence.sprint-views', '#/plugins/cadence.day-planner', '#/routines', '#/templates', '#/data', '#/timesheet', '#/plan', '#/help'];
const MIN = 3;

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-spacing-'));
  const server = spawn('npx', ['vite', '--mode', 'demo', '--port', String(PORT), '--strictPort'], {cwd: join(__dirname, '../..'),
    env: {...process.env, TASKS_DB: join(dir, 'tasks.db'), TASKS_BACKUPS: join(dir, 'backups'), TASKS_NO_SYNC: '1'}, stdio: 'ignore', detached: true});
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/api/bootstrap'); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  let failed = 0, passed = 0;
  const only = process.argv[2];
  try {
    const boot = await (await fetch(BASE + '/api/bootstrap')).json();
    const space = boot.projects.find(p => !p.settings.rollup);
    const pages = [...PAGES, `#/p/${space.id}/settings`].filter(p => !only || p.includes(only));
    for (const hash of pages) {
      await page.goto(`${BASE}/${hash}`);
      await page.waitForTimeout(1200);
      // Open every details element so collapsed cards are checked too.
      await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
      await page.waitForTimeout(200);
      const bad = await page.evaluate(MIN => {
        const sel = 'button, select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, .chip-toggle, .pl-tag, .btn';
        const els = [...document.querySelectorAll(sel)].filter(e => {
          const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
          return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('.sidebar, .side, nav, .seg, .tabbar, .tab, [data-spacing-ok], .wb-world, .pal-row, .pop, .popover, table, .cal-wrap, .gantt, .board, .tg-ev, .dp-main');
        });
        const uniq = els.filter(e => !els.some(o => o !== e && o.contains(e)));
        const out = [];
        for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
          const a = uniq[i].getBoundingClientRect(), b = uniq[j].getBoundingClientRect();
          const dx = Math.max(b.left - a.right, a.left - b.right), dy = Math.max(b.top - a.bottom, a.top - b.bottom);
          // Neighbours on a line (overlap vertically) closer than MIN, or stacked (overlap horizontally) closer than MIN.
          if ((dy < 0 && dx < MIN && dx > -10000) || (dx < 0 && dy < MIN && dy > -10000)) {
            const name = e => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}("${(e.textContent || e.placeholder || e.value || '').trim().slice(0, 18)}")`;
            const parent = uniq[i].parentElement;
            out.push(`${name(uniq[i])} / ${name(uniq[j])} in ${parent?.className || parent?.tagName} (${Math.round(Math.max(dx, dy))}px)`);
          }
        }
        return out.slice(0, 12);
      }, MIN);
      if (bad.length) { failed++; console.log(`FAIL  ${hash}\n  ${bad.join('\n  ')}`); }
      else { passed++; console.log(`ok    ${hash}`); }
    }
  } finally {
    await browser.close();
    process.kill(-server.pid);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
