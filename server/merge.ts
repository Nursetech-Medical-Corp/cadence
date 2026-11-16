// Merge two team member rows into one (admins): the same AI or person that ended up on the team twice, like an AI
// that joined by invite as a person and was then added again as an agent. Everything that names the old row moves
// to the kept row; the old row is deactivated, never deleted, so history still reads.
import {Invalid} from './errors.ts';
import type {Tasks} from './service.ts';

type Row = {id: string; name: string; email: string | null; kind: string | null; owner: string | null; agent: string | null; active: number; admin: number};

/** Columns that hold one person id. Tables that do not exist in this workspace are skipped. */
const SINGLE: [string, string][] = [
  ['items', 'created_by'], ['comments', 'author'], ['time_entries', 'person'], ['notifications', 'person'], ['notifications', 'actor'],
  ['activity', 'actor'], ['work_log', 'actor'], ['files', 'by'], ['work_artifacts', 'agent'], ['events', 'organizer'], ['gcal_items', 'person'],
  ['proposals', 'agent'], ['proposals', 'owner'], ['proposals', 'decided_by'], ['approvals', 'requested_by'], ['approvals', 'approver'],
  ['tokens', 'person'], ['google_links', 'person'], ['event_attendees', 'person'],
];

export function mergePeople(tasks: Tasks, fromId: string, intoId: string, actor: string | null) {
  const db = tasks.db;
  const get = (id: string) => db.prepare('select id, name, email, kind, owner, agent, coalesce(active, 1) as active, admin from people where id = ?').get(id) as Row | undefined;
  const from = get(fromId), into = get(intoId);
  if (!from || !into) throw new Invalid('No such person');
  if (from.id === into.id) throw new Invalid('Pick two different rows');
  if (actor === from.id) throw new Invalid('You cannot merge yourself away');
  const has = (table: string, col: string) => (db.prepare(`pragma table_info(${table})`).all() as {name: string}[]).some(c => c.name === col);
  const moved: Record<string, number> = {};
  db.exec('begin');
  try {
    for (const [table, col] of SINGLE) {
      if (!has(table, col)) continue;
      // A row that would clash with one the kept person already has (same unique key) stays with the old row.
      const n = Number(db.prepare(`update or ignore ${table} set ${col} = ? where ${col} = ?`).run(into.id, from.id).changes);
      if (n) moved[`${table}.${col}`] = n;
    }
    // Assignees and AI review records live in item JSON.
    let items = 0;
    for (const r of db.prepare("select id, assignees, fields from items where assignees like ? or fields like ?").all(`%${from.id}%`, `%${from.id}%`) as {id: string; assignees: string; fields: string}[]) {
      const a = (JSON.parse(r.assignees || '[]') as string[]).map(x => x === from.id ? into.id : x);
      const f = JSON.parse(r.fields || '{}') as Record<string, unknown>;
      const rv = f.review as Record<string, unknown> | undefined;
      if (rv) for (const k of ['agent', 'by']) if (rv[k] === from.id) rv[k] = into.id;
      db.prepare('update items set assignees = ?, fields = ? where id = ?').run(JSON.stringify([...new Set(a)]), JSON.stringify(f), r.id);
      items++;
    }
    if (items) moved['items.assignees'] = items;
    // Agents the old row owned: owned by the kept row, or by its owner when the kept row is itself an agent (agents never own agents).
    const newOwner = into.kind === 'ai' ? into.owner : into.id;
    const owned = Number(db.prepare("update people set owner = ? where owner = ? and id <> ?").run(newOwner, from.id, into.id).changes);
    if (owned) moved['people.owner'] = owned;
    // The kept row takes what it lacks: the sign-in email, agent settings, an owner.
    if (!into.email && from.email) {
      db.prepare('update people set email = null where id = ?').run(from.id);
      db.prepare('update people set email = ? where id = ?').run(from.email, into.id);
    }
    if (!into.agent && from.agent) db.prepare('update people set agent = ? where id = ?').run(from.agent, into.id);
    if (into.kind === 'ai' && into.owner === from.id) db.prepare('update people set owner = ? where id = ?').run(from.owner ?? actor, into.id);
    db.prepare("update people set active = 0, name = ? where id = ?").run(`${from.name} (merged)`.slice(0, 120), from.id);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  tasks.emit({kind: 'people'});
  return {kept: into.id, removed: from.id, moved};
}
