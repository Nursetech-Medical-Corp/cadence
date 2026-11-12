// Invites: an admin invites someone by email into this workspace with a role. They get a one-time link, valid
// for 7 days, where they set their name (a password is optional), and are signed in. Only a hash of the
// link's secret is stored, so a copy of the database cannot be used to accept invites.
import {createHash, randomBytes} from 'node:crypto';
import type {Db} from './db.ts';
import {Invalid, NotFound} from './errors.ts';
import {hashPassword} from './auth.ts';

const DAYS = 7;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export type Invite = {id: string; email: string; name: string | null; role: string; jobRoles: string[]; by: string | null; created: string; expires: string; accepted: string | null};

export function migrateInvites(db: Db) {
  db.exec(`create table if not exists invites (id text primary key, email text not null, name text, role text not null, token text not null unique,
    by text, created text not null, expires text not null, accepted text)`);
  const cols = db.prepare('pragma table_info(invites)').all().map(r => r.name);
  if (!cols.includes('job_roles')) db.exec("alter table invites add column job_roles text not null default '[]'");
}
const parseList = (v: unknown) => { try { const a = JSON.parse(String(v ?? '[]')); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
const row = (r: Record<string, unknown>): Invite => ({id: r.id as string, email: r.email as string, name: (r.name as string) ?? null, role: r.role as string, jobRoles: parseList(r.job_roles),
  by: (r.by as string) ?? null, created: r.created as string, expires: r.expires as string, accepted: (r.accepted as string) ?? null});

export function createInvite(db: Db, input: {email?: unknown; name?: unknown; role?: unknown; jobRoles?: unknown}, by: string | null, roles: string[], jobRoleIds: string[] = []) {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email) || email.length > 200) throw new Invalid('Enter a valid email address');
  const role = String(input.role ?? 'editor');
  if (!roles.includes(role)) throw new Invalid(`Role must be one of: ${roles.join(', ')}`);
  const jobRoles = [...new Set((Array.isArray(input.jobRoles) ? input.jobRoles : []).map(String))];
  for (const j of jobRoles) if (!jobRoleIds.includes(j)) throw new Invalid(`Unknown job role "${j}"`);
  const existing = db.prepare('select password, active from people where lower(email) = ?').get(email) as {password: string | null; active: number} | undefined;
  if (existing?.password && existing.active) throw new Invalid('That person already has an account in this workspace. They can sign in.');
  const secret = randomBytes(32).toString('base64url');
  const inv = {id: randomBytes(6).toString('hex'), email, name: String(input.name ?? '').trim().slice(0, 100) || null, role, jobRoles, by,
    created: new Date().toISOString(), expires: new Date(Date.now() + DAYS * 86400_000).toISOString()};
  db.prepare('delete from invites where email = ? and accepted is null').run(email); // one live invite per email
  db.prepare('insert into invites (id, email, name, role, job_roles, token, by, created, expires) values (?,?,?,?,?,?,?,?,?)').run(inv.id, inv.email, inv.name, inv.role, JSON.stringify(jobRoles), sha(secret), inv.by, inv.created, inv.expires);
  return {invite: {...inv, accepted: null} as Invite, secret};
}
export const listInvites = (db: Db) => db.prepare('select * from invites where accepted is null order by created desc').all().map(row);
export const revokeInvite = (db: Db, id: string) => { db.prepare('delete from invites where id = ? and accepted is null').run(id); };

/** The invite behind a link, if it is still good. */
export function findInvite(db: Db, secret: string): Invite {
  const r = /^[\w-]{20,100}$/.test(secret) ? db.prepare('select * from invites where token = ?').get(sha(secret)) : undefined;
  if (!r) throw new NotFound('This invite link is not valid. Ask for a new one.');
  const inv = row(r);
  if (inv.accepted) throw new Invalid('This invite was already used. Sign in instead.');
  if (inv.expires < new Date().toISOString()) throw new Invalid('This invite has expired. Ask for a new one.');
  return inv;
}

/** Joins the workspace: makes (or completes) the person, sets the password if one was given, marks the invite used. Returns the person id. */
export function acceptInvite(db: Db, secret: string, input: {name?: unknown; password?: unknown}, createPerson: (name: string, email: string) => string) {
  const inv = findInvite(db, secret);
  const name = String(input.name ?? '').trim() || inv.name || inv.email.split('@')[0];
  if (name.length > 100) throw new Invalid('Names are limited to 100 characters');
  const password = String(input.password ?? '');
  const hash = password ? hashPassword(password) : null; // passwordless unless they choose one
  const existing = db.prepare('select id from people where lower(email) = ?').get(inv.email) as {id: string} | undefined;
  const id = existing?.id ?? createPerson(name, inv.email);
  db.prepare('update people set name = ?, password = ?, role = ?, job_roles = ?, active = 1 where id = ?').run(name, hash, inv.role, JSON.stringify(inv.jobRoles), id);
  db.prepare('update invites set accepted = ? where id = ?').run(new Date().toISOString(), inv.id);
  return id;
}
