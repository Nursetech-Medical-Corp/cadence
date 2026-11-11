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

const DAYS = 30;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DUMMY = hashPassword('not-a-real-password-just-timing');
export const ACCOUNT_COOKIE = 'cadence_session';

export class Accounts {
  constructor(readonly db: Db) {
    db.exec(`create table if not exists accounts (email text primary key, password text, created text not null);
      create table if not exists account_sessions (hash text primary key, email text not null, created text not null, expires text not null);`);
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
