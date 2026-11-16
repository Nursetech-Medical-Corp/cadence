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
import {checkPassword} from './auth.ts';

export type Meaning = 'reviewed' | 'approved' | 'verified' | 'authored';
export type Decision = 'pending' | 'approved' | 'changes' | 'rejected';
export type Approval = {
  id: string; itemId: string; requestedBy: string | null; approver: string; meaning: Meaning; note: string;
  decision: Decision; comment: string; signedAt: string | null; signerName: string | null; fingerprint: string | null; passwordChecked: boolean; created: string;
};

export function migrateApprovals(tasks: Tasks) {
  tasks.db.exec(`create table if not exists approvals (
    id text primary key, item_id text not null, requested_by text, approver text not null, meaning text not null, note text not null default '',
    decision text not null default 'pending', comment text not null default '', signed_at text, signer_name text, fingerprint text,
    password_checked integer not null default 0, created text not null);
    create index if not exists approvals_item on approvals(item_id);
    create index if not exists approvals_approver on approvals(approver, decision);`);
}

const row = (r: Record<string, unknown>): Approval => ({
  id: r.id as string, itemId: r.item_id as string, requestedBy: (r.requested_by as string) ?? null, approver: r.approver as string,
  meaning: r.meaning as Meaning, note: r.note as string, decision: r.decision as Decision, comment: r.comment as string,
  signedAt: (r.signed_at as string) ?? null, signerName: (r.signer_name as string) ?? null, fingerprint: (r.fingerprint as string) ?? null,
  passwordChecked: !!r.password_checked, created: r.created as string,
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
  return made;
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
  // Signing is an identity check: when the signer has a password it must be entered again now.
  if (stored.password && !checkPassword(password ?? '', stored.password)) throw new Invalid('Password is wrong. Signing needs your password.');
  const item = tasks.item(a.itemId);
  const now = new Date().toISOString();
  tasks.db.prepare('update approvals set decision = ?, comment = ?, signed_at = ?, signer_name = ?, fingerprint = ?, password_checked = ? where id = ?')
    .run(decision, comment.slice(0, 5000), now, stored.name, fingerprint(item), stored.password ? 1 : 0, approvalId);
  const verb = decision === 'approved' ? `signed: ${a.meaning}` : decision === 'changes' ? 'requested changes' : 'rejected';
  tasks.logWork(a.itemId, signer, 'review', `${stored.name} ${verb}${comment ? ': ' + comment : ''}`);
  if (comment.trim()) tasks.addComment(a.itemId, signer, `${decision === 'approved' ? 'Approved' : decision === 'changes' ? 'Changes requested' : 'Rejected'} (${a.meaning}). ${comment}`);
  if (a.requestedBy && a.requestedBy !== signer) tasks.notifyPublic(a.requestedBy, signer, a.itemId, 'approval', `${verb} on ${item.title}`);
  tasks.emit({kind: 'comment', itemId: a.itemId});
  const signed = listApprovals(tasks, {itemId: a.itemId}).find(x => x.id === approvalId)!;
  tasks.event('approval.signed', {projectId: item.projectId, item, actor: signer, details: {approval: signed, decision}});
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
