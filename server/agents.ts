// AI agents as owned teammates.
//
// Each agent (a person with kind 'ai') belongs to a person, its owner. The owner sets what it may do (settings below)
// and approves its work: claims and submitted work (server/aiwork.ts), and, when the agent's write policy is
// 'review', every change it makes to the workspace, which is held as a proposal until the owner approves it.
// Changes to items that follow an AI SOP the owner approved (the item, its parent or its template carries the SOP
// id as a tag or in fields.sop) go straight through and are logged with that SOP.
import {randomBytes} from 'node:crypto';
import type {Tasks} from './service.ts';
import type {Item} from '../src/types.ts';
import {Invalid, NotFound} from './errors.ts';
import {aiQueue, agentOwner, claim, decide} from './aiwork.ts';
import {createEvent, deleteEvent, updateEvent, type EventInput} from './events.ts';

export type AgentSettings = {
  provider: 'claude' | 'chatgpt' | 'meta' | 'other'; spaces: string[] | null; workTypes: 'ai' | 'ai+either'; watchAssignments: boolean;
  checkFrequency: string; maxClaims: number; writePolicy: 'review' | 'direct'; autoApprove: string[]; canCreate: boolean; canInviteOutside: boolean; webhook: string | null;
};
export const DEFAULT_AGENT: AgentSettings = {provider: 'claude', spaces: null, workTypes: 'ai+either', watchAssignments: true, checkFrequency: 'Hourly, 8:00 to 18:00 on weekdays',
  maxClaims: 5, writePolicy: 'review', autoApprove: [], canCreate: true, canInviteOutside: false, webhook: null};
export type Proposal = {id: string; agent: string; owner: string | null; op: string; args: unknown[]; summary: string; reason: string; itemId: string | null; projectId: string | null;
  created: string; state: 'pending' | 'approved' | 'rejected' | 'failed'; decidedBy: string | null; decidedAt: string | null; note: string | null; result: unknown};

const now = () => new Date().toISOString();
const id = () => randomBytes(6).toString('hex');

export function migrateAgents(tasks: Tasks) {
  tasks.db.exec(`create table if not exists proposals (id text primary key, agent text not null, owner text, op text not null, args text not null, summary text not null,
    reason text not null default '', item_id text, project_id text, created text not null, state text not null default 'pending', decided_by text, decided_at text, note text, result text);
    create index if not exists proposals_owner on proposals(owner, state);
    create index if not exists proposals_agent on proposals(agent, created);`);
}

const isAgent = (tasks: Tasks, pid: string | null) => !!pid && (tasks.db.prepare('select kind from people where id = ?').get(pid) as {kind?: string} | undefined)?.kind === 'ai';
const isAdmin = (tasks: Tasks, pid: string | null) => !!pid && !!(tasks.db.prepare('select admin from people where id = ?').get(pid) as {admin?: number} | undefined)?.admin;
const nameOf = (tasks: Tasks, pid: string | null) => pid ? (tasks.db.prepare('select name from people where id = ?').get(pid) as {name?: string} | undefined)?.name ?? 'someone' : 'someone';

export function agentSettings(tasks: Tasks, agent: string): AgentSettings {
  const r = tasks.db.prepare('select agent from people where id = ?').get(agent) as {agent?: string | null} | undefined;
  return {...DEFAULT_AGENT, ...(r?.agent ? JSON.parse(r.agent) : {})};
}
export function agentsOf(tasks: Tasks, owner: string) {
  return (tasks.db.prepare("select id, name from people where kind = 'ai' and owner = ? and coalesce(active, 1) = 1 order by name").all(owner) as {id: string; name: string}[])
    .map(a => ({...a, settings: agentSettings(tasks, a.id)}));
}
export function listAgents(tasks: Tasks) {
  return (tasks.db.prepare("select id, name, owner, email from people where kind = 'ai' order by name").all() as {id: string; name: string; owner: string | null; email: string | null}[])
    .map(a => ({...a, ownerName: a.owner ? nameOf(tasks, a.owner) : null, settings: agentSettings(tasks, a.id)}));
}
/** Anyone signed in can add an agent of their own. It gets its owner's role, never admin. */
export function addAgent(tasks: Tasks, owner: string, input: {name: string; provider?: AgentSettings['provider']}) {
  if (isAgent(tasks, owner)) throw new Invalid('AI agents cannot add agents');
  const p = tasks.createPerson({name: String(input.name ?? '').trim() || `${nameOf(tasks, owner).split(' ')[0]}'s Claude`});
  const cols = tasks.db.prepare('pragma table_info(people)').all().map(r => r.name as string);
  const role = cols.includes('role') ? (tasks.db.prepare('select role from people where id = ?').get(owner) as {role?: string} | undefined)?.role : undefined;
  tasks.db.prepare("update people set kind = 'ai', owner = ?, agent = ? where id = ?").run(owner, JSON.stringify({...DEFAULT_AGENT, provider: input.provider ?? 'claude'}), p.id);
  if (role !== undefined && cols.includes('role')) tasks.db.prepare('update people set role = ? where id = ?').run(role, p.id);
  if (cols.includes('admin')) tasks.db.prepare('update people set admin = 0 where id = ?').run(p.id);
  tasks.emit({kind: 'people'});
  return {...tasks.person(p.id), settings: agentSettings(tasks, p.id)};
}
export function saveAgentSettings(tasks: Tasks, agent: string, patch: Partial<AgentSettings> & {owner?: string}, actor: string | null) {
  if (!isAgent(tasks, agent)) throw new NotFound('No such AI agent');
  const owner = agentOwner(tasks, agent);
  if (isAgent(tasks, actor)) throw new Invalid('AI agents cannot change agent settings');
  if (actor && owner !== actor && !isAdmin(tasks, actor)) throw new Invalid(`Only ${nameOf(tasks, owner)} or an admin changes this agent`);
  const next = {...agentSettings(tasks, agent), ...patch};
  delete (next as {owner?: string}).owner;
  if (!['claude', 'chatgpt', 'meta', 'other'].includes(next.provider)) throw new Invalid('provider must be claude, chatgpt, meta or other');
  if (!['ai', 'ai+either'].includes(next.workTypes)) throw new Invalid('workTypes must be ai or ai+either');
  if (!['review', 'direct'].includes(next.writePolicy)) throw new Invalid('writePolicy must be review or direct');
  if (!Number.isInteger(next.maxClaims) || next.maxClaims < 0 || next.maxClaims > 100) throw new Invalid('maxClaims must be 0 to 100');
  if (!Array.isArray(next.autoApprove) || next.autoApprove.some(x => typeof x !== 'string' || x.length > 40)) throw new Invalid('autoApprove must be a list of SOP ids like SOP-07.26');
  next.autoApprove = [...new Set(next.autoApprove.map(x => x.trim().toUpperCase()).filter(Boolean))];
  if (next.spaces !== null && (!Array.isArray(next.spaces) || next.spaces.some(s => !tasks.listProjects().some(p => p.id === s)))) throw new Invalid('spaces must be space ids, or null for all');
  if (next.webhook && !/^https?:\/\//.test(next.webhook)) throw new Invalid('webhook must be an http(s) URL');
  if (typeof next.checkFrequency !== 'string' || next.checkFrequency.length > 120) throw new Invalid('checkFrequency is a short note');
  tasks.db.prepare('update people set agent = ? where id = ?').run(JSON.stringify(next), agent);
  if (patch.owner !== undefined) {
    if (!isAdmin(tasks, actor) && actor) throw new Invalid('Only an admin moves an agent to another owner');
    if (patch.owner && isAgent(tasks, patch.owner)) throw new Invalid('An agent cannot own an agent');
    tasks.db.prepare('update people set owner = ? where id = ?').run(patch.owner || null, agent);
  }
  tasks.emit({kind: 'people'});
  return {settings: next, owner: agentOwner(tasks, agent)};
}

// ---- Proposals: agent changes held for the owner ----

/** Ops that change the workspace. Logging, comments, claims, submissions and timers are not held. */
export const WRITE_OPS = new Set(['createItem', 'updateItem', 'deleteItem', 'quickAdd', 'importItems', 'applyPlan', 'applyToChildren', 'upsertExternal', 'fromEmail', 'fileTask',
  'createSprint', 'updateSprint', 'deleteSprint', 'rolloverSprint', 'updateProject', 'createProject', 'createProjectFromTemplate', 'createRollup', 'deleteProject',
  'createView', 'updateView', 'deleteView', 'reorderViews', 'createTemplate', 'updateTemplate', 'deleteTemplate', 'saveItemTemplate', 'saveProjectTemplate', 'saveViewTemplate',
  'useItemTemplate', 'useViewTemplate', 'installPack', 'revert', 'setDayMinutes']);

export function needsReview(tasks: Tasks, actor: string | null) {
  if (!isAgent(tasks, actor)) return false;
  return agentSettings(tasks, actor!).writePolicy === 'review';
}
const sopsOf = (i: Item | null | undefined) => i ? [...i.tags, String(i.fields.sop ?? '')].map(s => s.trim().toUpperCase()).filter(s => /^SOP-/.test(s)) : [];
/** The approved SOP an agent's change follows, if any. */
export function approvedSop(tasks: Tasks, agent: string, op: string, args: unknown[]): string | null {
  const allowed = new Set(agentSettings(tasks, agent).autoApprove);
  if (!allowed.size) return null;
  const item = (x: unknown) => { try { return typeof x === 'string' ? tasks.findItem(x) : null; } catch { return null; } };
  let found: string[] = [];
  if (op === 'updateItem' || op === 'deleteItem' || op === 'applyToChildren') { const i = item(args[0]); found = [...sopsOf(i), ...sopsOf(i?.parentId ? item(i.parentId) : null)]; }
  if (op === 'createItem') {
    const inp = (args[0] ?? {}) as {tags?: string[]; fields?: Record<string, unknown>; parentId?: string | null};
    found = [...(inp.tags ?? []), String(inp.fields?.sop ?? '')].map(s => s.trim().toUpperCase()).concat(sopsOf(inp.parentId ? item(inp.parentId) : null));
  }
  return found.find(s => allowed.has(s)) ?? null;
}
function describe(tasks: Tasks, op: string, args: unknown[]) {
  const ref = (x: unknown) => { try { const i = tasks.findItem(String(x)); return `${tasks.project(i.projectId).key}-${i.number} "${i.title}"`; } catch { return String(x); } };
  const a0 = args[0] as Record<string, unknown> | string | undefined;
  switch (op) {
    case 'createItem': return `Create "${(a0 as {title?: string})?.title ?? ''}"`;
    case 'updateItem': return `Change ${ref(a0)}: ${Object.keys((args[1] ?? {}) as object).join(', ')}`;
    case 'deleteItem': return `Delete ${ref(a0)}`;
    case 'quickAdd': return `Add "${(a0 as {text?: string})?.text ?? ''}"`;
    case 'importItems': return `Import ${Array.isArray(args[1]) ? args[1].length : 'some'} items`;
    case 'applyPlan': return `Reschedule ${Array.isArray(args[1]) ? args[1].length : 'some'} items`;
    case 'event.create': return `Schedule "${(a0 as {title?: string})?.title ?? ''}"`;
    case 'event.update': return `Change meeting ${String(a0)}`;
    case 'event.delete': return `Cancel meeting ${String(a0)}`;
    case 'suggestWork': return `Suggest "${(a0 as {title?: string})?.title ?? ref((a0 as {item?: string})?.item)}" for ${nameOf(tasks, (a0 as {forPerson?: string})?.forPerson ?? null)}`;
    default: return op.replace(/([A-Z])/g, ' $1').toLowerCase();
  }
}
const itemOf = (tasks: Tasks, op: string, args: unknown[]) => {
  try {
    if (['updateItem', 'deleteItem', 'applyToChildren'].includes(op)) { const i = tasks.findItem(String(args[0])); return {itemId: i.id, projectId: i.projectId}; }
    const a0 = args[0] as {projectId?: string; parentId?: string} | undefined;
    if (a0?.projectId) return {itemId: null, projectId: a0.projectId};
    if (typeof args[0] === 'string' && op !== 'event.update' && op !== 'event.delete') return {itemId: null, projectId: tasks.project(args[0]).id};
  } catch { /* nothing to link */ }
  return {itemId: null, projectId: null};
};
export function propose(tasks: Tasks, agent: string, op: string, args: unknown[], reason = ''): {proposal: string; state: 'pending'; summary: string; note: string} {
  const owner = agentOwner(tasks, agent);
  const p: Proposal = {id: id(), agent, owner, op, args, summary: describe(tasks, op, args).slice(0, 300), reason: reason.slice(0, 2000), ...itemOf(tasks, op, args),
    created: now(), state: 'pending', decidedBy: null, decidedAt: null, note: null, result: null};
  tasks.db.prepare('insert into proposals (id, agent, owner, op, args, summary, reason, item_id, project_id, created) values (?,?,?,?,?,?,?,?,?,?)')
    .run(p.id, agent, owner, op, JSON.stringify(args), p.summary, p.reason, p.itemId, p.projectId, p.created);
  if (owner) tasks.notifyPublic(owner, agent, p.itemId, 'ai', `proposes: ${p.summary}. Approve it on the AI work page.`);
  tasks.emit({kind: 'refresh'});
  return {proposal: p.id, state: 'pending', summary: p.summary, note: `Held for ${nameOf(tasks, owner)} to approve. Check agent_inbox later for the decision.`};
}
const toProposal = (r: Record<string, unknown>): Proposal => ({id: r.id as string, agent: r.agent as string, owner: (r.owner as string) ?? null, op: r.op as string, args: JSON.parse(r.args as string),
  summary: r.summary as string, reason: r.reason as string, itemId: (r.item_id as string) ?? null, projectId: (r.project_id as string) ?? null, created: r.created as string,
  state: r.state as Proposal['state'], decidedBy: (r.decided_by as string) ?? null, decidedAt: (r.decided_at as string) ?? null, note: (r.note as string) ?? null, result: r.result ? JSON.parse(r.result as string) : null});
export function listProposals(tasks: Tasks, q: {owner?: string; agent?: string; state?: string; since?: string} = {}) {
  const where: string[] = [], vals: string[] = [];
  if (q.owner) { where.push('owner = ?'); vals.push(q.owner); }
  if (q.agent) { where.push('agent = ?'); vals.push(q.agent); }
  if (q.state) { where.push('state = ?'); vals.push(q.state); }
  if (q.since) { where.push('coalesce(decided_at, created) > ?'); vals.push(q.since); }
  return tasks.db.prepare(`select * from proposals ${where.length ? 'where ' + where.join(' and ') : ''} order by created desc limit 500`).all(...vals).map(toProposal);
}
export function getProposal(tasks: Tasks, pid: string) {
  const r = tasks.db.prepare('select * from proposals where id = ?').get(pid);
  if (!r) throw new NotFound('No such proposal');
  return toProposal(r);
}

/** Suggested work, applied on approval: the task (new or existing) goes to the person and the right agent, already accepted. */
export type Suggestion = {title?: string; item?: string; projectId?: string; forPerson: string; reason?: string; sop?: string; estimate?: number; due?: string; agent: string};
export function applySuggestion(tasks: Tasks, s: Suggestion, by: string) {
  const agentFor = agentOwner(tasks, s.agent) === s.forPerson ? s.agent : agentsOf(tasks, s.forPerson).find(a => a.settings.watchAssignments)?.id ?? null;
  let item: Item;
  if (s.item) {
    item = tasks.findItem(s.item);
    item = tasks.updateItem(item.id, {assignees: [...new Set([...item.assignees, s.forPerson])]}, by);
  } else {
    if (!s.projectId || !s.title) throw new Invalid('A new suggestion needs a space and a title');
    item = tasks.createItem({projectId: s.projectId, title: s.title, body: s.reason ? `Suggested by ${nameOf(tasks, s.agent)}: ${s.reason}` : '', assignees: [s.forPerson],
      estimate: s.estimate ?? null, due: s.due ?? null, tags: s.sop ? [s.sop.toUpperCase()] : [], fields: {worker: agentFor ? 'either' : 'human'}}, by);
  }
  if (agentFor && (item.fields.worker ?? 'either') !== 'human') {
    claim(tasks, item.id, agentFor, s.reason ?? '');
    // Approved by a person, or by the owner's standing approval of the SOP it follows.
    decide(tasks, item.id, isAgent(tasks, by) ? agentOwner(tasks, agentFor) : by, true, isAgent(tasks, by) ? `Accepted under approved ${s.sop}` : 'Accepted with the suggestion');
  }
  return tasks.item(item.id);
}
function runSpecial(tasks: Tasks, op: string, args: unknown[], by: string) {
  if (op === 'event.create') return createEvent(tasks, args[0] as EventInput, by, {organizer: by});
  if (op === 'event.update') return updateEvent(tasks, String(args[0]), args[1] as EventInput, by, (args[2] ?? {}) as {scope?: 'all' | 'one'; occurrence?: string});
  if (op === 'event.delete') return deleteEvent(tasks, String(args[0]), by, (args[1] ?? {}) as {scope?: 'all' | 'one'; occurrence?: string});
  if (op === 'suggestWork') return applySuggestion(tasks, args[0] as Suggestion, by);
  return undefined;
}

/** The owner (or an admin) approves: the change is made now, by the approver on the agent's behalf. */
export function decideProposal(tasks: Tasks, pid: string, decider: string | null, approve: boolean, opts: {note?: string; args?: unknown[]} = {}) {
  const p = getProposal(tasks, pid);
  if (p.state !== 'pending') throw new Invalid(`This proposal was already ${p.state}`);
  if (isAgent(tasks, decider)) throw new Invalid('Only a person approves an agent\'s proposal');
  if (decider && p.owner && decider !== p.owner && !isAdmin(tasks, decider)) throw new Invalid(`Only ${nameOf(tasks, p.owner)} or an admin decides this proposal`);
  const done = (state: Proposal['state'], result: unknown, note = opts.note ?? null) => {
    tasks.db.prepare('update proposals set state = ?, decided_by = ?, decided_at = ?, note = ?, result = ? where id = ?').run(state, decider, now(), note, JSON.stringify(result ?? null), pid);
    tasks.notifyPublic(p.agent, decider, p.itemId, 'ai', `${state === 'approved' ? 'approved' : state === 'rejected' ? 'rejected' : 'could not apply'}: ${p.summary}${note ? ` (${note})` : ''}`);
    tasks.emit({kind: 'refresh'});
    return {...getProposal(tasks, pid)};
  };
  if (!approve) return done('rejected', null);
  const args = opts.args ?? p.args;
  const by = decider ?? p.owner ?? p.agent;
  // Run as the person approving, so rules meant for agents (like not marking work done) do not block an approved change.
  const swap = (list: unknown[]) => list.map(a => a === p.agent ? by : a);
  try {
    let result: unknown;
    if (p.op.startsWith('event.') || p.op === 'suggestWork') result = runSpecial(tasks, p.op, args, by);
    else {
      const fn = (tasks as unknown as Record<string, (...a: unknown[]) => unknown>)[p.op];
      if (typeof fn !== 'function') throw new Invalid(`Cannot apply ${p.op}`);
      result = fn.apply(tasks, swap(args));
    }
    if (p.itemId) { try { tasks.addComment(p.itemId, by, `Approved a change proposed by ${nameOf(tasks, p.agent)}: ${p.summary}`); } catch { /* item gone */ } }
    return done('approved', result);
  } catch (e) {
    return done('failed', null, (e as Error).message);
  }
}

// ---- What an agent should look at ----

/** One call per run: new assignments for the owner, work it may take, work sent back, decided proposals. */
export function agentInbox(tasks: Tasks, agent: string, since?: string) {
  if (!isAgent(tasks, agent)) throw new Invalid('agent_inbox is for AI agents');
  const s = agentSettings(tasks, agent), owner = agentOwner(tasks, agent);
  const after = since ?? new Date(Date.now() - 86400000).toISOString();
  const inSpace = (pid: string) => !s.spaces || s.spaces.includes(pid);
  const key = (i: Item) => `${tasks.project(i.projectId).key}-${i.number}`;
  const brief = (i: Item) => ({id: i.id, key: key(i), title: i.title, due: i.due, priority: i.priority, worker: (i.fields.worker as string) ?? 'either', estimate: i.estimate, assignees: i.assignees});
  const notes = tasks.db.prepare('select * from notifications where person = ? and created > ? order by created').all(agent, after) as Record<string, unknown>[];
  const assigned = owner ? tasks.listItems({open: true}).filter(i => i.assignees.includes(owner) && inSpace(i.projectId) && i.updated > after && (i.fields.worker ?? 'either') !== 'human') : [];
  const queue = aiQueue(tasks, agent).filter(x => inSpace(x.item.projectId) && (s.workTypes === 'ai+either' || x.item.fields.worker === 'ai'));
  const mine = queue.filter(x => x.review?.agent === agent && ['claimed', 'accepted', 'changes'].includes(x.review.state));
  return {
    now: now(), owner: owner ? {id: owner, name: nameOf(tasks, owner)} : null, settings: s,
    openClaims: mine.length, canClaimMore: Math.max(0, s.maxClaims - mine.length),
    newForOwner: assigned.map(brief),
    available: queue.filter(x => !x.review || x.review.state === 'declined').map(x => brief(x.item)),
    working: mine.filter(x => x.review!.state === 'accepted').map(x => brief(x.item)),
    sentBack: mine.filter(x => x.review!.state === 'changes').map(x => ({...brief(x.item), comment: x.review!.note ?? ''})),
    waiting: mine.filter(x => x.review!.state === 'claimed').map(x => brief(x.item)),
    proposals: listProposals(tasks, {agent, since: after}).map(p => ({id: p.id, summary: p.summary, state: p.state, note: p.note})),
    notifications: notes.map(n => ({text: n.text, itemId: n.item_id, at: n.created, kind: n.kind})),
  };
}

/** When work is assigned to a person, their agents that watch assignments hear about it (and their webhook fires). */
export function startAgents(tasks: Tasks, opts: {post?: (url: string, body: unknown) => Promise<void>} = {}) {
  migrateAgents(tasks);
  tasks.onAssign(({person, actor, item}) => {
    if (isAgent(tasks, person) || (item.fields.worker ?? 'either') === 'human') return;
    const ref = `${tasks.project(item.projectId).key}-${item.number}`;
    for (const a of agentsOf(tasks, person)) {
      if (!a.settings.watchAssignments || a.id === actor || item.assignees.includes(a.id)) continue;
      if (a.settings.spaces && !a.settings.spaces.includes(item.projectId)) continue;
      tasks.notifyPublic(a.id, actor, item.id, 'assigned', `${nameOf(tasks, person)} has a new task ${ref}: ${item.title}. Check whether you can do it.`);
      if (a.settings.webhook && opts.post) void opts.post(a.settings.webhook, {event: 'assigned', person: {id: person, name: nameOf(tasks, person)}, agent: {id: a.id, name: a.name},
        item: {id: item.id, key: ref, title: item.title, due: item.due, worker: item.fields.worker ?? 'either'}, at: now()}).catch(e => console.error('Agent webhook failed', (e as Error).message));
    }
  });
}
