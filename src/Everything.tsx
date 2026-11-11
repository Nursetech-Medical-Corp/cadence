// Everything, across every workspace: a dashboard you arrange, one calendar, a personal timeline, and a list.
// Edits (dates, done) go straight to the item's own workspace. Opening an item from another workspace switches to it.
import {CoverHeader, type Cover} from './Cover.tsx';
import {useEffect, useMemo, useRef, useState} from 'react';
import {ChevronLeft, ChevronRight, LayoutDashboard, CalendarDays, GanttChart, List as ListIcon, Plus, RotateCcw} from 'lucide-react';
import type {Item, Project} from './types.ts';
import {api, apiIn, getMe, meIn, switchWorkspace, wsId, type Store} from './store.ts';
import {addDays, daysBetween, parseDay} from './dates.ts';
import {Popover, Empty} from './components.tsx';
import {WsMark, useWorkspaces, type Workspace} from './Workspaces.tsx';
import {DashGrid, place, type Cell} from './DashGrid.tsx';

type Row = {ws: Workspace; me: string; projects: Project[]; items: Item[]; error?: string};
type Tab = 'dash' | 'calendar' | 'timeline' | 'list';

function useEverything(store: Store, scope: 'mine' | 'all') {
  const [list] = useWorkspaces();
  const [rows, setRows] = useState<Row[] | null>(null);
  const load = () => {
    if (!list.length) return;
    const mine = store.people.find(p => p.id === getMe());
    Promise.all(list.map(async (ws): Promise<Row> => {
      try {
        const me = ws.id === wsId() ? getMe() : await meIn(ws.id, mine?.email ?? '', mine?.name ?? '');
        if (scope === 'mine' && !me) return {ws, me: '', projects: [], items: [], error: `No person matching you in ${ws.name}. Open it and pick who you are, or choose Everyone.`};
        const [projects, items] = await Promise.all([
          apiIn<Project[]>(ws.id, '/projects', me),
          apiIn<Item[]>(ws.id, `/items?open=true${scope === 'mine' && me ? `&assignee=${me}` : ''}`, me),
        ]);
        return {ws, me, projects: projects.filter(p => !p.settings.rollup), items};
      } catch (e) { return {ws, me: '', projects: [], items: [], error: String(e instanceof Error ? e.message : e)}; }
    })).then(setRows);
  };
  useEffect(load, [list, scope, store.tick]);
  /** Saves a change in the item's own workspace; the screen updates right away. */
  const update = async (row: Row, item: Item, patch: Partial<Item>) => {
    setRows(rs => rs?.map(r => r === row ? {...r, items: r.items.map(i => i.id === item.id ? {...i, ...patch} : i)} : r) ?? null);
    const res = await fetch(`/api/items/${item.id}`, {method: 'PATCH', headers: {'content-type': 'application/json', 'x-workspace': row.ws.id, 'x-person': row.me}, body: JSON.stringify(patch)});
    if (!res.ok) { store.fail(new Error((await res.json().catch(() => null))?.error ?? 'Could not save')); load(); }
  };
  const complete = (row: Row, item: Item) => {
    const done = row.projects.find(p => p.id === item.projectId)?.statuses.find(s => s.category === 'done')?.id;
    if (done) update(row, item, {status: done, completed: new Date().toISOString()}).then(() => setRows(rs => rs?.map(r => r === row ? {...r, items: r.items.filter(i => i.id !== item.id)} : r) ?? null));
  };
  return {rows, update, complete, reload: load};
}

const keyOf = (row: Row, i: Item) => { const p = row.projects.find(x => x.id === i.projectId); return p ? `${p.key}-${i.number}` : ''; };
/** Moving an item keeps its length: start shifts by as much as due. */
const moveTo = (i: Item, due: string): Partial<Item> => {
  const d = i.due ? daysBetween(i.due, due) : 0;
  return {due, ...(i.start && i.due ? {start: addDays(i.start, d)} : {})};
};

export function Everything({store, open}: {store: Store; open: (id: string) => void}) {
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('everything-tab') as Tab) || 'dash');
  const [scope, setScope] = useState<'mine' | 'all'>(() => (localStorage.getItem('everything-scope') as 'mine' | 'all') || 'mine');
  const [hidden, setHidden] = useState<string[]>(() => JSON.parse(localStorage.getItem('everything-hidden') ?? '[]'));
  const {rows, update, complete} = useEverything(store, scope);
  const shown = rows?.filter(r => !hidden.includes(r.ws.id)) ?? [];
  const go = (row: Row, i: Item) => {
    if (row.ws.id === wsId()) return open(i.id);
    sessionStorage.setItem('open-after', i.id);
    switchWorkspace(row.ws.id, `/p/${i.projectId}/`);
  };
  const setT = (t: Tab) => { setTab(t); localStorage.setItem('everything-tab', t); };
  const ctx = {rows: shown, update, complete, go, today: store.today};
  return (
    <div className="page every" style={{maxWidth: 'none'}}>
      {getMe() && <CoverHeader name={`everything-${getMe()}`} value={store.prefs['cover:everything'] as Cover | undefined} onChange={c => store.setPref('cover:everything', c)} />}
      <div className="every-head">
        <h1>Everything</h1>
        <span className="muted">All your workspaces in one place. Changes save to each item's own workspace.</span>
        <span className="spacer" />
        <div className="seg">{([['mine', 'Assigned to me'], ['all', 'Everyone']] as const).map(([k, l]) => <button key={k} className={scope === k ? 'on' : ''} onClick={() => { setScope(k); localStorage.setItem('everything-scope', k); }}>{l}</button>)}</div>
        <div className="ws-filter">{rows?.map(r => <button key={r.ws.id} className={'ws-chip' + (hidden.includes(r.ws.id) ? ' off' : '')} title={hidden.includes(r.ws.id) ? 'Show' : 'Hide'}
          onClick={() => { const n = hidden.includes(r.ws.id) ? hidden.filter(x => x !== r.ws.id) : [...hidden, r.ws.id]; setHidden(n); localStorage.setItem('everything-hidden', JSON.stringify(n)); }}><WsMark w={r.ws} size={14} /> {r.ws.name}</button>)}</div>
      </div>
      <div className="tabs every-tabs">
        {([['dash', 'Dashboard', LayoutDashboard], ['calendar', 'Calendar', CalendarDays], ['timeline', 'Timeline', GanttChart], ['list', 'List', ListIcon]] as const).map(([k, l, I]) =>
          <button key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => setT(k)}><I size={14} /> {l}</button>)}
      </div>
      {!rows && <p className="muted">Loading every workspace...</p>}
      {rows?.filter(r => r.error).map(r => <p key={r.ws.id} className="small muted"><WsMark w={r.ws} size={14} /> {r.ws.name}: {r.error}</p>)}
      {rows && tab === 'dash' && <EveryDash {...ctx} />}
      {rows && tab === 'calendar' && <EveryCalendar {...ctx} />}
      {rows && tab === 'timeline' && <EveryTimeline {...ctx} />}
      {rows && tab === 'list' && <EveryList {...ctx} />}
    </div>
  );
}

type Ctx = {rows: Row[]; update: (r: Row, i: Item, p: Partial<Item>) => void; complete: (r: Row, i: Item) => void; go: (r: Row, i: Item) => void; today: string};
const flat = (rows: Row[]) => rows.flatMap(r => r.items.map(i => ({r, i})));

function ItemLine({r, i, c, showDate = true}: {r: Row; i: Item; c: Ctx; showDate?: boolean}) {
  return (
    <div className="every-line">
      <button className="check" title="Mark done" onClick={() => c.complete(r, i)} />
      <span className="ws-dot" style={{background: r.ws.color}} title={r.ws.name} />
      <button className="grow every-title" onClick={() => c.go(r, i)}><span className="muted small">{keyOf(r, i)}</span> {i.title}</button>
      {showDate && <input type="date" className="every-date" value={i.due ?? ''} onChange={e => c.update(r, i, e.target.value ? moveTo(i, e.target.value) : {due: null})} />}
    </div>
  );
}

// ---------- Dashboard ----------
const DW: Record<string, {title: string; hint: string; h: number}> = {
  kpis: {title: 'At a glance', hint: 'Open, overdue and due today per workspace', h: 4},
  overdue: {title: 'Overdue', hint: 'Past due, oldest first', h: 7},
  today: {title: 'Today', hint: 'Due today in every workspace', h: 6},
  week: {title: 'This week', hint: 'Seven days side by side; drag to reschedule', h: 6},
  upcoming: {title: 'Next 14 days', hint: 'Coming up soon', h: 7},
  load: {title: 'Load by workspace', hint: 'Open work and estimated hours', h: 5},
  nodate: {title: 'No date', hint: 'Open work without a due date', h: 6},
};
const DASH_DEFAULT: Cell[] = [{id: 'kpis', x: 0, y: 0, w: 6, h: 4}, {id: 'overdue', x: 0, y: 4, w: 2, h: 7}, {id: 'today', x: 2, y: 4, w: 2, h: 7}, {id: 'upcoming', x: 4, y: 4, w: 2, h: 7}, {id: 'week', x: 0, y: 11, w: 6, h: 6}];

function EveryDash(c: Ctx) {
  const [cells, setCells] = useState<Cell[]>(() => JSON.parse(localStorage.getItem('everything-grid') ?? 'null') ?? DASH_DEFAULT);
  const [adding, setAdding] = useState(false);
  const save = (x: Cell[]) => { setCells(x); localStorage.setItem('everything-grid', JSON.stringify(x)); };
  const all = flat(c.rows);
  const body = (id: string) => {
    const t = c.today, in14 = addDays(t, 14);
    const lines = (list: typeof all) => list.length ? list.slice(0, 60).map(({r, i}) => <ItemLine key={r.ws.id + i.id} r={r} i={i} c={c} />) : <div className="muted small">Nothing here.</div>;
    if (id === 'kpis') return <div className="kpi-row">{c.rows.map(r => {
      const o = r.items.filter(i => i.due && i.due < t).length, d = r.items.filter(i => i.due === t).length;
      return <div key={r.ws.id} className="kpi" style={{borderTopColor: r.ws.color}}><div className="kpi-ws"><WsMark w={r.ws} size={16} /> {r.ws.name}</div>
        <div className="kpi-nums"><span><b>{r.items.length}</b> open</span><span className={o ? 'bad' : ''}><b>{o}</b> overdue</span><span><b>{d}</b> today</span></div></div>;
    })}</div>;
    if (id === 'overdue') return lines(all.filter(x => x.i.due && x.i.due < t).sort((a, b) => a.i.due!.localeCompare(b.i.due!)));
    if (id === 'today') return lines(all.filter(x => x.i.due === t));
    if (id === 'upcoming') return lines(all.filter(x => x.i.due && x.i.due > t && x.i.due <= in14).sort((a, b) => a.i.due!.localeCompare(b.i.due!)));
    if (id === 'nodate') return lines(all.filter(x => !x.i.due));
    if (id === 'week') return <WeekStrip c={c} />;
    if (id === 'load') {
      const max = Math.max(1, ...c.rows.map(r => r.items.length));
      return <div>{c.rows.map(r => { const h = r.items.reduce((a, i) => a + (i.estimate ?? 0), 0); return (
        <div key={r.ws.id} className="load-row"><span className="load-name"><WsMark w={r.ws} size={14} /> {r.ws.name}</span>
          <span className="load-bar"><span style={{width: `${100 * r.items.length / max}%`, background: r.ws.color}} /></span><span className="small muted">{r.items.length} open{h ? `, ${+h.toFixed(1)}h` : ''}</span></div>); })}</div>;
    }
    return null;
  };
  return <>
    <div className="toolbar" style={{padding: '0 0 10px', border: 0}}>
      <span className="picker"><button className="btn" onClick={() => setAdding(o => !o)}><Plus size={14} /> Add widget</button>
        <Popover open={adding} onClose={() => setAdding(false)} className="wide">
          {Object.entries(DW).filter(([k]) => !cells.some(x => x.id === k)).map(([k, w]) => <button key={k} className="pop-row" onClick={() => { save([...cells, place(cells, k, 2, w.h)]); setAdding(false); }}><span className="grow"><div>{w.title}</div><div className="muted small">{w.hint}</div></span></button>)}
          {Object.keys(DW).every(k => cells.some(x => x.id === k)) && <div className="pop-row muted">All widgets are on the page</div>}
        </Popover></span>
      <button className="btn ghost" onClick={() => save(DASH_DEFAULT)}><RotateCcw size={14} /> Reset layout</button>
      <span className="muted small">Drag widgets by the grip, resize from the corner. Gaps are fine.</span>
    </div>
    <DashGrid cells={cells} onChange={save} defaultH={id => DW[id]?.h ?? 6} title={id => DW[id]?.title ?? id} body={body} />
  </>;
}

/** Seven days side by side; drop an item on a day to move it there. */
function WeekStrip({c}: {c: Ctx}) {
  const [drag, setDrag] = useState<{r: Row; i: Item} | null>(null);
  const days = Array.from({length: 7}, (_, n) => addDays(c.today, n));
  return <div className="week-strip">{days.map(d => (
    <div key={d} className={'week-day' + (d === c.today ? ' today' : '')} onDragOver={e => e.preventDefault()} onDrop={() => { if (drag) c.update(drag.r, drag.i, moveTo(drag.i, d)); setDrag(null); }}>
      <div className="small muted">{parseDay(d).toLocaleDateString(undefined, {weekday: 'short', day: 'numeric'})}</div>
      {flat(c.rows).filter(x => x.i.due === d).map(({r, i}) => <div key={r.ws.id + i.id} className="cal-chip" draggable onDragStart={() => setDrag({r, i})} style={{borderLeftColor: r.ws.color}} onClick={() => c.go(r, i)} title={`${r.ws.name}: ${i.title}`}>{i.title}</div>)}
    </div>
  ))}</div>;
}

// ---------- Calendar ----------
function EveryCalendar(c: Ctx) {
  const [month, setMonth] = useState(() => c.today.slice(0, 7));
  const [drag, setDrag] = useState<{r: Row; i: Item} | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const first = parseDay(month + '-01'), startDow = (first.getDay() + 6) % 7;
  const gridStart = addDays(month + '-01', -startDow);
  const days = Array.from({length: 42}, (_, n) => addDays(gridStart, n));
  // Your Google Calendar events (if connected) show next to tasks, read-only.
  const [gev, setGev] = useState<{id: string; title: string; start: string; link: string | null; account: string}[]>([]);
  useEffect(() => { api<typeof gev>(`/google/events?from=${days[0]}&to=${days[41]}`).then(setGev).catch(() => setGev([])); }, [month]);
  const byDay = useMemo(() => { const m = new Map<string, {r: Row; i: Item}[]>(); for (const x of flat(c.rows)) if (x.i.due) m.set(x.i.due, [...(m.get(x.i.due) ?? []), x]); return m; }, [c.rows]);
  const shift = (n: number) => { const d = new Date(first); d.setMonth(d.getMonth() + n); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); };
  return <>
    <div className="toolbar" style={{padding: '0 0 10px', border: 0}}>
      <button className="icon" onClick={() => shift(-1)}><ChevronLeft size={16} /></button>
      <b style={{minWidth: 150, textAlign: 'center'}}>{first.toLocaleDateString(undefined, {month: 'long', year: 'numeric'})}</b>
      <button className="icon" onClick={() => shift(1)}><ChevronRight size={16} /></button>
      <button className="btn ghost small" onClick={() => setMonth(c.today.slice(0, 7))}>Today</button>
      <span className="muted small">Drag an item to another day to reschedule it. Colors show the workspace.</span>
    </div>
    <div className="every-cal">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} className="cal-dow">{d}</div>)}
      {days.map(d => {
        const list = byDay.get(d) ?? [];
        return (
          <div key={d} className={'cal-cell' + (d.slice(0, 7) !== month ? ' out' : '') + (d === c.today ? ' today' : '') + (over === d ? ' over' : '')}
            onDragOver={e => { e.preventDefault(); setOver(d); }} onDragLeave={() => setOver(o => o === d ? null : o)}
            onDrop={() => { if (drag) c.update(drag.r, drag.i, moveTo(drag.i, d)); setDrag(null); setOver(null); }}>
            <div className="cal-num">{parseDay(d).getDate()}</div>
            {gev.filter(e => e.start.slice(0, 10) === d).slice(0, 3).map(e => <a key={e.id + e.start} className="cal-chip gcal" href={e.link ?? undefined} target="_blank" rel="noreferrer" title={`${e.account}: ${e.title}`}>{e.start.length > 10 ? e.start.slice(11, 16) + ' ' : ''}{e.title}</a>)}
            {list.slice(0, 5).map(({r, i}) => <div key={r.ws.id + i.id} className={'cal-chip' + (d < c.today ? ' late' : '')} draggable onDragStart={() => setDrag({r, i})} style={{borderLeftColor: r.ws.color}}
              onClick={() => c.go(r, i)} title={`${r.ws.name}, ${keyOf(r, i)}: ${i.title}`}>{i.title}</div>)}
            {list.length > 5 && <div className="small muted">+{list.length - 5} more</div>}
          </div>
        );
      })}
    </div>
  </>;
}

// ---------- Timeline ----------
const DAY = 26;
function EveryTimeline(c: Ctx) {
  const [from, setFrom] = useState(() => addDays(c.today, -7));
  const span = 63;
  const [drag, setDrag] = useState<{key: string; mode: 'move' | 'end'; dx: number} | null>(null);
  const x0 = useRef(0);
  const days = Array.from({length: span}, (_, n) => addDays(from, n));
  const dated = c.rows.map(r => ({r, items: r.items.filter(i => i.due || i.start).sort((a, b) => (a.start ?? a.due!).localeCompare(b.start ?? b.due!))})).filter(g => g.items.length);
  const pos = (d: string) => daysBetween(from, d) * DAY;
  const begin = (e: React.PointerEvent, r: Row, i: Item, mode: 'move' | 'end') => {
    e.preventDefault(); e.stopPropagation();
    x0.current = e.clientX;
    const key = r.ws.id + i.id;
    setDrag({key, mode, dx: 0});
    const move = (ev: PointerEvent) => setDrag({key, mode, dx: Math.round((ev.clientX - x0.current) / DAY)});
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      const n = Math.round((ev.clientX - x0.current) / DAY);
      setDrag(null);
      if (!n) return c.go(r, i);
      const s = i.start ?? i.due!, d = i.due ?? i.start!;
      if (mode === 'move') c.update(r, i, {...(i.start ? {start: addDays(s, n)} : {}), ...(i.due ? {due: addDays(d, n)} : {})});
      else { const nd = addDays(d, n); if (nd >= s) c.update(r, i, i.start ? {due: nd} : {start: s, due: nd}); }
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  return <>
    <div className="toolbar" style={{padding: '0 0 10px', border: 0}}>
      <button className="icon" onClick={() => setFrom(addDays(from, -14))}><ChevronLeft size={16} /></button>
      <button className="btn ghost small" onClick={() => setFrom(addDays(c.today, -7))}>Today</button>
      <button className="icon" onClick={() => setFrom(addDays(from, 14))}><ChevronRight size={16} /></button>
      <span className="muted small">Drag a bar to move it, drag its right end to change the due date. Click to open.</span>
    </div>
    <div className="every-tl">
      <div className="tl-head" style={{width: 260 + span * DAY}}>
        <span className="tl-label" />
        {days.map(d => <span key={d} className={'tl-day' + (d === c.today ? ' today' : '') + ([0, 6].includes(parseDay(d).getDay()) ? ' wknd' : '')} style={{width: DAY}}>{parseDay(d).getDate() === 1 || d === from ? parseDay(d).toLocaleDateString(undefined, {month: 'short'}) : ''}<br />{parseDay(d).getDate()}</span>)}
      </div>
      {dated.map(g => <div key={g.r.ws.id}>
        <div className="tl-group" style={{borderLeftColor: g.r.ws.color}}><WsMark w={g.r.ws} size={14} /> {g.r.ws.name} <span className="count">{g.items.length}</span></div>
        {g.items.map(i => {
          const k = g.r.ws.id + i.id, live = drag?.key === k ? drag : null;
          const s = i.start ?? i.due!, d = i.due ?? i.start!;
          const left = pos(s) + (live?.mode === 'move' ? live.dx * DAY : 0);
          const width = (daysBetween(s, d) + 1 + (live?.mode === 'end' ? live.dx : 0)) * DAY;
          return (
            <div key={k} className="tl-row" style={{width: 260 + span * DAY}}>
              <button className="tl-label" onClick={() => c.go(g.r, i)} title={i.title}><span className="muted small">{keyOf(g.r, i)}</span> {i.title}</button>
              <div className="tl-track" style={{width: span * DAY, backgroundSize: `${DAY}px 100%`}}>
                <span className="tl-now" style={{left: pos(c.today) + DAY / 2}} />
                <div className={'tl-bar' + (d < c.today ? ' late' : '') + (live ? ' dragging' : '')} style={{left, width: Math.max(DAY - 4, width - 4), background: g.r.ws.color}}
                  onPointerDown={e => begin(e, g.r, i, 'move')} title={`${s} to ${d}`}>
                  <span className="tl-bar-text">{i.title}</span>
                  <span className="tl-end" onPointerDown={e => begin(e, g.r, i, 'end')} />
                </div>
              </div>
            </div>
          );
        })}
      </div>)}
      {!dated.length && <Empty title="Nothing dated">Give items a start or due date and they show here.</Empty>}
    </div>
  </>;
}

// ---------- List ----------
function EveryList(c: Ctx) {
  const t = c.today, week = addDays(t, 7);
  const groups: [string, (i: Item) => boolean][] = [['Overdue', i => !!i.due && i.due < t], ['Today', i => i.due === t], ['This week', i => !!i.due && i.due > t && i.due <= week], ['Later', i => !!i.due && i.due > week], ['No date', i => !i.due]];
  return <div className="every-list">{c.rows.map(r => (
    <section key={r.ws.id} className="chart-card" style={{borderTop: `3px solid ${r.ws.color}`}}>
      <div className="today-head"><WsMark w={r.ws} size={18} /><b className="grow">{r.ws.name}</b><span className="count">{r.items.length}</span></div>
      {groups.map(([label, test]) => { const list = r.items.filter(test).sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9')); return list.length > 0 && (
        <div key={label}><div className={'pop-label' + (label === 'Overdue' ? ' overdue' : '')}>{label} <span className="count">{list.length}</span></div>
          {list.slice(0, 100).map(i => <ItemLine key={i.id} r={r} i={i} c={c} />)}</div>); })}
      {!r.items.length && <div className="muted small">Nothing open.</div>}
    </section>
  ))}</div>;
}
