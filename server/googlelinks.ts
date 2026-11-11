// Personal Google connections: each person can link one or more Google accounts to read their calendars
// (and add events) and, if they choose, read their Gmail. Uses the workspace's OAuth client (Team page).
// Refresh tokens are stored in this workspace's database and never leave it in exports.
import {randomBytes} from 'node:crypto';
import type {Db} from './db.ts';
import {getWorkspace} from './auth.ts';
import {Invalid, NotFound} from './errors.ts';

export const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
} as const;
export type Link = {id: string; person: string; email: string; scopes: string; created: string};

export function migrateGoogleLinks(db: Db) {
  db.exec('create table if not exists google_links (id text primary key, person text not null, email text not null, refresh_token text not null, scopes text not null, created text not null)');
}
export const listLinks = (db: Db, person: string): Link[] =>
  db.prepare('select id, person, email, scopes, created from google_links where person = ? order by created').all(person).map(r => ({id: r.id as string, person: r.person as string, email: r.email as string, scopes: r.scopes as string, created: r.created as string}));
export function saveLink(db: Db, person: string, email: string, refresh: string, scopes: string) {
  const cur = db.prepare('select id from google_links where person = ? and lower(email) = lower(?)').get(person, email) as {id: string} | undefined;
  if (cur) db.prepare('update google_links set refresh_token = ?, scopes = ? where id = ?').run(refresh, scopes, cur.id);
  else db.prepare('insert into google_links (id, person, email, refresh_token, scopes, created) values (?,?,?,?,?,?)').run(randomBytes(6).toString('hex'), person, email, refresh, scopes, new Date().toISOString());
}
export const removeLink = (db: Db, person: string, id: string) => { db.prepare('delete from google_links where id = ? and person = ?').run(id, person); };

async function access(db: Db, person: string, linkId: string, need: string) {
  const r = db.prepare('select * from google_links where id = ? and person = ?').get(linkId, person) as {refresh_token: string; scopes: string; email: string} | undefined;
  if (!r) throw new NotFound('That Google account is not connected');
  if (!r.scopes.includes(need)) throw new Invalid(`${r.email} was connected without ${need.includes('gmail') ? 'Gmail' : 'Calendar'} access. Connect it again and allow it.`);
  const g = getWorkspace(db).google;
  const t = await fetch('https://oauth2.googleapis.com/token', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({refresh_token: r.refresh_token, client_id: g.clientId, client_secret: g.clientSecret, grant_type: 'refresh_token'})});
  const j = await t.json() as {access_token?: string; error_description?: string; error?: string};
  if (!t.ok || !j.access_token) throw new Invalid(`Google refused access for ${r.email}: ${j.error_description ?? j.error ?? t.status}. Try connecting again.`);
  return j.access_token;
}
async function get<T>(token: string, url: string): Promise<T> {
  const r = await fetch(url, {headers: {authorization: `Bearer ${token}`}});
  const j = await r.json() as T & {error?: {message?: string}};
  if (!r.ok) throw new Invalid(`Google: ${j.error?.message ?? r.status}`);
  return j;
}

export async function calendars(db: Db, person: string, linkId: string) {
  const t = await access(db, person, linkId, 'calendar');
  const j = await get<{items: {id: string; summary: string; primary?: boolean; backgroundColor?: string; accessRole: string}[]}>(t, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100');
  return j.items.map(c => ({id: c.id, name: c.summary, primary: !!c.primary, color: c.backgroundColor ?? null, canWrite: ['owner', 'writer'].includes(c.accessRole)}));
}
export type GEvent = {id: string; calendar: string; title: string; start: string; end: string; allDay: boolean; link: string | null; account: string};
/** Events between two dates (YYYY-MM-DD) from the chosen calendars of every connected account (primary if none chosen). */
export async function events(db: Db, person: string, from: string, to: string, pick?: Record<string, string[]>) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Invalid('from and to must be dates like 2026-11-30');
  const out: GEvent[] = [];
  for (const l of listLinks(db, person).filter(l => l.scopes.includes('calendar'))) {
    const t = await access(db, person, l.id, 'calendar');
    for (const cal of pick?.[l.id]?.length ? pick[l.id] : ['primary']) {
      const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`);
      u.search = new URLSearchParams({timeMin: `${from}T00:00:00Z`, timeMax: `${to}T23:59:59Z`, singleEvents: 'true', orderBy: 'startTime', maxResults: '250'}).toString();
      const j = await get<{items: {id: string; summary?: string; start: {date?: string; dateTime?: string}; end: {date?: string; dateTime?: string}; htmlLink?: string; status?: string}[]}>(t, u.toString());
      for (const e of j.items) if (e.status !== 'cancelled') out.push({id: e.id, calendar: cal, title: e.summary ?? '(no title)', start: e.start.dateTime ?? e.start.date!, end: e.end.dateTime ?? e.end.date!, allDay: !!e.start.date, link: e.htmlLink ?? null, account: l.email});
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
/** Adds an all-day event (for example a task's due date) to a calendar. */
export async function addEvent(db: Db, person: string, linkId: string, calendar: string, input: {title: string; date: string; description?: string}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Invalid('date must look like 2026-11-30');
  const t = await access(db, person, linkId, 'calendar.events');
  const end = new Date(input.date + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1);
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar || 'primary')}/events`, {
    method: 'POST', headers: {authorization: `Bearer ${t}`, 'content-type': 'application/json'},
    body: JSON.stringify({summary: input.title.slice(0, 300), description: input.description?.slice(0, 5000), start: {date: input.date}, end: {date: end.toISOString().slice(0, 10)}}),
  });
  const j = await r.json() as {id?: string; htmlLink?: string; error?: {message?: string}};
  if (!r.ok) throw new Invalid(`Google: ${j.error?.message ?? r.status}`);
  return {id: j.id, link: j.htmlLink};
}
/** Recent emails matching a Gmail search, as subject, sender, date and snippet. */
export async function gmailSearch(db: Db, person: string, linkId: string, q: string, max = 10) {
  const t = await access(db, person, linkId, 'gmail');
  const list = await get<{messages?: {id: string}[]}>(t, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(25, Math.max(1, max))}&q=${encodeURIComponent(q)}`);
  const out = [];
  for (const m of list.messages ?? []) {
    const msg = await get<{id: string; threadId: string; snippet: string; payload: {headers: {name: string; value: string}[]}}>(t, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
    const h = (n: string) => msg.payload.headers.find(x => x.name.toLowerCase() === n.toLowerCase())?.value ?? '';
    out.push({id: msg.id, subject: h('Subject'), from: h('From'), date: h('Date'), snippet: msg.snippet, link: `https://mail.google.com/mail/u/0/#all/${msg.threadId}`});
  }
  return out;
}
