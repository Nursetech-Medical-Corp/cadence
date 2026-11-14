// API tokens: let AI agents and other systems act as a person (with that person's role) without a password.
// Tokens are shown once; only a SHA-256 hash is stored. Send as "Authorization: Bearer tt_...".
import {createHash, randomBytes} from 'node:crypto';
import type {Db} from './db.ts';
import type {Tasks} from './service.ts';
import {settingsChanged, areaLocked, capsFor, type Access, type Cap} from './auth.ts';
import {WRITE_OPS, approvedSop, needsReview, propose} from './agents.ts';

export function migrateTokens(db: Db) {
  db.exec('create table if not exists tokens (id text primary key, person text not null, name text not null, hash text not null unique, created text not null, last_used text)');
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function createToken(db: Db, person: string, name: string) {
  const token = 'tt_' + randomBytes(24).toString('base64url');
  const id = randomBytes(6).toString('hex');
  db.prepare('insert into tokens (id, person, name, hash, created) values (?,?,?,?,?)').run(id, person, name.trim().slice(0, 80) || 'Token', sha(token), new Date().toISOString());
  return {id, token};
}
export function listTokens(db: Db, person?: string) {
  return (person ? db.prepare('select id, person, name, created, last_used from tokens where person = ? order by created desc').all(person) : db.prepare('select id, person, name, created, last_used from tokens order by created desc').all())
    .map(r => ({id: r.id as string, person: r.person as string, name: r.name as string, created: r.created as string, lastUsed: (r.last_used as string) ?? null}));
}
export function deleteToken(db: Db, id: string) { db.prepare('delete from tokens where id = ?').run(id); }
export function tokenPerson(db: Db, header: string | undefined): string | null {
  const m = /^Bearer\s+(tt_[\w-]+)$/i.exec(header ?? '');
  if (!m) return null;
  const r = db.prepare('select t.id, t.person from tokens t join people p on p.id = t.person where t.hash = ? and p.active = 1').get(sha(m[1])) as {id: string; person: string} | undefined;
  if (!r) return null;
  db.prepare('update tokens set last_used = ? where id = ?').run(new Date().toISOString(), r.id);
  return r.person;
}

export class Forbidden extends Error {}

/**
 * Wraps the service so every call is checked against the acting person's role, for callers that are not
 * the trusted local user (remote MCP over HTTP). Reads are filtered to visible projects; writes need the capability.
 */
/** Calls that need no project check: the person list, dates, the template gallery. */
const OPEN = new Set(['listPeople', 'person', 'today', 'gallery', 'findItem', 'on', 'emit', 'notifyPublic']);

export function guarded(tasks: Tasks, actor: string): Tasks {
  const caps = (projectId: string) => capsFor(tasks.db, actor, (tasks.project(projectId).settings as {access?: Access}).access, true, projectId);
  const need = (projectId: string, cap: Cap) => { if (!caps(projectId).has(cap)) throw new Forbidden(`Not allowed: needs "${cap}" in space ${tasks.project(projectId).key}`); };
  const sees = (projectId: string) => { try { return caps(projectId).has('view'); } catch { return false; } };
  const projOfItem = (id: string) => tasks.findItem(id).projectId;
  const isAdmin = () => !!(tasks.db.prepare('select admin from people where id = ?').get(actor) as {admin: number} | undefined)?.admin;
  const self = (person: string, what: string) => { if (person !== actor) throw new Forbidden(`You can only ${what} your own`); };
  const selfOrAdmin = (person: string, what: string) => { if (person !== actor && !isAdmin()) throw new Forbidden(`Only admins ${what} for others`); };
  // Whiteboards in a space follow that space's permissions; boards without a space are seen by everyone and changed by their maker or an admin.
  const boardOf = (ref: string) => tasks.board(ref);
  const seesBoard = (b: {projectId: string | null}) => !b.projectId || sees(b.projectId);
  const editsBoard = (b: {projectId: string | null; createdBy: string | null}) => b.projectId ? caps(b.projectId).has('edit') : b.createdBy === actor || isAdmin();
  const needBoard = (ref: string) => { const b = boardOf(ref); if (!seesBoard(b)) throw new Forbidden('Not found'); if (!editsBoard(b)) throw new Forbidden('Not allowed: you cannot change this whiteboard'); return b; };
  const boardOut = (b: any) => editsBoard(b) ? b : {...b, hookKey: undefined};
  const runBoardOf = (runId: string) => { const r = tasks.db.prepare('select board_id from board_runs where id = ?').get(runId) as {board_id: string} | undefined; if (!r) throw new Forbidden('Not found'); const b = boardOf(r.board_id); if (!seesBoard(b)) throw new Forbidden('Not found'); return b; };
  // Workspace endpoints hear every space, so they are for admins; a space's own need the settings permission there.
  const hooks = (scope: string) => { if (scope === 'workspace') { if (!isAdmin()) throw new Forbidden('Only admins manage workspace webhooks'); } else need(scope, 'settings'); };
  const checks: Record<string, (...a: any[]) => void> = {
    dayPlan: (person) => self(person, 'read day plans'),
    updateDayPlan: (person) => self(person, 'plan days'),
    autoSchedule: (person) => self(person, 'plan days'),
    createSubspace: (pid) => need(pid, 'settings'),
    boardsBySop: (o) => { if (o) o.visible = tasks.listProjects().filter(p => sees(p.id) && caps(p.id).has('edit')).map(p => p.id); else throw new Forbidden('Pass options'); },
    createBoard: (i) => { if (i?.projectId) need(i.projectId, 'edit'); },
    updateBoard: (ref, patch) => { needBoard(ref); if (patch?.projectId) need(patch.projectId, 'edit'); },
    deleteBoard: (ref) => { const b = needBoard(ref); if (b.projectId) need(b.projectId, 'delete'); },
    boardFromItems: (q) => { if (q?.projectId) need(q.projectId, 'edit'); for (const x of q?.itemIds ?? []) if (!sees(projOfItem(x))) throw new Forbidden('Not found'); if (q?.parentId && !sees(projOfItem(q.parentId))) throw new Forbidden('Not found'); if (q) q.visible = tasks.listProjects().filter(p => sees(p.id)).map(p => p.id); },
    boardToTasks: (ref, _a, opts) => { const b = needBoard(ref); const pid = opts?.projectId ?? b.projectId; if (pid) need(pid, 'create'); },
    runBoard: (ref) => { const b = boardOf(ref); if (!seesBoard(b)) throw new Forbidden('Not found'); if (b.projectId) need(b.projectId, 'create'); },
    listBoardRuns: (ref) => { if (ref && !seesBoard(boardOf(ref))) throw new Forbidden('Not found'); },
    boardRun: (runId) => runBoardOf(runId),
    boardRunAction: (runId) => { const b = runBoardOf(runId); if (!editsBoard(b)) throw new Forbidden('Not allowed: you cannot change this whiteboard'); },
    createItem: (i) => { need(i.projectId, 'create'); for (const d of i.deps ?? []) need(projOfItem(d), 'view'); },
    quickAdd: (i) => need(i.projectId, 'create'),
    routine: (id, _a, _actor, opts) => { need(projOfItem(id), 'edit'); for (const d of opts?.on ?? []) need(projOfItem(d), 'view'); },
    archiveItem: (id) => need(projOfItem(id), 'edit'),
    restoreItem: (id) => need(projOfItem(id), 'edit'),
    snoozeItem: (id) => need(projOfItem(id), 'edit'),
    updateItem: (id, patch) => { need(projOfItem(id), 'edit'); if (patch?.projectId) need(patch.projectId, 'create'); for (const d of patch?.deps ?? []) need(projOfItem(d), 'view'); },
    deleteItem: (id) => need(projOfItem(id), 'delete'),
    addComment: (id) => need(projOfItem(id), 'comment'),
    resolveComment: (cid) => need(projOfItem(tasks.comment(cid).itemId), 'comment'),
    reorderViews: (pid) => { need(pid, 'views'); if (areaLocked(tasks.db, 'viewOrder') && !isAdmin()) throw new Forbidden('Only admins change the order of views here'); },
    logTime: (i) => { need(projOfItem(i.itemId), 'edit'); selfOrAdmin(i.person, 'log time'); },
    startTimer: (itemId, person) => { need(projOfItem(itemId), 'edit'); self(person, 'run timers'); },
    stopTimer: (person) => self(person, 'stop timers'),
    timesheet: (person) => selfOrAdmin(person, 'see timesheets'),
    deleteTime: (eid) => { const e = tasks.timeEntry(eid); need(projOfItem(e.itemId), 'edit'); selfOrAdmin(e.person, 'delete time'); },
    listNotifications: (person) => self(person, 'read notifications'),
    markRead: (person) => self(person, 'read notifications'),
    updateView: (vid, patch) => { need(tasks.view(vid).projectId, 'views'); if (patch?.config && areaLocked(tasks.db, 'viewSettings') && settingsChanged(tasks.view(vid).config, patch.config) && !isAdmin()) throw new Forbidden('Only admins change view settings here'); if (patch?.config?.privateTo && patch.config.privateTo !== actor) throw new Forbidden('A view can only be made private to yourself'); },
    deleteView: (vid) => need(tasks.view(vid).projectId, 'views'),
    deleteProject: (pid) => { if ((tasks.project(pid).settings as {access?: Access}).access?.private) need(pid, 'settings'); else if (!isAdmin()) throw new Forbidden('Only admins delete spaces'); },
    createRollup: () => { if (!isAdmin()) throw new Forbidden('Only admins add rollup spaces'); },
    importItems: (pid) => need(pid, 'create'),
    exportItems: (pid) => need(pid, 'export'),
    exportWorkspace: () => { if (!isAdmin()) throw new Forbidden('Only admins export the whole workspace'); },
    setDayMinutes: (person, itemId) => { need(projOfItem(itemId), 'edit'); selfOrAdmin(person, 'log time'); },
    applyToChildren: (id) => need(projOfItem(id), 'edit'),
    createSprint: (i) => need(i.projectId, 'sprints'),
    updateSprint: (sid) => need(tasks.sprint(sid).projectId, 'sprints'),
    deleteSprint: (sid) => need(tasks.sprint(sid).projectId, 'sprints'),
    rolloverSprint: (sid) => need(tasks.sprint(sid).projectId, 'sprints'),
    updateProject: (pid, patch) => { need(pid, 'settings'); if (patch?.sort !== undefined && areaLocked(tasks.db, 'projectOrder') && !isAdmin()) throw new Forbidden('Only admins change the order of spaces here'); if (patch?.settings?.access && !isAdmin()) throw new Forbidden('Only admins change space access with a token'); },
    createProject: (i) => { const a = i?.settings?.access as Access | undefined; if (a?.private && Object.keys(a.members).length === 1 && a.members[actor] === 'admin') return; if (!isAdmin()) throw new Forbidden('Only admins create shared spaces; pass personal: true for your own'); },
    createProjectFromTemplate: () => { if (!isAdmin()) throw new Forbidden('Only admins create spaces'); },
    saveItemTemplate: (id) => need(projOfItem(id), 'templates'),
    saveProjectTemplate: (pid) => need(pid, 'settings'),
    useItemTemplate: (_t, pid) => need(pid, 'create'),
    useViewTemplate: (_t, pid) => need(pid, 'views'),
    saveViewTemplate: (_v, _n, pid) => { if (pid) need(pid, 'templates'); },
    createTemplate: (i) => { if (i?.projectId) need(i.projectId, 'templates'); else if (!isAdmin()) throw new Forbidden('Only admins make workspace-wide templates; pass a project'); },
    updateTemplate: (tid) => { const t = tasks.getTemplate(tid); if (t.projectId && tasks.listProjects().some(p => p.id === t.projectId)) need(t.projectId, 'templates'); else if (!isAdmin()) throw new Forbidden('Only admins change workspace-wide templates'); },
    deleteTemplate: (tid) => { const t = tasks.getTemplate(tid); if (t.projectId && tasks.listProjects().some(p => p.id === t.projectId)) need(t.projectId, 'templates'); else if (!isAdmin()) throw new Forbidden('Only admins delete workspace-wide templates'); },
    getTemplate: (tid) => { const t = tasks.getTemplate(tid); if (t.projectId && tasks.listProjects().some(p => p.id === t.projectId)) need(t.projectId, 'view'); },
    revert: (aid) => { const a = tasks.listActivity({before: aid + 1, limit: 1})[0]; if (a) need(a.projectId, a.kind === 'delete' ? 'delete' : 'edit'); },
    createView: (i) => need(i.projectId, 'views'),
    applyPlan: (pid) => need(pid, 'edit'),
    upsertExternal: (i) => need(i.projectId, 'create'),
    installPack: (_p, pid) => { if (pid) need(pid, 'settings'); else if (!isAdmin()) throw new Forbidden('Only admins install packs workspace-wide'); },
    claimTask: (id) => need(projOfItem(id), 'edit'),
    requestApproval: (id) => need(projOfItem(id), 'edit'),
    signApproval: () => { throw new Forbidden('Sign approvals in the app; tokens cannot sign'); },
    fromEmail: (i) => need(i.projectId, 'create'),
    flow: (pid) => need(pid, 'view'),
    decideClaim: (id) => need(projOfItem(id), 'edit'),
    submitWork: (id) => need(projOfItem(id), 'edit'),
    reviewWork: (id) => need(projOfItem(id), 'edit'),
    logWork: (id) => need(projOfItem(id), 'comment'),
    attachFile: (id) => need(projOfItem(id), 'comment'),
    fileTask: (pid) => need(pid, 'create'),
    projectFiles: (pid) => need(pid, 'view'),
    workLog: (id) => need(projOfItem(id), 'view'),
    workArtifacts: (id) => need(projOfItem(id), 'view'),
    workFeedback: (id) => need(projOfItem(id), 'view'),
    confirmCleanup: (id) => need(projOfItem(id), 'comment'),
    triggerHook: (pid, _key, opts) => { need(pid, 'edit'); if (opts?.item) need(projOfItem(opts.item), 'view'); },
    webhooks: (scope) => hooks(scope), setWebhooks: (scope) => hooks(scope), testWebhook: (scope) => hooks(scope), hookDeliveries: (scope) => hooks(scope),
    itemFiles: (id) => need(projOfItem(id), 'view'),
    listComments: (id) => need(projOfItem(id), 'view'),
    approvalState: (id) => need(projOfItem(id), 'view'),
    currentSprint: (pid) => need(pid, 'view'),
    burndown: (sid) => need(tasks.sprint(sid).projectId, 'view'),
    estimateMissing: (pid) => { if (!pid) throw new Forbidden('Pass a space'); need(pid, 'view'); },
    replan: (o) => { if (!o?.projectId) throw new Forbidden('Pass a space'); need(o.projectId, 'view'); },
    forecast: (o) => { if (!o?.projectId) throw new Forbidden('Pass a space'); need(o.projectId, 'view'); },
    exportPack: (ids: string[]) => { for (const id of ids) checks.getTemplate(id); },
  };
  const filters: Record<string, (r: any) => any> = {
    listBoards: (r: any[]) => r.filter(seesBoard).map(boardOut),
    boardsBySop: (r: any) => ({made: r.made.map(boardOut), kept: r.kept.filter(seesBoard).map(boardOut)}),
    board: (b: any) => { if (!seesBoard(b)) throw new Forbidden('Not found'); return boardOut(b); },
    createBoard: boardOut, updateBoard: boardOut, boardFromItems: boardOut,
    listBoardRuns: (r: any[]) => r.filter(x => { try { return seesBoard(boardOf(x.boardId)); } catch { return false; } }),
    // Admins see the full setup; everyone else sees job role names and their own job roles.
    jobRoles: (r: any) => isAdmin() ? r : {levels: r.levels.map((l: any) => ({id: l.id, name: l.name})), jobRoles: r.jobRoles.map((j: any) => ({id: j.id, name: j.name})), people: r.people.filter((p: any) => p.id === actor), domainJoin: null},
    listProjects: (r: any[]) => r.filter(p => sees(p.id)),
    listItems: (r: any[]) => r.filter(i => sees(i.projectId)),
    listRoutines: (r: any[]) => r.filter(i => sees(i.projectId)),
    listParked: (r: any[]) => r.filter(i => sees(i.projectId)),
    listSprints: (r: any[]) => r.filter(s => sees(s.projectId)),
    listTime: (r: any[]) => r.filter(e => sees(projOfItem(e.itemId))),
    listApprovals: (r: any[]) => r.filter(a => sees(projOfItem(a.itemId))),
    view: (v: any) => { if (!sees(v.projectId)) throw new Forbidden('Not found'); return v; },
    listViews: (r: any[]) => r.filter(v => sees(v.projectId) && (!v.config.privateTo || v.config.privateTo === actor)),
    listActivity: (r: any[]) => r.filter(a => sees(a.projectId)),
    myWork: (r: Record<string, any[]>) => Object.fromEntries(Object.entries(r).map(([k, l]) => [k, l.filter(i => sees(i.projectId))])),
    findItem: (i: any) => { if (!sees(i.projectId)) throw new Forbidden('Not found'); return i; },
    item: (i: any) => { if (!sees(i.projectId)) throw new Forbidden('Not found'); return i; },
    project: (p: any) => { if (!sees(p.id)) throw new Forbidden('Not found'); return p; },
    listTemplates: (r: any[]) => r.filter(t => !t.projectId || !tasks.listProjects().some(p => p.id === t.projectId) || sees(t.projectId)),
    listChanges: (r: any) => ({...r, items: r.items.filter((i: any) => sees(i.projectId))}),
    aiQueue: (r: any[]) => r.filter(x => sees(x.item.projectId)),
  };
  return new Proxy(tasks, {
    get(target, prop, recv) {
      // Modules that keep per-workspace state (calendar sync hooks) look up the real service behind the guard.
      if (prop === Symbol.for('cadence.raw')) return target;
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function' || typeof prop !== 'string') return v;
      const check = checks[prop], filter = filters[prop];
      // Anything not listed is refused, so a new service method is closed to tokens until it gets a check.
      if (!check && !filter) { if (OPEN.has(prop)) return v.bind(target); return () => { throw new Forbidden(`${prop} is not available to tokens`); }; }
      // AI agents on "review": changes wait for their owner, unless they follow an AI SOP the owner approved.
      if (WRITE_OPS.has(prop) && needsReview(target, actor)) return (...args: unknown[]) => {
        check?.(...args);
        const sop = approvedSop(target, actor, prop, args);
        if (!sop) return propose(target, actor, prop, args);
        const out = v.apply(target, args);
        const itemId = typeof args[0] === 'string' ? args[0] : (out as {id?: string} | null)?.id;
        if (itemId) { try { target.logWork(target.findItem(itemId).id, actor, 'note', `Applied directly under approved ${sop}`); } catch { /* not an item */ } }
        return filter ? filter(out) : out;
      };
      return (...args: unknown[]) => {
        check?.(...args);
        const out = v.apply(target, args);
        return filter ? filter(out) : out;
      };
    },
  });
}
