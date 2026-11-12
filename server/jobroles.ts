// Job roles: company-defined roles (Executive, Sales rep, R&D engineer, VA...) that say which spaces a person
// sees and at which permission level. Set once per job role on the Team page instead of per space.
//
// How a person's access to a shared space is decided, first match wins:
//   1. A per-person entry on that space (the space's Access card).
//   2. Their job roles: the strongest level any of them grants there ("none" only when every matching job role says none).
//   3. The space's "everyone else" setting, when it is not "inherit".
//   4. The person's default permission level.
// Personal (private) spaces ignore job roles: only the people the owner shared with get in. Admins pass every shared space.
//
// Domain join: people signing in with Google on a listed company domain join the workspace on their own,
// with a starting level and job roles. Google has verified the address, so no invite is needed.
import type {Db} from './db.ts';
import {Invalid} from './errors.ts';

export type JobRole = {id: string; name: string; spaces: Record<string, string>; others: string};
export type DomainJoin = {domains: string[]; level: string; jobRoles: string[]};
export const NO_DOMAIN_JOIN: DomainJoin = {domains: [], level: 'contributor', jobRoles: []};

export function migrateJobRoles(db: Db) {
  const cols = db.prepare('pragma table_info(people)').all().map(r => r.name);
  if (!cols.includes('job_roles')) db.exec("alter table people add column job_roles text not null default '[]'");
}

export const personJobRoles = (db: Db, personId: string): string[] => {
  try {
    const r = db.prepare('select job_roles from people where id = ?').get(personId) as {job_roles?: string} | undefined;
    const v = JSON.parse(r?.job_roles ?? '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; } // an older database without the column yet
};

/** What a person's job roles give in one space: level ids to combine, 'none', or undefined (they say nothing). */
export function jobRoleGrant(jobRoles: JobRole[], mine: string[], projectId: string): string[] | 'none' | undefined {
  const said = jobRoles.filter(j => mine.includes(j.id)).map(j => j.spaces[projectId] ?? j.others ?? 'inherit').filter(l => l !== 'inherit');
  if (!said.length) return undefined;
  const levels = said.filter(l => l !== 'none');
  return levels.length ? levels : 'none';
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'role';

/** Cleans job roles sent by the app or a restore: known levels only, unique ids, names required. */
export function cleanJobRoles(input: unknown, levels: string[]): JobRole[] {
  if (!Array.isArray(input)) throw new Invalid('jobRoles must be a list');
  if (input.length > 100) throw new Invalid('Up to 100 job roles');
  const ok = (l: unknown) => typeof l === 'string' && (l === 'inherit' || l === 'none' || levels.includes(l));
  const seen = new Set<string>();
  return input.map((raw: Record<string, unknown>) => {
    const name = String(raw?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
    if (!name) throw new Invalid('Every job role needs a name');
    let id = typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : slug(name);
    while (seen.has(id)) id += '-2';
    seen.add(id);
    const spaces: Record<string, string> = {};
    for (const [pid, l] of Object.entries((raw.spaces ?? {}) as Record<string, unknown>)) {
      if (!ok(l)) throw new Invalid(`Unknown level "${String(l)}" in job role ${name}`);
      if (l !== 'inherit') spaces[pid] = l as string;
    }
    const others = raw.others === undefined ? 'inherit' : raw.others;
    if (!ok(others)) throw new Invalid(`Unknown level "${String(others)}" in job role ${name}`);
    return {id, name, spaces, others: others as string};
  });
}

export function cleanDomainJoin(input: unknown, levels: string[], jobRoles: JobRole[]): DomainJoin {
  const raw = (input ?? {}) as Record<string, unknown>;
  const domains = [...new Set((Array.isArray(raw.domains) ? raw.domains : []).map(d => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  for (const d of domains) if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Invalid(`"${d}" is not a domain like example.com`);
  const level = String(raw.level ?? 'contributor');
  if (!levels.includes(level) || level === 'admin') throw new Invalid('Pick a starting level other than Admin');
  const jr = (Array.isArray(raw.jobRoles) ? raw.jobRoles : []).map(String).filter(id => jobRoles.some(j => j.id === id));
  return {domains: domains.slice(0, 20), level, jobRoles: jr};
}

/** Checks a person's job role list against the workspace's job roles. */
export function cleanPersonJobRoles(input: unknown, jobRoles: JobRole[]): string[] {
  if (!Array.isArray(input)) throw new Invalid('jobRoles must be a list of job role ids');
  const ids = [...new Set(input.map(String))];
  for (const id of ids) if (!jobRoles.some(j => j.id === id)) throw new Invalid(`Unknown job role "${id}"`);
  return ids;
}

export const domainOf = (email: string) => email.toLowerCase().split('@')[1] ?? '';
export const domainMatches = (dj: DomainJoin | undefined, email: string) => !!dj && dj.domains.includes(domainOf(email));

type JoinTarget = {db: Db; createPerson: (i: {name: string; email: string}) => {id: string}; emit: (e: {kind: 'people'}) => void};
/**
 * Adds a Google-verified email to every workspace whose company domain list has its domain. Skips workspaces
 * where the person is already a member, or was turned off by an admin. Returns how many workspaces they joined.
 */
export function joinByDomain(targets: JoinTarget[], email: string, readJoin: (db: Db) => DomainJoin): number {
  const e = email.toLowerCase();
  let n = 0;
  for (const t of targets) {
    const dj = readJoin(t.db);
    if (!domainMatches(dj, e) || t.db.prepare('select 1 from people where lower(email) = ?').get(e)) continue;
    const p = t.createPerson({name: e.split('@')[0], email: e});
    t.db.prepare('update people set role = ?, job_roles = ? where id = ?').run(dj.level, JSON.stringify(dj.jobRoles), p.id);
    t.emit({kind: 'people'});
    n++;
  }
  return n;
}
