// Day planner: the overwhelm page. Top 3, a brain dump, today's and overdue tasks, and the day as time boxes.
// Drag lines and tasks onto the day, drag boxes to move them, drag the bottom edge to resize. Done boxes turn green.
// Saved per person per day at /api/day/:date (server/dayplan.ts).
import {useCallback, useEffect, useRef, useState} from 'react';
import {Bell, BellOff, CalendarClock, ChevronLeft, ChevronRight, Clock, GitMerge, GripVertical, ListPlus, Play, Square, Wand2, X, Check as CheckIcon} from 'lucide-react';
import type {Item, TimeEntry} from './types.ts';
import {api, realProjects, type Store} from './store.ts';
import {Check, itemKey} from './components.tsx';
import {addDays} from './dates.ts';

type Entry = {id: string; text: string; itemId?: string | null; done?: boolean};
type Block = Entry & {start: string; minutes: number; at?: string | null; remind?: boolean};
type Plan = {date: string; top: Entry[]; dump: Entry[]; blocks: Block[]; dayStart: number; dayEnd: number; slot: number};
type DragData = {from: 'top' | 'dump' | 'task' | 'block'; id: string; itemId?: string | null; text: string; grab?: number};

const PX = 1.4; // pixels per minute
const rid = () => Math.random().toString(36).slice(2, 10);
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const label = (m: number) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`; };
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const atOf = (date: string, start: string) => new Date(`${date}T${start}:00`).toISOString();
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
/** How alike two titles are: shared words over the shorter title's words. */
const alike = (a: string, b: string) => { const x = words(a), y = words(b); if (!x.size || !y.size) return 0; let n = 0; for (const w of x) if (y.has(w)) n++; return n / Math.min(x.size, y.size); };

export function DayPlanner({store, me, open}: {store: Store; me: string; open: (id: string) => void}) {
  const [date, setDate] = useState(localDate);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [time, setTime] = useState<TimeEntry[]>([]);
  const [line, setLine] = useState('');
  const [matches, setMatches] = useState<Record<string, string> | null>(null);
  const [space, setSpace] = useState(() => localStorage.getItem('day-space') ?? '');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const pending = useRef<number | null>(null), latest = useRef<Plan | null>(null), dirty = useRef(false);
  latest.current = plan;

  const load = useCallback(() => {
    if (!me || dirty.current) return;
    api<Plan>(`/day/${date}?person=${me}`).then(setPlan).catch(e => store.fail(e));
    api<TimeEntry[]>(`/time?person=${me}`).then(setTime).catch(() => {});
  }, [date, me]);
  useEffect(load, [load, store.tick]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);

  const save = (next: Plan) => {
    setPlan(next); latest.current = next; dirty.current = true;
    if (pending.current) clearTimeout(pending.current);
    pending.current = window.setTimeout(async () => {
      const p = latest.current!;
      try { await api(`/day/${p.date}?person=${me}`, {method: 'PUT', body: {top: p.top, dump: p.dump, blocks: p.blocks, dayStart: p.dayStart, dayEnd: p.dayEnd, slot: p.slot}}); }
      catch (e) { store.fail(e); }
      dirty.current = false;
    }, 400);
  };
  if (!me) return <p className="muted">Pick who you are first.</p>;
  if (!plan) return <div className="loading">Loading...</div>;

  const item = (e: Entry) => e.itemId ? store.items.get(e.itemId) : undefined;
  const isDone = (e: Entry) => { const it = item(e); return it ? !!it.completed : !!e.done; };
  const boxedIds = new Set(plan.blocks.map(b => b.itemId).filter(Boolean)), boxedText = new Set(plan.blocks.map(b => b.text.toLowerCase()));
  const boxed = (e: Entry) => e.itemId ? boxedIds.has(e.itemId) : boxedText.has(e.text.toLowerCase());
  const toggleEntry = (list: 'top' | 'dump' | 'blocks', e: Entry) => {
    const it = item(e);
    if (it) { const p = store.projects.find(x => x.id === it.projectId)!; const doneS = p.statuses.find(s => s.category === 'done')?.id, todoS = p.statuses.find(s => s.category === 'todo')?.id ?? p.statuses[0].id; store.updateItem(it.id, {status: it.completed ? todoS : doneS ?? todoS}); return; }
    save({...plan, [list]: (plan[list] as Entry[]).map(x => x.id === e.id ? {...x, done: !x.done} : x)});
  };
  const mine = [...store.items.values()].filter(i => i.assignees.includes(me) && !i.completed && i.due && i.due <= date && !i.recur?.paused && !i.recur?.waiting && !(i.fields as {archived?: unknown}).archived)
    .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '') || (a.priority || 9) - (b.priority || 9));
  const doneToday = [...store.items.values()].filter(i => i.assignees.includes(me) && i.completed?.slice(0, 10) === date);

  // ---- Brain dump ----
  const addLines = (text: string) => {
    const lines = text.split(/\r?\n/).map(l => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean);
    if (lines.length) save({...plan, dump: [...plan.dump, ...lines.map(t => ({id: rid(), text: t}))]});
  };
  const findMatches = () => {
    const open = [...store.items.values()].filter(i => !i.completed && !i.recur?.spawned);
    const out: Record<string, string> = {};
    for (const e of plan.dump.filter(e => !e.itemId)) {
      let best: Item | null = null, score = 0;
      for (const i of open) { const s = alike(e.text, i.title) + (i.assignees.includes(me) ? 0.05 : 0); if (s > score) { score = s; best = i; } }
      if (best && score >= 0.6) out[e.id] = best.id;
    }
    setMatches(out);
  };
  const useMatch = (e: Entry, itemId: string) => { save({...plan, dump: plan.dump.map(x => x.id === e.id ? {...x, itemId, text: store.items.get(itemId)?.title ?? x.text} : x)}); setMatches(m => { const n = {...m}; delete n[e.id]; return n; }); };
  const createTasks = async () => {
    const pid = realProjects(store.projects).find(p => p.id === space)?.id ?? realProjects(store.projects)[0]?.id;
    if (!pid) { alert('Make a space first.'); return; }
    const todo = plan.dump.filter(e => !e.itemId && !e.done && !matches?.[e.id]);
    if (!todo.length) { alert(matches && Object.keys(matches).length ? 'Every new line has a suggested match. Use or dismiss the matches first.' : 'Every line is already a task.'); return; }
    setBusy(true);
    const made = new Map<string, string>();
    for (const e of todo) {
      const it = await store.quickAdd(pid, e.text);
      if (!it) continue;
      if (!it.assignees.length) store.updateItem(it.id, {assignees: [me]});
      made.set(e.id, it.id);
    }
    const p = latest.current!;
    save({...p, dump: p.dump.map(x => made.has(x.id) ? {...x, itemId: made.get(x.id), text: store.items.get(made.get(x.id)!)?.title ?? x.text} : x)});
    setBusy(false);
  };

  // ---- Time boxes ----
  const startM = plan.dayStart * 60, endM = plan.dayEnd * 60, height = (endM - startM) * PX;
  const snapTo = Math.min(plan.slot, 15);
  const yToMin = (y: number) => Math.max(startM, Math.min(endM - snapTo, startM + Math.round(y / PX / snapTo) * snapTo));
  const lenFor = (e: {itemId?: string | null}) => { const est = e.itemId ? store.items.get(e.itemId)?.estimate : null; return est ? Math.max(15, Math.min(240, Math.round(est * 60 / 15) * 15)) : 30; };
  const dropOnGrid = (ev: React.DragEvent) => {
    ev.preventDefault();
    const d = JSON.parse(ev.dataTransfer.getData('application/x-plan') || 'null') as DragData | null;
    if (!d) return;
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const m = yToMin(ev.clientY - r.top - (d.grab ?? 0));
    const start = hhmm(m);
    if (d.from === 'block') { save({...plan, blocks: plan.blocks.map(b => b.id === d.id ? {...b, start, at: atOf(plan.date, start)} : b)}); return; }
    save({...plan, blocks: [...plan.blocks, {id: rid(), text: d.text, ...(d.itemId ? {itemId: d.itemId} : {}), start, minutes: lenFor(d), at: atOf(plan.date, start), remind: false}]});
  };
  const removeBlock = (id: string) => save({...plan, blocks: plan.blocks.filter(b => b.id !== id)});
  const patchBlock = (id: string, p: Partial<Block>) => save({...plan, blocks: plan.blocks.map(b => b.id === id ? {...b, ...p} : b)});
  const auto = async () => {
    const isToday = date === localDate();
    const from = isToday ? hhmm(now.getHours() * 60 + now.getMinutes()) : hhmm(plan.dayStart * 60);
    setBusy(true);
    try {
      if (pending.current) { clearTimeout(pending.current); pending.current = null; await api(`/day/${date}?person=${me}`, {method: 'PUT', body: {top: plan.top, dump: plan.dump, blocks: plan.blocks}}); dirty.current = false; }
      setPlan(await api<Plan>(`/day/${date}/auto?person=${me}`, {method: 'POST', body: {from, offsetMinutes: -new Date().getTimezoneOffset()}}));
    } catch (e) { store.fail(e); } finally { setBusy(false); }
  };
  // Time logged with timers on this day, per task.
  const logged = time.filter(t => localDate(new Date(t.start)) === date);
  const actualOf = (itemId: string) => logged.filter(t => t.itemId === itemId);
  const adapt = (b: Block) => {
    const es = actualOf(b.itemId!); if (!es.length) return;
    const s = Math.min(...es.map(e => new Date(e.start).getTime())), e = Math.max(...es.map(x => x.end ? new Date(x.end).getTime() : Date.now()));
    const sd = new Date(s), sm = Math.floor((sd.getHours() * 60 + sd.getMinutes()) / 5) * 5;
    const start = hhmm(Math.max(startM, sm));
    patchBlock(b.id, {start, minutes: Math.max(5, Math.round((e - s) / 60000 / 5) * 5), at: atOf(plan.date, start)});
  };
  // Overlapping boxes sit side by side.
  const lanes = lanesOf(plan.blocks);
  const nowM = date === localDate(now) ? now.getHours() * 60 + now.getMinutes() : null;

  const dragProps = (d: DragData) => ({draggable: true, onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('application/x-plan', JSON.stringify(d)); e.dataTransfer.effectAllowed = 'move'; }});
  const EntryRow = ({e, list}: {e: Entry; list: 'top' | 'dump'}) => {
    const it = item(e), done = isDone(e), m = matches?.[e.id] ? store.items.get(matches[e.id]) : undefined;
    return <div className={'dp-entry' + (done ? ' done' : '') + (boxed(e) ? ' boxed' : '')} {...dragProps({from: list, id: e.id, itemId: e.itemId, text: e.text})}>
      <GripVertical size={12} className="dp-grip" />
      <button className={'check' + (done ? ' on' : '')} onClick={() => toggleEntry(list, e)} title={done ? 'Mark not done' : 'Mark done'}>{done && <CheckIcon size={11} strokeWidth={3} />}</button>
      {it ? <button className="dp-text link" onClick={() => open(it.id)} title="Open the task"><span className="dp-key">{itemKey(it, store.projects)}</span> {it.title}</button> : <span className="dp-text">{e.text}</span>}
      {boxed(e) && <Clock size={11} className="muted" aria-label="On the day" />}
      <button className="icon dp-x" title="Remove" onClick={() => save({...plan, [list]: plan[list].filter(x => x.id !== e.id)})}><X size={12} /></button>
      {m && <div className="dp-match small">Same as <b>{itemKey(m, store.projects)}</b> {m.title}? <button className="btn ghost small" onClick={() => useMatch(e, m.id)}>Use it</button>
        <button className="btn ghost small" onClick={() => setMatches(x => { const n = {...x}; delete n[e.id]; return n; })}>New</button></div>}
    </div>;
  };
  const dropOnTop = (ev: React.DragEvent) => {
    ev.preventDefault();
    const d = JSON.parse(ev.dataTransfer.getData('application/x-plan') || 'null') as DragData | null;
    if (!d || d.from === 'top' || plan.top.length >= 3) return;
    save({...plan, top: [...plan.top, {id: rid(), text: d.text, ...(d.itemId ? {itemId: d.itemId} : {})}]});
  };

  return <div className="dp">
    <header className="dp-head">
      <h1><CalendarClock size={20} /> Day planner</h1>
      <div className="dp-date">
        <button className="btn ghost small" onClick={() => setDate(addDays(date, -1))} title="Day before"><ChevronLeft size={14} /></button>
        <b>{new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'})}</b>
        <button className="btn ghost small" onClick={() => setDate(addDays(date, 1))} title="Day after"><ChevronRight size={14} /></button>
        {date !== localDate() && <button className="btn small" onClick={() => setDate(localDate())}>Today</button>}
      </div>
      <span className="spacer" />
      <button className="btn primary small" disabled={busy} onClick={auto} title="Put the top 3, today's and overdue tasks, then the brain dump into the next free times, from now"><Wand2 size={13} /> Plan my day from now</button>
      <label className="small muted">From <select className="plain-select" value={plan.dayStart} onChange={e => Number(e.target.value) < plan.dayEnd && save({...plan, dayStart: Number(e.target.value)})}>{Array.from({length: 24}, (_, h) => <option key={h} value={h}>{label(h * 60)}</option>)}</select></label>
      <label className="small muted">to <select className="plain-select" value={plan.dayEnd} onChange={e => Number(e.target.value) > plan.dayStart && save({...plan, dayEnd: Number(e.target.value)})}>{Array.from({length: 24}, (_, h) => <option key={h} value={h + 1}>{label((h + 1) * 60)}</option>)}</select></label>
      <label className="small muted">Slots <select className="plain-select" value={plan.slot} onChange={e => save({...plan, slot: Number(e.target.value)})}><option value={15}>15m</option><option value={30}>30m</option><option value={60}>1h</option></select></label>
    </header>
    <div className="dp-main">
      <div className="dp-left">
        <section className="dp-sec" onDragOver={e => e.preventDefault()} onDrop={dropOnTop}>
          <h4>Top 3</h4>
          {plan.top.map(e => <EntryRow key={e.id} e={e} list="top" />)}
          {plan.top.length < 3 && <input className="plain-input dp-add" placeholder={`Priority ${plan.top.length + 1} (or drag one here)`} onKeyDown={e => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (e.key === 'Enter' && v) { save({...plan, top: [...plan.top, {id: rid(), text: v}]}); (e.target as HTMLInputElement).value = ''; }
          }} />}
        </section>
        <section className="dp-sec">
          <h4>Brain dump <span className="count">{plan.dump.filter(e => !isDone(e)).length}</span></h4>
          <textarea className="plain-input dp-dump" rows={2} placeholder="Get it all out. Enter adds a line; paste many lines at once." value={line} onChange={e => setLine(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addLines(line); setLine(''); } }}
            onPaste={e => { const t = e.clipboardData.getData('text/plain'); if (t.includes('\n')) { e.preventDefault(); addLines(t); } }} />
          {plan.dump.map(e => <EntryRow key={e.id} e={e} list="dump" />)}
          {plan.dump.some(e => !e.itemId) && <div className="dp-actions">
            <button className="btn small" onClick={findMatches} title="Find tasks that already exist for these lines"><GitMerge size={12} /> Match to tasks</button>
            <button className="btn small" disabled={busy} onClick={createTasks} title="Make a task for each line with no match. Quick-add works: @name due:fri ~1h"><ListPlus size={12} /> Create tasks</button>
            <select className="plain-select small" value={space} onChange={e => { setSpace(e.target.value); localStorage.setItem('day-space', e.target.value); }} title="Space for new tasks">
              {realProjects(store.projects).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            {matches && !Object.keys(matches).length && <span className="muted small">No matches found.</span>}
          </div>}
        </section>
        <section className="dp-sec">
          <h4>Assigned: today and overdue <span className="count">{mine.length}</span></h4>
          {!mine.length && <p className="muted small">Nothing due. Nice.</p>}
          {mine.map(i => { const p = store.projects.find(x => x.id === i.projectId)!; return <div key={i.id} className={'dp-entry' + (boxedIds.has(i.id) ? ' boxed' : '')} {...dragProps({from: 'task', id: i.id, itemId: i.id, text: i.title})}>
            <GripVertical size={12} className="dp-grip" />
            <Check item={i} project={p} onToggle={status => store.updateItem(i.id, {status})} />
            <button className="dp-text link" onClick={() => open(i.id)}><span className="dp-key">{itemKey(i, store.projects)}</span> {i.title}</button>
            {i.due! < date && <span className="dp-late small">{i.due}</span>}
            {boxedIds.has(i.id) && <Clock size={11} className="muted" />}
          </div>; })}
          {!!doneToday.length && <p className="muted small">Done today: {doneToday.length}</p>}
        </section>
      </div>
      <div className="dp-day">
        <div className="dp-grid" style={{height}} onDragOver={e => e.preventDefault()} onDrop={dropOnGrid}>
          {Array.from({length: (endM - startM) / plan.slot}, (_, k) => { const m = startM + k * plan.slot; return <div key={m} className={'dp-slot' + (m % 60 === 0 ? ' hour' : '')} style={{top: (m - startM) * PX, height: plan.slot * PX}}>{m % 60 === 0 && <span className="dp-hour">{label(m)}</span>}</div>; })}
          {nowM !== null && nowM >= startM && nowM <= endM && <div className="dp-now" style={{top: (nowM - startM) * PX}} />}
          {logged.map(t => { const s = new Date(t.start), e = t.end ? new Date(t.end) : new Date(); const sm = s.getHours() * 60 + s.getMinutes(), em = e.getHours() * 60 + e.getMinutes();
            if (em < startM || sm > endM) return null;
            return <div key={t.id} className="dp-actual" style={{top: (Math.max(sm, startM) - startM) * PX, height: Math.max(3, (Math.min(em, endM) - Math.max(sm, startM)) * PX)}} title={`Timer: ${store.items.get(t.itemId)?.title ?? ''} ${s.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})} to ${t.end ? e.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : 'now'}`} />; })}
          {plan.blocks.map(b => {
            const s = mins(b.start), it = item(b), done = isDone(b), lane = lanes.get(b.id) ?? {i: 0, n: 1};
            const running = !!it && store.running?.itemId === it.id;
            return <div key={b.id} className={'dp-block' + (done ? ' done' : '') + (running ? ' running' : '')} {...dragProps({from: 'block', id: b.id, itemId: b.itemId, text: b.text})}
              onDragStart={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); e.dataTransfer.setData('application/x-plan', JSON.stringify({from: 'block', id: b.id, itemId: b.itemId, text: b.text, grab: e.clientY - r.top})); }}
              style={{top: (s - startM) * PX, height: Math.max(18, b.minutes * PX - 2), left: `calc(56px + (100% - 60px) * ${lane.i / lane.n})`, width: `calc((100% - 60px) / ${lane.n} - 4px)`}}
              onClick={e => { if ((e.target as HTMLElement).closest('button')) return; if (it) open(it.id); }}>
              <div className="dp-brow">
                <button className={'check' + (done ? ' on' : '')} onClick={() => toggleEntry('blocks', b)}>{done && <CheckIcon size={11} strokeWidth={3} />}</button>
                <span className="dp-btitle">{it ? <span className="dp-key">{itemKey(it, store.projects)}</span> : null} {it?.title ?? b.text}</span>
                <span className="dp-btime">{label(s)} to {label(s + b.minutes)}</span>
                {it && !done && (running ? <button className="icon" title="Stop timer" onClick={() => store.stopTimer()}><Square size={11} /></button> : <button className="icon" title="Start timer" onClick={() => store.startTimer(it.id)}><Play size={11} /></button>)}
                {it && actualOf(it.id).length > 0 && <button className="icon" title="Fit this box to the time you logged" onClick={() => adapt(b)}><Clock size={11} /></button>}
                <button className={'icon' + (b.remind ? ' on' : '')} title={b.remind ? 'Reminder on: you get a notification when it starts' : 'Remind me when it starts (phone and desktop)'} onClick={() => patchBlock(b.id, {remind: !b.remind, at: atOf(plan.date, b.start)})}>{b.remind ? <Bell size={11} /> : <BellOff size={11} />}</button>
                <button className="icon" title="Take off the day" onClick={() => removeBlock(b.id)}><X size={11} /></button>
              </div>
              <span className="dp-resize" onMouseDown={e => startResize(e, b, plan, save)} onClick={e => e.stopPropagation()} />
            </div>;
          })}
        </div>
        {!plan.blocks.length && <p className="muted small dp-hint">Drag a priority, a brain dump line or a task onto a time, or press Plan my day from now. Reminders go to your Inbox and to phones and desktops with notifications on.</p>}
      </div>
    </div>
  </div>;
}

function startResize(e: React.MouseEvent, b: Block, plan: Plan, save: (p: Plan) => void) {
  e.preventDefault(); e.stopPropagation();
  const y0 = e.clientY, m0 = b.minutes, el = (e.currentTarget as HTMLElement).parentElement!;
  let minutes = m0;
  const move = (ev: MouseEvent) => { minutes = Math.max(15, Math.round((m0 + (ev.clientY - y0) / PX) / 15) * 15); el.style.height = `${minutes * PX - 2}px`; };
  const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); if (minutes !== m0) save({...plan, blocks: plan.blocks.map(x => x.id === b.id ? {...x, minutes} : x)}); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}

function lanesOf(blocks: Block[]) {
  {
    const out = new Map<string, {i: number; n: number}>();
    const sorted = [...blocks].sort((a, b) => mins(a.start) - mins(b.start));
    let group: Block[] = [], groupEnd = -1;
    const flush = () => { const laneEnd: number[] = []; const lane = new Map<string, number>();
      for (const b of group) { const s = mins(b.start); let i = laneEnd.findIndex(e => e <= s); if (i < 0) { i = laneEnd.length; laneEnd.push(0); } laneEnd[i] = s + b.minutes; lane.set(b.id, i); }
      for (const b of group) out.set(b.id, {i: lane.get(b.id)!, n: laneEnd.length}); group = []; };
    for (const b of sorted) { const s = mins(b.start); if (s >= groupEnd && group.length) flush(); group.push(b); groupEnd = Math.max(groupEnd, s + b.minutes); }
    if (group.length) flush();
    return out;
  }
}
