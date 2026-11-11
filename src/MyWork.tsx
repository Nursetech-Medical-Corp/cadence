// My Work: a personal daily dashboard. Widgets can be added, removed, resized and dragged into a new order.
// Layout is saved per person in this browser.
import {CoverHeader, type Cover} from './Cover.tsx';
import {useQuickAssist} from './QuickAssist.tsx';
import {useEffect, useMemo, useRef, useState} from 'react';
import {GripVertical, Plus, RotateCcw, X} from 'lucide-react';
import type {Item, Notification, Project, TimeEntry} from './types.ts';
import {addDays, parseDay} from './dates.ts';
import {api, fmtMinutes, type Store, wsId, realProjects, validProject} from './store.ts';
import {Avatar, Check, Empty, Popover, PriorityIcon, TypeBadge, itemKey} from './components.tsx';
import {sprintState} from './SprintParts.tsx';
import {DashGrid, fromFlow, place, type Cell} from './DashGrid.tsx';
import {describeRecur} from './recur.ts';

type WidgetId = 'comments' | 'focus' | 'week' | 'upcoming' | 'nodate' | 'done' | 'time' | 'sprints' | 'projects' | 'inbox' | 'waiting' | 'recurring' | 'quick' | 'chart' | 'chart2' | 'flow';
/** w: columns spanned (1 to 3). h: height in rows of ROW px, or undefined to fit content. */
type Slot = {id: WidgetId; w: number; h?: number};
const ROW = 80;
const WIDGETS: Record<WidgetId, {title: string; hint: string}> = {
  comments: {title: 'Comments for me', hint: 'Comments assigned to you, until you resolve them'},
  quick: {title: 'Quick add', hint: 'Add a task for yourself to any space'},
  focus: {title: 'Today and overdue', hint: 'What needs doing now'},
  week: {title: 'This week', hint: 'Seven-day strip with your due items'},
  upcoming: {title: 'Coming up', hint: 'Due in the next 14 days'},
  nodate: {title: 'No due date', hint: 'Open work with no date set'},
  done: {title: 'Completed today', hint: 'What you finished today'},
  time: {title: 'Time this week', hint: 'Hours logged per day'},
  sprints: {title: 'My sprints', hint: 'Your share of each current sprint'},
  projects: {title: 'By space', hint: 'Open work per space'},
  inbox: {title: 'Latest notifications', hint: 'Mentions, assignments, comments'},
  waiting: {title: 'Waiting on others', hint: 'Items you created that others own'},
  recurring: {title: 'Recurring', hint: 'Your repeating work'},
  chart: {title: 'Chart', hint: 'Count work by status, priority, type, person, space or tag'},
  chart2: {title: 'Chart 2', hint: 'A second chart with its own settings'},
  flow: {title: 'Cumulative flow', hint: 'Work per stage over time for a space'},
};
const DEFAULT: Slot[] = [{id: 'quick', w: 3}, {id: 'comments', w: 1}, {id: 'focus', w: 1}, {id: 'week', w: 2}, {id: 'sprints', w: 1}, {id: 'time', w: 1}, {id: 'upcoming', w: 1}, {id: 'inbox', w: 1}];
// Older saved layouts used {wide}; convert them.
const loadLayout = (key: string): Slot[] => {
  const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as (Slot & {wide?: boolean})[] | null;
  return raw ? raw.map(x => ({id: x.id, w: x.w ?? (x.wide ? 3 : 1), h: x.h && x.h < 40 ? x.h : undefined})) : DEFAULT;
};
/** Starting height in grid rows for each widget. */
const heightOf = (id: string) => id === 'quick' ? 3 : id === 'week' ? 5 : id.startsWith('chart') || id === 'flow' ? 7 : 6;

export function MyWork({store, me, open}: {store: Store; me: string; open: (id: string) => void}) {
  const key = 'mywork-layout:' + me, gridKey = 'mywork-grid:' + me;
  const load = () => { const g = localStorage.getItem(gridKey); return g ? JSON.parse(g) as Cell[] : fromFlow(loadLayout(key), heightOf); };
  const [cells, setCells] = useState<Cell[]>(load);
  const [adding, setAdding] = useState(false);
  useEffect(() => setCells(load()), [me]);
  const save = (c: Cell[]) => { setCells(c); localStorage.setItem(gridKey, JSON.stringify(c)); };
  const name = store.people.find(p => p.id === me)?.name ?? '';
  const mine = useMemo(() => [...store.items.values()].filter(i => i.assignees.includes(me)), [store.items, me]);
  const openCount = mine.filter(i => !i.completed).length;
  const overdue = mine.filter(i => !i.completed && i.due && i.due < store.today).length;
  const hour = new Date().getHours();

  return (
    <div className="page dash">
      {me && <CoverHeader name={`mywork-${me}`} value={store.prefs['cover:mywork'] as Cover | undefined} onChange={c => store.setPref('cover:mywork', c)} />}
      <div className="dash-head">
        <div>
          <h1>{hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, {name.split(' ')[0]}</h1>
          <div className="muted">{parseDay(store.today).toLocaleDateString(undefined, {weekday: 'long', month: 'long', day: 'numeric'})}. {openCount} open{overdue ? `, ${overdue} overdue` : ''}.</div>
        </div>
        <span className="spacer" />
        <span className="picker">
          <button className="btn" onClick={() => setAdding(o => !o)}><Plus size={14} /> Add widget</button>
          <Popover open={adding} onClose={() => setAdding(false)} className="wide">
            {(Object.keys(WIDGETS) as WidgetId[]).filter(w => !cells.some(s => s.id === w)).map(w => (
              <button key={w} className="pop-row" onClick={() => { save([...cells, place(cells, w, w === 'quick' ? 6 : 2, heightOf(w))]); setAdding(false); }}>
                <span className="grow"><div>{WIDGETS[w].title}</div><div className="muted small">{WIDGETS[w].hint}</div></span>
              </button>
            ))}
            {cells.length === Object.keys(WIDGETS).length && <div className="pop-row muted">All widgets are on the page</div>}
          </Popover>
        </span>
        <button className="btn ghost" onClick={() => save(fromFlow(DEFAULT, heightOf))} title="Back to the default layout"><RotateCcw size={14} /> Reset layout</button>
      </div>
      <DashGrid cells={cells} onChange={save} defaultH={heightOf} title={id => WIDGETS[id as WidgetId].title}
        body={id => <Widget id={id as WidgetId} store={store} me={me} mine={mine} open={open} />} />
      {!cells.length && <Empty title="Your dashboard is empty">Press Customize, then Add widget.</Empty>}
    </div>
  );
}

function Widget({id, store, me, mine, open}: {id: WidgetId; store: Store; me: string; mine: Item[]; open: (id: string) => void}) {
  const t = store.today;
  const openItems = mine.filter(i => !i.completed);
  const byDue = (a: Item, b: Item) => (a.due ?? '9').localeCompare(b.due ?? '9') || (a.priority || 9) - (b.priority || 9);
  const list = (items: Item[], empty: string) => items.length
    ? <div>{items.slice(0, 12).map(i => <WorkRow key={i.id} item={i} store={store} open={open} />)}{items.length > 12 && <div className="muted small" style={{padding: 6}}>{items.length - 12} more</div>}</div>
    : <div className="muted small" style={{padding: 8}}>{empty}</div>;

  if (id === 'quick') return <QuickAdd store={store} me={me} />;
  if (id === 'comments') return <AssignedComments store={store} me={me} open={open} />;
  if (id === 'focus') return list(openItems.filter(i => i.due && i.due <= t).sort(byDue), 'Nothing due today. Nice.');
  if (id === 'upcoming') return list(openItems.filter(i => i.due && i.due > t && i.due <= addDays(t, 14)).sort(byDue), 'Nothing due in the next two weeks.');
  if (id === 'nodate') return list(openItems.filter(i => !i.due).sort((a, b) => (a.priority || 9) - (b.priority || 9)), 'Everything has a date.');
  if (id === 'done') return list(mine.filter(i => i.completed && new Date(i.completed).toDateString() === new Date().toDateString()), 'Nothing finished yet today.');
  if (id === 'waiting') return list([...store.items.values()].filter(i => i.createdBy === me && !i.completed && i.assignees.length && !i.assignees.includes(me)).sort(byDue), 'Nothing waiting on others.');
  if (id === 'recurring') {
    const rec = openItems.filter(i => i.recur).sort(byDue);
    return rec.length ? <div>{rec.map(i => <div key={i.id} className="row" onClick={() => open(i.id)} style={{cursor: 'pointer'}}><span className="grow">{i.title}</span><span className="muted small">{describeRecur(i.recur!, i.due)}</span><span className="small muted">{i.due?.slice(5)}</span></div>)}</div> : <div className="muted small" style={{padding: 8}}>No repeating work.</div>;
  }
  if (id === 'week') {
    const days = Array.from({length: 7}, (_, n) => addDays(t, n));
    return <div className="week-strip">{days.map(d => {
      const due = openItems.filter(i => i.due === d || (n0(d, t) && i.due && i.due < t));
      return <div key={d} className={'wk-day' + (d === t ? ' today' : '')}>
        <div className="wk-name">{parseDay(d).toLocaleDateString(undefined, {weekday: 'short'})} {parseDay(d).getDate()}</div>
        {due.slice(0, 4).map(i => <div key={i.id} className={'wk-item' + (i.due! < t ? ' overdue' : '')} onClick={() => open(i.id)} title={i.title}>{i.title}</div>)}
        {due.length > 4 && <div className="muted small">+{due.length - 4}</div>}
      </div>;
    })}</div>;
  }
  if (id === 'projects') {
    const rows = store.projects.map(p => ({p, n: openItems.filter(i => i.projectId === p.id).length})).filter(r => r.n);
    const max = Math.max(1, ...rows.map(r => r.n));
    return <div>{rows.map(r => <div key={r.p.id} className="bar-row"><span className="grow">{r.p.name}</span><div className="meter" style={{width: 140}}><div style={{width: `${100 * r.n / max}%`, background: 'var(--accent)'}} /></div><span className="small muted" style={{width: 24, textAlign: 'right'}}>{r.n}</span></div>)}{!rows.length && <div className="muted small">No open work.</div>}</div>;
  }
  if (id === 'sprints') {
    const cur = store.sprints.filter(s => sprintState(s, t) === 'current');
    if (!cur.length) return <div className="muted small" style={{padding: 8}}>No sprint running right now.</div>;
    return <div>{cur.map(s => {
      const items = mine.filter(i => i.sprint === s.id), done = items.filter(i => i.completed).length;
      const p = store.projects.find(p => p.id === s.projectId);
      return <div key={s.id} className="bar-row"><span className="grow"><b>{s.name}</b> <span className="muted small">{p?.name}, ends {s.end.slice(5)}</span></span>
        <div className="meter" style={{width: 120}}><div style={{width: `${items.length ? 100 * done / items.length : 0}%`}} /></div><span className="small muted">{done}/{items.length}</span></div>;
    })}</div>;
  }
  if (id === 'time') return <TimeWeek store={store} me={me} />;
  if (id === 'chart' || id === 'chart2') return <ChartWidget id={id} store={store} me={me} />;
  if (id === 'flow') return <FlowWidget store={store} />;
  return <InboxWidget store={store} me={me} open={open} />;
}
const n0 = (d: string, t: string) => d === t;

export function WorkRow({item, store, open}: {item: Item; store: Store; open: (id: string) => void}) {
  const project = store.projects.find(p => p.id === item.projectId) as Project;
  return (
    <div className={'row' + (item.completed ? ' done' : '')} onClick={() => open(item.id)} style={{cursor: 'pointer'}}>
      <Check item={item} project={project} onToggle={status => store.updateItem(item.id, {status})} />
      {item.priority > 0 && <PriorityIcon value={item.priority} />}
      <span className="grow title" style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{item.title}</span>
      {item.type !== 'Task' && <TypeBadge type={item.type} />}
      <span className="muted small">{itemKey(item, store.projects)}</span>
      {item.due && <span className={'small' + (item.due < store.today && !item.completed ? ' overdue' : ' muted')}>{item.due.slice(5).replace('-', '/')}</span>}
    </div>
  );
}

function QuickAdd({store, me}: {store: Store; me: string}) {
  const [project, setProject] = useState(() => validProject(store, localStorage.getItem(`quick-project:${wsId()}`)) ?? realProjects(store.projects)[0]?.id ?? '');
  const [text, setText] = useState('');
  const first = store.people.find(p => p.id === me)?.name.split(' ')[0] ?? '';
  const qa = useQuickAssist(store, store.projects.find(p => p.id === project)?.types ?? [], text, setText);
  return (
    <div className="recur-row" style={{margin: 0}}>
      <select className="plain-select" value={project} onChange={e => { setProject(e.target.value); localStorage.setItem(`quick-project:${wsId()}`, e.target.value); }}>
        {realProjects(store.projects).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <span className="qa-wrap grow"><input className="search" style={{width: '100%'}} placeholder={`Add a task for yourself. Type @ to assign, ! for priority, due: for a date`} value={text} onChange={e => setText(e.target.value)} {...qa.props}
        onKeyDown={async e => { if (qa.keyDown(e)) return; if (e.key === 'Enter' && text.trim() && project) { const t = /(^|\s)@\S/.test(text) ? text : `${text} @${first}`; setText(''); await store.quickAdd(project, t); } }} />{qa.ui}</span>
    </div>
  );
}

function TimeWeek({store, me}: {store: Store; me: string}) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  useEffect(() => { api<TimeEntry[]>(`/time?person=${me}`).then(setEntries).catch(() => {}); }, [me, store.tick]);
  const days = Array.from({length: 7}, (_, n) => addDays(store.today, n - 6));
  const per = days.map(d => entries.filter(e => new Date(e.start).toDateString() === parseDay(d).toDateString()).reduce((a, e) => a + (e.minutes ?? 0), 0));
  const max = Math.max(60, ...per), total = per.reduce((a, b) => a + b, 0);
  return <div>
    <div className="time-bars">{days.map((d, n) => <div key={d} title={`${d}: ${fmtMinutes(per[n])}`}><div className="tb" style={{height: `${(70 * per[n]) / max}px`}} /><span>{parseDay(d).toLocaleDateString(undefined, {weekday: 'narrow'})}</span></div>)}</div>
    <div className="muted small">{fmtMinutes(total)} logged in the last 7 days. Start a timer from any item.</div>
  </div>;
}

function InboxWidget({store, me, open}: {store: Store; me: string; open: (id: string) => void}) {
  const [list, setList] = useState<Notification[]>([]);
  useEffect(() => { api<Notification[]>(`/notifications?person=${me}`).then(n => setList(n.slice(0, 6))).catch(() => {}); }, [me, store.tick]);
  if (!list.length) return <div className="muted small" style={{padding: 8}}>No notifications.</div>;
  return <div>{list.map(n => (
    <div key={n.id} className={'note' + (n.read ? ' read' : '')} onClick={() => n.itemId && store.items.has(n.itemId) && open(n.itemId)}>
      <Avatar person={store.people.find(p => p.id === n.actor)} size={20} /><span className="grow small">{n.text}</span>
    </div>
  ))}</div>;
}

const PALETTE = ['#6d5dfc', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#64748b', '#84cc16'];
type ChartCfg = {by: 'status' | 'priority' | 'type' | 'assignee' | 'project' | 'tag' | 'worker'; scope: 'mine' | 'all'; open: boolean; kind: 'bar' | 'pie'};

/** Count items by any field, as bars or a donut. Settings are saved per widget. */
function ChartWidget({id, store, me}: {id: string; store: Store; me: string}) {
  const key = `chart-cfg:${id}:${me}`;
  const [cfg, setCfgS] = useState<ChartCfg>(() => ({by: 'status', scope: 'all', open: true, kind: 'bar', ...JSON.parse(localStorage.getItem(key) ?? '{}')}));
  const setCfg = (p: Partial<ChartCfg>) => { const n = {...cfg, ...p}; setCfgS(n); localStorage.setItem(key, JSON.stringify(n)); };
  const items = [...store.items.values()].filter(i => (cfg.scope === 'all' || i.assignees.includes(me)) && (!cfg.open || !i.completed));
  const counts = new Map<string, number>();
  const add = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const i of items) {
    const p = store.projects.find(x => x.id === i.projectId);
    if (cfg.by === 'status') add(p?.statuses.find(s => s.id === i.status)?.name ?? i.status);
    else if (cfg.by === 'priority') add(['None', 'Urgent', 'High', 'Medium', 'Low'][i.priority]);
    else if (cfg.by === 'type') add(i.type);
    else if (cfg.by === 'project') add(p?.name ?? '?');
    else if (cfg.by === 'worker') add(String(i.fields.worker ?? 'either'));
    else if (cfg.by === 'tag') (i.tags.length ? i.tags : ['(none)']).forEach(add);
    else (i.assignees.length ? i.assignees.map(a => store.people.find(x => x.id === a)?.name ?? '?') : ['Unassigned']).forEach(add);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const total = rows.reduce((a, r) => a + r[1], 0), max = Math.max(1, ...rows.map(r => r[1]));
  let acc = 0;
  return <div>
    <div className="recur-row" style={{margin: '0 0 8px', flexWrap: 'wrap'}}>
      <select className="plain-select" value={cfg.by} onChange={e => setCfg({by: e.target.value as ChartCfg['by']})}>{['status', 'priority', 'type', 'assignee', 'project', 'tag', 'worker'].map(b => <option key={b} value={b}>By {b === 'worker' ? 'human or AI' : b}</option>)}</select>
      <select className="plain-select" value={cfg.scope} onChange={e => setCfg({scope: e.target.value as ChartCfg['scope']})}><option value="all">Everyone</option><option value="mine">Mine</option></select>
      <label className="small"><input type="checkbox" checked={cfg.open} onChange={e => setCfg({open: e.target.checked})} /> Open only</label>
      <div className="seg"><button className={cfg.kind === 'bar' ? 'on' : ''} onClick={() => setCfg({kind: 'bar'})}>Bars</button><button className={cfg.kind === 'pie' ? 'on' : ''} onClick={() => setCfg({kind: 'pie'})}>Donut</button></div>
    </div>
    {cfg.kind === 'bar' ? rows.map(([k, n], c) => <div key={k} className="bar-row"><span className="grow" style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{k}</span><div className="meter" style={{width: 140}}><div style={{width: `${100 * n / max}%`, background: PALETTE[c % PALETTE.length]}} /></div><span className="small muted" style={{width: 28, textAlign: 'right'}}>{n}</span></div>)
      : <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
        <svg width="120" height="120" viewBox="-1 -1 2 2" style={{transform: 'rotate(-90deg)'}}>{rows.map(([k, n], c) => {
          const a0 = acc / total * 2 * Math.PI; acc += n; const a1 = acc / total * 2 * Math.PI;
          const big = a1 - a0 > Math.PI ? 1 : 0;
          return <path key={k} d={`M ${Math.cos(a0)} ${Math.sin(a0)} A 1 1 0 ${big} 1 ${Math.cos(a1)} ${Math.sin(a1)} L ${Math.cos(a1) * .6} ${Math.sin(a1) * .6} A .6 .6 0 ${big} 0 ${Math.cos(a0) * .6} ${Math.sin(a0) * .6} Z`} fill={PALETTE[c % PALETTE.length]}><title>{`${k}: ${n}`}</title></path>;
        })}</svg>
        <div className="small">{rows.map(([k, n], c) => <div key={k}><span className="dot" style={{background: PALETTE[c % PALETTE.length], display: 'inline-block', marginRight: 6}} />{k} <span className="muted">{n}</span></div>)}</div>
      </div>}
    {!rows.length && <div className="muted small">Nothing to count.</div>}
  </div>;
}

/** Cumulative flow: stacked areas of not started, active and done per day. Widening bands show where work piles up. */
function FlowWidget({store}: {store: Store}) {
  const [pid, setPid] = useState(() => localStorage.getItem('flow-project') ?? realProjects(store.projects)[0]?.id ?? '');
  const [rows, setRows] = useState<{date: string; todo: number; doing: number; done: number}[]>([]);
  useEffect(() => { if (pid) api<typeof rows>(`/reports/flow?projectId=${pid}&days=30`).then(setRows).catch(() => setRows([])); }, [pid, store.tick]);
  const W = 520, H = 150, max = Math.max(1, ...rows.map(r => r.todo + r.doing + r.done));
  const sx = (k: number) => (k * W) / Math.max(1, rows.length - 1), sy = (v: number) => H - (v / max) * H;
  const band = (lo: (r: typeof rows[0]) => number, hi: (r: typeof rows[0]) => number) =>
    rows.map((r, k) => `${sx(k)},${sy(hi(r))}`).join(' ') + ' ' + rows.map((r, k) => `${sx(k)},${sy(lo(r))}`).reverse().join(' ');
  return <div>
    <select className="plain-select" value={pid} onChange={e => { setPid(e.target.value); localStorage.setItem('flow-project', e.target.value); }} style={{marginBottom: 8}}>{realProjects(store.projects).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    {rows.length > 1 && <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
      <polygon points={band(() => 0, r => r.done)} fill="var(--ok)" opacity=".75" />
      <polygon points={band(r => r.done, r => r.done + r.doing)} fill="var(--accent)" opacity=".75" />
      <polygon points={band(r => r.done + r.doing, r => r.done + r.doing + r.todo)} fill="#94a3b8" opacity=".55" />
    </svg>}
    <div className="legend"><span><i style={{background: '#94a3b8'}} />Not started</span><span><i style={{background: 'var(--accent)'}} />Active</span><span><i style={{background: 'var(--ok)'}} />Done</span><span className="muted">last 30 days</span></div>
  </div>;
}

type AssignedComment = {id: string; itemId: string; author: string; body: string; created: string; item: Item};
function AssignedComments({store, me, open}: {store: Store; me: string; open: (id: string) => void}) {
  const [list, setList] = useState<AssignedComment[]>([]);
  const load = () => { if (me) api<AssignedComment[]>(`/assigned-comments?person=${me}`).then(setList).catch(() => {}); };
  useEffect(load, [me]);
  useEffect(() => { if (store.lastEvent.current?.kind === 'comment') load(); }, [store.tick]);
  if (!list.length) return <div className="muted small" style={{padding: 8}}>No comments waiting on you.</div>;
  return <div>{list.slice(0, 20).map(c => (
    <div key={c.id} className="row" style={{alignItems: 'flex-start', cursor: 'pointer'}} onClick={() => open(c.itemId)}>
      <Avatar person={store.people.find(p => p.id === c.author)} size={18} />
      <span className="grow small"><b>{itemKey(c.item, store.projects)}</b> {c.body.slice(0, 120)}</span>
      <button className="btn small" onClick={e => { e.stopPropagation(); api(`/comments/${c.id}`, {method: 'PATCH', body: {resolved: true}}).then(() => setList(l => l.filter(x => x.id !== c.id))).catch(store.fail); }}>Resolve</button>
    </div>))}</div>;
}
