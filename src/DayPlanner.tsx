// Day planner: the overwhelm page. Top 3, a brain dump, today's and overdue tasks, and the day as time boxes.
// Drag lines and tasks onto the day, drag boxes to move them, drag the bottom edge to resize. Done boxes turn green.
// Saved per person per day at /api/day/:date (server/dayplan.ts).
import {useCallback, useEffect, useRef, useState} from 'react';
import {Bell, BellOff, CalendarClock, CalendarPlus, ChevronDown, ChevronLeft, ChevronRight, Clock, GitMerge, GripVertical, Link2, ListPlus, Pencil, Play, Timer, Undo2, Plus, Square, Trash2, Video, Wand2, X, Check as CheckIcon} from 'lucide-react';
import type {Item, TimeEntry} from './types.ts';
import {PRIORITIES} from './types.ts';
import {api, realProjects, type Store} from './store.ts';
import {Avatars, Check, Popover, PriorityIcon, itemKey} from './components.tsx';
import {addDays} from './dates.ts';

type Entry = {id: string; text: string; itemId?: string | null; done?: boolean};
type Block = Entry & {start: string; minutes: number; at?: string | null; remind?: boolean; links?: string[]; eventId?: string | null; note?: string; planned?: {start: string; minutes: number} | null; fitted?: boolean};
type FitSummary = {plannedMinutes: number; loggedMinutes: number; moved: number; added: number; upTo: string | null};
/** A calendar event (Cadence meeting or synced Google event) shown on the day. */
type CalEv = {id: string; title: string; start: string; end: string; allDay: boolean; meetUrl: string | null; location: string; source: string; occurrenceOf?: string; itemId: string | null};
type Plan = {tz: string; updated?: string | null; date: string; top: Entry[]; dump: Entry[]; blocks: Block[]; dayStart: number; dayEnd: number; slot: number};
type DragData = {from: 'top' | 'dump' | 'task' | 'block'; id: string; itemId?: string | null; text: string; grab?: number; grabX?: number};

const rid = () => Math.random().toString(36).slice(2, 10);
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const label = (m: number) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`; };
const dayName = (d: string, long = false) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, long ? {weekday: 'long', month: 'short', day: 'numeric'} : {weekday: 'short', day: 'numeric'});
const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** The calendar day and minute of the day of a moment, on the clock of a time zone. */
const inZone = (t: string | Date, tz: string) => {
  let f = fmtCache.get(tz);
  if (!f) { try { f = new Intl.DateTimeFormat('en-CA', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}); } catch { f = new Intl.DateTimeFormat('en-CA', {hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}); } fmtCache.set(tz, f); }
  const o: Record<string, string> = {}; for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return {day: `${o.year}-${o.month}-${o.day}`, m: Number(o.hour) * 60 + Number(o.minute)};
};
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const atOf = (date: string, start: string) => new Date(`${date}T${start}:00`).toISOString();
import {matchScore} from './match.ts';

export function DayPlanner({store, me, open}: {store: Store; me: string; open: (id: string) => void}) {
  const [date, setDate] = useState(localDate);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [time, setTime] = useState<TimeEntry[]>([]);
  const [line, setLine] = useState('');
  const [space, setSpace] = useState(() => localStorage.getItem('day-space') ?? '');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [design, setDesignState] = useState(() => localStorage.getItem('day-design') ?? 'focus');
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem('day-density') as Density) || 'normal');
  const [bySource, setBySource] = useState(() => !!localStorage.getItem('day-bysource'));
  const [tab, setTab] = useState<'dump' | 'top' | 'tasks' | 'day'>('day');
  const [events, setEvents] = useState<CalEv[]>([]);
  const [week, setWeek] = useState<{date: string; boxes: number; minutes: number; events: number}[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{a: number; b: number} | null>(null);
  const [openSecs, setOpenSecs] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('day-open') ?? '{}'); } catch { return {}; } });
  const isOpen = (k: string) => openSecs[k] ?? true;
  const setOpen = (k: string, v: boolean) => setOpenSecs(o => { const n = {...o, [k]: v}; localStorage.setItem('day-open', JSON.stringify(n)); return n; });
  const dayRef = useRef<HTMLDivElement>(null), scrolled = useRef('');
  const [matchOn, setMatchOn] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [showEarly, setShowEarly] = useState(() => localStorage.getItem('day-early') === '1');
  const [over, setOver] = useState<{list: 'top' | 'dump'; id: string | null; after: boolean} | null>(null);
  const [dropGhost, setDropGhost] = useState<{m: number; len: number} | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const dragging = useRef<DragData | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [fitMenu, setFitMenu] = useState(false);
  const [fitInfo, setFitInfo] = useState<FitSummary | null>(null);
  const [showPlanned, setShowPlanned] = useState(() => localStorage.getItem('day-planned') !== 'off');
  // Undo for the planner: earlier plans, and tasks a step created (removed again on undo).
  const history = useRef<{plan: Plan; created: string[]}[]>([]);
  const setDesign = (id: string) => { setDesignState(id); localStorage.setItem('day-design', id); };
  const pickDesign = (step: number) => { const i = DESIGNS.findIndex(x => x.id === design); setDesign(DESIGNS[(i + step + DESIGNS.length) % DESIGNS.length].id); };
  const pending = useRef<number | null>(null), latest = useRef<Plan | null>(null), dirty = useRef(false), version = useRef(0);
  latest.current = plan;

  const load = useCallback(() => {
    if (!me || dirty.current) return;
    // A reply that comes back after a newer local change is dropped, so it cannot undo that change.
    const v = version.current;
    api<Plan>(`/day/${date}?person=${me}&tz=${encodeURIComponent(browserTz())}`).then(p => { if (v === version.current && !dirty.current) setPlan(p); }).catch(e => store.fail(e));
    api<TimeEntry[]>(`/time?person=${me}&tz=${encodeURIComponent(browserTz())}`).then(setTime).catch(() => {});
    api<CalEv[]>(`/meetings?from=${addDays(date, -1)}&to=${addDays(date, 1)}&mine=1`).then(l => setEvents(l.filter(e => !e.allDay))).catch(() => setEvents([]));
  }, [date, me]);
  useEffect(load, [load, store.tick]);
  // The week around the day: boxes planned and calendar events per day (Google events too, once Google Calendar is connected).
  useEffect(() => {
    if (!me) return;
    const d0 = new Date(`${date}T12:00:00`), mon = addDays(date, -((d0.getDay() + 6) % 7));
    const days = Array.from({length: 7}, (_, i) => addDays(mon, i));
    Promise.all([Promise.all(days.map(d => api<Plan>(`/day/${d}?person=${me}&tz=${encodeURIComponent(browserTz())}`).catch(() => null))), api<CalEv[]>(`/meetings?from=${addDays(mon, -1)}&to=${addDays(mon, 7)}&mine=1`).catch(() => [] as CalEv[])])
      .then(([plans, evs]) => setWeek(days.map((d, i) => { const p = plans[i]; const tzz = p?.tz || browserTz();
        return {date: d, boxes: p?.blocks.length ?? 0, minutes: p?.blocks.reduce((a, b) => a + b.minutes, 0) ?? 0, events: evs.filter(e => !e.allDay && inZone(e.start, tzz).day === d).length}; })));
  }, [date, me, Math.floor(now.getTime() / 60_000), plan?.updated]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);

  const save = (next: Plan, created: string[] = []) => {
    if (latest.current && latest.current.date === next.date) { history.current.push({plan: latest.current, created}); if (history.current.length > 100) history.current.shift(); }
    version.current++;
    setPlan(next); latest.current = next; dirty.current = true;
    if (pending.current) clearTimeout(pending.current);
    pending.current = window.setTimeout(async () => {
      const p = latest.current!;
      try { await api(`/day/${p.date}?person=${me}&tz=${encodeURIComponent(browserTz())}`, {method: 'PUT', body: {top: p.top, dump: p.dump, blocks: p.blocks, dayStart: p.dayStart, dayEnd: p.dayEnd, slot: p.slot, tz: p.tz}}); }
      catch (e) { store.fail(e); }
      dirty.current = false;
    }, 400);
  };
  // Ctrl+Z undoes the last planner change (and removes tasks it made). Falls back to the app's undo when there is none.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement;
      if ((t.matches('input, textarea') && (t as HTMLInputElement).value) || t.isContentEditable) return;
      const last = history.current.pop();
      if (!last) return;
      e.preventDefault(); e.stopImmediatePropagation();
      for (const id of last.created) store.deleteItem(id, false);
      setPlan(last.plan); latest.current = last.plan; dirty.current = true;
      if (pending.current) clearTimeout(pending.current);
      pending.current = window.setTimeout(async () => { const p = latest.current!; try { await api(`/day/${p.date}?person=${me}&tz=${encodeURIComponent(browserTz())}`, {method: 'PUT', body: {top: p.top, dump: p.dump, blocks: p.blocks, dayStart: p.dayStart, dayEnd: p.dayEnd, slot: p.slot, tz: p.tz}}); } catch (err) { store.fail(err); } dirty.current = false; }, 300);
      store.flash(last.created.length ? `Undone: removed ${last.created.length} task${last.created.length === 1 ? '' : 's'}` : 'Undone');
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [me]);
  useEffect(() => { history.current = []; }, [date]);
  // Scroll the day to an hour before now (or the first box) once per day shown.
  useEffect(() => {
    const el = dayRef.current;
    if (!el || !plan || scrolled.current === date) return;
    scrolled.current = date;
    const tzz = plan.tz || browserTz();
    const target = date === inZone(new Date(), tzz).day ? inZone(new Date(), tzz).m - 60 : plan.blocks.length ? Math.min(...plan.blocks.map(b => mins(b.start))) - 30 : plan.dayStart * 60;
    const grid = el.querySelector('.dp-grid') as HTMLElement | null;
    if (grid) el.scrollTop = Math.max(0, grid.offsetTop + (target - (localStorage.getItem('day-early') === '1' ? 0 : Math.min(6, plan.dayStart) * 60)) * 1.4);
  });
  if (!me) return <p className="muted">Pick who you are first.</p>;
  if (!plan) return <div className="loading">Loading...</div>;

  /** Change the newest plan (never a stale copy from before an await). */
  const update = (fn: (p: Plan) => Plan, created: string[] = []) => save(fn(latest.current!), created);
  /** A line became a task: every line, priority and box with the same text points at it too. */
  const linkText = (p: Plan, text: string, itemId: string, title: string): Plan => {
    const same = (e: Entry) => !e.itemId && e.text.trim().toLowerCase() === text.trim().toLowerCase();
    const set = <T extends Entry>(e: T): T => same(e) ? {...e, itemId, text: title} : e;
    return {...p, top: p.top.map(set), dump: p.dump.map(set), blocks: p.blocks.map(set)};
  };
  // Everything on this page reads the clock of the plan's time zone (saved with the day), not the computer's.
  const tz = plan.tz || browserTz();
  const today = inZone(now, tz).day, nowMin = inZone(now, tz).m;
  const item = (e: Entry) => e.itemId ? store.items.get(e.itemId) : undefined;
  const isDone = (e: Entry) => { const it = item(e); return it ? !!it.completed : !!e.done; };
  const boxedIds = new Set(plan.blocks.map(b => b.itemId).filter(Boolean)), boxedText = new Set(plan.blocks.map(b => b.text.toLowerCase()));
  const boxed = (e: Entry) => e.itemId ? boxedIds.has(e.itemId) : boxedText.has(e.text.toLowerCase());
  const toggleEntry = (list: 'top' | 'dump' | 'blocks', e: Entry) => {
    const it = item(e);
    if (it) { const p = store.projects.find(x => x.id === it.projectId)!; const doneS = p.statuses.find(s => s.category === 'done')?.id, todoS = p.statuses.find(s => s.category === 'todo')?.id ?? p.statuses[0].id; store.updateItem(it.id, {status: it.completed ? todoS : doneS ?? todoS}); return; }
    update(p => ({...p, [list]: (p[list] as Entry[]).map(x => x.id === e.id ? {...x, done: !x.done} : x)}));
  };
  const listSpaces = new Set(store.projects.filter(p => p.settings.records).map(p => p.id));
  const mine = [...store.items.values()].filter(i => !listSpaces.has(i.projectId) && i.assignees.includes(me) && !i.completed && i.due && i.due <= date && !i.recur?.paused && !i.recur?.waiting && !(i.fields as {archived?: unknown}).archived)
    .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '') || (a.priority || 9) - (b.priority || 9));
  const doneToday = [...store.items.values()].filter(i => i.assignees.includes(me) && i.completed?.slice(0, 10) === date);

  // ---- Brain dump ----
  const addLines = (text: string) => {
    const lines = text.split(/\r?\n/).map(l => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean);
    if (lines.length) update(p => ({...p, dump: [...p.dump, ...lines.map(t => ({id: rid(), text: t}))]}));
  };
  // Suggestions per brain dump line: the 3 best open tasks, only when Match is on.
  const linked = new Set([...plan.top, ...plan.dump, ...plan.blocks].map(e => e.itemId).filter(Boolean));
  const pool = matchOn ? [...store.items.values()].filter(i => !i.completed && !i.recur?.spawned && !listSpaces.has(i.projectId) && !linked.has(i.id) && !(i.fields as {archived?: unknown}).archived) : [];
  const suggest = (e: Entry): {item: Item; score: number}[] => {
    if (!matchOn || e.itemId || e.done || dismissed.has(e.id)) return [];
    return pool.map(i => ({item: i, score: matchScore(e.text, i.title, itemKey(i, store.projects)) + (i.assignees.includes(me) ? 0.08 : 0) + (i.due && i.due <= date ? 0.04 : 0)}))
      .filter(x => x.score >= 0.45).sort((x, y) => y.score - x.score).slice(0, 3);
  };
  const useMatch = (e: Entry, it: Item) => {
    update(p => linkText(p, e.text, it.id, it.title));
    // The task now belongs to your day: you are on it, and it is due today if it had no date.
    const patch: Partial<Item> = {};
    if (!it.assignees.includes(me)) patch.assignees = [...it.assignees, me];
    if (!it.due) patch.due = date;
    if (Object.keys(patch).length) store.updateItem(it.id, patch);
  };
  const createTasks = async () => {
    const pid = realProjects(store.projects).find(p => p.id === space)?.id ?? realProjects(store.projects)[0]?.id;
    if (!pid) { alert('Make a space first.'); return; }
    const todo = latest.current!.dump.filter(e => !e.itemId && !e.done);
    if (!todo.length) { store.flash('Every line is already a task'); return; }
    if (!confirm(`Make ${todo.length} new task${todo.length === 1 ? '' : 's'} in ${realProjects(store.projects).find(p => p.id === pid)?.name}, assigned to you?${matchOn ? '' : ' Tip: turn on Match first to tie lines to tasks you already have.'}`)) return;
    setBusy(true);
    const made = new Map<string, string>();
    for (const e of todo) {
      const it = await store.quickAdd(pid, e.text);
      if (!it) continue;
      if (!it.assignees.length) store.updateItem(it.id, {assignees: [me]});
      made.set(e.id, it.id);
      update(p => linkText(p, e.text, it.id, it.title), [it.id]);
    }
    (document.activeElement as HTMLElement | null)?.blur();
    setBusy(false);
  };

  // ---- Time boxes ----
  // The day shows midnight to midnight; the hours before 6am (or the planning start) fold away unless opened.
  const foldEnd = Math.min(6, plan.dayStart) * 60;
  const earlyBoxes = plan.blocks.filter(b => mins(b.start) < foldEnd).length;
  const startM = showEarly ? 0 : foldEnd, endM = 24 * 60;
  const planStart = plan.dayStart * 60, planEnd = plan.dayEnd * 60;
  const snapTo = Math.min(plan.slot, 15);
  const lenFor = (e: {itemId?: string | null}) => { const est = e.itemId ? store.items.get(e.itemId)?.estimate : null; return est ? Math.max(15, Math.min(240, Math.round(est * 60 / 15) * 15)) : 30; };
  /** Put something dragged at minute m: move a box, or make a new box from a line or a task. */
  const placeDrop = (d: DragData, m: number) => {
    const start = hhmm(m);
    if (d.from === 'block') { update(p => ({...p, blocks: p.blocks.map(b => b.id === d.id ? {...b, start, at: atOf(p.date, start)} : b)})); return; }
    update(p => ({...p, blocks: [...p.blocks, {id: rid(), text: d.text, ...(d.itemId ? {itemId: d.itemId} : {}), start, minutes: lenFor(d), at: atOf(p.date, start), remind: false}]}));
  };
  /** The first free time from now (or the start of the day) that fits len minutes. */
  const nextFree = (len: number) => {
    const n = date === today ? nowMin : planStart;
    let m = Math.max(planStart, Math.ceil(n / snapTo) * snapTo);
    while (m + len <= endM && plan.blocks.some(b => m < mins(b.start) + b.minutes && m + len > mins(b.start))) m += snapTo;
    return Math.min(m, endM - snapTo);
  };
  const removeBlock = (id: string) => update(p => ({...p, blocks: p.blocks.filter(b => b.id !== id)}));
  const patchBlock = (id: string, patch: Partial<Block>) => update(p => ({...p, blocks: p.blocks.map(b => b.id === id ? {...b, ...patch} : b)}));
  /** A plain box gets a timer: it becomes a task (in the chosen space) first. */
  const timeBox = async (b: Block) => {
    const pid = realProjects(store.projects).find(p => p.id === space && !p.settings.records)?.id ?? realProjects(store.projects).find(p => !p.settings.records)?.id;
    if (!pid || !b.text.trim()) { setEditing(b.id); return; }
    const it = await store.quickAdd(pid, b.text);
    if (!it) return;
    if (!it.assignees.length) store.updateItem(it.id, {assignees: [me]});
    update(p => linkText({...p, blocks: p.blocks.map(x => x.id === b.id ? {...x, itemId: it.id, text: it.title} : x)}, b.text, it.id, it.title), [it.id]);
    store.startTimer(it.id);
  };
  /** Boxes to the time really logged: up to now, or the whole day. Ctrl+Z puts the plan back. */
  const fit = async (upToNow: boolean) => {
    setFitMenu(false); setBusy(true);
    try {
      if (pending.current) { clearTimeout(pending.current); pending.current = null; const p0 = latest.current!; await api(`/day/${date}?person=${me}&tz=${encodeURIComponent(browserTz())}`, {method: 'PUT', body: {top: p0.top, dump: p0.dump, blocks: p0.blocks}}); dirty.current = false; }
      const r = await api<{plan: Plan; summary: FitSummary}>(`/day/${date}/fit?person=${me}&tz=${encodeURIComponent(browserTz())}`, {method: 'POST', body: {upTo: upToNow ? new Date().toISOString() : null}});
      if (latest.current) history.current.push({plan: latest.current, created: []});
      version.current++; setPlan(r.plan); latest.current = r.plan;
      setFitInfo(r.summary);
      if (!r.summary.moved && !r.summary.added) store.flash(r.summary.loggedMinutes ? 'Boxes already match your logged time' : 'No time logged yet. Press play on a box to time it');
    } catch (e) { store.fail(e); } finally { setBusy(false); }
  };
  const auto = async () => {
    // The server starts today at now and any other day at the start of the planning hours, around meetings.
    setBusy(true);
    try {
      if (pending.current) { clearTimeout(pending.current); pending.current = null; await api(`/day/${date}?person=${me}&tz=${encodeURIComponent(browserTz())}`, {method: 'PUT', body: {top: plan.top, dump: plan.dump, blocks: plan.blocks}}); dirty.current = false; }
      setPlan(await api<Plan>(`/day/${date}/auto?person=${me}&tz=${encodeURIComponent(browserTz())}`, {method: 'POST', body: {}}));
    } catch (e) { store.fail(e); } finally { setBusy(false); }
  };
  // Time logged with timers on this day, per task.
  const logged = time.filter(t => inZone(t.start, tz).day === date);
  const actualOf = (itemId: string) => logged.filter(t => t.itemId === itemId);
  const adapt = (b: Block) => {
    const es = actualOf(b.itemId!); if (!es.length) return;
    const s = Math.min(...es.map(e => new Date(e.start).getTime())), e = Math.max(...es.map(x => x.end ? new Date(x.end).getTime() : Date.now()));
    const sm = Math.floor(inZone(new Date(s), tz).m / 5) * 5;
    const start = hhmm(Math.max(startM, sm));
    patchBlock(b.id, {start, minutes: Math.max(5, Math.round((e - s) / 60000 / 5) * 5), at: atOf(plan.date, start)});
  };
  // Overlapping boxes sit side by side.
  const tiedEvents = new Set(plan.blocks.map(b => b.eventId).filter(Boolean));
  const evMin = (iso: string) => inZone(iso, tz).m;
  const dayEvents = events.filter(e => !tiedEvents.has(e.id) && inZone(e.start, tz).day === date).map(e => ({...e, s: evMin(e.start), len: Math.max(15, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60000))}));
  const lanes = lanesOf([...plan.blocks, ...dayEvents.map(e => ({id: 'ev:' + e.id, text: e.title, start: hhmm(Math.max(0, e.s)), minutes: e.len}))]);
  const nowM = date === today ? nowMin : null;

  const dragProps = (d: DragData) => ({draggable: true,
    onDragStart: (e: React.DragEvent) => { dragging.current = d; e.dataTransfer.setData('application/x-plan', JSON.stringify(d)); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => setDragActive(true), 0); },
    onDragEnd: () => { dragging.current = null; setOver(null); setDropGhost(null); setDragActive(false); }});
  /** Leave events also fire when moving onto a child (and browsers often leave relatedTarget empty), so check the pointer. */
  const stillIn = (e: React.DragEvent) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom; };
  const readDrag = (ev: React.DragEvent) => (JSON.parse(ev.dataTransfer.getData('application/x-plan') || 'null') as DragData | null) ?? dragging.current;
  /** Drop on a list (Top 3 or Brain dump), before or after a row, or at the end. Reorders within the list. */
  const dropOnList = (ev: React.DragEvent, list: 'top' | 'dump') => {
    ev.preventDefault(); ev.stopPropagation();
    const d = readDrag(ev), at = over;
    setOver(null); dragging.current = null; setDragActive(false);
    if (!d) return;
    update(p => {
      const cur = [...p[list]];
      let entry: Entry;
      if (d.from === list) { const i = cur.findIndex(x => x.id === d.id); if (i < 0) return p; entry = cur.splice(i, 1)[0]; }
      else entry = {id: rid(), text: d.text, ...(d.itemId ? {itemId: d.itemId} : {})};
      if (list === 'top' && d.from !== 'top' && cur.length >= 3) { store.flash('Top 3 is full. Drag one out first'); return p; }
      if (d.from !== list && cur.some(x => (entry.itemId && x.itemId === entry.itemId) || (!entry.itemId && x.text.toLowerCase() === entry.text.toLowerCase()))) return p;
      let i = at?.list === list && at.id ? cur.findIndex(x => x.id === at.id) : cur.length;
      if (i < 0) i = cur.length; else if (at?.after) i++;
      cur.splice(i, 0, entry);
      // Moving a line from the dump into the top 3 takes it out of the dump.
      const moved = d.from === 'dump' && list === 'top' ? {dump: p.dump.filter(x => x.id !== d.id)} : d.from === 'top' && list === 'dump' ? {top: p.top.filter(x => x.id !== d.id)} : {};
      return {...p, ...moved, [list]: cur};
    });
  };
  const listOver = (ev: React.DragEvent, list: 'top' | 'dump', id: string | null) => {
    ev.preventDefault(); ev.stopPropagation();
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(), after = id ? ev.clientY > r.top + r.height / 2 : true;
    if (over?.list !== list || over.id !== id || over.after !== after) setOver({list, id, after});
  };
  const renameEntry = (list: 'top' | 'dump', e: Entry, text: string) => {
    setEditText(null);
    const it = item(e), t = text.trim();
    if (!t) return;
    if (it) { if (t !== it.title) store.updateItem(it.id, {title: t}); return; }
    if (t !== e.text) update(p => ({...p, [list]: p[list].map(x => x.id === e.id ? {...x, text: t} : x), blocks: p.blocks.map(b => !b.itemId && b.text === e.text ? {...b, text: t} : b)}));
  };
  const entryRow = (e: Entry, list: 'top' | 'dump') => {
    const it = item(e), done = isDone(e), sug = list === 'dump' ? suggest(e) : [];
    const mark = over?.list === list && over.id === e.id ? (over.after ? ' drop-after' : ' drop-before') : '';
    return <div key={e.id} className={'dp-entry' + (done ? ' done' : '') + (boxed(e) ? ' boxed' : '') + mark} {...dragProps({from: list, id: e.id, itemId: e.itemId, text: e.text})}
      onDragOver={ev => listOver(ev, list, e.id)} onDrop={ev => dropOnList(ev, list)}>
      <GripVertical size={12} className="dp-grip" />
      <button className={'check' + (done ? ' on' : '')} onClick={() => toggleEntry(list, e)} title={done ? 'Mark not done' : 'Mark done'}>{done && <CheckIcon size={11} strokeWidth={3} />}</button>
      {editText === e.id ? <input className="plain-input dp-text" autoFocus defaultValue={it?.title ?? e.text} onBlur={ev => renameEntry(list, e, ev.target.value)} onKeyDown={ev => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') setEditText(null); }} />
        : it ? <span className="dp-text" onDoubleClick={() => setEditText(e.id)} title="Click the key to open the task; double-click to rename"><button className="dp-key link" onClick={() => open(it.id)}>{itemKey(it, store.projects)}</button> {it.title}</span>
        : <span className="dp-text" onDoubleClick={() => setEditText(e.id)} title="Double-click to edit">{e.text}</span>}
      {boxed(e) && <Clock size={11} className="muted" aria-label="On the day" />}
      <button className="icon dp-x" title="Edit" onClick={() => setEditText(e.id)}><Pencil size={11} /></button>
      <button className="icon dp-x" title="Remove from the list (the task stays)" onClick={() => update(p => ({...p, [list]: p[list].filter(x => x.id !== e.id)}))}><X size={12} /></button>
      {sug.length > 0 && <div className="dp-sugs">{sug.map(x => <button key={x.item.id} className="dp-sug" title={`Tie this line to ${x.item.title} (${Math.round(Math.min(1, x.score) * 100)}% match). It joins your day.`} onClick={() => useMatch(e, x.item)}>
        <GitMerge size={10} /> <span className="dp-key">{itemKey(x.item, store.projects)}</span> {x.item.title}</button>)}
        <button className="dp-sug none" title="None of these: keep it as a new line" onClick={() => setDismissed(d => new Set(d).add(e.id))}>New</button></div>}
    </div>;
  };
  // ---- Pieces each design arranges differently ----
  const D = DESIGNS.find(x => x.id === design) ?? DESIGNS[0];
  const horiz = D.id === 'horizontal';
  const px = (D.px ?? 1.4) * DENSITY[density];
  const srcOf = (b: Block) => plan.top.some(t => (b.itemId && t.itemId === b.itemId) || t.text.toLowerCase() === b.text.toLowerCase()) ? 'top' : b.itemId ? 'task' : 'dump';
  const head = <header className="dp-head">
    <h1><CalendarClock size={20} /> Day planner</h1>
    <div className="dp-date">
      <button className="btn ghost small" onClick={() => setDate(addDays(date, -1))} title="Day before"><ChevronLeft size={14} /></button>
      <b>{new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'})}</b>
      <button className="btn ghost small" onClick={() => setDate(addDays(date, 1))} title="Day after"><ChevronRight size={14} /></button>
      {date !== today && <button className="btn small" onClick={() => setDate(today)}>Today</button>}
    </div>
    <span className="spacer" />
    <span className="dp-design">
      <button className="btn ghost small" title="Previous design" onClick={() => pickDesign(-1)}><ChevronLeft size={13} /></button>
      <select className="plain-select small" value={D.id} onChange={e => setDesign(e.target.value)} title={D.hint}>{DESIGNS.map((x, i) => <option key={x.id} value={x.id}>{i + 1}. {x.name}</option>)}</select>
      <button className="btn ghost small" title="Next design" onClick={() => pickDesign(1)}><ChevronRight size={13} /></button>
      <select className="plain-select small" value={density} onChange={e => { setDensity(e.target.value as Density); localStorage.setItem('day-density', e.target.value); }} title="Row height">
        <option value="compact">Compact</option><option value="normal">Normal</option><option value="roomy">Roomy</option></select>
      <label className="small muted" title="Color boxes by where they came from: top 3, tasks, brain dump"><input type="checkbox" checked={bySource} onChange={e => { setBySource(e.target.checked); localStorage.setItem('day-bysource', e.target.checked ? '1' : ''); }} /> Color by source</label>
    </span>
    <span className="picker">
      <button className="btn small" disabled={busy} onClick={() => setFitMenu(o => !o)} title="Move and size your boxes to the time you logged with timers, to see what you really did"><Timer size={13} /> Fit to my time <ChevronDown size={12} /></button>
      <Popover open={fitMenu} onClose={() => setFitMenu(false)}>
        {date === today && <button className="pop-row" onClick={() => fit(true)}>Up to now <span className="muted small">(the day so far)</span></button>}
        <button className="pop-row" onClick={() => fit(false)}>Whole day</button>
        <label className="pop-row small"><input type="checkbox" checked={showPlanned} onChange={e => { setShowPlanned(e.target.checked); localStorage.setItem('day-planned', e.target.checked ? 'on' : 'off'); }} /> Show where boxes were planned</label>
        <div className="pop-label">Boxes keep their planned time (dashed outline). Ctrl+Z undoes.</div>
      </Popover>
    </span>
    <button className="btn primary small" disabled={busy} onClick={auto} title="Put the top 3, today's and overdue tasks, then the brain dump into the next free times, from now"><Wand2 size={13} /> Plan my day from now</button>
    <label className="small muted" title="Plan my day from now fills only these hours; the day shows all 24">Plan between <select className="plain-select" value={plan.dayStart} onChange={e => Number(e.target.value) < plan.dayEnd && save({...plan, dayStart: Number(e.target.value)})}>{Array.from({length: 24}, (_, h) => <option key={h} value={h}>{label(h * 60)}</option>)}</select></label>
    <label className="small muted">and <select className="plain-select" value={plan.dayEnd} onChange={e => Number(e.target.value) > plan.dayStart && save({...plan, dayEnd: Number(e.target.value)})}>{Array.from({length: 24}, (_, h) => <option key={h} value={h + 1}>{label((h + 1) * 60)}</option>)}</select></label>
    <label className="small muted">Slots <select className="plain-select" value={plan.slot} onChange={e => save({...plan, slot: Number(e.target.value)})}><option value={15}>15m</option><option value={30}>30m</option><option value={60}>1h</option></select></label>
  </header>;
  const topSec = <section className={'dp-sec dp-top' + (over?.list === 'top' ? ' drop-on' : '')} onDragOver={e => listOver(e, 'top', null)} onDragLeave={e => { if (!stillIn(e)) setOver(o => o?.list === 'top' ? null : o); }} onDrop={e => dropOnList(e, 'top')}>
    <h4>Top 3</h4>
    {plan.top.map((e, i) => <div key={e.id} className="dp-topcell"><span className="dp-num">{i + 1}</span>{entryRow(e, 'top')}</div>)}
    {over?.list === 'top' && !over.id && <div className="dp-dropline" />}
    {plan.top.length < 3 && dragActive && dragging.current?.from !== 'top' && <div className={'dp-dropzone' + (over?.list === 'top' ? ' on' : '')}>Drop here for priority {plan.top.length + 1}</div>}
    {plan.top.length < 3 && !dragActive && <input className="plain-input dp-add" placeholder={`Priority ${plan.top.length + 1} (or drag one here)`} onKeyDown={e => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (e.key === 'Enter' && v) { update(p => ({...p, top: [...p.top, {id: rid(), text: v}]})); (e.target as HTMLInputElement).value = ''; }
    }} />}
  </section>;
  const dumpSec = <section className={'dp-sec dp-dumpsec' + (over?.list === 'dump' ? ' drop-on' : '')} onDragOver={e => listOver(e, 'dump', null)} onDragLeave={e => { if (!stillIn(e)) setOver(o => o?.list === 'dump' ? null : o); }} onDrop={e => dropOnList(e, 'dump')}>
    <h4>Brain dump <span className="count">{plan.dump.filter(e => !isDone(e)).length}</span></h4>
    <textarea className="plain-input dp-dump" rows={2} placeholder="Get it all out. Enter adds a line; paste many lines at once." value={line} onChange={e => setLine(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addLines(line); setLine(''); } }}
      onPaste={e => { const t = e.clipboardData.getData('text/plain'); if (t.includes('\n')) { e.preventDefault(); addLines(t); } }} />
    {plan.dump.map(e => entryRow(e, 'dump'))}
    {over?.list === 'dump' && !over.id && <div className="dp-dropline" />}
    {plan.dump.some(e => !e.itemId && !e.done) && <div className="dp-actions">
      <button className={'btn small' + (matchOn ? ' on' : '')} onClick={() => { setMatchOn(m => !m); setDismissed(new Set()); }} title="Show the closest existing tasks under each line, so you can tie a line to a task you already have"><GitMerge size={12} /> Match {matchOn ? 'on' : 'off'}</button>
      <button className="btn small" disabled={busy} onClick={createTasks} title="Make a task, assigned to you, for each line not tied to a task yet. Quick-add works in a line: @name due:fri ~1h"><ListPlus size={12} /> Create tasks</button>
      <label className="small muted">in <select className="plain-select small" value={realProjects(store.projects).some(p => p.id === space) ? space : realProjects(store.projects)[0]?.id} onChange={e => { setSpace(e.target.value); localStorage.setItem('day-space', e.target.value); }} title="The space new tasks go in">
        {realProjects(store.projects).filter(p => !p.settings.records).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {matchOn && !plan.dump.some(e => suggest(e).length) && <span className="muted small">No close tasks found.</span>}
    </div>}
  </section>;
  const mineSec = <section className="dp-sec dp-minesec">
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
  </section>;
  const taskInfo = (it: Item) => {
    const p = store.projects.find(x => x.id === it.projectId), st = p?.statuses.find(x => x.id === it.status);
    return <span className="dp-info">
      {st && <span className="dp-status" style={{'--c': st.color} as React.CSSProperties}>{st.name}</span>}
      {it.priority > 0 && <span title={PRIORITIES[it.priority]}><PriorityIcon value={it.priority} size={11} /></span>}
      {it.due && <span className={it.due < date && !it.completed ? 'dp-late' : ''}>due {it.due === date ? 'today' : it.due}</span>}
      {it.estimate ? <span>{it.estimate}h</span> : null}
      {p && <span className="dp-space">{p.name}</span>}
      {it.tags.filter(t => /^sop-/i.test(t)).map(t => <span key={t} className="tag">{t.toUpperCase()}</span>)}
      <Avatars ids={it.assignees} people={store.people} size={16} />
    </span>;
  };
  const linkChips = (b: Block) => !!b.links?.length && <span className="dp-links">{b.links.map(id => { const it = store.items.get(id); return it ? <button key={id} className={'dp-linkchip' + (it.completed ? ' done' : '')} title={`${it.completed ? 'Done' : 'Open'}: ${it.title}`} onClick={() => open(id)}><Link2 size={9} /> {itemKey(it, store.projects)} {it.title}</button> : null; })}</span>;
  const blockTools = (b: Block, it: Item | undefined, done: boolean, running: boolean) => <>
    <button className="icon" title="Edit this time slot: time, length, reminder, agenda, tasks tied to it, calendar" onClick={() => setEditing(b.id)}><Clock size={11} /></button>
    {it && !done && (running ? <button className="icon" title="Stop timer" onClick={() => store.stopTimer()}><Square size={11} /></button> : <button className="icon" title="Start timer" onClick={() => store.startTimer(it.id)}><Play size={11} /></button>)}
    {!it && !b.done && <button className="icon" title="Start a timer (makes this box a task first, so the time is logged)" onClick={() => timeBox(b)}><Play size={11} /></button>}
    {it && actualOf(it.id).length > 0 && <button className="icon" title="Fit this box to the time you logged" onClick={() => adapt(b)}><Clock size={11} /></button>}
    <button className={'icon' + (b.remind ? ' on' : '')} title={b.remind ? 'Reminder on: you get a notification when it starts' : 'Remind me when it starts (phone and desktop)'} onClick={() => patchBlock(b.id, {remind: !b.remind, at: atOf(plan.date, b.start)})}>{b.remind ? <Bell size={11} /> : <BellOff size={11} />}</button>
    <button className="icon" title="Take off the day" onClick={() => removeBlock(b.id)}><X size={11} /></button>
  </>;
  // Where a block sits: top/height down the day, or left/width across it.
  const place = (s: number, len: number, lane: {i: number; n: number}): React.CSSProperties => horiz
    ? {left: (s - startM) * px, width: Math.max(18, len * px - 2), top: `calc(26px + (100% - 30px) * ${lane.i / lane.n})`, height: `calc((100% - 30px) / ${lane.n} - 4px)`}
    : {top: (s - startM) * px, height: Math.max(18, len * px - 2), left: `calc(56px + (100% - 60px) * ${lane.i / lane.n})`, width: `calc((100% - 60px) / ${lane.n} - 4px)`};
  const span = (s: number, len: number): React.CSSProperties => horiz ? {left: (s - startM) * px, width: len * px} : {top: (s - startM) * px, height: len * px};
  const minuteAt = (ev: React.DragEvent, d: DragData) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const offset = horiz ? ev.clientX - r.left - (d.grabX ?? 0) : ev.clientY - r.top - (d.grab ?? 0);
    return Math.max(startM, Math.min(endM - snapTo, startM + Math.round(offset / px / snapTo) * snapTo));
  };
  const lenOfDrag = (d: DragData) => d.from === 'block' ? plan.blocks.find(b => b.id === d.id)?.minutes ?? 30 : lenFor(d);
  const overGrid = (ev: React.DragEvent) => {
    ev.preventDefault();
    const d = dragging.current; if (!d) return;
    const m = minuteAt(ev, d), len = lenOfDrag(d);
    if (dropGhost?.m !== m || dropGhost.len !== len) setDropGhost({m, len});
  };
  const dropAt = (ev: React.DragEvent) => {
    ev.preventDefault();
    const d = readDrag(ev);
    setDropGhost(null); dragging.current = null;
    if (!d) return;
    placeDrop(d, minuteAt(ev, d));
  };
  const dayGrid = <div className={'dp-day' + (horiz ? ' horiz' : '')} ref={dayRef}>
    {!horiz && week.length === 7 && <div className="dp-week">{week.map(w => {
      const due = [...store.items.values()].filter(i => i.assignees.includes(me) && !i.completed && i.due === w.date && !listSpaces.has(i.projectId)).length;
      return <button key={w.date} className={'dp-wday' + (w.date === date ? ' on' : '') + (w.date === today ? ' today' : '')} onClick={() => setDate(w.date)}
        title={`${w.boxes} time box${w.boxes === 1 ? '' : 'es'} (${fmtM(w.minutes)}), ${w.events} calendar event${w.events === 1 ? '' : 's'}, ${due} task${due === 1 ? '' : 's'} due`}>
        <span className="dp-wname">{new Date(`${w.date}T12:00:00`).toLocaleDateString(undefined, {weekday: 'short'})} <b>{Number(w.date.slice(8))}</b></span>
        <span className="dp-wbar"><span style={{width: `${Math.min(100, w.minutes / 480 * 100)}%`}} /></span>
        <span className="dp-wstats">{w.boxes ? <span title="Time boxes">{fmtM(w.minutes)}</span> : null}{w.events ? <span title="Calendar events"><CalendarClock size={10} /> {w.events}</span> : null}{due ? <span title="Tasks due">{due} due</span> : null}</span>
      </button>; })}</div>}
    {!horiz && <div className="dp-daynav">
      <button className="btn ghost small" onClick={() => setDate(addDays(date, -1))}><ChevronLeft size={14} /> {dayName(addDays(date, -1))}</button>
      <b>{dayName(date, true)}</b>{date !== today && <button className="btn small" onClick={() => setDate(today)}>Today</button>}
      <button className="btn ghost small" onClick={() => setDate(addDays(date, 1))}>{dayName(addDays(date, 1))} <ChevronRight size={14} /></button>
    </div>}
    {tz !== browserTz() && <div className="dp-tznote small">Times on this day are in <b>{tz.replace(/_/g, ' ')}</b>; your computer is on {browserTz().replace(/_/g, ' ')}.
      <button className="btn ghost small" title="Keep 9:00 as 9:00, now on your computer's clock (reminders move with it)" onClick={() => update(p => ({...p, tz: browserTz()}))}>Use my time zone</button></div>}
    {fitInfo && <div className="dp-fitinfo small">
      <b>{fitInfo.upTo ? `Up to ${new Date(fitInfo.upTo).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}` : 'Whole day'}:</b> planned {fmtM(fitInfo.plannedMinutes)}, logged {fmtM(fitInfo.loggedMinutes)}
      {fitInfo.plannedMinutes > 0 && <span className="muted"> ({Math.round(fitInfo.loggedMinutes / fitInfo.plannedMinutes * 100)}%)</span>}
      {fitInfo.added > 0 && <span> · {fitInfo.added} unplanned box{fitInfo.added === 1 ? '' : 'es'} added</span>}
      <button className="icon" title="Hide" onClick={() => setFitInfo(null)}><X size={12} /></button></div>}
    {!horiz && foldEnd > 0 && <button className="dp-early" onClick={() => { const v = !showEarly; setShowEarly(v); localStorage.setItem('day-early', v ? '1' : ''); }}>
      {showEarly ? <ChevronDown size={13} /> : <ChevronRight size={13} />} 12am to {label(foldEnd)}{earlyBoxes ? ` (${earlyBoxes} box${earlyBoxes === 1 ? '' : 'es'})` : ''}</button>}
    <div className="dp-grid" style={horiz ? {width: (endM - startM) * px + 20} : {height: (endM - startM) * px}} onDragOver={overGrid} onDragLeave={e => { if (!stillIn(e)) setDropGhost(null); }} onDrop={dropAt}
      onMouseDown={e => {
        // Like a calendar: press on an empty time and drag down to make a box. With an editor or a task panel open, a click only closes it.
        if (horiz || e.button !== 0 || !(e.target as HTMLElement).matches('.dp-grid, .dp-slot, .dp-hour, .dp-half, .dp-plan')) return;
        if (editing || document.querySelector('.panel')) { setEditing(null); return; }
        const grid = e.currentTarget, r = grid.getBoundingClientRect();
        const at = (y: number) => Math.max(startM, Math.min(endM, startM + Math.round((y - r.top) / px / snapTo) * snapTo));
        const a = Math.min(at(e.clientY), endM - snapTo);
        let b2 = a + 30;
        setGhost({a, b: b2});
        const move = (ev: MouseEvent) => { b2 = Math.max(a + snapTo, at(ev.clientY)); setGhost({a, b: b2}); };
        const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); setGhost(null);
          const id = rid(), start = hhmm(a); update(p => ({...p, blocks: [...p.blocks, {id, text: '', start, minutes: Math.max(snapTo, b2 - a), at: atOf(p.date, start), remind: false}]})); setEditing(id); };
        addEventListener('mousemove', move); addEventListener('mouseup', up);
      }}>
      {ghost && <div className="dp-ghost" style={{top: (ghost.a - startM) * px, height: (ghost.b - ghost.a) * px}}>{label(ghost.a)} to {label(ghost.b)}</div>}
      {showPlanned && !horiz && plan.blocks.filter(b => b.planned && (b.planned.start !== b.start || b.planned.minutes !== b.minutes) && mins(b.planned.start) + b.planned.minutes > startM).map(b => {
        const ps = Math.max(startM, mins(b.planned!.start)), lane = lanes.get(b.id) ?? {i: 0, n: 1};
        return <div key={'pl' + b.id} className="dp-planned" style={place(ps, b.planned!.minutes, lane)} title={`Planned ${label(mins(b.planned!.start))} to ${label(mins(b.planned!.start) + b.planned!.minutes)}`}>planned: {item(b)?.title ?? b.text}</div>;
      })}
      {dropGhost && <div className="dp-ghost drop" style={horiz ? {left: (dropGhost.m - startM) * px, width: dropGhost.len * px, top: 26, bottom: 4} : {top: (dropGhost.m - startM) * px, height: dropGhost.len * px}}>{label(dropGhost.m)} to {label(dropGhost.m + dropGhost.len)}</div>}
      {!horiz && planStart > startM && <div className="dp-plan" style={{top: 0, height: (planStart - startM) * px}} title="Before your planning hours" />}
      {!horiz && planEnd < endM && <div className="dp-plan" style={{top: (planEnd - startM) * px, height: (endM - planEnd) * px}} title="After your planning hours" />}
      {dayEvents.map(ev => { const lane = lanes.get('ev:' + ev.id) ?? {i: 0, n: 1}; return <div key={ev.id + ev.start} className="dp-event" style={place(ev.s, ev.len, lane)} title={`${ev.source === 'google' ? 'Google Calendar' : 'Calendar'}: ${ev.title}`}>
        <div className="dp-brow"><CalendarClock size={11} /><span className="dp-btitle">{ev.title || '(no title)'}</span>{ev.itemId && store.items.get(ev.itemId) && <button className="dp-linkchip" onClick={() => open(ev.itemId!)} title="The task this event is for">{itemKey(store.items.get(ev.itemId)!, store.projects)}</button>}<span className="dp-btime">{label(ev.s)} to {label(ev.s + ev.len)}</span>
          {ev.meetUrl && <a className="icon" href={ev.meetUrl} target="_blank" rel="noreferrer" title="Join"><Video size={11} /></a>}
          <button className="icon" title="Plan in this event: make it a box so you can tie tasks to it" onClick={() => { const id = rid(), start = hhmm(Math.max(startM, ev.s)); update(p => ({...p, blocks: [...p.blocks, {id, text: ev.title || 'Meeting', start, minutes: ev.len, at: ev.start, remind: false, eventId: ev.id, ...(ev.itemId ? {links: [ev.itemId]} : {})}]})); setEditing(id); }}><Plus size={11} /></button></div>
      </div>; })}
      {Array.from({length: (endM - startM) / plan.slot}, (_, k) => { const m = startM + k * plan.slot; return <div key={m} className={'dp-slot' + (m % 60 === 0 ? ' hour' : '')} style={span(m, plan.slot)}>
        {m % 60 === 0 && <span className="dp-hour">{label(m)}</span>}{D.id === 'paper' && m % 60 === 30 && <span className="dp-half">:30</span>}</div>; })}
      {nowM !== null && nowM >= startM && nowM <= endM && <div className="dp-now" style={horiz ? {left: (nowM - startM) * px} : {top: (nowM - startM) * px}}><span className="dp-nowlabel">{label(nowM)}</span></div>}
      {logged.map(t => { const s = new Date(t.start), e = t.end ? new Date(t.end) : new Date(); const sm = inZone(s, tz).m, em = inZone(e, tz).day === date ? inZone(e, tz).m : 24 * 60;
        if (em < startM || sm > endM) return null;
        const a = Math.max(sm, startM), len = Math.max(2, Math.min(em, endM) - a);
        return <div key={t.id} className="dp-actual" style={horiz ? {left: (a - startM) * px, width: len * px} : {top: (a - startM) * px, height: len * px}} title={`Timer: ${store.items.get(t.itemId)?.title ?? ''} ${s.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})} to ${t.end ? e.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : 'now'}`} />; })}
      {plan.blocks.filter(b => mins(b.start) + b.minutes > startM).map(b => {
        const s = Math.max(startM, mins(b.start)), it = item(b), done = isDone(b), lane = lanes.get(b.id) ?? {i: 0, n: 1};
        const running = !!it && store.running?.itemId === it.id;
        return <div key={b.id} data-src={srcOf(b)} className={'dp-block' + (done ? ' done' : '') + (running ? ' running' : '')} draggable
          onDragStart={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const d: DragData = {from: 'block', id: b.id, itemId: b.itemId, text: b.text, grab: e.clientY - r.top, grabX: e.clientX - r.left}; dragging.current = d; e.dataTransfer.setData('application/x-plan', JSON.stringify(d)); e.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => { dragging.current = null; setDropGhost(null); }}
          style={place(s, b.minutes, lane)}
          onClick={e => { if ((e.target as HTMLElement).closest('button, a, .dp-btitle-link')) return; if (it) open(it.id); else setEditing(b.id); }}
          title={it ? 'Click to open the task (notes, status, people). The clock opens this time slot' : 'Click to edit this time slot'}>
          <div className="dp-brow">
            <button className={'check' + (done ? ' on' : '')} onClick={() => toggleEntry('blocks', b)}>{done && <CheckIcon size={11} strokeWidth={3} />}</button>
            <span className="dp-btitle">{it ? <button className="dp-btitle-link" title="Open the task" onClick={() => open(it.id)}><span className="dp-key">{itemKey(it, store.projects)}</span> {it.title}</button> : (b.text || <span className="muted">(untitled)</span>)}</span>
            <span className="dp-btime">{label(mins(b.start))} to {label(mins(b.start) + b.minutes)}</span>
            {b.eventId && <span title="On your calendar"><CalendarClock size={11} className="muted" /></span>}
            {b.fitted && <span className="dp-fitted" title={b.planned ? `Fitted to logged time. Planned ${label(mins(b.planned.start))}, ${b.planned.minutes} min` : 'Logged work that had no box'}>{b.planned ? 'actual' : 'unplanned'}</span>}
            {blockTools(b, it, done, running)}
          </div>
          {(it || b.links?.length || b.note) && b.minutes * px >= 40 && <div className="dp-bmore">{it && taskInfo(it)}{linkChips(b)}{b.note && <span className="dp-note">{b.note}</span>}</div>}
          {!horiz && <span className="dp-resize top" title="Drag to change the start" onMouseDown={e => startResizeTop(e, b, (start, minutes) => patchBlock(b.id, {start: hhmm(start), minutes}), px, startM)} onClick={e => e.stopPropagation()} />}
          <span className={'dp-resize' + (horiz ? ' x' : '')} title="Drag to change the length" onMouseDown={e => startResize(e, b, m => patchBlock(b.id, {minutes: m}), px, horiz)} onClick={e => e.stopPropagation()} />
        </div>;
      })}
    </div>
    {!plan.blocks.length && <p className="muted small dp-hint">Drag a priority, a brain dump line or a task onto a time, or press Plan my day from now. Reminders go to your Inbox and to phones and desktops with notifications on.</p>}
  </div>;
  // Agenda: the boxes as a list in time order, times edited in place.
  const sorted = [...plan.blocks].sort((a, b) => mins(a.start) - mins(b.start));
  const agenda = <div className="dp-agenda" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const d = JSON.parse(e.dataTransfer.getData('application/x-plan') || 'null') as DragData | null; if (d && d.from !== 'block') placeDrop(d, nextFree(30)); }}>
    <h4>Today's time boxes</h4>
    {!sorted.length && <p className="muted small">Drop things here (they go in the next free time) or press Plan my day from now.</p>}
    {sorted.map(b => { const it = item(b), done = isDone(b), s = mins(b.start), running = !!it && store.running?.itemId === it.id;
      const cur = nowM !== null && nowM >= s && nowM < s + b.minutes;
      return <div key={b.id} data-src={srcOf(b)} className={'dp-arow' + (done ? ' done' : '') + (cur ? ' now' : '')}>
        <input type="time" className="plain-input dp-atime" value={b.start} step={300} onChange={e => e.target.value && patchBlock(b.id, {start: e.target.value, at: atOf(plan.date, e.target.value)})} />
        <select className="plain-select small" value={b.minutes} onChange={e => patchBlock(b.id, {minutes: Number(e.target.value)})}>{[15, 30, 45, 60, 90, 120, 180, 240].concat(b.minutes).filter((v, i, a) => a.indexOf(v) === i).sort((x, y) => x - y).map(v => <option key={v} value={v}>{v < 60 ? `${v}m` : `${v / 60}h`}</option>)}</select>
        <button className={'check' + (done ? ' on' : '')} onClick={() => toggleEntry('blocks', b)}>{done && <CheckIcon size={11} strokeWidth={3} />}</button>
        <span className="dp-acol"><button className="dp-text link" onClick={() => it ? open(it.id) : setEditing(b.id)}>{it ? <span className="dp-key">{itemKey(it, store.projects)}</span> : null} {it?.title ?? b.text}</button>
          {it && taskInfo(it)}{linkChips(b)}</span>
        {blockTools(b, it, done, running)}
      </div>; })}
  </div>;
  // Focus: what is on now, and what is next.
  const curB = sorted.find(b => nowM !== null && nowM >= mins(b.start) && nowM < mins(b.start) + b.minutes);
  const nextB = sorted.find(b => nowM !== null && mins(b.start) > nowM && !isDone(b));
  const nowCard = <div className="dp-nowcard">
    <span className="muted small">{curB ? 'Now' : 'Nothing boxed right now'}</span>
    {curB && <><div className="dp-nowtitle">{item(curB)?.title ?? curB.text}</div>
      <div className="muted">{label(mins(curB.start))} to {label(mins(curB.start) + curB.minutes)} · {Math.max(0, mins(curB.start) + curB.minutes - (nowM ?? 0))} min left</div>
      <div className="row"><button className="btn small" onClick={() => toggleEntry('blocks', curB)}><CheckIcon size={12} /> {isDone(curB) ? 'Not done' : 'Done'}</button>
        {item(curB) && <button className="btn small" onClick={() => store.startTimer(item(curB)!.id)}><Play size={12} /> Start timer</button>}</div></>}
    {nextB && <div className="dp-next small">Next at {label(mins(nextB.start))}: <b>{item(nextB)?.title ?? nextB.text}</b></div>}
  </div>;
  // Time logged today with timers, per task (the same entries as the Timesheet).
  const loggedBy = [...logged.reduce((m, t) => m.set(t.itemId, (m.get(t.itemId) ?? 0) + (t.minutes ?? (t.end ? 0 : (Date.now() - Date.parse(t.start)) / 60000))), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  // The day's timesheet: every timer and logged entry, in time order, with totals per task.
  const dayEntries = [...logged].sort((a, b) => a.start.localeCompare(b.start));
  const entryMin = (t: TimeEntry) => t.minutes ?? (t.end ? 0 : (Date.now() - Date.parse(t.start)) / 60000);
  const loggedSec = <section className="dp-sec dp-timesheet">
    <h4>Timesheet for the day <span className="count">{fmtM(loggedBy.reduce((a, x) => a + x[1], 0))}</span></h4>
    {!dayEntries.length ? <p className="muted small">No time logged yet. Press play on a box to start a timer.</p> : <>
      {dayEntries.map(t => { const it = store.items.get(t.itemId), s = inZone(t.start, tz).m, timed = !!t.end && t.end !== t.start;
        return <div key={t.id} className={'dp-tsrow' + (!t.end ? ' running' : '')}>
          <span className="dp-tstime">{!t.end ? `${label(s)} to now` : timed ? `${label(s)} to ${label(inZone(t.end, tz).m)}` : 'logged'}</span>
          <button className="dp-text link" onClick={() => open(t.itemId)}>{it ? <><span className="dp-key">{itemKey(it, store.projects)}</span> {it.title}</> : 'A task'}</button>
          <span className="muted small">{fmtM(entryMin(t))}</span>
        </div>; })}
      {loggedBy.length > 1 && <div className="dp-tstotals small muted">{loggedBy.map(([iid, m]) => { const it = store.items.get(iid); return <span key={iid}>{it ? itemKey(it, store.projects) : 'Task'} {fmtM(m)}</span>; })}</div>}
    </>}
    <a className="small" href="#/timesheet">Week timesheet</a>
  </section>;
  const eb = editing ? plan.blocks.find(b => b.id === editing) : undefined;
  const editor = eb && <BoxEditor key={eb.id} store={store} b={eb} date={date} space={space} open={open}
    patch={p => patchBlock(eb.id, p)} remove={() => { removeBlock(eb.id); setEditing(null); }} close={() => setEditing(null)} />;
  const fold = (k: string, title: string, body: React.ReactNode) => <details open={isOpen(k)} onToggle={e => { const v = (e.currentTarget as HTMLDetailsElement).open; if (v !== isOpen(k)) setOpen(k, v); }}><summary>{title}</summary>{body}</details>;
  const tabsBar = <div className="dp-tabs">{(['dump', 'top', 'tasks', 'day'] as const).map(t => <button key={t} className={'btn' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>{({dump: 'Brain dump', top: 'Top 3', tasks: `Assigned (${mine.length})`, day: `Day (${plan.blocks.length})`})[t]}</button>)}</div>;

  let body;
  switch (D.id) {
    case 'gcal': body = <div className="dp-main">{dayGrid}<div className="dp-left right">{topSec}{dumpSec}{mineSec}</div></div>; break;
    case 'columns': body = <div className="dp-main"><div className="dp-left">{topSec}{dumpSec}</div>{dayGrid}<div className="dp-left right">{mineSec}</div></div>; break;
    case 'focus': body = <div className="dp-main"><div className="dp-left">{nowCard}{fold('top', 'Top 3', topSec)}{fold('dump', `Brain dump (${plan.dump.filter(e => !isDone(e)).length})`, dumpSec)}{fold('mine', `Assigned (${mine.length})`, mineSec)}{fold('logged', 'Timesheet for the day', loggedSec)}</div>{dayGrid}</div>; break;
    case 'agenda': body = <div className="dp-main"><div className="dp-left">{topSec}{dumpSec}{mineSec}</div><div className="dp-day">{agenda}</div></div>; break;
    case 'zen': body = <div className="dp-main"><div className="dp-left">{topSec}<details><summary>Brain dump ({plan.dump.length})</summary>{dumpSec}</details><details><summary>Assigned ({mine.length})</summary>{mineSec}</details></div>{dayGrid}</div>; break;
    case 'tabs': body = <div className="dp-main col">{tabsBar}<div className="dp-tabbody">{tab === 'dump' ? dumpSec : tab === 'top' ? topSec : tab === 'tasks' ? mineSec : <>{nowCard}{dayGrid}</>}</div></div>; break;
    case 'horizontal': body = <div className="dp-main col">{dayGrid}<div className="dp-row3">{topSec}{dumpSec}{mineSec}</div></div>; break;
    default: body = <div className="dp-main"><div className="dp-left">{topSec}{dumpSec}{mineSec}</div>{dayGrid}</div>;
  }
  return <div className={`dp d-${D.id}${bySource ? ' by-source' : ''}`}>{head}{body}{editor}</div>;
}

type Density = 'compact' | 'normal' | 'roomy';
const DENSITY: Record<Density, number> = {compact: 0.75, normal: 1, roomy: 1.4};
/** Ten ways to lay out and style the planner. Same data; pick one in the header. */
export const DESIGNS: {id: string; name: string; hint: string; px?: number}[] = [
  {id: 'classic', name: 'Classic', hint: 'Lists on the left, the day on the right'},
  {id: 'paper', name: 'Paper planner', hint: 'Grid paper and ruled boxes, like a printed day planner'},
  {id: 'gcal', name: 'Calendar', hint: 'Calendar first with solid colored events; lists on the right'},
  {id: 'columns', name: 'Three columns', hint: 'Top 3 and dump, the day, then assigned work'},
  {id: 'focus', name: 'Focus', hint: 'A big Now and Next card; the rest folds away'},
  {id: 'agenda', name: 'Agenda list', hint: 'No grid: time boxes as a list with editable times'},
  {id: 'night', name: 'Night', hint: 'Dark, high contrast, glowing boxes'},
  {id: 'zen', name: 'Zen', hint: 'Big type, no borders, only Top 3 and the day'},
  {id: 'tabs', name: 'Phone tabs', hint: 'One section at a time with big touch targets'},
  {id: 'horizontal', name: 'Timeline across', hint: 'Hours run left to right; lists underneath', px: 3.4},
];

function startResize(e: React.MouseEvent, b: Block, done: (minutes: number) => void, px: number, horiz: boolean) {
  e.preventDefault(); e.stopPropagation();
  const y0 = horiz ? e.clientX : e.clientY, m0 = b.minutes, el = (e.currentTarget as HTMLElement).parentElement!;
  let minutes = m0;
  const move = (ev: MouseEvent) => { minutes = Math.max(15, Math.round((m0 + ((horiz ? ev.clientX : ev.clientY) - y0) / px) / 15) * 15); el.style[horiz ? 'width' : 'height'] = `${minutes * px - 2}px`; };
  const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); if (minutes !== m0) done(minutes); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}

/** Drag a box's top edge: the start moves, the end stays. */
function startResizeTop(e: React.MouseEvent, b: Block, done: (start: number, minutes: number) => void, px: number, viewStart: number) {
  e.preventDefault(); e.stopPropagation();
  const y0 = e.clientY, s0 = mins(b.start), end = s0 + b.minutes, el = (e.currentTarget as HTMLElement).parentElement!;
  const top0 = parseFloat(el.style.top);
  let start = s0;
  const move = (ev: MouseEvent) => {
    start = Math.max(viewStart, Math.min(end - 15, Math.round((s0 + (ev.clientY - y0) / px) / 15) * 15));
    el.style.top = `${top0 + (start - s0) * px}px`; el.style.height = `${(end - start) * px - 2}px`;
  };
  const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); if (start !== s0) done(start, end - start); };
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

const fmtM = (m: number) => m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`;

/** Edit one time box: title, time, note, tasks tied to it (done in or to discuss), make it a task, put it on the calendar. */
function BoxEditor({store, b, date, space, open, patch, remove, close}: {store: Store; b: Block; date: string; space: string; open: (id: string) => void; patch: (p: Partial<Block>) => void; remove: () => void; close: () => void}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const it = b.itemId ? store.items.get(b.itemId) : undefined;
  const found = q.trim().length < 2 ? [] : [...store.items.values()].filter(i => !i.recur?.spawned && i.id !== b.itemId && !(b.links ?? []).includes(i.id) &&
    (itemKey(i, store.projects).toLowerCase() === q.trim().toLowerCase() || i.title.toLowerCase().includes(q.trim().toLowerCase()))).sort((a, c) => Number(!!a.completed) - Number(!!c.completed)).slice(0, 8);
  const s = mins(b.start);
  const toCalendar = async () => {
    setBusy(true);
    try {
      const start = new Date(`${date}T${b.start}:00`), end = new Date(start.getTime() + b.minutes * 60000);
      const linked = (b.links ?? []).map(id => store.items.get(id)).filter(Boolean).map(x => `- ${itemKey(x!, store.projects)} ${x!.title}`);
      const ev = await api<{id: string; google?: unknown}>('/meetings', {method: 'POST', body: {title: (it?.title ?? b.text) || 'Time block', start: start.toISOString(), end: end.toISOString(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone, body: [b.note, linked.length ? 'Tasks:\n' + linked.join('\n') : ''].filter(Boolean).join('\n\n'), ...(b.itemId ? {itemId: b.itemId} : {}), visibility: 'attendees'}});
      patch({eventId: ev.id});
    } catch (e) { store.fail(e); } finally { setBusy(false); }
  };
  const makeTask = async () => {
    const pid = realProjects(store.projects).find(p => p.id === space)?.id ?? realProjects(store.projects)[0]?.id;
    if (!pid || !b.text.trim()) return;
    const made = await store.quickAdd(pid, b.text);
    if (made) { if (!made.assignees.length) store.updateItem(made.id, {assignees: [store.me]}); patch({itemId: made.id, text: made.title}); }
  };
  return <div className="dp-editor" onMouseDown={e => e.stopPropagation()}>
    <div className="row"><b className="grow">Time box</b><button className="icon" onClick={close} title="Close"><X size={14} /></button></div>
    <input className="plain-input dp-etitle" autoFocus={!it} placeholder="What is it? (Lunch, Call Tim, Team meeting)" defaultValue={it?.title ?? b.text}
      onBlur={e => { const v = e.target.value.trim(); if (it) { if (v && v !== it.title) store.updateItem(it.id, {title: v}); } else if (v !== b.text) patch({text: v}); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    {it && <button className="btn ghost small" onClick={() => open(it.id)} title="Open the full task"><span className="dp-key">{itemKey(it, store.projects)}</span> Open task</button>}
    <div className="row">
      <input type="time" className="plain-input" value={b.start} step={300} onChange={e => e.target.value && patch({start: e.target.value, at: new Date(`${date}T${e.target.value}:00`).toISOString()})} />
      <select className="plain-select" value={b.minutes} onChange={e => patch({minutes: Number(e.target.value)})}>{[15, 30, 45, 60, 90, 120, 180, 240].concat(b.minutes).filter((v, i, a) => a.indexOf(v) === i).sort((x, y) => x - y).map(v => <option key={v} value={v}>{v < 60 ? `${v} min` : `${v / 60} h`}</option>)}</select>
      <span className="muted small">to {label(s + b.minutes)}</span>
    </div>
    {b.planned && <div className="row small muted">Planned {label(mins(b.planned.start))} for {b.planned.minutes} min
      <button className="btn ghost small" onClick={() => patch({start: b.planned!.start, minutes: b.planned!.minutes, at: new Date(`${date}T${b.planned!.start}:00`).toISOString(), planned: null, fitted: false})}><Undo2 size={12} /> Back to plan</button></div>}
    <label className="row small"><input type="checkbox" checked={!!b.remind} onChange={e => patch({remind: e.target.checked, at: new Date(`${date}T${b.start}:00`).toISOString()})} /> Remind me when it starts</label>
    <textarea className="plain-input" rows={2} placeholder="Note or agenda" defaultValue={b.note ?? ''} onBlur={e => e.target.value !== (b.note ?? '') && patch({note: e.target.value})} />
    <div className="dp-field"><span className="muted small">Tasks tied to this box (done in it, or to discuss)</span>
      {(b.links ?? []).map(id => { const x = store.items.get(id); return <div key={id} className="row small">
        {x && <Check item={x} project={store.projects.find(p => p.id === x.projectId)!} onToggle={status => store.updateItem(x.id, {status})} />}
        <button className="link grow" style={{textAlign: 'left'}} onClick={() => open(id)}>{x ? <><span className="dp-key">{itemKey(x, store.projects)}</span> {x.title}</> : 'Task'}</button>
        <button className="icon" title="Untie" onClick={() => patch({links: (b.links ?? []).filter(y => y !== id)})}><X size={11} /></button></div>; })}
      <input className="plain-input" placeholder="Tie a task: key or title" value={q} onChange={e => setQ(e.target.value)} />
      {found.map(i => <button key={i.id} className="pop-row small" onClick={() => { patch({links: [...(b.links ?? []), i.id]}); setQ(''); }}>{itemKey(i, store.projects)} {i.title}{i.completed ? ' (done)' : ''}</button>)}
    </div>
    <div className="row">
      {!it && <button className="btn small" disabled={!b.text.trim()} onClick={makeTask} title="Make this box a task (quick-add works)"><ListPlus size={12} /> Make it a task</button>}
      {b.eventId ? <span className="muted small"><CalendarClock size={12} /> On your calendar</span>
        : <button className="btn small" disabled={busy} onClick={toCalendar} title="Add it to your calendar (and Google Calendar when connected). Invite people from the meeting"><CalendarPlus size={12} /> Add to calendar</button>}
      <span className="spacer" />
      <button className="btn small danger" onClick={remove}><Trash2 size={12} /> Remove</button>
    </div>
  </div>;
}
