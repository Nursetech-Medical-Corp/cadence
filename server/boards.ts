// Whiteboards: an infinite canvas to design and run workflows.
//
// A board holds nodes (task cards, stickies, text, shapes, frames, links to documents such as Google Drive SOPs,
// triggers and webhooks) and edges between them. Task cards can link to real items (a routine, a task) or be
// plain ideas until "Create tasks" turns them into items. Flow edges between task cards become dependencies.
//
// Running a board (by hand, from an inbound webhook, on a schedule, or when a tagged item is finished) starts a run:
// one parent item for the run, a child item per unlinked task card (with dependencies following the arrows),
// linked cards tracked as they are, and webhook cards that POST once everything before them is done.
// Every step is kept in the run log, so automations and routines are visible and checkable.
import {randomBytes} from 'node:crypto';
import type {Tasks} from './service.ts';
import {Invalid, NotFound} from './errors.ts';
import {safeTarget} from './integrations.ts';
import {parseQuickAdd} from '../src/quickadd.ts';
import {daysBetween} from '../src/dates.ts';
import type {Item} from '../src/types.ts';
import {listSopLinks, sopCode} from './sops.ts';

export const NODE_KINDS = ['task', 'sticky', 'text', 'shape', 'frame', 'link', 'trigger', 'webhook', 'end'] as const;
export type NodeKind = typeof NODE_KINDS[number];
export type TriggerOn = 'manual' | 'webhook' | 'completed' | 'schedule';
export type BoardNode = {
  id: string; kind: NodeKind; x: number; y: number; w: number; h: number; text: string; color?: string | null;
  /** task: the item this card stands for (a routine's live copy is followed after it repeats). */
  itemId?: string | null;
  /** link: the document (Google Drive SOP, any https page). webhook: where it POSTs. */
  url?: string | null;
  assignees?: string[]; worker?: 'human' | 'ai' | 'either'; sop?: string | null; estimate?: number | null;
  /** task: quick-add repeat, like week, 2w, month or weekdays, used by Create tasks. */
  repeat?: string | null;
  shape?: 'rect' | 'ellipse' | 'diamond';
  trigger?: {on: TriggerOn; tag?: string | null; every?: 'day' | 'week' | 'month' | null};
};
export type BoardEdge = {id: string; from: string; to: string; label?: string | null; kind?: 'flow' | 'link'};
export type BoardHook = {id: string; url: string; events: string[]};
export type Board = {id: string; projectId: string | null; name: string; description: string; nodes: BoardNode[]; edges: BoardEdge[];
  webhooks: BoardHook[]; hookKey: string; createdBy: string | null; created: string; updated: string; lastScheduled: string | null};
export type StepState = 'waiting' | 'open' | 'done' | 'firing' | 'fired' | 'failed' | 'skipped';
export type Step = {node: string; kind: NodeKind; title: string; itemId: string | null; state: StepState; at: string | null; note: string | null};
export type RunLog = {at: string; text: string};
export type Run = {id: string; boardId: string; state: 'running' | 'done' | 'failed' | 'cancelled'; trigger: string; by: string | null; started: string; finished: string | null;
  parentItem: string | null; input: unknown; steps: Step[]; log: RunLog[]};

export const RUN_EVENTS = ['run.started', 'step.done', 'run.done', 'run.failed'] as const;
const STEP_KINDS = new Set<NodeKind>(['task', 'webhook', 'end']);
const NON_FLOW = new Set<NodeKind>(['sticky', 'text', 'shape', 'frame', 'link']);
const now = () => new Date().toISOString();
const rid = () => randomBytes(6).toString('hex');
const j = <T>(s: unknown, d: T): T => { try { return typeof s === 'string' && s ? JSON.parse(s) : d; } catch { return d; } };
const migrated = new WeakSet<object>();

/** Sends webhook payloads. Tests swap it; the default only reaches public addresses. */
type Poster = (url: string, payload: unknown) => Promise<void>;
let poster: Poster = async (url, payload) => {
  if (!(await safeTarget(url))) throw new Error('Blocked: private or local address');
  const r = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10_000)});
  if (!r.ok) throw new Error(`Answered ${r.status}`);
};
export const setBoardPoster = (p: Poster) => { poster = p; };
const pending = new Set<Promise<unknown>>();
/** Waits for webhook calls in flight (tests). */
export async function settleBoards() { while (pending.size) await Promise.all([...pending]); }

export function migrateBoards(tasks: Tasks) {
  if (migrated.has(tasks.db)) return;
  tasks.db.exec(`create table if not exists boards (id text primary key, project_id text, name text not null, description text not null default '',
      data text not null default '{}', webhooks text not null default '[]', hook_key text not null, created_by text, created text not null, updated text not null, last_scheduled text);
    create table if not exists board_runs (id text primary key, board_id text not null, state text not null, trigger text not null, by text, started text not null, finished text,
      parent_item text, input text, steps text not null default '[]', log text not null default '[]');
    create index if not exists board_runs_board on board_runs(board_id, started);
    create index if not exists board_runs_state on board_runs(state);`);
  migrated.add(tasks.db);
}

const toBoard = (r: Record<string, unknown>): Board => {
  const d = j<{nodes?: BoardNode[]; edges?: BoardEdge[]}>(r.data, {});
  return {id: r.id as string, projectId: (r.project_id as string) ?? null, name: r.name as string, description: r.description as string, nodes: d.nodes ?? [], edges: d.edges ?? [],
    webhooks: j(r.webhooks, []), hookKey: r.hook_key as string, createdBy: (r.created_by as string) ?? null, created: r.created as string, updated: r.updated as string, lastScheduled: (r.last_scheduled as string) ?? null};
};
const toRun = (r: Record<string, unknown>): Run => ({id: r.id as string, boardId: r.board_id as string, state: r.state as Run['state'], trigger: r.trigger as string, by: (r.by as string) ?? null,
  started: r.started as string, finished: (r.finished as string) ?? null, parentItem: (r.parent_item as string) ?? null, input: j(r.input, null), steps: j(r.steps, []), log: j(r.log, [])});

export function listBoards(tasks: Tasks, q: {projectId?: string; itemId?: string} = {}): Board[] {
  migrateBoards(tasks);
  let list = tasks.db.prepare('select * from boards order by updated desc').all().map(toBoard);
  if (q.projectId) list = list.filter(b => b.projectId === q.projectId);
  if (q.itemId) { const ids = new Set(itemChain(tasks, q.itemId)); list = list.filter(b => b.nodes.some(n => n.itemId && (ids.has(n.itemId) || ids.has(liveId(tasks, n.itemId))))); }
  return list;
}
export function getBoard(tasks: Tasks, ref: string): Board {
  migrateBoards(tasks);
  const r = tasks.db.prepare('select * from boards where id = ?').get(ref) ?? tasks.db.prepare('select * from boards where lower(name) = lower(?) order by updated desc').get(ref);
  if (!r) throw new NotFound(`No whiteboard "${ref}"`);
  return toBoard(r);
}

/** A routine's copy that is finished points to the next one; follow to the live copy. */
export function liveId(tasks: Tasks, itemId: string) {
  let id = itemId;
  for (let n = 0; n < 200; n++) {
    const r = tasks.db.prepare('select recur from items where id = ?').get(id) as {recur: string | null} | undefined;
    const next = r ? j<{spawned?: string} | null>(r.recur, null)?.spawned : undefined;
    if (!next) return id;
    id = next;
  }
  return id;
}
/** Every copy of a routine that leads to this item, so a board linked to an older copy still finds it. */
function itemChain(tasks: Tasks, itemId: string) {
  const out = [itemId];
  const rows = tasks.db.prepare("select id, recur from items where recur like '%spawned%'").all() as {id: string; recur: string}[];
  const back = new Map(rows.map(r => [j<{spawned?: string}>(r.recur, {}).spawned, r.id]));
  for (let cur = itemId, n = 0; back.has(cur) && n < 500; n++) { cur = back.get(cur)!; out.push(cur); }
  return out;
}

const num = (v: unknown, d: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
const str = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : '';
const SIZES: Record<NodeKind, [number, number]> = {task: [220, 96], sticky: [180, 140], text: [200, 40], shape: [160, 100], frame: [600, 400], link: [220, 64], trigger: [180, 64], webhook: [200, 72], end: [120, 52]};

function cleanNode(tasks: Tasks, n: Partial<BoardNode>, people: Set<string>): BoardNode {
  if (!n || typeof n !== 'object') throw new Invalid('Each node must be an object');
  const kind = n.kind as NodeKind;
  if (!NODE_KINDS.includes(kind)) throw new Invalid(`Node kind must be one of: ${NODE_KINDS.join(', ')}`);
  const [w, h] = SIZES[kind];
  const out: BoardNode = {id: str(n.id, 40) || rid(), kind, x: num(n.x, 0, -1e6, 1e6), y: num(n.y, 0, -1e6, 1e6), w: num(n.w || undefined, w, 40, 8000), h: num(n.h || undefined, h, 24, 8000), text: str(n.text, 5000)};
  if (n.color) out.color = /^#[0-9a-f]{3,8}$/i.test(n.color) ? n.color : null;
  if (n.url) {
    if (!/^https?:\/\//i.test(n.url)) throw new Invalid('Links must start with https:// or http://');
    out.url = str(n.url, 2000);
  }
  if (kind === 'task') {
    if (n.itemId) out.itemId = tasks.findItem(n.itemId).id;
    if (n.assignees?.length) { for (const a of n.assignees) if (!people.has(a)) throw new Invalid(`Unknown person ${a}`); out.assignees = [...new Set(n.assignees)]; }
    if (n.worker) { if (!['human', 'ai', 'either'].includes(n.worker)) throw new Invalid('worker must be human, ai or either'); out.worker = n.worker; }
    if (n.sop) out.sop = sopCode(n.sop) ?? str(n.sop, 40);
    if (n.estimate != null) out.estimate = num(n.estimate, 0, 0, 10000);
    if (n.repeat) out.repeat = str(n.repeat, 20);
  }
  if (kind === 'shape') out.shape = n.shape === 'ellipse' || n.shape === 'diamond' ? n.shape : 'rect';
  if (kind === 'trigger') {
    const t = n.trigger ?? {on: 'manual'};
    if (!['manual', 'webhook', 'completed', 'schedule'].includes(t.on)) throw new Invalid('trigger.on must be manual, webhook, completed or schedule');
    out.trigger = {on: t.on, tag: t.on === 'completed' ? str(t.tag, 60) || null : null, every: t.on === 'schedule' ? (['day', 'week', 'month'].includes(t.every as string) ? t.every : 'week') : null};
    if (t.on === 'completed' && !out.trigger.tag) throw new Invalid('A "when finished" trigger needs a tag (like SOP-07.2) or an item key');
  }
  return out;
}
function cleanGraph(tasks: Tasks, nodes: unknown, edges: unknown) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Invalid('nodes and edges must be lists');
  if (nodes.length > 1000 || edges.length > 3000) throw new Invalid('A board holds up to 1000 nodes and 3000 connections');
  const people = new Set(tasks.listPeople().map(p => p.id));
  const ns = nodes.map(n => cleanNode(tasks, n as BoardNode, people));
  const ids = new Set<string>();
  for (const n of ns) { if (ids.has(n.id)) throw new Invalid(`Two nodes have the id ${n.id}`); ids.add(n.id); }
  const es: BoardEdge[] = [];
  for (const e of edges as BoardEdge[]) {
    if (!ids.has(e?.from) || !ids.has(e?.to)) throw new Invalid('Every connection must join two nodes on this board');
    if (e.from === e.to) continue;
    const fromKind = ns.find(n => n.id === e.from)!.kind, toKind = ns.find(n => n.id === e.to)!.kind;
    const kind = e.kind === 'link' || NON_FLOW.has(fromKind) || NON_FLOW.has(toKind) ? 'link' : 'flow';
    es.push({id: str(e.id, 40) || rid(), from: e.from, to: e.to, label: str(e.label, 200) || null, kind});
  }
  return {nodes: ns, edges: es};
}
function cleanHooks(v: unknown): BoardHook[] {
  if (!Array.isArray(v)) throw new Invalid('webhooks must be a list');
  return v.slice(0, 20).map((h: BoardHook) => {
    if (!/^https?:\/\//.test(String(h?.url ?? ''))) throw new Invalid('Webhook links must start with https:// or http://');
    const events = (Array.isArray(h.events) ? h.events : []).filter(e => (RUN_EVENTS as readonly string[]).includes(e));
    return {id: str(h.id, 40) || rid(), url: str(h.url, 2000), events};
  });
}

export type BoardInput = {name?: string; description?: string; projectId?: string | null; nodes?: BoardNode[]; edges?: BoardEdge[]; webhooks?: BoardHook[]};
export function createBoard(tasks: Tasks, input: BoardInput, actor: string | null): Board {
  migrateBoards(tasks);
  const name = str(input.name, 200).trim() || 'Untitled board';
  if (input.projectId) { const p = tasks.project(input.projectId); if (p.settings.rollup) throw new Invalid('Put a whiteboard in a real space, not a rollup'); }
  const g = cleanGraph(tasks, input.nodes ?? [], input.edges ?? []);
  const t = now(), b: Board = {id: rid(), projectId: input.projectId ?? null, name, description: str(input.description, 5000), ...g, webhooks: cleanHooks(input.webhooks ?? []),
    hookKey: 'wb_' + randomBytes(18).toString('base64url'), createdBy: actor, created: t, updated: t, lastScheduled: null};
  tasks.db.prepare('insert into boards (id, project_id, name, description, data, webhooks, hook_key, created_by, created, updated) values (?,?,?,?,?,?,?,?,?,?)')
    .run(b.id, b.projectId, b.name, b.description, JSON.stringify({nodes: b.nodes, edges: b.edges}), JSON.stringify(b.webhooks), b.hookKey, actor, t, t);
  tasks.emit({kind: 'boards'});
  return b;
}

/** Small changes for agents: add, change or remove nodes and connections without sending the whole board. */
export type BoardOps = {addNodes?: BoardNode[]; updateNodes?: (Partial<BoardNode> & {id: string})[]; removeNodes?: string[]; addEdges?: BoardEdge[]; removeEdges?: string[]};
export function updateBoard(tasks: Tasks, ref: string, patch: BoardInput & BoardOps & {rotateKey?: boolean}, _actor: string | null): Board {
  const b = getBoard(tasks, ref);
  let nodes = patch.nodes ?? b.nodes, edges = patch.edges ?? b.edges;
  if (patch.removeNodes?.length) { const rm = new Set(patch.removeNodes); nodes = nodes.filter(n => !rm.has(n.id)); edges = edges.filter(e => !rm.has(e.from) && !rm.has(e.to)); }
  if (patch.updateNodes?.length) {
    for (const u of patch.updateNodes) if (!nodes.some(n => n.id === u.id)) throw new Invalid(`No node ${u.id} on this board`);
    nodes = nodes.map(n => { const u = patch.updateNodes!.find(x => x.id === n.id); return u ? {...n, ...u, kind: u.kind ?? n.kind} as BoardNode : n; });
  }
  if (patch.addNodes?.length) nodes = [...nodes, ...patch.addNodes];
  if (patch.removeEdges?.length) { const rm = new Set(patch.removeEdges); edges = edges.filter(e => !rm.has(e.id)); }
  if (patch.addEdges?.length) edges = [...edges, ...patch.addEdges];
  const g = cleanGraph(tasks, nodes, edges);
  let projectId = b.projectId;
  if (patch.projectId !== undefined) {
    if (patch.projectId) { const p = tasks.project(patch.projectId); if (p.settings.rollup) throw new Invalid('Put a whiteboard in a real space, not a rollup'); }
    projectId = patch.projectId || null;
  }
  const next: Board = {...b, ...g, projectId, name: patch.name !== undefined ? (str(patch.name, 200).trim() || b.name) : b.name,
    description: patch.description !== undefined ? str(patch.description, 5000) : b.description,
    webhooks: patch.webhooks !== undefined ? cleanHooks(patch.webhooks) : b.webhooks,
    hookKey: patch.rotateKey ? 'wb_' + randomBytes(18).toString('base64url') : b.hookKey, updated: now()};
  tasks.db.prepare('update boards set project_id = ?, name = ?, description = ?, data = ?, webhooks = ?, hook_key = ?, updated = ? where id = ?')
    .run(next.projectId, next.name, next.description, JSON.stringify({nodes: next.nodes, edges: next.edges}), JSON.stringify(next.webhooks), next.hookKey, next.updated, b.id);
  tasks.emit({kind: 'boards'});
  return next;
}
export function deleteBoard(tasks: Tasks, ref: string) {
  const b = getBoard(tasks, ref);
  tasks.db.prepare('delete from board_runs where board_id = ?').run(b.id);
  tasks.db.prepare('delete from boards where id = ?').run(b.id);
  tasks.emit({kind: 'boards'});
  return {ok: true, id: b.id};
}

// ---- Graph helpers ----
const flowEdges = (b: Board) => b.edges.filter(e => e.kind !== 'link');
/** The nearest steps (task, webhook, end) before this node, looking through triggers and other pass-through nodes. */
function stepsBefore(b: Board, nodeId: string, seen = new Set<string>()): string[] {
  const out: string[] = [];
  for (const e of flowEdges(b).filter(e => e.to === nodeId)) {
    if (seen.has(e.from)) continue;
    seen.add(e.from);
    const n = b.nodes.find(x => x.id === e.from);
    if (!n) continue;
    if (STEP_KINDS.has(n.kind)) out.push(n.id); else out.push(...stepsBefore(b, n.id, seen));
  }
  return [...new Set(out)];
}
/** Links (SOP documents) attached to a node by a connection, plus its SOP code's document. */
function linksOf(tasks: Tasks, b: Board, n: BoardNode) {
  const ids = b.edges.filter(e => e.from === n.id || e.to === n.id).map(e => e.from === n.id ? e.to : e.from);
  const links = b.nodes.filter(x => ids.includes(x.id) && x.kind === 'link' && x.url).map(x => ({title: x.text || x.url!, url: x.url!}));
  if (n.sop) { const s = listSopLinks(tasks).find(l => l.code === n.sop); if (s) links.push({title: s.title || s.code, url: s.url}); }
  return links;
}
/** Topological order of task cards, for creating items in a sensible order. */
function ordered(b: Board, nodes: BoardNode[]) {
  const ids = new Set(nodes.map(n => n.id)), out: BoardNode[] = [], done = new Set<string>();
  const visit = (n: BoardNode, path: Set<string>) => {
    if (done.has(n.id) || path.has(n.id)) return;
    path.add(n.id);
    for (const p of stepsBefore(b, n.id)) { const pn = b.nodes.find(x => x.id === p); if (pn && ids.has(pn.id)) visit(pn, path); }
    done.add(n.id); out.push(n);
  };
  for (const n of [...nodes].sort((a, c) => a.x - c.x || a.y - c.y)) visit(n, new Set());
  return out;
}
const recurFrom = (tasks: Tasks, repeat: string | null | undefined) => repeat ? parseQuickAdd(`x every:${repeat}`, [], tasks.today(), []).recur ?? null : null;

/** Turn task cards without an item into real items (in the board's space, or projectId), and arrows into dependencies. */
export function boardToTasks(tasks: Tasks, ref: string, actor: string | null, opts: {projectId?: string; parentId?: string | null} = {}) {
  const b = getBoard(tasks, ref);
  const projectId = opts.projectId ?? b.projectId;
  if (!projectId) throw new Invalid('Pick a space for the new tasks (or put the board in a space)');
  const cards = ordered(b, b.nodes.filter(n => n.kind === 'task'));
  const made: Item[] = [], itemOf = new Map(cards.filter(n => n.itemId).map(n => [n.id, liveId(tasks, n.itemId!)]));
  const before = (n: BoardNode) => stepsBefore(b, n.id).map(p => itemOf.get(p)).filter((x): x is string => !!x);
  for (const n of cards) {
    if (n.itemId) continue;
    const links = linksOf(tasks, b, n);
    const it = tasks.createItem({projectId, parentId: opts.parentId ?? null, title: n.text.split('\n')[0].trim() || 'Untitled', body: [n.text.split('\n').slice(1).join('\n').trim(), ...links.map(l => `- [${l.title}](${l.url})`)].filter(Boolean).join('\n\n'),
      assignees: n.assignees ?? [], estimate: n.estimate ?? null, tags: n.sop ? [n.sop] : [], fields: {worker: n.worker ?? 'either'}, deps: before(n), recur: recurFrom(tasks, n.repeat)}, actor);
    itemOf.set(n.id, it.id); made.push(it);
  }
  const nodes = b.nodes.map(n => itemOf.has(n.id) && !n.itemId ? {...n, itemId: itemOf.get(n.id)} : n);
  const saved = updateBoard(tasks, b.id, {nodes}, actor);
  return {board: saved, created: made.map(i => ({id: i.id, title: i.title, node: [...itemOf].find(([, v]) => v === i.id)?.[0]}))};
}

/** A board drawn from existing work: routines (by SOP), a tag, a parent's children, or a list of items. Arrows follow dependencies. */
export function boardFromItems(tasks: Tasks, q: {name?: string; projectId?: string | null; tag?: string; parentId?: string; itemIds?: string[]; routines?: boolean; visible?: string[]}, actor: string | null, canSee: (projectId: string) => boolean = () => true): Board {
  const see = (pid: string) => canSee(pid) && (!q.visible || q.visible.includes(pid));
  let items: Item[];
  if (q.itemIds?.length) items = q.itemIds.map(x => tasks.findItem(x));
  else if (q.parentId) items = tasks.listItems({parentId: tasks.findItem(q.parentId).id});
  else if (q.routines || q.tag) items = (q.routines ? tasks.listRoutines() : tasks.listItems({open: true})).filter(i => !q.tag || i.tags.some(t => t.toLowerCase() === q.tag!.toLowerCase()));
  else throw new Invalid('Say which work to draw: routines, a tag, a parent item or items');
  items = items.filter(i => see(i.projectId) && (!q.projectId || i.projectId === q.projectId || q.routines || q.tag));
  if (!items.length) throw new Invalid('No work matched');
  if (items.length > 400) items = items.slice(0, 400);
  const sopOf = (i: Item) => i.tags.map(t => sopCode(t)).find(Boolean) ?? null;
  const groups = new Map<string, Item[]>();
  for (const i of items) { const g = q.routines || q.tag ? (sopOf(i) ?? 'No SOP') : ''; groups.set(g, [...(groups.get(g) ?? []), i]); }
  const sops = new Map(listSopLinks(tasks).map(l => [l.code, l]));
  const nodes: BoardNode[] = [], edges: BoardEdge[] = [], nodeOf = new Map<string, string>();
  let top = 0;
  for (const [g, list] of [...groups].sort((a, c) => a[0].localeCompare(c[0]))) {
    const ids = new Set(list.map(i => i.id));
    const depth = new Map<string, number>();
    const d = (i: Item, path = new Set<string>()): number => {
      if (depth.has(i.id)) return depth.get(i.id)!;
      if (path.has(i.id)) return 0;
      path.add(i.id);
      const v = Math.max(-1, ...i.deps.filter(x => ids.has(x)).map(x => d(tasks.item(x), path))) + 1;
      depth.set(i.id, v); return v;
    };
    const cols = new Map<number, Item[]>();
    for (const i of list) cols.set(d(i), [...(cols.get(d(i)) ?? []), i]);
    const rows = Math.max(...[...cols.values()].map(c => c.length));
    const width = Math.max(600, (Math.max(...cols.keys()) + 1) * 280 + 300), height = rows * 130 + 120;
    const pad = g ? 60 : 0;
    if (g) {
      nodes.push({id: rid(), kind: 'frame', x: 0, y: top, w: width, h: height, text: g === 'No SOP' ? 'No SOP' : `${g}${sops.get(g)?.title ? ' ' + sops.get(g)!.title : ''}`});
      const s = sops.get(g) ?? sops.get('*');
      if (s && g !== 'No SOP') nodes.push({id: rid(), kind: 'link', x: width - 260, y: top + 16, w: 230, h: 56, text: sops.get(g) ? `${g} document` : 'SOP master list', url: s.url});
    }
    for (const [c, col] of [...cols].sort((a, b) => a[0] - b[0])) col.forEach((i, r) => {
      const id = rid(); nodeOf.set(i.id, id);
      nodes.push({id, kind: 'task', x: 30 + c * 280, y: top + pad + 20 + r * 130, w: 230, h: 96, text: i.title, itemId: i.id, sop: sopOf(i), worker: (i.fields.worker as BoardNode['worker']) ?? undefined});
    });
    top += height + 80;
  }
  for (const i of items) for (const dpd of i.deps) if (nodeOf.has(dpd)) edges.push({id: rid(), from: nodeOf.get(dpd)!, to: nodeOf.get(i.id)!, kind: 'flow'});
  const projects = new Set(items.map(i => i.projectId));
  const projectId = q.projectId ?? (projects.size === 1 ? [...projects][0] : null);
  const name = q.name || (q.tag ? `${q.tag} flow` : q.routines ? 'Routines map' : q.parentId ? `${tasks.findItem(q.parentId).title} flow` : 'Work map');
  return createBoard(tasks, {name, projectId, nodes, edges}, actor);
}

// ---- Runs ----
export function listRuns(tasks: Tasks, boardId?: string, limit = 50): Run[] {
  migrateBoards(tasks);
  const rows = boardId ? tasks.db.prepare('select * from board_runs where board_id = ? order by started desc limit ?').all(boardId, limit) : tasks.db.prepare('select * from board_runs order by started desc limit ?').all(limit);
  return rows.map(toRun).map(r => r.state === 'running' ? advance(tasks, r.id) : r);
}
export function getRun(tasks: Tasks, runId: string): Run {
  migrateBoards(tasks);
  const r = tasks.db.prepare('select * from board_runs where id = ?').get(runId);
  if (!r) throw new NotFound('No such run');
  return toRun(r);
}
const saveRun = (tasks: Tasks, r: Run) => {
  tasks.db.prepare('update board_runs set state = ?, finished = ?, steps = ?, log = ? where id = ?').run(r.state, r.finished, JSON.stringify(r.steps), JSON.stringify(r.log.slice(-500)), r.id);
  tasks.emit({kind: 'boards'});
};
const runPayload = (tasks: Tasks, b: Board, r: Run, extra: Record<string, unknown> = {}) => {
  const p = b.projectId ? (() => { try { const x = tasks.project(b.projectId!); return {id: x.id, key: x.key, name: x.name}; } catch { return null; } })() : null;
  return {board: {id: b.id, name: b.name}, space: p, run: {id: r.id, state: r.state, trigger: r.trigger, started: r.started, finished: r.finished, input: r.input}, at: now(), ...extra};
};
function sendHooks(tasks: Tasks, b: Board, event: string, payload: Record<string, unknown>) {
  for (const h of b.webhooks) {
    if (h.events.length && !h.events.includes(event)) continue;
    const p = poster(h.url, {event, ...payload}).catch(e => console.error('Board webhook failed', h.url, (e as Error).message)).finally(() => pending.delete(p));
    pending.add(p);
  }
}

/** Start a run. Needs the board in a space, since its task cards become items there. */
export function runBoard(tasks: Tasks, ref: string, actor: string | null, opts: {trigger?: string; input?: unknown; title?: string} = {}): Run {
  const b = getBoard(tasks, ref);
  if (!b.projectId) throw new Invalid('Put the board in a space first: its task cards become tasks there when it runs');
  const steps = b.nodes.filter(n => STEP_KINDS.has(n.kind));
  if (!steps.length) throw new Invalid('This board has nothing to run. Add task cards or webhooks and connect them with arrows.');
  const raw = JSON.stringify(opts.input ?? null) ?? 'null';
  const input = raw.length > 20_000 ? {truncated: raw.slice(0, 20_000)} : JSON.parse(raw);
  const p = tasks.project(b.projectId);
  const started = now(), trigger = opts.trigger ?? 'manual';
  const inputText = input === null ? '' : '\n\nInput:\n\n```json\n' + JSON.stringify(input, null, 2).slice(0, 8000) + '\n```';
  const parent = tasks.createItem({projectId: p.id, title: (opts.title || `${b.name} run ${tasks.today()}`).slice(0, 500), tags: ['board-run'],
    body: `Run of whiteboard **${b.name}** (${trigger}).${inputText}`, fields: {worker: 'either'}}, actor, {system: true});
  const id = rid();
  const run: Run = {id, boardId: b.id, state: 'running', trigger, by: actor, started, finished: null, parentItem: parent.id, input, steps: [], log: [{at: started, text: `Started (${trigger})`}]};
  // Linked cards are tracked as they are; the others become child tasks of the run, waiting on the cards before them.
  const itemOf = new Map<string, string>();
  for (const n of ordered(b, steps)) {
    if (n.kind !== 'task') { run.steps.push({node: n.id, kind: n.kind, title: n.text || n.kind, itemId: null, state: 'waiting', at: null, note: null}); continue; }
    if (n.itemId) {
      const live = liveId(tasks, n.itemId);
      itemOf.set(n.id, live);
      run.steps.push({node: n.id, kind: 'task', title: n.text, itemId: live, state: 'open', at: null, note: 'Linked task, tracked as it is'});
      continue;
    }
    const deps = stepsBefore(b, n.id).flatMap(s => itemsBefore(b, s, itemOf));
    const links = linksOf(tasks, b, n);
    const it = tasks.createItem({projectId: p.id, parentId: parent.id, title: n.text.split('\n')[0].trim() || 'Step', estimate: n.estimate ?? null,
      body: [n.text.split('\n').slice(1).join('\n').trim(), ...links.map(l => `- [${l.title}](${l.url})`)].filter(Boolean).join('\n\n'),
      assignees: n.assignees ?? [], tags: n.sop ? [n.sop] : [], deps: [...new Set(deps)], fields: {worker: n.worker ?? 'either', board: {board: b.id, run: id, node: n.id}}}, actor, {system: true});
    itemOf.set(n.id, it.id);
    run.steps.push({node: n.id, kind: 'task', title: n.text, itemId: it.id, state: 'open', at: null, note: null});
  }
  tasks.db.prepare('insert into board_runs (id, board_id, state, trigger, by, started, parent_item, input, steps, log) values (?,?,?,?,?,?,?,?,?,?)')
    .run(id, b.id, run.state, trigger, actor, started, parent.id, JSON.stringify(input), JSON.stringify(run.steps), JSON.stringify(run.log));
  sendHooks(tasks, b, 'run.started', runPayload(tasks, b, run));
  tasks.emit({kind: 'boards'});
  return advance(tasks, id);
}
/** Items a step stands for, looking through webhooks to the tasks before them. */
function itemsBefore(b: Board, stepId: string, itemOf: Map<string, string>, seen = new Set<string>()): string[] {
  if (seen.has(stepId)) return [];
  seen.add(stepId);
  if (itemOf.has(stepId)) return [itemOf.get(stepId)!];
  return stepsBefore(b, stepId).flatMap(s => itemsBefore(b, s, itemOf, seen));
}

/** Bring a run up to date with its items: finished tasks, webhooks that may now fire, the end. Safe to call often. */
export function advance(tasks: Tasks, runId: string): Run {
  const r = getRun(tasks, runId);
  if (r.state !== 'running') return r;
  let b: Board;
  try { b = getBoard(tasks, r.boardId); } catch { r.state = 'cancelled'; r.finished = now(); r.log.push({at: now(), text: 'Board deleted'}); saveRun(tasks, r); return r; }
  let changed = false;
  const ok = (s: Step | undefined) => !s || s.state === 'done' || s.state === 'fired' || s.state === 'skipped';
  for (let pass = 0; pass < 50; pass++) {
    let moved = false;
    for (const s of r.steps) {
      if (s.state === 'done' || s.state === 'fired' || s.state === 'skipped' || s.state === 'firing' || s.state === 'failed') continue;
      if (s.kind === 'task' && s.itemId) {
        let it: Item | null = null;
        try { it = tasks.item(s.itemId); } catch { it = null; }
        if (!it) { s.state = 'skipped'; s.note = 'Task was deleted'; s.at = now(); moved = true; continue; }
        // A linked routine counts once the copy that was live when the run started is finished.
        if (it.completed) {
          s.state = 'done'; s.at = it.completed; moved = true;
          r.log.push({at: now(), text: `Done: ${s.title}`});
          sendHooks(tasks, b, 'step.done', runPayload(tasks, b, r, {step: s, item: it}));
        } else {
          const ready = stepsBefore(b, s.node).every(p => ok(r.steps.find(x => x.node === p)));
          const st: StepState = ready ? 'open' : 'waiting';
          if (s.state !== st) { s.state = st; moved = true; }
        }
        continue;
      }
      const before = stepsBefore(b, s.node);
      if (!before.every(p => ok(r.steps.find(x => x.node === p)))) { if (s.state !== 'waiting') { s.state = 'waiting'; moved = true; } continue; }
      const n = b.nodes.find(x => x.id === s.node);
      if (s.kind === 'end' || !n) { s.state = 'done'; s.at = now(); moved = true; continue; }
      if (s.kind === 'webhook') {
        if (!n.url) { s.state = 'skipped'; s.note = 'No link set'; s.at = now(); moved = true; continue; }
        s.state = 'firing'; s.at = now(); moved = true;
        const items = before.map(p => r.steps.find(x => x.node === p)?.itemId).filter((x): x is string => !!x).map(x => { try { const i = tasks.item(x); return {id: i.id, title: i.title, completed: i.completed}; } catch { return null; } }).filter(Boolean);
        const body = {event: 'board.step', ...runPayload(tasks, b, r, {step: {node: n.id, title: n.text}, after: items})};
        const url = n.url;
        const pr = poster(url, body).then(() => finishHook(tasks, r.id, n.id, null), e => finishHook(tasks, r.id, n.id, (e as Error).message)).finally(() => pending.delete(pr));
        pending.add(pr);
      }
    }
    if (!moved) break;
    changed = true;
  }
  const allOk = r.steps.every(s => ok(s));
  if (allOk) {
    r.state = 'done'; r.finished = now(); r.log.push({at: r.finished, text: 'Finished'}); changed = true;
    if (r.parentItem) { try { const pi = tasks.item(r.parentItem); if (!pi.completed) { const p = tasks.project(pi.projectId); const done = p.statuses.find(s => s.category === 'done'); if (done) tasks.updateItem(pi.id, {status: done.id}, null, {system: true}); } } catch { /* parent gone */ } }
    sendHooks(tasks, b, 'run.done', runPayload(tasks, b, r));
  }
  if (changed) saveRun(tasks, r);
  return r;
}
function finishHook(tasks: Tasks, runId: string, node: string, error: string | null) {
  let r: Run;
  try { r = getRun(tasks, runId); } catch { return; }
  const s = r.steps.find(x => x.node === node);
  if (!s || s.state !== 'firing') return;
  s.state = error ? 'failed' : 'fired'; s.at = now(); s.note = error;
  r.log.push({at: s.at, text: error ? `Webhook failed: ${s.title} (${error})` : `Webhook sent: ${s.title}`});
  if (error) { r.state = 'failed'; r.finished = now(); try { const b = getBoard(tasks, r.boardId); sendHooks(tasks, b, 'run.failed', runPayload(tasks, b, r, {step: s})); } catch { /* board gone */ } }
  saveRun(tasks, r);
  if (!error) advance(tasks, runId);
}

/** cancel: stop a run (its tasks stay). retry: send a failed webhook again. skip: count a step as done. */
export function runAction(tasks: Tasks, runId: string, action: 'cancel' | 'retry' | 'skip', node?: string): Run {
  const r = getRun(tasks, runId);
  if (action === 'cancel') {
    if (r.state !== 'running' && r.state !== 'failed') throw new Invalid('This run already ended');
    r.state = 'cancelled'; r.finished = now(); r.log.push({at: r.finished, text: 'Cancelled'}); saveRun(tasks, r); return r;
  }
  const s = r.steps.find(x => x.node === node);
  if (!s) throw new Invalid('Name the step (node id) to retry or skip');
  if (action === 'retry') { if (s.state !== 'failed') throw new Invalid('Only a failed webhook can be retried'); s.state = 'waiting'; s.note = null; }
  else if (action === 'skip') { if (s.state === 'done' || s.state === 'fired') throw new Invalid('That step is already done'); s.state = 'skipped'; s.at = now(); s.note = 'Skipped by hand'; }
  else throw new Invalid('Action must be cancel, retry or skip');
  r.state = 'running'; r.finished = null; r.log.push({at: now(), text: `${action === 'retry' ? 'Retry' : 'Skipped'}: ${s.title}`});
  saveRun(tasks, r);
  return advance(tasks, runId);
}

/** Triggers: finished items (by tag or key), schedules, and keeping runs current when their tasks change. */
export function startBoards(tasks: Tasks) {
  migrateBoards(tasks);
  const justFinished = (item: Item, before: unknown, after: unknown) => {
    if (!item.completed) return false;
    const a = after as Record<string, unknown> | null, bf = before as Record<string, unknown> | null;
    if (a?.completed && !bf?.completed) return true;
    if (!a || !('status' in a) || !bf || typeof bf.status !== 'string') return false;
    try { return tasks.project(item.projectId).statuses.find(s => s.id === bf.status)?.category !== 'done'; } catch { return false; }
  };
  tasks.onLog(({kind, item, before, after}) => {
    if (kind !== 'update' && kind !== 'delete') return;
    for (const r of tasks.db.prepare("select id, steps from board_runs where state = 'running'").all() as {id: string; steps: string}[])
      if (j<Step[]>(r.steps, []).some(s => s.itemId === item.id)) { try { advance(tasks, r.id); } catch (e) { console.error('Board run update failed', (e as Error).message); } }
    if (kind === 'update' && justFinished(item, before, after) && !(item.fields.board) && !item.tags.includes('board-run')) completedTrigger(tasks, item);
  });
}
function completedTrigger(tasks: Tasks, item: Item) {
  let key = '';
  try { key = `${tasks.project(item.projectId).key}-${item.number}`.toLowerCase(); } catch { return; }
  for (const b of listBoards(tasks)) {
    const t = b.nodes.find(n => n.kind === 'trigger' && n.trigger?.on === 'completed' && n.trigger.tag &&
      (item.tags.some(x => x.toLowerCase() === n.trigger!.tag!.toLowerCase()) || n.trigger.tag.toLowerCase() === key));
    if (!t || !b.projectId) continue;
    try { runBoard(tasks, b.id, b.createdBy, {trigger: `finished ${key.toUpperCase()}`, input: {item: {id: item.id, key: key.toUpperCase(), title: item.title}}}); }
    catch (e) { console.error('Board trigger failed', b.name, (e as Error).message); }
  }
}
/** Hourly: boards with a schedule trigger start a run once per day, week or month. Also keeps running runs current. */
export function boardsPeriodic(tasks: Tasks) {
  migrateBoards(tasks);
  const today = tasks.today();
  for (const b of listBoards(tasks)) {
    const t = b.nodes.find(n => n.kind === 'trigger' && n.trigger?.on === 'schedule');
    if (!t || !b.projectId) continue;
    const last = b.lastScheduled, every = t.trigger!.every ?? 'week';
    const due = !last || (every === 'day' ? last < today : every === 'week' ? daysBetween(last, today) >= 7 : last.slice(0, 7) < today.slice(0, 7));
    if (!due) continue;
    tasks.db.prepare('update boards set last_scheduled = ? where id = ?').run(today, b.id);
    try { runBoard(tasks, b.id, b.createdBy, {trigger: `schedule (${every})`}); } catch (e) { console.error('Scheduled board run failed', b.name, (e as Error).message); }
  }
  for (const r of tasks.db.prepare("select id from board_runs where state = 'running'").all() as {id: string}[]) { try { advance(tasks, r.id); } catch { /* keep going */ } }
}
/** Inbound webhook: POST /api/hooks/<key> starts a run of the board with that key; the body is the run's input. */
export function boardByKey(tasks: Tasks, key: string): Board | null {
  migrateBoards(tasks);
  const r = tasks.db.prepare('select * from boards where hook_key = ?').get(key);
  return r ? toBoard(r) : null;
}
