// Meetings and other calendar events, kept apart from items.
//
// An event has a real start and end time (or is all-day), attendees, an optional linked item (a meeting's prep task
// or a task put on the calendar as a time-block) and an optional repeat rule (iCalendar RRULE). Repeating events are
// stored once (the master) and expanded when listed; a changed or cancelled single occurrence is its own row with
// recurring_id and original_start. Google Calendar sync (server/gcal.ts) keeps a copy of each event in the
// organizer's chosen calendar and brings Google events in, so both sides show the same thing.
import {randomBytes} from 'node:crypto';
import type {Tasks} from './service.ts';
import {Invalid, NotFound} from './errors.ts';

export const DEFAULT_TZ = process.env.CADENCE_TZ || 'America/Denver';
export type EventKind = 'meeting' | 'timeblock' | 'deadline';
export type Attendee = {person: string | null; email: string | null; name?: string | null; response: 'needsAction' | 'accepted' | 'declined' | 'tentative'; optional?: boolean};
export type CalEvent = {
  id: string; projectId: string | null; itemId: string | null; kind: EventKind;
  title: string; body: string; location: string; meetUrl: string | null;
  start: string; end: string; allDay: boolean; tz: string;
  rrule: string | null; recurringId: string | null; originalStart: string | null;
  organizer: string; visibility: 'space' | 'attendees' | 'private'; attendees: Attendee[];
  source: 'cadence' | 'google'; readonly: boolean; created: string; updated: string; deleted: string | null;
  /** Set on expanded occurrences of a repeating event: the master's id. */
  occurrenceOf?: string;
};
export type EventInput = Partial<Pick<CalEvent, 'projectId' | 'itemId' | 'kind' | 'title' | 'body' | 'location' | 'start' | 'end' | 'allDay' | 'tz' | 'rrule' | 'visibility'>> & {
  attendees?: (string | {person?: string | null; email?: string | null; optional?: boolean})[]; meet?: boolean; duration?: number;
};
export type CalendarSettings = {linkId: string | null; calendarId: string; pushTasks: 'none' | 'due'; tasksCalendarId: string | null; doneRule: 'mark' | 'delete';
  syncCalendars: string[]; workStart: string; workEnd: string; tz: string};

const now = () => new Date().toISOString();
const id = () => randomBytes(6).toString('hex');

export function migrateEvents(tasks: Tasks) {
  tasks.db.exec(`
    create table if not exists events (
      id text primary key, project_id text, item_id text, kind text not null default 'meeting',
      title text not null, body text not null default '', location text not null default '', meet_url text,
      start text not null, end text not null, all_day integer not null default 0, tz text not null,
      rrule text, recurring_id text, original_start text, organizer text not null,
      visibility text not null default 'space', source text not null default 'cadence', readonly integer not null default 0,
      created text not null, updated text not null, deleted text
    );
    create index if not exists events_range on events(start, end);
    create index if not exists events_recurring on events(recurring_id);
    create index if not exists events_item on events(item_id);
    create table if not exists event_attendees (event_id text not null, person text, email text, name text, response text not null default 'needsAction', optional integer not null default 0);
    create index if not exists event_attendees_event on event_attendees(event_id);
    create index if not exists event_attendees_person on event_attendees(person);
    create table if not exists event_links (event_id text not null, link_id text not null, calendar_id text not null, google_id text not null, etag text, google_updated text,
      primary key (link_id, calendar_id, google_id));
    create index if not exists event_links_event on event_links(event_id);
    create table if not exists gcal_sync (link_id text not null, calendar_id text not null, sync_token text, channel_id text, resource_id text, channel_token text,
      channel_expires text, last_sync text, error text, primary key (link_id, calendar_id));
    create table if not exists gcal_items (person text not null, item_id text not null, link_id text not null, calendar_id text not null, google_id text not null, etag text,
      primary key (person, item_id));
    create table if not exists calendar_settings (person text primary key, data text not null);
  `);
}

// ---- Time zones (no library: Intl gives the offset of any zone at any instant) ----

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(t: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'}); fmtCache.set(tz, f); }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(t)) o[p.type] = p.value;
  return {y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday)};
}
export function validTz(tz: string) { try { new Intl.DateTimeFormat('en-US', {timeZone: tz}); return true; } catch { return false; } }
/** Wall-clock time in a zone to a UTC instant. */
export function zoned(y: number, m: number, d: number, h: number, mi: number, tz: string) {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let k = 0; k < 3; k++) {
    const p = parts(new Date(guess), tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Date.UTC(y, m - 1, d, h, mi);
    if (!diff) break;
    guess -= diff;
  }
  return new Date(guess);
}
/** The calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDay(t: string | Date, tz: string) { const p = parts(new Date(t), tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
export function localTime(t: string | Date, tz: string) { const p = parts(new Date(t), tz); return {...p, minutes: p.h * 60 + p.mi}; }

// ---- Repeat rules (the RRULE subset Google and Outlook produce for normal meetings) ----

type Rule = {freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval: number; count?: number; until?: Date; byday: {n: number; wd: number}[]; bymonthday: number[]; exdates: Set<string>};
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export function parseRule(text: string): Rule {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rr = lines.find(l => /^RRULE:/i.test(l)) ?? (lines[0] && !/^EXDATE/i.test(lines[0]) ? 'RRULE:' + lines[0].replace(/^RRULE:/i, '') : '');
  if (!rr) throw new Invalid('Repeat rule needs an RRULE line, like RRULE:FREQ=WEEKLY;BYDAY=MO');
  const kv = Object.fromEntries(rr.replace(/^RRULE:/i, '').split(';').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]));
  const freq = kv.FREQ as Rule['freq'];
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) throw new Invalid('Repeat FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY');
  const interval = kv.INTERVAL ? Math.max(1, Math.min(366, parseInt(kv.INTERVAL, 10) || 1)) : 1;
  const until = kv.UNTIL ? icalDate(kv.UNTIL) : undefined;
  const byday = (kv.BYDAY ? kv.BYDAY.split(',') : []).map((s: string) => { const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s); if (!m) throw new Invalid(`Bad BYDAY value ${s}`); return {n: m[1] ? parseInt(m[1], 10) : 0, wd: WD.indexOf(m[2])}; });
  const bymonthday = kv.BYMONTHDAY ? kv.BYMONTHDAY.split(',').map((x: string) => parseInt(x, 10)).filter((x: number) => x && Math.abs(x) <= 31) : [];
  const exdates = new Set<string>();
  for (const l of lines.filter(l => /^EXDATE/i.test(l))) for (const v of l.split(':')[1]?.split(',') ?? []) { const d = icalDate(v); if (d) exdates.add(d.toISOString()); }
  return {freq, interval, count: kv.COUNT ? Math.min(1000, parseInt(kv.COUNT, 10)) : undefined, until, byday, bymonthday, exdates};
}
function icalDate(v: string) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
  if (!m) return undefined;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : 59));
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addMonths = (y: number, m: number, n: number) => { const t = (y * 12 + (m - 1)) + n; return {y: Math.floor(t / 12), m: (t % 12) + 1}; };

/** Start instants of a repeating event that overlap [from, to). Wall-clock times hold across daylight saving. */
export function occurrences(start: string, rruleText: string, tz: string, from: Date, to: Date, durationMs: number, max = 2000): Date[] {
  const r = parseRule(rruleText);
  const s = localTime(start, tz);
  const out: Date[] = [];
  let produced = 0;
  const take = (y: number, m: number, d: number) => {
    const t = zoned(y, m, d, s.h, s.mi, tz);
    if (t.getTime() < new Date(start).getTime()) return true;
    if (r.until && t > r.until) return false;
    if (r.count !== undefined && produced >= r.count) return false;
    produced++;
    if (t.getTime() + durationMs > from.getTime() && t < to && !r.exdates.has(t.toISOString())) out.push(t);
    return out.length < max;
  };
  const startDay = new Date(Date.UTC(s.y, s.m - 1, s.d));
  const pastEnd = (y: number, m: number, d: number) => zoned(y, m, d, 0, 0, tz) >= to;
  if (r.freq === 'DAILY') {
    for (let k = 0; ; k += r.interval) {
      const d = new Date(startDay.getTime() + k * 86400000);
      const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
      if (pastEnd(y, m, dd) || !take(y, m, dd)) break;
    }
  } else if (r.freq === 'WEEKLY') {
    const days = r.byday.length ? [...new Set(r.byday.map(b => b.wd))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)) : [s.wd];
    const weekStart = new Date(startDay.getTime() - ((s.wd + 6) % 7) * 86400000); // Monday of the first week
    outer: for (let w = 0; w < 5000; w += r.interval) {
      for (const wd of days) {
        const d = new Date(weekStart.getTime() + (w * 7 + ((wd + 6) % 7)) * 86400000);
        const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
        if (pastEnd(y, m, dd)) break outer;
        if (!take(y, m, dd)) break outer;
      }
    }
  } else {
    const monthly = r.freq === 'MONTHLY';
    outer: for (let k = 0; k < 2000; k += r.interval) {
      const months = monthly ? [addMonths(s.y, s.m, k)] : [{y: s.y + k, m: s.m}];
      for (const {y, m} of months) {
        if (zoned(y, m, 1, 0, 0, tz) >= to) break outer;
        const dim = daysInMonth(y, m);
        let days: number[] = [];
        if (r.byday.length) {
          for (const b of r.byday) {
            const all = Array.from({length: dim}, (_, i) => i + 1).filter(d => new Date(Date.UTC(y, m - 1, d)).getUTCDay() === b.wd);
            if (!b.n) days.push(...all); else { const v = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (v) days.push(v); }
          }
        } else if (r.bymonthday.length) days = r.bymonthday.map(d => d > 0 ? d : dim + d + 1).filter(d => d >= 1 && d <= dim);
        else if (s.d <= dim) days = [s.d];
        for (const d of [...new Set(days)].sort((a, b) => a - b)) if (!take(y, m, d)) break outer;
      }
    }
  }
  return out;
}

// ---- Rows ----

function row(r: Record<string, unknown>, attendees: Attendee[]): CalEvent {
  return {id: r.id as string, projectId: (r.project_id as string) ?? null, itemId: (r.item_id as string) ?? null, kind: r.kind as EventKind,
    title: r.title as string, body: r.body as string, location: r.location as string, meetUrl: (r.meet_url as string) ?? null,
    start: r.start as string, end: r.end as string, allDay: !!r.all_day, tz: r.tz as string, rrule: (r.rrule as string) ?? null,
    recurringId: (r.recurring_id as string) ?? null, originalStart: (r.original_start as string) ?? null, organizer: r.organizer as string,
    visibility: r.visibility as CalEvent['visibility'], attendees, source: r.source as CalEvent['source'], readonly: !!r.readonly,
    created: r.created as string, updated: r.updated as string, deleted: (r.deleted as string) ?? null};
}
function attendeesOf(tasks: Tasks, ids: string[]) {
  const m = new Map<string, Attendee[]>();
  if (!ids.length) return m;
  const rows = tasks.db.prepare(`select * from event_attendees where event_id in (${ids.map(() => '?').join(',')})`).all(...ids);
  for (const a of rows) {
    const list = m.get(a.event_id as string) ?? [];
    list.push({person: (a.person as string) ?? null, email: (a.email as string) ?? null, name: (a.name as string) ?? null, response: a.response as Attendee['response'], optional: !!a.optional});
    m.set(a.event_id as string, list);
  }
  return m;
}
export function getEvent(tasks: Tasks, eid: string): CalEvent {
  const r = tasks.db.prepare('select * from events where id = ?').get(eid);
  if (!r) throw new NotFound('No such event');
  return row(r, attendeesOf(tasks, [eid]).get(eid) ?? []);
}

/** Can this person see the event? Organizer and attendees always; others by the space's access and the event's visibility. */
export function canSeeEvent(e: CalEvent, person: string | null, canSeeProject: (pid: string) => boolean) {
  if (person && (e.organizer === person || e.attendees.some(a => a.person === person))) return true;
  if (e.visibility !== 'space' || e.source === 'google') return false;
  return e.projectId ? canSeeProject(e.projectId) : !person ? true : false;
}

/** Events overlapping [from, to) (YYYY-MM-DD dates, or ISO times), repeating ones expanded into occurrences. */
export function listEvents(tasks: Tasks, q: {from: string; to: string; person?: string | null; projectId?: string; mine?: boolean; includeDeleted?: boolean},
  canSeeProject: (pid: string) => boolean = () => true): CalEvent[] {
  const from = toInstant(q.from, 'start'), to = toInstant(q.to, 'end');
  if (to <= from) throw new Invalid('to must be after from');
  if (to.getTime() - from.getTime() > 400 * 86400000) throw new Invalid('Ask for at most 400 days at a time');
  const rows = tasks.db.prepare(`select * from events where deleted is null and recurring_id is null and (rrule is not null or (start < ? and end > ?))`).all(to.toISOString(), from.toISOString());
  const exc = tasks.db.prepare('select * from events where recurring_id is not null').all();
  const att = attendeesOf(tasks, [...rows, ...exc].map(r => r.id as string));
  const exceptions = new Map<string, Map<string, CalEvent>>();
  for (const r of exc) {
    const e = row(r, att.get(r.id as string) ?? []);
    const m = exceptions.get(e.recurringId!) ?? new Map();
    m.set(new Date(e.originalStart!).toISOString(), e);
    exceptions.set(e.recurringId!, m);
  }
  const out: CalEvent[] = [];
  for (const r of rows) {
    const e = row(r, att.get(r.id as string) ?? []);
    if (!e.rrule) { out.push(e); continue; }
    const dur = new Date(e.end).getTime() - new Date(e.start).getTime();
    const ex = exceptions.get(e.id) ?? new Map<string, CalEvent>();
    let list: Date[] = [];
    try { list = occurrences(e.start, e.rrule, e.allDay ? 'UTC' : e.tz, from, to, dur); } catch { list = [new Date(e.start)]; }
    for (const t of list) {
      const key = t.toISOString(), x = ex.get(key);
      if (x) { if (!x.deleted && new Date(x.start) < to && new Date(x.end) > from) out.push({...x, occurrenceOf: e.id}); ex.delete(key); continue; }
      out.push({...e, start: key, end: new Date(t.getTime() + dur).toISOString(), originalStart: key, occurrenceOf: e.id});
    }
    // Moved occurrences whose new time falls in range though the original did not.
    for (const x of ex.values()) if (!x.deleted && new Date(x.start) < to && new Date(x.end) > from) out.push({...x, occurrenceOf: e.id});
  }
  const visible = out.filter(e => canSeeEvent(e, q.person ?? null, canSeeProject))
    .filter(e => !q.projectId || e.projectId === q.projectId || (q.mine && q.person && (e.organizer === q.person || e.attendees.some(a => a.person === q.person))))
    .filter(e => !q.mine || !q.person || q.projectId || e.organizer === q.person || e.attendees.some(a => a.person === q.person));
  return visible.sort((a, b) => a.start.localeCompare(b.start));
}
function toInstant(v: string, edge: 'start' | 'end') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + (edge === 'start' ? 'T00:00:00Z' : 'T23:59:59Z'));
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) throw new Invalid(`${edge === 'start' ? 'from' : 'to'} must be a date like 2026-11-30 or an ISO time`);
  return t;
}

// ---- Create, change, delete ----

const KINDS: EventKind[] = ['meeting', 'timeblock', 'deadline'];
function normalizeTimes(input: EventInput, base?: CalEvent) {
  const allDay = input.allDay ?? base?.allDay ?? false;
  const tz = input.tz ?? base?.tz ?? DEFAULT_TZ;
  if (!validTz(tz)) throw new Invalid(`Unknown time zone ${tz}`);
  let start = input.start ?? base?.start, end = input.end ?? (input.start && base && !input.duration ? new Date(new Date(input.start).getTime() + (new Date(base.end).getTime() - new Date(base.start).getTime())).toISOString() : base?.end);
  if (!start) throw new Invalid('start is required, like 2026-11-16T10:00:00-07:00 (or a date for all-day)');
  if (allDay) {
    const s = /^\d{4}-\d{2}-\d{2}/.exec(start)?.[0];
    if (!s) throw new Invalid('All-day start must be a date like 2026-11-16');
    const e = end ? /^\d{4}-\d{2}-\d{2}/.exec(end)?.[0] : null;
    start = s + 'T00:00:00.000Z';
    end = (e && e > s ? e : new Date(new Date(start).getTime() + 86400000).toISOString().slice(0, 10)) + 'T00:00:00.000Z';
  } else {
    const st = new Date(start);
    if (Number.isNaN(st.getTime()) || !/T\d{2}:\d{2}/.test(start)) throw new Invalid('start must be a time like 2026-11-16T10:00:00-07:00');
    if (input.duration !== undefined) {
      if (!(input.duration > 0 && input.duration <= 24 * 60)) throw new Invalid('duration is minutes, 1 to 1440');
      end = new Date(st.getTime() + input.duration * 60000).toISOString();
    }
    if (!end) end = new Date(st.getTime() + 30 * 60000).toISOString();
    const en = new Date(end);
    if (Number.isNaN(en.getTime())) throw new Invalid('end must be a time');
    if (en <= st) throw new Invalid('end must be after start');
    if (en.getTime() - st.getTime() > 14 * 86400000) throw new Invalid('Events are limited to 14 days');
    start = st.toISOString(); end = en.toISOString();
  }
  return {start, end, allDay, tz};
}
function resolveAttendees(tasks: Tasks, list: EventInput['attendees']): Attendee[] {
  if (!list) return [];
  if (!Array.isArray(list) || list.length > 100) throw new Invalid('attendees must be a list (at most 100)');
  const people = tasks.listPeople();
  const out: Attendee[] = [];
  for (const a of list) {
    const raw = typeof a === 'string' ? a : (a.person ?? a.email ?? '');
    const optional = typeof a === 'object' && !!a?.optional;
    const p = people.find(x => x.id === raw || x.name.toLowerCase() === String(raw).toLowerCase() || (x.email && x.email.toLowerCase() === String(raw).toLowerCase()));
    if (p) { if (!out.some(o => o.person === p.id)) out.push({person: p.id, email: p.email ?? null, name: p.name, response: 'needsAction', optional}); continue; }
    const email = String(raw).trim().toLowerCase();
    if (!/^[^\s@<>",;:]+@[^\s@<>",;:]+\.[a-z]{2,}$/i.test(email)) throw new Invalid(`Unknown person or bad email: ${raw}`);
    if (!out.some(o => o.email === email)) out.push({person: null, email, response: 'needsAction', optional});
  }
  return out;
}
function saveAttendees(tasks: Tasks, eid: string, list: Attendee[]) {
  tasks.db.prepare('delete from event_attendees where event_id = ?').run(eid);
  const ins = tasks.db.prepare('insert into event_attendees (event_id, person, email, name, response, optional) values (?,?,?,?,?,?)');
  for (const a of list) ins.run(eid, a.person, a.email, a.name ?? null, a.response, a.optional ? 1 : 0);
}
function checkText(input: EventInput) {
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 300)) throw new Invalid('Title is required (up to 300 characters)');
  if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 20000)) throw new Invalid('Notes are limited to 20,000 characters');
  if (input.location !== undefined && (typeof input.location !== 'string' || input.location.length > 500)) throw new Invalid('Location is limited to 500 characters');
  if (input.kind !== undefined && !KINDS.includes(input.kind)) throw new Invalid('kind must be meeting, timeblock or deadline');
  if (input.visibility !== undefined && !['space', 'attendees', 'private'].includes(input.visibility)) throw new Invalid('visibility must be space, attendees or private');
  if (input.rrule) parseRule(input.rrule);
}
export type Hook = {created?: (e: CalEvent, opts: {meet?: boolean}) => void; changed?: (before: CalEvent, after: CalEvent, scope: 'all' | 'one') => void; removed?: (e: CalEvent, scope: 'all' | 'one') => void};
const hooks = new WeakMap<Tasks, Hook[]>();
/** The service behind a permission guard (MCP over HTTP wraps it), so hooks registered on it are found. */
export const raw = (t: Tasks): Tasks => ((t as unknown as Record<symbol, Tasks>)[Symbol.for('cadence.raw')]) ?? t;
export function onEvent(tasks: Tasks, h: Hook) { hooks.set(raw(tasks), [...(hooks.get(raw(tasks)) ?? []), h]); }
const fire = (tasks: Tasks, f: (h: Hook) => void) => { for (const h of hooks.get(raw(tasks)) ?? []) { try { f(h); } catch (e) { console.error('Event hook failed', e); } } tasks.emit({kind: 'events'}); };

export function createEvent(tasks: Tasks, input: EventInput, actor: string | null, opts: {source?: 'cadence' | 'google'; readonly?: boolean; recurringId?: string; originalStart?: string; organizer?: string; silent?: boolean} = {}): CalEvent {
  checkText(input);
  if (!input.title?.trim()) throw new Invalid('Title is required');
  const organizer = opts.organizer ?? actor;
  if (!organizer) throw new Invalid('Pick who you are first (the organizer)');
  if (input.projectId) tasks.project(input.projectId);
  if (input.itemId) tasks.item(input.itemId);
  const t = normalizeTimes(input);
  const e: CalEvent = {id: id(), projectId: input.projectId ?? (input.itemId ? tasks.item(input.itemId).projectId : null), itemId: input.itemId ?? null,
    kind: input.kind ?? (input.itemId && !input.attendees?.length ? 'timeblock' : 'meeting'), title: input.title.trim(), body: input.body ?? '', location: input.location ?? '', meetUrl: null,
    ...t, rrule: input.rrule?.trim() || null, recurringId: opts.recurringId ?? null, originalStart: opts.originalStart ?? null, organizer,
    visibility: input.visibility ?? 'space', attendees: resolveAttendees(tasks, input.attendees), source: opts.source ?? 'cadence', readonly: !!opts.readonly,
    created: now(), updated: now(), deleted: null};
  // The organizer is always on the list (as accepted) so their calendar and capacity count it.
  if (!e.attendees.some(a => a.person === organizer) && tasks.listPeople().some(p => p.id === organizer)) {
    const p = tasks.listPeople().find(x => x.id === organizer)!;
    e.attendees.unshift({person: organizer, email: p.email ?? null, name: p.name, response: 'accepted'});
  }
  tasks.db.prepare(`insert into events (id, project_id, item_id, kind, title, body, location, meet_url, start, end, all_day, tz, rrule, recurring_id, original_start, organizer, visibility, source, readonly, created, updated)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.id, e.projectId, e.itemId, e.kind, e.title, e.body, e.location, e.meetUrl, e.start, e.end, e.allDay ? 1 : 0, e.tz, e.rrule,
    e.recurringId, e.originalStart, e.organizer, e.visibility, e.source, e.readonly ? 1 : 0, e.created, e.updated);
  saveAttendees(tasks, e.id, e.attendees);
  if (!opts.silent) {
    for (const a of e.attendees) if (a.person && a.person !== organizer) tasks.notifyPublic(a.person, organizer, e.itemId, 'meeting', `invited you to "${e.title}" ${describeWhen(e)}`);
    fire(tasks, h => h.created?.(e, {meet: input.meet}));
  } else tasks.emit({kind: 'events'});
  return e;
}
export function describeWhen(e: Pick<CalEvent, 'start' | 'allDay' | 'tz'>) {
  if (e.allDay) return `on ${e.start.slice(0, 10)}`;
  return 'on ' + new Date(e.start).toLocaleString('en-US', {timeZone: e.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'});
}

/** Changes an event. For a repeating event, scope 'one' with occurrence (its original start) changes only that occurrence. */
export function updateEvent(tasks: Tasks, eid: string, input: EventInput & {response?: Attendee['response']}, actor: string | null,
  opts: {scope?: 'all' | 'one'; occurrence?: string; system?: boolean; silent?: boolean} = {}): CalEvent {
  const base = getEvent(tasks, eid);
  if (base.deleted) throw new NotFound('That event was deleted');
  // Attendees answer for themselves.
  if (input.response !== undefined && Object.keys(input).length === 1) {
    if (!['accepted', 'declined', 'tentative', 'needsAction'].includes(input.response)) throw new Invalid('response must be accepted, declined or tentative');
    if (!actor || !base.attendees.some(a => a.person === actor)) throw new Invalid('Only attendees answer an invitation');
    tasks.db.prepare('update event_attendees set response = ? where event_id = ? and person = ?').run(input.response, eid, actor);
    const after = getEvent(tasks, eid);
    if (!opts.system) fire(tasks, h => h.changed?.(base, after, 'all'));
    return after;
  }
  if (!opts.system && base.readonly) throw new Invalid('This event comes from someone else\'s Google calendar. Change it there.');
  if (!opts.system && actor !== base.organizer && !isAdmin(tasks, actor)) throw new Invalid('Only the organizer changes this event');
  checkText(input);
  if (opts.scope === 'one' && base.rrule) {
    if (!opts.occurrence) throw new Invalid('Say which occurrence (its original start time) to change');
    const orig = new Date(opts.occurrence).toISOString();
    const dur = new Date(base.end).getTime() - new Date(base.start).getTime();
    const existing = tasks.db.prepare('select id from events where recurring_id = ? and original_start = ?').get(base.id, orig) as {id: string} | undefined;
    if (existing) return updateEvent(tasks, existing.id, input, actor, {...opts, scope: 'all'});
    const occ = {...base, start: orig, end: new Date(new Date(orig).getTime() + dur).toISOString(), rrule: null};
    const merged: EventInput = {title: base.title, body: base.body, location: base.location, kind: base.kind, projectId: base.projectId, itemId: base.itemId,
      visibility: base.visibility, allDay: base.allDay, tz: base.tz, attendees: base.attendees.map(a => ({person: a.person, email: a.email, optional: a.optional})), ...input,
      start: input.start ?? occ.start, end: input.end ?? (input.start ? undefined : occ.end), rrule: null};
    const x = createEvent(tasks, merged, actor, {recurringId: base.id, originalStart: orig, organizer: base.organizer, silent: true, source: base.source, readonly: base.readonly});
    if (base.meetUrl) tasks.db.prepare('update events set meet_url = ? where id = ?').run(base.meetUrl, x.id);
    const after = getEvent(tasks, x.id);
    if (!opts.silent) fire(tasks, h => h.changed?.(occ, after, 'one'));
    return after;
  }
  const t = normalizeTimes(input, base);
  const next: CalEvent = {...base, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && ['title', 'body', 'location', 'kind', 'projectId', 'itemId', 'visibility'].includes(k))), ...t, updated: now()} as CalEvent;
  if (input.rrule !== undefined) next.rrule = input.rrule?.trim() || null;
  if (next.title !== base.title) next.title = next.title.trim();
  if (input.attendees) {
    const list = resolveAttendees(tasks, input.attendees);
    // Keep answers people already gave.
    for (const a of list) { const was = base.attendees.find(b => (a.person && b.person === a.person) || (a.email && b.email === a.email)); if (was) a.response = was.response; }
    if (!list.some(a => a.person === base.organizer)) { const o = base.attendees.find(a => a.person === base.organizer); if (o) list.unshift(o); }
    next.attendees = list;
  }
  tasks.db.prepare(`update events set project_id=?, item_id=?, kind=?, title=?, body=?, location=?, start=?, end=?, all_day=?, tz=?, rrule=?, visibility=?, updated=? where id=?`)
    .run(next.projectId, next.itemId, next.kind, next.title, next.body, next.location, next.start, next.end, next.allDay ? 1 : 0, next.tz, next.rrule, next.visibility, next.updated, eid);
  if (input.attendees) {
    saveAttendees(tasks, eid, next.attendees);
    if (!opts.system) for (const a of next.attendees) if (a.person && a.person !== base.organizer && !base.attendees.some(b => b.person === a.person))
      tasks.notifyPublic(a.person, actor, next.itemId, 'meeting', `invited you to "${next.title}" ${describeWhen(next)}`);
  }
  const after = getEvent(tasks, eid);
  if (!opts.silent) fire(tasks, h => h.changed?.(base, after, 'all'));
  return after;
}

export function deleteEvent(tasks: Tasks, eid: string, actor: string | null, opts: {scope?: 'all' | 'one'; occurrence?: string; system?: boolean; silent?: boolean} = {}) {
  const base = getEvent(tasks, eid);
  if (!opts.system && base.readonly) throw new Invalid('This event comes from someone else\'s Google calendar. Remove it there.');
  if (!opts.system && actor !== base.organizer && !isAdmin(tasks, actor)) throw new Invalid('Only the organizer deletes this event');
  if (opts.scope === 'one' && base.rrule) {
    if (!opts.occurrence) throw new Invalid('Say which occurrence (its original start time) to remove');
    const orig = new Date(opts.occurrence).toISOString();
    const existing = tasks.db.prepare('select id from events where recurring_id = ? and original_start = ?').get(base.id, orig) as {id: string} | undefined;
    const dur = new Date(base.end).getTime() - new Date(base.start).getTime();
    const occ = {...base, start: orig, end: new Date(new Date(orig).getTime() + dur).toISOString(), rrule: null, originalStart: orig, recurringId: base.id};
    if (existing) tasks.db.prepare('update events set deleted = ?, updated = ? where id = ?').run(now(), now(), existing.id);
    else {
      const x = createEvent(tasks, {title: base.title, start: occ.start, end: occ.end, allDay: base.allDay, tz: base.tz}, actor, {recurringId: base.id, originalStart: orig, organizer: base.organizer, silent: true, source: base.source, readonly: base.readonly});
      tasks.db.prepare('update events set deleted = ? where id = ?').run(now(), x.id);
    }
    if (!opts.silent) fire(tasks, h => h.removed?.(occ, 'one'));
    return {ok: true};
  }
  tasks.db.prepare('update events set deleted = ?, updated = ? where id = ? or recurring_id = ?').run(now(), now(), eid, eid);
  if (!opts.silent) {
    for (const a of base.attendees) if (a.person && a.person !== base.organizer) tasks.notifyPublic(a.person, actor, base.itemId, 'meeting', `cancelled "${base.title}" ${describeWhen(base)}`);
    fire(tasks, h => h.removed?.(base, 'all'));
  }
  return {ok: true};
}
const isAdmin = (tasks: Tasks, pid: string | null) => !!pid && !!(tasks.db.prepare('select admin from people where id = ?').get(pid) as {admin?: number} | undefined)?.admin;

// ---- Time-blocks: put a task on the calendar ----

export function timeblockItem(tasks: Tasks, itemId: string, start: string, end: string, actor: string | null) {
  const it = tasks.item(itemId);
  const e = createEvent(tasks, {itemId, kind: 'timeblock', title: it.title, start, end, visibility: 'attendees', body: `Time set aside for ${tasks.project(it.projectId).key}-${it.number}.`}, actor);
  const endDay = localDay(e.end, e.tz);
  return {event: e, pastDue: !!it.due && endDay > it.due, note: it.due && endDay > it.due ? `This block ends after the task is due (${it.due}). Move the due date or the block.` : ''};
}

// ---- Settings per person ----

export function calendarSettings(tasks: Tasks, person: string): CalendarSettings {
  const r = tasks.db.prepare('select data from calendar_settings where person = ?').get(person) as {data: string} | undefined;
  const saved = r ? JSON.parse(r.data) as Partial<CalendarSettings> : {};
  const link = saved.linkId ?? (tasks.db.prepare("select id from google_links where person = ? and scopes like '%calendar%' order by created").get(person) as {id: string} | undefined)?.id ?? null;
  return {linkId: link, calendarId: saved.calendarId || 'primary', pushTasks: saved.pushTasks ?? 'none', tasksCalendarId: saved.tasksCalendarId ?? null, doneRule: saved.doneRule ?? 'mark',
    syncCalendars: saved.syncCalendars?.length ? saved.syncCalendars : [saved.calendarId || 'primary'], workStart: saved.workStart ?? '09:00', workEnd: saved.workEnd ?? '17:00', tz: saved.tz ?? DEFAULT_TZ};
}
export function saveCalendarSettings(tasks: Tasks, person: string, patch: Partial<CalendarSettings>) {
  const cur = calendarSettings(tasks, person);
  const next = {...cur, ...patch};
  if (next.linkId && !tasks.db.prepare('select 1 from google_links where id = ? and person = ?').get(next.linkId, person)) throw new Invalid('That Google account is not one of yours');
  if (!['none', 'due'].includes(next.pushTasks)) throw new Invalid('pushTasks must be none or due');
  if (!['mark', 'delete'].includes(next.doneRule)) throw new Invalid('doneRule must be mark or delete');
  if (!/^\d{2}:\d{2}$/.test(next.workStart) || !/^\d{2}:\d{2}$/.test(next.workEnd) || next.workEnd <= next.workStart) throw new Invalid('Work hours must be like 09:00 to 17:00');
  if (!validTz(next.tz)) throw new Invalid(`Unknown time zone ${next.tz}`);
  if (!Array.isArray(next.syncCalendars) || next.syncCalendars.length > 20) throw new Invalid('syncCalendars must be a list');
  tasks.db.prepare('insert into calendar_settings (person, data) values (?, ?) on conflict(person) do update set data = excluded.data').run(person, JSON.stringify(next));
  return next;
}

// ---- Capacity and free time ----

/** Hours each person spends in meetings and time-blocks per local day (declined invitations do not count). */
export function busyHours(tasks: Tasks, from: string, to: string, opts: {timeblocks?: boolean} = {}) {
  const out = new Map<string, Map<string, number>>();
  let list: CalEvent[] = [];
  try { list = listEvents(tasks, {from, to}); } catch { return out; }
  for (const e of list) {
    if (e.allDay || (!opts.timeblocks && e.kind === 'timeblock')) continue;
    const hours = (new Date(e.end).getTime() - new Date(e.start).getTime()) / 3600000;
    for (const a of e.attendees) {
      if (!a.person || a.response === 'declined') continue;
      const d = localDay(e.start, calendarSettings(tasks, a.person).tz);
      const m = out.get(a.person) ?? new Map<string, number>();
      m.set(d, (m.get(d) ?? 0) + hours);
      out.set(a.person, m);
    }
  }
  return out;
}

export type Busy = {start: string; end: string};
/** First open slots of the given length when every listed person is free, inside the first person's work hours. */
export function freeSlots(busyByPerson: Map<string, Busy[]>, opts: {from: string; to: string; durationMin: number; tz: string; workStart: string; workEnd: string; max?: number; stepMin?: number}) {
  const out: {start: string; end: string}[] = [];
  const all = [...busyByPerson.values()].flat().map(b => [new Date(b.start).getTime(), new Date(b.end).getTime()] as const).sort((a, b) => a[0] - b[0]);
  const dur = opts.durationMin * 60000, step = (opts.stepMin ?? 15) * 60000;
  const [ws, we] = [opts.workStart, opts.workEnd].map(t => t.split(':').map(Number));
  const nowMs = Date.now();
  for (let d = new Date(opts.from + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= opts.to && out.length < (opts.max ?? 5); d = new Date(d.getTime() + 86400000)) {
    const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const dayStart = zoned(y, m, dd, ws[0], ws[1], opts.tz).getTime(), dayEnd = zoned(y, m, dd, we[0], we[1], opts.tz).getTime();
    for (let t = Math.max(dayStart, Math.ceil(nowMs / step) * step); t + dur <= dayEnd && out.length < (opts.max ?? 5); t += step) {
      if (!all.some(([s, e]) => s < t + dur && e > t)) { out.push({start: new Date(t).toISOString(), end: new Date(t + dur).toISOString()}); t += dur - step; }
    }
  }
  return out;
}
export function cadenceBusy(tasks: Tasks, people: string[], from: string, to: string): Map<string, Busy[]> {
  const out = new Map<string, Busy[]>(people.map(p => [p, []]));
  for (const e of listEvents(tasks, {from, to})) {
    if (e.allDay) continue;
    for (const a of e.attendees) if (a.person && out.has(a.person) && a.response !== 'declined') out.get(a.person)!.push({start: e.start, end: e.end});
  }
  return out;
}
