// Day planner: the overwhelm page. Top 3, a brain dump, today's and overdue tasks, and the day as time boxes.
// Drag lines and tasks onto the day, drag boxes to move them, drag the bottom edge to resize. Done boxes turn green.
// Saved per person per day at /api/day/:date (server/dayplan.ts).
import {BellRing} from 'lucide-react';
import {spaceColor} from './ProjectNav.tsx';
import {eventColor} from './Meetings.tsx';
import {useCallback, useEffect, useRef, useState} from 'react';
import {Bell, BellOff, CalendarClock, CalendarPlus, CalendarRange, ChevronDown, History, ChevronLeft, ChevronRight, Clock, GitMerge, GripVertical, Link2, ListPlus, Pencil, Play, Timer, Undo2, Plus, Square, Trash2, Video, Wand2, X, Check as CheckIcon} from 'lucide-react';
import type {Item, TimeEntry} from './types.ts';
import {PRIORITIES} from './types.ts';
import {api, realProjects, type Store} from './store.ts';
import {Avatars, Check, Popover, PriorityIcon, itemKey} from './components.tsx';
import {addDays} from './dates.ts';

type Entry = {id: string; text: string; itemId?: string | null; done?: boolean};
type Block = Entry & {start: string; minutes: number; at?: string | null; remind?: boolean; remindBefore?: number; links?: string[]; eventId?: string | null; note?: string; planned?: {start: string; minutes: number} | null; fitted?: boolean; color?: string | null};
type FitSummary = {plannedMinutes: number; loggedMinutes: number; moved: number; added: number; upTo: string | null};
/** A calendar event (Cadence meeting or synced Google event) shown on the day. */
type CalEv = {id: string; title: string; start: string; end: string; allDay: boolean; meetUrl: string | null; location: string; source: string; occurrenceOf?: string; itemId: string | null; color?: string | null};
type Plan = {tz: string; updated?: string | null; date: string; top: Entry[]; dump: Entry[]; blocks: Block[]; dayStart: number; dayEnd: number; slot: number; remindAll?: boolean};
/** day: the day a dragged box comes from (week view). */
type DragData = {from: 'top' | 'dump' | 'task' | 'block'; id: string; itemId?: string | null; text: string; grab?: number; grabX?: number; day?: string};

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
import {TimeEntryEdit} from './TimeTracker.tsx';
import {checkEntries, entryDone, type TaskInfo} from './daycheck.ts';
import {boxesFor, carryLines, copyBox} from './dayweek.ts';
import {EventEditor, GCAL_COLORS, type CalEvent as FullEvent} from './Meetings.tsx';
import {uiAlert, uiConfirm} from './dialogs.tsx';

export function DayPlanner({store, me, open}: {store: Store; me: string; open: (id: string) => void}) {
  const [date, setDate] = useState(localDate);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [time, setTime] = useState<TimeEntry[]>([]);
  const [line, setLine] = useState('');
  const [space, setSpace] = useState(() => localStorage.getItem('day-space') ?? '');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [design, setDesignState] = useState(() => { const d = localStorage.getItem('day-design'); return d === 'columns' || d === 'horizontal' ? d : 'focus'; });
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem('day-density') as Density) || 'normal');
  const [bySource, setBySource] = useState(() => !!localStorage.getItem('day-bysource'));
  const [events, setEvents] = useState<CalEv[]>([]);
  const [week, setWeek] = useState<{date: string; boxes: number; minutes: number; events: number}[]>([]);
  // Week view: the seven days around the day, their plans and calendar events. Dragging a box to another day copies it.
  const [view, setViewState] = useState<'day' | 'week'>(() => localStorage.getItem('day-view') === 'week' ? 'week' : 'day');
  const setView = (v: 'day' | 'week') => { setViewState(v); localStorage.setItem('day-view', v); };
  const [weekPlans, setWeekPlans] = useState<{date: string; plan: Plan | null}[]>([]);
  const [weekEvents, setWeekEvents] = useState<CalEv[]>([]);
  const [weekTick, setWeekTick] = useState(0);
  const [weekGhost, setWeekGhost] = useState<{date: string; m: number; len: number} | null>(null);
  // Roll over: open brain dump lines from the 7 days before, offered on today and later days.
  const [earlier, setEarlier] = useState<{date: string; plan: Plan}[]>([]);
  const [carryOpen, setCarryOpen] = useState(false);
  const [carryOff, setCarryOff] = useState<Set<string>>(new Set());
  const [carrySkip, setCarrySkip] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('day-carry-skip') ?? '[]') as string[]); } catch { return new Set(); } });
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
  const [tsEdit, setTsEdit] = useState<string | null>(null);
  // The full calendar editor (Meet link, repeats, guests, color), for an event or a box that becomes one.
  const [evEdit, setEvEdit] = useState<{event?: FullEvent; draft?: Partial<FullEvent>; boxId?: string} | null>(null);
  const [fitInfo, setFitInfo] = useState<FitSummary | null>(null);
  const [showPlanned, setShowPlanned] = useState(() => localStorage.getItem('day-planned') !== 'off');
  const [leftW, leftDrag, leftReset] = usePanelSize('dp-w-left', 360, 220, 760, 1);
  const [rightW, rightDrag, rightReset] = usePanelSize('dp-w-right', 300, 200, 700, -1);
  const [bottomH, bottomDrag, bottomReset] = usePanelSize('dp-h-bottom', 320, 140, 900, -1, true);
  const [bySpace, setBySpace] = useState(() => localStorage.getItem('day-byspace') === '1');
  // Lines and tasks already in a box on the day: shaded with their times (default), hidden, or shown as usual.
  const [onDay, setOnDay] = useState<'shade' | 'hide' | 'plain'>(() => { const v = localStorage.getItem('day-onday'); return v === 'hide' || v === 'plain' ? v : 'shade'; });
  // Google Calendar: which of your Google accounts share calendars here, and whether Google is set up at all.
  const [gcal, setGcal] = useState<{links: {email: string}[]; ready: boolean} | null>(null);
  useEffect(() => {
    Promise.all([api<{email: string; scopes: string}[]>('/google/links').catch(() => []), api<{googleReady?: boolean}>('/auth/me').catch(() => ({googleReady: false}))])
      .then(([l, m]) => setGcal({links: l.filter(x => x.scopes.includes('calendar')), ready: !!m.googleReady}));
    const linked = new URLSearchParams(location.hash.split('?')[1] ?? '').get('linked');
    if (linked) { store.flash(`Google Calendar connected: ${linked}`); window.history.replaceState(null, '', '#/day'); }
  }, []);
  // Undo for the planner: earlier plans, and tasks a step created (removed again on undo).
  const history = useRef<{plan: Plan; created: string[]; status?: {id: string; status: string}}[]>([]);
  // The key handler below is set up once; it reads the store through this so it sees tasks made since.
  const storeRef = useRef(store); storeRef.current = store;
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
      .then(([plans, evs]) => {
        setWeekPlans(days.map((d, i) => ({date: d, plan: plans[i]})));
        setWeekEvents(evs.filter(e => !e.allDay));
        setWeek(days.map((d, i) => { const p = plans[i]; const tzz = p?.tz || browserTz();
          return {date: d, boxes: p?.blocks.length ?? 0, minutes: p?.blocks.reduce((a, b) => a + b.minutes, 0) ?? 0, events: evs.filter(e => !e.allDay && inZone(e.start, tzz).day === d).length}; }));
      });
  }, [date, me, Math.floor(now.getTime() / 60_000), plan?.updated, weekTick]);
  // The days before, for rolling brain dump lines over (only on today and later days).
  useEffect(() => {
    if (!me || date < localDate()) { setEarlier([]); return; }
    const days = Array.from({length: 7}, (_, i) => addDays(date, -1 - i));
    Promise.all(days.map(d => api<Plan>(`/day/${d}?person=${me}&tz=${encodeURIComponent(browserTz())}`).then(p => ({date: d, plan: p})).catch(() => null)))
      .then(l => setEarlier(l.filter((x): x is {date: string; plan: Plan} => !!x && !!x.plan.updated && x.plan.dump.length > 0)));
  }, [date, me, weekTick]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);

  const save = (next: Plan, created: string[] = [], status?: {id: string; status: string}) => {
    if (latest.current && latest.current.date === next.date) { history.current.push({plan: latest.current, created, ...(status ? {status} : {})}); if (history.current.length > 100) history.current.shift(); }
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
      // A check-off that completed or reopened a task puts the task back too.
      const st = storeRef.current;
      if (last.status && st.items.get(last.status.id)) st.updateItem(last.status.id, {status: last.status.status});
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
    if (!el || !plan || scrolled.current === date + design) return;
    scrolled.current = date + design;
    const tzz = plan.tz || browserTz();
    const target = date === inZone(new Date(), tzz).day ? inZone(new Date(), tzz).m - 60 : plan.blocks.length ? Math.min(...plan.blocks.map(b => mins(b.start))) - 30 : plan.dayStart * 60;
    const grid = el.querySelector('.dp-grid') as HTMLElement | null;
    const viewStart = localStorage.getItem('day-early') === '1' ? 0 : Math.min(6, plan.dayStart) * 60;
    const k = (DESIGNS.find(x => x.id === design)?.px ?? 1.4) * DENSITY[density];
    if (grid && design === 'horizontal') el.scrollLeft = Math.max(0, (target - viewStart) * k);
    else if (grid) el.scrollTop = Math.max(0, grid.offsetTop + (target - viewStart) * k);
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
  const tinfo: TaskInfo = id => { const it = store.items.get(id); return it ? {title: it.title, completed: !!it.completed} : undefined; };
  // Done once per line: a task line (or a plain line with the same text as a task on the page) follows the task.
  const doneIds = new Set([...plan.top, ...plan.dump, ...plan.blocks].filter(e => entryDone(plan, e, tinfo)).map(e => e.id));
  const isDone = (e: Entry) => doneIds.has(e.id);
  /** The boxes on this day a line or task is already in (it may be in several: work, a break, more work). */
  const boxesOf = (e: {itemId?: string | null; text: string}) => boxesFor(plan.blocks, e, tinfo);
  const boxed = (e: {itemId?: string | null; text: string}) => boxesOf(e).length > 0;
  /** Scroll the day to a box and flash it. */
  const showBox = (id: string) => {
    if (view === 'week') setView('day');
    setTimeout(() => { const el = document.querySelector(`.dp-block[data-box="${id}"]`) as HTMLElement | null; if (!el) return; el.scrollIntoView({block: 'center', behavior: 'smooth'}); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); }, 50);
  };
  /** On the day: the times of its boxes; click to see the first one. */
  const onDayChip = (e: {itemId?: string | null; text: string}) => {
    const bs = boxesOf(e);
    if (!bs.length || onDay === 'plain') return bs.length ? <Clock size={11} className="muted" aria-label="On the day" /> : null;
    const times = bs.slice(0, 3).map(b => label(mins(b.start))).join(', ') + (bs.length > 3 ? ` +${bs.length - 3}` : '');
    return <button className="dp-onday" onClick={() => showBox(bs[0].id)} title={`Already on this day: ${bs.map(b => `${label(mins(b.start))} to ${label(mins(b.start) + b.minutes)}`).join(', ')}. Click to see it. Dragging it out again adds another box`}><Clock size={10} /> {times}</button>;
  };
  const shade = (e: {itemId?: string | null; text: string}) => onDay !== 'plain' && boxed(e) ? ' boxed' : '';
  const hidden = (e: {itemId?: string | null; text: string}) => onDay === 'hide' && boxed(e);
  /** Check a line off (or back on) everywhere it shows: top 3, brain dump and boxes with the same task or text, and the task itself. */
  const toggleEntry = (e: Entry) => {
    const want = !isDone(e);
    const r = checkEntries(latest.current!, e.id, want, tinfo);
    if (!r) return;
    const it = r.itemId ? store.items.get(r.itemId) : undefined;
    let before: {id: string; status: string} | undefined;
    if (it && !!it.completed !== want) {
      const p = store.projects.find(x => x.id === it.projectId)!;
      const doneS = p.statuses.find(s => s.category === 'done')?.id, todoS = p.statuses.find(s => s.category === 'todo')?.id ?? p.statuses[0].id;
      before = {id: it.id, status: it.status};
      store.updateItem(it.id, {status: want ? doneS ?? todoS : todoS});
    }
    // Saved (with undo) even when only the task changed, so Ctrl+Z can reopen it.
    if (before || JSON.stringify(r.plan) !== JSON.stringify(latest.current)) save(r.plan, [], before);
  };
  const tzq = `person=${me}&tz=${encodeURIComponent(browserTz())}`;
  /** Change any day: the one shown goes through the page (with undo); another day is read fresh, changed and saved. */
  const editDay = async (d: string, fn: (p: Plan) => Plan) => {
    if (d === date) { update(fn); return; }
    try {
      const n = fn(await api<Plan>(`/day/${d}?${tzq}`));
      await api(`/day/${d}?${tzq}`, {method: 'PUT', body: {top: n.top, dump: n.dump, blocks: n.blocks}});
    } catch (e) { store.fail(e); }
    setWeekTick(t => t + 1);
  };
  /** A box dragged to another day is copied there (Shift: moved). On its own day it just moves to the new time. */
  const sendBox = async (from: string, b: Block, to: string, start: string, move: boolean) => {
    if (from === to) { await editDay(to, p => ({...p, blocks: p.blocks.map(x => x.id === b.id ? {...x, start, at: atOf(p.date, start)} : x)})); return; }
    await editDay(to, p => ({...p, blocks: [...p.blocks, {...copyBox(b, rid, start), at: atOf(to, start)} as Block]}));
    if (move) await editDay(from, p => ({...p, blocks: p.blocks.filter(x => x.id !== b.id)}));
    store.flash(`${move ? 'Moved' : 'Copied'} "${item(b)?.title ?? (b.text || 'Time box')}" to ${dayName(to, true)}${move ? '' : '. Hold Shift while dropping to move instead'}`);
  };
  const planOf = (d: string) => d === date ? plan : weekPlans.find(w => w.date === d)?.plan ?? null;
  /** Check a box off on any day of the week. */
  const checkOn = async (d: string, b: Block) => {
    if (d === date) { toggleEntry(b); return; }
    try { await api(`/day/${d}/check?${tzq}`, {method: 'POST', body: {id: b.id}}); } catch (e) { store.fail(e); }
    setWeekTick(t => t + 1);
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
  // Roll over: open plain lines (not tasks) from the days before. Brought over, they come to this day; the earlier
  // days keep theirs, so Ctrl+Z loses nothing, and the copy here (the newest) decides whether it is offered again.
  const carry = carryLines(earlier, plan, tinfo).filter(x => !carrySkip.has(x.entry.id));
  const carryPicked = carry.filter(x => !carryOff.has(x.entry.id));
  const normText = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
  const bringOver = () => {
    if (!carryPicked.length) return;
    const here = new Set(latest.current!.dump.map(l => normText(l.text)));
    update(p => ({...p, dump: [...p.dump, ...carryPicked.filter(x => !here.has(normText(x.entry.text))).map(x => ({id: rid(), text: x.entry.text}))]}));
    setCarryOpen(false); setCarryOff(new Set());
    store.flash(`Brought over ${carryPicked.length} line${carryPicked.length === 1 ? '' : 's'}. Make them tasks or keep them as lines`);
  };
  const leaveCarry = () => {
    const next = new Set([...carrySkip, ...carry.map(x => x.entry.id)]);
    setCarrySkip(next); setCarryOpen(false);
    localStorage.setItem('day-carry-skip', JSON.stringify([...next].slice(-500)));
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
  /** One line becomes a task in the chosen space, assigned to you, and the line is tied to it. */
  const createOne = async (e: Entry) => {
    const pid = realProjects(store.projects).find(p => p.id === space)?.id ?? realProjects(store.projects)[0]?.id;
    if (!pid) { void uiAlert('Make a space first.'); return; }
    const it = await store.quickAdd(pid, e.text);
    if (!it) return;
    if (!it.assignees.length) store.updateItem(it.id, {assignees: [me]});
    if (!it.due) store.updateItem(it.id, {due: date});
    update(p => linkText(p, e.text, it.id, it.title), [it.id]);
    store.flash(`Made ${itemKey(it, store.projects)} in ${store.projects.find(p => p.id === pid)?.name}`);
  };
  const createTasks = async () => {
    const pid = realProjects(store.projects).find(p => p.id === space)?.id ?? realProjects(store.projects)[0]?.id;
    if (!pid) { void uiAlert('Make a space first.'); return; }
    const todo = latest.current!.dump.filter(e => !e.itemId && !e.done);
    if (!todo.length) { store.flash('Every line is already a task'); return; }
    if (!(await uiConfirm(`Make ${todo.length} new task${todo.length === 1 ? '' : 's'} in ${realProjects(store.projects).find(p => p.id === pid)?.name}, assigned to you?${matchOn ? '' : ' Tip: turn on Match first to tie lines to tasks you already have.'}`))) return;
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
    const sc = bySpace && it ? spaceColor(store.projects, it.projectId) : undefined;
    if (list === 'dump' && hidden(e)) return null;
    return <div key={e.id} className={'dp-entry' + (done ? ' done' : '') + shade(e) + (sc ? ' spaced' : '') + mark} style={sc ? {'--sc': sc} as React.CSSProperties : undefined} {...dragProps({from: list, id: e.id, itemId: e.itemId, text: e.text})}
      onDragOver={ev => listOver(ev, list, e.id)} onDrop={ev => dropOnList(ev, list)}>
      <GripVertical size={12} className="dp-grip" />
      <button className={'check' + (done ? ' on' : '')} onClick={() => toggleEntry(e)} title={done ? 'Mark not done' : 'Mark done'}>{done && <CheckIcon size={11} strokeWidth={3} />}</button>
      {editText === e.id ? <input className="plain-input dp-text" autoFocus defaultValue={it?.title ?? e.text} onBlur={ev => renameEntry(list, e, ev.target.value)} onKeyDown={ev => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') setEditText(null); }} />
        : it ? <span className="dp-text" onDoubleClick={() => setEditText(e.id)} title="Click the key to open the task; double-click to rename"><button className="dp-key link" onClick={() => open(it.id)}>{itemKey(it, store.projects)}</button> {it.title}</span>
        : <span className="dp-text" onDoubleClick={() => setEditText(e.id)} title="Double-click to edit">{e.text}</span>}
      {onDayChip(e)}
      <button className="icon dp-x" title="Edit" onClick={() => setEditText(e.id)}><Pencil size={11} /></button>
      <button className="icon dp-x" title="Remove from the list (the task stays)" onClick={() => update(p => ({...p, [list]: p[list].filter(x => x.id !== e.id)}))}><X size={12} /></button>
      {list === 'dump' && matchOn && !e.itemId && !isDone(e) && !dismissed.has(e.id) && <div className="dp-sugs">{sug.map(x => <button key={x.item.id} className="dp-sug" title={`Tie this line to ${x.item.title} (${Math.round(Math.min(1, x.score) * 100)}% match). It joins your day.`} onClick={() => useMatch(e, x.item)}>
        <GitMerge size={10} /> <span className="dp-key">{itemKey(x.item, store.projects)}</span> {x.item.title}</button>)}
        {!sug.length && <span className="muted small">No matching task.</span>}
        <button className="dp-sug make" title={`Make this line a task in ${store.projects.find(p => p.id === space)?.name ?? 'the chosen space'}, assigned to you, due this day`} onClick={() => createOne(e)}><ListPlus size={10} /> Create task</button>
        {sug.length > 0 && <button className="dp-sug none" title="None of these: keep it as a plain line" onClick={() => setDismissed(d => new Set(d).add(e.id))}>Keep as a line</button>}</div>}
    </div>;
  };
  // ---- Pieces each design arranges differently ----
  const D = DESIGNS.find(x => x.id === design) ?? DESIGNS[0];
  const horiz = D.id === 'horizontal';
  const px = (D.px ?? 1.4) * DENSITY[density];
  const srcOf = (b: Block) => plan.top.some(t => (b.itemId && t.itemId === b.itemId) || t.text.toLowerCase() === b.text.toLowerCase()) ? 'top' : b.itemId ? 'task' : 'dump';
  const head = <header className="dp-head">
    <h1><CalendarClock size={20} /> Day planner</h1>
    {gcal && (gcal.links.length
      ? <a className="dp-gcal on" href="#/team" title={`Google Calendar connected: ${gcal.links.map(l => l.email).join(', ')}. Manage it on the Team page`}><CalendarClock size={12} /> {gcal.links.length === 1 ? gcal.links[0].email : `${gcal.links.length} Google calendars`}</a>
      : gcal.ready ? <a className="btn small" href={`/api/auth/google/start?mode=link&want=calendar&as=${encodeURIComponent(me)}&back=/day`} title="Show your Google Calendar events on the day, and add boxes to it">Connect Google Calendar</a>
      : <a className="btn small ghost" href="#/team" title="An admin adds the Google OAuth client on the Team page first, then everyone can connect">Set up Google Calendar</a>)}
    <span className="seg dp-viewseg" role="group" aria-label="Day or week">
      <button className={view === 'day' ? 'on' : ''} onClick={() => setView('day')}><CalendarClock size={12} /> Day</button>
      <button className={view === 'week' ? 'on' : ''} onClick={() => setView('week')} title="The week side by side: drag a time box to another day to copy it"><CalendarRange size={12} /> Week</button>
    </span>
    <div className="dp-date">
      <button className="btn ghost small" onClick={() => setDate(addDays(date, view === 'week' ? -7 : -1))} title={view === 'week' ? 'Week before' : 'Day before'}><ChevronLeft size={14} /></button>
      <b>{view === 'week' && weekPlans.length ? `Week of ${new Date(`${weekPlans[0].date}T12:00:00`).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}` : new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'})}</b>
      <button className="btn ghost small" onClick={() => setDate(addDays(date, view === 'week' ? 7 : 1))} title={view === 'week' ? 'Week after' : 'Day after'}><ChevronRight size={14} /></button>
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
      <label className="small muted" title="Color tasks by their space's color (set a space's color from its menu in the sidebar). A box's own color wins"><input type="checkbox" checked={bySpace} onChange={e => { setBySpace(e.target.checked); localStorage.setItem('day-byspace', e.target.checked ? '1' : ''); }} /> Color by space</label>
      <label className="small muted" title="Lines and tasks you already put on this day (in a time box): shade them and show their times, hide them from the lists, or show them as usual">On the day
        <select className="plain-select small" value={onDay} onChange={e => { const v = e.target.value as typeof onDay; setOnDay(v); localStorage.setItem('day-onday', v); }}>
          <option value="shade">Shade, show times</option><option value="hide">Hide from lists</option><option value="plain">Show as usual</option></select></label>
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
    <label className={'small dp-remind-all' + (plan.remindAll ? ' on' : '')} title="Your setting, kept day to day: every time box sends an alert (phone and desktop) when it starts. Off: only boxes with their bell on.">
      <input type="checkbox" checked={!!plan.remindAll} onChange={e => { const on = e.target.checked; setPlan(p => p && {...p, remindAll: on}); if (latest.current) latest.current = {...latest.current, remindAll: on};
        api(`/day/${plan.date}?person=${me}&tz=${encodeURIComponent(browserTz())}`, {method: 'PUT', body: {remindAll: on}}).catch(err => store.fail(err)); if (on) askNotify(); }} />
      {plan.remindAll ? <Bell size={13} /> : <BellOff size={13} />} Remind all</label>
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
    {carry.length > 0 && <div className="dp-carry">
      <button className="dp-carry-head" aria-expanded={carryOpen} onClick={() => setCarryOpen(o => !o)} title="Lines from your brain dump on earlier days that are not tasks and not done">
        <History size={12} /> <span className="grow">{carry.length} open line{carry.length === 1 ? '' : 's'} from earlier days</span>{carryOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
      {carryOpen && <>
        {carry.map(x => <label key={x.entry.id} className="dp-carry-row small"><input type="checkbox" checked={!carryOff.has(x.entry.id)} onChange={e => setCarryOff(o => { const n = new Set(o); if (e.target.checked) n.delete(x.entry.id); else n.add(x.entry.id); return n; })} />
          <span className="grow">{x.entry.text}</span><span className="muted">{dayName(x.date)}</span></label>)}
        <div className="row">
          <button className="btn small primary" disabled={!carryPicked.length} onClick={bringOver} title="Bring the ticked lines to this day's brain dump">Bring over {carryPicked.length}</button>
          <button className="btn small ghost" onClick={leaveCarry} title="Stop offering these lines; they stay on their day">Leave them</button>
        </div>
        <p className="muted small">Ticked lines come to this day. Then make them tasks (Create task, Match) or keep them as lines. Ctrl+Z undoes.</p>
      </>}
    </div>}
    {plan.dump.map(e => entryRow(e, 'dump'))}
    {over?.list === 'dump' && !over.id && <div className="dp-dropline" />}
    {plan.dump.some(e => !e.itemId && !e.done) && <div className="dp-actions">
      <button className={'btn small' + (matchOn ? ' on' : '')} onClick={() => { setMatchOn(m => !m); setDismissed(new Set()); }} title="Show the closest existing tasks under each line, so you can tie a line to a task you already have"><GitMerge size={12} /> Match {matchOn ? 'on' : 'off'}</button>
      <button className="btn small" disabled={busy} onClick={createTasks} title="Make a task, assigned to you, for each line not tied to a task yet. Quick-add works in a line: @name due:fri ~1h"><ListPlus size={12} /> Create tasks</button>
      <label className="small muted">in <select className="plain-select small" value={realProjects(store.projects).some(p => p.id === space) ? space : realProjects(store.projects)[0]?.id} onChange={e => { setSpace(e.target.value); localStorage.setItem('day-space', e.target.value); }} title="The space new tasks go in">
        {realProjects(store.projects).filter(p => !p.settings.records).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {matchOn && !plan.dump.some(e => suggest(e).length) && <span className="muted small">No close tasks found. Use Create task on a line.</span>}
    </div>}
  </section>;
  const mineSec = <section className="dp-sec dp-minesec">
    <h4>Assigned: today and overdue <span className="count">{mine.length}</span>{mine.some(i => boxed({itemId: i.id, text: i.title})) && <span className="muted small"> {mine.filter(i => boxed({itemId: i.id, text: i.title})).length} on the day</span>}</h4>
    {!mine.length && <p className="muted small">Nothing due. Nice.</p>}
    {mine.filter(i => !hidden({itemId: i.id, text: i.title})).map(i => { const p = store.projects.find(x => x.id === i.projectId)!; const sc = bySpace ? spaceColor(store.projects, i.projectId) : undefined; return <div key={i.id} className={'dp-entry' + shade({itemId: i.id, text: i.title}) + (sc ? ' spaced' : '')} style={sc ? {'--sc': sc} as React.CSSProperties : undefined} title={i.title} {...dragProps({from: 'task', id: i.id, itemId: i.id, text: i.title})}>
      <GripVertical size={12} className="dp-grip" />
      <Check item={i} project={p} onToggle={status => store.updateItem(i.id, {status})} />
      <button className="dp-text link" onClick={() => open(i.id)}><span className="dp-key">{itemKey(i, store.projects)}</span> {i.title}</button>
      {i.due! < date && <span className="dp-late small">{i.due}</span>}
      {onDayChip({itemId: i.id, text: i.title})}
    </div>; })}
    {onDay === 'hide' && mine.some(i => boxed({itemId: i.id, text: i.title})) && <p className="muted small">{mine.filter(i => boxed({itemId: i.id, text: i.title})).length} more already on the day (hidden).</p>}
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
    <button className={'icon' + (b.remind || plan.remindAll ? ' on' : '')} title={plan.remindAll && !b.remind ? 'Remind all is on: you get a notification when it starts' : b.remind ? 'Reminder on: you get a notification when it starts' : 'Remind me when it starts (phone and desktop)'} onClick={() => patchBlock(b.id, {remind: !b.remind, at: atOf(plan.date, b.start)})}>{b.remind || plan.remindAll ? <Bell size={11} /> : <BellOff size={11} />}</button>
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
  // The week row, day arrows and notes stay put above the day; only the hours scroll.
  const dayHead = <div className="dp-dayhead">
    {week.length === 7 && <div className="dp-week">{week.map(w => {
      const due = [...store.items.values()].filter(i => i.assignees.includes(me) && !i.completed && i.due === w.date && !listSpaces.has(i.projectId)).length;
      // A box dropped on another day is copied there at the same time (Shift: moved).
      const canDrop = (e: React.DragEvent) => dragging.current?.from === 'block' && w.date !== date && (e.preventDefault(), true);
      return <button key={w.date} className={'dp-wday' + (w.date === date ? ' on' : '') + (w.date === today ? ' today' : '') + (weekGhost?.date === w.date && weekGhost.m < 0 ? ' drop-on' : '')} onClick={() => setDate(w.date)}
        onDragOver={e => { if (canDrop(e) && weekGhost?.date !== w.date) setWeekGhost({date: w.date, m: -1, len: 0}); }}
        onDragLeave={() => setWeekGhost(g => g?.date === w.date ? null : g)}
        onDrop={e => { setWeekGhost(null); const d = readDrag(e); const b = d?.from === 'block' ? plan.blocks.find(x => x.id === d.id) : undefined; if (!b || w.date === date) return; e.preventDefault(); void sendBox(date, b, w.date, b.start, e.shiftKey); }}
        title={`${w.boxes} time box${w.boxes === 1 ? '' : 'es'} (${fmtM(w.minutes)}), ${w.events} calendar event${w.events === 1 ? '' : 's'}, ${due} task${due === 1 ? '' : 's'} due. Drop a time box here to copy it to this day (hold Shift to move it)`}>
        <span className="dp-wname">{new Date(`${w.date}T12:00:00`).toLocaleDateString(undefined, {weekday: 'short'})} <b>{Number(w.date.slice(8))}</b></span>
        <span className="dp-wbar"><span style={{width: `${Math.min(100, w.minutes / 480 * 100)}%`}} /></span>
        <span className="dp-wstats">{w.boxes ? <span title="Time boxes">{fmtM(w.minutes)}</span> : null}{w.events ? <span title="Calendar events"><CalendarClock size={10} /> {w.events}</span> : null}{due ? <span title="Tasks due">{due} due</span> : null}</span>
      </button>; })}</div>}
    {<div className="dp-daynav">
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
  </div>;
  const dayGrid = <div className={'dp-daycol' + (horiz ? ' horiz' : '')}>{dayHead}<div className={'dp-day' + (horiz ? ' horiz' : '')} ref={dayRef}>
    {!horiz && foldEnd > 0 && <button className="dp-early" onClick={() => { const v = !showEarly; setShowEarly(v); localStorage.setItem('day-early', v ? '1' : ''); }}>
      {showEarly ? <ChevronDown size={13} /> : <ChevronRight size={13} />} 12am to {label(foldEnd)}{earlyBoxes ? ` (${earlyBoxes} box${earlyBoxes === 1 ? '' : 'es'})` : ''}</button>}
    <div className="dp-grid" style={horiz ? {width: (endM - startM) * px + 20} : {height: (endM - startM) * px}} onDragOver={overGrid} onDragLeave={e => { if (!stillIn(e)) setDropGhost(null); }} onDrop={dropAt}
      onMouseDown={e => {
        // Like a calendar: press on an empty time and drag down to make a box. With an editor or a task panel open, a click only closes it.
        if (horiz || e.button !== 0 || !(e.target as HTMLElement).matches('.dp-grid, .dp-slot, .dp-hour, .dp-half, .dp-plan')) return;
        if (editing || document.querySelector('.panel')) { setEditing(null); return; }
        const grid = e.currentTarget, r = grid.getBoundingClientRect();
        const at = (y: number) => Math.max(startM, Math.min(endM, startM + Math.round((y - r.top) / px / snapTo) * snapTo));
        e.preventDefault();
        const a = Math.min(at(e.clientY), endM - snapTo);
        let from = a, to = a + 30, moved = false;
        setGhost({a: from, b: to});
        // Drag down or up from where you pressed; a plain click makes a 30 minute box.
        const move = (ev: MouseEvent) => { const m = at(ev.clientY); if (Math.abs(m - a) >= snapTo) moved = true; if (!moved) return; from = Math.min(a, m); to = Math.max(a + snapTo, m); setGhost({a: from, b: to}); };
        const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); setGhost(null);
          const id = rid(), start = hhmm(from); update(p => ({...p, blocks: [...p.blocks, {id, text: '', start, minutes: Math.max(snapTo, to - from), at: atOf(p.date, start), remind: false}]})); setEditing(id); };
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
      {dayEvents.map(ev => { const lane = lanes.get('ev:' + ev.id) ?? {i: 0, n: 1}; const col = eventColor(store.prefs, ev);
        return <div key={ev.id + ev.start} className="dp-event" style={{...place(ev.s, ev.len, lane), ...(col ? {borderLeftColor: col, background: `color-mix(in srgb, ${col} 18%, var(--card))`} : {})}} title={`${ev.source === 'google' ? 'Google Calendar' : 'Calendar'}: ${ev.title}. Click to open it`}
          onClick={async e => { if ((e.target as HTMLElement).closest('button, a')) return; try { setEvEdit({event: await api<FullEvent>(`/meetings/${ev.occurrenceOf ?? ev.id}`)}); } catch (err) { store.fail(err); } }}>
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
        const bc = b.color ? GCAL_COLORS[b.color]?.[1] : bySpace && it ? spaceColor(store.projects, it.projectId) : undefined;
        return <div key={b.id} data-src={srcOf(b)} data-box={b.id} className={'dp-block' + (done ? ' done' : '') + (running ? ' running' : '') + (bc ? ' colored' : '')} draggable
          onDragStart={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const d: DragData = {from: 'block', id: b.id, itemId: b.itemId, text: b.text, grab: e.clientY - r.top, grabX: e.clientX - r.left}; dragging.current = d; e.dataTransfer.setData('application/x-plan', JSON.stringify(d)); e.dataTransfer.effectAllowed = 'copyMove'; }}
          onDragEnd={() => { dragging.current = null; setDropGhost(null); setWeekGhost(null); }}
          style={{...place(s, b.minutes, lane), ...(bc && !done ? {'--bc': bc} as React.CSSProperties : {})}}
          onClick={e => { if ((e.target as HTMLElement).closest('button, a, .dp-btitle-link')) return; if (it) open(it.id); else setEditing(b.id); }}
          title={it ? 'Click to open the task (notes, status, people). The clock opens this time slot' : 'Click to edit this time slot'}>
          <div className="dp-brow">
            <button className={'check' + (done ? ' on' : '')} onClick={() => toggleEntry(b)}>{done && <CheckIcon size={11} strokeWidth={3} />}</button>
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
  </div></div>;
  // ---- Week: seven days side by side. Drag a box to another day to copy it there (Shift: move); within a day it moves. ----
  const wDays = weekPlans.map(w => ({date: w.date, plan: planOf(w.date)}));
  const wBlocks = wDays.flatMap(w => w.plan?.blocks ?? []);
  const wStart = Math.floor(Math.min(plan.dayStart * 60, ...wBlocks.map(b => mins(b.start))) / 60) * 60;
  const wEnd = Math.min(1440, Math.ceil(Math.max(plan.dayEnd * 60, ...wBlocks.map(b => mins(b.start) + b.minutes)) / 60) * 60);
  const wpx = 0.9 * DENSITY[density];
  const wMinute = (ev: React.DragEvent, d: DragData) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.max(wStart, Math.min(wEnd - 15, wStart + Math.round((ev.clientY - r.top - (d.grab ?? 0)) / wpx / 15) * 15));
  };
  const wLen = (d: DragData) => d.from === 'block' ? planOf(d.day ?? date)?.blocks.find(b => b.id === d.id)?.minutes ?? 30 : lenFor(d);
  const wDrop = (ev: React.DragEvent, day: string) => {
    ev.preventDefault();
    const d = readDrag(ev);
    setWeekGhost(null); dragging.current = null; setDragActive(false);
    if (!d) return;
    const start = hhmm(wMinute(ev, d));
    if (d.from === 'block') { const src = d.day ?? date, b = planOf(src)?.blocks.find(x => x.id === d.id); if (b) void sendBox(src, b, day, start, ev.shiftKey); return; }
    void editDay(day, p => ({...p, blocks: [...p.blocks, {id: rid(), text: d.text, ...(d.itemId ? {itemId: d.itemId} : {}), start, minutes: lenFor(d), at: atOf(day, start), remind: false}]}));
  };
  const openBox = (day: string, b: Block) => { const it = item(b); if (it) { open(it.id); return; } setDate(day); setView('day'); setEditing(b.id); };
  const weekGrid = <div className="dp-daycol dp-weekcol">
    <div className="dp-wk" style={{'--wk-h': `${(wEnd - wStart) * wpx}px`} as React.CSSProperties}>
      <div className="dp-wk-hours">{Array.from({length: (wEnd - wStart) / 60}, (_, k) => <span key={k} style={{top: k * 60 * wpx}}>{label(wStart + k * 60)}</span>)}</div>
      {wDays.map((w, wi) => {
        const p = w.plan, tzz = p?.tz || tz, blocks = p?.blocks ?? [], ln = lanesOf(blocks);
        const evs = weekEvents.filter(e => !blocks.some(b => b.eventId === e.id) && inZone(e.start, tzz).day === w.date);
        const total = blocks.reduce((a, b) => a + b.minutes, 0);
        return <div key={w.date} className={'dp-wk-day' + (w.date === today ? ' today' : '') + (w.date === date ? ' on' : '')}>
          <button className="dp-wk-head" style={{gridColumn: wi + 2}} onClick={() => { setDate(w.date); setView('day'); }} title="Open this day">
            <span>{new Date(`${w.date}T12:00:00`).toLocaleDateString(undefined, {weekday: 'short'})} <b>{Number(w.date.slice(8))}</b></span>
            {total > 0 && <span className="muted small">{fmtM(total)}</span>}</button>
          <div className={'dp-wk-body' + (weekGhost?.date === w.date && weekGhost.m >= 0 ? ' drop-on' : '')} style={{gridColumn: wi + 2}}
            onDragOver={e => { const d = dragging.current; if (!d) return; e.preventDefault(); const m = wMinute(e, d), len = wLen(d); if (weekGhost?.date !== w.date || weekGhost.m !== m || weekGhost.len !== len) setWeekGhost({date: w.date, m, len}); }}
            onDragLeave={e => { if (!stillIn(e)) setWeekGhost(g => g?.date === w.date ? null : g); }}
            onDrop={e => wDrop(e, w.date)}>
            {Array.from({length: (wEnd - wStart) / 60}, (_, k) => <div key={k} className="dp-wk-line" style={{top: k * 60 * wpx}} />)}
            {evs.map(e => { const s = inZone(e.start, tzz).m, len = Math.max(15, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60000));
              return s + len > wStart && s < wEnd ? <div key={e.id + e.start} className="dp-wk-ev" style={{top: (Math.max(s, wStart) - wStart) * wpx, height: Math.max(14, len * wpx - 2)}} title={`Calendar: ${e.title}`}>{e.title}</div> : null; })}
            {w.date === today && nowMin >= wStart && nowMin <= wEnd && <div className="dp-wk-now" style={{top: (nowMin - wStart) * wpx}} />}
            {weekGhost?.date === w.date && weekGhost.m >= 0 && <div className="dp-ghost drop" style={{top: (weekGhost.m - wStart) * wpx, height: weekGhost.len * wpx}}>{label(weekGhost.m)}</div>}
            {p && blocks.map(b => {
              const s = mins(b.start), it = item(b), done = entryDone(p, b, tinfo), lane = ln.get(b.id) ?? {i: 0, n: 1};
              const bc = b.color ? GCAL_COLORS[b.color]?.[1] : bySpace && it ? spaceColor(store.projects, it.projectId) : undefined;
              return <div key={b.id} className={'dp-wk-box' + (done ? ' done' : '') + (bc ? ' colored' : '')} draggable
                style={{top: (Math.max(s, wStart) - wStart) * wpx, height: Math.max(16, b.minutes * wpx - 2), left: `calc(${lane.i / lane.n * 100}% + 2px)`, width: `calc(${100 / lane.n}% - 4px)`, ...(bc && !done ? {'--bc': bc} as React.CSSProperties : {})}}
                onDragStart={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const d: DragData = {from: 'block', id: b.id, itemId: b.itemId, text: b.text, grab: e.clientY - r.top, day: w.date}; dragging.current = d; e.dataTransfer.setData('application/x-plan', JSON.stringify(d)); e.dataTransfer.effectAllowed = 'copyMove'; }}
                onDragEnd={() => { dragging.current = null; setWeekGhost(null); }}
                onClick={e => { if (!(e.target as HTMLElement).closest('button')) openBox(w.date, b); }}
                title={`${it?.title ?? b.text} ${label(s)} to ${label(s + b.minutes)}. Drag to another day to copy it there; hold Shift to move it`}>
                <button className={'check' + (done ? ' on' : '')} onClick={() => void checkOn(w.date, b)} title={done ? 'Mark not done' : 'Mark done'}>{done && <CheckIcon size={10} strokeWidth={3} />}</button>
                <span className="dp-wk-title">{it ? <><span className="dp-key">{itemKey(it, store.projects)}</span> {it.title}</> : b.text || <span className="muted">(untitled)</span>}</span>
                {b.minutes * wpx >= 30 && <span className="dp-wk-time">{label(s)}</span>}
              </div>; })}
          </div>
        </div>; })}
    </div>
    <p className="muted small dp-hint">Drag a box to another day to copy it there; hold Shift while dropping to move it. Drag lines and tasks from the left onto any day.</p>
  </div>;
  const sorted = [...plan.blocks].sort((a, b) => mins(a.start) - mins(b.start));
  // Focus: what is on now, and what is next.
  const curB = sorted.find(b => nowM !== null && nowM >= mins(b.start) && nowM < mins(b.start) + b.minutes);
  const nextB = sorted.find(b => nowM !== null && mins(b.start) > nowM && !isDone(b));
  const nowCard = <div className="dp-nowcard">
    <span className="muted small">{curB ? 'Now' : 'Nothing boxed right now'}</span>
    {curB && <><div className="dp-nowtitle">{item(curB)?.title ?? curB.text}</div>
      <div className="muted">{label(mins(curB.start))} to {label(mins(curB.start) + curB.minutes)} · {Math.max(0, mins(curB.start) + curB.minutes - (nowM ?? 0))} min left</div>
      <div className="row"><button className="btn small" onClick={() => toggleEntry(curB)}><CheckIcon size={12} /> {isDone(curB) ? 'Not done' : 'Done'}</button>
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
        if (tsEdit === t.id) return <TimeEntryEdit key={t.id} entry={t} onDone={saved => { setTsEdit(null); if (saved) api<TimeEntry[]>(`/time?person=${me}&tz=${encodeURIComponent(browserTz())}`).then(setTime).catch(() => {}); }} />;
        return <div key={t.id} className={'dp-tsrow' + (!t.end ? ' running' : '')} onDoubleClick={() => setTsEdit(t.id)}>
          <span className="dp-tstime" title={timed || !t.end ? '' : 'Added as minutes, with no start and stop time'}>{!t.end ? `${label(s)} to now` : timed ? `${label(s)} to ${label(inZone(t.end, tz).m)}` : 'added by hand'}</span>
          <button className="dp-text link" onClick={() => open(t.itemId)}>{it ? <><span className="dp-key">{itemKey(it, store.projects)}</span> {it.title}</> : 'A task'}</button>
          <span className="muted small">{fmtM(entryMin(t))}</span>
          <button className="icon" title={t.end ? 'Edit this entry: day, start, end, notes' : 'Edit when this timer started'} onClick={() => setTsEdit(t.id)}><Pencil size={11} /></button>
        </div>; })}
      {loggedBy.length > 1 && <div className="dp-tstotals small muted">{loggedBy.map(([iid, m]) => { const it = store.items.get(iid); return <span key={iid}>{it ? itemKey(it, store.projects) : 'Task'} {fmtM(m)}</span>; })}</div>}
    </>}
    <a className="small" href="#/timesheet">Week timesheet</a>
  </section>;
  const eb = editing ? plan.blocks.find(b => b.id === editing) : undefined;
  const openCalendar = async (b: Block) => {
    if (b.eventId) { try { setEvEdit({event: await api<FullEvent>(`/meetings/${b.eventId}`), boxId: b.id}); return; } catch { /* the event is gone: make a new one */ } }
    const it = item(b), s0 = new Date(b.at ?? atOf(date, b.start));
    setEvEdit({boxId: b.id, draft: {color: b.color ?? null, title: it?.title ?? b.text, start: s0.toISOString(), end: new Date(s0.getTime() + b.minutes * 60000).toISOString(), itemId: b.itemId ?? null,
      body: [b.note, ...(b.links ?? []).map(id => store.items.get(id)).filter(Boolean).map(x => `- ${itemKey(x!, store.projects)} ${x!.title}`)].filter(Boolean).join('\n')}});
  };
  const editor = eb && <BoxEditor key={eb.id} store={store} b={eb} date={date} space={space} open={open} onCalendar={() => openCalendar(eb)}
    patch={p => patchBlock(eb.id, p)} remove={() => { removeBlock(eb.id); setEditing(null); }} close={() => setEditing(null)} />;
  const fold = (k: string, title: string, body: React.ReactNode) => <details open={isOpen(k)} onToggle={e => { const v = (e.currentTarget as HTMLDetailsElement).open; if (v !== isOpen(k)) setOpen(k, v); }}><summary>{title}</summary>{body}</details>;

  // Three views, same features: Focus (lists left, day right), Three columns, and Timeline across.
  const lists = {
    top: fold('top', 'Top 3', topSec),
    dump: fold('dump', `Brain dump (${plan.dump.filter(e => !isDone(e)).length})`, dumpSec),
    mine: fold('mine', `Assigned (${mine.length})`, mineSec),
    logged: fold('logged', 'Timesheet for the day', loggedSec),
  };
  const splitL = <div className="dp-split" title="Drag to resize; double-click to reset" onMouseDown={leftDrag} onDoubleClick={leftReset} />;
  const splitR = <div className="dp-split" title="Drag to resize; double-click to reset" onMouseDown={rightDrag} onDoubleClick={rightReset} />;
  const centre = view === 'week' ? weekGrid : dayGrid;
  let body;
  switch (D.id) {
    case 'columns': body = <div className="dp-main"><div className="dp-left" style={{width: leftW}}>{nowCard}{lists.top}{lists.dump}</div>{splitL}{centre}{splitR}<div className="dp-left right" style={{width: rightW}}>{lists.mine}{lists.logged}</div></div>; break;
    case 'horizontal': body = <div className="dp-main col">{centre}<div className="dp-split row" title="Drag to resize; double-click to reset" onMouseDown={bottomDrag} onDoubleClick={bottomReset} /><div className="dp-row3" style={{height: bottomH, flex: 'none'}}><div>{nowCard}{lists.top}</div><div>{lists.dump}</div><div>{lists.mine}{lists.logged}</div></div></div>; break;
    default: body = <div className="dp-main"><div className="dp-left" style={{width: leftW}}>{nowCard}{lists.top}{lists.dump}{lists.mine}{lists.logged}</div>{splitL}{centre}</div>;
  }
  const evModal = evEdit && <EventEditor store={store} event={evEdit.event} draft={evEdit.draft} items={[...store.items.values()]} open={open}
    onSaved={r => { if (evEdit.boxId) patchBlock(evEdit.boxId, {eventId: r.id}); }} onClose={() => { setEvEdit(null); load(); }} />;
  return <div className={`dp d-${D.id}${bySource ? ' by-source' : ''}`}>{head}{body}{editor}{evModal}</div>;
}

type Density = 'compact' | 'normal' | 'roomy';

/** A panel size you set by dragging its edge, kept per browser. sign: +1 grows when dragged right or down, -1 when left or up. */
function usePanelSize(key: string, initial: number, min: number, max: number, sign: 1 | -1, vertical = false) {
  const [size, setSize] = useState(() => { const v = Number(localStorage.getItem(key)); return v >= min && v <= max ? v : initial; });
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const from = vertical ? e.clientY : e.clientX, base = size;
    let last = base;
    const move = (m: MouseEvent) => { last = Math.max(min, Math.min(max, base + sign * ((vertical ? m.clientY : m.clientX) - from))); setSize(last); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('dp-resizing'); localStorage.setItem(key, String(Math.round(last))); };
    document.body.classList.add('dp-resizing');
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  const reset = () => { setSize(initial); localStorage.removeItem(key); };
  return [size, start, reset] as const;
}
const DENSITY: Record<Density, number> = {compact: 0.75, normal: 1, roomy: 1.4};
/** Ten ways to lay out and style the planner. Same data; pick one in the header. */
export const DESIGNS: {id: string; name: string; hint: string; px?: number}[] = [
  {id: 'focus', name: 'Focus', hint: 'Now and next, your lists on the left, the day on the right'},
  {id: 'columns', name: 'Three columns', hint: 'Top 3 and dump, the day, then assigned work and the timesheet'},
  {id: 'horizontal', name: 'Timeline across', hint: 'Hours run left to right; your lists underneath', px: 3.4},
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
/** The first reminder you set asks the browser once for permission to show alerts on this computer. */
function askNotify() {
  try { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* not supported */ }
}

function BoxEditor({store, b, date, space, open, patch, remove, close, onCalendar}: {store: Store; b: Block; date: string; space: string; open: (id: string) => void; patch: (p: Partial<Block>) => void; remove: () => void; close: () => void; onCalendar: () => void}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const it = b.itemId ? store.items.get(b.itemId) : undefined;
  const found = q.trim().length < 2 ? [] : [...store.items.values()].filter(i => !i.recur?.spawned && i.id !== b.itemId && !(b.links ?? []).includes(i.id) &&
    (itemKey(i, store.projects).toLowerCase() === q.trim().toLowerCase() || i.title.toLowerCase().includes(q.trim().toLowerCase()))).sort((a, c) => Number(!!a.completed) - Number(!!c.completed)).slice(0, 8);
  const s = mins(b.start);
  const [title, setTitle] = useState(it?.title ?? b.text);
  // Not a task yet: the closest existing tasks by the box's title, or a search, to make this box that task.
  const [asQ, setAsQ] = useState('');
  const asFound = it ? [] : [...store.items.values()].filter(i => !i.recur?.spawned && !i.completed)
    .map(i => ({i, score: asQ.trim().length >= 2 ? (itemKey(i, store.projects).toLowerCase() === asQ.trim().toLowerCase() ? 2 : i.title.toLowerCase().includes(asQ.trim().toLowerCase()) ? 1 : 0) : matchScore(title, i.title, itemKey(i, store.projects))}))
    .filter(x => x.score >= (asQ.trim().length >= 2 ? 1 : 0.45)).sort((x, y) => y.score - x.score).slice(0, 5).map(x => x.i);
  const useTask = (x: Item) => {
    patch({itemId: x.id, text: x.title, links: (b.links ?? []).filter(y => y !== x.id)});
    setTitle(x.title); setAsQ('');
    const p: Partial<Item> = {};
    if (!x.assignees.includes(store.me)) p.assignees = [...x.assignees, store.me];
    if (!x.due) p.due = date;
    if (Object.keys(p).length) store.updateItem(x.id, p);
  };
  const makeTask = async () => {
    const pid = realProjects(store.projects).find(p => p.id === space)?.id ?? realProjects(store.projects)[0]?.id;
    if (!pid || !title.trim()) return;
    const made = await store.quickAdd(pid, title.trim());
    if (made) { if (!made.assignees.length) store.updateItem(made.id, {assignees: [store.me]}); patch({itemId: made.id, text: made.title}); }
  };
  return <div className="dp-editor" onMouseDown={e => e.stopPropagation()}>
    <div className="row"><b className="grow">Time box</b><button className="icon" onClick={close} title="Close"><X size={14} /></button></div>
    <input className="plain-input dp-etitle" autoFocus={!it} placeholder="What is it? (Lunch, Call Tim, Team meeting)" value={title}
      onChange={e => { setTitle(e.target.value); if (!it) patch({text: e.target.value}); }}
      onBlur={e => { const v = e.target.value.trim(); if (it && v && v !== it.title) store.updateItem(it.id, {title: v}); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    <div className="row"><span className="muted small">Color</span>
      <button className={'ev-color' + (!b.color ? ' on' : '')} title="Default" onClick={() => patch({color: null})} style={{background: 'var(--accent)'}} />
      {Object.entries(GCAL_COLORS).map(([id, [name, hex]]) => <button key={id} className={'ev-color' + (b.color === id ? ' on' : '')} title={name} onClick={() => patch({color: id})} style={{background: hex}} />)}
    </div>
    {it && <div className="row"><button className="btn ghost small" onClick={() => open(it.id)} title="Open the full task"><span className="dp-key">{itemKey(it, store.projects)}</span> Open task</button>
      <button className="btn ghost small" title="Keep the box, no longer as this task (the task stays)" onClick={() => patch({itemId: undefined, text: it.title})}><X size={12} /> Not this task</button></div>}
    {!it && <div className="dp-field"><span className="muted small">Is this box an existing task? Pick it to make the box that task</span>
      <input className="plain-input" placeholder="Search tasks: key or title" value={asQ} onChange={e => setAsQ(e.target.value)} />
      {asFound.map(x => <button key={x.id} className="pop-row small" onClick={() => useTask(x)}><GitMerge size={11} /> {itemKey(x, store.projects)} {x.title}</button>)}
      {!asFound.length && <span className="muted small">{asQ.trim().length >= 2 ? 'No task found.' : 'No close task. Search, or Make it a task below.'}</span>}
    </div>}
    <div className="row">
      <input type="time" className="plain-input" value={b.start} step={300} onChange={e => e.target.value && patch({start: e.target.value, at: new Date(`${date}T${e.target.value}:00`).toISOString()})} />
      <select className="plain-select" value={b.minutes} onChange={e => patch({minutes: Number(e.target.value)})}>{[15, 30, 45, 60, 90, 120, 180, 240].concat(b.minutes).filter((v, i, a) => a.indexOf(v) === i).sort((x, y) => x - y).map(v => <option key={v} value={v}>{v < 60 ? `${v} min` : `${v / 60} h`}</option>)}</select>
      <span className="muted small">to {label(s + b.minutes)}</span>
    </div>
    {b.planned && <div className="row small muted">Planned {label(mins(b.planned.start))} for {b.planned.minutes} min
      <button className="btn ghost small" onClick={() => patch({start: b.planned!.start, minutes: b.planned!.minutes, at: new Date(`${date}T${b.planned!.start}:00`).toISOString(), planned: null, fitted: false})}><Undo2 size={12} /> Back to plan</button></div>}
    <label className="row small" title="A notification in Cadence, and on this computer or phone when notifications are on (Team page, My account)"><BellRing size={12} /> Remind me
      <select className="plain-select" value={b.remind ? String(b.remindBefore ?? 0) : 'off'} onChange={e => { const v = e.target.value; patch(v === 'off' ? {remind: false} : {remind: true, remindBefore: Number(v), at: new Date(`${date}T${b.start}:00`).toISOString()}); askNotify(); }}>
        <option value="off">Off</option>
        {[0, 5, 10, 15, 30, 60, 120, 1440].map(m => <option key={m} value={m}>{m === 0 ? 'When it starts' : m === 1440 ? '1 day before' : m >= 60 ? `${m / 60} hour${m > 60 ? 's' : ''} before` : `${m} minutes before`}</option>)}
      </select></label>
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
      {!it && <button className="btn small" disabled={!title.trim()} onClick={makeTask} title="Make this box a task (quick-add works)"><ListPlus size={12} /> Make it a task</button>}
      <button className="btn small" onClick={onCalendar} title="The full calendar editor: guests, Google Meet link, repeats, color, and Open in Google Calendar">{b.eventId ? <><CalendarClock size={12} /> Calendar event</> : <><CalendarPlus size={12} /> Add to calendar</>}</button>
      <span className="spacer" />
      <button className="btn small danger" onClick={remove}><Trash2 size={12} /> Remove</button>
    </div>
  </div>;
}
