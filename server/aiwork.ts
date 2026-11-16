// Human and AI workers on the same board.
//
// People are "human" or "ai". Items say who should do them in fields.worker: human, ai, or either.
// AI work goes through a review loop kept in fields.review:
//   claimed (AI asks to take it) -> accepted (a human agrees, AI is assigned) -> submitted (AI reports)
//   -> approved (done), changes (sent back with a comment, AI continues), redo (start over from scratch)
//   or discarded (work rejected, attempt closed, item back where it was) ; declined ends a claim.
// Every step an agent takes can be written to the work log (with links and screenshots) so there is a
// complete record of what was done and what was missed. What the agent made is kept as artifacts, so a redo
// or a discard can remove it: Cadence hides its own files, and the agent confirms the cleanup of the rest.
import {Invalid, NotFound} from './errors.ts';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import type {Item, ItemPatch} from '../src/types.ts';
import type {Tasks} from './service.ts';

export type ReviewState = 'claimed' | 'accepted' | 'submitted' | 'changes' | 'redo' | 'approved' | 'declined' | 'discarded';
export type Decision = 'approve' | 'changes' | 'redo' | 'discard';
export const DECISIONS: Decision[] = ['approve', 'changes', 'redo', 'discard'];
/** attempt, started, since (last history id before the attempt) and prior (status and assignees before it) let a discard put things back. */
export type Review = {state: ReviewState; by: string | null; at: string; note?: string; agent?: string; session?: string; decision?: Decision;
  attempt?: number; started?: string; since?: number; prior?: {status: string; assignees: string[]}};
export type LogEntry = {id: string; itemId: string; actor: string | null; at: string; kind: 'step' | 'note' | 'link' | 'file' | 'result' | 'missed' | 'review' | 'cleanup'; text: string; url: string | null; session: string | null};
export const ARTIFACT_KINDS = ['file', 'doc', 'design', 'commit', 'branch', 'pr', 'item', 'url', 'other'] as const;
export type ArtifactInput = {kind: typeof ARTIFACT_KINDS[number]; ref: string; url?: string | null; undo?: string | null};
/** cleanup: null (kept), pending (the agent must undo it), confirmed (the agent said it did), removed (Cadence removed it). */
export type Artifact = {id: string; itemId: string; agent: string | null; attempt: number; kind: ArtifactInput['kind']; ref: string; url: string | null; undo: string | null;
  cleanup: null | 'pending' | 'confirmed' | 'removed'; note: string | null; created: string; confirmedAt: string | null};

const FILES = (tasks: Tasks) => join(tasks.dataDir, 'files');
const now = () => new Date().toISOString();
const id = () => randomBytes(6).toString('hex');
/** Still running: the agent holds the task. */
const OPEN: ReviewState[] = ['claimed', 'accepted', 'submitted', 'changes', 'redo'];

export function migrateAiWork(tasks: Tasks) {
  const cols = tasks.db.prepare('pragma table_info(people)').all().map(r => r.name);
  if (!cols.includes('kind')) tasks.db.exec("alter table people add column kind text not null default 'human'");
  tasks.db.exec(`
    create table if not exists work_log (id text primary key, item_id text not null, actor text, at text not null, kind text not null, text text not null, url text);
    create index if not exists work_log_item on work_log(item_id, at);
    create table if not exists files (id text primary key, item_id text not null, name text not null, mime text not null, size integer not null, created text not null, by text);
    create table if not exists work_artifacts (id text primary key, item_id text not null, agent text, attempt integer not null default 1, kind text not null, ref text not null,
      url text, undo text, cleanup text, note text, created text not null, confirmed_at text);
    create index if not exists work_artifacts_item on work_artifacts(item_id);
    create index if not exists work_artifacts_agent on work_artifacts(agent, cleanup);
  `);
  // Where the agent worked (a chat, session or run), and files hidden by a redo or discard.
  if (!tasks.db.prepare('pragma table_info(work_log)').all().some(r => r.name === 'session')) tasks.db.exec('alter table work_log add column session text');
  if (!tasks.db.prepare('pragma table_info(files)').all().some(r => r.name === 'removed')) tasks.db.exec('alter table files add column removed text');
}

export const personKind = (tasks: Tasks, pid: string | null) => pid ? ((tasks.db.prepare('select kind from people where id = ?').get(pid) as {kind: string} | undefined)?.kind ?? 'human') : 'human';
/** Who hears about AI activity on an item: whoever accepted it, the creator, and human assignees. */
function humansToTell(tasks: Tasks, i: Item) {
  const r = i.fields.review as {by?: string; agent?: string} | undefined;
  return [...new Set([agentOwner(tasks, r?.agent ?? null), r?.by, i.createdBy, ...i.assignees].filter((x): x is string => !!x && personKind(tasks, x) !== 'ai'))];
}
/** The person an AI agent belongs to (null for agents without an owner, from before owners existed). */
export const agentOwner = (tasks: Tasks, agent: string | null) => agent ? ((tasks.db.prepare('select owner from people where id = ?').get(agent) as {owner?: string | null} | undefined)?.owner ?? null) : null;
/** Who may accept a claim or approve work: the agent's owner, a person assigned to the task, or an admin. */
export function mayReview(tasks: Tasks, reviewer: string | null, i: Item, agent: string | null | undefined) {
  const owner = agentOwner(tasks, agent ?? null);
  if (!owner || !reviewer) return true; // agents without an owner, and open mode without a person: as before
  if (reviewer === owner || i.assignees.includes(reviewer)) return true;
  return !!(tasks.db.prepare('select admin from people where id = ?').get(reviewer) as {admin?: number} | undefined)?.admin;
}
const notOwner = (tasks: Tasks, agent: string | null | undefined) => {
  const owner = agentOwner(tasks, agent ?? null);
  const name = owner ? (tasks.db.prepare('select name from people where id = ?').get(owner) as {name?: string} | undefined)?.name : null;
  return new Invalid(`Only ${name ?? 'the agent\'s owner'}, someone assigned to this task, or an admin can approve this agent's work`);
};
const review = (i: Item) => (i.fields.review ?? null) as Review | null;
const setReview = (tasks: Tasks, i: Item, r: Review, extra: Record<string, unknown> = {}, actor: string | null = null) =>
  tasks.updateItem(i.id, {...extra, fields: {...tasks.item(i.id).fields, ...(extra.fields as object), review: r}}, actor, {system: true});
const sessionOf = (s: unknown) => typeof s === 'string' && s.trim() ? s.trim().slice(0, 500) : undefined;
/** A new attempt: remembers where the item stood so a discard can put it back. */
const begin = (tasks: Tasks, i: Item, prev: Review | null) => ({attempt: (prev?.attempt ?? 0) + 1, started: now(),
  since: (tasks.db.prepare('select coalesce(max(id), 0) as n from activity').get() as {n: number}).n, prior: {status: i.status, assignees: i.assignees}});
const told = (tasks: Tasks, event: string, i: Item, actor: string | null, details: Record<string, unknown> = {}) =>
  tasks.event(event, {projectId: i.projectId, item: i, actor, details: {review: review(i), ...details}});

export function log(tasks: Tasks, itemId: string, actor: string | null, kind: LogEntry['kind'], text: string, url: string | null = null, opts: {session?: string | null; artifact?: ArtifactInput} = {}) {
  tasks.item(itemId);
  if (!text.trim() && !url) throw new Invalid('Log entries need text or a link');
  if (url && !/^(https?:\/\/|\/api\/files\/)/.test(url)) throw new Invalid('Links must start with http(s):// or /api/files/');
  const session = sessionOf(opts.session) ?? null;
  const e: LogEntry = {id: id(), itemId, actor, at: now(), kind, text: text.slice(0, 20000), url, session};
  tasks.db.prepare('insert into work_log (id, item_id, actor, at, kind, text, url, session) values (?,?,?,?,?,?,?,?)').run(e.id, e.itemId, e.actor, e.at, e.kind, e.text, e.url, e.session);
  if (opts.artifact) addArtifact(tasks, itemId, actor, opts.artifact);
  // The review keeps the latest session, so the agent (or another chat) knows where to pick the work up.
  const cur = tasks.item(itemId), r = review(cur);
  if (session && r && r.agent === actor && r.session !== session && OPEN.includes(r.state)) setReview(tasks, cur, {...r, session});
  tasks.emit({kind: 'comment', itemId});
  // Only once the agent is cleared to work: its claim accepted or sent back, or it was simply assigned.
  if (actor && kind !== 'review' && kind !== 'result' && personKind(tasks, actor) === 'ai' && tasks.runningTimer(actor)?.itemId !== itemId) {
    const i = tasks.item(itemId), st = review(i)?.state;
    if (st === 'accepted' || st === 'changes' || st === 'redo' || (!st && i.assignees.includes(actor))) tasks.startTimer(itemId, actor);
  }
  return e;
}
export function listLog(tasks: Tasks, itemId: string): LogEntry[] {
  return tasks.db.prepare('select * from work_log where item_id = ? order by at').all(itemId).map(r => ({
    id: r.id as string, itemId: r.item_id as string, actor: (r.actor as string) ?? null, at: r.at as string, kind: r.kind as LogEntry['kind'], text: r.text as string, url: (r.url as string) ?? null, session: (r.session as string) ?? null}));
}

// ---- Artifacts: what the agent made, so it can be undone ----
const toArtifact = (r: Record<string, unknown>): Artifact => ({id: r.id as string, itemId: r.item_id as string, agent: (r.agent as string) ?? null, attempt: r.attempt as number, kind: r.kind as Artifact['kind'],
  ref: r.ref as string, url: (r.url as string) ?? null, undo: (r.undo as string) ?? null, cleanup: (r.cleanup as Artifact['cleanup']) ?? null, note: (r.note as string) ?? null,
  created: r.created as string, confirmedAt: (r.confirmed_at as string) ?? null});
export function listArtifacts(tasks: Tasks, itemId: string): Artifact[] {
  return tasks.db.prepare('select * from work_artifacts where item_id = ? order by created, rowid').all(itemId).map(toArtifact);
}
export function addArtifact(tasks: Tasks, itemId: string, agent: string | null, a: ArtifactInput): Artifact {
  const i = tasks.item(itemId);
  if (!a || !(ARTIFACT_KINDS as readonly string[]).includes(a.kind)) throw new Invalid(`Artifact kind must be one of: ${ARTIFACT_KINDS.join(', ')}`);
  if (typeof a.ref !== 'string' || !a.ref.trim()) throw new Invalid('An artifact needs a ref: a name, id, path or link that identifies it');
  if (a.url != null && !/^(https?:\/\/|\/api\/files\/)/.test(String(a.url))) throw new Invalid('Artifact links must start with http(s):// or /api/files/');
  const same = tasks.db.prepare('select * from work_artifacts where item_id = ? and attempt = ? and kind = ? and ref = ?').get(itemId, review(i)?.attempt ?? 1, a.kind, a.ref.trim().slice(0, 500));
  if (same) return toArtifact(same);
  const aid = id();
  tasks.db.prepare('insert into work_artifacts (id, item_id, agent, attempt, kind, ref, url, undo, created) values (?,?,?,?,?,?,?,?,?)')
    .run(aid, itemId, agent, review(i)?.attempt ?? 1, a.kind, a.ref.trim().slice(0, 500), a.url ? String(a.url).slice(0, 2000) : null, a.undo ? String(a.undo).slice(0, 2000) : null, now());
  tasks.emit({kind: 'comment', itemId});
  return listArtifacts(tasks, itemId).find(x => x.id === aid)!;
}
/** The agent (or a person, for it) says an artifact outside Cadence was undone. */
export function confirmCleanup(tasks: Tasks, itemId: string, actor: string | null, artifactId: string, note = '') {
  const a = listArtifacts(tasks, itemId).find(x => x.id === artifactId);
  if (!a) throw new NotFound('Artifact not found on this item');
  if (personKind(tasks, actor) === 'ai' && a.agent !== actor) throw new Invalid('This artifact belongs to another agent');
  if (a.cleanup === 'confirmed' || a.cleanup === 'removed') return a;
  if (a.cleanup !== 'pending') throw new Invalid('Nothing to clean up: this artifact was not part of a redo or a discard');
  tasks.db.prepare("update work_artifacts set cleanup = 'confirmed', confirmed_at = ?, note = ? where id = ?").run(now(), note.slice(0, 2000) || null, artifactId);
  log(tasks, itemId, actor, 'cleanup', `Cleaned up ${a.kind} ${a.ref}${note ? ': ' + note : ''}`, a.url);
  return listArtifacts(tasks, itemId).find(x => x.id === artifactId)!;
}
/** Subitems the agent created under the task during this attempt count as artifacts. */
function trackCreatedItems(tasks: Tasks, i: Item, r: Review) {
  if (!r.agent || !r.started) return [];
  const made: Item[] = [];
  const walk = (parent: string) => { for (const c of tasks.listItems({parentId: parent})) { if (c.createdBy === r.agent && c.created >= r.started!) made.push(c); else walk(c.id); } };
  walk(i.id);
  for (const c of made) addArtifact(tasks, i.id, r.agent, {kind: 'item', ref: c.id, undo: `Delete ${tasks.project(c.projectId).key}-${c.number} "${c.title.slice(0, 80)}"`});
  return made;
}

const statusOf = (tasks: Tasks, i: Item, want: 'doing' | 'review' | 'done') => {
  const p = tasks.project(i.projectId);
  if (want === 'review') return p.statuses.find(s => /review|resolved|qa/i.test(s.name) && s.category !== 'done')?.id ?? p.statuses.find(s => s.category === 'doing')?.id ?? i.status;
  return p.statuses.find(s => s.category === want)?.id ?? i.status;
};

/** An AI asks to take a task. A human accepts or declines. session: where the agent works (a chat or run id, or its URL). */
export function claim(tasks: Tasks, itemId: string, agent: string, note = '', session?: string | null) {
  const i = tasks.item(itemId);
  if (personKind(tasks, agent) !== 'ai') throw new Invalid('Only AI workers claim tasks; people just assign themselves');
  if ((i.fields.worker ?? 'either') === 'human') throw new Invalid('This task is marked for a human');
  const r = review(i);
  if (r && OPEN.includes(r.state) && r.agent !== agent) throw new Invalid('Another agent already has this task');
  const s = sessionOf(session);
  const base = r && OPEN.includes(r.state) ? {attempt: r.attempt, started: r.started, since: r.since, prior: r.prior, session: r.session} : begin(tasks, i, r);
  log(tasks, itemId, agent, 'note', `Asked to take this task${note ? ': ' + note : ''}`, null, {session: s});
  for (const p of humansToTell(tasks, i)) tasks.notifyPublic(p, agent, itemId, 'ai', `asked to take "${i.title}". Accept or decline it on the AI work page.`);
  const out = setReview(tasks, i, {state: 'claimed', by: agent, agent, at: now(), note, ...base, ...(s ? {session: s} : {})});
  told(tasks, 'ai.claimed', out, agent);
  return out;
}
export function decide(tasks: Tasks, itemId: string, reviewer: string | null, accept: boolean, note = '') {
  if (personKind(tasks, reviewer) === 'ai') throw new Invalid('Only a person can accept or decline an AI claim');
  const i = tasks.item(itemId), r = review(i);
  if (!r || r.state !== 'claimed') throw new Invalid('There is no open claim on this task');
  if (!mayReview(tasks, reviewer, i, r.agent)) throw notOwner(tasks, r.agent);
  log(tasks, itemId, reviewer, 'review', accept ? `Accepted the claim${note ? ': ' + note : ''}` : `Declined the claim${note ? ': ' + note : ''}`);
  const out = accept
    ? setReview(tasks, i, {...r, state: 'accepted', by: reviewer, at: now(), note}, {assignees: [...new Set([...i.assignees, r.agent!])], status: statusOf(tasks, i, 'doing')}, reviewer)
    : setReview(tasks, i, {...r, state: 'declined', by: reviewer, at: now(), note}, {}, reviewer);
  told(tasks, accept ? 'ai.accepted' : 'ai.declined', out, reviewer);
  return out;
}
/** The agent hands in its work with a report (markdown with links and screenshots), and what it made (artifacts). */
export function submit(tasks: Tasks, itemId: string, agent: string, report: string, missed = '', opts: {session?: string | null; artifacts?: ArtifactInput[]} = {}) {
  const i = tasks.item(itemId), r = review(i);
  if (r && r.agent && r.agent !== agent) throw new Invalid('This task belongs to another agent');
  if (r && !['accepted', 'changes', 'redo'].includes(r.state) && !(r.state === 'claimed' && i.assignees.includes(agent))) throw new Invalid('Wait until a person accepts your claim');
  if (!r && !i.assignees.includes(agent)) throw new Invalid('Claim the task first, or be assigned to it');
  if (opts.artifacts !== undefined && !Array.isArray(opts.artifacts)) throw new Invalid('artifacts must be a list');
  const s = sessionOf(opts.session);
  // Assigned without a claim: the attempt starts with the agent's first step here.
  let base = r ? {attempt: r.attempt ?? 1, started: r.started, since: r.since, prior: r.prior} : begin(tasks, i, null);
  if (!r) {
    const first = tasks.db.prepare('select min(id) as n from activity where item_id = ? and actor = ?').get(itemId, agent) as {n: number | null};
    const at = tasks.db.prepare('select min(at) as at from work_log where item_id = ? and actor = ?').get(itemId, agent) as {at: string | null};
    base = {...base, ...(first.n ? {since: first.n - 1} : {}), ...(at.at ? {started: at.at} : {})};
  }
  log(tasks, itemId, agent, 'result', report, null, {session: s});
  if (tasks.runningTimer(agent)?.itemId === itemId) tasks.stopTimer(agent, `Submitted: ${report.trim().slice(0, 300)}`);
  for (const p of humansToTell(tasks, i)) tasks.notifyPublic(p, agent, itemId, 'ai', `submitted "${i.title}" for your review`);
  if (missed.trim()) log(tasks, itemId, agent, 'missed', missed);
  const next: Review = {state: 'submitted', by: agent, agent, at: now(), ...base, ...(s ?? review(tasks.item(itemId))?.session ? {session: s ?? review(tasks.item(itemId))!.session} : {})};
  const out = setReview(tasks, i, next, {status: statusOf(tasks, i, 'review')}, agent);
  for (const a of opts.artifacts ?? []) addArtifact(tasks, itemId, agent, a);
  trackCreatedItems(tasks, out, next);
  told(tasks, 'ai.submitted', out, agent, {report: report.slice(0, 20000), missed: missed || null, artifacts: listArtifacts(tasks, itemId).filter(a => a.attempt === next.attempt)});
  return out;
}

/** Undo what the agent changed on the item itself during the attempt, where nobody changed the same field after it. */
function revertPatch(tasks: Tasks, i: Item, r: Review): ItemPatch {
  if (!r.agent || r.since === undefined) return {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const KEYS = ['title', 'body', 'priority', 'start', 'due', 'estimate', 'tags', 'type', 'sprint', 'deps'] as const;
  const SKIP = ['review', 'ext', 'links', 'follow', 'archived', 'snooze'];
  const patch: Record<string, unknown> = {}, fields: Record<string, unknown> = {}, blocked = new Set<string>(), seen = new Set<string>();
  // Newest first: the newest change must still be in place; the oldest one tells what to put back.
  for (const a of tasks.listActivity({itemId: i.id, limit: 500}).filter(a => a.kind === 'update' && a.actor === r.agent && a.id > r.since!)) {
    const before = a.before as Record<string, unknown>, after = a.after as Record<string, unknown>;
    for (const k of KEYS) if (k in before) {
      if (!seen.has(k)) { seen.add(k); if (!same((i as Record<string, unknown>)[k], after[k])) blocked.add(k); }
      if (!blocked.has(k)) patch[k] = before[k];
    }
    if ('fields' in before) {
      const b = (before.fields ?? {}) as Record<string, unknown>, af = (after.fields ?? {}) as Record<string, unknown>;
      for (const f of new Set([...Object.keys(b), ...Object.keys(af)])) {
        if (SKIP.includes(f) || same(b[f], af[f])) continue;
        const k = 'f:' + f;
        if (!seen.has(k)) { seen.add(k); if (!same(i.fields[f], af[f])) blocked.add(k); }
        if (!blocked.has(k)) fields[f] = b[f];
      }
    }
  }
  if (Object.keys(fields).length) patch.fields = Object.fromEntries(Object.entries({...i.fields, ...fields}).filter(([, v]) => v !== undefined));
  return patch as ItemPatch;
}

/**
 * A person decides on submitted work: approve (done), changes (sent back with a comment, the agent continues),
 * redo (start over from scratch, comment required) or discard (reject the work and close the attempt; the item goes
 * back to its status from before and the agent is unassigned unless keep is set). true and false mean approve and changes.
 * Redo and discard hide the files the agent uploaded in the attempt and mark what it made outside Cadence for cleanup;
 * discard also undoes the agent's changes to the item and deletes the subitems it created.
 */
export function reviewWork(tasks: Tasks, itemId: string, reviewer: string | null, decision: boolean | Decision, comment = '', opts: {keep?: boolean} = {}) {
  if (personKind(tasks, reviewer) === 'ai') throw new Invalid('Only a person can review AI work');
  const d: Decision = decision === true ? 'approve' : decision === false ? 'changes' : decision;
  if (!DECISIONS.includes(d)) throw new Invalid(`Decision must be one of: ${DECISIONS.join(', ')}`);
  const i = tasks.item(itemId), r = review(i);
  // Work in progress can be discarded too; the other decisions need submitted work.
  if (!r || (d === 'discard' ? !['accepted', 'submitted', 'changes', 'redo'].includes(r.state) : r.state !== 'submitted')) throw new Invalid('Nothing is waiting for review on this task');
  if (!mayReview(tasks, reviewer, i, r.agent)) throw notOwner(tasks, r.agent);
  if (d === 'redo' && !comment.trim()) throw new Invalid('A redo needs a comment: say what to do differently this time');
  const words = {approve: ['Approved', 'Approved. ', 'Review: approved'], changes: ['Sent back', 'Changes requested. ', 'Review: sent back'],
    redo: ['Redo requested', 'Redo requested: start over. ', 'Review: redo'], discard: ['Discarded', 'Work discarded. ', 'Review: discarded']}[d];
  log(tasks, itemId, reviewer, 'review', d === 'changes' ? `Sent back: ${comment || 'needs changes'}` : `${words[0]}${comment ? ': ' + comment : ''}`);
  if (reviewer && tasks.runningTimer(reviewer)?.itemId === itemId) tasks.stopTimer(reviewer, words[2]);
  if (comment.trim() && reviewer) tasks.addComment(itemId, reviewer, words[1] + comment);
  const next: Review = {...r, state: ({approve: 'approved', changes: 'changes', redo: 'redo', discard: 'discarded'} as const)[d], decision: d, by: reviewer, at: now(), note: comment};
  let out: Item | undefined;
  if (d === 'approve' || d === 'changes') out = setReview(tasks, i, next, {status: statusOf(tasks, i, d === 'approve' ? 'done' : 'doing')}, reviewer);
  else {
    const attempt = r.attempt ?? 1;
    if (d === 'discard') trackCreatedItems(tasks, i, r);
    // Files the agent uploaded during the attempt are hidden (the rows stay, so the work log still names them).
    if (r.agent) tasks.db.prepare('update files set removed = ? where item_id = ? and by = ? and removed is null and created >= ?').run(now(), itemId, r.agent, r.started ?? '');
    for (const a of listArtifacts(tasks, itemId).filter(a => a.attempt === attempt && !a.cleanup)) {
      if (a.kind === 'item' && d === 'redo') continue; // subitems stay for the next try
      let held = !!a.url?.startsWith('/api/files/');
      if (a.kind === 'item') {
        // Only subitems the agent itself created in this attempt are deleted (history can bring them back).
        try { const x = tasks.findItem(a.ref); if (x.createdBy === r.agent && x.created >= (r.started ?? '')) { tasks.deleteItem(x.id, reviewer); held = true; } } catch { held = true; }
      }
      tasks.db.prepare('update work_artifacts set cleanup = ? where id = ?').run(held ? 'removed' : 'pending', a.id);
    }
    if (r.agent && tasks.runningTimer(r.agent)?.itemId === itemId) tasks.stopTimer(r.agent, words[2]);
    if (r.agent) tasks.notifyPublic(r.agent, reviewer, itemId, 'ai', d === 'redo' ? `asked you to start over on "${i.title}". Read get_feedback first: it lists what to clean up.` : `discarded your work on "${i.title}". Read get_feedback: it lists what to clean up.`);
    if (d === 'redo') out = setReview(tasks, i, {...next, attempt: attempt + 1, started: now()}, {status: statusOf(tasks, i, 'doing')}, reviewer);
    else {
      const p = tasks.project(i.projectId);
      const status = r.prior && p.statuses.some(s => s.id === r.prior!.status) ? r.prior.status : p.statuses.find(s => s.category === 'todo')?.id ?? p.statuses[0].id;
      const assignees = opts.keep || !r.agent ? i.assignees : i.assignees.filter(a => a !== r.agent);
      // Put back as much as the space's rules allow: everything, else status and people, else only the review state.
      const tries = [{...revertPatch(tasks, i, r), status, assignees}, {status, assignees}, {}];
      for (let n = 0; ; n++) {
        try { out = setReview(tasks, i, next, tries[n], reviewer); break; }
        catch (e) { if (!(e instanceof Invalid) || n === tries.length - 1) throw e; }
      }
    }
  }
  if (!out) throw new Invalid('Could not save the review');
  told(tasks, ({approve: 'ai.approved', changes: 'ai.changes_requested', redo: 'ai.redo_requested', discard: 'ai.discarded'} as const)[d], out, reviewer,
    {decision: d, comment, cleanup: listArtifacts(tasks, itemId).filter(a => a.cleanup === 'pending')});
  return out;
}

/** What an agent needs to continue, redo or clean up, also from a new chat: decision, comment, session, and a compact record of the last attempt. */
export function feedback(tasks: Tasks, itemId: string) {
  const i = tasks.item(itemId), r = review(i), logs = listLog(tasks, itemId), arts = listArtifacts(tasks, itemId);
  const last = (kind: LogEntry['kind']) => logs.findLast(e => e.kind === kind) ?? null;
  return {
    review: r, decision: r?.decision ?? null, comment: r?.decision ? r.note ?? '' : '',
    session: r?.session ?? logs.findLast(e => e.session)?.session ?? null,
    context: {
      report: last('result')?.text ?? null, missed: last('missed')?.text ?? null,
      steps: logs.filter(e => ['step', 'note', 'link', 'file', 'missed', 'cleanup'].includes(e.kind)).slice(-60).map(e => ({at: e.at, kind: e.kind, text: e.text.slice(0, 500), url: e.url})),
      artifacts: arts.map(a => ({id: a.id, attempt: a.attempt, kind: a.kind, ref: a.ref, url: a.url, cleanup: a.cleanup})),
    },
    cleanup: arts.filter(a => a.cleanup === 'pending').map(a => ({id: a.id, kind: a.kind, ref: a.ref, url: a.url, undo: a.undo})),
    log: logs, comments: tasks.listComments(itemId),
  };
}
/** Cleanups an agent still owes, across its tasks. */
export function pendingCleanup(tasks: Tasks, agent: string) {
  return tasks.db.prepare("select * from work_artifacts where agent = ? and cleanup = 'pending' order by created").all(agent).map(toArtifact);
}

/** Open work an AI could pick up, or is already doing. */
export function aiQueue(tasks: Tasks, agent: string | null, projectId?: string) {
  return tasks.listItems({projectId, open: true}).filter(i => {
    const w = (i.fields.worker as string) ?? 'either', r = review(i), closed = !!r && (r.state === 'declined' || r.state === 'discarded');
    if (w === 'human') return false;
    if (agent && r?.agent && r.agent !== agent && !closed) return false;
    return w === 'ai' || (agent && i.assignees.includes(agent)) || (!!r && !closed);
  }).map(i => ({item: i, review: review(i)}));
}

// Files (screenshots, PDFs) attached to items. Served back only to people who can see the item.
const OK = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/(plain|csv|markdown)|application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.[\w.]+|vnd\.oasis\.opendocument\.[\w.]+))$/;
const BY_EXT: Record<string, string> = {md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
export function saveFile(tasks: Tasks, itemId: string, by: string | null, name: string, mime: string, base64: string) {
  tasks.item(itemId);
  // Browsers send no type for some files (like .md); go by the extension then.
  if (!mime || mime === 'application/octet-stream') mime = BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? mime;
  if (!OK.test(mime)) throw new Invalid('Allowed files: images (PNG, JPG, GIF, WebP), PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV, Markdown');
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length || buf.length > 10_000_000) throw new Invalid('Files must be under 10 MB');
  // Images and PDFs must really be what they say, so a renamed file cannot pose as a picture.
  const head = buf.subarray(0, 12).toString('latin1');
  const looks = mime === 'application/pdf' ? head.startsWith('%PDF') : mime === 'image/png' ? head.startsWith('PNG') : /jpe?g/.test(mime) ? buf[0] === 0xff && buf[1] === 0xd8
    : mime === 'image/gif' ? head.startsWith('GIF8') : mime === 'image/webp' ? head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP' : true;
  if (!looks) throw new Invalid(`${name} does not look like a real ${mime.split('/')[1].toUpperCase()} file`);
  const fid = id();
  mkdirSync(FILES(tasks), {recursive: true});
  writeFileSync(join(FILES(tasks), fid), buf);
  const safe = name.replace(/[^\p{L}\p{N}._\- ()]+/gu, '_').slice(0, 120) || 'file';
  tasks.db.prepare('insert into files (id, item_id, name, mime, size, created, by) values (?,?,?,?,?,?,?)').run(fid, itemId, safe, mime, buf.length, now(), by);
  // What an agent uploads is one of its artifacts: a redo or a discard hides it.
  log(tasks, itemId, by, 'file', safe, `/api/files/${fid}`, personKind(tasks, by) === 'ai' ? {artifact: {kind: 'file', ref: `${safe} (${fid})`, url: `/api/files/${fid}`}} : {});
  return {id: fid, url: `/api/files/${fid}`, name: safe, mime, size: buf.length};
}
export function readFile(tasks: Tasks, fid: string) {
  if (!/^[0-9a-f]{12}$/.test(fid)) return null;
  const r = tasks.db.prepare('select * from files where id = ? and removed is null').get(fid) as {item_id: string; name: string; mime: string} | undefined;
  const path = join(FILES(tasks), fid);
  if (!r || !existsSync(path)) return null;
  return {itemId: r.item_id, name: r.name, mime: r.mime, data: readFileSync(path)};
}
/** Every attachment in a project, newest first. */
export function projectFiles(tasks: Tasks, projectId: string) {
  return tasks.db.prepare('select f.id, f.item_id, f.name, f.mime, f.size, f.created, f.by from files f join items i on i.id = f.item_id where i.project_id = ? and f.removed is null order by f.created desc').all(projectId)
    .map(r => ({id: r.id as string, itemId: r.item_id as string, name: r.name as string, mime: r.mime as string, size: r.size as number, created: r.created as string, by: (r.by as string) ?? null, url: `/api/files/${r.id}`}));
}
export function listFiles(tasks: Tasks, itemId: string) {
  return tasks.db.prepare('select id, name, mime, size, created, by from files where item_id = ? and removed is null order by created').all(itemId)
    .map(r => ({id: r.id as string, name: r.name as string, mime: r.mime as string, size: r.size as number, created: r.created as string, by: (r.by as string) ?? null, url: `/api/files/${r.id}`}));
}
