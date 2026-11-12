// Sign-in, sessions, roles and permissions.
//
// Open mode (the default for pnpm dev): no sign-in, anyone on this computer picks who they are.
// Once sign-in is required (pnpm start, CADENCE_REQUIRE_LOGIN=1, or "Require sign in" on the Team page), every
// API call needs a session (accounts.ts), the acting person is the one with the account's email, and each action is checked against that person's role
// in the item's project.
//
// Roles are sets of capabilities. A person has a default role; each project can override it per person,
// and set what everyone else gets (including "no access").
import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import type {Db} from './db.ts';
import {DEFAULT_CUSTOM, DEFAULT_FEATURES, POLICY_IDS, type Area, type Customization, type Features} from '../src/types.ts';
import {Invalid} from './errors.ts';
import {cleanDomainJoin, cleanJobRoles, jobRoleGrant, migrateJobRoles, NO_DOMAIN_JOIN, personJobRoles, type DomainJoin, type JobRole} from './jobroles.ts';

export const CAPS = ['view', 'comment', 'create', 'edit', 'delete', 'sprints', 'views', 'templates', 'settings', 'export'] as const;
export type Cap = typeof CAPS[number];
export const CAP_LABELS: Record<Cap, string> = {
  view: 'See the space', comment: 'Comment', create: 'Create items', edit: 'Edit items', delete: 'Delete items',
  sprints: 'Manage sprints', views: 'Create and change views', templates: 'Use and save templates',
  settings: 'Space settings (statuses, fields, automations)', export: 'Export data',
};
export type Role = {id: string; name: string; caps: Cap[]};
export const DEFAULT_ROLES: Role[] = [
  {id: 'admin', name: 'Admin', caps: [...CAPS]},
  {id: 'editor', name: 'Editor', caps: ['view', 'comment', 'create', 'edit', 'delete', 'sprints', 'views', 'templates', 'export']},
  {id: 'contributor', name: 'Contributor', caps: ['view', 'comment', 'create', 'edit']},
  {id: 'commenter', name: 'Commenter', caps: ['view', 'comment']},
  {id: 'viewer', name: 'Viewer', caps: ['view']},
];
export type Workspace = {requireLogin: boolean; roles: Role[]; google: {clientId: string; clientSecret: string; senderEmail?: string; refreshToken?: string}; custom: Customization; features: Features; jobRoles: JobRole[]; domainJoin: DomainJoin};
export type Access = {default: string; members: Record<string, string>; private?: boolean}; // role ids, or 'none'
/** A personal space: only its owner until they share it. Workspace admins get no automatic access. */
export const personalAccess = (owner: string): Access => ({default: 'none', members: {[owner]: 'admin'}, private: true});

/** Who may change a space's access rules: admins for normal spaces; for a personal space, its members who manage settings. */
export function mayChangeAccess(db: Db, personId: string | null, current: Access | undefined, next: Access | undefined): string | null {
  const admin = !!personId && !!(db.prepare('select admin from people where id = ?').get(personId) as {admin: number} | undefined)?.admin;
  if (current?.private) {
    if (!capsFor(db, personId, current, true).has('settings')) return 'Only the owner of this personal space can share it';
  } else if (!admin) return 'Only admins change access';
  if (next?.private) {
    const w = getWorkspace(db);
    const managers = Object.entries(next.members).filter(([, r]) => w.roles.find(x => x.id === r)?.caps.includes('settings'));
    if (!managers.length) throw new Invalid('A personal space needs at least one person with full access');
    if (!admin && !next.members[personId!]) return 'Keep yourself in your personal space, or ask an admin to take it over';
  }
  return null;
}

export function migrate(db: Db) {
  db.exec(`
    create table if not exists workspace (key text primary key, value text not null);
  `);
  const cols = db.prepare('pragma table_info(people)').all().map(r => r.name);
  if (!cols.includes('password')) db.exec('alter table people add column password text');
  if (!cols.includes('role')) db.exec("alter table people add column role text not null default 'editor'");
  if (!cols.includes('admin')) db.exec('alter table people add column admin integer not null default 0');
  if (!cols.includes('active')) db.exec('alter table people add column active integer not null default 1');
  if (!cols.includes('notify_email')) db.exec('alter table people add column notify_email integer not null default 0');
  // The first person is the workspace admin until someone says otherwise.
  migrateJobRoles(db);
  if (!(db.prepare('select 1 from people where admin = 1').get())) db.exec('update people set admin = 1 where rowid = (select min(rowid) from people)');
}

/** CADENCE_REQUIRE_LOGIN=1 (the default for pnpm start) turns sign-in on for every workspace. */
export const loginForced = () => process.env.CADENCE_REQUIRE_LOGIN === '1';

const stored = (db: Db) => { const r = db.prepare("select value from workspace where key = 'settings'").get() as {value: string} | undefined; return r ? JSON.parse(r.value) : {}; };
export function getWorkspace(db: Db): Workspace {
  const w = stored(db);
  return {requireLogin: loginForced() || !!w.requireLogin, roles: w.roles?.length ? w.roles : DEFAULT_ROLES, google: {clientId: '', clientSecret: '', ...w.google},
    custom: {...DEFAULT_CUSTOM, ...w.custom}, features: {...DEFAULT_FEATURES, ...w.features},
    jobRoles: Array.isArray(w.jobRoles) ? w.jobRoles : [], domainJoin: {...NO_DOMAIN_JOIN, ...w.domainJoin}};
}
/** Whether a view config change touches its settings, not just its lock or privacy. */
export const settingsChanged = (before: object, after: object) => {
  const b = before as Record<string, unknown>, a = after as Record<string, unknown>;
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].some(k => k !== 'locked' && k !== 'privateTo' && JSON.stringify(b[k]) !== JSON.stringify(a[k]));
};
/** Locked areas of the team setup are changed only by admins (see src/customize.ts). */
export const areaLocked = (db: Db, area: Area) => getWorkspace(db).custom[area] === 'locked';

export function saveWorkspace(db: Db, patch: Partial<Workspace>) {
  const cur = getWorkspace(db);
  // Unknown policies and non-boolean feature switches keep the current value (API and restores alike).
  if (patch.custom) patch = {...patch, custom: Object.fromEntries(Object.entries(cur.custom).map(([k, v]) => {
    const n = (patch.custom as Record<string, unknown>)[k];
    return [k, (POLICY_IDS as readonly unknown[]).includes(n) ? n : v];
  })) as Customization};
  if (patch.features) patch = {...patch, features: Object.fromEntries(Object.entries(cur.features).map(([k, v]) => {
    const n = (patch.features as Record<string, unknown>)[k];
    return [k, typeof n === 'boolean' ? n : v];
  })) as Features};
  const levels = (patch.roles ?? cur.roles).map(r => r.id);
  if (patch.jobRoles !== undefined) patch = {...patch, jobRoles: cleanJobRoles(patch.jobRoles, levels)};
  if (patch.domainJoin !== undefined) patch = {...patch, domainJoin: cleanDomainJoin(patch.domainJoin, levels, patch.jobRoles ?? cur.jobRoles)};
  const w = {...cur, requireLogin: !!stored(db).requireLogin, ...patch};
  if (!w.roles.some(r => r.id === 'admin')) throw new Error('The Admin role cannot be removed');
  w.roles = w.roles.map(r => r.id === 'admin' ? {...r, caps: [...CAPS]} : r);
  db.prepare("insert into workspace (key, value) values ('settings', ?) on conflict(key) do update set value = excluded.value").run(JSON.stringify(w));
  return w;
}

export function hashPassword(pw: string) {
  if (pw.length < 8) throw new Invalid('Passwords need at least 8 characters');
  if (pw.length > 200) throw new Invalid('Passwords are limited to 200 characters');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function checkPassword(pw: string, stored: string | null) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex'), b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Capabilities a person has in a project. Workspace admins always have everything. */
/** What a person may do in one space. Order: per-person entry, job roles, the space's default, the person's level (see jobroles.ts). */
export function capsFor(db: Db, personId: string | null, projectAccess: Access | undefined, strict = false, projectId?: string): Set<Cap> {
  const w = getWorkspace(db);
  if (!w.requireLogin && !strict) return new Set(CAPS); // open mode (tokens pass strict and always get their role)
  if (!personId) return new Set();
  const p = db.prepare('select role, admin, active from people where id = ?').get(personId) as {role: string; admin: number; active: number} | undefined;
  if (!p || !p.active) return new Set();
  if (p.admin && !projectAccess?.private) return new Set(CAPS);
  const levelCaps = (id: string) => w.roles.find(r => r.id === id)?.caps ?? [];
  const member = projectAccess?.members[personId];
  if (member === undefined && projectId && !projectAccess?.private && w.jobRoles.length) {
    const g = jobRoleGrant(w.jobRoles, personJobRoles(db, personId), projectId);
    if (g === 'none') return new Set();
    if (g) return new Set(g.flatMap(levelCaps));
  }
  const roleId = member ?? (projectAccess && projectAccess.default !== 'inherit' ? projectAccess.default : p.role);
  if (roleId === 'none') return new Set();
  return new Set(levelCaps(roleId));
}
