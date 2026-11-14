// Day planner: one page per person per day to get out of overwhelm.
// Top 3 priorities, a brain dump, and time boxes laid on the day like a calendar. Entries can be plain text or
// real tasks. Time boxes can carry a reminder that goes to the person's phone and desktop at its start.
import {randomBytes} from 'node:crypto';
import type {Tasks} from './service.ts';
import {Invalid} from './errors.ts';
import type {Item} from '../src/types.ts';

/** A line of the plan: plain text, or a task (itemId). done is only used for plain text; tasks are done when completed. */
export type Entry = {id: string; text: string; itemId?: string | null; done?: boolean};
/** A time box: start "HH:MM" on the plan's day, minutes long. at is the same moment as an ISO time (set by the app, which knows the time zone). */
export type Block = Entry & {start: string; minutes: number; at?: string | null; remind?: boolean; notified?: boolean;
  /** Tasks tied to this box: done in it or to discuss in it (a meeting, a call). */
  links?: string[];
  /** The calendar event this box stands for (Cadence or synced Google event). */
  eventId?: string | null;
  note?: string};
export type DayPlan = {person: string; date: string; top: Entry[]; dump: Entry[]; blocks: Block[]; dayStart: number; dayEnd: number; slot: number; updated: string | null};

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

export function getDayPlan(tasks: Tasks, person: string, date: string): DayPlan {
  migrateDayPlans(tasks);
  if (!DATE.test(date)) throw new Invalid('Date must look like 2026-11-14');
  tasks.person(person);
  const r = tasks.db.prepare('select data, updated from day_plans where person = ? and date = ?').get(person, date) as {data: string; updated: string} | undefined;
  const d = r ? JSON.parse(r.data) : {};
  return {person, date, top: d.top ?? [], dump: d.dump ?? [], blocks: d.blocks ?? [], dayStart: d.dayStart ?? 6, dayEnd: d.dayEnd ?? 22, slot: d.slot ?? 30, updated: r?.updated ?? null};
}

function cleanEntry(tasks: Tasks, e: Partial<Entry>, allowEmpty = false): Entry {
  if (!e || typeof e !== 'object') throw new Invalid('Each entry must be an object');
  const out: Entry = {id: typeof e.id === 'string' && e.id ? e.id.slice(0, 40) : rid(), text: String(e.text ?? '').slice(0, 500)};
  if (e.itemId) { const it = tasks.findItem(e.itemId); out.itemId = it.id; if (!out.text) out.text = it.title; }
  if (!out.text && !out.itemId && !allowEmpty) throw new Invalid('An entry needs text or a task');
  if (e.done) out.done = true;
  return out;
}
export type DayPatch = Partial<Pick<DayPlan, 'top' | 'dump' | 'blocks' | 'dayStart' | 'dayEnd' | 'slot'>>;
export function updateDayPlan(tasks: Tasks, person: string, date: string, patch: DayPatch): DayPlan {
  const cur = getDayPlan(tasks, person, date);
  const next = {...cur};
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
      const notified = !!old?.notified && old.start === b.start && old.at === (b.at ?? null) && !!b.remind;
      const links = Array.isArray(b.links) ? [...new Set(b.links.slice(0, 50).map(x => tasks.findItem(String(x)).id))] : [];
      return {...e, start: b.start, minutes, at: b.at ?? null, remind: !!b.remind, ...(notified ? {notified: true} : {}),
        ...(links.length ? {links} : {}), ...(b.eventId ? {eventId: String(b.eventId).slice(0, 200)} : {}), ...(b.note ? {note: String(b.note).slice(0, 5000)} : {})};
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
    .run(person, date, JSON.stringify({top: next.top, dump: next.dump, blocks: next.blocks, dayStart: next.dayStart, dayEnd: next.dayEnd, slot: next.slot}), updated);
  tasks.emit({kind: 'dayplan', person});
  return {...next, updated};
}

/**
 * Fill the day from a time on: top 3 first, then tasks due today and overdue, then the brain dump, each in the
 * next free gap. Uses each task's estimate (30 minutes when it has none). Things already boxed or done are skipped.
 * offsetMinutes: the person's offset from UTC (like -420 for Mountain time) so reminders land at the right moment.
 */
export function autoSchedule(tasks: Tasks, person: string, date: string, opts: {from?: string; offsetMinutes?: number; include?: ('top' | 'due' | 'dump')[]} = {}): DayPlan {
  const plan = getDayPlan(tasks, person, date);
  const from = opts.from && TIME.test(opts.from) ? mins(opts.from) : plan.dayStart * 60;
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
  const free = (s: number, len: number) => s + len <= end && busy.every(([a, b]) => s + len <= a || s >= b);
  const blocks = [...plan.blocks];
  // Lines that name a time ("2PM meeting") go at that time first, if it is free and later than now.
  for (const e of [...want]) {
    const t = e.itemId ? null : timeIn(e.text);
    if (t === null || t < start || !free(t, 30)) continue;
    const at = opts.offsetMinutes !== undefined ? new Date(Date.parse(`${date}T${hhmm(t)}:00Z`) - opts.offsetMinutes * 60_000).toISOString() : null;
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
    const at = opts.offsetMinutes !== undefined ? new Date(Date.parse(`${date}T${hhmm(s)}:00Z`) - opts.offsetMinutes * 60_000).toISOString() : null;
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
