import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {apiMiddleware} from '../server/api.ts';
import {Accounts} from '../server/accounts.ts';
import {checkIdToken, googleSignInCallback, googleSignInStart} from '../server/signin.ts';

const dir = mkdtempSync(join(tmpdir(), 'tasks-signin-'));
process.env.TASKS_BACKUPS = join(dir, 'backups');
process.env.TASKS_DB = join(dir, 'tasks.db'); // the sign-in log goes beside it
const NEW_ENV = ['PUBLIC_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'STAFF_GOOGLE_DOMAIN', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS'];
const clearEnv = () => { for (const k of NEW_ENV) delete process.env[k]; };
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const future = () => Math.floor(Date.now() / 1000) + 600;

/** A forced sign-in server with an owner account (owner@x.test) and a member account (member@x.test). */
async function setup() {
  process.env.CADENCE_REQUIRE_LOGIN = '1';
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-10');
  const mw = apiMiddleware(tasks);
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as {port: number}).port;
  /** Raw request, so tests can forge Host and Origin, and pick the client IP (X-Forwarded-For from a local proxy). */
  const call = (path: string, init: {method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>} = {}) => new Promise<{status: number; json: any; cookie?: string; location?: string}>((ok, bad) => {
    const data = init.body === undefined ? undefined : JSON.stringify(init.body);
    const r = request({host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.cookie ? {cookie: init.cookie} : {}), ...init.headers}}, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => {
        let json = null; try { json = JSON.parse(b); } catch { /* not JSON */ }
        const sc = res.headers['set-cookie'] ?? [];
        ok({status: res.statusCode!, json, cookie: sc.find(c => c.startsWith('cadence_session='))?.split(';')[0], location: res.headers.location});
      });
    });
    r.on('error', bad); if (data) r.write(data); r.end();
  });
  const owner = (await call('/api/auth/setup', {method: 'POST', body: {name: 'Owner', email: 'owner@x.test', password: 'owner password'}})).cookie!;
  const inv = (await call('/api/invites', {method: 'POST', body: {email: 'member@x.test', role: 'editor'}, cookie: owner})).json;
  const joined = await call(`/api/invites/${inv.link.split('#/invite/')[1]}/accept`, {method: 'POST', body: {name: 'Member', password: 'member password'}});
  assert.equal(joined.status, 200);
  return {tasks, server, call, owner, member: joined.cookie!};
}
/** Captures what the server prints (sign-in links land in the log when no mail is set up). */
function captureLog() {
  const lines: string[] = [], log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  return {lines, restore: () => { console.log = log; }};
}
const linkFor = (lines: string[], email: string) => lines.filter(l => l.includes(`Sign-in link for ${email}:`)).at(-1)?.split(': ').at(-1)?.trim();

test('email sign-in links: same reply for unknown emails, PUBLIC_URL even with a forged Host and Origin, single use', async () => {
  clearEnv();
  process.env.PUBLIC_URL = 'https://cadence.example.test/';
  const {server, call} = await setup();
  const out = captureLog();
  try {
    const ip = {'x-forwarded-for': '203.0.113.1'};
    const unknown = await call('/api/auth/email-link', {method: 'POST', body: {email: 'nobody@x.test'}, headers: ip});
    const known = await call('/api/auth/email-link', {method: 'POST', body: {email: 'Member@X.test'}, headers: {...ip, host: 'evil.example', origin: 'http://evil.example'}});
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.json, known.json, 'the reply does not reveal whether the account exists');
    assert.ok(!out.lines.some(l => l.includes('nobody@x.test')), 'no link for an unknown email');
    const link = linkFor(out.lines, 'member@x.test')!;
    assert.ok(link.startsWith('https://cadence.example.test/#/signin-link/'), `link built from PUBLIC_URL, got ${link}`);
    assert.ok(!out.lines.some(l => l.includes('evil.example')));
    const token = link.split('#/signin-link/')[1];

    // A newer link voids the older one.
    await call('/api/auth/email-link', {method: 'POST', body: {email: 'member@x.test'}, headers: ip});
    const newer = linkFor(out.lines, 'member@x.test')!.split('#/signin-link/')[1];
    assert.notEqual(newer, token);
    assert.equal((await call('/api/auth/email-link/use', {method: 'POST', body: {token}})).status, 400, 'older link voided');
    // Opening the link (a GET, as mail scanners do) does not use it; only the POST does.
    assert.equal((await call(`/#/signin-link/${newer}`)).status, 404);
    const used = await call('/api/auth/email-link/use', {method: 'POST', body: {token: newer}});
    assert.equal(used.status, 200);
    assert.equal((await call('/api/auth/me', {cookie: used.cookie})).json.account, 'member@x.test');
    assert.equal((await call('/api/auth/email-link/use', {method: 'POST', body: {token: newer}})).status, 400, 'single use');
    assert.equal((await call('/api/auth/email-link/use', {method: 'POST', body: {token: 'made-up-token-made-up-token'}})).status, 400);

    // The invite link is emailed with PUBLIC_URL too.
    const owner = (await call('/api/auth/login', {method: 'POST', body: {email: 'owner@x.test', password: 'owner password'}})).cookie!;
    const inv = await call('/api/invites', {method: 'POST', body: {email: 'third@x.test', role: 'editor'}, cookie: owner, headers: {host: 'evil.example', origin: 'http://evil.example'}});
    assert.ok(inv.json.link.startsWith('https://cadence.example.test/?ws=main#/invite/'), inv.json.link);

    // The sign-in log has the attempts and never a token or password.
    const log = readFileSync(join(dir, 'signin-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(log.some(r => r.email === 'member@x.test' && r.method === 'link' && r.result === 'ok' && r.ip === '127.0.0.1' && 'ua' in r && r.time));
    assert.ok(log.some(r => r.email === 'nobody@x.test' && r.result === 'no account' && r.ip === '203.0.113.1'));
    assert.ok(log.some(r => r.method === 'password' && r.result === 'ok'));
    assert.ok(log.some(r => r.method === 'invite' && r.result === 'ok'));
    const raw = readFileSync(join(dir, 'signin-log.jsonl'), 'utf8');
    assert.ok(!raw.includes(token) && !raw.includes(newer) && !raw.includes('owner password') && !raw.includes('member password'));
  } finally { out.restore(); server.close(); clearEnv(); }
});

test('email sign-in links expire after 15 minutes', () => {
  const a = new Accounts(new DatabaseSync(':memory:'));
  const t = a.startSignInLink('x@x.test');
  const row = a.db.prepare('select expires from signin_links').get() as {expires: string};
  const mins = (Date.parse(row.expires) - Date.now()) / 60_000;
  assert.ok(mins > 14 && mins <= 15, `expires in ${mins} minutes`);
  a.db.prepare('update signin_links set expires = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal(a.useSignInLink(t), null, 'expired');
  const t2 = a.startSignInLink('x@x.test');
  assert.equal(a.useSignInLink(t2), 'x@x.test');
  assert.equal(a.useSignInLink(t2), null, 'single use');
});

test('email sign-in links are rate limited: 5 per email and 10 per IP in 15 minutes', async () => {
  clearEnv();
  process.env.PUBLIC_URL = 'https://cadence.example.test';
  const {server, call} = await setup();
  const out = captureLog();
  try {
    const ask = (email: string, ip: string) => call('/api/auth/email-link', {method: 'POST', body: {email}, headers: {'x-forwarded-for': ip}});
    for (let n = 0; n < 5; n++) assert.equal((await ask('rate@x.test', `198.51.100.${n}`)).status, 200);
    assert.equal((await ask('rate@x.test', '198.51.100.99')).status, 429, 'sixth for one email');
    for (let n = 0; n < 10; n++) assert.equal((await ask(`p${n}@x.test`, '198.51.100.200')).status, 200);
    assert.equal((await ask('another@x.test', '198.51.100.200')).status, 429, 'eleventh from one IP');
    assert.equal((await ask('another@x.test', '198.51.100.201')).status, 200, 'other IPs still work');
  } finally { out.restore(); server.close(); clearEnv(); }
});

test('Google sign-in: PKCE and state cookie, state mismatch and unverified emails rejected, no account creation', async () => {
  clearEnv();
  Object.assign(process.env, {PUBLIC_URL: 'https://cadence.example.test', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'});
  let claims: object = {};
  const seen: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/auth/google/start') return googleSignInStart(req, res);
    void googleSignInCallback(req, res, url, {hasAccount: e => e === 'known@x.test', signIn: e => `cadence_session=for-${e}`, log: () => {},
      exchange: async p => { seen.push(p); return {id_token: jwt(claims)}; }});
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const get = async (path: string, cookie?: string) => {
    const r = await fetch(base + path, {redirect: 'manual', headers: cookie ? {cookie} : {}});
    return {location: r.headers.get('location') ?? '', cookies: r.headers.getSetCookie()};
  };
  try {
    const start = await get('/auth/google/start');
    const auth = new URL(start.location);
    assert.equal(auth.origin, 'https://accounts.google.com');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://cadence.example.test/auth/google/callback');
    assert.equal(auth.searchParams.get('scope'), 'openid email profile');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const state = auth.searchParams.get('state')!;
    const cookie = start.cookies[0].split(';')[0];
    assert.match(start.cookies[0], /HttpOnly/);
    assert.match(start.cookies[0], /Max-Age=600/);

    const mismatch = await get(`/auth/google/callback?state=wrong${state.slice(5)}&code=c`, cookie);
    assert.match(decodeURIComponent(mismatch.location), /Sign-in expired/);
    assert.equal(seen.length, 0, 'no code exchange on a state mismatch');
    assert.match(decodeURIComponent((await get(`/auth/google/callback?state=${state}&code=c`)).location), /Sign-in expired/, 'no state cookie');

    claims = {aud: 'client-1', iss: 'https://accounts.google.com', exp: future(), email: 'known@x.test', email_verified: false};
    assert.match(decodeURIComponent((await get(`/auth/google/callback?state=${state}&code=c`, cookie)).location), /did not confirm that email/);
    assert.ok(seen[0].code_verifier, 'PKCE verifier sent with the code');
    claims = {aud: 'client-1', iss: 'accounts.google.com', exp: future(), email: 'stranger@x.test', email_verified: true};
    assert.match(decodeURIComponent((await get(`/auth/google/callback?state=${state}&code=c`, cookie)).location), /No account for that email\. Ask an admin for an invite\./);
    claims = {aud: 'client-1', iss: 'accounts.google.com', exp: future(), email: 'Known@X.test', email_verified: true};
    const ok = await get(`/auth/google/callback?state=${state}&code=c`, cookie);
    assert.equal(ok.location, '/#/mywork');
    assert.ok(ok.cookies.some(c => c === 'cadence_session=for-known@x.test'));
  } finally { server.close(); clearEnv(); }
});

test('ID token checks: audience, issuer, expiry, verified email', () => {
  const good = {aud: 'c', iss: 'accounts.google.com', exp: future(), email: 'A@B.test', email_verified: true};
  assert.equal(checkIdToken(jwt(good), 'c'), 'a@b.test');
  assert.throws(() => checkIdToken(jwt({...good, aud: 'other'}), 'c'));
  assert.throws(() => checkIdToken(jwt({...good, iss: 'https://evil.example'}), 'c'));
  assert.throws(() => checkIdToken(jwt({...good, exp: 1000}), 'c'));
  assert.throws(() => checkIdToken(jwt({...good, email_verified: false}), 'c'), /did not confirm/);
  assert.throws(() => checkIdToken('not-a-token', 'c'));
});

test('staff rule: staff accounts use Google only when Google is configured; no lockout without it', async () => {
  clearEnv();
  process.env.PUBLIC_URL = 'https://cadence.example.test';
  const {server, call, owner} = await setup();
  const out = captureLog();
  try {
    // Without Google the rule is off: staff can still use a password and email links.
    process.env.STAFF_GOOGLE_DOMAIN = 'x.test';
    assert.equal((await call('/api/auth/login', {method: 'POST', body: {email: 'owner@x.test', password: 'owner password'}})).status, 200, 'no lockout without Google');
    await call('/api/auth/email-link', {method: 'POST', body: {email: 'owner@x.test'}, headers: {'x-forwarded-for': '192.0.2.1'}});
    assert.ok(linkFor(out.lines, 'owner@x.test'));
    const early = linkFor(out.lines, 'owner@x.test')!.split('#/signin-link/')[1];
    assert.equal((await call('/api/auth/me')).json.signInGoogle, false);

    Object.assign(process.env, {GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'});
    assert.equal((await call('/api/auth/me')).json.signInGoogle, true);
    const pw = await call('/api/auth/login', {method: 'POST', body: {email: 'owner@x.test', password: 'owner password'}});
    assert.equal(pw.status, 403);
    assert.match(pw.json.error, /Google/);
    const before = out.lines.length;
    const reply = await call('/api/auth/email-link', {method: 'POST', body: {email: 'owner@x.test'}, headers: {'x-forwarded-for': '192.0.2.2'}});
    assert.equal(reply.status, 200, 'same reply');
    assert.ok(!out.lines.slice(before).some(l => l.includes('Sign-in link')), 'no link for staff');
    assert.equal((await call('/api/auth/email-link/use', {method: 'POST', body: {token: early}})).status, 403, 'a link sent earlier no longer works for staff');
    // Another domain is unaffected.
    process.env.STAFF_GOOGLE_DOMAIN = 'staff.example';
    assert.equal((await call('/api/auth/login', {method: 'POST', body: {email: 'owner@x.test', password: 'owner password'}})).status, 200);
    // An existing session still works (sessions are unchanged).
    assert.equal((await call('/api/bootstrap', {cookie: owner})).status, 200);
  } finally { out.restore(); server.close(); clearEnv(); }
});

test('invites: passwordless when the server offers Google or email links; a password otherwise; removing a person ends their access', async () => {
  clearEnv();
  const {server, call, owner, member} = await setup();
  const out = captureLog();
  try {
    const invite = async (email: string) => (await call('/api/invites', {method: 'POST', body: {email, role: 'editor'}, cookie: owner})).json.link.split('#/invite/')[1];
    // Nothing new configured: a password is still required, so the person can sign in again later.
    const s1 = await invite('p1@x.test');
    assert.equal((await call(`/api/invites/${s1}`)).json.passwordless, false);
    assert.equal((await call(`/api/invites/${s1}/accept`, {method: 'POST', body: {name: 'P1'}})).status, 400);
    // With email links on (localhost PUBLIC_URL prints them to the log), a name is enough.
    process.env.PUBLIC_URL = 'http://localhost:8091';
    assert.equal((await call('/api/auth/me')).json.signInLink, true);
    const s2 = await invite('p2@x.test');
    assert.equal((await call(`/api/invites/${s2}`)).json.passwordless, true);
    const j = await call(`/api/invites/${s2}/accept`, {method: 'POST', body: {name: 'P2'}});
    assert.equal(j.status, 200);
    assert.equal((await call('/api/bootstrap', {cookie: j.cookie})).status, 200, 'signed in after joining');
    assert.equal((await call('/api/auth/login', {method: 'POST', body: {email: 'p2@x.test', password: ''}})).status, 401, 'no password set');

    // Removing (deactivating) a person ends their access to the workspace at once.
    const people = (await call('/api/team', {cookie: owner})).json.people;
    const m = people.find((p: {email: string}) => p.email === 'member@x.test');
    assert.equal((await call('/api/bootstrap', {cookie: member})).status, 200);
    assert.equal((await call(`/api/team/${m.id}`, {method: 'PATCH', body: {active: false}, cookie: owner})).status, 200);
    assert.equal((await call('/api/bootstrap', {cookie: member})).status, 403);
  } finally { out.restore(); server.close(); clearEnv(); }
});
