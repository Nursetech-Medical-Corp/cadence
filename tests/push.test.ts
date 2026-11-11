import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDecipheriv, createECDH, createPublicKey, hkdfSync, verify, type ECDH} from 'node:crypto';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {apiMiddleware} from '../server/api.ts';
import {encrypt, makeVapid, transport, vapidHeader} from '../server/push.ts';
import {quietNow, DEFAULT_NOTIFY} from '../server/accounts.ts';

process.env.TASKS_BACKUPS = mkdtempSync(join(tmpdir(), 'tasks-push-'));
const b64 = (s: string) => Buffer.from(s, 'base64url');

/** The receiving side of RFC 8291, as a browser does it. */
function decrypt(body: Buffer, ua: ECDH, auth: Buffer) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ikm = Buffer.from(hkdfSync('sha256', ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}

test('push encryption matches the RFC 8291 example; VAPID signatures verify', () => {
  const out = encrypt(Buffer.from('When I grow up, I want to be a watermelon'), b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    b64('BTBZMqHH6r4Tts7J_aSIgg'), b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), b64('DGv6ra1nlYgDCS1FRnbzlw'));
  assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');

  const v = makeVapid(), header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', v, 'mailto:owner@example.test');
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  assert.equal(k, v.publicKey);
  const [h, c, sig] = jwt.split('.');
  const claims = JSON.parse(b64(c).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:owner@example.test');
  const pub = b64(v.publicKey);
  const key = createPublicKey({key: {kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url')}, format: 'jwk'});
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), {key, dsaEncoding: 'ieee-p1363'}, b64(sig)));
});

test('quiet hours and pause hold pushes back, in the person\'s own time zone', () => {
  const at = new Date('2026-11-10T23:30:00Z');
  assert.equal(quietNow({...DEFAULT_NOTIFY, quiet: {from: '22:00', to: '07:00'}, tz: 'UTC'}, at), true);
  assert.equal(quietNow({...DEFAULT_NOTIFY, quiet: {from: '22:00', to: '07:00'}, tz: 'America/Los_Angeles'}, at), false, '15:30 there');
  assert.equal(quietNow({...DEFAULT_NOTIFY, quiet: {from: '09:00', to: '17:00'}, tz: 'America/Los_Angeles'}, at), true);
  assert.equal(quietNow({...DEFAULT_NOTIFY, pausedUntil: '2026-11-11T00:00:00.000Z'}, at), true);
  assert.equal(quietNow({...DEFAULT_NOTIFY, pausedUntil: '2026-11-10T00:00:00.000Z'}, at), false);
});

test('devices: subscribe, get the notification encrypted, settings respected, dead devices dropped', async () => {
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-10');
  const mw = apiMiddleware(tasks);
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; person?: string} = {}) => {
    const r = await fetch(base + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.person ? {'x-person': init.person} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  const sent: {url: string; body: Buffer}[] = [];
  let answer = 201;
  const real = transport.post;
  transport.post = async (url, init) => { sent.push({url, body: init.body as Buffer}); return answer; };
  const settle = () => new Promise(r => setTimeout(r, 30));
  try {
    const [me, boss] = tasks.listPeople();
    assert.equal((await call('/push', {person: me.id})).status, 400, 'needs an email first');
    await call(`/team/${me.id}`, {method: 'PATCH', body: {email: 'me@example.test'}, person: boss.id});
    const info = (await call('/push', {person: me.id})).json;
    assert.equal(b64(info.key).length, 65);
    assert.equal(info.devices, 0);

    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.from('0123456789abcdef');
    const sub = {endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: {p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url')}};
    // Only real push services, and real keys.
    assert.equal((await call('/push/subscribe', {method: 'POST', body: {subscription: {...sub, endpoint: 'http://127.0.0.1:9/steal'}}, person: me.id})).status, 400);
    assert.equal((await call('/push/subscribe', {method: 'POST', body: {subscription: {...sub, keys: {p256dh: 'abc', auth: 'x'}}}, person: me.id})).status, 400);
    assert.equal((await call('/push/subscribe', {method: 'POST', body: {subscription: sub}, person: me.id})).json.devices, 1);

    // Being assigned reaches the device, encrypted for it alone.
    const item = tasks.listItems({open: true}).find(i => !i.assignees.includes(me.id))!;
    await call(`/items/${item.id}`, {method: 'PATCH', body: {assignees: [...item.assignees, me.id]}, person: boss.id});
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, sub.endpoint);
    const msg = decrypt(sent[0].body, ua, auth);
    assert.equal(msg.title, boss.name);
    assert.match(msg.body, /assigned you/);
    assert.equal(msg.url, `/?ws=main#/open/${item.id}`);
    assert.equal(msg.tag, item.id);
    assert.ok(msg.unread >= 1);

    // Turned off: the Inbox still gets it, the phone does not.
    const off = await call('/push/prefs', {method: 'PUT', body: {off: ['mention', 'nonsense'], quiet: {from: '25:00', to: '07:00'}, tz: 'UTC'}, person: me.id});
    assert.deepEqual(off.json.off, ['mention'], 'unknown kinds dropped');
    assert.equal(off.json.quiet, null, 'bad times dropped');
    assert.equal((await call('/push/prefs', {method: 'PUT', body: {tz: 'Mars/Olympus'}, person: me.id})).status, 400);
    await call('/push/prefs', {method: 'PUT', body: {off: ['mention'], tz: 'UTC'}, person: me.id});
    const before = sent.length;
    await call(`/items/${item.id}/comments`, {method: 'POST', body: {body: `@${me.name.split(' ')[0]} look`}, person: boss.id});
    await settle();
    assert.equal(sent.length, before, 'mentions are off');
    assert.ok(tasks.listNotifications(me.id).some(n => n.kind === 'mention'), 'Inbox still has it');

    // Paused: nothing goes out.
    await call('/push/prefs', {method: 'PUT', body: {pausedUntil: new Date(Date.now() + 3600_000).toISOString(), tz: 'UTC'}, person: me.id});
    const other = tasks.listItems({open: true}).find(i => !i.assignees.includes(me.id))!;
    await call(`/items/${other.id}`, {method: 'PATCH', body: {assignees: [me.id]}, person: boss.id});
    await settle();
    assert.equal(sent.length, before);

    // A test message; a device the push service no longer knows is removed.
    await call('/push/prefs', {method: 'PUT', body: {tz: 'UTC'}, person: me.id});
    assert.equal((await call('/push/test', {method: 'POST', body: {}, person: me.id})).json.sent, 1);
    answer = 410;
    assert.equal((await call('/push/test', {method: 'POST', body: {}, person: me.id})).json.sent, 0);
    assert.equal((await call('/push', {person: me.id})).json.devices, 0);
  } finally {
    transport.post = real;
    server.close();
  }
});

test('reminders: due today or tomorrow, overdue and long timers, each once', () => {
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-10');
  tasks.seedIfEmpty();
  const me = tasks.listPeople()[0];
  const project = tasks.listProjects().find(p => !p.settings.rollup)!;
  const soon = tasks.createItem({projectId: project.id, title: 'Soon', due: '2026-11-11', assignees: [me.id]});
  const late = tasks.createItem({projectId: project.id, title: 'Late', due: '2026-11-01', assignees: [me.id]});
  const morning = new Date(2026, 10, 10, 10, 0);
  tasks.db.prepare('insert into time_entries (id, item_id, person, start) values (?, ?, ?, ?)').run('t1', soon.id, me.id, new Date(morning.getTime() - 5 * 3600_000).toISOString());
  tasks.reminders(morning);
  tasks.reminders(morning);
  const mine = (id: string, kind: string) => tasks.listNotifications(me.id).filter(n => n.itemId === id && n.kind === kind);
  assert.equal(mine(soon.id, 'due').length, 1);
  assert.match(mine(soon.id, 'due')[0].text, /due tomorrow/);
  assert.equal(mine(late.id, 'overdue').length, 1);
  assert.equal(mine(soon.id, 'timer').length, 1);
  // Nothing about dates at night.
  const night = tasks.createItem({projectId: project.id, title: 'Night', due: '2026-11-11', assignees: [me.id]});
  tasks.reminders(new Date(2026, 10, 10, 23, 0));
  assert.equal(mine(night.id, 'due').length, 0);
});
