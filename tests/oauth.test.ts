import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {apiMiddleware} from '../server/api.ts';
import {validRedirectUri} from '../server/oauth.ts';

process.env.TASKS_BACKUPS = mkdtempSync(join(tmpdir(), 'tasks-oauth-'));
const CB = 'https://claude.ai/api/mcp/auth_callback';

test('redirect URIs: https anywhere, http only on this computer', () => {
  assert.ok(validRedirectUri(CB));
  assert.ok(validRedirectUri('http://localhost:33418/callback'));
  assert.ok(validRedirectUri('http://127.0.0.1/cb'));
  for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'https://claude.ai/cb#x', 'ftp://x/y', 'not a url', 'https://u:p@claude.ai/cb']) assert.ok(!validRedirectUri(bad), bad);
});

test('OAuth for the MCP endpoint: discovery, register, sign in, consent, PKCE, codes, refresh rotation, revoke, removal', async () => {
  const tasks = new Tasks(openDb(':memory:'), () => '2026-11-10');
  const mw = apiMiddleware(tasks);
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const B = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  process.env.PUBLIC_URL = B;
  const call = async (path: string, init: {method?: string; body?: unknown; cookie?: string; person?: string} = {}) => {
    const r = await fetch(B + '/api' + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.cookie ? {cookie: init.cookie} : {}), ...(init.person ? {'x-person': init.person} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0]};
  };
  const mcp = (token: string | null, method = 'tools/list', params?: unknown) => fetch(B + '/mcp', {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? {authorization: `Bearer ${token}`} : {})},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
  const form = (path: string, p: Record<string, string>, headers: Record<string, string> = {}) => fetch(B + path, {method: 'POST', redirect: 'manual', headers: {'content-type': 'application/x-www-form-urlencoded', ...headers}, body: new URLSearchParams(p)});
  const token = async (p: Record<string, string>) => { const r = await form('/oauth/token', p); return {status: r.status, json: await r.json() as any}; };
  try {
    const team = (await call('/team')).json;
    const [admin, viewer] = [team.people.find((p: {admin: boolean}) => p.admin), team.people.find((p: {admin: boolean}) => !p.admin)];
    await call(`/team/${admin.id}`, {method: 'PATCH', body: {email: 'admin@x.test', password: 'correct horse'}, person: admin.id});
    await call(`/team/${viewer.id}`, {method: 'PATCH', body: {email: 'viewer@x.test', password: 'viewer pass', role: 'viewer'}, person: admin.id});
    assert.equal((await call('/workspace', {method: 'PUT', body: {requireLogin: true}, person: admin.id})).status, 200);
    const a = (await call('/auth/login', {method: 'POST', body: {email: 'admin@x.test', password: 'correct horse'}})).cookie!;
    const v = (await call('/auth/login', {method: 'POST', body: {email: 'viewer@x.test', password: 'viewer pass'}})).cookie!;

    // Discovery: 401 names the resource metadata, which names this server as the authorization server.
    const un = await mcp(null);
    assert.equal(un.status, 401);
    assert.equal(un.headers.get('www-authenticate'), `Bearer resource_metadata="${B}/.well-known/oauth-protected-resource/mcp"`);
    assert.match((await mcp('cda_nope')).headers.get('www-authenticate')!, /error="invalid_token"/);
    const prm = await (await fetch(`${B}/.well-known/oauth-protected-resource/mcp`)).json() as any;
    assert.deepEqual([prm.resource, prm.authorization_servers], [`${B}/mcp`, [B]]);
    assert.equal((await (await fetch(`${B}/.well-known/oauth-protected-resource`)).json() as any).resource, `${B}/mcp`);
    const asmRes = await fetch(`${B}/.well-known/oauth-authorization-server`);
    assert.equal(asmRes.headers.get('access-control-allow-origin'), '*');
    const asm = await asmRes.json() as any;
    assert.equal(asm.issuer, B);
    assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(await (await fetch(`${B}/.well-known/openid-configuration`)).json(), asm);
    // URLs come from PUBLIC_URL, never from the Host header.
    assert.equal((await (await fetch(`${B}/.well-known/oauth-authorization-server`, {headers: {host: 'evil.example'}})).json() as any).issuer, B);
    assert.equal((await fetch(asm.registration_endpoint, {method: 'OPTIONS'})).status, 204);

    // Registration: bad redirect URIs refused.
    const register = (uris: string[]) => fetch(asm.registration_endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({client_name: 'Claude', redirect_uris: uris, token_endpoint_auth_method: 'none'})});
    assert.equal((await register(['http://evil.example/cb'])).status, 400);
    assert.equal((await register([])).status, 400);
    const reg = await register([CB]);
    assert.equal(reg.status, 201);
    const clientId = (await reg.json() as any).client_id as string;

    const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return {verifier, challenge: createHash('sha256').update(verifier).digest('base64url')}; };
    const authParams = (challenge: string, extra: Record<string, string> = {}) => new URLSearchParams({response_type: 'code', client_id: clientId, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', scope: 'cadence', resource: `${B}/mcp`, ...extra});
    const get = (qs: URLSearchParams, cookie?: string) => fetch(`${B}/oauth/authorize?${qs}`, {redirect: 'manual', headers: cookie ? {cookie} : {}});

    // Not signed in: off to sign-in, remembering the consent page.
    const k0 = pkce();
    const out = await get(authParams(k0.challenge));
    assert.equal(out.status, 303);
    assert.equal(out.headers.get('location'), '/#/signin');
    assert.match(out.headers.get('set-cookie')!, /^cadence_next=%2Foauth%2Fauthorize%3F/);
    // An unregistered redirect URI is never redirected to; a missing PKCE goes back to the app with an error.
    const badRedirect = await get(authParams(k0.challenge, {redirect_uri: 'https://evil.example/cb'}), a);
    assert.equal(badRedirect.status, 400);
    assert.equal(badRedirect.headers.get('location'), null);
    const noPkce = await get(new URLSearchParams({response_type: 'code', client_id: clientId, redirect_uri: CB, state: 'st8'}), a);
    assert.equal(noPkce.status, 303);
    assert.match(noPkce.headers.get('location')!, /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=invalid_request/);
    assert.equal((await get(authParams(k0.challenge, {resource: 'https://other.example/mcp'}), a)).status, 303, 'unknown resource refused');

    // Consent page names the app, the person and where it goes back to.
    const approve = async (cookie: string, decision = 'allow', extra: Record<string, string> = {}) => {
      const k = pkce(), qs = authParams(k.challenge);
      const page = await get(qs, cookie), html = await page.text();
      // Browsers send Origin: null on the form post under no-referrer, which the origin check would refuse.
      assert.equal(page.headers.get('referrer-policy'), 'same-origin');
      assert.match(html, /Connect Claude to Cadence\?/);
      assert.match(html, /claude\.ai/);
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
      const r = await form('/oauth/authorize', {...Object.fromEntries(qs), csrf, workspace: 'main', decision, ...extra}, {cookie});
      return {status: r.status, location: r.headers.get('location') ?? '', html, ...k};
    };
    const first = await approve(a);
    assert.match(first.html, new RegExp(admin.name));
    assert.equal(first.status, 303);
    const cb = new URL(first.location);
    assert.equal(cb.origin + cb.pathname, CB);
    assert.equal(cb.searchParams.get('state'), 'st8');
    assert.equal(cb.searchParams.get('iss'), B);
    const code = cb.searchParams.get('code')!;
    // CSRF: a wrong token or another site's origin gets no code.
    const forged = await approve(a, 'allow', {csrf: 'x'.repeat(32)});
    assert.ok(!forged.location.includes('code='), 'bad csrf token');
    const cross = await form('/oauth/authorize', {...Object.fromEntries(authParams(first.challenge)), csrf: /name="csrf" value="([^"]+)"/.exec(first.html)![1], workspace: 'main', decision: 'allow'}, {cookie: a, origin: 'https://evil.example'});
    assert.equal(cross.status, 403);
    // Deny goes back with access_denied.
    assert.match((await approve(a, 'deny')).location, /error=access_denied.*state=st8/);

    // PKCE: the wrong verifier fails.
    const pk = await approve(a);
    assert.equal((await token({grant_type: 'authorization_code', code: new URL(pk.location).searchParams.get('code')!, redirect_uri: CB, client_id: clientId, code_verifier: pkce().verifier})).json.error, 'invalid_grant');

    // Exchange, then use the access token on /mcp: same tools, as the admin.
    const t1 = await token({grant_type: 'authorization_code', code, redirect_uri: CB, client_id: clientId, code_verifier: first.verifier});
    assert.equal(t1.status, 200);
    assert.equal(t1.json.token_type, 'Bearer');
    assert.equal(t1.json.expires_in, 3600);
    assert.match(t1.json.access_token, /^cda_/);
    const listed = await mcp(t1.json.access_token);
    assert.equal(listed.status, 200);
    assert.ok(((await listed.json()) as any).result.tools.length > 40);
    // Reusing a code fails and revokes what it issued.
    assert.equal((await token({grant_type: 'authorization_code', code, redirect_uri: CB, client_id: clientId, code_verifier: first.verifier})).json.error, 'invalid_grant');
    assert.equal((await mcp(t1.json.access_token)).status, 401, 'tokens from a reused code are revoked');
    assert.equal((await token({grant_type: 'refresh_token', refresh_token: t1.json.refresh_token, client_id: clientId})).status, 400);

    // Refresh rotation: the new pair works, the old access and refresh tokens do not.
    const s = await approve(a);
    const t2 = await token({grant_type: 'authorization_code', code: new URL(s.location).searchParams.get('code')!, redirect_uri: CB, client_id: clientId, code_verifier: s.verifier});
    const t3 = await token({grant_type: 'refresh_token', refresh_token: t2.json.refresh_token, client_id: clientId});
    assert.equal(t3.status, 200);
    assert.notEqual(t3.json.refresh_token, t2.json.refresh_token);
    assert.equal((await mcp(t2.json.access_token)).status, 401);
    assert.equal((await mcp(t3.json.access_token)).status, 200);
    assert.equal((await token({grant_type: 'refresh_token', refresh_token: t2.json.refresh_token, client_id: clientId})).json.error, 'invalid_grant');
    // Revoke (RFC 7009).
    const rv = await form('/oauth/revoke', {token: t3.json.access_token});
    assert.equal(rv.status, 200);
    assert.equal((await mcp(t3.json.access_token)).status, 401);

    // Connected apps: listed for the account, Disconnect cuts it off.
    const s4 = await approve(a);
    const t4 = await token({grant_type: 'authorization_code', code: new URL(s4.location).searchParams.get('code')!, redirect_uri: CB, client_id: clientId, code_verifier: s4.verifier});
    const apps = (await call('/auth/apps', {cookie: a})).json;
    assert.equal(apps.mcpUrl, `${B}/mcp`);
    assert.ok(apps.apps.some((x: {clientId: string; name: string}) => x.clientId === clientId && x.name === 'Claude'));
    assert.equal((await call('/auth/apps', {cookie: v})).json.apps.length, 0, 'only your own apps');
    await call(`/auth/apps/${clientId}?workspace=main`, {method: 'DELETE', cookie: v});
    assert.equal((await mcp(t4.json.access_token)).status, 200, 'someone else cannot disconnect it');
    await call(`/auth/apps/${clientId}?workspace=main`, {method: 'DELETE', cookie: a});
    assert.equal((await mcp(t4.json.access_token)).status, 401);
    assert.equal((await call('/auth/apps', {cookie: a})).json.apps.length, 0);

    // The viewer's grant acts as the viewer, through the same permission guard.
    const sv = await approve(v);
    assert.match(sv.html, new RegExp(viewer.name));
    const tv = await token({grant_type: 'authorization_code', code: new URL(sv.location).searchParams.get('code')!, redirect_uri: CB, client_id: clientId, code_verifier: sv.verifier});
    const project = tasks.listProjects().find(p => !p.settings.rollup)!;
    const denied = await (await mcp(tv.json.access_token, 'tools/call', {name: 'create_item', arguments: {projectId: project.id, title: 'From Claude'}})).json() as any;
    assert.ok(denied.result.isError, 'a viewer cannot create items');
    assert.match(JSON.stringify(denied.result.content), /create/);
    // Removed (deactivated) people lose their apps: access and refresh both stop.
    await call(`/team/${viewer.id}`, {method: 'PATCH', body: {active: false}, cookie: a});
    assert.equal((await mcp(tv.json.access_token)).status, 401);
    assert.equal((await token({grant_type: 'refresh_token', refresh_token: tv.json.refresh_token, client_id: clientId})).json.error, 'invalid_grant');

    // Team page tokens and ?key= still work.
    const tt = (await call('/tokens', {method: 'POST', body: {person: admin.id, name: 'Agent'}, cookie: a})).json.token;
    assert.equal((await mcp(tt)).status, 200);
    assert.equal((await fetch(`${B}/mcp?key=${tt}`, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'})})).status, 200);
  } finally {
    delete process.env.PUBLIC_URL;
    server.close();
  }
});
