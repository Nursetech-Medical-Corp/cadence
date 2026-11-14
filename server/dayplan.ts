// Day planner: one page per person per day to get out of overwhelm.
// Top 3 priorities, a brain dump, and time boxes laid on the day like a calendar. Entries can be plain text or
// real tasks. Time boxes can carry a reminder that goes to the person's phone and desktop at its start.
import {randomBytes} from 'node:crypto';
import type {Tasks} from './service.ts';
import {Invalid} from './errors.ts';
import type {Item} from '../src/types.ts';
import {calendarSettings, listEvents, localDay, localTime, validTz, zoned} from './events.ts';

/** A line of the plan: plain text, or a task (itemId). done is only used for plain text; tasks are done when completed. */
export type Entry = {id: string; text: string; itemId?: string | null; done?: boolean};
/** A time box: start "HH:MM" on the plan's day, minutes long. at is the same moment as an ISO time (set by the app, which knows the time zone). */
export type Block = Entry & {start: string; minutes: number; at?: string | null; remind?: boolean; notified?: boolean;
  /** Tasks tied to this box: done in it or to discuss in it (a meeting, a call). */
  links?: string[];
  /** The calendar event this box stands for (Cadence or synced Google event). */
  eventId?: string | null;
  note?: string;
  /** Where the box was planned before it was fitted to logged time, so the plan stays visible and can come back. */
  planned?: {start: string; minutes: number} | null;
  /** Fitted to time logged with timers. */
  fitted?: boolean};
/** tz: the time zone the day is planned in (IANA, like America/Denver). Box times are wall-clock times there. */
export type DayPlan = {person: string; date: string; top: Entry[]; dump: Entry[]; blocks: Block[]; dayStart: number; dayEnd: number; slot: number; tz: string; updated: string | null};

const rid = () => randomBytes(5).toString('hex');
const migrated = new WeakSet<object>();
export function migrateDayPlans(tasks: Tasks) {
  if (migrated.has(tasks.db)) return;
  tasks.db.exec('create table if not exists day_plans (person text not null, date text not null, data text not null, updated text not null, primary key (person, date))');
  migrated.add(tasks.db);
}
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A time written in a line, like "2PM meeting", "call at 9:30am" or "14:00 standup", in minutes from midnight. */
export function timeIn(text: string): number | null {
  const m = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i.exec(text);
  if (m) return (Number(m[1]) % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0)) * 60 + Number(m[2] ?? 0);
  const h = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  return h ? Number(h[1]) * 60 + Number(h[2]) : null;
}
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** hintTz: where the person is now (their browser); a day not saved yet takes it, before the calendar settings' zone. */
export function getDayPlan(tasks: Tasks, person: string, date: string, hintTz?: string): DayPlan {
  migrateDayPlans(tasks);
  if (!DATE.test(date)) throw new Invalid('Date must look like 2026-11-14');
  tasks.person(person);
  const r = tasks.db.prepare('select data, updated from day_plans where person = ? and date = ?').get(person, date) as {data: string; updated: string} | undefined;
  const d = r ? JSON.parse(r.data) : {};
  // New days start from the person's working hours and time zone (Team page, calendar settings).
  let cs: {workStart: string; workEnd: string; tz: string};
  try { cs = calendarSettings(tasks, person); } catch { cs = {workStart: '09:00', workEnd: '17:00', tz: 'UTC'}; }
  const hour = (t: string, up = false) => { const m = mins(t); return Math.min(24, Math.max(0, up ? Math.ceil(m / 60) : Math.floor(m / 60))); };
  return {person, date, top: d.top ?? [], dump: d.dump ?? [], blocks: d.blocks ?? [], dayStart: d.dayStart ?? hour(cs.workStart), dayEnd: d.dayEnd ?? Math.max(hour(cs.workStart) + 1, hour(cs.workEnd, true)),
    slot: d.slot ?? 30, tz: d.tz ?? (hintTz && validTz(hintTz) ? hintTz : cs.tz), updated: r?.updated ?? null};
}

function cleanEntry(tasks: Tasks, e: Partial<Entry>, allowEmpty = false): Entry {
  if (!e || typeof e !== 'object') throw new Invalid('Each entry must be an object');
  const out: Entry = {id: typeof e.id === 'string' && e.id ? e.id.slice(0, 40) : rid(), text: String(e.text ?? '').slice(0, 500)};
  if (e.itemId) { const it = tasks.findItem(e.itemId); out.itemId = it.id; if (!out.text) out.text = it.title; }
  if (!out.text && !out.itemId && !allowEmpty) throw new Invalid('An entry needs text or a task');
  if (e.done) out.done = true;
  return out;
}
export type DayPatch = Partial<Pick<DayPlan, 'top' | 'dump' | 'blocks' | 'dayStart' | 'dayEnd' | 'slot' | 'tz'>>;
export function updateDayPlan(tasks: Tasks, person: string, date: string, patch: DayPatch): DayPlan {
  const cur = getDayPlan(tasks, person, date);
  const next = {...cur};
  if (patch.tz !== undefined) { if (!validTz(String(patch.tz))) throw new Invalid(`Unknown time zone ${patch.tz}`); next.tz = String(patch.tz); }
  // The moment each box starts, from its wall-clock time in the plan's zone (daylight saving included).
  const [y, mo, da] = date.split('-').map(Number);
  const momentOf = (start: string) => zoned(y, mo, da, Number(start.slice(0, 2)), Number(start.slice(3, 5)), next.tz).toISOString();
  if (patch.top !== undefined) { if (!Array.isArray(patch.top) || patch.top.length > 3) throw new Invalid('Top priorities hold up to 3'); next.top = patch.top.map(e => cleanEntry(tasks, e)); }
  if (patch.dump !== undefined) { if (!Array.isArray(patch.dump) || patch.dump.length > 300) throw new Invalid('The brain dump holds up to 300 lines'); next.dump = patch.dump.map(e => cleanEntry(tasks, e)); }
  if (patch.blocks !== undefined) {
    if (!Array.isArray(patch.blocks) || patch.blocks.length > 200) throw new Invalid('A day holds up to 200 time boxes');
    next.blocks = patch.blocks.map(b => {
      const e = cleanEntry(tasks, b, true);
      if (!TIME.test(String(b.start))) throw new Invalid('Time boxes start at a time like 09:30');
      const minutes = Math.round(Number(b.minutes));
      if (!(minutes >= 5 && minutes <= 24 * 60)) throw new Invalid('A time box is 5 minutes to 24 hours');
      if (b.at && Number.isNaN(Date.parse(b.at))) throw new Invalid('at must be an ISO time');
      const old = cur.blocks.find(x => x.id === e.id);
      // Moving a box or changing its reminder arms the reminder again.
      const notified = !!old?.notified && old.start === b.start && old.at === momentOf(b.start) && !!b.remind;
      const links = Array.isArray(b.links) ? [...new Set(b.links.slice(0, 50).map(x => tasks.findItem(String(x)).id))] : [];
      return {...e, start: b.start, minutes, at: momentOf(b.start), remind: !!b.remind, ...(notified ? {notified: true} : {}),
        ...(links.length ? {links} : {}), ...(b.eventId ? {eventId: String(b.eventId).slice(0, 200)} : {}), ...(b.note ? {note: String(b.note).slice(0, 5000)} : {}),
        ...(b.planned && TIME.test(String(b.planned.start)) && Number(b.planned.minutes) > 0 ? {planned: {start: b.planned.start, minutes: Math.round(Number(b.planned.minutes))}} : {}), ...(b.fitted ? {fitted: true} : {})};
    });
  }
  if (patch.dayStart !== undefined || patch.dayEnd !== undefined) {
    const s = Math.round(Number(patch.dayStart ?? cur.dayStart)), e = Math.round(Number(patch.dayEnd ?? cur.dayEnd));
    if (!(s >= 0 && e <= 24 && s < e)) throw new Invalid('The day runs from an hour 0 to 23 to a later hour up to 24');
    next.dayStart = s; next.dayEnd = e;
  }
  if (patch.slot !== undefined) { if (![15, 30, 60].includes(Number(patch.slot))) throw new Invalid('Slots are 15, 30 or 60 minutes'); next.slot = Number(patch.slot); }
  const updated = new Date().toISOString();
  tasks.db.prepare('insert into day_plans (person, date, data, updated) values (?,?,?,?) on conflict(person, date) do update set data = excluded.data, updated = excluded.updated')
    .run(person, date, JSON.stringify({top: next.top, dump: next.dump, blocks: next.blocks.map(b => ({...b, at: momentOf(b.start)})), dayStart: next.dayStart, dayEnd: next.dayEnd, slot: next.slot, tz: next.tz}), updated);
  tasks.emit({kind: 'dayplan', person});
  return {...next, blocks: next.blocks.map(b => ({...b, at: momentOf(b.start)})), updated};
}

/**
 * Fill the day from a time on: top 3 first, then tasks due today and overdue, then the brain dump, each in the
 * next free gap. Uses each task's estimate (30 minutes when it has none). Things already boxed or done are skipped.
 * Without from: today starts now (in the plan's time zone), any other day at the start of the planning hours.
 * Meetings and other calendar events on the day are left free.
 */
export function autoSchedule(tasks: Tasks, person: string, date: string, opts: {from?: string; offsetMinutes?: number; include?: ('top' | 'due' | 'dump')[]} = {}): DayPlan {
  const plan = getDayPlan(tasks, person, date);
  const nowHere = localTime(new Date(), plan.tz);
  const from = opts.from && TIME.test(opts.from) ? mins(opts.from) : localDay(new Date(), plan.tz) === date ? nowHere.minutes : plan.dayStart * 60;
  const start = Math.max(plan.dayStart * 60, Math.ceil(from / plan.slot) * plan.slot), end = plan.dayEnd * 60;
  const include = new Set(opts.include ?? ['top', 'due', 'dump']);
  const isDone = (e: Entry) => { if (e.itemId) { try { return !!tasks.item(e.itemId).completed; } catch { return true; } } return !!e.done; };
  const boxed = new Set(plan.blocks.flatMap(b => b.itemId ? [b.itemId, b.text.toLowerCase()] : [b.text.toLowerCase()]));
  const want: Entry[] = [];
  const addIf = (e: Entry) => { if (isDone(e) || (e.itemId ? boxed.has(e.itemId) : boxed.has(e.text.toLowerCase())) || want.some(w => (e.itemId && w.itemId === e.itemId) || w.text.toLowerCase() === e.text.toLowerCase())) return; want.push(e); };
  if (include.has('top')) plan.top.forEach(addIf);
  if (include.has('due')) { const w = tasks.myWork(person); [...w.overdue, ...w.today].forEach((i: Item) => addIf({id: rid(), text: i.title, itemId: i.id})); }
  if (include.has('dump')) plan.dump.forEach(addIf);
  const busy = plan.blocks.map(b => [mins(b.start), mins(b.start) + b.minutes] as const);
  // Calendar events that day (meetings, synced Google events) are busy too, unless a box already stands for them.
  try {
    const tied = new Set(plan.blocks.map(b => b.eventId).filter(Boolean));
    for (const ev of listEvents(tasks, {from: date, to: date, person, mine: true})) {
      if (ev.allDay || tied.has(ev.id) || localDay(ev.start, plan.tz) !== date) continue;
      const s = localTime(ev.start, plan.tz).minutes;
      busy.push([s, s + Math.round((Date.parse(ev.end) - Date.parse(ev.start)) / 60000)]);
    }
  } catch { /* no calendar */ }
  const free = (s: number, len: number) => s + len <= end && busy.every(([a, b]) => s + len <= a || s >= b);
  const blocks = [...plan.blocks];
  // Lines that name a time ("2PM meeting") go at that time first, if it is free and later than now.
  for (const e of [...want]) {
    const t = e.itemId ? null : timeIn(e.text);
    if (t === null || t < start || !free(t, 30)) continue;
    const at = null;
    blocks.push({id: rid(), text: e.text, start: hhmm(t), minutes: 30, at, remind: false});
    busy.push([t, t + 30]);
    want.splice(want.indexOf(e), 1);
  }
  for (const e of want) {
    let len = 30;
    if (e.itemId) { try { const est = tasks.item(e.itemId).estimate; if (est) len = Math.max(plan.slot, Math.min(240, Math.round(est * 60 / plan.slot) * plan.slot)); } catch { /* gone */ } }
    let s = start;
    while (s < end && !free(s, len)) s += plan.slot;
    if (s >= end) break;
    const at = null;
    blocks.push({id: rid(), text: e.text, ...(e.itemId ? {itemId: e.itemId} : {}), start: hhmm(s), minutes: len, at, remind: false});
    busy.push([s, s + len]);
  }
  return updateDayPlan(tasks, person, date, {blocks});
}

/** Every minute: time boxes with a reminder whose start has come (within the last 15 minutes) tell their person once. */
export function dayPlanReminders(tasks: Tasks, now = new Date()) {
  migrateDayPlans(tasks);
  const day = (d: number) => new Date(now.getTime() + d * 86400_000).toISOString().slice(0, 10);
  const rows = tasks.db.prepare('select person, date, data from day_plans where date between ? and ?').all(day(-1), day(1)) as {person: string; date: string; data: string}[];
  for (const r of rows) {
    const d = JSON.parse(r.data) as {blocks?: Block[]};
    let changed = false;
    for (const b of d.blocks ?? []) {
      if (!b.remind || b.notified || !b.at) continue;
      const t = Date.parse(b.at);
      if (t > now.getTime() || now.getTime() - t > 15 * 60_000) continue;
      b.notified = true; changed = true;
      tasks.notifyPublic(r.person, null, b.itemId ?? null, 'reminder', `Now (${b.start}, ${b.minutes} min): ${b.text}`);
    }
    if (changed) tasks.db.prepare('update day_plans set data = ? where person = ? and date = ?').run(JSON.stringify(d), r.person, r.date);
  }
}

/**
 * Fit the day to what was really done: each box for a task moves to the time logged on it (timers), up to a cutoff
 * (now, at midday, to see the morning) or the whole day. Separate sessions of one task become separate boxes. Work
 * logged with no box gets a box. The planned time is kept on the box (planned) so the plan still shows.
 * Logged times are read on the plan's clock (its time zone).
 */
export function fitToLogged(tasks: Tasks, person: string, date: string, opts: {upTo?: string | null; offsetMinutes?: number} = {}) {
  const plan = getDayPlan(tasks, person, date);
  const local = (iso: string) => ({day: localDay(iso, plan.tz), m: localTime(iso, plan.tz).minutes});
  const cut = opts.upTo ? Date.parse(opts.upTo) : Infinity;
  if (opts.upTo && Number.isNaN(cut)) throw new Invalid('upTo must be a time');
  const entries = tasks.listTime({person}).filter(e => e.kind !== 'review' && local(e.start).day === date && Date.parse(e.start) < cut);
  // Sessions per task: timed entries (start to end, a running one to now), joined when less than 10 minutes apart.
  const sessions = new Map<string, {s: number; e: number}[]>();
  const loggedOnly = new Map<string, number>();
  for (const e of entries) {
    const end = Math.min(e.end ? Date.parse(e.end) : Date.now(), cut);
    if (end - Date.parse(e.start) < 60_000) { if (e.minutes) loggedOnly.set(e.itemId, (loggedOnly.get(e.itemId) ?? 0) + e.minutes); continue; }
    const s = local(e.start).m, m = s + Math.round((end - Date.parse(e.start)) / 60_000);
    sessions.set(e.itemId, [...(sessions.get(e.itemId) ?? []), {s, e: Math.min(m, 24 * 60)}]);
  }
  for (const [k, list] of sessions) {
    list.sort((a, b) => a.s - b.s);
    const merged: {s: number; e: number}[] = [];
    for (const x of list) { const last = merged[merged.length - 1]; if (last && x.s - last.e < 10) last.e = Math.max(last.e, x.e); else merged.push({...x}); }
    sessions.set(k, merged);
  }
  const r5 = (m: number) => Math.round(m / 5) * 5;
  const atOf = (_m: number) => null;
  let blocks = [...plan.blocks];
  let moved = 0, added = 0;
  const ids = new Set([...sessions.keys(), ...loggedOnly.keys()]);
  for (const itemId of ids) {
    const mine = blocks.filter(b => b.itemId === itemId).sort((a, b) => mins(a.start) - mins(b.start));
    const ss = sessions.get(itemId) ?? [];
    const fit = (b: Block, s: number, len: number): Block => ({...b, planned: b.planned ?? {start: b.start, minutes: b.minutes}, start: hhmm(Math.min(r5(s), 24 * 60 - 5)), minutes: Math.max(5, r5(len)), at: atOf(r5(s)), fitted: true, notified: true});
    if (!ss.length) {
      // Logged as minutes only: the box keeps its time and takes the logged length.
      const total = loggedOnly.get(itemId)!;
      if (mine[0]) { blocks = blocks.map(b => b.id === mine[0].id ? fit(b, mins(b.start), total) : b); moved++; }
      continue;
    }
    ss.forEach((x, i) => {
      const b = mine[i];
      if (b) { blocks = blocks.map(y => y.id === b.id ? fit(y, x.s, x.e - x.s) : y); moved++; }
      else {
        let title = 'Logged work';
        try { title = tasks.item(itemId).title; } catch { /* task deleted */ }
        blocks.push({id: rid(), text: title, itemId, start: hhmm(Math.min(r5(x.s), 24 * 60 - 5)), minutes: Math.max(5, r5(x.e - x.s)), at: atOf(r5(x.s)), remind: false, notified: true, fitted: true, planned: null});
        added++;
      }
    });
  }
  const loggedMin = [...sessions.values()].flat().reduce((a, x) => a + x.e - x.s, 0) + [...loggedOnly.values()].reduce((a, x) => a + x, 0);
  const cutM = opts.upTo ? local(opts.upTo).m : 24 * 60;
  const plannedMin = plan.blocks.reduce((a, b) => { const s = mins((b.planned ?? b).start), e = s + (b.planned ?? b).minutes; return a + Math.max(0, Math.min(e, cutM) - s); }, 0);
  const next = updateDayPlan(tasks, person, date, {blocks});
  return {plan: next, summary: {plannedMinutes: plannedMin, loggedMinutes: loggedMin, moved, added, upTo: opts.upTo ?? null}};
}
