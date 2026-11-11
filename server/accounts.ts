// Accounts: one sign-in for every workspace on this server. An account is an email and a password. In each
// workspace, a signed-in account acts as the active person with the same email; workspace admins decide who
// that is (Team page, invites). Only hashes of session tokens are stored, so a copy of the database cannot
// be used to sign in.
//
// Account passwords change only with the current password, through an invite for a new email, or by the
// server owner (pnpm reset-password). A workspace admin cannot take over an account used in other workspaces.
import {createHash, randomBytes} from 'node:crypto';
import type {Db} from './db.ts';
import {checkPassword, hashPassword} from './auth.ts';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {listWorkspaces} from './workspaces.ts';
import {makeVapid, type PushSub, type Vapid} from './push.ts';

/** What reaches a person's devices. The Inbox always keeps everything. */
export type NotifyPrefs = {off: string[]; quiet: {from: string; to: string} | null; pausedUntil: string | null; tz: string};
export const DEFAULT_NOTIFY: NotifyPrefs = {off: [], quiet: null, pausedUntil: null, tz: 'UTC'};
/** True while pushes should wait: paused, or inside quiet hours in the person's own time zone. */
export function quietNow(p: NotifyPrefs, now = new Date()) {
  if (p.pausedUntil && p.pausedUntil > now.toISOString()) return true;
  if (!p.quiet) return false;
  const hm = new Intl.DateTimeFormat('en-GB', {timeZone: p.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(now);
  const {from, to} = p.quiet;
  return from <= to ? hm >= from && hm < to : hm >= from || hm < to;
}

const DAYS = 30;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DUMMY = hashPassword('not-a-real-password-just-timing');
export const ACCOUNT_COOKIE = 'cadence_session';

export class Accounts {
  constructor(readonly db: Db) {
    db.exec(`create table if not exists accounts (email text primary key, password text, created text not null);
      create table if not exists account_sessions (hash text primary key, email text not null, created text not null, expires text not null);
      create table if not exists account_links (a text not null, b text not null, created text not null, primary key (a, b));
      create table if not exists signin_links (hash text primary key, email text not null, expires text not null);
      create table if not exists server_settings (key text primary key, value text not null);
      create table if not exists push_subs (endpoint text primary key, email text not null, p256dh text not null, auth text not null, created text not null);
      create table if not exists notify_prefs (email text primary key, value text not null);`);
  }

  /** Server-wide settings kept by the owner (the account that set the server up). */
  setting(key: string): string | null { return (this.db.prepare('select value from server_settings where key = ?').get(key) as {value: string} | undefined)?.value ?? null; }
  setSetting(key: string, value: string) { this.db.prepare('insert into server_settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value); }
  /** The server owner: the account that set the server up, or on servers set up before this was kept, the oldest account. */
  owner(): string | null { return this.setting('owner') ?? (this.db.prepare('select email from accounts order by created limit 1').get() as {email: string} | undefined)?.email ?? null; }
  /** Who may create an account on their own: 'invite' (only through an invite link, the default) or 'open'. */
  signup(): 'open' | 'invite' { return this.setting('signup') === 'open' ? 'open' : 'invite'; }

  /** The server's push key pair, made on first use. */
  vapid(): Vapid {
    const saved = this.setting('vapid');
    if (saved) return JSON.parse(saved) as Vapid;
    const v = makeVapid();
    this.setSetting('vapid', JSON.stringify(v));
    return v;
  }
  /** A device that gets push notifications for this account (one per browser or installed app). */
  subscribe(email: string, s: PushSub) {
    this.db.prepare('insert into push_subs (endpoint, email, p256dh, auth, created) values (?, ?, ?, ?, ?) on conflict(endpoint) do update set email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth')
      .run(s.endpoint, email, s.p256dh, s.auth, new Date().toISOString());
  }
  unsubscribe(endpoint: string, email?: string) { this.db.prepare(`delete from push_subs where endpoint = ?${email ? ' and email = ?' : ''}`).run(...(email ? [endpoint, email] : [endpoint])); }
  subs(emails: string[]): PushSub[] {
    if (!emails.length) return [];
    return this.db.prepare(`select endpoint, p256dh, auth from push_subs where email in (${emails.map(() => '?').join(',')})`).all(...emails) as PushSub[];
  }
  /** Notification settings: the first of these linked accounts that saved any. */
  notifyPrefs(emails: string[]): NotifyPrefs {
    for (const e of emails) { const r = this.db.prepare('select value from notify_prefs where email = ?').get(e) as {value: string} | undefined; if (r) return {...DEFAULT_NOTIFY, ...JSON.parse(r.value)}; }
    return DEFAULT_NOTIFY;
  }
  setNotifyPrefs(email: string, p: NotifyPrefs) { this.db.prepare('insert into notify_prefs (email, value) values (?, ?) on conflict(email) do update set value = excluded.value').run(email, JSON.stringify(p)); }

  /** A one-time sign-in link, valid for 15 minutes. Only its hash is stored; a new link voids older unused ones. */
  startSignInLink(email: string) {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('delete from signin_links where email = ? or expires < ?').run(email, new Date().toISOString());
    this.db.prepare('insert into signin_links (hash, email, expires) values (?, ?, ?)').run(sha(token), email, new Date(Date.now() + 15 * 60_000).toISOString());
    return token;
  }
  /** The account a sign-in link belongs to, used up on the way. Null when unknown, used or expired. */
  useSignInLink(token: string): string | null {
    const h = sha(String(token));
    const r = this.db.prepare('select email, expires from signin_links where hash = ?').get(h) as {email: string; expires: string} | undefined;
    if (!r) return null;
    this.db.prepare('delete from signin_links where hash = ?').run(h);
    return r.expires > new Date().toISOString() ? r.email : null;
  }
  count() { return (this.db.prepare('select count(*) as n from accounts').get() as {n: number}).n; }
  has(email: string) { return !!this.db.prepare('select 1 from accounts where email = ?').get(email); }
  hash(email: string) { return (this.db.prepare('select password from accounts where email = ?').get(email) as {password: string | null} | undefined)?.password ?? null; }
  /** Sets (or creates the account with) a password hash. Signs out every other session of the account. */
  setHash(email: string, hash: string | null, keepToken?: string) {
    this.db.prepare('insert into accounts (email, password, created) values (?, ?, ?) on conflict(email) do update set password = excluded.password').run(email, hash, new Date().toISOString());
    this.db.prepare('delete from account_sessions where email = ? and hash != ?').run(email, keepToken ? sha(keepToken) : '');
  }
  /**
   * Checks a password. Always runs one hash so timing does not reveal whether the email exists.
   * Older installs kept passwords per workspace: when there is no account yet and the password matches every
   * workspace that has one for this email, the account is created from it.
   */
  verify(email: string, password: string, legacy: () => string[]) {
    const stored = this.hash(email);
    if (stored) return checkPassword(password, stored);
    const old = this.has(email) ? [] : legacy();
    if (!old.length) { checkPassword(password, DUMMY); return false; }
    if (!old.every(h => checkPassword(password, h))) return false;
    this.setHash(email, old[0]);
    return true;
  }
  startSession(email: string) {
    const token = randomBytes(32).toString('base64url'), now = Date.now();
    this.db.prepare('insert into account_sessions (hash, email, created, expires) values (?,?,?,?)').run(sha(token), email, new Date(now).toISOString(), new Date(now + DAYS * 86400_000).toISOString());
    return token;
  }
  sessionEmail(token: string | undefined): string | null {
    if (!token) return null;
    const r = this.db.prepare('select email, expires from account_sessions where hash = ?').get(sha(token)) as {email: string; expires: string} | undefined;
    return r && r.expires > new Date().toISOString() ? r.email : null;
  }
  endSession(token: string | undefined) { if (token) this.db.prepare('delete from account_sessions where hash = ?').run(sha(token)); }

  // Linked accounts: one person's accounts (for example a work and a personal email). Linking needs both
  // passwords (the API checks the other one), so it is always the person's own choice; either side can unlink.
  link(a: string, b: string) {
    const ins = this.db.prepare('insert into account_links (a, b, created) values (?, ?, ?) on conflict do nothing'), t = new Date().toISOString();
    ins.run(a, b, t); ins.run(b, a, t);
  }
  unlink(a: string, b: string) { this.db.prepare('delete from account_links where (a = ? and b = ?) or (a = ? and b = ?)').run(a, b, b, a); }
  /** This account first, then every account linked to it, directly or through another. */
  group(email: string): string[] {
    const seen = [email], next = this.db.prepare('select b from account_links where a = ?');
    for (let n = 0; n < seen.length && seen.length < 20; n++) for (const r of next.all(seen[n])) if (!seen.includes(r.b as string)) seen.push(r.b as string);
    return seen;
  }
}

/** HttpOnly session cookie; Secure when the request came over HTTPS (directly or through a proxy). */
export const accountCookie = (token: string, secure: boolean) =>
  `${ACCOUNT_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? DAYS * 86400 : 0}${secure ? '; Secure' : ''}`;

/** The server's account store, beside the main workspace database (data/accounts.db). */
export function openAccounts() {
  const dir = dirname(listWorkspaces().find(w => w.id === 'main')!.db);
  mkdirSync(dir, {recursive: true}); // a fresh install has no data folder yet
  return new Accounts(new DatabaseSync(join(dir, 'accounts.db')));
}
