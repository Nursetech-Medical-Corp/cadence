// Approvals and electronic signatures.
//
// Anyone who can edit an item can request approval from one or more people, with a meaning
// (reviewed, approved, verified, authored). Each approver signs: approve, request changes, or reject,
// with a comment. Signing re-checks the signer's password when they have one, and stores who signed,
// the meaning, the time, and a SHA-256 fingerprint of the item as it was at signing, so a later change
// to the item is visible against the signature. AI agents can request approvals but never sign.
import {Invalid} from './errors.ts';
import {createHash, randomBytes} from 'node:crypto';
import type {Item} from '../src/types.ts';
import type {Tasks} from './service.ts';
import {checkPassword, getWorkspace} from './auth.ts';

export type Meaning = 'reviewed' | 'approved' | 'verified' | 'authored';
/** How the signer's identity was confirmed: password now, password earlier this session, or none asked. */
export type Auth = 'password' | 'session' | 'none' | '';
export type Decision = 'pending' | 'approved' | 'changes' | 'rejected';
export type Approval = {
  id: string; itemId: string; requestedBy: string | null; approver: string; meaning: Meaning; note: string;
  decision: Decision; comment: string; signedAt: string | null; signerName: string | null; fingerprint: string | null; passwordChecked: boolean; auth: Auth; created: string;
};

export function migrateApprovals(tasks: Tasks) {
  tasks.db.exec(`create table if not exists approvals (
    id text primary key, item_id text not null, requested_by text, approver text not null, meaning text not null, note text not null default '',
    decision text not null default 'pending', comment text not null default '', signed_at text, signer_name text, fingerprint text,
    password_checked integer not null default 0, created text not null);
    create index if not exists approvals_item on approvals(item_id);
    create index if not exists approvals_approver on approvals(approver, decision);
    create table if not exists sign_sessions (person text primary key, until text not null);`);
  const cols = (tasks.db.prepare('pragma table_info(approvals)').all() as {name: string}[]).map(c => c.name);
  if (!cols.includes('auth')) tasks.db.exec("alter table approvals add column auth text not null default ''");
}

const row = (r: Record<string, unknown>): Approval => ({
  id: r.id as string, itemId: r.item_id as string, requestedBy: (r.requested_by as string) ?? null, approver: r.approver as string,
  meaning: r.meaning as Meaning, note: r.note as string, decision: r.decision as Decision, comment: r.comment as string,
  signedAt: (r.signed_at as string) ?? null, signerName: (r.signer_name as string) ?? null, fingerprint: (r.fingerprint as string) ?? null,
  passwordChecked: !!r.password_checked, auth: ((r.auth as Auth) || (r.password_checked ? 'password' : 'none')), created: r.created as string,
});

/** What was signed: the item's meaningful content, so any later change shows. */
export function fingerprint(i: Item) {
  const content = JSON.stringify({id: i.id, title: i.title, body: i.body, type: i.type, status: i.status, due: i.due, fields: Object.fromEntries(Object.entries(i.fields).filter(([k]) => !['review', 'links'].includes(k)))});
  return createHash('sha256').update(content).digest('hex');
}

export function listApprovals(tasks: Tasks, q: {itemId?: string; approver?: string; pending?: boolean}) {
  const where: string[] = [], args: string[] = [];
  if (q.itemId) { where.push('item_id = ?'); args.push(q.itemId); }
  if (q.approver) { where.push('approver = ?'); args.push(q.approver); }
  if (q.pending) where.push("decision = 'pending'");
  return tasks.db.prepare(`select * from approvals ${where.length ? 'where ' + where.join(' and ') : ''} order by created`).all(...args).map(row);
}

const kindOf = (tasks: Tasks, pid: string) => (tasks.db.prepare('select kind from people where id = ?').get(pid) as {kind?: string} | undefined)?.kind ?? 'human';

export function requestApproval(tasks: Tasks, itemId: string, by: string | null, approvers: string[], meaning: Meaning, note = '') {
  const item = tasks.item(itemId);
  if (!approvers.length) throw new Invalid('Pick at least one approver');
  const people = new Set(tasks.listPeople().map(p => p.id));
  for (const a of approvers) {
    if (!people.has(a)) throw new Invalid('Unknown approver');
    if (kindOf(tasks, a) === 'ai') throw new Invalid('AI agents cannot be approvers; pick a person');
  }
  if (!['reviewed', 'approved', 'verified', 'authored'].includes(meaning)) throw new Invalid('Unknown meaning');
  const now = new Date().toISOString();
  const made: Approval[] = [];
  for (const a of [...new Set(approvers)]) {
    // One open request per approver per item; re-requesting refreshes it.
    tasks.db.prepare("delete from approvals where item_id = ? and approver = ? and decision = 'pending'").run(itemId, a);
    const id = randomBytes(6).toString('hex');
    tasks.db.prepare('insert into approvals (id, item_id, requested_by, approver, meaning, note, created) values (?,?,?,?,?,?,?)').run(id, itemId, by, a, meaning, note.slice(0, 2000), now);
    tasks.notifyPublic(a, by, itemId, 'approval', `asked you to ${meaning === 'approved' ? 'approve' : meaning === 'reviewed' ? 'review' : meaning === 'verified' ? 'verify' : 'sign as author of'}: ${item.title}`);
    made.push(listApprovals(tasks, {itemId}).find(x => x.id === id)!);
  }
  tasks.logWork(itemId, by, 'review', `Approval requested from ${approvers.map(a => tasks.listPeople().find(p => p.id === a)?.name).join(', ')} (${meaning})${note ? ': ' + note : ''}`);
  tasks.emit({kind: 'comment', itemId});
  tasks.event('approval.requested', {projectId: item.projectId, item, actor: by, details: {approvals: made}});
  // One flow for AI work: an agent asking for approval on its task also hands the work in, so AI work shows it under
  // Ready for review. Signing it here (or deciding it on AI work) settles both.
  if (by && kindOf(tasks, by) === 'ai') {
    const r = tasks.item(itemId).fields.review as {state?: string; agent?: string} | undefined;
    const working = r ? ['accepted', 'changes', 'redo'].includes(r.state ?? '') && r.agent === by : tasks.item(itemId).assignees.includes(by);
    if (working) tasks.submitWork(itemId, by, note.trim() || `Submitted for ${meaning === 'approved' ? 'approval' : meaning === 'reviewed' ? 'review' : meaning === 'verified' ? 'verification' : 'an author signature'}.`);
  }
  return made;
}

export const SESSION_HOURS = 8;
/**
 * Signing is an identity check. The workspace chooses: the password every time, once per session (then signatures
 * for the next 8 hours need none, like the continuous-session rule in 21 CFR 11.200), or never. People with no
 * password (Google sign-in only) are never asked.
 */
function signerAuth(tasks: Tasks, signer: string, hash: string | null, password: string | undefined): Auth {
  const mode = getWorkspace(tasks.db).signPassword;
  if (!hash || mode === 'never') return 'none';
  if (password) {
    if (!checkPassword(password, hash)) throw new Invalid('Password is wrong. Signing needs your password.');
    if (mode === 'session') tasks.db.prepare('insert into sign_sessions (person, until) values (?, ?) on conflict(person) do update set until = excluded.until')
      .run(signer, new Date(Date.now() + SESSION_HOURS * 3600000).toISOString());
    return 'password';
  }
  if (mode === 'session' && signSession(tasks, signer)) return 'session';
  throw new Invalid('Signing needs your password.');
}
/** Until when this person may sign without their password (session mode), or null. */
export function signSession(tasks: Tasks, person: string) {
  const r = tasks.db.prepare('select until from sign_sessions where person = ?').get(person) as {until: string} | undefined;
  return r && r.until > new Date().toISOString() ? r.until : null;
}
/** What signing will ask of this person now: a password or not. */
export function signNeeds(tasks: Tasks, person: string) {
  const mode = getWorkspace(tasks.db).signPassword;
  const has = !!(tasks.db.prepare('select password from people where id = ?').get(person) as {password: string | null} | undefined)?.password;
  return {mode, password: has && mode !== 'never' && !(mode === 'session' && signSession(tasks, person)), until: mode === 'session' ? signSession(tasks, person) : null};
}
/** Sign several at once with one decision; the password (when needed) is checked once. Stops at nothing: failures are listed. */
export function signMany(tasks: Tasks, ids: string[], signer: string, decision: Exclude<Decision, 'pending'>, comment: string, password: string | undefined) {
  const out: {signed: Approval[]; failed: {id: string; error: string}[]} = {signed: [], failed: []};
  let pw = password;
  for (const id of ids.slice(0, 200)) {
    try { out.signed.push(sign(tasks, id, signer, decision, comment, pw)); if (getWorkspace(tasks.db).signPassword === 'session') pw = undefined; }
    catch (e) { if (/password/i.test((e as Error).message) && !out.signed.length) throw e; out.failed.push({id, error: (e as Error).message}); }
  }
  return out;
}

export function sign(tasks: Tasks, approvalId: string, signer: string, decision: Exclude<Decision, 'pending'>, comment: string, password: string | undefined) {
  const r = tasks.db.prepare('select * from approvals where id = ?').get(approvalId);
  if (!r) throw new Invalid('Approval not found');
  const a = row(r);
  if (a.approver !== signer) throw new Invalid('Only the named approver can sign this');
  if (a.decision !== 'pending') throw new Invalid('This approval was already decided');
  if (kindOf(tasks, signer) === 'ai') throw new Invalid('AI agents cannot sign approvals');
  if (decision !== 'approved' && !comment.trim()) throw new Invalid('Say what needs to change, or why it is rejected');
  const stored = (tasks.db.prepare('select password, name from people where id = ?').get(signer) as {password: string | null; name: string});
  const auth = signerAuth(tasks, signer, stored.password, password);
  const item = tasks.item(a.itemId);
  const now = new Date().toISOString();
  tasks.db.prepare('update approvals set decision = ?, comment = ?, signed_at = ?, signer_name = ?, fingerprint = ?, password_checked = ?, auth = ? where id = ?')
    .run(decision, comment.slice(0, 5000), now, stored.name, fingerprint(item), auth === 'password' || auth === 'session' ? 1 : 0, auth, approvalId);
  const verb = decision === 'approved' ? `signed: ${a.meaning}` : decision === 'changes' ? 'requested changes' : 'rejected';
  tasks.logWork(a.itemId, signer, 'review', `${stored.name} ${verb}${comment ? ': ' + comment : ''}`);
  if (comment.trim()) tasks.addComment(a.itemId, signer, `${decision === 'approved' ? 'Approved' : decision === 'changes' ? 'Changes requested' : 'Rejected'} (${a.meaning}). ${comment}`);
  if (a.requestedBy && a.requestedBy !== signer) tasks.notifyPublic(a.requestedBy, signer, a.itemId, 'approval', `${verb} on ${item.title}`);
  tasks.emit({kind: 'comment', itemId: a.itemId});
  const signed = listApprovals(tasks, {itemId: a.itemId}).find(x => x.id === approvalId)!;
  tasks.event('approval.signed', {projectId: item.projectId, item, actor: signer, details: {approval: signed, decision}});
  // Work an agent handed in: the signature is also the review on AI work. Approved approves it; changes or rejected
  // send it back with the comment (never discards it: that undoes the agent's changes, so it stays a choice on AI work).
  const rv = tasks.item(a.itemId).fields.review as {state?: string; agent?: string} | undefined;
  if (rv?.agent && rv.agent === a.requestedBy && ['submitted', 'accepted', 'changes', 'redo'].includes(rv.state ?? '')) {
    try {
      // Asked for approval before this link existed (or by hand): hand the work in first, then decide it.
      if (rv.state !== 'submitted') tasks.submitWork(a.itemId, rv.agent, a.note.trim() || 'Submitted for approval.');
      tasks.reviewWork(a.itemId, signer, decision === 'approved' ? 'approve' : 'changes', comment || 'See the approval comment.', {fromApproval: true}); }
    catch (e) { tasks.logWork(a.itemId, signer, 'note', `Signed, but the AI work review was not changed: ${(e as Error).message}`); }
  }
  return signed;
}

/** Summary for an item: whether all requested approvals are signed, and whether the item changed since. */
export function approvalState(tasks: Tasks, itemId: string) {
  const list = listApprovals(tasks, {itemId});
  if (!list.length) return null;
  const latest = new Map<string, Approval>();
  for (const a of list) latest.set(a.approver, a);
  const current = [...latest.values()];
  const fp = fingerprint(tasks.item(itemId));
  return {
    pending: current.filter(a => a.decision === 'pending').length,
    approved: current.filter(a => a.decision === 'approved').length,
    blocked: current.some(a => a.decision === 'changes' || a.decision === 'rejected'),
    complete: current.every(a => a.decision === 'approved'),
    changedSinceSigning: current.some(a => a.decision === 'approved' && a.fingerprint !== fp),
  };
}

/** Deciding AI work on the AI work page also settles that reviewer's open approval requests from the same agent on the
 *  task, so the Approvals page and AI work never disagree. Recorded as decided in AI work (no password re-entry). */
export function settleFromAiReview(tasks: Tasks, itemId: string, reviewer: string | null, agent: string | null | undefined, decision: 'approve' | 'changes' | 'redo' | 'discard', comment: string) {
  if (!reviewer || !agent) return;
  if (!tasks.db.prepare("select 1 from sqlite_master where type = 'table' and name = 'approvals'").get()) return;
  const open = listApprovals(tasks, {itemId, approver: reviewer, pending: true}).filter(a => a.requestedBy === agent);
  if (!open.length) return;
  const name = (tasks.db.prepare('select name from people where id = ?').get(reviewer) as {name: string} | undefined)?.name ?? 'Reviewer';
  const d: Exclude<Decision, 'pending'> = decision === 'approve' ? 'approved' : decision === 'discard' ? 'rejected' : 'changes';
  const now = new Date().toISOString(), fp = fingerprint(tasks.item(itemId));
  for (const a of open) tasks.db.prepare('update approvals set decision = ?, comment = ?, signed_at = ?, signer_name = ?, fingerprint = ?, password_checked = 0 where id = ?')
    .run(d, `Decided in AI work (${decision})${comment ? ': ' + comment : ''}`.slice(0, 5000), now, name, fp, a.id);
  tasks.emit({kind: 'comment', itemId});
}
