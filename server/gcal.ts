// Two-way Google Calendar sync for Cadence events, plus task due dates on a calendar.
//
// Cadence to Google: every event a person organizes is written to their chosen calendar (Calendar settings on the
// Team page) with attendees, invitations sent by Google, and a Meet link when asked. Changes and cancellations follow.
// Google to Cadence: each chosen calendar is read with a sync token (only changes since last time), every 5 minutes
// and, when PUBLIC_URL is https, right away through Google's push notifications. Events organized by someone else are
// shown read-only. The same meeting seen in several people's calendars is one Cadence event (matched by iCalUID).
// Due dates: people who turn it on get one all-day event per task assigned to them, kept in step as the task changes.
import {randomBytes, randomUUID} from 'node:crypto';
import type {Tasks} from './service.ts';
import type {ChangeEvent, Item} from '../src/types.ts';
import {access, listLinks} from './googlelinks.ts';
import {Invalid} from './errors.ts';
import {publicUrl} from './signin.ts';
import {type Attendee, type Busy, type CalEvent, cadenceBusy, calendarSettings, createEvent, getEvent, onEvent, raw, saveCalendarSettings} from './events.ts';

const API = 'https://www.googleapis.com/calendar/v3';
export const FULL_SCOPE = 'https://www.googleapis.com/auth/calendar';
const now = () => new Date().toISOString();

type G = {status: number; json: Record<string, unknown> & {error?: {message?: string}}};
async function g(token: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<G> {
  const r = await fetch(url.startsWith('http') ? url : API + url, {method, headers: {authorization: `Bearer ${token}`, ...(body ? {'content-type': 'application/json'} : {}), ...headers}, body: body ? JSON.stringify(body) : undefined});
  const text = await r.text();
  let json: G['json'] = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  return {status: r.status, json};
}
const fail = (x: G) => new Invalid(`Google: ${x.json.error?.message ?? x.status}`);
const enc = encodeURIComponent;
const tok = (tasks: Tasks, person: string, linkId: string) => access(tasks.db, person, linkId, 'calendar.events');

// ---- Shapes ----

type GEvent = {id: string; status?: string; summary?: string; description?: string; location?: string; etag?: string; updated?: string; iCalUID?: string; hangoutLink?: string;
  start?: {date?: string; dateTime?: string; timeZone?: string}; end?: {date?: string; dateTime?: string; timeZone?: string};
  recurrence?: string[]; recurringEventId?: string; originalStartTime?: {date?: string; dateTime?: string};
  organizer?: {email?: string; self?: boolean}; attendees?: {email?: string; responseStatus?: string; optional?: boolean; self?: boolean; displayName?: string}[];
  extendedProperties?: {private?: Record<string, string>}};

function emailOf(tasks: Tasks, a: Attendee) {
  if (a.email) return a.email;
  if (a.person) return (tasks.db.prepare('select email from people where id = ?').get(a.person) as {email?: string} | undefined)?.email ?? null;
  return null;
}
export function toGoogle(tasks: Tasks, e: CalEvent, wsId: string, opts: {meet?: boolean} = {}) {
  const time = (t: string) => e.allDay ? {date: t.slice(0, 10)} : {dateTime: t, timeZone: e.tz};
  const base = publicUrl();
  const link = base && e.itemId ? `\n\n${base}/?ws=${wsId}#/open/${e.itemId}` : '';
  const body: Record<string, unknown> = {
    summary: e.title, description: (e.body + link).slice(0, 8000), location: e.location || undefined, start: time(e.start), end: time(e.end),
    attendees: e.attendees.filter(a => a.person !== e.organizer).map(a => ({email: emailOf(tasks, a), optional: a.optional || undefined})).filter(a => a.email),
    extendedProperties: {private: {cadenceEvent: e.id, cadenceWs: wsId}},
    transparency: e.kind === 'timeblock' ? 'opaque' : undefined,
  };
  if (e.rrule) body.recurrence = e.rrule.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => /^(RRULE|EXDATE|RDATE|EXRULE)/i.test(l) ? l : 'RRULE:' + l);
  if (opts.meet && !e.meetUrl) body.conferenceData = {createRequest: {requestId: randomUUID(), conferenceSolutionKey: {type: 'hangoutsMeet'}}};
  return body;
}
const basic = (iso: string, allDay: boolean) => allDay ? iso.slice(0, 10).replace(/-/g, '') : new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function linkFor(tasks: Tasks, eventId: string, linkId?: string) {
  return tasks.db.prepare(`select * from event_links where event_id = ?${linkId ? ' and link_id = ?' : ''} order by rowid limit 1`).get(...(linkId ? [eventId, linkId] : [eventId])) as
    {event_id: string; link_id: string; calendar_id: string; google_id: string; etag: string | null; google_updated: string | null} | undefined;
}
function saveLinkRow(tasks: Tasks, eventId: string, linkId: string, cal: string, ge: GEvent) {
  tasks.db.prepare(`insert into event_links (event_id, link_id, calendar_id, google_id, etag, google_updated, ical_uid) values (?,?,?,?,?,?,?)
    on conflict(link_id, calendar_id, google_id) do update set event_id = excluded.event_id, etag = excluded.etag, google_updated = excluded.google_updated, ical_uid = coalesce(excluded.ical_uid, ical_uid)`)
    .run(eventId, linkId, cal, ge.id, ge.etag ?? null, ge.updated ?? null, ge.iCalUID ?? null);
}
export function migrateGcal(tasks: Tasks) {
  const cols = tasks.db.prepare('pragma table_info(event_links)').all().map(r => r.name);
  if (!cols.includes('ical_uid')) tasks.db.exec('alter table event_links add column ical_uid text; create index if not exists event_links_ical on event_links(ical_uid)');
}

// ---- Cadence to Google ----

export type PushResult = {ok: boolean; skipped?: string; error?: string; meetUrl?: string | null};
/** Writes one event (or one changed or cancelled occurrence) to the organizer's Google calendar. */
export async function pushEvent(tasks: Tasks, wsId: string, e: CalEvent, what: 'upsert' | 'delete', opts: {meet?: boolean; scope?: 'all' | 'one'} = {}): Promise<PushResult> {
  if (e.readonly) return {ok: true, skipped: 'read-only Google event'};
  const s = calendarSettings(tasks, e.organizer);
  if (!s.linkId) return {ok: true, skipped: 'organizer has no Google calendar connected'};
  const token = await tok(tasks, e.organizer, s.linkId);
  const q = '?sendUpdates=all&conferenceDataVersion=1';
  // One occurrence of a repeating event: Google names it <master id>_<original start>.
  if (e.recurringId && e.originalStart) {
    const master = linkFor(tasks, e.recurringId, s.linkId);
    if (!master) return {ok: true, skipped: 'repeating event not in Google yet'};
    const gid = `${master.google_id}_${basic(e.originalStart, e.allDay)}`;
    const body = what === 'delete' ? {status: 'cancelled'} : toGoogle(tasks, e, wsId);
    if (what !== 'delete') delete (body as Record<string, unknown>).recurrence;
    const r = await g(token, 'PATCH', `/calendars/${enc(master.calendar_id)}/events/${enc(gid)}${q}`, body);
    if (r.status >= 300) return {ok: false, error: fail(r).message};
    saveLinkRow(tasks, e.id, s.linkId, master.calendar_id, r.json as GEvent);
    return {ok: true};
  }
  const existing = linkFor(tasks, e.id, s.linkId);
  if (what === 'delete') {
    if (!existing) return {ok: true, skipped: 'not in Google'};
    const r = await g(token, 'DELETE', `/calendars/${enc(existing.calendar_id)}/events/${enc(existing.google_id)}?sendUpdates=all`);
    if (r.status >= 300 && r.status !== 404 && r.status !== 410) return {ok: false, error: fail(r).message};
    tasks.db.prepare('delete from event_links where event_id = ?').run(e.id);
    return {ok: true};
  }
  const body = toGoogle(tasks, e, wsId, opts);
  let r: G;
  if (existing) {
    r = await g(token, 'PATCH', `/calendars/${enc(existing.calendar_id)}/events/${enc(existing.google_id)}${q}`, body, existing.etag ? {'if-match': existing.etag} : {});
    if (r.status === 412) {
      // Changed in Google since we last saw it: Google's version wins and comes back into Cadence.
      const fresh = await g(token, 'GET', `/calendars/${enc(existing.calendar_id)}/events/${enc(existing.google_id)}`);
      if (fresh.status < 300) applyGoogle(tasks, e.organizer, s.linkId, existing.calendar_id, fresh.json as GEvent);
      return {ok: false, error: 'This event was changed in Google since Cadence last saw it. Cadence now shows the Google version; make your change again.'};
    }
  } else r = await g(token, 'POST', `/calendars/${enc(s.calendarId)}/events${q}`, body);
  if (r.status >= 300) return {ok: false, error: fail(r).message};
  const ge = r.json as GEvent;
  saveLinkRow(tasks, e.id, s.linkId, existing?.calendar_id ?? s.calendarId, ge);
  if (ge.hangoutLink && ge.hangoutLink !== e.meetUrl) tasks.db.prepare('update events set meet_url = ? where id = ?').run(ge.hangoutLink, e.id);
  return {ok: true, meetUrl: ge.hangoutLink ?? e.meetUrl};
}

// ---- Google to Cadence ----

const gTime = (t?: {date?: string; dateTime?: string}) => t?.dateTime ? new Date(t.dateTime).toISOString() : t?.date ? t.date + 'T00:00:00.000Z' : null;
function attendeesFrom(tasks: Tasks, ge: GEvent, owner: string): Attendee[] {
  const people = tasks.listPeople();
  const list: Attendee[] = [];
  const organizerEmail = ge.organizer?.email?.toLowerCase();
  for (const a of ge.attendees ?? []) {
    const email = a.email?.toLowerCase();
    if (!email || email.endsWith('resource.calendar.google.com')) continue;
    const p = a.self ? people.find(x => x.id === owner) : people.find(x => x.email?.toLowerCase() === email);
    const response = (['accepted', 'declined', 'tentative', 'needsAction'].includes(a.responseStatus ?? '') ? a.responseStatus : 'needsAction') as Attendee['response'];
    list.push({person: p?.id ?? null, email, name: a.displayName ?? p?.name ?? null, response, optional: !!a.optional});
  }
  // The calendar's owner is on their own events even when Google lists no attendees.
  if (!list.some(a => a.person === owner)) {
    const p = people.find(x => x.id === owner);
    if (p) list.unshift({person: owner, email: p.email ?? organizerEmail ?? null, name: p.name, response: 'accepted'});
  }
  return list;
}
/** Brings one Google event into Cadence (create, update, cancel). Returns the Cadence event id, if any. */
export function applyGoogle(tasks: Tasks, owner: string, linkId: string, cal: string, ge: GEvent): string | null {
  const known = tasks.db.prepare('select event_id, etag from event_links where link_id = ? and calendar_id = ? and google_id = ?').get(linkId, cal, ge.id) as {event_id: string; etag: string | null} | undefined;
  if (known && known.etag && ge.etag && known.etag === ge.etag) return known.event_id; // our own write coming back
  const mine = ge.extendedProperties?.private?.cadenceEvent;
  let localId = known?.event_id ?? (mine && tasks.db.prepare('select id from events where id = ?').get(mine) ? mine : null);
  // The same meeting already in Cadence from someone else's calendar.
  if (!localId && ge.iCalUID && !ge.recurringEventId) localId = (tasks.db.prepare('select event_id from event_links where ical_uid = ? limit 1').get(ge.iCalUID) as {event_id: string} | undefined)?.event_id ?? null;
  const masterLocal = ge.recurringEventId ? (tasks.db.prepare('select event_id from event_links where link_id = ? and calendar_id = ? and google_id = ?').get(linkId, cal, ge.recurringEventId) as {event_id: string} | undefined)?.event_id : null;
  const orig = ge.originalStartTime ? gTime(ge.originalStartTime) : null;
  if (!localId && masterLocal && orig) localId = (tasks.db.prepare('select id from events where recurring_id = ? and original_start = ?').get(masterLocal, orig) as {id: string} | undefined)?.id ?? null;

  if (ge.status === 'cancelled') {
    if (localId) tasks.db.prepare('update events set deleted = ?, updated = ? where id = ? or recurring_id = ?').run(now(), now(), localId, localId);
    else if (masterLocal && orig) {
      const m = getEvent(tasks, masterLocal);
      const x = createEvent(tasks, {title: m.title, start: orig, end: new Date(new Date(orig).getTime() + (new Date(m.end).getTime() - new Date(m.start).getTime())).toISOString(), allDay: m.allDay, tz: m.tz}, null,
        {organizer: m.organizer, recurringId: masterLocal, originalStart: orig, silent: true, source: m.source, readonly: m.readonly});
      tasks.db.prepare('update events set deleted = ? where id = ?').run(now(), x.id);
    }
    if (localId || masterLocal) tasks.emit({kind: 'events'});
    return localId;
  }
  const start = gTime(ge.start), end = gTime(ge.end);
  if (!start || !end) return null;
  const allDay = !!ge.start?.date;
  const tz = ge.start?.timeZone || calendarSettings(tasks, owner).tz;
  const attendees = attendeesFrom(tasks, ge, owner);
  const rrule = ge.recurrence?.length ? ge.recurrence.join('\n') : null;
  const organizerIsOwner = ge.organizer ? !!ge.organizer.self : true;
  if (localId) {
    const cur = getEvent(tasks, localId);
    if (cur.source === 'google' && !organizerIsOwner && !cur.readonly) { /* keep editable copy as is */ }
    // Another person's copy of a meeting we already have: only their own answer counts.
    if (known === undefined && cur.organizer !== owner && !mine) {
      const self = (ge.attendees ?? []).find(a => a.self);
      if (self?.responseStatus) tasks.db.prepare('update event_attendees set response = ? where event_id = ? and person = ?').run(self.responseStatus, localId, owner);
    } else {
      tasks.db.prepare('update events set title = ?, body = ?, location = ?, start = ?, end = ?, all_day = ?, tz = ?, rrule = ?, meet_url = coalesce(?, meet_url), updated = ?, deleted = null where id = ?')
        .run(ge.summary ?? '(no title)', stripLink(ge.description ?? ''), ge.location ?? '', start, end, allDay ? 1 : 0, tz, cur.recurringId ? null : rrule, ge.hangoutLink ?? null, now(), localId);
      tasks.db.prepare('delete from event_attendees where event_id = ?').run(localId);
      const ins = tasks.db.prepare('insert into event_attendees (event_id, person, email, name, response, optional) values (?,?,?,?,?,?)');
      for (const a of attendees) ins.run(localId, a.person, a.email, a.name ?? null, a.response, a.optional ? 1 : 0);
    }
    saveLinkRow(tasks, localId, linkId, cal, ge);
    tasks.emit({kind: 'events'});
    return localId;
  }
  const e = createEvent(tasks, {title: ge.summary ?? '(no title)', body: stripLink(ge.description ?? ''), location: ge.location ?? '', start, end, allDay, tz, rrule: masterLocal ? null : rrule,
    visibility: 'attendees', kind: 'meeting'}, null, {organizer: owner, source: 'google', readonly: !organizerIsOwner, silent: true,
    ...(masterLocal && orig ? {recurringId: masterLocal, originalStart: orig} : {})});
  tasks.db.prepare('delete from event_attendees where event_id = ?').run(e.id);
  const ins = tasks.db.prepare('insert into event_attendees (event_id, person, email, name, response, optional) values (?,?,?,?,?,?)');
  for (const a of attendees) ins.run(e.id, a.person, a.email, a.name ?? null, a.response, a.optional ? 1 : 0);
  if (ge.hangoutLink) tasks.db.prepare('update events set meet_url = ? where id = ?').run(ge.hangoutLink, e.id);
  saveLinkRow(tasks, e.id, linkId, cal, ge);
  tasks.emit({kind: 'events'});
  return e.id;
}
const stripLink = (s: string) => s.replace(/\n\nhttps?:\/\/\S+#\/open\/\w+\s*$/, '');

/** Reads changes from one Google calendar since the last sync (a full read of 30 days back to a year ahead the first time). */
export async function pullCalendar(tasks: Tasks, person: string, linkId: string, cal: string) {
  const token = await tok(tasks, person, linkId);
  const st = tasks.db.prepare('select sync_token from gcal_sync where link_id = ? and calendar_id = ?').get(linkId, cal) as {sync_token: string | null} | undefined;
  let syncToken = st?.sync_token ?? null, pageToken: string | null = null, next: string | null = null, n = 0;
  const params = () => {
    const p = new URLSearchParams({maxResults: '250', showDeleted: 'true', singleEvents: 'false'});
    if (pageToken) p.set('pageToken', pageToken);
    else if (syncToken) p.set('syncToken', syncToken);
    else { p.set('timeMin', new Date(Date.now() - 30 * 86400000).toISOString()); p.set('timeMax', new Date(Date.now() + 365 * 86400000).toISOString()); }
    return p;
  };
  for (let guard = 0; guard < 40; guard++) {
    const r = await g(token, 'GET', `/calendars/${enc(cal)}/events?${params()}`);
    if (r.status === 410) { syncToken = null; pageToken = null; continue; } // token expired: start over with a full read
    if (r.status >= 300) { tasks.db.prepare('insert into gcal_sync (link_id, calendar_id, error, last_sync) values (?,?,?,?) on conflict(link_id, calendar_id) do update set error = excluded.error').run(linkId, cal, fail(r).message, now()); throw fail(r); }
    // Masters before their changed occurrences, so occurrences find them.
    const items = ((r.json.items ?? []) as GEvent[]).sort((a, b) => Number(!!a.recurringEventId) - Number(!!b.recurringEventId));
    for (const ge of items) { try { applyGoogle(tasks, person, linkId, cal, ge); n++; } catch (e) { console.error('Google event skipped', ge.id, (e as Error).message); } }
    pageToken = (r.json.nextPageToken as string) ?? null;
    next = (r.json.nextSyncToken as string) ?? next;
    if (!pageToken) break;
  }
  tasks.db.prepare(`insert into gcal_sync (link_id, calendar_id, sync_token, last_sync, error) values (?,?,?,?,null)
    on conflict(link_id, calendar_id) do update set sync_token = excluded.sync_token, last_sync = excluded.last_sync, error = null`).run(linkId, cal, next ?? syncToken, now());
  return {changes: n};
}

/** Every person's chosen calendars. Errors are recorded per calendar and never stop the others. */
export async function pullAll(tasks: Tasks) {
  const out: {person: string; calendar: string; changes?: number; error?: string}[] = [];
  for (const p of tasks.listPeople()) {
    const s = calendarSettings(tasks, p.id);
    if (!s.linkId) continue;
    for (const cal of s.syncCalendars) {
      try { out.push({person: p.id, calendar: cal, ...(await pullCalendar(tasks, p.id, s.linkId, cal))}); }
      catch (e) { out.push({person: p.id, calendar: cal, error: (e as Error).message}); }
    }
  }
  return out;
}

// ---- Push notifications from Google (instant pulls) ----

export async function renewWatches(tasks: Tasks, wsId: string) {
  const base = publicUrl();
  if (!base?.startsWith('https://')) return;
  for (const p of tasks.listPeople()) {
    const s = calendarSettings(tasks, p.id);
    if (!s.linkId) continue;
    for (const cal of s.syncCalendars) {
      const row = tasks.db.prepare('select channel_id, resource_id, channel_expires from gcal_sync where link_id = ? and calendar_id = ?').get(s.linkId, cal) as {channel_id: string | null; resource_id: string | null; channel_expires: string | null} | undefined;
      if (row?.channel_expires && new Date(row.channel_expires).getTime() - Date.now() > 86400000) continue;
      try {
        const token = await tok(tasks, p.id, s.linkId);
        if (row?.channel_id && row.resource_id) await g(token, 'POST', '/channels/stop', {id: row.channel_id, resourceId: row.resource_id});
        const channelId = randomUUID(), secret = randomBytes(16).toString('hex');
        const r = await g(token, 'POST', `/calendars/${enc(cal)}/events/watch`, {id: channelId, type: 'web_hook', address: `${base}/api/google/push?ws=${enc(wsId)}`, token: secret});
        if (r.status >= 300) throw fail(r);
        tasks.db.prepare(`insert into gcal_sync (link_id, calendar_id, channel_id, resource_id, channel_token, channel_expires) values (?,?,?,?,?,?)
          on conflict(link_id, calendar_id) do update set channel_id = excluded.channel_id, resource_id = excluded.resource_id, channel_token = excluded.channel_token, channel_expires = excluded.channel_expires`)
          .run(s.linkId, cal, channelId, r.json.resourceId as string, secret, new Date(Number(r.json.expiration ?? Date.now() + 7 * 86400000)).toISOString());
      } catch (e) { console.error('Google watch failed', (e as Error).message); }
    }
  }
}
/** Google's ping that a watched calendar changed. Unknown or forged channels are ignored. */
export function onPush(tasks: Tasks, headers: Record<string, string | string[] | undefined>) {
  const h = (k: string) => String(headers[k] ?? '');
  const row = tasks.db.prepare('select link_id, calendar_id, channel_token from gcal_sync where channel_id = ? and resource_id = ?').get(h('x-goog-channel-id'), h('x-goog-resource-id')) as {link_id: string; calendar_id: string; channel_token: string} | undefined;
  if (!row || row.channel_token !== h('x-goog-channel-token')) return false;
  if (h('x-goog-resource-state') === 'sync') return true;
  const person = (tasks.db.prepare('select person from google_links where id = ?').get(row.link_id) as {person: string} | undefined)?.person;
  if (person) debounce(`pull:${row.link_id}:${row.calendar_id}`, 2000, () => pullCalendar(tasks, person, row.link_id, row.calendar_id).catch(e => console.error('Google pull failed', e.message)));
  return true;
}
const timers = new Map<string, ReturnType<typeof setTimeout>>();
function debounce(key: string, ms: number, f: () => unknown) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { timers.delete(key); f(); }, ms));
}

// ---- Task due dates on a calendar ----

const ref = (tasks: Tasks, i: Item) => `${tasks.project(i.projectId).key}-${i.number}`;
export async function pushItem(tasks: Tasks, wsId: string, itemId: string) {
  let it: Item | null = null;
  try { it = tasks.item(itemId); } catch { it = null; }
  const rows = tasks.db.prepare('select * from gcal_items where item_id = ?').all(itemId) as {person: string; link_id: string; calendar_id: string; google_id: string; etag: string | null}[];
  const people = new Set([...rows.map(r => r.person), ...(it?.assignees ?? [])]);
  for (const person of people) {
    const s = calendarSettings(tasks, person);
    const row = rows.find(r => r.person === person);
    const want = !!it && s.pushTasks === 'due' && !!s.linkId && it.assignees.includes(person) && !!it.due && !(it.completed && s.doneRule === 'delete');
    try {
      if (!want) {
        if (row) {
          const token = await tok(tasks, person, row.link_id);
          await g(token, 'DELETE', `/calendars/${enc(row.calendar_id)}/events/${enc(row.google_id)}`);
          tasks.db.prepare('delete from gcal_items where person = ? and item_id = ?').run(person, itemId);
        }
        continue;
      }
      const token = await tok(tasks, person, s.linkId!);
      const cal = s.tasksCalendarId || s.calendarId;
      const endDay = new Date(new Date(it!.due! + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
      const base = publicUrl();
      const body = {summary: `${it!.completed ? '[Done] ' : ''}${ref(tasks, it!)} ${it!.title}`.slice(0, 300), start: {date: it!.due}, end: {date: endDay}, transparency: 'transparent',
        description: base ? `${base}/?ws=${wsId}#/open/${it!.id}` : undefined, extendedProperties: {private: {cadenceItem: it!.id, cadenceWs: wsId}}};
      let r: G;
      if (row && row.calendar_id === cal) r = await g(token, 'PATCH', `/calendars/${enc(cal)}/events/${enc(row.google_id)}`, body);
      else {
        if (row) await g(await tok(tasks, person, row.link_id), 'DELETE', `/calendars/${enc(row.calendar_id)}/events/${enc(row.google_id)}`);
        r = await g(token, 'POST', `/calendars/${enc(cal)}/events`, body);
      }
      if (r.status === 404 || r.status === 410) r = await g(token, 'POST', `/calendars/${enc(cal)}/events`, body);
      if (r.status >= 300) throw fail(r);
      tasks.db.prepare(`insert into gcal_items (person, item_id, link_id, calendar_id, google_id, etag) values (?,?,?,?,?,?)
        on conflict(person, item_id) do update set link_id = excluded.link_id, calendar_id = excluded.calendar_id, google_id = excluded.google_id, etag = excluded.etag`)
        .run(person, itemId, s.linkId, cal, r.json.id as string, (r.json.etag as string) ?? null);
    } catch (e) { console.error('Due date to Google failed', itemId, (e as Error).message); }
  }
}
/** Puts every due date for one person on their calendar (after they turn it on or change calendars). */
export async function pushAllItems(tasks: Tasks, wsId: string, person: string) {
  const items = tasks.listItems({}).filter(i => i.assignees.includes(person) && i.due);
  const old = (tasks.db.prepare('select item_id from gcal_items where person = ?').all(person) as {item_id: string}[]).map(r => r.item_id);
  for (const id of new Set([...items.map(i => i.id), ...old])) await pushItem(tasks, wsId, id);
  return {items: items.length};
}

/** Makes a calendar named "Cadence" for due dates (needs the full Calendar permission) and selects it. */
export async function createCadenceCalendar(tasks: Tasks, person: string) {
  const s = calendarSettings(tasks, person);
  if (!s.linkId) throw new Invalid('Connect Google Calendar first');
  const link = listLinks(tasks.db, person).find(l => l.id === s.linkId)!;
  if (!link.scopes.split(/\s+/).includes(FULL_SCOPE)) throw new Invalid('Creating a calendar needs full Calendar permission. Use "Allow creating a Cadence calendar" to reconnect, or pick an existing calendar.');
  const token = await access(tasks.db, person, s.linkId, 'calendar');
  const r = await g(token, 'POST', '/calendars', {summary: 'Cadence', description: 'Task due dates from Cadence', timeZone: s.tz});
  if (r.status >= 300) throw fail(r);
  return saveCalendarSettings(tasks, person, {tasksCalendarId: r.json.id as string});
}

// ---- Free and busy ----

export async function googleBusy(tasks: Tasks, people: string[], emails: string[], organizer: string | null, from: string, to: string): Promise<Map<string, Busy[]>> {
  const out = new Map<string, Busy[]>();
  const range = {timeMin: new Date(from + 'T00:00:00Z').toISOString(), timeMax: new Date(to + 'T23:59:59Z').toISOString()};
  for (const p of people) {
    const s = calendarSettings(tasks, p);
    if (!s.linkId) continue;
    try {
      const token = await tok(tasks, p, s.linkId);
      const r = await g(token, 'POST', '/freeBusy', {...range, items: s.syncCalendars.map(id => ({id}))});
      if (r.status < 300) out.set(p, Object.values((r.json.calendars ?? {}) as Record<string, {busy?: Busy[]}>).flatMap(c => c.busy ?? []));
    } catch { /* no access: Cadence events still count */ }
  }
  // Outside people: only works when their calendar is shared with the organizer.
  const os = organizer ? calendarSettings(tasks, organizer) : null;
  if (emails.length && organizer && os?.linkId) {
    try {
      const token = await tok(tasks, organizer, os.linkId);
      const r = await g(token, 'POST', '/freeBusy', {...range, items: emails.map(id => ({id}))});
      if (r.status < 300) for (const [k, v] of Object.entries((r.json.calendars ?? {}) as Record<string, {busy?: Busy[]; errors?: unknown[]}>)) if (!v.errors?.length) out.set(k, v.busy ?? []);
    } catch { /* ignore */ }
  }
  return out;
}
export async function allBusy(tasks: Tasks, people: string[], emails: string[], organizer: string | null, from: string, to: string) {
  const local = cadenceBusy(tasks, people, from, to), google = await googleBusy(tasks, people, emails, organizer, from, to);
  for (const [k, v] of google) local.set(k, [...(local.get(k) ?? []), ...v]);
  return local;
}

// ---- Wiring per workspace ----

/** Sync results of the last pushes, so the API can report them with the save. */
const pending = new WeakMap<Tasks, Promise<PushResult>[]>();
export async function flushGoogle(guardedTasks: Tasks): Promise<PushResult | null> {
  const tasks = raw(guardedTasks);
  const list = pending.get(tasks) ?? [];
  pending.set(tasks, []);
  if (!list.length) return null;
  const results = await Promise.all(list);
  return results.find(r => !r.ok) ?? results.find(r => r.meetUrl) ?? results[0];
}
export function startCalendarSync(tasks: Tasks, wsId: string, opts: {poll?: boolean} = {}) {
  migrateGcal(tasks);
  const queue = (p: Promise<PushResult>) => { const safe = p.catch(e => ({ok: false, error: (e as Error).message})); pending.set(tasks, [...(pending.get(tasks) ?? []), safe]); };
  onEvent(tasks, {
    created: (e, o) => queue(pushEvent(tasks, wsId, e, 'upsert', o)),
    changed: (_b, a) => queue(pushEvent(tasks, wsId, a, 'upsert')),
    removed: (e) => queue(pushEvent(tasks, wsId, e, 'delete')),
  });
  tasks.on((c: ChangeEvent) => {
    if (c.kind === 'item') debounce(`item:${c.item.id}`, 1500, () => pushItem(tasks, wsId, c.item.id));
    if (c.kind === 'item-deleted') debounce(`item:${c.id}`, 1500, () => pushItem(tasks, wsId, c.id));
  });
  if (opts.poll === false) return;
  const tick = async () => { try { await pullAll(tasks); await renewWatches(tasks, wsId); } catch (e) { console.error('Calendar sync failed', (e as Error).message); } };
  setTimeout(tick, 20_000).unref();
  setInterval(tick, 5 * 60 * 1000).unref();
}
