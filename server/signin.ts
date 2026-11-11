// Passwordless sign-in: "Continue with Google" and emailed sign-in links, plus the sign-in log and system mail.
// Settings come from the environment (the same names in Cadence, the CRM and the dataroom):
//   PUBLIC_URL            the address people use, for example https://cadence.example.com. Every emailed link starts with it.
//   GOOGLE_CLIENT_ID/_SECRET  an OAuth client (Web application) with redirect URI {PUBLIC_URL}/auth/google/callback
//   STAFF_GOOGLE_DOMAIN   accounts on this domain sign in only with Google (when Google is configured)
//   SMTP_HOST, SMTP_PORT (465 implicit TLS, 587 STARTTLS), SMTP_FROM, optional SMTP_USER and SMTP_PASS
// Google sign-in here is separate from the Google connections (Gmail sender, calendars) in google.ts.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {IncomingMessage, ServerResponse} from 'node:http';
import nodemailer from 'nodemailer';

const env = (k: string) => (process.env[k] ?? '').trim();
/** The public address of this server, without a trailing slash, or null when PUBLIC_URL is not set. */
export const publicUrl = () => { const u = env('PUBLIC_URL').replace(/\/+$/, ''); return /^https?:\/\/[^/]+/.test(u) ? u : null; };
/** PUBLIC_URL points at this computer: sign-in links may be printed in the server log instead of emailed. */
export const devLogMode = () => { const u = publicUrl(); if (!u) return false; const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost'); };
export const googleSignInReady = () => !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET') && publicUrl());
export const googleRedirectUri = () => `${publicUrl()}/auth/google/callback`;
/** Staff accounts sign in only with Google, so Google Workspace 2-Step Verification covers them. Off when Google is not configured. */
export const staffGoogleOnly = (email: string) => {
  const d = env('STAFF_GOOGLE_DOMAIN').toLowerCase().replace(/^@/, '');
  return !!d && googleSignInReady() && email.toLowerCase().endsWith('@' + d);
};
export const smtpReady = () => !!(env('SMTP_HOST') && env('SMTP_FROM'));

/** Sends a plain-text email over SMTP. Returns false when SMTP is not set up. */
export async function sendSmtp(to: string, subject: string, text: string) {
  if (!smtpReady() || /[\r\n,;<>]/.test(to)) return false;
  const port = Number(env('SMTP_PORT') || 587);
  const t = nodemailer.createTransport({host: env('SMTP_HOST'), port, secure: port === 465, requireTLS: port === 587,
    name: publicUrl() ? new URL(publicUrl()!).hostname : undefined,
    auth: env('SMTP_USER') ? {user: env('SMTP_USER'), pass: env('SMTP_PASS')} : undefined});
  await t.sendMail({from: env('SMTP_FROM'), to, subject: subject.slice(0, 140), text});
  return true;
}

/** The client's address. Behind a local proxy (Coolify, Caddy) it is the last X-Forwarded-For entry, the one the proxy added. */
export function clientIp(req: IncomingMessage) {
  const sock = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const local = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/.test(sock);
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return local && fwd.length ? fwd[fwd.length - 1] : sock;
}

export type SignInMethod = 'google' | 'link' | 'password' | 'invite';
/** Appends one line per sign-in attempt. Never pass tokens or passwords. */
export function logSignIn(file: string, req: IncomingMessage, email: string, method: SignInMethod, result: string) {
  try {
    mkdirSync(dirname(file), {recursive: true});
    appendFileSync(file, JSON.stringify({time: new Date().toISOString(), email: email.slice(0, 200), method, result, ip: clientIp(req), ua: String(req.headers['user-agent'] ?? '').slice(0, 300)}) + '\n');
  } catch (e) { console.error('Sign-in log failed', (e as Error).message); }
}

// ---- Google sign-in: authorization code flow with PKCE; state and verifier ride in a short-lived HttpOnly cookie ----
const STATE_COOKIE = 'cadence_google_signin';
const b64url = (b: Buffer) => b.toString('base64url');
const secureReq = (req: IncomingMessage) => req.headers['x-forwarded-proto'] === 'https' || 'encrypted' in req.socket;
const stateCookie = (value: string, req: IncomingMessage) =>
  `${STATE_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=${value ? 600 : 0}${secureReq(req) ? '; Secure' : ''}`;
function go(res: ServerResponse, to: string, cookies: string[] = []) { res.statusCode = 302; if (cookies.length) res.setHeader('set-cookie', cookies); res.setHeader('location', to); res.end(); }
const failTo = (msg: string) => '/#/signin?error=' + encodeURIComponent(msg);

export function googleSignInStart(req: IncomingMessage, res: ServerResponse) {
  if (!googleSignInReady()) return go(res, failTo('Google sign-in is not set up on this server.'));
  const state = b64url(randomBytes(32)), verifier = b64url(randomBytes(32));
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: googleRedirectUri(), response_type: 'code', scope: 'openid email profile',
    state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account'}).toString();
  go(res, u.toString(), [stateCookie(`${state}.${verifier}`, req)]);
}

/** Checks the claims of an ID token received straight from Google's token endpoint over TLS. Returns the verified email. */
export function checkIdToken(idToken: string, clientId: string, now = Date.now()): string {
  let c: {aud?: string; iss?: string; exp?: number; email?: string; email_verified?: boolean | string};
  try { c = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { throw new Error('Google sign-in failed. Please try again.'); }
  if (c.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(c.iss ?? '') || !c.exp || c.exp * 1000 < now) throw new Error('Google sign-in failed. Please try again.');
  if (!c.email || (c.email_verified !== true && c.email_verified !== 'true')) throw new Error('Google did not confirm that email address. Use a verified Google account.');
  return c.email.toLowerCase();
}

type Exchange = (params: Record<string, string>) => Promise<{id_token?: string}>;
const googleToken: Exchange = async params => {
  const r = await fetch('https://oauth2.googleapis.com/token', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(params)});
  const j = await r.json() as {id_token?: string; error?: string};
  if (!r.ok) throw new Error('Google sign-in failed. Please try again.');
  return j;
};

/** Google's redirect back. Signs in an existing account only; never creates one. */
export async function googleSignInCallback(req: IncomingMessage, res: ServerResponse, url: URL, opts: {
  hasAccount: (email: string) => boolean; signIn: (email: string) => string; log: (email: string, result: string) => void; exchange?: Exchange;
}) {
  const clear = stateCookie('', req);
  const fail = (msg: string, email = '', result = 'failed') => { opts.log(email, result); go(res, failTo(msg), [clear]); };
  const saved = (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(STATE_COOKIE + '='))?.slice(STATE_COOKIE.length + 1) ?? '';
  const [state = '', verifier = ''] = saved.split('.');
  const got = url.searchParams.get('state') ?? '';
  if (!state || !verifier || got.length !== state.length || !timingSafeEqual(Buffer.from(got), Buffer.from(state))) return fail('Sign-in expired. Please try again.', '', 'state mismatch');
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return fail('Google sign-in was cancelled.', '', 'cancelled');
  if (!googleSignInReady()) return fail('Google sign-in is not set up on this server.', '', 'not configured');
  let email: string;
  try {
    const t = await (opts.exchange ?? googleToken)({code: url.searchParams.get('code')!, client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri: googleRedirectUri(), grant_type: 'authorization_code', code_verifier: verifier});
    email = checkIdToken(t.id_token ?? '', env('GOOGLE_CLIENT_ID'));
  } catch (e) { return fail(e instanceof Error ? e.message : 'Google sign-in failed.', '', 'token rejected'); }
  if (!opts.hasAccount(email)) return fail('No account for that email. Ask an admin for an invite.', email, 'no account');
  opts.log(email, 'ok');
  go(res, '/#/mywork', [clear, opts.signIn(email)]);
}
