// Human and AI workers on the same board.
//
// People are "human" or "ai". Items say who should do them in fields.worker: human, ai, or either.
// AI work goes through a review loop kept in fields.review:
//   claimed (AI asks to take it) -> accepted (a human agrees, AI is assigned) -> submitted (AI reports)
//   -> approved (done) or changes (sent back with a comment, AI continues) ; declined ends a claim.
// Every step an agent takes can be written to the work log (with links and screenshots) so there is a
// complete record of what was done and what was missed.
import {Invalid} from './errors.ts';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomBytes} from 'node:crypto';
import type {Item} from '../src/types.ts';
import type {Tasks} from './service.ts';

export type ReviewState = 'claimed' | 'accepted' | 'submitted' | 'changes' | 'approved' | 'declined';
export type Review = {state: ReviewState; by: string | null; at: string; note?: string; agent?: string};
export type LogEntry = {id: string; itemId: string; actor: string | null; at: string; kind: 'step' | 'note' | 'link' | 'file' | 'result' | 'missed' | 'review'; text: string; url: string | null};

const FILES = (tasks: Tasks) => join(tasks.dataDir, 'files');
const now = () => new Date().toISOString();
const id = () => randomBytes(6).toString('hex');

export function migrateAiWork(tasks: Tasks) {
  const cols = tasks.db.prepare('pragma table_info(people)').all().map(r => r.name);
  if (!cols.includes('kind')) tasks.db.exec("alter table people add column kind text not null default 'human'");
  tasks.db.exec(`
    create table if not exists work_log (id text primary key, item_id text not null, actor text, at text not null, kind text not null, text text not null, url text);
    create index if not exists work_log_item on work_log(item_id, at);
    create table if not exists files (id text primary key, item_id text not null, name text not null, mime text not null, size integer not null, created text not null, by text);
  `);
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
  tasks.updateItem(i.id, {...extra, fields: {...tasks.item(i.id).fields, review: r}}, actor, {system: true});

export function log(tasks: Tasks, itemId: string, actor: string | null, kind: LogEntry['kind'], text: string, url: string | null = null) {
  tasks.item(itemId);
  if (!text.trim() && !url) throw new Invalid('Log entries need text or a link');
  if (url && !/^(https?:\/\/|\/api\/files\/)/.test(url)) throw new Invalid('Links must start with http(s):// or /api/files/');
  const e: LogEntry = {id: id(), itemId, actor, at: now(), kind, text: text.slice(0, 20000), url};
  tasks.db.prepare('insert into work_log (id, item_id, actor, at, kind, text, url) values (?,?,?,?,?,?,?)').run(e.id, e.itemId, e.actor, e.at, e.kind, e.text, e.url);
  tasks.emit({kind: 'comment', itemId});
  // Only once the agent is cleared to work: its claim accepted or sent back, or it was simply assigned.
  if (actor && kind !== 'review' && kind !== 'result' && personKind(tasks, actor) === 'ai' && tasks.runningTimer(actor)?.itemId !== itemId) {
    const i = tasks.item(itemId), st = review(i)?.state;
    if (st === 'accepted' || st === 'changes' || (!st && i.assignees.includes(actor))) tasks.startTimer(itemId, actor);
  }
  return e;
}
export function listLog(tasks: Tasks, itemId: string): LogEntry[] {
  return tasks.db.prepare('select * from work_log where item_id = ? order by at').all(itemId).map(r => ({
    id: r.id as string, itemId: r.item_id as string, actor: (r.actor as string) ?? null, at: r.at as string, kind: r.kind as LogEntry['kind'], text: r.text as string, url: (r.url as string) ?? null}));
}

const statusOf = (tasks: Tasks, i: Item, want: 'doing' | 'review' | 'done') => {
  const p = tasks.project(i.projectId);
  if (want === 'review') return p.statuses.find(s => /review|resolved|qa/i.test(s.name) && s.category !== 'done')?.id ?? p.statuses.find(s => s.category === 'doing')?.id ?? i.status;
  return p.statuses.find(s => s.category === want)?.id ?? i.status;
};

/** An AI asks to take a task. A human accepts or declines. */
export function claim(tasks: Tasks, itemId: string, agent: string, note = '') {
  const i = tasks.item(itemId);
  if (personKind(tasks, agent) !== 'ai') throw new Invalid('Only AI workers claim tasks; people just assign themselves');
  if ((i.fields.worker ?? 'either') === 'human') throw new Invalid('This task is marked for a human');
  const r = review(i);
  if (r && ['claimed', 'accepted', 'submitted', 'changes'].includes(r.state) && r.agent !== agent) throw new Invalid('Another agent already has this task');
  log(tasks, itemId, agent, 'note', `Asked to take this task${note ? ': ' + note : ''}`);
  for (const p of humansToTell(tasks, i)) tasks.notifyPublic(p, agent, itemId, 'ai', `asked to take "${i.title}". Accept or decline it on the AI work page.`);
  return setReview(tasks, i, {state: 'claimed', by: agent, agent, at: now(), note});
}
export function decide(tasks: Tasks, itemId: string, reviewer: string | null, accept: boolean, note = '') {
  if (personKind(tasks, reviewer) === 'ai') throw new Invalid('Only a person can accept or decline an AI claim');
  const i = tasks.item(itemId), r = review(i);
  if (!r || r.state !== 'claimed') throw new Invalid('There is no open claim on this task');
  if (!mayReview(tasks, reviewer, i, r.agent)) throw notOwner(tasks, r.agent);
  log(tasks, itemId, reviewer, 'review', accept ? `Accepted the claim${note ? ': ' + note : ''}` : `Declined the claim${note ? ': ' + note : ''}`);
  if (!accept) return setReview(tasks, i, {...r, state: 'declined', by: reviewer, at: now(), note}, {}, reviewer);
  return setReview(tasks, i, {...r, state: 'accepted', by: reviewer, at: now(), note}, {assignees: [...new Set([...i.assignees, r.agent!])], status: statusOf(tasks, i, 'doing')}, reviewer);
}
/** The agent hands in its work with a report (markdown with links and screenshots). */
export function submit(tasks: Tasks, itemId: string, agent: string, report: string, missed = '') {
  const i = tasks.item(itemId), r = review(i);
  if (r && r.agent && r.agent !== agent) throw new Invalid('This task belongs to another agent');
  if (r && !['accepted', 'changes'].includes(r.state) && !(r.state === 'claimed' && i.assignees.includes(agent))) throw new Invalid('Wait until a person accepts your claim');
  if (!r && !i.assignees.includes(agent)) throw new Invalid('Claim the task first, or be assigned to it');
  log(tasks, itemId, agent, 'result', report);
  if (tasks.runningTimer(agent)?.itemId === itemId) tasks.stopTimer(agent, `Submitted: ${report.trim().slice(0, 300)}`);
  for (const p of humansToTell(tasks, i)) tasks.notifyPublic(p, agent, itemId, 'ai', `submitted "${i.title}" for your review`);
  if (missed.trim()) log(tasks, itemId, agent, 'missed', missed);
  return setReview(tasks, i, {state: 'submitted', by: agent, agent, at: now()}, {status: statusOf(tasks, i, 'review')}, agent);
}
/** A person approves (done) or sends back with a comment (agent continues). */
export function reviewWork(tasks: Tasks, itemId: string, reviewer: string | null, approve: boolean, comment = '') {
  if (personKind(tasks, reviewer) === 'ai') throw new Invalid('Only a person can review AI work');
  const i = tasks.item(itemId), r = review(i);
  if (!r || r.state !== 'submitted') throw new Invalid('Nothing is waiting for review on this task');
  if (!mayReview(tasks, reviewer, i, r.agent)) throw notOwner(tasks, r.agent);
  log(tasks, itemId, reviewer, 'review', approve ? `Approved${comment ? ': ' + comment : ''}` : `Sent back: ${comment || 'needs changes'}`);
  if (reviewer && tasks.runningTimer(reviewer)?.itemId === itemId) tasks.stopTimer(reviewer, approve ? 'Review: approved' : 'Review: sent back');
  if (comment.trim() && reviewer) tasks.addComment(itemId, reviewer, (approve ? 'Approved. ' : 'Changes requested. ') + comment);
  return setReview(tasks, i, {...r, state: approve ? 'approved' : 'changes', by: reviewer, at: now(), note: comment},
    {status: approve ? statusOf(tasks, i, 'done') : statusOf(tasks, i, 'doing')}, reviewer);
}
/** Open work an AI could pick up, or is already doing. */
export function aiQueue(tasks: Tasks, agent: string | null, projectId?: string) {
  return tasks.listItems({projectId, open: true}).filter(i => {
    const w = (i.fields.worker as string) ?? 'either', r = review(i);
    if (w === 'human') return false;
    if (agent && r?.agent && r.agent !== agent && r.state !== 'declined') return false;
    return w === 'ai' || (agent && i.assignees.includes(agent)) || (!!r && r.state !== 'declined');
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
  log(tasks, itemId, by, 'file', safe, `/api/files/${fid}`);
  return {id: fid, url: `/api/files/${fid}`, name: safe, mime, size: buf.length};
}
export function readFile(tasks: Tasks, fid: string) {
  if (!/^[0-9a-f]{12}$/.test(fid)) return null;
  const r = tasks.db.prepare('select * from files where id = ?').get(fid) as {item_id: string; name: string; mime: string} | undefined;
  const path = join(FILES(tasks), fid);
  if (!r || !existsSync(path)) return null;
  return {itemId: r.item_id, name: r.name, mime: r.mime, data: readFileSync(path)};
}
/** Every attachment in a project, newest first. */
export function projectFiles(tasks: Tasks, projectId: string) {
  return tasks.db.prepare('select f.id, f.item_id, f.name, f.mime, f.size, f.created, f.by from files f join items i on i.id = f.item_id where i.project_id = ? order by f.created desc').all(projectId)
    .map(r => ({id: r.id as string, itemId: r.item_id as string, name: r.name as string, mime: r.mime as string, size: r.size as number, created: r.created as string, by: (r.by as string) ?? null, url: `/api/files/${r.id}`}));
}
export function listFiles(tasks: Tasks, itemId: string) {
  return tasks.db.prepare('select id, name, mime, size, created, by from files where item_id = ? order by created').all(itemId)
    .map(r => ({id: r.id as string, name: r.name as string, mime: r.mime as string, size: r.size as number, created: r.created as string, by: (r.by as string) ?? null, url: `/api/files/${r.id}`}));
}
