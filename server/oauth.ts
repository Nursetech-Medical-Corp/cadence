// OAuth 2.1 for the MCP endpoint, so anyone can add Cadence to claude.ai (or any MCP client) by pasting one URL,
// signing in to Cadence and clicking Allow. Follows the MCP authorization spec:
//   /.well-known/oauth-protected-resource[/mcp]   RFC 9728, points the client at this server
//   /.well-known/oauth-authorization-server       RFC 8414 (also served as openid-configuration)
//   /oauth/register                               RFC 7591 dynamic registration, public clients only
//   /oauth/authorize                              sign in, then a consent page; Allow returns a code
//   /oauth/token                                  authorization_code with PKCE S256, rotating refresh tokens
//   /oauth/revoke                                 RFC 7009
// A grant acts as one person in one workspace, the person whose account approved it, and every tool runs through
// the same permission guard as tokens (tokens.ts). Codes and tokens are stored only as SHA-256 hashes, in the
// server's account store (accounts.db). Every URL comes from PUBLIC_URL, never from request headers; without
// PUBLIC_URL sign-in for apps is off and the Team page tokens still work.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Db} from './db.ts';
import {ACCOUNT_COOKIE, type Accounts} from './accounts.ts';
import {clientIp, publicUrl} from './signin.ts';

export const ACCESS_TTL = 3600; // seconds
export const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 600;
export const SCOPE = 'cadence';
/** Remembers the consent page while someone signs in; the app sends them back to it (src/App.tsx). */
export const NEXT_COOKIE = 'cadence_next';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => randomBytes(n).toString('base64url');
const at = (sec = 0) => new Date(Date.now() + sec * 1000).toISOString();

export function migrateOAuth(db: Db) {
  db.exec(`create table if not exists oauth_clients (id text primary key, name text not null, redirect_uris text not null, created text not null);
    create table if not exists oauth_codes (hash text primary key, client_id text not null, email text not null, workspace text not null, person text not null,
      redirect_uri text not null, challenge text not null, scope text not null, expires text not null, used text);
    create table if not exists oauth_tokens (id text primary key, client_id text not null, email text not null, workspace text not null, person text not null,
      scope text not null, family text not null, access_hash text not null unique, refresh_hash text not null unique,
      access_expires text not null, refresh_expires text not null, created text not null, last_used text, revoked text);
    create index if not exists oauth_tokens_person on oauth_tokens(workspace, person);
    create index if not exists oauth_tokens_email on oauth_tokens(email);`);
}

// ---- URLs and metadata ----

export const issuer = () => publicUrl();
/** The MCP address for a workspace: {PUBLIC_URL}/mcp for the first one, with ?ws= for the others. */
export const mcpResource = (ws?: string | null) => `${publicUrl()}/mcp${ws && ws !== 'main' ? `?ws=${encodeURIComponent(ws)}` : ''}`;
export const resourceMetadataUrl = (ws?: string | null) => `${publicUrl()}/.well-known/oauth-protected-resource/mcp${ws && ws !== 'main' ? `?ws=${encodeURIComponent(ws)}` : ''}`;

export function authServerMetadata() {
  const b = issuer();
  return {
    issuer: b, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`, revocation_endpoint: `${b}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: [SCOPE],
  };
}
export const protectedResourceMetadata = (ws?: string | null) => ({
  resource: mcpResource(ws), authorization_servers: [issuer()], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Cadence',
});

// ---- Clients ----

export type OAuthClient = {id: string; name: string; redirectUris: string[]};
/** https anywhere, or http only on this computer (Claude Code and other local apps). */
export function validRedirectUri(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}
export function registerClient(db: Db, input: {client_name?: unknown; redirect_uris?: unknown}): OAuthClient | {error: string} {
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (!uris.length || uris.length > 10) return {error: 'redirect_uris is required (1 to 10)'};
  const bad = uris.find(u => !validRedirectUri(u));
  if (bad) return {error: `Redirect URI not allowed (use https, or http on localhost): ${bad.slice(0, 200)}`};
  const name = (typeof input.client_name === 'string' && input.client_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100)) || new URL(uris[0]).host;
  const id = 'cdc_' + rand(16);
  db.prepare('insert into oauth_clients (id, name, redirect_uris, created) values (?, ?, ?, ?)').run(id, name, JSON.stringify(uris), at());
  return getClient(db, id)!;
}
export function getClient(db: Db, id: string | null | undefined): OAuthClient | null {
  if (!id) return null;
  const r = db.prepare('select id, name, redirect_uris from oauth_clients where id = ?').get(id) as {id: string; name: string; redirect_uris: string} | undefined;
  return r ? {id: r.id, name: r.name, redirectUris: JSON.parse(r.redirect_uris)} : null;
}

// ---- Authorization request ----

export type AuthRequest = {client: OAuthClient; redirectUri: string; state: string | null; challenge: string; scope: string; ws: string | null};
type Parsed = {ok: true; req: AuthRequest} | {ok: false; error: string; redirect?: string};

/** Errors before the redirect URI is trusted are shown on our page; nothing is ever sent to an unregistered address. */
export function parseAuthRequest(db: Db, p: URLSearchParams): Parsed {
  const client = getClient(db, p.get('client_id'));
  if (!client) return {ok: false, error: 'Unknown app. Remove the connector in your AI app and add it again.'};
  const redirectUri = p.get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
  if (!client.redirectUris.includes(redirectUri)) return {ok: false, error: 'This app did not register that return address.'};
  const state = p.get('state');
  const fail = (code: string, desc: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set('error', code); u.searchParams.set('error_description', desc);
    if (state) u.searchParams.set('state', state);
    return {ok: false as const, error: desc, redirect: u.toString()};
  };
  if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
  const challenge = p.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || p.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
  // The resource (RFC 8707) must be this server's MCP address; its ?ws= picks the workspace shown first.
  let ws: string | null = null;
  const resource = p.get('resource');
  if (resource) {
    let u: URL;
    try { u = new URL(resource); } catch { return fail('invalid_target', 'Unknown resource'); }
    const bare = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    if (bare !== `${publicUrl()}/mcp` && bare !== publicUrl()) return fail('invalid_target', 'Unknown resource');
    ws = u.searchParams.get('ws');
  }
  return {ok: true, req: {client, redirectUri, state, challenge, scope: SCOPE, ws}};
}

export type Grant = {email: string; workspace: string; person: string};
export function issueCode(db: Db, req: AuthRequest, g: Grant) {
  const code = rand();
  db.prepare('insert into oauth_codes (hash, client_id, email, workspace, person, redirect_uri, challenge, scope, expires) values (?,?,?,?,?,?,?,?,?)')
    .run(sha(code), req.client.id, g.email, g.workspace, g.person, req.redirectUri, req.challenge, req.scope, at(CODE_TTL));
  return code;
}
function back(req: AuthRequest, params: Record<string, string>) {
  const u = new URL(req.redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (req.state) u.searchParams.set('state', req.state);
  u.searchParams.set('iss', issuer()!);
  return u.toString();
}
export const approvalRedirect = (req: AuthRequest, code: string) => back(req, {code});
export const denialRedirect = (req: AuthRequest) => back(req, {error: 'access_denied', error_description: 'The person declined'});

// ---- Tokens ----

export type TokenResponse = {access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string};
type TokenResult = {ok: true; body: TokenResponse} | {ok: false; error: string; description: string};
const err = (error: string, description: string): TokenResult => ({ok: false, error, description});
type Row = {id: string; client_id: string; email: string; workspace: string; person: string; scope: string; family: string};

function newTokens(db: Db, r: Omit<Row, 'id'>): TokenResponse {
  const access = 'cda_' + rand(), refresh = 'cdr_' + rand();
  db.prepare(`insert into oauth_tokens (id, client_id, email, workspace, person, scope, family, access_hash, refresh_hash, access_expires, refresh_expires, created)
    values (?,?,?,?,?,?,?,?,?,?,?,?)`).run(rand(8), r.client_id, r.email, r.workspace, r.person, r.scope, r.family, sha(access), sha(refresh), at(ACCESS_TTL), at(REFRESH_TTL), at());
  return {access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: r.scope};
}

/** alive: the grant's person is still an active member with that account (checked in api.ts). */
export function exchangeCode(db: Db, p: {code?: string | null; client_id?: string | null; redirect_uri?: string | null; code_verifier?: string | null}, alive: (g: Grant) => boolean): TokenResult {
  if (!p.code || !p.code_verifier) return err('invalid_request', 'code and code_verifier are required');
  const h = sha(p.code);
  const r = db.prepare('select * from oauth_codes where hash = ?').get(h) as {client_id: string; email: string; workspace: string; person: string; redirect_uri: string; challenge: string; scope: string; expires: string; used: string | null} | undefined;
  if (!r) return err('invalid_grant', 'Unknown code');
  if (r.used) {
    // A code used twice may have been stolen: revoke everything it produced.
    db.prepare('update oauth_tokens set revoked = ? where family = ? and revoked is null').run(at(), h);
    return err('invalid_grant', 'Code already used');
  }
  db.prepare('update oauth_codes set used = ? where hash = ?').run(at(), h);
  if (r.expires <= at()) return err('invalid_grant', 'Code expired');
  if (p.client_id && p.client_id !== r.client_id) return err('invalid_grant', 'Code was issued to another app');
  if (p.redirect_uri && p.redirect_uri !== r.redirect_uri) return err('invalid_grant', 'redirect_uri does not match');
  const got = Buffer.from(createHash('sha256').update(p.code_verifier).digest('base64url')), want = Buffer.from(r.challenge);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return err('invalid_grant', 'PKCE verification failed');
  if (!alive(r)) return err('invalid_grant', 'This person no longer has access');
  return {ok: true, body: newTokens(db, {client_id: r.client_id, email: r.email, workspace: r.workspace, person: r.person, scope: r.scope, family: h})};
}

/** Refresh tokens rotate: each use returns a new pair and retires the old access and refresh token. */
export function refreshTokens(db: Db, p: {refresh_token?: string | null; client_id?: string | null}, alive: (g: Grant) => boolean): TokenResult {
  if (!p.refresh_token) return err('invalid_request', 'refresh_token is required');
  const r = db.prepare('select * from oauth_tokens where refresh_hash = ?').get(sha(p.refresh_token)) as (Row & {refresh_expires: string; revoked: string | null}) | undefined;
  if (!r || r.revoked || r.refresh_expires <= at()) return err('invalid_grant', 'Refresh token is invalid or expired');
  if (p.client_id && p.client_id !== r.client_id) return err('invalid_grant', 'Token was issued to another app');
  db.prepare('update oauth_tokens set revoked = ? where id = ?').run(at(), r.id);
  if (!alive(r)) return err('invalid_grant', 'This person no longer has access');
  return {ok: true, body: newTokens(db, r)};
}

export function revokeToken(db: Db, token: string) {
  const h = sha(token);
  db.prepare('update oauth_tokens set revoked = ? where (access_hash = ? or refresh_hash = ?) and revoked is null').run(at(), h, h);
}

/** The grant behind a live access token, or null. */
export function accessGrant(db: Db, token: string): (Grant & {id: string}) | null {
  if (!token.startsWith('cda_')) return null;
  const r = db.prepare('select id, email, workspace, person, last_used from oauth_tokens where access_hash = ? and revoked is null and access_expires > ?').get(sha(token), at()) as (Grant & {id: string; last_used: string | null}) | undefined;
  if (!r) return null;
  if (!r.last_used || r.last_used < at(-60)) db.prepare('update oauth_tokens set last_used = ? where id = ?').run(at(), r.id);
  return {id: r.id, email: r.email, workspace: r.workspace, person: r.person};
}
export const isOAuthAccess = (header: string | undefined) => /^Bearer\s+cda_[\w-]+$/i.test(header ?? '');

// ---- Connected apps ----

export type Connection = {clientId: string; name: string; workspace: string; email: string; connected: string; lastUsed: string | null};
/** One row per app and workspace these accounts approved and have not disconnected. */
export function listConnections(db: Db, emails: string[]): Connection[] {
  if (!emails.length) return [];
  return db.prepare(`select c.id as clientId, c.name, t.workspace, t.email, min(t.created) as connected, max(t.last_used) as lastUsed
    from oauth_tokens t join oauth_clients c on c.id = t.client_id
    where t.email in (${emails.map(() => '?').join(',')}) and t.revoked is null and t.refresh_expires > ?
    group by c.id, t.workspace, t.email order by connected desc`).all(...emails, at()) as Connection[];
}
export function disconnect(db: Db, emails: string[], clientId: string, workspace?: string) {
  if (!emails.length) return;
  db.prepare(`update oauth_tokens set revoked = ? where client_id = ? and email in (${emails.map(() => '?').join(',')})${workspace ? ' and workspace = ?' : ''} and revoked is null`)
    .run(at(), clientId, ...emails, ...(workspace ? [workspace] : []));
}
/** Cuts off every app a person approved in a workspace (they were deactivated or their email changed). */
export function revokePerson(db: Db, workspace: string, person: string) {
  db.prepare('update oauth_tokens set revoked = ? where workspace = ? and person = ? and revoked is null').run(at(), workspace, person);
}

// ---- HTTP ----

const CORS = {'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version', 'access-control-max-age': '86400'};
function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, {...CORS, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra});
  res.end(JSON.stringify(body));
}
function redirect(res: ServerResponse, to: string, cookies: string[] = []) {
  res.statusCode = 303;
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.setHeader('location', to); res.setHeader('cache-control', 'no-store');
  res.end();
}
async function readBody(req: IncomingMessage, limit = 100_000) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > limit) throw new Error('too large'); }
  return s;
}
/** Form or JSON body as URLSearchParams (string values only). */
async function params(req: IncomingMessage) {
  const raw = await readBody(req);
  if (String(req.headers['content-type'] ?? '').includes('application/json')) {
    let j: unknown = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* empty */ }
    return new URLSearchParams(Object.entries(j && typeof j === 'object' ? j : {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return new URLSearchParams(raw);
}
const cookie = (req: IncomingMessage, name: string) => (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(name + '='))?.slice(name.length + 1);
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!);
/** Ties the consent form to the session, on top of the SameSite=Lax session cookie. */
const csrfFor = (session: string) => sha('oauth-consent:' + session).slice(0, 32);
const registrations = new Map<string, number[]>();

/** A workspace this signed-in account can approve for: who they are there and with which of their accounts. */
export type Membership = {id: string; name: string; person: string; personName: string; email: string};
export type OAuthContext = {
  accounts: Accounts;
  /** Active memberships of these linked accounts, the signed-in one first. */
  memberships: (emails: string[]) => Membership[];
  /** Known workspace ids, for ?ws= in resource metadata. */
  workspaceIds: () => string[];
  alive: (g: Grant) => boolean;
  /** Whether people sign in on this server at all (open mode has no accounts to approve with). */
  signInOn: boolean;
};

export const isOAuthPath = (path: string) => path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-') || path === '/.well-known/openid-configuration';

export async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL, ctx: OAuthContext): Promise<void> {
  const path = url.pathname, m = req.method ?? 'GET', db = ctx.accounts.db;
  if (m === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (!publicUrl()) return json(res, 404, {error: 'not_configured', error_description: 'Sign-in for apps needs PUBLIC_URL set on the server. Use a token from the Team page instead.'});
  if (path.startsWith('/.well-known/oauth-protected-resource') && m === 'GET') {
    const ws = url.searchParams.get('ws');
    return json(res, 200, protectedResourceMetadata(ws && ctx.workspaceIds().includes(ws) ? ws : null));
  }
  if ((path.startsWith('/.well-known/oauth-authorization-server') || path === '/.well-known/openid-configuration') && m === 'GET') return json(res, 200, authServerMetadata());
  try {
    if (path === '/oauth/register' && m === 'POST') {
      const ip = clientIp(req), now = Date.now(), tries = (registrations.get(ip) ?? []).filter(t => now - t < 3600_000);
      if (tries.length >= 30) return json(res, 429, {error: 'slow_down', error_description: 'Too many registrations'});
      registrations.set(ip, [...tries, now]);
      let body: Record<string, unknown> | null = null;
      try { body = JSON.parse(await readBody(req)); } catch { /* below */ }
      if (!body || typeof body !== 'object') return json(res, 400, {error: 'invalid_client_metadata', error_description: 'JSON body required'});
      const c = registerClient(db, body);
      if ('error' in c) return json(res, 400, {error: 'invalid_redirect_uri', error_description: c.error});
      return json(res, 201, {client_id: c.id, client_name: c.name, redirect_uris: c.redirectUris, grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.now() / 1000)});
    }
    if (path === '/oauth/token' && m === 'POST') {
      const p = await params(req), grant = p.get('grant_type');
      const r = grant === 'authorization_code' ? exchangeCode(db, {code: p.get('code'), client_id: p.get('client_id'), redirect_uri: p.get('redirect_uri'), code_verifier: p.get('code_verifier')}, ctx.alive)
        : grant === 'refresh_token' ? refreshTokens(db, {refresh_token: p.get('refresh_token'), client_id: p.get('client_id')}, ctx.alive)
          : err('unsupported_grant_type', 'Use authorization_code or refresh_token');
      return r.ok ? json(res, 200, r.body, {pragma: 'no-cache'}) : json(res, 400, {error: r.error, error_description: r.description});
    }
    if (path === '/oauth/revoke' && m === 'POST') {
      const t = (await params(req)).get('token');
      if (t) revokeToken(db, t);
      return json(res, 200, {});
    }
    if (path === '/oauth/authorize' && (m === 'GET' || m === 'POST')) return await authorize(req, res, url, ctx, m === 'POST' ? await params(req) : url.searchParams);
  } catch (e) {
    console.error('OAuth request failed', (e as Error).message);
    return json(res, 400, {error: 'invalid_request'});
  }
  return json(res, 404, {error: 'not_found'});
}

async function authorize(req: IncomingMessage, res: ServerResponse, url: URL, ctx: OAuthContext, input: URLSearchParams) {
  const db = ctx.accounts.db, post = req.method === 'POST';
  const p = new URLSearchParams([...input].filter(([k]) => k !== 'decision' && k !== 'csrf' && k !== 'workspace'));
  const parsed = parseAuthRequest(db, p);
  if (!parsed.ok) return parsed.redirect ? redirect(res, parsed.redirect) : page(res, 400, 'Cannot connect', `<p>${esc(parsed.error)}</p>`);
  if (!ctx.signInOn) return page(res, 400, 'Cannot connect', '<p>Sign-in is turned off on this Cadence server, so apps cannot connect by signing in. An admin can turn on <b>Require sign in</b> on the Team page, or create a token there instead.</p>');
  const session = cookie(req, ACCOUNT_COOKIE), email = ctx.accounts.sessionEmail(session);
  const here = `/oauth/authorize?${p}`;
  const secure = publicUrl()!.startsWith('https:');
  if (!email || !session) {
    // Sign in first (password, Google or an emailed link); the app brings them back here afterwards.
    return redirect(res, '/#/signin', [`${NEXT_COOKIE}=${encodeURIComponent(here)}; SameSite=Lax; Path=/; Max-Age=1800${secure ? '; Secure' : ''}`]);
  }
  const clearNext = `${NEXT_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
  const spaces = ctx.memberships(ctx.accounts.group(email));
  const r = parsed.req;
  if (post) {
    // CSRF: the session cookie is SameSite=Lax, the form carries a token tied to the session, and the origin must be ours.
    const origin = req.headers.origin;
    if (origin && origin !== new URL(publicUrl()!).origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return page(res, 403, 'Cannot connect', '<p>This request came from another site.</p>');
    const got = Buffer.from(input.get('csrf') ?? ''), want = Buffer.from(csrfFor(session));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return redirect(res, here);
    if (input.get('decision') !== 'allow') return redirect(res, denialRedirect(r), [clearNext]);
    const w = spaces.find(s => s.id === input.get('workspace'));
    if (!w) return redirect(res, here);
    return redirect(res, approvalRedirect(r, issueCode(db, r, {email: w.email, workspace: w.id, person: w.person})), [clearNext]);
  }
  if (!spaces.length) return page(res, 403, 'Cannot connect', `<p>You are signed in as <b>${esc(email)}</b>, but that account is not a member of any workspace here. Ask an admin to invite you.</p>`, [clearNext]);
  const first = spaces.find(s => s.id === r.ws) ?? spaces[0];
  const host = new URL(r.redirectUri).host;
  const hidden = [...p].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const picker = spaces.length > 1
    ? `<label class="ws">Workspace<select name="workspace">${spaces.map(s => `<option value="${esc(s.id)}"${s.id === first.id ? ' selected' : ''}>${esc(s.name)} (as ${esc(s.personName)})</option>`).join('')}</select></label>`
    : `<input type="hidden" name="workspace" value="${esc(first.id)}">`;
  const body = `<p><b>${esc(r.client.name)}</b> wants to use Cadence as you: <b>${esc(first.personName)}</b> (${esc(email)})${spaces.length === 1 ? ` in <b>${esc(first.name)}</b>` : ''}.</p>
    <ul><li>See the spaces and tasks you can see</li><li>Create, update and comment on work, only as far as your role allows</li><li>It cannot sign approvals or change who has access</li></ul>
    <form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${csrfFor(session)}">${picker}
    <p class="note">After you allow, you go back to <b>${esc(host)}</b>. Only allow apps you just set up yourself. You can disconnect any time under Connected apps on the Team page (My account).</p>
    <div class="row"><button name="decision" value="deny" class="ghost">Cancel</button><button name="decision" value="allow" class="primary">Allow</button></div></form>`;
  return page(res, 200, `Connect ${r.client.name} to Cadence?`, body, [clearNext]);
}

function page(res: ServerResponse, status: number, title: string, body: string, cookies: string[] = []) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'");
  // same-origin, not no-referrer: with no-referrer browsers send Origin: null on the form post, which the origin check refuses.
  res.setHeader('referrer-policy', 'same-origin');
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2430}
.card{background:#fff;border:1px solid #e3e6eb;border-radius:12px;padding:28px;max-width:440px;width:calc(100% - 32px);box-shadow:0 2px 10px rgba(0,0,0,.04)}
h1{font-size:20px;margin:0 0 14px}ul{padding-left:20px}.note{font-size:13px;color:#5b6472}.row{display:flex;gap:10px;margin-top:16px}
button{flex:1;font:inherit;font-weight:600;padding:10px;border-radius:8px;cursor:pointer}.primary{background:#7c5cff;color:#fff;border:1px solid #7c5cff}.ghost{background:#fff;border:1px solid #cfd4dc;color:#1f2430}
.ws{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#5b6472}select{font:inherit;padding:8px;border-radius:8px;border:1px solid #cfd4dc}
</style></head><body><main class="card"><h1>${esc(title)}</h1>${body}</main></body></html>`);
}
