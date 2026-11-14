// All reads and writes go through here: the HTTP API, MCP server and tests share it,
// so anything a person can do in the UI an agent can do too.
import {syncHours} from '../src/hours.ts';
import {exportAll} from './backup.ts';
import {getWorkspace} from './auth.ts';
import {personJobRoles} from './jobroles.ts';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import type {Db} from './db.ts';
import {addUnit, daysBetween, iso, monday, onWorkdays} from '../src/dates.ts';
import {PRIORITY_WORDS, parseQuickAdd} from '../src/quickadd.ts';
import {nextOccurrence} from '../src/recur.ts';
import {Invalid, NotFound} from './errors.ts';
export {Invalid, NotFound};
import * as planner from './planner.ts';
import * as ai from './aiwork.ts';
import * as approvals from './approvals.ts';
import * as boards from './boards.ts';
import * as dayplan from './dayplan.ts';
import {GALLERY, validatePack, type Node as PackNode, type Pack, checkTemplateData} from './packs.ts';
import {DATE_TRIGGERS, apply as applyRule, matches as ruleMatches, validateRules, type RuleContext, type RuleHost} from './automations.ts';
import {cleanHooks, cleanRuleSecrets, listDeliveries, queueHooks, saveWorkspaceHooks, workspaceHooks} from './webhooks.ts';
import {normalizeHook} from '../src/hooks.ts';
import {PRIORITIES} from '../src/types.ts';
import type {Activity, BurnPoint, InheritKey, ProjectSettings, Rule, Template, Trigger, ChangeEvent, Comment, FieldDef, Item, ItemPatch, Notification, Person, Project, Recur, Sprint, Status, TimeEntry, View, ViewConfig, ViewKind} from '../src/types.ts';

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];

export const DEFAULT_STATUSES: Status[] = [
  {id: 'todo', name: 'To do', category: 'todo', color: '#94a3b8'},
  {id: 'doing', name: 'In progress', category: 'doing', color: '#3b82f6'},
  {id: 'review', name: 'Review', category: 'doing', color: '#a855f7'},
  {id: 'done', name: 'Done', category: 'done', color: '#22c55e'},
];
// Azure-style levels, top to bottom. Projects can rename or add their own.
/** Levels a new space starts with, top to bottom (a space is a team or area; a Project is its biggest piece of work). */
export const DEFAULT_TYPES = ['Project', 'Phase', 'Task', 'Subtask'];
export const SOFTWARE_TYPES = ['Epic', 'Feature', 'Story', 'Task', 'Bug'];
export const DEFAULT_VIEWS: {name: string; kind: ViewKind; config?: ViewConfig}[] = [
  {name: 'List', kind: 'list'}, {name: 'Table', kind: 'table'}, {name: 'Board', kind: 'board'},
  {name: 'Timeline', kind: 'gantt', config: {zoom: 'week'}}, {name: 'Calendar', kind: 'calendar'}, {name: 'Backlog', kind: 'backlog'}, {name: 'Sprint', kind: 'sprint'},
];


const realDate = (d: string) => { const [y, m, dd] = d.split('-').map(Number); const t = new Date(y, m - 1, dd); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === dd; };
/** Server-side checks so bad values from the API, MCP or imports cannot break views. */
function validatePatch(p: ItemPatch, people: Set<string>, types: string[]) {
  if (p.title !== undefined) { if (typeof p.title !== 'string') throw new Invalid('Title must be text'); if (p.title.length > 500) throw new Invalid('Titles are limited to 500 characters'); }
  if (p.body !== undefined && (typeof p.body !== 'string' || p.body.length > 200_000)) throw new Invalid('Description must be text under 200,000 characters');
  if (p.priority !== undefined && !(Number.isInteger(p.priority) && p.priority >= 0 && p.priority <= 4)) throw new Invalid('Priority must be 0 to 4');
  if (p.estimate !== undefined && p.estimate !== null && !(typeof p.estimate === 'number' && Number.isFinite(p.estimate) && p.estimate >= 0 && p.estimate <= 10000)) throw new Invalid('Estimate must be hours between 0 and 10000');
  for (const k of ['start', 'due'] as const) {
    const v = p[k];
    if (v !== undefined && v !== null && !(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && realDate(v))) throw new Invalid(`${k === 'due' ? 'Due' : 'Start'} must be a real date like 2026-11-30`);
  }
  if (p.assignees !== undefined) {
    if (!Array.isArray(p.assignees) || p.assignees.length > 50) throw new Invalid('Assignees must be a list');
    for (const a of p.assignees) if (!people.has(a)) throw new Invalid(`Unknown person ${a}`);
    if (new Set(p.assignees).size !== p.assignees.length) p.assignees = [...new Set(p.assignees)];
  }
  if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.length > 50 || p.tags.some(t => typeof t !== 'string' || t.length > 60))) throw new Invalid('Tags must be a list of short words');
  if (p.type !== undefined && !types.includes(p.type)) throw new Invalid(`Type must be one of: ${types.join(', ')}`);
  if (p.fields !== undefined && (typeof p.fields !== 'object' || p.fields === null || Array.isArray(p.fields))) throw new Invalid('Fields must be an object');
  if (p.deps !== undefined && (!Array.isArray(p.deps) || p.deps.length > 100)) throw new Invalid('Dependencies must be a list');
  if (p.recur !== undefined && p.recur !== null) checkRecur(p.recur);
}
/** Repeat rules: every 1 to 1000 days, weeks, months or years, on schedule or after completion. */
export function checkRecur(r: unknown) {
  const x = r as Recur;
  if (!x || typeof x !== 'object') throw new Invalid('Repeat must be a rule like {every: 1, unit: "week"}');
  if (!Number.isInteger(x.every) || x.every < 1 || x.every > 1000) throw new Invalid('Repeat every must be a whole number from 1 to 1000');
  if (!['day', 'week', 'month', 'year'].includes(x.unit)) throw new Invalid('Repeat unit must be day, week, month or year');
  if (x.mode !== undefined && !['schedule', 'completion'].includes(x.mode)) throw new Invalid('Repeat mode must be schedule or completion');
  if (x.weekdays !== undefined && (!Array.isArray(x.weekdays) || x.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6))) throw new Invalid('Repeat weekdays must be numbers 0 (Sunday) to 6');
  if (x.count !== undefined && x.count !== null && (!Number.isInteger(x.count) || x.count < 1)) throw new Invalid('Repeat count must be 1 or more');
  if (x.until !== undefined && x.until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(x.until))) throw new Invalid('Repeat until must be a date like 2026-12-31');
  if (x.paused !== undefined && typeof x.paused !== 'boolean') throw new Invalid('Repeat paused must be true or false');
  if (x.waiting !== undefined && typeof x.waiting !== 'boolean') throw new Invalid('Repeat waiting must be true or false');
  if (x.slot !== undefined && x.slot !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(x.slot))) throw new Invalid('Repeat slot must be a date like 2026-12-31');
}
export const isColor = (c: unknown) => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c);
/** Field values must match their column kind, so bad API input cannot break views. */
function checkFieldValues(fields: Record<string, unknown>, defs: FieldDef[], selfId: string | null) {
  for (const f of defs) {
    const v = fields[f.id];
    if (v === undefined || v === null || v === '') continue;
    const bad = (what: string) => { throw new Invalid(`${f.name} must be ${what}`); };
    if (['number', 'money', 'rating'].includes(f.kind) && (typeof v !== 'number' || !Number.isFinite(v))) bad('a number');
    if (f.kind === 'rating' && ((v as number) < 1 || (v as number) > 5)) bad('1 to 5');
    if (f.kind === 'checkbox' && typeof v !== 'boolean') bad('true or false');
    if (f.kind === 'url' && !/^https?:\/\//i.test(String(v))) bad('a link starting with http:// or https://');
    if (f.kind === 'email' && !/^[^\s@]+@[^\s@]+$/.test(String(v))) bad('an email address');
    if (f.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) bad('a date like 2026-11-30');
    if (['multi', 'person', 'relation'].includes(f.kind) && (!Array.isArray(v) || v.some(x => typeof x !== 'string'))) bad('a list');
    if (f.kind === 'relation' && selfId && (v as string[]).includes(selfId)) bad('links to other items, not itself');
    if (['text', 'phone', 'email', 'select', 'url'].includes(f.kind) && (typeof v !== 'string' || v.length > 10000)) bad('text');
  }
}

type Row = Record<string, unknown>;
const j = <T>(s: unknown, fallback: T): T => (typeof s === 'string' && s ? JSON.parse(s) : fallback);
const now = () => new Date().toISOString();
const id = () => randomUUID().slice(0, 8) + randomUUID().slice(0, 4);

function toProject(r: Row): Project {
  return {
    id: r.id as string, name: r.name as string, key: r.key as string,
    statuses: j(r.statuses, []), types: j(r.types, []), fields: j(r.fields, []),
    sort: r.sort as number, created: r.created as string,
    settings: {...DEFAULT_SETTINGS, ...j(r.settings, {})},
  };
}

export const DEFAULT_SETTINGS: ProjectSettings = {inherit: ['sprint', 'assignees'], automations: [], webhooks: [], autoRollover: false};

function toItem(r: Row): Item {
  return {
    id: r.id as string, projectId: r.project_id as string, parentId: (r.parent_id as string) ?? null,
    number: r.number as number, type: r.type as string, title: r.title as string, body: r.body as string,
    status: r.status as string, priority: r.priority as number, assignees: j(r.assignees, []),
    start: (r.start as string) ?? null, due: (r.due as string) ?? null, estimate: (r.estimate as number) ?? null,
    tags: j(r.tags, []), sprint: (r.sprint as string) ?? null, sort: r.sort as number,
    recur: j(r.recur, null), fields: j(r.fields, {}), createdBy: (r.created_by as string) ?? null,
    created: r.created as string, updated: r.updated as string, completed: (r.completed as string) ?? null,
    deps: j(r.deps, []),
  };
}

/** Packs travel between organizations, so people ids are removed on export. */
function stripPeople(n: PackNode & {assignees?: string[]}): PackNode {
  const {assignees: _a, ...rest} = n; void _a;
  return {...rest, children: (n.children ?? []).map(stripPeople)};
}

/** Per-item state that must not be copied: AI review progress, external record ids, item links. */
const cleanFields = (f: Record<string, unknown>) => Object.fromEntries(Object.entries(f).filter(([k]) => !['review', 'ext', 'links', 'follow'].includes(k)));

/** The part of a view's settings that makes sense in another project: no sprint, baselines, lock or owner. */
export function portableViewConfig(c: ViewConfig): ViewConfig {
  const {sprint: _s, baselines: _b, baseline: _bl, privateTo: _p, locked: _l, ...rest} = c;
  return rest;
}

function toTime(r: Row): TimeEntry {
  return {id: r.id as string, itemId: r.item_id as string, person: r.person as string, start: r.start as string,
    end: (r.end as string) ?? null, minutes: (r.minutes as number) ?? null, note: (r.note as string) ?? null, kind: r.kind === 'review' ? 'review' : 'work'};
}

function toComment(r: Row): Comment {
  return {id: r.id as string, itemId: r.item_id as string, author: r.author as string, body: r.body as string, created: r.created as string, assignee: (r.assignee as string) ?? null, resolved: (r.resolved as string) ?? null};
}

function toSprint(r: Row): Sprint {
  return {id: r.id as string, projectId: r.project_id as string, name: r.name as string, start: r.start as string, end: r.end as string, goal: r.goal as string, capacity: j(r.capacity, {}), created: r.created as string};
}

function toView(r: Row): View {
  return {id: r.id as string, projectId: r.project_id as string, name: r.name as string, kind: r.kind as ViewKind, config: j(r.config, {}), sort: r.sort as number};
}

export type ItemQuery = {
  projectId?: string; assignee?: string; status?: string; parentId?: string | null;
  text?: string; dueBefore?: string; open?: boolean; limit?: number;
};

/** Something that happened, for webhooks (server/webhooks.ts). target sends it to one URL only: a rule's webhook action, or a test. */
export type HookEvent = {event: string; projectId?: string | null; project?: {id: string; key: string; name: string}; item?: Item | null; changes?: {before: unknown; after: unknown};
  actor?: string | null; details?: Record<string, unknown>; target?: {hook: string; scope: string; url: string; secretKey: string | null}};

export class Tasks {
  private listeners = new Set<(e: ChangeEvent) => void>();
  /** Folder for this workspace's uploaded files. */
  dataDir = dirname(process.env.TASKS_DB ?? 'data/tasks.db');
  constructor(readonly db: Db, readonly today: () => string = () => iso(new Date())) {}

  on(fn: (e: ChangeEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(e: ChangeEvent) { for (const fn of this.listeners) fn(e); }
  /** Id of this workspace, sent with webhook events. */
  workspace = 'main';
  private eventListeners = new Set<(e: HookEvent) => void>();
  onEvent(fn: (e: HookEvent) => void) { this.eventListeners.add(fn); return () => this.eventListeners.delete(fn); }
  /** The one place outside systems hear from: every event goes to the webhook queue. A problem here never breaks a save. */
  event(event: string, e: Omit<HookEvent, 'event'> = {}) {
    const ev = {event, ...e};
    try { queueHooks(this, ev); for (const fn of this.eventListeners) fn(ev); } catch (err) { console.error('Event failed', event, err); }
  }

  // People. No passwords yet: the UI picks who you are. Real auth is a later iteration.
  listPeople(): Person[] {
    return this.db.prepare('select * from people order by coalesce(sort, 1e9), name').all().map(r => ({id: r.id as string, name: r.name as string, email: (r.email as string) ?? null, color: r.color as string, kind: ((r.kind as string) === 'ai' ? 'ai' : 'human') as 'human' | 'ai', owner: (r.owner as string) ?? null}));
  }
  /** An AI agent is never the only one on a task: assigning an agent adds the person it belongs to. */
  withOwners(assignees: string[]) {
    if (!assignees.length) return assignees;
    const rows = this.db.prepare(`select owner from people where kind = 'ai' and owner is not null and id in (${assignees.map(() => '?').join(',')})`).all(...assignees) as {owner: string}[];
    const add = rows.map(r => r.owner).filter(o => !assignees.includes(o) && this.db.prepare('select 1 from people where id = ?').get(o));
    return add.length ? [...assignees, ...new Set(add)] : assignees;
  }
  /** Auto-job routines are run by AI agents: every person on one must be the owner of an assigned agent (they review).
   *  A workspace with no AI agents cannot automate, so there anyone (or no one) may be assigned. */
  checkAutoJob(tags: string[], assignees: string[]) {
    if (!tags.includes('auto-job') || !assignees.length) return;
    const people = new Map(this.listPeople().map(p => [p.id, p]));
    if (![...people.values()].some(p => p.kind === 'ai')) return;
    const agents = assignees.filter(a => people.get(a)?.kind === 'ai');
    const owners = new Set(agents.map(a => people.get(a)?.owner).filter(Boolean));
    const others = assignees.filter(a => people.get(a)?.kind !== 'ai' && !owners.has(a));
    if (!agents.length || others.length) throw new Invalid('Auto-job routines are run by an AI agent. Assign an AI agent (its owner is added to review), or change the mode to hybrid or manual to give it to a person.');
  }
  /** Puts people in the given order (pickers and sorting by assignee follow it). */
  reorderPeople(ids: string[]) {
    const set = this.db.prepare('update people set sort = ? where id = ?');
    ids.forEach((pid, n) => set.run(n, pid));
    this.emit({kind: 'people'});
    return this.listPeople();
  }
  person(pid: string) {
    const p = this.listPeople().find(p => p.id === pid);
    if (!p) throw new NotFound(`Person ${pid} not found`);
    return p;
  }
  createPerson(input: {name: string; email?: string | null}): Person {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Invalid('Name is required');
    const count = (this.db.prepare('select count(*) c from people').get() as Row).c as number;
    const p: Person = {id: id(), name, email: input.email ?? null, color: COLORS[count % COLORS.length]};
    this.db.prepare('insert into people (id,name,email,color) values (?,?,?,?)').run(p.id, p.name, p.email, p.color);
    this.emit({kind: 'people'});
    this.event('person.added', {details: {person: p}});
    return p;
  }

  // Projects
  listProjects(): Project[] {
    return this.db.prepare('select * from projects order by sort, created').all().map(toProject);
  }
  project(pid: string) {
    const r = this.db.prepare('select * from projects where id = ?').get(pid);
    if (!r) throw new NotFound(`Space ${pid} not found`);
    return toProject(r);
  }
  createProject(input: {name: string; key?: string; statuses?: Status[]; types?: string[]; fields?: FieldDef[]; settings?: Partial<ProjectSettings>; noViews?: boolean}): Project {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Invalid('Name is required');
    const base = (input.key || name.replace(/[^a-z]/gi, '').slice(0, 3) || 'PRJ').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'PRJ';
    // Keys must be unique so item keys like ABC-12 and [[links]] point at one project.
    const taken = new Set(this.listProjects().map(x => x.key));
    let key = base; for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 5)}${n}`;
    const max = (this.db.prepare('select coalesce(max(sort),0) m from projects').get() as Row).m as number;
    const p: Project = {
      id: id(), name, key, statuses: input.statuses ?? DEFAULT_STATUSES, types: input.types ?? DEFAULT_TYPES,
      fields: input.fields ?? [], sort: max + 1, created: now(), settings: {...DEFAULT_SETTINGS, ...input.settings},
    };
    this.db.prepare('insert into projects (id,name,key,statuses,types,fields,sort,created,settings) values (?,?,?,?,?,?,?,?,?)')
      .run(p.id, p.name, p.key, JSON.stringify(p.statuses), JSON.stringify(p.types), JSON.stringify(p.fields), p.sort, p.created, JSON.stringify(p.settings));
    if (!input.noViews) DEFAULT_VIEWS.forEach((v, n) => this.createView({projectId: p.id, name: v.name, kind: v.kind, config: v.config, sort: n}));
    this.emit({kind: 'project', project: p});
    this.event('project.created', {projectId: p.id});
    return p;
  }
  /** A project whose views show work from other projects together (All projects, or the ones chosen in its settings). */
  createRollup(name = 'All spaces') {
    const min = Math.min(0, ...this.listProjects().map(p => p.sort));
    const p = this.createProject({name, key: 'ALL', settings: {rollup: {include: null}}, noViews: true});
    ([['List', 'list'], ['Table', 'table'], ['Board', 'board'], ['Timeline', 'gantt'], ['Calendar', 'calendar'], ['Workload', 'workload']] as [string, ViewKind][])
      .forEach(([n, k], i) => this.createView({projectId: p.id, name: n, kind: k, config: k === 'gantt' ? {zoom: 'week'} : {}, sort: i}));
    return this.updateProject(p.id, {sort: min - 1});
  }
  /** Built-in spaces every workspace has: Routines (every repeating item) and Archive and later (parked and snoozed items).
   *  They work like rollups with the usual views, plus a Routines view. Made once; renaming is fine, deleting is not. */
  ensureSystemSpaces() {
    const made: Project[] = [];
    const spaces: [NonNullable<NonNullable<ProjectSettings['rollup']>['scope']>, string, string, string, [string, ViewKind, ViewConfig?][]][] = [
      ['routines', 'Routines', 'RTN', 'lucide:Repeat', [['Routines', 'routines'], ['Table', 'table'], ['Board', 'board', {groupBy: 'assignee'}], ['Timeline', 'gantt', {zoom: 'month'}], ['Calendar', 'calendar'], ['Workload', 'workload', {zoom: 'month'}], ['Whiteboard', 'whiteboard']]],
      ['parked', 'Archive and later', 'ARC', 'lucide:Archive', [['Table', 'table'], ['List', 'list'], ['Board', 'board', {groupBy: 'assignee'}]]],
    ];
    for (const [scope, name, key0, icon, views] of spaces) {
      if (this.listProjects().some(p => p.settings.rollup?.scope === scope)) continue;
      const used = new Set(this.listProjects().flatMap(p => [p.key.toUpperCase(), ...(p.settings.oldKeys ?? [])]));
      let key = key0; for (let n = 2; used.has(key); n++) key = key0 + n;
      const max = Math.max(0, ...this.listProjects().map(p => p.sort));
      const p = this.createProject({name, key, settings: {rollup: {include: null, scope}, icon}, noViews: true});
      views.forEach(([n, k, config], i) => this.createView({projectId: p.id, name: n, kind: k, config: config ?? {}, sort: i}));
      made.push(this.updateProject(p.id, {sort: max + 1}));
    }
    // Routines spaces made before whiteboards get a Whiteboard view, once (deleting it is respected).
    const rt = this.listProjects().find(p => p.settings.rollup?.scope === 'routines');
    try {
      if (rt && !this.db.prepare("select 1 from workspace where key = 'routines-whiteboard'").get()) {
        if (!this.listViews(rt.id).some(v => v.kind === 'whiteboard')) this.createView({projectId: rt.id, name: 'Whiteboard', kind: 'whiteboard', config: {}});
        this.db.prepare("insert into workspace (key, value) values ('routines-whiteboard', '1') on conflict(key) do nothing").run();
      }
    } catch { /* no workspace table yet (tests without auth) */ }
    return made;
  }
  updateProject(pid: string, patch: Partial<Pick<Project, 'name' | 'key' | 'statuses' | 'types' | 'fields' | 'sort' | 'settings'>>): Project {
    const cur = this.project(pid);
    const p = {...cur, ...patch, settings: {...cur.settings, ...patch.settings}};
    if (patch.key !== undefined) {
      p.key = String(p.key).toUpperCase();
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(p.key)) throw new Invalid('A space key is 2 to 10 letters or digits, starting with a letter, like GEN');
      if (this.listProjects().some(x => x.id !== pid && (x.key.toUpperCase() === p.key || (x.settings.oldKeys ?? []).includes(p.key)))) throw new Invalid(`Key ${p.key} is already used by another space`);
      // Old keys keep working in links and searches (NT-12 still finds GEN-12).
      if (p.key !== cur.key) p.settings = {...p.settings, oldKeys: [...new Set([...((cur.settings.oldKeys ?? [])), cur.key])].filter(k => k !== p.key)};
    }
    if (patch.name !== undefined && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 200)) throw new Invalid('Space names need 1 to 200 characters');
    if (patch.name !== undefined) p.name = p.name.trim();
    if (patch.sort !== undefined && !Number.isFinite(p.sort)) throw new Invalid('Sort must be a number');
    if (p.settings.color !== undefined && p.settings.color !== null && !isColor(p.settings.color)) throw new Invalid('Color must look like #10b981');
    if (p.settings.icon !== undefined && p.settings.icon !== null && (typeof p.settings.icon !== 'string' || p.settings.icon.length > 40)) throw new Invalid('Icons are an emoji or a short icon name');
    if (p.statuses.some(s => !isColor(s.color))) throw new Invalid('Status colors must look like #10b981');
    if (!p.statuses.length) throw new Invalid('A space needs at least one status');
    if (!p.statuses.some(s => s.category === 'done')) throw new Invalid('A space needs at least one status in the Done group');
    if (new Set(p.types).size !== p.types.length || !p.types.length) throw new Invalid('Item types must be unique and not empty');
    // Rules and endpoints are checked when they change. Their secrets move out of the settings, which every viewer of the space can read.
    if (patch.settings?.automations !== undefined && JSON.stringify(patch.settings.automations) !== JSON.stringify(cur.settings.automations)) {
      validateRules(p.settings.automations, p, new Set(this.listPeople().map(x => x.id)));
      p.settings = {...p.settings, automations: cleanRuleSecrets(this.db, p.settings.automations)};
    }
    if (patch.settings?.webhooks !== undefined && JSON.stringify(patch.settings.webhooks) !== JSON.stringify(cur.settings.webhooks))
      p.settings = {...p.settings, webhooks: cleanHooks(this.db, p.settings.webhooks, cur.settings.webhooks)};
    this.db.prepare('update projects set name=?, key=?, statuses=?, types=?, fields=?, sort=?, settings=? where id=?')
      .run(p.name, p.key, JSON.stringify(p.statuses), JSON.stringify(p.types), JSON.stringify(p.fields), p.sort, JSON.stringify(p.settings), pid);
    this.emit({kind: 'project', project: p});
    this.event('project.updated', {projectId: pid, details: {changed: Object.keys(patch)}});
    return p;
  }
  deleteProject(pid: string) {
    const gone = this.project(pid);
    if (gone.settings.rollup?.scope) throw new Invalid('Routines and Archive and later are built in and always there. Rename them if you like.');
    this.db.prepare('delete from projects where id = ?').run(pid);
    this.emit({kind: 'project-deleted', id: pid});
    if (!gone.settings.access?.private) this.event('project.deleted', {project: {id: gone.id, key: gone.key, name: gone.name}});
  }

  // Items
  listItems(q: ItemQuery = {}): Item[] {
    const where: string[] = [], args: (string | number | null)[] = [];
    if (q.projectId) { where.push('project_id = ?'); args.push(q.projectId); }
    if (q.assignee) { where.push('exists (select 1 from json_each(assignees) where value = ?)'); args.push(q.assignee); }
    if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.parentId !== undefined) { where.push(q.parentId === null ? 'parent_id is null' : 'parent_id = ?'); if (q.parentId !== null) args.push(q.parentId); }
    if (q.text) { where.push('(title like ? or body like ?)'); args.push(`%${q.text}%`, `%${q.text}%`); }
    if (q.dueBefore) { where.push('due is not null and due <= ?'); args.push(q.dueBefore); }
    if (q.open) {
      // Open work: not done, not a paused or waiting routine, not archived, not snoozed past today.
      where.push("completed is null and coalesce(json_extract(recur, '$.paused'), 0) = 0 and coalesce(json_extract(recur, '$.waiting'), 0) = 0 and json_extract(fields, '$.archived') is null and coalesce(json_extract(fields, '$.snooze'), '') <= ?");
      args.push(this.today());
    }
    const sql = `select * from items ${where.length ? 'where ' + where.join(' and ') : ''} order by sort limit ${Math.min(q.limit ?? 5000, 5000)}`;
    return this.db.prepare(sql).all(...args).map(toItem);
  }
  item(iid: string) {
    const r = this.db.prepare('select * from items where id = ?').get(iid);
    if (!r) throw new NotFound(`Item ${iid} not found`);
    return toItem(r);
  }
  /** Accepts an id or a key like "WEB-12". */
  findItem(ref: string) {
    if (typeof ref !== 'string' || !ref) throw new NotFound('Item not found');
    const m = /^([a-z]+)-(\d+)$/i.exec(ref);
    if (m) {
      const r = this.db.prepare('select i.* from items i join projects p on p.id = i.project_id where upper(p.key) = ? and i.number = ?').get(m[1].toUpperCase(), Number(m[2]))
        ?? this.db.prepare("select i.* from items i join projects p on p.id = i.project_id where exists (select 1 from json_each(json_extract(p.settings, '$.oldKeys')) where upper(value) = ?) and i.number = ?").get(m[1].toUpperCase(), Number(m[2]));
      if (r) return toItem(r);
    }
    return this.item(ref);
  }

  createItem(input: ItemPatch & {projectId: string; title: string}, actor: string | null = null, opts: {system?: boolean} = {}): Item {
    const p = this.project(input.projectId);
    validatePatch(input, new Set(this.listPeople().map(x => x.id)), p.types);
    if (input.start && input.due && input.start > input.due) throw new Invalid('Start must be on or before due');
    const title = String(input.title).trim();
    if (!title) throw new Invalid('Title is required');
    if (p.settings.rollup) {
      const inc = p.settings.rollup.include;
      const names = this.listProjects().filter(x => !x.settings.rollup && (!inc || inc.includes(x.id))).map(x => `${x.name} (${x.key})`);
      throw new Invalid(`${p.name} shows work from other spaces and holds none itself. Add the item to one of these: ${names.join(', ') || 'no spaces yet'}.`);
    }
    if (input.parentId) input = this.inherit(p, input);
    const status = input.status ?? p.statuses.find(s => s.category === 'todo')?.id ?? p.statuses[0].id;
    this.checkStatus(p, status);
    if (this.isAi(actor)) {
      if (p.statuses.find(s => s.id === status)?.category === 'done' && !p.settings.aiMayComplete) throw new Invalid('AI agents cannot create work that is already done. A person approves it.');
      if (input.fields?.review) throw new Invalid('AI agents set review state only through claim_task and submit_work.');
    }
    if (input.fields) checkFieldValues(input.fields, p.fields, null);
    const max = this.db.prepare('select coalesce(max(number),0) n, coalesce(max(sort),0) s from items where project_id = ?').get(p.id) as Row;
    const t = now();
    const item: Item = {
      id: id(), projectId: p.id, parentId: input.parentId ?? null, number: (max.n as number) + 1,
      type: input.type ?? (p.types.includes('Task') ? 'Task' : p.types[0] ?? 'Task'), title, body: input.body ?? '', status,
      priority: input.priority ?? 0, assignees: this.withOwners(input.assignees ?? []), start: input.start ?? null, due: input.due ?? null,
      estimate: input.estimate ?? null, tags: input.tags ?? [], sprint: input.sprint ?? null,
      sort: input.sort ?? (max.s as number) + 1, recur: input.recur ?? null, fields: input.fields ?? {},
      createdBy: actor, created: t, updated: t, deps: input.deps ?? [],
      completed: p.statuses.find(s => s.id === status)?.category === 'done' ? t : null,
    };
    Object.assign(item, syncHours(item));
    if (item.parentId) this.item(item.parentId);
    if (item.sprint) this.sprint(item.sprint);
    for (const d of item.deps) this.item(d);
    if (!opts.system) this.checkAutoJob(item.tags, item.assignees);
    this.db.prepare(`insert into items (id,project_id,parent_id,number,type,title,body,status,priority,assignees,start,due,estimate,tags,sprint,sort,recur,fields,created_by,created,updated,completed,deps)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      item.id, item.projectId, item.parentId, item.number, item.type, item.title, item.body, item.status, item.priority,
      JSON.stringify(item.assignees), item.start, item.due, item.estimate, JSON.stringify(item.tags), item.sprint, item.sort,
      item.recur ? JSON.stringify(item.recur) : null, JSON.stringify(item.fields), item.createdBy, item.created, item.updated, item.completed, JSON.stringify(item.deps));
    this.emit({kind: 'item', item});
    this.log('create', actor, item, null, item);
    this.fire({kind: 'created'}, item);
    for (const a of item.assignees) this.notify(a, actor, item.id, 'assigned', `assigned you ${p.key}-${item.number}: ${item.title}`);
    this.assigned(item.assignees, actor, item);
    return item;
  }

  quickAdd(input: {projectId: string; text: string; parentId?: string | null; status?: string; sort?: number; sprint?: string | null}, actor: string | null = null) {
    const p = this.project(input.projectId);
    const parsed = parseQuickAdd(input.text, this.listPeople(), this.today(), p.types);
    if (!parsed.title) throw new Invalid('Title is required');
    return this.createItem({
      projectId: p.id, parentId: input.parentId ?? null, status: input.status, sort: input.sort,
      title: parsed.title, assignees: parsed.assignees, priority: parsed.priority, tags: parsed.tags,
      due: parsed.due, start: parsed.start, estimate: parsed.estimate, recur: parsed.recur, type: parsed.type,
      sprint: parsed.sprint ? this.resolveSprint(p.id, parsed.sprint) : input.sprint ?? undefined,
    }, actor);
  }

  /** A person can set when done work was finished (to fix work marked done late). Date-only values mean midday UTC. */
  private checkCompleted(v: unknown, isDone: boolean, created: string, actor: string | null) {
    if (this.isAi(actor)) throw new Invalid('AI agents cannot change when work was completed. A person does that.');
    if (v === null) { if (isDone) throw new Invalid('Done work needs a completed date. Reopen it to clear the date.'); return null; }
    if (!isDone) throw new Invalid('Only done work has a completed date. Mark it done first.');
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(v)) throw new Invalid('Completed must be a date like 2026-11-30 or a time like 2026-11-30T15:00:00Z');
    // A bare date means midday, or now when that date is today and midday has not come yet.
    const t = v.length === 10 ? new Date(v === new Date().toISOString().slice(0, 10) ? Math.min(Date.parse(v + 'T12:00:00Z'), Date.now()) : Date.parse(v + 'T12:00:00Z')) : new Date(v);
    if (Number.isNaN(t.getTime())) throw new Invalid('Completed must be a real date');
    if (t.getTime() > Date.now() + 60_000) throw new Invalid('Completed cannot be in the future');
    if (t.toISOString().slice(0, 10) < created.slice(0, 10)) throw new Invalid('Completed cannot be before the item was created');
    return t.toISOString();
  }
  private isAi(actor: string | null) { return !!actor && (this.db.prepare('select kind from people where id = ?').get(actor) as {kind?: string} | undefined)?.kind === 'ai'; }
  /** opts.system: the review tools changing review state. opts.keep: change dates without moving followers. */
  updateItem(iid: string, patch: ItemPatch, actor: string | null = null, opts: {system?: boolean; keep?: boolean} = {}): Item {
    const before = this.item(iid);
    if (!opts.system && patch.fields && JSON.stringify(patch.fields.review ?? null) !== JSON.stringify(before.fields.review ?? null) && this.isAi(actor))
      throw new Invalid('AI agents change review state only through claim_task and submit_work; a person accepts and approves.');
    const p = this.project(patch.projectId ?? before.projectId);
    const next: Item = {...before, ...patch, updated: now()};
    if (patch.title !== undefined && !next.title.trim()) throw new Invalid('Title is required');
    if (patch.projectId && patch.projectId !== before.projectId) {
      if (!p.statuses.some(s => s.id === next.status)) next.status = p.statuses[0].id;
      next.number = ((this.db.prepare('select coalesce(max(number),0) n from items where project_id = ?').get(p.id) as Row).n as number) + 1;
      next.parentId = null;
    }
    this.checkStatus(p, next.status);
    if (next.parentId) this.checkParent(iid, next.parentId);
    if (patch.sprint) this.sprint(patch.sprint);
    if (patch.deps) this.checkDeps(iid, next.deps);
    validatePatch(patch, new Set(this.listPeople().map(x => x.id)), p.types);
    if (patch.fields) checkFieldValues(patch.fields, p.fields, iid);
    next.assignees = [...new Set(next.assignees)];
    if (patch.assignees !== undefined) next.assignees = this.withOwners(next.assignees);
    if (patch.assignees !== undefined || patch.tags !== undefined) this.checkAutoJob(next.tags, next.assignees);
    if ((patch.start !== undefined || patch.due !== undefined) && next.start && next.due && next.start > next.due) throw new Invalid('Start must be on or before due');
    const wasDone = before.completed !== null;
    const isDone = p.statuses.find(s => s.id === next.status)?.category === 'done';
    if (patch.status !== undefined && patch.status !== before.status) this.checkWorkflow(p, before, next, isDone && !wasDone, actor);
    if (isDone && !wasDone && actor && !p.settings.aiMayComplete && (this.db.prepare('select kind from people where id = ?').get(actor) as {kind?: string} | undefined)?.kind === 'ai')
      throw new Invalid('AI agents cannot mark work done here. Submit it for review (submit_work) and a person will approve it.');
    next.completed = isDone ? (before.completed ?? now()) : null;
    if (patch.completed !== undefined) next.completed = this.checkCompleted(patch.completed, isDone, next.created, actor);
    // Per-person hours follow the assignees (removed people drop out) and set the estimate.
    Object.assign(next, syncHours(next));

    this.db.prepare(`update items set project_id=?, parent_id=?, number=?, type=?, title=?, body=?, status=?, priority=?, assignees=?, start=?, due=?,
      estimate=?, tags=?, sprint=?, sort=?, recur=?, fields=?, updated=?, completed=?, deps=? where id=?`).run(
      next.projectId, next.parentId, next.number, next.type, next.title, next.body, next.status, next.priority, JSON.stringify(next.assignees),
      next.start, next.due, next.estimate, JSON.stringify(next.tags), next.sprint, next.sort, next.recur ? JSON.stringify(next.recur) : null,
      JSON.stringify(next.fields), next.updated, next.completed, JSON.stringify(next.deps), iid);
    this.emit({kind: 'item', item: next});
    const changed = (Object.keys(patch) as (keyof Item)[]).filter(k => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
    if (changed.length && !(changed.length === 1 && changed[0] === 'sort'))
      this.log('update', actor, next, Object.fromEntries(changed.map(k => [k, before[k]])), Object.fromEntries(changed.map(k => [k, next[k]])));

    // Done and reopened follow the status, so they are not among the changed fields above.
    if (wasDone !== !!isDone) this.event(isDone ? 'item.completed' : 'item.reopened', {projectId: next.projectId, item: next, actor, changes: {before: {status: before.status, completed: before.completed}, after: {status: next.status, completed: next.completed}}});
    if (!opts.keep) this.shiftFollowers(before, next, actor);
    const ref = `${p.key}-${next.number}`;
    for (const a of next.assignees.filter(a => !before.assignees.includes(a)))
      this.notify(a, actor, iid, 'assigned', `assigned you ${ref}: ${next.title}`);
    this.assigned(next.assignees.filter(a => !before.assignees.includes(a)), actor, next);
    if (!wasDone && isDone) {
      for (const who of this.watchers(next)) this.notify(who, actor, iid, 'completed', `completed ${ref}: ${next.title}`);
      this.spawnRecurrence(next, p, actor);
      this.releaseWaiting(iid, actor);
    }
    if (before.status !== next.status) this.fire({kind: 'status', to: next.status}, this.item(iid));
    if (!wasDone && isDone) this.fire({kind: 'completed'}, this.item(iid));
    if (next.assignees.some(a => !before.assignees.includes(a))) this.fire({kind: 'assigned'}, this.item(iid));
    if (before.assignees.some(a => !next.assignees.includes(a))) this.fire({kind: 'unassigned'}, this.item(iid));
    const reviewState = (i: Item) => (i.fields.review as {state?: string} | undefined)?.state;
    if (reviewState(next) && reviewState(next) !== reviewState(before)) this.fire({kind: 'review', to: reviewState(next)!}, this.item(iid));
    return this.item(iid);
  }

  /**
   * Dynamic dates. Subitems set to move with their parent (fields.follow = 'parent') keep their spacing when the
   * parent's dates move; steps set to follow the step before them (fields.follow = 'previous', with a dependency)
   * move by as much as that step's due date moved. Anything else keeps its own fixed dates.
   */
  private shiftFollowers(before: Item, next: Item, actor: string | null) {
    const a = before.start ?? before.due, b = next.start ?? next.due;
    const delta = a && b ? daysBetween(a, b) : 0;
    const dueDelta = before.due && next.due ? daysBetween(before.due, next.due) : 0;
    if (!delta && !dueDelta) return;
    const rules = this.project(next.projectId).settings.dates ?? {};
    const move = (i: Item, d: number) => {
      if (!d || i.completed || !(i.start || i.due)) return;
      const s0 = i.start ? addUnit(i.start, d, 'day') : null, d0 = i.due ? addUnit(i.due, d, 'day') : null;
      // Saturday and Sunday roll to Monday when the project skips weekends, keeping the length.
      const [start, due] = onWorkdays(rules.skipWeekends, s0, d0, true);
      this.updateItem(i.id, {...(start ? {start} : {}), ...(due ? {due} : {})}, actor);
    };
    if (delta) for (const c of this.listItems({parentId: next.id})) if (c.fields.follow === 'parent') move(c, delta);
    if (dueDelta) for (const r of this.db.prepare('select * from items where deps like ?').all(`%${next.id}%`)) {
      const f = toItem(r);
      if (f.fields.follow !== 'previous' || !f.deps.includes(next.id)) continue;
      if (rules.shift === 'overlap') {
        // Only push later when the step would now start before this one ends; never pull it earlier.
        const s0 = f.start ?? f.due;
        if (s0 && next.due && s0 <= next.due) move(f, daysBetween(s0, next.due) + 1);
      } else move(f, dueDelta);
    }
  }

  deleteItem(iid: string, actor: string | null = null) {
    const item = this.item(iid);
    const ids = [iid, ...this.descendants(iid)];
    const snapshot = ids.map(x => this.item(x));
    const comments = this.db.prepare(`select * from comments where item_id in (${ids.map(() => '?').join(',')})`).all(...ids);
    const incoming = this.listItems({}).filter(i => !ids.includes(i.id) && i.deps.some(d => ids.includes(d))).map(i => ({id: i.id, deps: i.deps.filter(d => ids.includes(d))}));
    this.log('delete', actor, item, {items: snapshot, comments, incoming}, null);
    for (const x of ids) this.db.prepare('delete from items where id = ?').run(x);
    for (const r of this.db.prepare("select * from items where deps != '[]'").all()) {
      const it = toItem(r), left = it.deps.filter(d => !ids.includes(d));
      if (left.length !== it.deps.length) { this.db.prepare('update items set deps = ? where id = ?').run(JSON.stringify(left), it.id); this.emit({kind: 'item', item: {...it, deps: left}}); }
    }
    for (const x of ids) this.emit({kind: 'item-deleted', id: x, projectId: item.projectId});
    return {deleted: ids.length};
  }

  private descendants(iid: string): string[] {
    const kids = this.db.prepare('select id from items where parent_id = ?').all(iid).map(r => r.id as string);
    return kids.flatMap(k => [k, ...this.descendants(k)]);
  }
  private checkStatus(p: Project, status: string) {
    if (!p.statuses.some(s => s.id === status)) throw new Invalid(`Status "${status}" is not in space ${p.key}. Valid: ${p.statuses.map(s => s.id).join(', ')}`);
  }
  private checkParent(iid: string, parentId: string) {
    if (parentId === iid || this.descendants(iid).includes(parentId)) throw new Invalid('An item cannot be nested under itself');
    this.item(parentId);
  }
  /** Rules per item type (Settings, Workflow). Applies to people, the API and AI alike. */
  private checkWorkflow(p: Project, before: Item, next: Item, closing: boolean, actor: string | null) {
    const rule = p.settings.workflow?.[next.type];
    if (!rule) return;
    const name = (sid: string) => p.statuses.find(s => s.id === sid)?.name ?? sid;
    const allowed = rule.transitions?.[before.status];
    if (allowed && !allowed.includes(next.status))
      throw new Invalid(`${next.type} items cannot move from ${name(before.status)} to ${name(next.status)}. Allowed: ${allowed.map(name).join(', ') || 'none'}.`);
    if (!closing) return;
    const missing = (rule.required ?? []).filter(k => {
      const v = k.startsWith('f:') ? next.fields[k.slice(2)] : (next as Record<string, unknown>)[k];
      return v == null || v === '' || (Array.isArray(v) && !v.length);
    });
    if (missing.length) {
      const label = (k: string) => k.startsWith('f:') ? p.fields.find(f => f.id === k.slice(2))?.name ?? k : ({assignees: 'an owner', due: 'a due date', start: 'a start date', estimate: 'an estimate', body: 'a description'} as Record<string, string>)[k] ?? k;
      throw new Invalid(`Before closing this ${next.type}, add ${missing.map(label).join(', ')}.`);
    }
    if (rule.humansOnly && actor && (this.db.prepare('select kind from people where id = ?').get(actor) as {kind?: string} | undefined)?.kind === 'ai')
      throw new Invalid(`Only people can close ${next.type} items.`);
    if (rule.requireApproval) {
      const st = approvals.approvalState(this, next.id);
      if (!st || !st.complete) throw new Invalid(`${next.type} items need every requested approval signed before they close. ${st ? `${st.pending} still pending.` : 'Request approval first.'}`);
      if (st.changedSinceSigning) throw new Invalid('This item changed after it was signed. Ask the approvers to sign again.');
    }
  }
  private checkDeps(iid: string, deps: string[]) {
    // Reject self links and loops: walk what each new blocker is itself blocked by.
    const seen = new Set<string>();
    const walk = (x: string): boolean => {
      if (x === iid) return true;
      if (seen.has(x)) return false;
      seen.add(x);
      return this.item(x).deps.some(walk);
    };
    if (deps.some(walk)) throw new Invalid('That dependency would create a loop');
  }
  private watchers(item: Item) {
    return [...new Set([...item.assignees, ...(item.createdBy ? [item.createdBy] : [])])];
  }

  // Recurring: completing an item with `recur` creates the next one once.
  private spawnRecurrence(done: Item, p: Project, actor: string | null) {
    const r = done.recur;
    if (!r || r.spawned) return;
    const sched = r.slot ?? done.due;
    const base = r.mode === 'completion' || !sched ? this.today() : sched;
    const due = nextOccurrence(r, base, sched ?? base);
    if ((r.until && due > r.until) || (r.count != null && r.count <= 0)) { this.event('routine.ended', {projectId: p.id, item: done, actor, details: {reason: r.until && due > r.until ? 'until' : 'count'}}); return; }
    const start = done.start && done.due ? addUnit(done.start, daysBetween(done.due, due), 'day') : null;
    const {spawned: _s, slot: _sl, waiting: _w, ...rule} = r;
    void _s; void _sl; void _w;
    const nextRule: Recur | null = r.count != null ? (r.count - 1 > 0 ? {...rule, count: r.count - 1} : null) : rule;
    const todo = p.statuses.find(s => s.category === 'todo')?.id ?? p.statuses[0].id;
    if (r.reopen) {
      // Same item comes back: new dates, back to To do.
      this.db.prepare('update items set status = ?, completed = null, due = ?, start = ?, recur = ?, updated = ? where id = ?')
        .run(todo, due, start, nextRule ? JSON.stringify(nextRule) : null, now(), done.id);
      const back = this.item(done.id);
      this.emit({kind: 'item', item: back});
      this.event('item.reopened', {projectId: p.id, item: back, actor});
      this.event('routine.spawned', {projectId: p.id, item: back, actor, details: {reopened: true, previousDue: done.due}});
      return;
    }
    const next = this.createItem({
      projectId: p.id, parentId: done.parentId, type: done.type, title: done.title, body: done.body,
      priority: done.priority, assignees: done.assignees, tags: done.tags, estimate: done.estimate,
      fields: cleanFields(done.fields), sprint: done.sprint, due, start, recur: nextRule,
    }, actor, {system: true});
    if (r.copySubitems) for (const c of this.listItems({parentId: done.id}))
      this.createItem({projectId: p.id, parentId: next.id, type: c.type, title: c.title, body: c.body, priority: c.priority, assignees: c.assignees, tags: c.tags, estimate: c.estimate, fields: c.fields}, actor, {system: true});
    this.db.prepare('update items set recur = ? where id = ?').run(JSON.stringify({...r, spawned: next.id}), done.id);
    this.emit({kind: 'item', item: this.item(done.id)});
    this.event('routine.spawned', {projectId: p.id, item: this.item(next.id), actor, details: {reopened: false, from: done.id}});
  }

  /** Routines: open items that repeat, paused ones included. One live copy each; the next is made when it is finished. */
  listRoutines(): Item[] {
    return this.listItems({}).filter(i => i.recur && !i.recur.spawned && !i.completed);
  }
  /**
   * Turn a routine on or off without losing its history.
   * skip: move this copy to the next date. pause: hide it from views, sprints and plans. resume: show it again on
   * its next date from today. end: stop repeating; this copy stays as a normal task.
   */
  routine(ref: string, action: 'skip' | 'pause' | 'resume' | 'end' | 'delay' | 'wait', actor: string | null = null, opts: {to?: string; on?: string[]} = {}): Item {
    const it = this.findItem(ref), r = it.recur;
    if (!r || r.spawned || it.completed) throw new Invalid(`${it.title} is not an open repeating item`);
    const shift = (due: string) => it.start && it.due ? addUnit(it.start, daysBetween(it.due, due), 'day') : it.start;
    const anchor = it.due ?? this.today();
    const tell = (event: string, out: Item, details: Record<string, unknown> = {}) => { this.event(event, {projectId: out.projectId, item: out, actor, details}); return out; };
    if (action === 'pause') return this.updateItem(it.id, {recur: {...r, paused: true}, sprint: null}, actor);
    if (action === 'delay') {
      // Push only this copy. The next one is still counted from the date this one was scheduled for.
      if (!opts.to || !/^\d{4}-\d{2}-\d{2}$/.test(opts.to)) throw new Invalid('Delay needs a date like 2026-12-04');
      const slot = r.slot ?? it.due;
      return this.updateItem(it.id, {due: opts.to, start: shift(opts.to), recur: {...r, slot: opts.to === slot ? null : slot}}, actor, {keep: true});
    }
    if (action === 'wait') {
      // Start only after other work is done (a hire, a W-2 setup). Hidden until then; starts by itself.
      const on = (opts.on ?? []).map(x => this.findItem(x).id);
      if (!on.length) throw new Invalid('Wait needs the items it waits on');
      const open = on.filter(d => !this.item(d).completed);
      const deps = [...new Set([...it.deps, ...on])];
      const out = this.updateItem(it.id, {deps, recur: open.length ? {...r, waiting: true} : {...r, waiting: false}, sprint: open.length ? null : it.sprint}, actor, {keep: true});
      return open.length ? tell('routine.waiting', out, {waitingOn: open}) : out;
    }
    if (action === 'end') return tell('routine.ended', this.updateItem(it.id, {recur: null}, actor), {reason: 'ended'});
    if (action === 'resume') {
      const {paused: _p, waiting: _w, slot: _sl, ...rule} = r; void _p; void _w; void _sl;
      let due = it.due;
      for (let n = 0; due && due < this.today() && n < 5000; n++) due = nextOccurrence(rule, due, anchor);
      if (due && rule.until && due > rule.until) return tell('routine.ended', this.updateItem(it.id, {recur: null, due}, actor), {reason: 'until'});
      const out = tell('routine.resumed', this.updateItem(it.id, {recur: rule, due, start: due ? shift(due) : it.start}, actor), {reason: r.waiting ? 'wait-ended-by-hand' : 'resumed'});
      this.fire({kind: 'routine-resumed'}, out);
      return this.item(it.id);
    }
    if (action !== 'skip') throw new Invalid('Action must be skip, pause, resume or end');
    const sched = r.slot ?? anchor;
    let due = nextOccurrence(r, sched, sched);
    for (let n = 0; due <= anchor && n < 500; n++) due = nextOccurrence(r, due, sched);
    if (r.until && due > r.until) throw new Invalid('That was the last one. End the routine instead.');
    if (r.count != null && r.count <= 1) throw new Invalid('That was the last one. End the routine instead.');
    const {slot: _sl, ...kept} = r; void _sl;
    return tell('routine.skipped', this.updateItem(it.id, {due, start: shift(due), recur: r.count != null ? {...kept, count: r.count - 1} : kept}, actor), {from: anchor, to: due});
  }
  /** When work finishes, start the routines that were waiting only on it. Their first date is the next one from today. */
  private releaseWaiting(doneId: string, actor: string | null) {
    const waiting = this.db.prepare("select id from items where completed is null and json_extract(recur, '$.waiting') = 1 and exists (select 1 from json_each(deps) where value = ?)").all(doneId) as {id: string}[];
    for (const {id: wid} of waiting) {
      const w = this.item(wid);
      if (w.deps.some(d => { try { return !this.item(d).completed; } catch { return false; } })) continue;
      const {waiting: _w, ...rule} = w.recur!; void _w;
      let due = w.due;
      for (let n = 0; due && due < this.today() && n < 5000; n++) due = nextOccurrence(rule, due, w.due!);
      this.updateItem(wid, {recur: rule, due: due ?? this.today()}, actor, {system: true, keep: true});
      for (const a of w.assignees) this.notify(a, actor, wid, 'assigned', `routine started (what it waited on is done): ${w.title}`);
      // Told at once, so an outside system or a rule can act the moment the wait is over.
      const started = this.item(wid);
      this.event('routine.resumed', {projectId: started.projectId, item: started, actor, details: {reason: 'wait-over', releasedBy: doneId}});
      this.fire({kind: 'routine-resumed'}, started);
    }
  }

  // Archive and snooze: park ideas and rejected work out of every list without deleting it.
  archiveItem(ref: string, opts: {reason?: string; kind?: 'parked' | 'rejected' | 'idea'} = {}, actor: string | null = null): Item {
    const it = this.findItem(ref);
    const archived = {on: this.today(), by: actor, kind: opts.kind ?? 'parked', reason: (opts.reason ?? '').slice(0, 1000)};
    return this.updateItem(it.id, {fields: {...it.fields, archived}, sprint: null}, actor, {keep: true});
  }
  restoreItem(ref: string, actor: string | null = null): Item {
    const it = this.findItem(ref);
    const {archived: _a, snooze: _s, ...fields} = it.fields; void _a; void _s;
    return this.updateItem(it.id, {fields}, actor, {keep: true});
  }
  /** Hide until a date, then it comes back to its list. Null brings it back now. */
  snoozeItem(ref: string, until: string | null, actor: string | null = null): Item {
    const it = this.findItem(ref);
    if (until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Invalid('Snooze needs a date like 2027-03-01');
    const {snooze: _s, ...rest} = it.fields; void _s;
    return this.updateItem(it.id, {fields: until ? {...rest, snooze: until} : rest, sprint: until ? null : it.sprint}, actor, {keep: true});
  }
  /** Archived and snoozed items, newest first. */
  listParked(): Item[] {
    return this.listItems({}).filter(i => i.fields.archived || (typeof i.fields.snooze === 'string' && i.fields.snooze > this.today()))
      .sort((a, b) => String((b.fields.archived as {on?: string})?.on ?? b.fields.snooze).localeCompare(String((a.fields.archived as {on?: string})?.on ?? a.fields.snooze)));
  }

  // Comments, with @mentions by first name.
  listComments(itemId: string): Comment[] {
    return this.db.prepare('select * from comments where item_id = ? order by created').all(itemId)
      .map(toComment);
  }
  /** Open comments assigned to a person, newest first, with their item. */
  comment(cid: string): Comment {
    const r = this.db.prepare('select * from comments where id = ?').get(cid);
    if (!r) throw new NotFound('Comment not found');
    return toComment(r);
  }
  /** Open comments assigned to a person, newest first, each with its item. */
  assignedComments(person: string) {
    const item = this.db.prepare('select * from items where id = ?');
    return this.db.prepare(`select c.* from comments c join items i on i.id = c.item_id
      where c.assignee = ? and c.resolved is null order by c.created desc`).all(person)
      .map(r => ({...toComment(r), item: toItem(item.get(r.item_id as string)!)}));
  }
  resolveComment(cid: string, _actor: string | null, resolved: boolean) {
    const c = this.comment(cid);
    this.db.prepare('update comments set resolved = ? where id = ?').run(resolved ? now() : null, cid);
    this.emit({kind: 'comment', itemId: c.itemId});
    if (resolved) { const item = this.item(c.itemId); this.event('comment.resolved', {projectId: item.projectId, item, actor: _actor, details: {comment: this.comment(cid)}}); }
    return this.comment(cid);
  }
  addComment(itemId: string, author: string, body: string, assignee: string | null = null): Comment {
    const item = this.item(itemId);
    this.person(author);
    if (!body.trim()) throw new Invalid('Comment is empty');
    if (assignee) this.person(assignee);
    const c: Comment = {id: id(), itemId, author, body: body.trim(), created: now(), assignee, resolved: null};
    this.db.prepare('insert into comments (id,item_id,author,body,created,assignee) values (?,?,?,?,?,?)').run(c.id, c.itemId, c.author, c.body, c.created, assignee);
    this.emit({kind: 'comment', itemId});
    const p = this.project(item.projectId);
    const ref = `${p.key}-${item.number}`;
    const mentioned = this.listPeople().filter(pp => new RegExp(`@${pp.name.split(' ')[0]}\\b`, 'i').test(c.body)).map(pp => pp.id);
    if (assignee && assignee !== author) this.notify(assignee, author, itemId, 'assigned-comment', `assigned you a comment on ${ref}: ${c.body.slice(0, 80)}`);
    for (const m of mentioned.filter(x => x !== assignee)) this.notify(m, author, itemId, 'mention', `mentioned you on ${ref}: ${c.body.slice(0, 80)}`);
    for (const w of this.watchers(item).filter(w => !mentioned.includes(w))) this.notify(w, author, itemId, 'comment', `commented on ${ref}: ${c.body.slice(0, 80)}`);
    this.event('comment.created', {projectId: p.id, item, actor: author, details: {comment: c}});
    for (const m of mentioned) this.event('mention.created', {projectId: p.id, item, actor: author, details: {comment: c, person: m}});
    this.fire({kind: 'comment-added'}, item);
    return c;
  }

  // Time tracking. One running timer per person.
  listTime(q: {itemId?: string; person?: string}): TimeEntry[] {
    const where: string[] = [], args: string[] = [];
    if (q.itemId) { where.push('item_id = ?'); args.push(q.itemId); }
    if (q.person) { where.push('person = ?'); args.push(q.person); }
    return this.db.prepare(`select * from time_entries ${where.length ? 'where ' + where.join(' and ') : ''} order by start desc`).all(...args).map(toTime);
  }
  runningTimer(person: string): TimeEntry | null {
    const r = this.db.prepare('select * from time_entries where person = ? and end is null limit 1').get(person);
    return r ? toTime(r) : null;
  }
  timeEntry(entryId: string): TimeEntry {
    const r = this.db.prepare('select * from time_entries where id = ?').get(entryId);
    if (!r) throw new NotFound('Time entry not found');
    return toTime(r);
  }
  startTimer(itemId: string, person: string, kind: 'work' | 'review' = 'work') {
    this.item(itemId); this.person(person);
    this.stopTimer(person);
    const e: TimeEntry = {id: id(), itemId, person, start: now(), end: null, minutes: null, note: null, kind: kind === 'review' ? 'review' : 'work'};
    this.db.prepare('insert into time_entries (id,item_id,person,start,kind) values (?,?,?,?,?)').run(e.id, e.itemId, e.person, e.start, e.kind);
    this.emit({kind: 'time', itemId});
    this.timeEvent('timer.started', e);
    return e;
  }
  /** Stops the running timer. Time is kept to the second; a run under a second is dropped. */
  stopTimer(person: string, note?: string | null) {
    const run = this.runningTimer(person);
    if (!run) return null;
    const end = now();
    const seconds = Math.round((Date.parse(end) - Date.parse(run.start)) / 1000);
    if (seconds < 1) { this.db.prepare('delete from time_entries where id = ?').run(run.id); this.emit({kind: 'time', itemId: run.itemId}); return null; }
    const minutes = seconds / 60, n = note == null ? run.note : String(note).slice(0, 500);
    this.db.prepare('update time_entries set end = ?, minutes = ?, note = ? where id = ?').run(end, minutes, n, run.id);
    this.emit({kind: 'time', itemId: run.itemId});
    this.timeEvent('timer.stopped', {...run, end, minutes, note: n});
    this.timeEvent('time.logged', {...run, end, minutes, note: n});
    return {...run, end, minutes, note: n};
  }
  /** Logs time by minutes (on a date), or by a start and an end (then minutes is the span). */
  logTime(input: {itemId: string; person: string; minutes?: number; note?: string | null; date?: string; start?: string; end?: string}) {
    this.item(input.itemId); this.person(input.person);
    let start = input.date ? new Date(input.date + 'T09:00:00').toISOString() : now(), end = start, minutes = Number(input.minutes);
    if (input.start !== undefined || input.end !== undefined) {
      const s = Date.parse(String(input.start)), e = Date.parse(String(input.end));
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || e - s > 86400_000) throw new Invalid('start and end must be times, with the end after the start and within a day');
      start = new Date(s).toISOString(); end = new Date(e).toISOString(); minutes = Math.round((e - s) / 60000);
    }
    if (!(minutes > 0)) throw new Invalid('Minutes must be positive');
    const note = input.note == null ? null : String(input.note).slice(0, 500);
    const e: TimeEntry = {id: id(), itemId: input.itemId, person: input.person, start, end, minutes, note, kind: 'work'};
    this.db.prepare('insert into time_entries (id,item_id,person,start,end,minutes,note) values (?,?,?,?,?,?,?)').run(e.id, e.itemId, e.person, e.start, e.end, e.minutes, e.note);
    this.emit({kind: 'time', itemId: input.itemId});
    this.timeEvent('time.logged', e);
    return e;
  }
  private timeEvent(event: string, entry: TimeEntry) {
    const item = this.item(entry.itemId);
    this.event(event, {projectId: item.projectId, item, actor: entry.person, details: {entry}});
  }
  /** Logged minutes per item (all people), for the Time tracked column. */
  timeTotals(itemId?: string): Record<string, number> {
    const rows = this.db.prepare('select item_id, sum(minutes) as m from time_entries where minutes > 0 and (?1 is null or item_id = ?1) group by item_id').all(itemId ?? null);
    return Object.fromEntries(rows.map(r => [r.item_id as string, r.m as number]));
  }
  /** One person's week: minutes per task per day (Monday first), from finished time entries. */
  timesheet(person: string, weekStart: string) {
    this.person(person);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Invalid('week must be a date like 2026-11-09');
    const days = Array.from({length: 7}, (_, n) => addUnit(weekStart, n, 'day'));
    const rows = new Map<string, number[]>();
    // Entries are bucketed by local day, so read a day either side of the week in UTC.
    const from = new Date(addUnit(weekStart, -1, 'day') + 'T00:00:00').toISOString(), to = new Date(addUnit(weekStart, 8, 'day') + 'T00:00:00').toISOString();
    const entries = this.db.prepare('select item_id, start, minutes from time_entries where person = ? and minutes > 0 and start >= ? and start < ?').all(person, from, to)
      .map(r => ({itemId: r.item_id as string, start: r.start as string, minutes: r.minutes as number}));
    for (const e of entries) {
      const n = days.indexOf(iso(new Date(e.start)));
      if (n < 0) continue;
      const m = rows.get(e.itemId) ?? [0, 0, 0, 0, 0, 0, 0];
      m[n] += e.minutes; rows.set(e.itemId, m);
    }
    return {weekStart, days, rows: [...rows.entries()].map(([itemId, minutes]) => ({itemId, minutes}))};
  }
  /** Sets a day's logged minutes for one task: replaces that day's finished entries with one entry (0 clears it). */
  setDayMinutes(person: string, itemId: string, date: string, minutes: number) {
    this.item(itemId); this.person(person);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Invalid('date must look like 2026-11-30');
    if (!(Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440)) throw new Invalid('A day has 0 to 24 hours');
    const from = new Date(date + 'T00:00:00').toISOString(), to = new Date(addUnit(date, 1, 'day') + 'T00:00:00').toISOString();
    this.db.exec('begin');
    try {
      this.db.prepare('delete from time_entries where person = ? and item_id = ? and end is not null and start >= ? and start < ?').run(person, itemId, from, to);
      if (minutes > 0) this.logTime({itemId, person, minutes: Math.round(minutes), date});
      this.db.exec('commit');
    } catch (e) { this.db.exec('rollback'); throw e; }
    if (!minutes) this.emit({kind: 'time', itemId});
    return this.timesheet(person, monday(date));
  }
  deleteTime(entryId: string) {
    const r = this.db.prepare('select item_id from time_entries where id = ?').get(entryId) as Row | undefined;
    if (!r) throw new NotFound('Time entry not found');
    this.db.prepare('delete from time_entries where id = ?').run(entryId);
    this.emit({kind: 'time', itemId: r.item_id as string});
  }

  // Notifications
  private assignListeners = new Set<(a: {person: string; actor: string | null; item: Item}) => void>();
  /** Every time someone is added to an item's assignees, including when they assign themselves. */
  onAssign(fn: (a: {person: string; actor: string | null; item: Item}) => void) { this.assignListeners.add(fn); return () => this.assignListeners.delete(fn); }
  private assigned(people: string[], actor: string | null, item: Item) { for (const person of people) for (const fn of this.assignListeners) { try { fn({person, actor, item}); } catch (e) { console.error('Assign hook failed', e); } } }
  private notifyListeners = new Set<(n: {person: string; actor: string | null; itemId: string | null; kind: string; text: string}) => void>();
  onNotify(fn: (n: {person: string; actor: string | null; itemId: string | null; kind: string; text: string}) => void) { this.notifyListeners.add(fn); return () => this.notifyListeners.delete(fn); }
  private notify(person: string, actor: string | null, itemId: string | null, kind: string, text: string) {
    if (person === actor) return;
    for (const fn of this.notifyListeners) { try { fn({person, actor, itemId, kind, text}); } catch { /* email problems must not block the save */ } }
    this.db.prepare('insert into notifications (id,person,item_id,kind,text,actor,created) values (?,?,?,?,?,?,?)').run(id(), person, itemId, kind, text, actor, now());
    this.emit({kind: 'notification', person});
    const about = itemId ? this.db.prepare('select * from items where id = ?').get(itemId) : undefined;
    this.event('notification.created', {projectId: about ? about.project_id as string : null, item: about ? toItem(about) : null, actor, details: {notification: {person, kind, text}}});
  }
  listNotifications(person: string, unreadOnly = false): Notification[] {
    return this.db.prepare(`select * from notifications where person = ? ${unreadOnly ? 'and read = 0' : ''} order by created desc, rowid desc limit 100`).all(person).map(r => ({
      id: r.id as string, person: r.person as string, itemId: (r.item_id as string) ?? null, kind: r.kind as string,
      text: r.text as string, actor: (r.actor as string) ?? null, created: r.created as string, read: r.read === 1,
    }));
  }
  markRead(person: string, ids?: string[]) {
    if (ids?.length) for (const x of ids) this.db.prepare('update notifications set read = 1 where id = ? and person = ?').run(x, person);
    else this.db.prepare('update notifications set read = 1 where person = ?').run(person);
    this.emit({kind: 'notification', person});
  }

  // My Work: open items assigned to a person, bucketed by due date.
  myWork(person: string) {
    const today = this.today(), week = addUnit(today, 7, 'day');
    const items = this.listItems({assignee: person, open: true});
    const bucket = (i: Item) => !i.due ? 'noDate' : i.due < today ? 'overdue' : i.due === today ? 'today' : i.due <= week ? 'thisWeek' : 'later';
    const out: Record<string, Item[]> = {overdue: [], today: [], thisWeek: [], later: [], noDate: []};
    for (const i of items) out[bucket(i)].push(i);
    for (const k in out) out[k].sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9') || (a.priority || 9) - (b.priority || 9));
    return out;
  }

  // Field inheritance: a new subitem copies the parent's fields that the project lists, unless given.
  private inherit<T extends ItemPatch & {projectId: string; title: string}>(p: Project, input: T): T {
    const parent = this.db.prepare('select * from items where id = ?').get(input.parentId!);
    if (!parent) return input;
    const par = toItem(parent);
    const out = {...input, fields: {...input.fields}};
    for (const k of p.settings.inherit) {
      if (k.startsWith('f:')) { const f = k.slice(2); if (out.fields[f] === undefined && par.fields[f] !== undefined) out.fields[f] = par.fields[f]; continue; }
      if (k === 'assignees' && !out.assignees?.length && par.assignees.length) out.assignees = par.assignees;
      if (k === 'tags') out.tags = [...new Set([...(out.tags ?? []), ...par.tags])];
      if (k === 'sprint' && out.sprint === undefined && par.sprint) out.sprint = par.sprint;
      if (k === 'priority' && !out.priority && par.priority) out.priority = par.priority;
      if (k === 'due' && out.due === undefined && par.due) out.due = par.due;
      if (k === 'start' && out.start === undefined && par.start) out.start = par.start;
    }
    return out;
  }
  /** Push the parent's current values for the given fields down to every descendant. */
  applyToChildren(parentId: string, keys: InheritKey[], actor: string | null = null) {
    const par = this.item(parentId);
    let n = 0;
    for (const id of this.descendants(parentId)) {
      const c = this.item(id), patch: ItemPatch = {};
      for (const k of keys) {
        if (k.startsWith('f:')) { patch.fields = {...(patch.fields ?? c.fields), [k.slice(2)]: par.fields[k.slice(2)]}; continue; }
        (patch as Record<string, unknown>)[k] = k === 'tags' ? [...new Set([...c.tags, ...par.tags])] : (par as Record<string, unknown>)[k];
      }
      this.updateItem(id, patch, actor);
      n++;
    }
    return {updated: n};
  }

  // Automations. Depth guard stops rules from triggering each other forever.
  private ruleDepth = 0;
  /** item is null only for an inbound webhook without an item; then ctx names the space. Returns the rules that ran. */
  private fire(trigger: Trigger, item: Item | null, ctx: {projectId?: string; data?: unknown} = {}): Rule[] {
    if (this.ruleDepth > 3) return [];
    const projectId = item?.projectId ?? ctx.projectId!;
    const rules = this.project(projectId).settings.automations.filter(r => ruleMatches(r, trigger, item, this.ruleHost));
    if (!rules.length) return [];
    this.ruleDepth++;
    try { for (const r of rules) this.runRule(r, item && this.item(item.id), {trigger, projectId, data: ctx.data}); }
    finally { this.ruleDepth--; }
    return rules;
  }
  private runRule(r: Rule, item: Item | null, ctx: RuleContext) {
    applyRule(r, item, this.ruleHost, ctx);
    if (item) this.logRule(r, item);
    const after = item ? this.db.prepare('select * from items where id = ?').get(item.id) : undefined;
    this.event('automation.ran', {projectId: ctx.projectId, item: after ? toItem(after) : null, details: {rule: {id: r.id, name: r.name}, trigger: ctx.trigger}});
  }
  private logRule(r: Rule, item: Item) {
    this.db.prepare('insert or ignore into rule_runs (rule_id, item_id) values (?, ?)').run(r.id, item.id);
  }
  private get ruleHost(): RuleHost {
    return {
      today: () => this.today(), project: id => this.project(id), item: id => this.item(id),
      listItems: q => this.listItems(q), updateItem: (id, patch, actor) => this.updateItem(id, patch as ItemPatch, actor),
      currentSprintId: pid => this.currentSprint(pid)?.id ?? null,
      nextSprintId: pid => { const cur = this.currentSprint(pid); return this.listSprints(pid).find(s => cur && s.start > cur.start)?.id ?? this.createSprint({projectId: pid}).id; },
      notifyPerson: (person, itemId, text) => this.notify(person, null, itemId, 'automation', text),
      instantiateTemplate: (tid, pid, parentId, actor) => this.useItemTemplate(tid, pid, parentId, actor),
      addDays: (d, n) => addUnit(d, n, 'day'),
      sendWebhook: (rule, a, item, ctx) => this.event('automation.webhook', {projectId: ctx.projectId, item,
        details: {rule: {id: rule.id, name: rule.name}, trigger: ctx.trigger, ...(ctx.data !== undefined ? {data: ctx.data} : {})},
        target: {hook: `rule:${rule.id}`, scope: ctx.projectId, url: a.value, secretKey: `rule:${rule.id}:${a.value}`}}),
      resumeRoutine: id => { const it = this.item(id); if (it.recur && !it.recur.spawned && !it.completed && (it.recur.waiting || it.recur.paused)) this.routine(id, 'resume', null); },
    };
  }
  /** Inbound webhook (POST /api/hooks/in/trigger): runs this space's rules that wait for this key. With an item the rules act on it;
   *  without one only webhook, template and notify-a-person actions run. data (the JSON that came in) goes out with webhook actions. */
  triggerHook(projectId: string, key: string, opts: {item?: string | null; data?: unknown} = {}) {
    const p = this.project(projectId);
    if (typeof key !== 'string' || !key.trim()) throw new Invalid('key is required');
    const item = opts.item ? this.findItem(opts.item) : null;
    if (item && item.projectId !== p.id) throw new Invalid('That item is in another space');
    return {ran: this.fire({kind: 'webhook-received', key}, item, {projectId: p.id, data: opts.data}).map(r => ({id: r.id, name: r.name}))};
  }
  /** The date a date rule is about for this item today, or null when the rule does not apply now. A rule runs once per item and date. */
  private ruleDate(t: Trigger, i: Item, today: string): string | null {
    const left = i.due ? daysBetween(today, i.due) : null;
    if (t.kind === 'due-passed') return left !== null && left < 0 ? i.due : null;
    if (t.kind === 'due-today') return left === 0 ? i.due : null;
    if (t.kind === 'due-soon') return left !== null && left > 0 && left <= t.days ? i.due : null;
    if (t.kind === 'overdue-by') return left !== null && -left >= t.days ? i.due : null;
    if (t.kind === 'start-reached') return i.start && i.start <= today ? i.start : null;
    return null;
  }
  /** Hourly: date rules (once per item and date, so they run again when the date changes), date events and automatic sprint rollover. */
  periodic() {
    const today = this.today();
    for (const p of this.listProjects()) {
      const rules = p.settings.automations.filter(r => r.enabled && DATE_TRIGGERS.includes(r.trigger.kind));
      if (rules.length) for (const i of this.listItems({projectId: p.id, open: true})) {
        for (const r of rules) {
          const stamp = this.ruleDate(r.trigger, i, today);
          if (!stamp || !ruleMatches(r, r.trigger, i, this.ruleHost)) continue;
          if (!this.db.prepare('insert or ignore into rule_fires (rule_id, item_id, stamp) values (?, ?, ?)').run(r.id, i.id, stamp).changes) continue;
          this.ruleDepth++;
          try { this.runRule(r, i, {trigger: r.trigger, projectId: p.id}); } finally { this.ruleDepth--; }
        }
      }
      if (p.settings.autoRollover) for (const s of this.listSprints(p.id).filter(s => s.end < today))
        if (this.listItems({projectId: p.id, open: true}).some(i => i.sprint === s.id)) this.rolloverSprint(s.id);
    }
    try { boards.boardsPeriodic(this); } catch (e) { console.error('Whiteboard schedules failed', (e as Error).message); }
    this.dateEvents(today);
    this.reminders();
  }
  /** Date events for webhooks, each sent once per item (or sprint) and date. On the first run after an upgrade the dates
   *  already reached are only marked, so old work does not flood the endpoints. */
  private dateEvents(today: string) {
    const silent = !!this.db.prepare("select 1 from event_runs where key = 'baseline-pending'").get();
    const send = (key: string, event: string, e: Omit<HookEvent, 'event'>) => {
      if (this.db.prepare('insert or ignore into event_runs (key, at) values (?, ?)').run(key, now()).changes && !silent) this.event(event, e);
    };
    const soon = workspaceHooks(this.db).dueSoonDays;
    for (const i of this.listItems({open: true})) {
      const e = {projectId: i.projectId, item: i};
      if (i.due) {
        const left = daysBetween(today, i.due), days = left > 0 ? soon.find(n => left <= n) : undefined;
        if (days !== undefined) send(`due_soon:${i.id}:${i.due}:${days}`, 'item.due_soon', {...e, details: {days, daysLeft: left}});
        if (left === 0) send(`due_today:${i.id}:${i.due}`, 'item.due_today', e);
        if (left < 0) send(`overdue:${i.id}:${i.due}`, 'item.overdue', {...e, details: {daysOverdue: -left}});
      }
      if (i.start && i.start <= today) send(`start:${i.id}:${i.start}`, 'item.start_reached', e);
    }
    for (const s of this.listSprints()) {
      const e = {projectId: s.projectId, details: {sprint: s}}, left = daysBetween(today, s.end);
      if (s.start <= today && left >= 0) send(`sprint_started:${s.id}:${s.start}`, 'sprint.started', e);
      if (s.start <= today && left >= 0 && left <= 2) send(`sprint_ending:${s.id}:${s.end}`, 'sprint.ending_soon', {...e, details: {sprint: s, daysLeft: left}});
      if (left < 0) send(`sprint_ended:${s.id}:${s.end}`, 'sprint.ended', e);
    }
    if (silent) this.db.prepare("delete from event_runs where key = 'baseline-pending'").run();
  }

  /** Reminders, each sent once: due today or tomorrow and overdue (8 am to 8 pm only), and timers left running 4 hours. */
  reminders(now = new Date()) {
    const sent = (person: string, itemId: string, kind: string, since: string) => !!this.db.prepare('select 1 from notifications where person = ? and item_id = ? and kind = ? and created >= ?').get(person, itemId, kind, since);
    const keys = new Map(this.listProjects().map(p => [p.id, p.key]));
    const ref = (i: Item) => `${keys.get(i.projectId)}-${i.number}: ${i.title}`;
    if (now.getHours() >= 8 && now.getHours() < 20) {
      const today = this.today(), tomorrow = addUnit(today, 1, 'day');
      for (const i of this.listItems({open: true})) {
        if (!i.due || i.due > tomorrow) continue;
        const [kind, text, since] = i.due < today ? ['overdue', `${ref(i)} is overdue (due ${i.due})`, ''] : ['due', `${ref(i)} is due ${i.due === today ? 'today' : 'tomorrow'}`, today];
        for (const a of i.assignees) if (!sent(a, i.id, kind, since)) this.notify(a, null, i.id, kind, text);
      }
    }
    const long = new Date(now.getTime() - 4 * 3600_000).toISOString();
    for (const t of this.db.prepare('select item_id, person, start from time_entries where end is null and start < ?').all(long) as {item_id: string; person: string; start: string}[]) {
      const i = this.item(t.item_id);
      if (!sent(t.person, t.item_id, 'timer', t.start)) this.notify(t.person, null, t.item_id, 'timer', `Your timer on ${ref(i)} has run over 4 hours. Stop it if you are done.`);
    }
  }

  // Templates. Item templates keep a tree of items (no ids); project templates keep the setup and optionally the items.
  /** Saves a view's layout and settings as a template (dated or project-specific bits like sprint and baselines are left out). */
  saveViewTemplate(viewId: string, name: string, projectId: string | null): Template {
    const r = this.db.prepare('select * from views where id = ?').get(viewId);
    if (!r) throw new NotFound('View not found');
    const v = toView(r);
    return this.createTemplate({kind: 'view', name: name.trim() || v.name, projectId, data: {name: v.name, kind: v.kind, config: portableViewConfig(v.config)}});
  }
  /** Adds a view from a view template to a project. */
  useViewTemplate(templateId: string, projectId: string): View {
    const t = this.getTemplate(templateId);
    if (t.kind !== 'view') throw new Invalid('That is not a view template');
    this.project(projectId);
    const d = t.data as {name: string; kind: ViewKind; config?: ViewConfig};
    return this.createView({projectId, name: d.name, kind: d.kind, config: d.config ?? {}});
  }
  listTemplates(kind?: 'item' | 'project' | 'view'): Template[] {
    return (kind ? this.db.prepare('select * from templates where kind = ? order by name').all(kind) : this.db.prepare('select * from templates order by name').all())
      .map(r => ({id: r.id as string, kind: r.kind as Template['kind'], name: r.name as string, projectId: (r.project_id as string) ?? null, data: j(r.data, null), created: r.created as string}));
  }
  private treeOf(id: string, parent?: Item, prev?: Item): unknown {
    const i = this.item(id);
    // Dates become relative: days from the parent's start, or a gap after the step above.
    const pStart = parent ? parent.start ?? parent.due : null, mine = i.start ?? i.due;
    const anchor = !parent ? undefined : i.fields.follow === 'previous' && prev?.due && mine ? 'after' : pStart && mine ? 'start' : 'none';
    const offset = anchor === 'after' ? daysBetween(prev!.due!, mine!) - 1 : anchor === 'start' ? daysBetween(pStart!, mine!) : undefined;
    const kids = this.listItems({parentId: id}).sort((a, b) => a.sort - b.sort);
    return {type: i.type, title: i.title, body: i.body, priority: i.priority, assignees: i.assignees, tags: i.tags, estimate: i.estimate, recur: i.recur, fields: cleanFields(i.fields),
      days: i.start && i.due ? daysBetween(i.start, i.due) : null, worker: i.fields.worker as string | undefined, anchor, offset,
      children: kids.map((c, n) => this.treeOf(c.id, i, kids[n - 1]))};
  }
  saveItemTemplate(itemId: string, name: string): Template {
    const i = this.item(itemId);
    const t: Template = {id: id(), kind: 'item', name: name.trim() || i.title, projectId: i.projectId, data: this.treeOf(itemId), created: now()};
    this.db.prepare('insert into templates (id, kind, name, project_id, data, created) values (?,?,?,?,?,?)').run(t.id, t.kind, t.name, t.projectId, JSON.stringify(t.data), t.created);
    this.emit({kind: 'template'});
    return t;
  }
  useItemTemplate(templateId: string, projectId: string, parentId: string | null, actor: string | null = null, overrides: {title?: string; due?: string | null; start?: string | null} = {}) {
    const t = this.listTemplates('item').find(x => x.id === templateId);
    if (!t) throw new NotFound('Template not found');
    const p = this.project(projectId);
    type Node = PackNode;
    const people = new Set(this.listPeople().map(x => x.id));
    // Types missing from this project fall back to the closest level so templates travel between projects.
    const typeFor = (name: string, depth: number) => p.types.includes(name) ? name : p.types[Math.min(depth + (p.types.length > 3 ? 1 : 0), p.types.length - 1)];
    const make = (n: Node, parent: string | null, depth: number, pStart: string | null, prev: Item | null): Item => {
      const top = depth === 0;
      const title = top && overrides.title ? (n.title.includes('{name}') ? n.title.replace('{name}', overrides.title) : overrides.title) : n.title.replace('{name}', '').trim() || n.title;
      let start: string | null = null, due: string | null = null, follow: string | undefined;
      if (top) {
        // Give either a start or a due date; the other comes from the template's length.
        start = overrides.start ?? (overrides.due && n.days != null ? addUnit(overrides.due, -n.days, 'day') : null);
        due = overrides.due ?? (start && n.days != null ? addUnit(start, n.days, 'day') : null);
      } else {
        const anchor = n.anchor ?? (n.offset != null ? 'start' : 'none');
        let at: string | null = null;
        if (anchor === 'after' && prev?.due) { at = addUnit(prev.due, 1 + (n.offset ?? 0), 'day'); follow = 'previous'; }
        else if (anchor !== 'none' && pStart) { at = addUnit(pStart, n.offset ?? 0, 'day'); follow = 'parent'; }
        if (at && n.days != null) { start = at; due = addUnit(at, n.days, 'day'); } else due = at;
      }
      const fields = {...cleanFields(n.fields ?? {}), ...(n.worker ? {worker: n.worker} : {}), ...(follow ? {follow} : {})};
      const it = this.createItem({
        projectId, parentId: parent, type: typeFor(n.type || 'Task', depth), title: title.slice(0, 500), body: n.body ?? '', priority: n.priority ?? 0,
        assignees: (n.assignees ?? []).filter(a => people.has(a)), tags: n.tags ?? [], estimate: n.estimate ?? null, recur: n.recur ?? null, fields,
        due, start: start ?? undefined, deps: follow === 'previous' && prev ? [prev.id] : undefined,
      }, actor);
      let last: Item | null = null;
      for (const c of n.children ?? []) last = make(c, it.id, depth + 1, it.start ?? it.due, last);
      return it;
    };
    checkTemplateData('item', t.data);
    // All or nothing: a bad step undoes the steps already made.
    this.db.exec('savepoint use_template');
    try { const made = make(t.data as Node, parentId, 0, null, null); this.db.exec('release use_template'); return made; }
    catch (e) { this.db.exec('rollback to use_template'); this.db.exec('release use_template'); this.emit({kind: 'refresh'}); throw e; }
  }
  saveProjectTemplate(projectId: string, name: string, includeItems: boolean): Template {
    const p = this.project(projectId);
    const data = {
      statuses: p.statuses, types: p.types, fields: p.fields, settings: {...p.settings, webhooks: []},
      views: this.listViews(projectId).filter(v => !v.config.privateTo).map(v => ({name: v.name, kind: v.kind, config: portableViewConfig(v.config)})),
      items: includeItems ? this.listItems({projectId}).filter(i => !i.parentId).sort((a, b) => a.sort - b.sort).map(i => this.treeOf(i.id)) : [],
    };
    const t: Template = {id: id(), kind: 'project', name: name.trim() || p.name, projectId, data, created: now()};
    this.db.prepare('insert into templates (id, kind, name, project_id, data, created) values (?,?,?,?,?,?)').run(t.id, t.kind, t.name, t.projectId, JSON.stringify(t.data), t.created);
    this.emit({kind: 'template'});
    return t;
  }
  createProjectFromTemplate(templateId: string, name: string, actor: string | null = null) {
    const t = this.listTemplates('project').find(x => x.id === templateId);
    if (!t) throw new NotFound('Template not found');
    const d = t.data as {statuses: Status[]; types: string[]; fields: FieldDef[]; settings: ProjectSettings; views: {name: string; kind: ViewKind; config: ViewConfig}[]; items: unknown[]};
    const p = this.createProject({name, statuses: d.statuses, types: d.types, fields: d.fields, settings: d.settings, noViews: true});
    d.views.forEach((v, n) => this.createView({projectId: p.id, name: v.name, kind: v.kind, config: v.config, sort: n}));
    if (d.items.length) {
      const tmp: Template = {id: id(), kind: 'item', name: '', projectId: p.id, data: null, created: now()};
      for (const tree of d.items) {
        this.db.prepare('insert into templates (id, kind, name, project_id, data, created) values (?,?,?,?,?,?)').run(tmp.id, 'item', '_tmp', p.id, JSON.stringify(tree), tmp.created);
        this.useItemTemplate(tmp.id, p.id, null, actor);
        this.db.prepare('delete from templates where id = ?').run(tmp.id);
      }
    }
    return p;
  }
  // ---- Template packs: gallery, export, import ----
  gallery() { return GALLERY.map(p => ({name: p.name, description: p.description, templates: p.templates.map(t => ({name: t.name, steps: 1 + (t.tree.children?.length ?? 0), repeats: !!t.tree.recur})), automations: p.automations?.length ?? 0})); }
  installPack(input: Pack | {gallery: string}, projectId?: string, withAutomations = false) {
    const pack = 'gallery' in input ? GALLERY.find(p => p.name === input.gallery) : validatePack(input);
    if (!pack) throw new NotFound('Pack not found');
    const made: Template[] = [];
    for (const tpl of pack.templates) {
      const t: Template = {id: id(), kind: 'item', name: tpl.name, projectId: projectId ?? null, data: tpl.tree, created: now()};
      this.db.prepare('insert into templates (id, kind, name, project_id, data, created) values (?,?,?,?,?,?)').run(t.id, t.kind, t.name, t.projectId, JSON.stringify(t.data), t.created);
      made.push(t);
    }
    if (projectId && withAutomations && pack.automations?.length) {
      const p = this.project(projectId);
      const done = p.statuses.find(s => s.category === 'done')?.id;
      const rules = pack.automations.map(r => ({...r, id: id(), actions: r.actions.map(a => a.kind === 'parent-status' && done ? {...a, value: done} : a)})) as Rule[];
      const have = new Set(p.settings.automations.map(r => r.name));
      this.updateProject(projectId, {settings: {...p.settings, automations: [...p.settings.automations, ...rules.filter(r => !have.has(r.name))]}});
    }
    this.emit({kind: 'template'});
    return {installed: made.length, templates: made.map(t => ({id: t.id, name: t.name}))};
  }
  exportPack(templateIds: string[], name: string, description = ''): Pack {
    const all = this.listTemplates('item');
    const templates = (templateIds.length ? all.filter(t => templateIds.includes(t.id)) : all)
      .map(t => ({name: t.name, tree: stripPeople(t.data as PackNode)}));
    return {app: 'cadence', kind: 'pack', version: 1, name: name || 'My templates', description, templates};
  }
  getTemplate(tid: string): Template {
    const t = this.listTemplates().find(x => x.id === tid);
    if (!t) throw new NotFound('Template not found');
    return t;
  }
  /** A new template from scratch: a blank one, or data written by a person in the editor or by an agent. */
  createTemplate(input: {kind: 'item' | 'project' | 'view'; name: string; data?: unknown; projectId?: string | null}): Template {
    const kind = input.kind === 'project' || input.kind === 'view' ? input.kind : 'item';
    const name = String(input.name ?? '').trim() || (kind === 'project' ? 'New space template' : 'New template');
    const data = input.data ?? (kind === 'view' ? {name: input.name || 'Board', kind: 'board', config: {}} : kind === 'project'
      ? {statuses: DEFAULT_STATUSES, types: DEFAULT_TYPES, fields: [], settings: {}, views: DEFAULT_VIEWS.map(v => ({name: v.name, kind: v.kind, config: v.config ?? {}})), items: []}
      : {type: 'Task', title: name, children: []});
    checkTemplateData(kind, data);
    if (input.projectId) this.project(input.projectId);
    const t: Template = {id: id(), kind, name: name.slice(0, 200), projectId: input.projectId ?? null, data, created: now()};
    this.db.prepare('insert into templates (id, kind, name, project_id, data, created) values (?,?,?,?,?,?)').run(t.id, t.kind, t.name, t.projectId, JSON.stringify(t.data), t.created);
    this.emit({kind: 'template'});
    return t;
  }
  updateTemplate(tid: string, patch: {name?: string; data?: unknown}): Template {
    const t = this.getTemplate(tid);
    if (patch.name !== undefined && !String(patch.name).trim()) throw new Invalid('Name is required');
    if (patch.data !== undefined) checkTemplateData(t.kind, patch.data);
    this.db.prepare('update templates set name = ?, data = ? where id = ?').run(patch.name !== undefined ? String(patch.name).trim().slice(0, 200) : t.name, JSON.stringify(patch.data ?? t.data), tid);
    this.emit({kind: 'template'});
    return this.getTemplate(tid);
  }
  duplicateTemplate(tid: string): Template {
    const t = this.getTemplate(tid);
    return this.createTemplate({kind: t.kind, name: `${t.name} (copy)`, data: t.data, projectId: t.projectId});
  }
  deleteTemplate(tid: string) {
    this.db.prepare('delete from templates where id = ?').run(tid);
    this.emit({kind: 'template'});
  }

  // Change history: every create, edit and delete is saved with who did it, and can be reverted.
  private logListeners = new Set<(a: {kind: Activity['kind']; item: Item; before: unknown; after: unknown; actor: string | null}) => void>();
  onLog(fn: (a: {kind: Activity['kind']; item: Item; before: unknown; after: unknown; actor: string | null}) => void) { this.logListeners.add(fn); return () => this.logListeners.delete(fn); }
  private log(kind: Activity['kind'], actor: string | null, item: Item, before: unknown, after: unknown) {
    for (const fn of this.logListeners) { try { fn({kind, item, before, after, actor}); } catch { /* a listener must not break a save */ } }
    this.itemEvents(kind, actor, item, before, after);
    this.db.prepare('insert into activity (at, actor, kind, item_id, project_id, title, before, after) values (?,?,?,?,?,?,?,?)')
      .run(now(), actor, kind, item.id, item.projectId, item.title, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after));
  }
  /** Webhook events for a saved change: the general one, plus one per kind of change so endpoints can subscribe narrowly. */
  private itemEvents(kind: Activity['kind'], actor: string | null, item: Item, before: unknown, after: unknown) {
    const send = (event: string, details?: Record<string, unknown>) => this.event(event, {projectId: item.projectId, item, actor, ...(kind === 'update' ? {changes: {before, after}} : {}), details});
    if (kind !== 'update') return send(({create: 'item.created', delete: 'item.deleted', revert: 'item.restored'} as const)[kind], kind === 'revert' ? after as Record<string, unknown> : undefined);
    const b = before as Partial<Item>, a = after as Partial<Item>;
    send('item.updated');
    if ('status' in a) send('item.status_changed', {from: b.status, to: a.status});
    if (a.assignees) {
      const added = a.assignees.filter(x => !b.assignees?.includes(x)), removed = (b.assignees ?? []).filter(x => !a.assignees!.includes(x));
      if (added.length) send('item.assigned', {people: added});
      if (removed.length) send('item.unassigned', {people: removed});
    }
    if ('due' in a) send('item.due_changed', {from: b.due, to: a.due});
    if ('priority' in a) send('item.priority_changed', {from: b.priority, to: a.priority});
    if ('projectId' in a || 'parentId' in a) send('item.moved', {fromProject: b.projectId, fromParent: b.parentId});
    if (a.fields && !!a.fields.archived !== !!b.fields?.archived) send(a.fields.archived ? 'item.archived' : 'item.unarchived');
  }
  listActivity(q: {itemId?: string; projectId?: string; limit?: number; before?: number}): Activity[] {
    const where: string[] = [], args: (string | number)[] = [];
    if (q.itemId) { where.push('item_id = ?'); args.push(q.itemId); }
    if (q.projectId) { where.push('project_id = ?'); args.push(q.projectId); }
    if (q.before) { where.push('id < ?'); args.push(q.before); }
    return this.db.prepare(`select * from activity ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit ${Math.min(q.limit ?? 100, 500)}`).all(...args).map(r => ({
      id: r.id as number, at: r.at as string, actor: (r.actor as string) ?? null, kind: r.kind as Activity['kind'],
      itemId: r.item_id as string, projectId: r.project_id as string, title: r.title as string,
      before: j(r.before, null), after: j(r.after, null),
    }));
  }
  /** Undo one saved change: restore changed fields, remove a created item, or bring back deleted items with their ids. */
  revert(activityId: number, actor: string | null = null) {
    const a = this.listActivity({before: activityId + 1, limit: 1})[0];
    if (!a || a.id !== activityId) throw new NotFound('Change not found');
    if (a.kind === 'update') {
      const exists = this.db.prepare('select 1 from items where id = ?').get(a.itemId);
      if (!exists) throw new Invalid('That item was deleted. Restore the delete first.');
      return {item: this.updateItem(a.itemId, a.before as ItemPatch, actor)};
    }
    if (a.kind === 'create') {
      if (!this.db.prepare('select 1 from items where id = ?').get(a.itemId)) throw new Invalid('Already removed');
      return this.deleteItem(a.itemId, actor);
    }
    if (a.kind === 'delete') {
      const restored: Item[] = [];
      const deletedItems = Array.isArray(a.before) ? a.before as Item[] : (a.before as {items: Item[]}).items;
      for (const it of deletedItems) {
        if (this.db.prepare('select 1 from items where id = ?').get(it.id)) continue;
        if (!this.db.prepare('select 1 from projects where id = ?').get(it.projectId)) throw new Invalid('Its space no longer exists');
        this.db.prepare(`insert into items (id,project_id,parent_id,number,type,title,body,status,priority,assignees,start,due,estimate,tags,sprint,sort,recur,fields,created_by,created,updated,completed,deps)
          values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          it.id, it.projectId, it.parentId, it.number, it.type, it.title, it.body, it.status, it.priority, JSON.stringify(it.assignees), it.start, it.due,
          it.estimate, JSON.stringify(it.tags), it.sprint && this.db.prepare('select 1 from sprints where id = ?').get(it.sprint) ? it.sprint : null, it.sort,
          it.recur ? JSON.stringify(it.recur) : null, JSON.stringify(it.fields), it.createdBy, it.created, now(), it.completed, JSON.stringify(it.deps.filter(d => this.db.prepare('select 1 from items where id = ?').get(d) || deletedItems.some(x => x.id === d))));
        const back = this.item(it.id);
        restored.push(back);
        this.emit({kind: 'item', item: back});
      }
      // Bring back comments and links from other items that pointed at the restored ones.
      const extra = (Array.isArray(a.before) ? {} : a.before) as {comments?: Record<string, unknown>[]; incoming?: {id: string; deps: string[]}[]};
      for (const c of extra.comments ?? []) this.db.prepare('insert or ignore into comments (id, item_id, author, body, created) values (?,?,?,?,?)').run(c.id as string, c.item_id as string, c.author as string, c.body as string, c.created as string);
      for (const l of extra.incoming ?? []) {
        const it = this.db.prepare('select deps from items where id = ?').get(l.id) as {deps: string} | undefined;
        if (!it) continue;
        const deps = [...new Set([...JSON.parse(it.deps), ...l.deps])];
        this.db.prepare('update items set deps = ? where id = ?').run(JSON.stringify(deps), l.id);
        this.emit({kind: 'item', item: this.item(l.id)});
      }
      if (restored[0]) this.log('revert', actor, restored[0], null, {restored: restored.length});
      return {restored: restored.length};
    }
    throw new Invalid('This change cannot be reverted');
  }

  // Sprints (Azure "iterations"), per project.
  listSprints(projectId?: string): Sprint[] {
    const rows = projectId
      ? this.db.prepare('select * from sprints where project_id = ? order by start').all(projectId)
      : this.db.prepare('select * from sprints order by start').all();
    return rows.map(toSprint);
  }
  sprint(sid: string) {
    const r = this.db.prepare('select * from sprints where id = ?').get(sid);
    if (!r) throw new NotFound(`Sprint ${sid} not found`);
    return toSprint(r);
  }
  createSprint(input: {projectId: string; name?: string; start?: string; end?: string; goal?: string; capacity?: Record<string, number>}): Sprint {
    this.project(input.projectId);
    const existing = this.listSprints(input.projectId);
    const prev = existing.at(-1);
    const start = input.start ?? (prev ? addUnit(prev.end, 1, 'day') : this.today());
    const end = input.end ?? addUnit(start, 13, 'day');
    if (end < start) throw new Invalid('Sprint end must be after start');
    this.checkOverlap(input.projectId, null, start, end);
    const s: Sprint = {
      id: id(), projectId: input.projectId, name: input.name?.trim() || `Sprint ${existing.length + 1}`,
      start, end, goal: input.goal ?? '', capacity: input.capacity ?? prev?.capacity ?? {}, created: now(),
    };
    this.db.prepare('insert into sprints (id,project_id,name,start,end,goal,capacity,created) values (?,?,?,?,?,?,?,?)')
      .run(s.id, s.projectId, s.name, s.start, s.end, s.goal, JSON.stringify(s.capacity), s.created);
    this.emit({kind: 'sprint', projectId: s.projectId});
    return s;
  }
  private checkOverlap(projectId: string, self: string | null, start: string, end: string) {
    const o = this.listSprints(projectId).find(x => x.id !== self && x.start <= end && start <= x.end);
    if (o) throw new Invalid(`Sprints cannot overlap: ${o.name} runs ${o.start} to ${o.end}`);
  }
  updateSprint(sid: string, patch: Partial<Pick<Sprint, 'name' | 'start' | 'end' | 'goal' | 'capacity'>>): Sprint {
    const s = {...this.sprint(sid), ...patch};
    if (s.end < s.start) throw new Invalid('Sprint end must be after start');
    if (patch.start !== undefined || patch.end !== undefined) this.checkOverlap(s.projectId, sid, s.start, s.end);
    this.db.prepare('update sprints set name=?, start=?, end=?, goal=?, capacity=? where id=?').run(s.name, s.start, s.end, s.goal, JSON.stringify(s.capacity), sid);
    this.emit({kind: 'sprint', projectId: s.projectId});
    return s;
  }
  deleteSprint(sid: string) {
    const s = this.sprint(sid);
    for (const i of this.listItems({projectId: s.projectId}).filter(i => i.sprint === sid)) this.updateItem(i.id, {sprint: null});
    this.db.prepare('delete from sprints where id = ?').run(sid);
    this.emit({kind: 'sprint', projectId: s.projectId});
  }
  /** "current", "next", "none", a sprint name or number, or undefined (leave as is). */
  resolveSprint(projectId: string, ref: string | undefined): string | null | undefined {
    if (ref === undefined) return undefined;
    if (ref === 'none') return null;
    const cur = this.currentSprint(projectId);
    if (ref === 'current') return cur?.id ?? this.createSprint({projectId}).id;
    if (ref === 'next') return this.listSprints(projectId).find(s => cur && s.start > cur.start)?.id ?? this.createSprint({projectId}).id;
    const list = this.listSprints(projectId);
    return list.find(s => s.name.toLowerCase() === ref.toLowerCase() || s.name.toLowerCase().endsWith(' ' + ref.toLowerCase()))?.id;
  }
  /** Move every unfinished item in a sprint to the next one (created if there is none). */
  rolloverSprint(sid: string, actor: string | null = null) {
    const s = this.sprint(sid);
    const next = this.listSprints(s.projectId).find(x => x.start > s.start) ?? this.createSprint({projectId: s.projectId});
    const open = this.listItems({projectId: s.projectId}).filter(i => i.sprint === sid && !i.completed);
    for (const i of open) this.updateItem(i.id, {sprint: next.id}, actor);
    this.event('sprint.rolled_over', {projectId: s.projectId, actor, details: {sprint: s, to: next, moved: open.length}});
    return {moved: open.length, to: next};
  }
  /** The sprint running today, else the next one, else the last one. */
  currentSprint(projectId: string) {
    const t = this.today(), list = this.listSprints(projectId);
    return list.find(s => s.start <= t && t <= s.end) ?? list.find(s => s.start > t) ?? list.at(-1) ?? null;
  }

  // Burndown: open work per day across the sprint, by count and by estimate hours.
  // Uses current sprint membership and each item's completion time. Future days are NaN.
  burndown(sid: string): BurnPoint[] {
    const s = this.sprint(sid);
    const items = this.listItems({projectId: s.projectId}).filter(i => i.sprint === sid);
    const total = items.length, hours = items.reduce((a, i) => a + (i.estimate ?? 0), 0);
    const days = daysBetween(s.start, s.end);
    const today = this.today();
    const out: BurnPoint[] = [];
    for (let n = 0; n <= days; n++) {
      const date = addUnit(s.start, n, 'day');
      // A completion stamped after "today" (clock or time-zone skew) counts as today.
      const doneBy = items.filter(i => i.completed && [iso(new Date(i.completed)), today].sort()[0] <= date);
      const future = date > today;
      out.push({
        date, done: doneBy.length,
        remaining: future ? NaN : total - doneBy.length,
        remainingHours: future ? NaN : hours - doneBy.reduce((a, i) => a + (i.estimate ?? 0), 0),
        ideal: days ? total * (1 - n / days) : 0,
        idealHours: days ? hours * (1 - n / days) : 0,
      });
    }
    return out;
  }

  // Saved views per project. Config holds filters, grouping, columns and zoom.
  /** Views of a project. With a viewer, private views of other people are left out. */
  listViews(projectId: string, viewer?: string | null): View[] {
    const read = () => this.db.prepare('select * from views where project_id = ? order by sort').all(projectId).map(toView)
      .filter(v => viewer === undefined || !v.config.privateTo || v.config.privateTo === viewer);
    const rows = read();
    if (rows.length) return rows;
    this.project(projectId);
    DEFAULT_VIEWS.forEach((v, n) => this.createView({projectId, name: v.name, kind: v.kind, config: v.config, sort: n}));
    return read();
  }
  /** Puts a project's views in the given order with one change event. */
  reorderViews(projectId: string, ids: string[]) {
    const set = this.db.prepare('update views set sort = ? where id = ? and project_id = ?');
    ids.forEach((vid, n) => set.run(n, vid, projectId));
    this.emit({kind: 'view', projectId});
    return this.listViews(projectId);
  }
  createView(input: {projectId: string; name: string; kind: ViewKind; config?: ViewConfig; sort?: number}): View {
    const max = (this.db.prepare('select coalesce(max(sort),0) m from views where project_id = ?').get(input.projectId) as Row).m as number;
    const v: View = {id: id(), projectId: input.projectId, name: String(input.name ?? '').trim() || input.kind, kind: input.kind, config: input.config ?? {}, sort: input.sort ?? max + 1};
    this.db.prepare('insert into views (id,project_id,name,kind,config,sort) values (?,?,?,?,?,?)').run(v.id, v.projectId, v.name, v.kind, JSON.stringify(v.config), v.sort);
    this.emit({kind: 'view', projectId: v.projectId});
    return v;
  }
  view(vid: string): View {
    const r = this.db.prepare('select * from views where id = ?').get(vid);
    if (!r) throw new NotFound('View not found');
    return toView(r);
  }
  updateView(vid: string, patch: Partial<Pick<View, 'name' | 'kind' | 'config' | 'sort'>>): View {
    const cur = this.view(vid);
    // Locked views keep their settings until someone unlocks them (config.locked false).
    if (cur.config.locked && patch.config && patch.config.locked !== false) throw new Invalid('This view is locked. Unlock it first (config locked: false).');
    const v = {...cur, ...patch};
    this.db.prepare('update views set name=?, kind=?, config=?, sort=? where id=?').run(v.name, v.kind, JSON.stringify(v.config), v.sort, vid);
    this.emit({kind: 'view', projectId: v.projectId});
    return v;
  }
  deleteView(vid: string) {
    const v = this.view(vid);
    this.db.prepare('delete from views where id = ?').run(vid);
    this.emit({kind: 'view', projectId: v.projectId});
  }

  /** A person's own layout: view settings, tab order, project order. */
  prefs(person: string): Record<string, unknown> {
    return Object.fromEntries(this.db.prepare('select key, value from prefs where person = ?').all(person).map(r => [r.key as string, j(r.value, null)]));
  }
  setPref(person: string, key: string, value: unknown) {
    if (!/^(view:[\w-]{1,40}|views:[\w-]{1,40}|projects|cover:(mywork|everything))$/.test(key)) throw new Invalid('Unknown preference');
    if (value === null || value === undefined) { this.db.prepare('delete from prefs where person = ? and key = ?').run(person, key); return; }
    const text = JSON.stringify(value);
    if (text.length > 50_000) throw new Invalid('That layout is too large');
    this.db.prepare('insert into prefs (person, key, value) values (?,?,?) on conflict(person, key) do update set value = excluded.value').run(person, key, text);
  }

  /** Everything in this workspace as one JSON file (the same as Data and backups, Export). Passwords are left out. */
  exportWorkspace() { return exportAll(this.db, {skipPrivate: true}); }
  /** Job roles (company roles and the spaces each one opens), permission levels, and who holds which job roles. Read only; changes are made on the Team page. */
  jobRoles() {
    const w = getWorkspace(this.db), projects = this.listProjects();
    const space = (pid: string) => projects.find(p => p.id === pid);
    return {
      levels: w.roles.map(r => ({id: r.id, name: r.name, caps: r.caps})),
      jobRoles: w.jobRoles.map(j => ({id: j.id, name: j.name, others: j.others,
        spaces: Object.entries(j.spaces).filter(([pid]) => space(pid)).map(([pid, level]) => ({space: space(pid)!.key, name: space(pid)!.name, level}))})),
      people: this.listPeople().map(p => ({id: p.id, name: p.name, jobRoles: personJobRoles(this.db, p.id)})),
      domainJoin: w.domainJoin,
    };
  }

  /** A project's items with readable values (names, not ids), as rows or CSV. */
  exportItems(projectId: string, format: 'json' | 'csv' = 'json') {
    const p = this.project(projectId), people = this.listPeople(), sprints = this.listSprints(projectId), totals = this.timeTotals();
    const items = this.listItems({projectId}), byId = new Map(items.map(i => [i.id, i]));
    const rows = items.map(i => ({
      key: `${p.key}-${i.number}`, title: i.title, type: i.type, status: p.statuses.find(s => s.id === i.status)?.name ?? i.status,
      priority: i.priority ? PRIORITIES[i.priority].toLowerCase() : '', assignees: i.assignees.map(a => people.find(x => x.id === a)?.name ?? a).join(', '),
      start: i.start ?? '', due: i.due ?? '', estimate: i.estimate ?? '', tags: i.tags.join(', '), sprint: sprints.find(s => s.id === i.sprint)?.name ?? '',
      parent: i.parentId && byId.get(i.parentId) ? `${p.key}-${byId.get(i.parentId)!.number}` : '', done: i.completed ? 'yes' : '',
      hours: totals[i.id] ? Math.round(totals[i.id] / 60 * 100) / 100 : '',
      ...Object.fromEntries(p.fields.filter(f => i.fields[f.id] != null).map(f => [f.name, Array.isArray(i.fields[f.id]) ? (i.fields[f.id] as unknown[]).join(', ') : i.fields[f.id]])),
    }) as Record<string, unknown>);
    if (format !== 'csv') return rows;
    const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
    // Spreadsheet formula guard: cells that start like a formula are prefixed so they stay text.
    const cell = (v: unknown) => { let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [cols.map(cell).join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
  }

  /**
   * Adds items from rows with readable values: status, type and priority by name, people by name or email,
   * columns by name, parent by key or by the title of an earlier row. Bad rows are skipped and reported.
   */
  importItems(projectId: string, rows: Record<string, unknown>[], actor: string | null = null) {
    const p = this.project(projectId), people = this.listPeople();
    if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Invalid('Send 1 to 1000 rows');
    const list = (v: unknown) => Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,;]/).map(x => x.trim()).filter(Boolean) : [];
    const made = new Map<string, string>(), keys: string[] = [], errors: {row: number; error: string}[] = [];
    // One transaction and one refresh for the whole import, not an event per row.
    const emit = this.emit;
    this.emit = () => {};
    this.db.exec('begin');
    try {
    rows.forEach((r, n) => {
      try {
        const s = (k: string) => r?.[k] == null || r[k] === '' ? undefined : String(r[k]).trim();
        const title = s('title');
        if (!title) throw new Invalid('title is required');
        const sn = s('status'), st = sn ? p.statuses.find(x => x.id === sn || x.name.toLowerCase() === sn.toLowerCase()) : undefined;
        if (sn && !st) throw new Invalid(`Unknown status "${sn}". Known: ${p.statuses.map(x => x.name).join(', ')}`);
        const tn = s('type'), type = tn ? p.types.find(x => x.toLowerCase() === tn.toLowerCase()) : undefined;
        if (tn && !type) throw new Invalid(`Unknown type "${tn}". Known: ${p.types.join(', ')}`);
        const pn = s('priority'), priority = pn === undefined || /^(none|0)$/i.test(pn) ? 0 : PRIORITY_WORDS[pn.toLowerCase()];
        if (priority === undefined) throw new Invalid(`Unknown priority "${pn}"`);
        const assignees = list(r.assignees ?? r.assignee).map(a => {
          const hit = people.find(x => x.id === a || x.name.toLowerCase() === a.toLowerCase() || x.email?.toLowerCase() === a.toLowerCase());
          if (!hit) throw new Invalid(`Unknown person "${a}"`);
          return hit.id;
        });
        const parentRef = s('parent');
        const parentId = parentRef ? made.get(parentRef.toLowerCase()) ?? this.findItem(parentRef).id : null;
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries((r.fields ?? {}) as Record<string, unknown>)) {
          const f = p.fields.find(x => x.id === k || x.name.toLowerCase() === k.toLowerCase());
          if (!f) throw new Invalid(`Unknown column "${k}"`);
          fields[f.id] = v;
        }
        const est = s('estimate');
        const it = this.createItem({projectId, title, ...(type ? {type} : {}), ...(st ? {status: st.id} : {}), priority, assignees,
          start: s('start') ?? null, due: s('due') ?? null, estimate: est === undefined ? null : Number(est), tags: list(r.tags), body: s('body') ?? '', parentId, fields}, actor);
        made.set(title.toLowerCase(), it.id);
        keys.push(`${p.key}-${it.number}`);
      } catch (e) { errors.push({row: n + 1, error: e instanceof Error ? e.message : String(e)}); }
    });
      this.db.exec('commit');
    } catch (e) { this.db.exec('rollback'); throw e; } finally { this.emit = emit; }
    if (keys.length) this.emit({kind: 'refresh'});
    return {created: keys.length, keys, errors};
  }

  // ---- Planning (see planner.ts). Methods here so the permission guard covers them. ----
  estimateMissing(projectId?: string) { return planner.estimateMissing(this, projectId); }
  replan(opts: {projectId?: string; reassign?: boolean} = {}) { return planner.replan(this, opts); }
  applyPlan(projectId: string, changes: Parameters<typeof planner.applyPlan>[1], actor: string | null = null) {
    for (const c of changes) if (this.item(c.itemId).projectId !== projectId) throw new Invalid('Every change must belong to the given project');
    return planner.applyPlan(this, changes, actor);
  }
  forecast(opts: {projectId?: string; months?: number} = {}) { return planner.forecast(this, opts); }

  // ---- Approvals and signatures (see approvals.ts) ----
  requestApproval(itemId: string, by: string | null, approvers: string[], meaning: approvals.Meaning, note = '') { return approvals.requestApproval(this, itemId, by, approvers, meaning, note); }
  signApproval(approvalId: string, signer: string, decision: 'approved' | 'changes' | 'rejected', comment = '', password?: string) { return approvals.sign(this, approvalId, signer, decision, comment, password); }
  listApprovals(q: {itemId?: string; approver?: string; pending?: boolean}) { return approvals.listApprovals(this, q); }
  approvalState(itemId: string) { return approvals.approvalState(this, itemId); }
  notifyPublic(person: string, actor: string | null, itemId: string | null, kind: string, text: string) { this.notify(person, actor, itemId, kind, text); }

  // ---- Day planner: top 3, brain dump and time boxes for one person's day (see dayplan.ts) ----
  dayPlan(person: string, date: string) { return dayplan.getDayPlan(this, person, date); }
  updateDayPlan(person: string, date: string, patch: dayplan.DayPatch) { return dayplan.updateDayPlan(this, person, date, patch); }
  autoSchedule(person: string, date: string, opts: Parameters<typeof dayplan.autoSchedule>[3] = {}) { return dayplan.autoSchedule(this, person, date, opts); }

  // ---- Whiteboards: design and run workflows on a canvas (see boards.ts) ----
  listBoards(q: {projectId?: string; itemId?: string} = {}) { return boards.listBoards(this, q); }
  board(ref: string) { return boards.getBoard(this, ref); }
  createBoard(input: boards.BoardInput, actor: string | null = null) { return boards.createBoard(this, input, actor); }
  updateBoard(ref: string, patch: boards.BoardInput & boards.BoardOps & {rotateKey?: boolean}, actor: string | null = null) { return boards.updateBoard(this, ref, patch, actor); }
  deleteBoard(ref: string) { return boards.deleteBoard(this, ref); }
  boardFromItems(q: Parameters<typeof boards.boardFromItems>[1], actor: string | null = null, canSee?: (projectId: string) => boolean) { return boards.boardFromItems(this, q, actor, canSee); }
  boardToTasks(ref: string, actor: string | null = null, opts: {projectId?: string; parentId?: string | null} = {}) { return boards.boardToTasks(this, ref, actor, opts); }
  runBoard(ref: string, actor: string | null = null, opts: {trigger?: string; input?: unknown; title?: string} = {}) { return boards.runBoard(this, ref, actor, opts); }
  listBoardRuns(boardRef?: string, limit = 50) { return boards.listRuns(this, boardRef ? boards.getBoard(this, boardRef).id : undefined, limit); }
  boardRun(runId: string) { return boards.advance(this, runId); }
  boardRunAction(runId: string, action: 'cancel' | 'retry' | 'skip', node?: string) { return boards.runAction(this, runId, action, node); }

  // ---- Human and AI workers (see aiwork.ts) ----
  claimTask(itemId: string, agent: string, note = '', session: string | null = null) { return ai.claim(this, itemId, agent, note, session); }
  decideClaim(itemId: string, reviewer: string | null, accept: boolean, note = '') { return ai.decide(this, itemId, reviewer, accept, note); }
  submitWork(itemId: string, agent: string, report: string, missed = '', opts: {session?: string | null; artifacts?: ai.ArtifactInput[]} = {}) { return ai.submit(this, itemId, agent, report, missed, opts); }
  /** decision: approve, changes, redo or discard (true and false still mean approve and changes). keep: on discard, leave the agent assigned. */
  reviewWork(itemId: string, reviewer: string | null, decision: boolean | ai.Decision, comment = '', opts: {keep?: boolean} = {}) { return ai.reviewWork(this, itemId, reviewer, decision, comment, opts); }
  logWork(itemId: string, actor: string | null, kind: ai.LogEntry['kind'], text: string, url: string | null = null, opts: {session?: string | null; artifact?: ai.ArtifactInput} = {}) {
    const entry = ai.log(this, itemId, actor, kind, text, url, opts);
    if (kind !== 'review') { const item = this.item(itemId); this.event('ai.step_logged', {projectId: item.projectId, item, actor, details: {entry}}); }
    return entry;
  }
  /** What the agent made on this item, with the cleanup state of each after a redo or a discard. */
  workArtifacts(itemId: string) { this.item(itemId); return ai.listArtifacts(this, itemId); }
  confirmCleanup(itemId: string, actor: string | null, artifactId: string, note = '') { return ai.confirmCleanup(this, itemId, actor, artifactId, note); }
  /** The latest decision, the reviewer's comment, the session to resume, a compact record of the attempt, and what is left to clean up. */
  workFeedback(itemId: string) { return ai.feedback(this, itemId); }
  workLog(itemId: string) { return ai.listLog(this, itemId); }
  aiQueue(agent: string | null, projectId?: string) { return ai.aiQueue(this, agent, projectId); }
  attachFile(itemId: string, by: string | null, name: string, mime: string, base64: string) { return ai.saveFile(this, itemId, by, name, mime, base64); }
  itemFiles(itemId: string) { return ai.listFiles(this, itemId); }
  projectFiles(projectId: string) { this.project(projectId); return ai.projectFiles(this, projectId); }
  /** Saves a file as its own task: the title is the file name without its extension, the file is attached. */
  fileTask(projectId: string, actor: string | null, f: {name: string; mime: string; data: string; parentId?: string | null; status?: string}) {
    const title = (f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || f.name).slice(0, 500);
    const it = this.createItem({projectId, title, parentId: f.parentId ?? null, ...(f.status ? {status: f.status} : {}), tags: ['file']}, actor);
    try { this.attachFile(it.id, actor, f.name, f.mime, f.data); } catch (e) { this.deleteItem(it.id, actor); throw e; }
    return this.item(it.id);
  }

  // ---- Outbound webhooks (see webhooks.ts). scope is a space id, or 'workspace' for the endpoints that hear every space. ----
  webhooks(scope: string) { return scope === 'workspace' ? workspaceHooks(this.db) : {webhooks: this.project(scope).settings.webhooks.map(normalizeHook)}; }
  setWebhooks(scope: string, patch: {webhooks?: unknown; dueSoonDays?: unknown}) {
    if (scope === 'workspace') return saveWorkspaceHooks(this.db, patch);
    const p = this.project(scope);
    if (patch.webhooks !== undefined) this.updateProject(p.id, {settings: {...p.settings, webhooks: patch.webhooks as ProjectSettings['webhooks']}});
    return this.webhooks(scope);
  }
  /** Sends a webhook.test event to one endpoint; the result shows in its deliveries. */
  testWebhook(scope: string, hookId: string, actor: string | null = null) {
    const h = this.webhooks(scope).webhooks.find(x => x.id === hookId);
    if (!h) throw new NotFound('Webhook not found');
    this.event('webhook.test', {projectId: scope === 'workspace' ? null : scope, actor, details: {message: 'Test event from Cadence', hook: {id: h.id, name: h.name}},
      target: {hook: h.id, scope, url: h.url, secretKey: `hook:${h.id}`}});
    return this.hookDeliveries(scope, hookId, 1)[0];
  }
  hookDeliveries(scope: string, hookId?: string, limit?: number) { if (scope !== 'workspace') this.project(scope); return listDeliveries(this.db, {scope, hook: hookId, limit}); }

  /** Cumulative flow: items per status group at the end of each day, rebuilt from the change history. */
  flow(projectId: string, days = 30) {
    const p = this.project(projectId);
    const cat = (sid: string) => p.statuses.find(s => s.id === sid)?.category ?? 'todo';
    const today = this.today(), start = addUnit(today, -(days - 1), 'day');
    const acts = this.db.prepare("select item_id, kind, at, before, after from activity where project_id = ? order by id").all(projectId)
      .map(r => ({item: r.item_id as string, kind: r.kind as string, at: iso(new Date(r.at as string)), before: j<Record<string, unknown> | null>(r.before, null), after: j<Record<string, unknown> | null>(r.after, null)}));
    const out: {date: string; todo: number; doing: number; done: number}[] = [];
    const state = new Map<string, string>(); // item -> status id
    let k = 0;
    for (let d = start; d <= today; d = addUnit(d, 1, 'day')) {
      for (; k < acts.length && (acts[k].at <= d || d === today); k++) {
        const a = acts[k];
        if (a.kind === 'create' && a.after) state.set(a.item, a.after.status as string);
        else if (a.kind === 'update' && a.after && 'status' in a.after) state.set(a.item, a.after.status as string);
        else if (a.kind === 'delete') state.delete(a.item);
      }
      const row = {date: d, todo: 0, doing: 0, done: 0};
      for (const s of state.values()) row[cat(s) as 'todo' | 'doing' | 'done']++;
      out.push(row);
    }
    // Items created before history was kept are counted with their current status.
    const known = new Set(acts.map(a => a.item));
    for (const i of this.listItems({projectId}).filter(i => !known.has(i.id))) for (const r of out) if (iso(new Date(i.created)) <= r.date) r[cat(i.status) as 'todo' | 'doing' | 'done']++;
    return out;
  }

  /** Email to task: subject becomes the title (quick add syntax works), body the description, sender is noted. */
  fromEmail(input: {projectId: string; subject: string; body?: string; from?: string}, actor: string | null) {
    const subject = String(input.subject ?? '').replace(/^(re|fwd?|fw):\s*/i, '').trim();
    if (!subject) throw new Invalid('Email subject is empty');
    const item = this.quickAdd({projectId: input.projectId, text: subject.slice(0, 400)}, actor);
    const body = `${input.from ? `From: ${String(input.from).slice(0, 200)}\n\n` : ''}${String(input.body ?? '').slice(0, 50000)}`;
    return this.updateItem(item.id, {body, tags: [...new Set([...item.tags, 'email'])]}, actor);
  }

  // ---- Sync with other systems (CRM, accounting, Zapier). Items carry fields.ext = {source, id, url}. ----
  /** Create or update the item linked to an outside record. Safe to call repeatedly. */
  upsertExternal(input: {projectId: string; source: string; externalId: string; url?: string; title?: string} & ItemPatch, actor: string | null = null) {
    const {source, externalId, url, projectId, ...patch} = input;
    if (!source || !externalId) throw new Invalid('source and externalId are required');
    const r = this.db.prepare("select id from items where project_id = ? and json_extract(fields, '$.ext.source') = ? and json_extract(fields, '$.ext.id') = ?").get(projectId, source, String(externalId)) as {id: string} | undefined;
    const ext = {source, id: String(externalId), ...(url ? {url} : {})};
    if (r) {
      const cur = this.item(r.id);
      return {created: false, item: this.updateItem(r.id, {...patch, fields: {...cur.fields, ...patch.fields, ext}}, actor)};
    }
    if (!input.title) throw new Invalid('title is required to create a new item');
    return {created: true, item: this.createItem({...patch, projectId, title: input.title, fields: {...patch.fields, ext}}, actor)};
  }
  /** Everything that changed since a time: items created or updated, and ids deleted. Poll with the returned "now". */
  listChanges(since: string, projectId?: string) {
    const now = new Date().toISOString();
    const items = this.listItems({projectId}).filter(i => i.updated > since);
    const deleted = this.db.prepare("select item_id, project_id, at from activity where kind = 'delete' and at > ? order by id").all(since)
      .filter(r => !projectId || r.project_id === projectId).map(r => ({id: r.item_id as string, projectId: r.project_id as string, at: r.at as string}));
    return {now, items, deleted};
  }

  // Seed a usable workspace on first run.
  seedIfEmpty() {
    if (this.listProjects().length) return;
    const [dave, sam, alex] = ['David', 'Sam', 'Alex'].map(name => this.createPerson({name}));
    const p = this.createProject({name: 'Getting started', key: 'GS', types: SOFTWARE_TYPES});
    const epic = this.createItem({projectId: p.id, title: 'Launch the task app', type: 'Epic', assignees: [dave.id]}, dave.id);
    const t = this.today();
    this.createItem({projectId: p.id, parentId: epic.id, title: 'Try quick add: type below, press Enter', assignees: [dave.id], due: t, priority: 2}, dave.id);
    this.createItem({projectId: p.id, parentId: epic.id, title: 'Drag cards between columns on the board', assignees: [sam.id], due: addUnit(t, 2, 'day'), status: 'doing'}, dave.id);
    this.createItem({projectId: p.id, parentId: epic.id, title: 'Weekly review', assignees: [dave.id], due: addUnit(t, 3, 'day'), recur: {every: 1, unit: 'week', mode: 'schedule'}, tags: ['routine']}, dave.id);
    this.createItem({projectId: p.id, title: 'Connect an AI agent over MCP', assignees: [alex.id], priority: 3}, dave.id);
    this.seedDemo();
    this.seedDevOps();
  }

  /**
   * Example project in Azure DevOps style (Agile process): Epic > Feature > User Story > Task, plus Bugs.
   * Tasks run in order through finish-to-start dependencies, sit in 2-week iterations, and include recurring work.
   */
  seedDevOps() {
    if (this.listProjects().some(p => p.key === 'OPS')) return null;
    let ppl = this.listPeople();
    for (const name of ['Priya', 'Marcus']) if (!ppl.some(p => p.name === name)) this.createPerson({name});
    ppl = this.listPeople();
    const by = (n: string) => ppl.find(p => p.name === n)?.id ?? ppl[0].id;
    const t = this.today(), d = (n: number) => addUnit(t, n, 'day');
    const p = this.createProject({
      name: 'DevOps example: CI/CD rollout', key: 'OPS',
      types: ['Epic', 'Feature', 'User Story', 'Task', 'Bug'],
      statuses: [
        {id: 'new', name: 'New', category: 'todo', color: '#8b8d98'},
        {id: 'active', name: 'Active', category: 'doing', color: '#2f80ed'},
        {id: 'resolved', name: 'Resolved', category: 'doing', color: '#a855f7'},
        {id: 'closed', name: 'Closed', category: 'done', color: '#30a46c'},
      ],
    });
    const it = [1, 2, 3, 4].map(n => this.createSprint({projectId: p.id, name: `Iteration ${n}`, start: d(-14 + (n - 1) * 14)}));
    for (const s of it) this.updateSprint(s.id, {capacity: Object.fromEntries(ppl.map(x => [x.id, 40]))});
    it.forEach((s, n) => this.updateSprint(s.id, {goal: ['Repo and CI build', 'Staging releases', 'Production with approvals', 'Monitoring and on-call'][n]}));
    const sprintFor = (day: string) => it.find(s => s.start <= day && day <= s.end)?.id ?? null;
    const actor = by('David');
    const add = (title: string, type: string, extra: ItemPatch = {}) => this.createItem({projectId: p.id, title, type, ...extra}, actor);

    add('Start here: how this example works', 'Epic', {body: [
      'This project shows an Azure DevOps style flow in this app.',
      '',
      '1. Backlog view: switch the level between Epics, Features and User Stories. Drag to rank, drag onto an iteration to plan.',
      '2. Timeline view: tasks are chained with dependencies, so they run in order. Drag a bar to move it, drag its edges to resize, drag empty space to pan.',
      '3. Sprint view: pick an iteration to see burndown, capacity and its board. Use Add work to pull items in.',
      '4. Board view: drag cards across New, Active, Resolved, Closed.',
      '5. Open any item: change assignee, make it repeat, log time, add "waits for" dependencies, comment with @mentions.',
      '6. Recurring work is tagged "recurring": close one and the next appears automatically.',
    ].join('\n'), priority: 2});

    // Walk the plan in order: each task starts the working day after the previous one ends.
    let cursor = d(-13);
    let prev: string | null = null;
    const done = new Set(['Create the repository', 'Set branch policies on main', 'Add a pull request template', 'Write the build pipeline YAML']);
    const active = new Set(['Run unit tests in CI']);
    const task = (parent: string, title: string, hours: number, who: string, extra: ItemPatch = {}) => {
      const days = Math.max(1, Math.ceil(hours / 6));
      const start = cursor, due = addUnit(start, days - 1, 'day');
      cursor = addUnit(due, 1, 'day');
      const item = add(title, 'Task', {
        parentId: parent, start, due, estimate: hours, assignees: [by(who)], sprint: sprintFor(start),
        deps: prev ? [prev] : [], status: done.has(title) ? 'closed' : active.has(title) ? 'active' : 'new', ...extra,
      });
      prev = item.id;
      return item;
    };
    const story = (parent: string, title: string, body: string, build: (id: string) => void) => {
      const s = add(title, 'User Story', {parentId: parent, body});
      build(s.id);
      const kids = this.listItems({parentId: s.id});
      const start = kids.map(k => k.start!).sort()[0], due = kids.map(k => k.due!).sort().at(-1)!;
      this.updateItem(s.id, {start, due, sprint: sprintFor(start), estimate: kids.reduce((a, k) => a + (k.estimate ?? 0), 0),
        status: kids.every(k => k.completed) ? 'closed' : kids.some(k => k.status !== 'new') ? 'active' : 'new'});
      return s;
    };

    const e1 = add('CI/CD pipeline for the patient portal', 'Epic', {assignees: [by('David')], priority: 1, tags: ['platform']});
    const fa = add('Source control and branching', 'Feature', {parentId: e1.id, assignees: [by('Sam')]});
    story(fa.id, 'As a developer, I work from a protected main branch', 'Acceptance: main needs a PR, 1 reviewer and a green build.', s => {
      task(s, 'Create the repository', 4, 'Sam');
      task(s, 'Set branch policies on main', 3, 'Sam');
      task(s, 'Add a pull request template', 2, 'Priya');
    });
    const fb = add('Build pipeline', 'Feature', {parentId: e1.id, assignees: [by('Priya')]});
    story(fb.id, 'As a developer, every PR gets an automatic build and test run', 'Acceptance: build under 10 minutes, coverage reported on the PR.', s => {
      task(s, 'Write the build pipeline YAML', 8, 'Priya');
      task(s, 'Run unit tests in CI', 6, 'Priya');
      task(s, 'Add a code coverage gate (80%)', 4, 'Marcus');
    });
    const fc = add('Release pipeline', 'Feature', {parentId: e1.id, assignees: [by('Marcus')]});
    story(fc.id, 'As a team, we deploy to staging on every merge', 'Acceptance: merge to main deploys to staging and runs smoke tests.', s => {
      task(s, 'Infrastructure as code for staging', 12, 'Marcus');
      task(s, 'Staging deploy stage', 6, 'Marcus');
      task(s, 'Automated smoke tests', 6, 'Alex');
    });
    story(fc.id, 'As a release manager, production deploys need approval and can roll back', 'Acceptance: approval gate, blue-green swap, rollback in under 5 minutes.', s => {
      task(s, 'Production approval gate', 3, 'David');
      task(s, 'Blue-green deployment', 10, 'Marcus');
      task(s, 'Rollback runbook and drill', 6, 'Alex', {priority: 2});
    });
    const e2 = add('Operate and monitor', 'Epic', {assignees: [by('Alex')], tags: ['ops']});
    const fd = add('Monitoring and alerting', 'Feature', {parentId: e2.id, assignees: [by('Alex')]});
    story(fd.id, 'As on-call, I get paged for real problems only', 'Acceptance: dashboards for latency and errors, alert rules tuned, rotation set.', s => {
      task(s, 'Application dashboards', 6, 'Alex');
      task(s, 'Alert rules and thresholds', 6, 'Alex');
      task(s, 'On-call rotation and escalation', 3, 'David');
    });
    add('Flaky integration test on checkout', 'Bug', {parentId: fb.id, priority: 1, assignees: [by('Priya')], due: d(2), estimate: 3, sprint: sprintFor(t), tags: ['ci']});
    // Recurring operational work.
    add('Weekly release review', 'Task', {parentId: e2.id, assignees: [by('David')], due: d(3), estimate: 1, tags: ['recurring'], recur: {every: 1, unit: 'week', mode: 'schedule'}, sprint: sprintFor(d(3))});
    add('Monthly dependency and security patching', 'Task', {parentId: e2.id, assignees: [by('Marcus')], due: d(12), estimate: 4, tags: ['recurring', 'security'], recur: {every: 1, unit: 'month', mode: 'completion'}, sprint: sprintFor(d(12))});
    add('Daily pipeline health check', 'Task', {parentId: e2.id, assignees: [by('Sam')], due: t, estimate: 0.25, tags: ['recurring'], recur: {every: 1, unit: 'day', mode: 'completion'}, sprint: sprintFor(t)});
    return p;
  }

  /** A realistic project: epics, features, stories, tasks, two sprints, dates and dependencies. */
  seedDemo() {
    if (this.listProjects().some(p => p.key === 'WEB')) return;
    const ppl = this.listPeople();
    const who = (n: number) => ppl[n % ppl.length]?.id;
    const t = this.today(), d = (n: number) => addUnit(t, n, 'day');
    const p = this.createProject({name: 'Website relaunch', key: 'WEB', types: SOFTWARE_TYPES});
    const s1 = this.createSprint({projectId: p.id, name: 'Sprint 1', start: d(-7)});
    const s2 = this.createSprint({projectId: p.id, name: 'Sprint 2'});
    for (const s of [s1, s2]) this.updateSprint(s.id, {capacity: Object.fromEntries(ppl.map(x => [x.id, 30])), goal: s === s1 ? 'Ship the new design system' : 'Launch content pages'});
    const add = (title: string, type: string, extra: ItemPatch = {}) => this.createItem({projectId: p.id, title, type, ...extra}, who(0) ?? null);
    const e1 = add('Design system', 'Epic', {start: d(-10), due: d(20), assignees: [who(0)]});
    const f1 = add('Components library', 'Feature', {parentId: e1.id, start: d(-10), due: d(6), assignees: [who(1)]});
    const a = add('Buttons and inputs', 'Story', {parentId: f1.id, start: d(-8), due: d(-3), estimate: 6, sprint: s1.id, assignees: [who(1)], status: 'done'});
    const b = add('Tables and lists', 'Story', {parentId: f1.id, start: d(-2), due: d(3), estimate: 10, sprint: s1.id, assignees: [who(1)], status: 'doing', deps: [a.id]});
    add('Dark mode tokens', 'Task', {parentId: f1.id, start: d(1), due: d(5), estimate: 4, sprint: s1.id, assignees: [who(2)], deps: [b.id]});
    const f2 = add('Docs site', 'Feature', {parentId: e1.id, start: d(4), due: d(18), assignees: [who(0)]});
    const c = add('Usage guidelines', 'Story', {parentId: f2.id, start: d(8), due: d(14), estimate: 8, sprint: s2.id, assignees: [who(0)], deps: [b.id]});
    add('Publish docs', 'Task', {parentId: f2.id, start: d(15), due: d(18), estimate: 3, sprint: s2.id, assignees: [who(2)], deps: [c.id]});
    const e2 = add('Content migration', 'Epic', {start: d(0), due: d(30), assignees: [who(2)]});
    const f3 = add('Blog import', 'Feature', {parentId: e2.id, start: d(0), due: d(12), assignees: [who(2)]});
    add('Export old posts', 'Task', {parentId: f3.id, start: d(-1), due: d(2), estimate: 5, sprint: s1.id, assignees: [who(2)], priority: 2});
    add('Fix broken image links', 'Bug', {parentId: f3.id, due: d(-1), estimate: 2, sprint: s1.id, assignees: [who(1)], priority: 1});
    add('Redirect map', 'Story', {parentId: f3.id, start: d(9), due: d(12), estimate: 6, sprint: s2.id});
    add('SEO audit', 'Story', {parentId: e2.id, estimate: 5});
    add('Launch checklist', 'Task', {due: d(30), recur: null, tags: ['launch']});
  }
}
