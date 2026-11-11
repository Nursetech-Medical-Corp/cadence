// Google connections: one sender account so notifications can be emailed through Gmail, and each person's own
// calendars and Gmail. Signing in with Google is separate (signin.ts).
// Needs an OAuth client (Google Cloud console, type "Web application") with the redirect URI
//   http://<host>/api/auth/google/callback
// Client ID and secret are entered by an admin on the Team page and kept in the local database.
import {randomBytes} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Db} from './db.ts';
import {getWorkspace, saveWorkspace} from './auth.ts';
import {SCOPES, saveLink} from './googlelinks.ts';

const pending = new Map<string, {mode: 'connect' | 'link'; actor: string | null; at: number; want?: string}>();
const redirectUri = (req: IncomingMessage) => `http://${req.headers.host}/api/auth/google/callback`;

function go(res: ServerResponse, to: string) { res.statusCode = 302; res.setHeader('location', to); res.end(); }

export function googleStart(db: Db, req: IncomingMessage, res: ServerResponse, mode: 'connect' | 'link', actor: string | null, want: ('calendar' | 'gmail')[] = []) {
  const g = getWorkspace(db).google;
  if (!g.clientId || !g.clientSecret) return go(res, '/#/team?error=' + encodeURIComponent('Google is not set up yet. An admin adds the OAuth client on the Team page.'));
  const state = randomBytes(16).toString('hex');
  if (mode === 'link' && !actor) return go(res, '/#/team?error=' + encodeURIComponent('Pick who you are first, then connect Google.'));
  pending.set(state, {mode, actor, at: Date.now(), want: want.join(',')});
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
  const scope = mode === 'connect' ? 'openid email https://www.googleapis.com/auth/gmail.send' : ['openid email', ...want.map(w => SCOPES[w])].join(' ');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({client_id: g.clientId, redirect_uri: redirectUri(req), response_type: 'code', scope, state,
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true'}).toString();
  go(res, u.toString());
}

async function token(params: Record<string, string>) {
  const r = await fetch('https://oauth2.googleapis.com/token', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(params)});
  const j = await r.json() as {access_token?: string; refresh_token?: string; scope?: string; error_description?: string; error?: string};
  if (!r.ok || !j.access_token) throw new Error(j.error_description ?? j.error ?? 'Google token request failed');
  return j;
}

export async function googleCallback(db: Db, req: IncomingMessage, res: ServerResponse, url: URL) {
  const state = pending.get(url.searchParams.get('state') ?? '');
  pending.delete(url.searchParams.get('state') ?? '');
  const fail = (msg: string) => go(res, '/#/team?error=' + encodeURIComponent(msg));
  if (!state) return fail('Sign-in expired. Please try again.');
  if (url.searchParams.get('error')) return fail('Google sign-in was cancelled.');
  const g = getWorkspace(db).google;
  try {
    const t = await token({code: url.searchParams.get('code') ?? '', client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: redirectUri(req), grant_type: 'authorization_code'});
    const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {headers: {authorization: `Bearer ${t.access_token}`}})).json() as {email?: string; email_verified?: boolean};
    if (!info.email || info.email_verified === false) return fail('Google did not return a verified email.');
    if (state.mode === 'link') {
      if (!t.refresh_token) return fail('Google did not grant offline access. Remove the app at myaccount.google.com/permissions and connect again.');
      saveLink(db, state.actor!, info.email, t.refresh_token, t.scope ?? '');
      return go(res, '/#/team?linked=' + encodeURIComponent(info.email));
    }
    const admin = state.actor && (db.prepare('select admin from people where id = ?').get(state.actor) as {admin: number} | undefined)?.admin;
    if (getWorkspace(db).requireLogin && !admin) return fail('Only admins can connect the email sender.');
    if (!t.refresh_token) return fail('Google did not grant offline access. Remove the app at myaccount.google.com/permissions and connect again.');
    saveWorkspace(db, {google: {...g, refreshToken: t.refresh_token, senderEmail: info.email}});
    return go(res, '/#/team?connected=1');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Google sign-in failed');
  }
}

/** Sends a notification by email when the workspace has a connected sender and the person opted in. */
export async function sendNotificationEmail(db: Db, n: {person: string; text: string; actor: string | null; itemId: string | null}) {
  const g = getWorkspace(db).google;
  if (!g.refreshToken || !g.senderEmail) return;
  const to = db.prepare('select email, notify_email from people where id = ?').get(n.person) as {email: string | null; notify_email: number} | undefined;
  if (!to?.email || !to.notify_email || /[\r\n,;<>]/.test(to.email)) return;
  const who = n.actor ? (db.prepare('select name from people where id = ?').get(n.actor) as {name: string} | undefined)?.name ?? 'Someone' : 'Cadence';
  await sendEmail(db, to.email, `${who} ${n.text}`, `${who} ${n.text}\n\nOpen Cadence to see it. Turn these emails off on the Team page.`);
}

/** Sends a plain email from the workspace's connected Gmail. Returns false when no sender is connected. */
export async function sendEmail(db: Db, to: string, subjectText: string, body: string) {
  const g = getWorkspace(db).google;
  if (!g.refreshToken || !g.senderEmail || /[\r\n,;<>]/.test(to)) return false;
  const t = await token({refresh_token: g.refreshToken, client_id: g.clientId, client_secret: g.clientSecret, grant_type: 'refresh_token'});
  const subject = subjectText.slice(0, 140);
  const mime = [`From: Cadence <${g.senderEmail}>`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', body].join('\r\n');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: {authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json'},
    body: JSON.stringify({raw: Buffer.from(mime).toString('base64url')}),
  });
  if (!r.ok) throw new Error(`Gmail send failed: ${r.status}`);
  return true;
}
