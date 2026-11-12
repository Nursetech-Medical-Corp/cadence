import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {migrateGoogleLinks, saveLink} from '../server/googlelinks.ts';
import {busyHours, createEvent, deleteEvent, freeSlots, listEvents, migrateEvents, occurrences, saveCalendarSettings, timeblockItem, updateEvent, zoned, cadenceBusy} from '../server/events.ts';
import {applyGoogle, migrateGcal, pullCalendar, pushEvent, pushItem, toGoogle} from '../server/gcal.ts';
import {migratePlanning, replan} from '../server/planner.ts';
import {migrate, saveWorkspace} from '../server/auth.ts';
import {migrateAiWork} from '../server/aiwork.ts';

function setup() {
  const t = new Tasks(openDb(':memory:'), () => '2026-11-10');
  migrate(t.db);
  migratePlanning(t);
  migrateAiWork(t);
  migrateGoogleLinks(t.db);
  migrateEvents(t);
  migrateGcal(t);
  const dave = t.createPerson({name: 'David', email: 'david@x.test'}), sam = t.createPerson({name: 'Sam', email: 'sam@x.test'});
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  return {t, dave, sam, p};
}

test('weekly repeats keep wall-clock time across daylight saving', () => {
  // Mondays 10:00 Denver: 17:00Z in October (MDT), 17:00Z becomes 18:00Z after Nov 1 (MST).
  const start = zoned(2026, 10, 26, 10, 0, 'America/Denver').toISOString();
  assert.equal(start, '2026-10-26T16:00:00.000Z');
  const list = occurrences(start, 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'America/Denver', new Date('2026-10-20T00:00:00Z'), new Date('2026-11-20T00:00:00Z'), 1800000);
  assert.deepEqual(list.map(d => d.toISOString()), ['2026-10-26T16:00:00.000Z', '2026-11-02T17:00:00.000Z', '2026-11-09T17:00:00.000Z', '2026-11-16T17:00:00.000Z']);
  // Monthly second Tuesday, COUNT and EXDATE.
  const m = occurrences('2026-11-10T15:00:00.000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3\nEXDATE:20261208T150000Z', 'UTC', new Date('2026-11-01T00:00:00Z'), new Date('2027-06-01T00:00:00Z'), 3600000);
  assert.deepEqual(m.map(d => d.toISOString().slice(0, 10)), ['2026-11-10', '2027-01-12']);
  assert.throws(() => occurrences(start, 'RRULE:FREQ=HOURLY', 'UTC', new Date(), new Date(), 0), /FREQ/);
});

test('meetings: create, invite, list, change one occurrence, cancel, permissions', () => {
  const {t, dave, sam, p} = setup();
  const e = createEvent(t, {title: 'Weekly ops review', start: '2026-11-16T10:00:00-07:00', duration: 60, tz: 'America/Denver', attendees: ['Sam', 'partner@outside.test'], rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO', projectId: p.id}, dave.id);
  assert.equal(e.attendees.length, 3, 'organizer, Sam, outside guest');
  assert.equal(e.attendees[0].person, dave.id);
  assert.match(t.listNotifications(sam.id)[0].text, /invited you to "Weekly ops review"/);
  const month = listEvents(t, {from: '2026-11-01', to: '2026-11-30', person: dave.id});
  assert.deepEqual(month.map(x => x.start), ['2026-11-16T17:00:00.000Z', '2026-11-23T17:00:00.000Z', '2026-11-30T17:00:00.000Z']);
  // Move only Nov 23 to 11:00.
  const moved = updateEvent(t, e.id, {start: '2026-11-23T11:00:00-07:00', duration: 60}, dave.id, {scope: 'one', occurrence: '2026-11-23T17:00:00.000Z'});
  assert.equal(moved.recurringId, e.id);
  const after = listEvents(t, {from: '2026-11-01', to: '2026-11-30', person: dave.id});
  assert.deepEqual(after.map(x => x.start), ['2026-11-16T17:00:00.000Z', '2026-11-23T18:00:00.000Z', '2026-11-30T17:00:00.000Z']);
  // Cancel Nov 30 only.
  deleteEvent(t, e.id, dave.id, {scope: 'one', occurrence: '2026-11-30T17:00:00.000Z'});
  assert.equal(listEvents(t, {from: '2026-11-01', to: '2026-11-30', person: dave.id}).length, 2);
  // Only the organizer changes it; attendees answer.
  assert.throws(() => updateEvent(t, e.id, {title: 'Hijack'}, sam.id), /Only the organizer/);
  updateEvent(t, e.id, {response: 'declined'}, sam.id);
  assert.equal(listEvents(t, {from: '2026-11-16', to: '2026-11-16', person: sam.id})[0].attendees.find(a => a.person === sam.id)?.response, 'declined');
  // Private events stay private.
  createEvent(t, {title: 'Doctor', start: '2026-11-17T09:00:00-07:00', duration: 30, visibility: 'private'}, dave.id);
  assert.ok(!listEvents(t, {from: '2026-11-17', to: '2026-11-17', person: sam.id}).some(x => x.title === 'Doctor'));
  assert.ok(listEvents(t, {from: '2026-11-17', to: '2026-11-17', person: dave.id}).some(x => x.title === 'Doctor'));
  // Validation.
  assert.throws(() => createEvent(t, {title: 'Bad', start: '2026-11-17T10:00:00Z', end: '2026-11-17T09:00:00Z'}, dave.id), /end must be after start/);
  assert.throws(() => createEvent(t, {title: 'Bad', start: '2026-11-17T10:00:00Z', attendees: ['nobody']}, dave.id), /Unknown person or bad email/);
  // Cancel all.
  deleteEvent(t, e.id, dave.id);
  assert.equal(listEvents(t, {from: '2026-11-01', to: '2026-11-30', person: dave.id}).filter(x => x.title.startsWith('Weekly')).length, 0);
  assert.match(t.listNotifications(sam.id)[0].text, /cancelled "Weekly ops review"/);
});

test('meetings reduce planning capacity; free time and time-blocks', () => {
  const {t, dave, sam, p} = setup();
  // 6 hours of meetings on Wed Nov 11 for David.
  createEvent(t, {title: 'Offsite', start: '2026-11-11T09:00:00-07:00', end: '2026-11-11T15:00:00-07:00'}, dave.id);
  const busy = busyHours(t, '2026-11-09', '2026-11-15');
  assert.equal(busy.get(dave.id)?.get('2026-11-11'), 6);
  const it = t.createItem({projectId: p.id, title: 'Write report', assignees: [dave.id], estimate: 6, due: '2026-11-09'});
  t.db.prepare("update people set weekly_hours = 40 where id = ?").run(dave.id);
  const plan = replan(t, {projectId: p.id});
  const c = plan.changes.find(x => x.itemId === it.id)!;
  // 8h per day; Wednesday has only 2h left, so 6h runs Tue (today) 6h... starts 2026-11-10.
  assert.equal(c.to.start, '2026-11-10');
  assert.equal(c.to.due, '2026-11-10');
  const it2 = t.createItem({projectId: p.id, title: 'Second', assignees: [dave.id], estimate: 6, due: '2026-11-09'});
  const c2 = replan(t, {projectId: p.id}).changes.find(x => x.itemId === it2.id)!;
  assert.equal(c2.to.due, '2026-11-12', '2h left Tue, 2h Wed (meetings), 2h Thu');

  // Free slots for David and Sam on Wed Nov 11 between 9 and 17 Denver: David busy 9 to 15.
  const slots = freeSlots(cadenceBusy(t, [dave.id, sam.id], '2026-11-11', '2026-11-11'), {from: '2026-11-11', to: '2026-11-11', durationMin: 60, tz: 'America/Denver', workStart: '09:00', workEnd: '17:00', max: 3});
  if (Date.now() < new Date('2026-11-11T22:00:00Z').getTime()) assert.equal(slots[0].start, '2026-11-11T22:00:00.000Z', '15:00 Denver');

  const tb = timeblockItem(t, it.id, '2026-11-12T09:00:00-07:00', '2026-11-12T11:00:00-07:00', dave.id);
  assert.equal(tb.event.kind, 'timeblock');
  assert.equal(tb.event.itemId, it.id);
  assert.equal(tb.pastDue, true);
  assert.match(tb.note, /ends after the task is due/);
});

test('Google: event body, push with Meet and attendees, two-way pull, conflicts, dedupe, due dates', async () => {
  const {t, dave, sam, p} = setup();
  saveWorkspace(t.db, {google: {clientId: 'c', clientSecret: 's'}} as never);
  saveLink(t.db, dave.id, 'david@x.test', 'refresh-d', 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events');
  saveLink(t.db, sam.id, 'sam@x.test', 'refresh-s', 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events');
  const calls: {method: string; url: string; body: any; headers: Record<string, string>}[] = [];
  const google = new Map<string, any>();
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const u = String(url), method = init.method ?? 'GET', body = init.body ? (init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init.body)) : null;
    calls.push({method, url: u, body, headers: init.headers ?? {}});
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), {status});
    if (u.includes('oauth2.googleapis.com/token')) return json(200, {access_token: 'at'});
    if (u.includes('/events') && method === 'POST' && !u.includes('watch')) {
      const ge = {...body, id: 'g' + ++n, etag: '"e' + n + '"', updated: new Date().toISOString(), iCalUID: 'uid' + n + '@google.com', hangoutLink: body.conferenceData ? 'https://meet.google.com/abc-defg-hij' : undefined, organizer: {self: true}};
      google.set(ge.id, ge);
      return json(200, ge);
    }
    if (method === 'PATCH') {
      const id = decodeURIComponent(u.split('/events/')[1].split('?')[0]);
      if (init.headers?.['if-match'] === '"stale"') return json(412, {error: {message: 'Precondition Failed'}});
      const ge = {...(google.get(id) ?? {id}), ...body, etag: '"e' + ++n + '"', updated: new Date().toISOString()};
      google.set(id, ge);
      return json(200, ge);
    }
    if (method === 'DELETE') { google.delete(decodeURIComponent(u.split('/events/')[1].split('?')[0])); return new Response(null, {status: 204}); }
    if (method === 'GET' && u.includes('/events/')) return json(200, google.get(decodeURIComponent(u.split('/events/')[1].split('?')[0])));
    if (method === 'GET' && u.includes('/events?')) return json(200, {items: (globalThis as any).__pull ?? [], nextSyncToken: 'sync-1'});
    return json(404, {error: {message: 'not mocked ' + u}});
  }) as typeof fetch;
  try {
    // Push: a meeting with Meet and attendees goes to David's primary calendar with invitations.
    const e = createEvent(t, {title: 'Board prep', start: '2026-11-16T10:00:00-07:00', duration: 45, attendees: ['Sam', 'jason@board.test'], projectId: p.id}, dave.id, {silent: true});
    const body = toGoogle(t, e, 'main', {meet: true}) as any;
    assert.deepEqual(body.attendees.map((a: any) => a.email), ['sam@x.test', 'jason@board.test']);
    assert.equal(body.start.timeZone, 'America/Denver');
    assert.ok(body.conferenceData.createRequest.requestId);
    const r = await pushEvent(t, 'main', e, 'upsert', {meet: true});
    assert.equal(r.ok, true);
    assert.equal(r.meetUrl, 'https://meet.google.com/abc-defg-hij');
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/calendars/primary/events'))!;
    assert.match(post.url, /sendUpdates=all/);
    assert.match(post.url, /conferenceDataVersion=1/);
    // Change in Cadence: PATCH with the etag.
    const e2 = updateEvent(t, e.id, {title: 'Board prep (moved)'}, dave.id, {silent: true});
    assert.equal((await pushEvent(t, 'main', e2, 'upsert')).ok, true);
    assert.equal(calls.at(-1)!.method, 'PATCH');
    assert.equal(calls.at(-1)!.headers['if-match'], '"e1"');
    // Conflict: Google changed since we last saw it, Google wins and comes back.
    t.db.prepare("update event_links set etag = '\"stale\"' where event_id = ?").run(e.id);
    google.set('g1', {...google.get('g1'), summary: 'Board prep (renamed in Google)'});
    const conflict = await pushEvent(t, 'main', e2, 'upsert');
    assert.equal(conflict.ok, false);
    assert.match(conflict.error!, /changed in Google/);
    assert.equal(listEvents(t, {from: '2026-11-16', to: '2026-11-16', person: dave.id})[0].title, 'Board prep (renamed in Google)');

    // Pull: an event created in Google comes into Cadence; someone else's event is read-only.
    (globalThis as any).__pull = [
      {id: 'x1', status: 'confirmed', summary: 'Dentist', start: {dateTime: '2026-11-18T08:00:00-07:00', timeZone: 'America/Denver'}, end: {dateTime: '2026-11-18T09:00:00-07:00'}, organizer: {self: true}, etag: '"x1"', iCalUID: 'x1@google.com'},
      {id: 'x2', status: 'confirmed', summary: 'Vendor call', start: {dateTime: '2026-11-19T12:00:00-07:00'}, end: {dateTime: '2026-11-19T12:30:00-07:00'}, organizer: {email: 'vendor@v.test'}, attendees: [{email: 'david@x.test', self: true, responseStatus: 'accepted'}], etag: '"x2"', iCalUID: 'x2@google.com'},
    ];
    const pulled = await pullCalendar(t, dave.id, (t.db.prepare('select id from google_links where person = ?').get(dave.id) as {id: string}).id, 'primary');
    assert.equal(pulled.changes, 2);
    const week = listEvents(t, {from: '2026-11-16', to: '2026-11-20', person: dave.id});
    assert.ok(week.some(x => x.title === 'Dentist' && !x.readonly && x.source === 'google'));
    const vendor = week.find(x => x.title === 'Vendor call')!;
    assert.equal(vendor.readonly, true);
    assert.throws(() => updateEvent(t, vendor.id, {title: 'x'}, dave.id), /someone else's Google calendar/);
    assert.equal((t.db.prepare("select sync_token from gcal_sync where calendar_id = 'primary'").get() as {sync_token: string}).sync_token, 'sync-1');
    // Cancelled in Google: gone in Cadence.
    const samLink = (t.db.prepare('select id from google_links where person = ?').get(sam.id) as {id: string}).id;
    applyGoogle(t, dave.id, (t.db.prepare('select id from google_links where person = ?').get(dave.id) as {id: string}).id, 'primary', {id: 'x1', status: 'cancelled'});
    assert.ok(!listEvents(t, {from: '2026-11-16', to: '2026-11-20', person: dave.id}).some(x => x.title === 'Dentist'));
    // Sam's copy of David's meeting (same iCalUID) is the same Cadence event: Sam's answer updates it, no duplicate.
    applyGoogle(t, sam.id, samLink, 'primary', {id: 'samcopy', status: 'confirmed', summary: 'Board prep', iCalUID: google.get('g1').iCalUID, start: {dateTime: '2026-11-16T10:00:00-07:00'}, end: {dateTime: '2026-11-16T10:45:00-07:00'},
      organizer: {email: 'david@x.test'}, attendees: [{email: 'sam@x.test', self: true, responseStatus: 'accepted'}], etag: '"s1"'});
    const both = listEvents(t, {from: '2026-11-16', to: '2026-11-16', person: sam.id});
    assert.equal(both.length, 1);
    assert.equal(both[0].attendees.find(a => a.person === sam.id)?.response, 'accepted');

    // Due dates on a calendar.
    saveCalendarSettings(t, dave.id, {pushTasks: 'due'});
    const it = t.createItem({projectId: p.id, title: 'File RT-6', assignees: [dave.id], due: '2026-11-30'});
    await pushItem(t, 'main', it.id);
    const due = calls.filter(c => c.method === 'POST' && c.body?.extendedProperties?.private?.cadenceItem === it.id);
    assert.equal(due.length, 1);
    assert.deepEqual(due[0].body.start, {date: '2026-11-30'});
    assert.equal(due[0].body.end.date, '2026-12-01');
    t.updateItem(it.id, {status: p.statuses.find(s => s.category === 'done')!.id});
    await pushItem(t, 'main', it.id);
    assert.match(calls.at(-1)!.body.summary, /^\[Done\] OPS-1/);
    t.updateItem(it.id, {assignees: []});
    await pushItem(t, 'main', it.id);
    assert.equal(calls.at(-1)!.method, 'DELETE');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('events API and MCP tools', async () => {
  process.env.TASKS_NO_SYNC = '1';
  const {createServer} = await import('node:http');
  const {apiMiddleware} = await import('../server/api.ts');
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {InMemoryTransport} = await import('@modelcontextprotocol/sdk/inMemory.js');
  const {createMcpServer} = await import('../server/mcp.ts');
  const t = new Tasks(openDb(':memory:'), () => '2026-11-10');
  const mw = apiMiddleware(t);
  const [dave, sam] = [t.createPerson({name: 'David', email: 'd@x.test'}), t.createPerson({name: 'Sam', email: 's@x.test'})];
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; person?: string} = {}) => {
    const r = await fetch(base + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.person ? {'x-person': init.person} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  try {
    const made = await call('/meetings', {method: 'POST', person: dave.id, body: {title: 'Standup', start: '2026-11-16T09:00:00-07:00', duration: 15, attendees: [sam.id], rrule: 'RRULE:FREQ=DAILY;COUNT=5'}});
    assert.equal(made.status, 201);
    assert.equal(made.json.google?.skipped, 'organizer has no Google calendar connected');
    const list = await call('/meetings?from=2026-11-16&to=2026-11-22&mine=1', {person: sam.id});
    assert.equal(list.json.length, 5);
    assert.equal((await call(`/meetings/${made.json.id}`, {method: 'PATCH', person: sam.id, body: {title: 'Mine now'}})).status, 400);
    assert.equal((await call(`/meetings/${made.json.id}?scope=one&occurrence=${encodeURIComponent(list.json[1].originalStart)}`, {method: 'DELETE', person: dave.id})).status, 200);
    assert.equal((await call('/meetings?from=2026-11-16&to=2026-11-22', {person: dave.id})).json.length, 4);
    assert.equal((await call('/calendar/settings', {method: 'PUT', person: dave.id, body: {workStart: '08:00', workEnd: '16:00'}})).json.workStart, '08:00');
    assert.equal((await call('/calendar/settings', {method: 'PUT', person: dave.id, body: {workStart: '17:00', workEnd: '08:00'}})).status, 400);
    const free = await call('/meetings/free', {method: 'POST', person: dave.id, body: {attendees: ['Sam'], duration: 30, from: '2027-01-04', to: '2027-01-04'}});
    assert.equal(free.status, 200);
    assert.ok(free.json.slots.length > 0);
    // Google's push endpoint refuses unknown channels.
    const ping = await fetch(base + '/google/push', {method: 'POST', headers: {'x-goog-channel-id': 'nope', 'x-goog-resource-id': 'x', 'x-goog-channel-token': 'y'}});
    assert.equal(ping.status, 404);

    const mcp = createMcpServer(t, dave.id);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({name: 't', version: '1'});
    await Promise.all([mcp.connect(a), client.connect(b)]);
    const res = await client.callTool({name: 'create_event', arguments: {title: 'Investor call', start: '2026-11-18T14:00:00-07:00', duration: 30, attendees: ['Sam']}});
    assert.ok(!res.isError, JSON.stringify(res.content));
    const ev = await client.callTool({name: 'list_events', arguments: {from: '2026-11-18', to: '2026-11-18'}});
    assert.match((ev.content as {text: string}[])[0].text, /Investor call/);
    t.db.prepare("update people set kind = 'ai' where id = ?").run(sam.id);
    const bot = createMcpServer(t, sam.id);
    const [a2, b2] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({name: 't2', version: '1'});
    await Promise.all([bot.connect(a2), c2.connect(b2)]);
    const refused = await c2.callTool({name: 'create_event', arguments: {title: 'Outside', start: '2026-11-18T15:00:00-07:00', attendees: ['someone@outside.test']}});
    assert.ok(refused.isError);
    assert.match((refused.content as {text: string}[])[0].text, /do not invite people outside/);
  } finally {
    server.close();
  }
});
