// REST API under /api, mounted as Vite middleware in dev.
// Who is acting: in open mode the `x-person` header; once sign-in is required, the session cookie.
// Every write is checked against the actor's role in the item's project (see auth.ts).
import type {IncomingMessage, ServerResponse} from 'node:http';
import {readFileSync} from 'node:fs';
import {openDb} from './db.ts';
import {Invalid, NotFound, Tasks} from './service.ts';
import {calendarFeed, startWebhooks} from './integrations.ts';
import {exportAll, getSettings, importAll, listSnapshots, maybeSnapshot, mirrorFiles, retention, saveSettings, snapshot} from './backup.ts';
import {CAPS, CAP_LABELS, capsFor, checkPassword, cookieName, cookieToken, createSession, endSession, getWorkspace, hashPassword, migrate, saveWorkspace, sessionCookie, sessionPerson, type Access, type Cap} from './auth.ts';
import {googleCallback, googleStart, sendEmail, sendNotificationEmail} from './google.ts';
import {addEvent, calendars, events, gmailSearch, listLinks, migrateGoogleLinks, removeLink} from './googlelinks.ts';
import {acceptInvite, createInvite, findInvite, listInvites, migrateInvites, revokeInvite} from './invites.ts';
import {createToken, deleteToken, listTokens, migrateTokens, tokenPerson} from './tokens.ts';
import {handleMcpHttp} from './mcp-http.ts';
import {migratePlanning, planningPeople} from './planner.ts';
import {migrateAiWork, readFile} from './aiwork.ts';
import {migrateApprovals} from './approvals.ts';
import {archiveWorkspace, createWorkspace, listWorkspaces, publicInfo, reorderWorkspaces, updateWorkspace, workspaceDir, type WorkspaceInfo} from './workspaces.ts';
import {join} from 'node:path';
import {seedSampleWorkspaces} from './demo.ts';
import type {ChangeEvent, Project} from '../src/types.ts';

type Next = (err?: unknown) => void;
const ITEM_FIELDS = new Set(['parentId', 'type', 'title', 'body', 'status', 'priority', 'assignees', 'start', 'due', 'estimate', 'tags', 'sprint', 'sort', 'recur', 'fields', 'projectId', 'deps']);
const DUMMY_HASH = hashPassword('not-a-real-password-just-timing');
const loginTries = new Map<string, number[]>();
class Denied extends Error {}

async function readJson(req: IncomingMessage, limit = 2_000_000): Promise<any> {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > limit) throw new Invalid('Request body is too large'); }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new Invalid('Body must be JSON'); }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data ?? null));
}

type Handler = (req: IncomingMessage, res: ServerResponse, next: Next) => Promise<void> | void;
const cookieValue = (cookie: string | undefined, name: string) => cookie?.split(';').map(c => c.trim().split('=')).find(([k]) => k === name)?.[1];

/**
 * Mounts the API. Each workspace gets its own handler and database, opened on first use. The workspace comes
 * from the x-workspace header, then ?ws=, then the tasks_ws cookie (set by the app's switcher), else "main".
 * Passing a Tasks instance (tests) serves just that one.
 */
export function apiMiddleware(single?: Tasks): Handler {
  if (single) return workspaceApi(single, {id: 'main', dir: single.dataDir, main: true}, () => single);
  const handlers = new Map<string, {h: Handler; tasks: Tasks}>();
  const close = (id: string) => { const x = handlers.get(id); if (x) { x.tasks.db.close(); handlers.delete(id); } };
  const open = (w: WorkspaceInfo): {h: Handler; tasks: Tasks} => {
    let x = handlers.get(w.id);
    if (!x) {
      const tasks = new Tasks(openDb(w.db));
      tasks.dataDir = workspaceDir(w);
      x = {tasks, h: workspaceApi(tasks, {id: w.id, dir: workspaceDir(w), main: w.id === 'main'}, (ww): Tasks => open(ww).tasks, close)};
      handlers.set(w.id, x);
    }
    return x;
  };
  if (process.env.TASKS_DEMO === '1') seedSampleWorkspaces(w => open(w).tasks);
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/mcp' && !url.pathname.startsWith('/api/')) return next();
    const asked = String(req.headers['x-workspace'] ?? '') || url.searchParams.get('ws') || '';
    const list = listWorkspaces();
    const w = list.find(x => x.id === (asked || cookieValue(req.headers.cookie, 'tasks_ws') || 'main')) ?? (asked ? null : list[0]);
    if (!w) return send(res, 404, {error: 'Unknown workspace'});
    return open(w).h(req, res, next);
  };
}

function workspaceApi(tasks: Tasks, info: {id: string; dir: string; main: boolean}, openTasks: (w: WorkspaceInfo) => Tasks, closeWorkspace: (id: string) => void = () => {}): Handler {
  // The main workspace keeps backups in data/backups (or TASKS_BACKUPS); others in their own folder.
  const bdir = info.main ? undefined : join(info.dir, 'backups');
  migrate(tasks.db);
  migrateTokens(tasks.db);
  migratePlanning(tasks);
  migrateAiWork(tasks);
  migrateApprovals(tasks);
  migrateInvites(tasks.db);
  migrateGoogleLinks(tasks.db);
  if (info.main) tasks.seedIfEmpty();
  migrate(tasks.db); // marks the first person as admin once people exist
  // Every workspace gets an All projects rollup at the top, once. Deleting it is respected.
  if (!tasks.db.prepare("select 1 from workspace where key = 'rollup-added'").get()) {
    if (!tasks.listProjects().some(p => p.settings.rollup)) tasks.createRollup();
    tasks.db.prepare("insert into workspace (key, value) values ('rollup-added', '1') on conflict(key) do nothing").run();
  }
  // Scheduled snapshots: checked on start and every 10 minutes against the saved interval.
  const auto = () => { try { maybeSnapshot(tasks.db, bdir); mirrorFiles(join(tasks.dataDir, 'files'), bdir); } catch (e) { console.error('Snapshot failed', e); } };
  auto();
  setInterval(auto, 10 * 60 * 1000).unref();
  // Due-date automations and sprint rollover, checked on start and hourly.
  const periodic = () => { try { tasks.periodic(); } catch (e) { console.error('Periodic check failed', e); } };
  periodic();
  setInterval(periodic, 3600 * 1000).unref();
  startWebhooks(tasks);
  tasks.onNotify(n => { sendNotificationEmail(tasks.db, n).catch(e => console.error('Email notification failed', e.message)); });
  // Live updates go only to people who can see the project the change belongs to.
  const clients = new Map<ServerResponse, string | null>();
  const eventProject = (e: ChangeEvent): string | null =>
    e.kind === 'item' ? e.item.projectId : e.kind === 'item-deleted' || e.kind === 'sprint' || e.kind === 'view' ? e.projectId : e.kind === 'project' ? e.project.id : null;
  const broadcast = (e: ChangeEvent) => {
    const pid = eventProject(e);
    for (const [c, who] of clients) {
      if (pid && getWorkspace(tasks.db).requireLogin) {
        try { if (!capsFor(tasks.db, who, (tasks.project(pid).settings as {access?: Access}).access).has('view')) continue; } catch { continue; }
      }
      c.write(`data: ${JSON.stringify(e)}\n\n`);
    }
  };
  tasks.on(broadcast);

  // Writes from another process (the MCP server) bump data_version; tell clients to refetch.
  let version = (tasks.db.prepare('pragma data_version').get() as {data_version: number}).data_version;
  const timer = setInterval(() => {
    const v = (tasks.db.prepare('pragma data_version').get() as {data_version: number}).data_version;
    if (v !== version) { version = v; broadcast({kind: 'refresh'}); }
  }, 1000);
  timer.unref();

  const isAdmin = (pid: string | null) => !!pid && !!(tasks.db.prepare('select admin from people where id = ?').get(pid) as {admin: number} | undefined)?.admin;
  const access = (p: Project) => (p.settings as {access?: Access}).access;
  const caps = (actor: string | null, projectId: string, strict = false) => capsFor(tasks.db, actor, access(tasks.project(projectId)), strict);
  const team = () => tasks.db.prepare('select id, name, email, color, role, admin, active, notify_email, kind, password is not null as has_password from people order by name').all()
    .map(r => ({id: r.id, name: r.name, email: r.email ?? '', color: r.color, role: r.role, admin: !!r.admin, active: !!r.active, notifyEmail: !!r.notify_email, hasPassword: !!r.has_password, kind: r.kind === 'ai' ? 'ai' : 'human'}));

  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? '/', 'http://local');
    // MCP over HTTP for remote AI apps: token required, every tool permission-checked.
    if (url.pathname === '/mcp') return handleMcpHttp(tasks, req, res);
    if (!url.pathname.startsWith('/api/')) return next();
    const parts = url.pathname.slice(5).split('/').filter(Boolean);
    const m = req.method ?? 'GET';
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const ws = getWorkspace(tasks.db);
    const token = cookieToken(req.headers.cookie, info.id);
    // A bearer token (AI agents, other systems) wins; then the session; then, in open mode, the x-person header.
    const bearer = tokenPerson(tasks.db, req.headers.authorization);
    if (req.headers.authorization && !bearer) return send(res, 401, {error: 'Invalid or revoked token'});
    const actor = bearer ?? (ws.requireLogin ? sessionPerson(tasks.db, token) : ((req.headers['x-person'] as string) || null));
    const [a, b, c] = parts;
    try {
      // Cross-site protection: writes must be JSON from this app's own origin. Browsers cannot send
      // application/json cross-origin without a preflight, and the dev server answers no preflights.
      if (m !== 'GET' && m !== 'HEAD') {
        const origin = req.headers.origin, host = req.headers.host;
        if (!bearer && origin && origin !== `http://${host}` && origin !== `https://${host}`) return send(res, 403, {error: 'Cross-origin request refused'});
        const ct = String(req.headers['content-type'] ?? '');
        if (m !== 'DELETE' && !ct.startsWith('application/json') && !(a === 'auth' && b === 'logout')) return send(res, 415, {error: 'Send JSON with content-type application/json'});
      }
      const body = m === 'GET' || m === 'DELETE' ? {} : await readJson(req, a === 'import' ? 100_000_000 : c === 'files' || c === 'file-tasks' ? 15_000_000 : 2_000_000);
      const num = (v: string | undefined, d: number, max: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : d; };
      const need = (projectId: string, cap: Cap) => { if (!caps(actor, projectId, !!bearer).has(cap)) throw new Denied(`You need "${CAP_LABELS[cap]}" permission in this project`); };
      const needAdmin = () => { if ((ws.requireLogin || bearer) && !isAdmin(actor)) throw new Denied('Only workspace admins can do this'); };
      const canSee = (projectId: string) => caps(actor, projectId, !!bearer).has('view');

      // ---- Sign-in (always reachable) ----
      if (a === 'auth') {
        if (b === 'me' && m === 'GET') {
          const me = actor ? tasks.listPeople().find(p => p.id === actor) ?? null : null;
          return send(res, 200, {required: ws.requireLogin, person: me, admin: !ws.requireLogin || isAdmin(actor), googleReady: !!(ws.google.clientId && ws.google.clientSecret),
            caps: Object.fromEntries(tasks.listProjects().map(p => [p.id, [...caps(actor, p.id)]]))});
        }
        if (b === 'login' && m === 'POST') {
          const email = String(body.email ?? '').trim().toLowerCase();
          const key = `${email}|${req.socket.remoteAddress}`;
          const tries = (loginTries.get(key) ?? []).filter(t => Date.now() - t < 15 * 60_000);
          if (tries.length >= 8) return send(res, 429, {error: 'Too many attempts. Wait 15 minutes and try again.'});
          const r = tasks.db.prepare('select id, password, active from people where lower(email) = ?').get(email) as {id: string; password: string | null; active: number} | undefined;
          // Always run the hash so response time does not reveal whether the email exists.
          const ok = checkPassword(String(body.password ?? ''), r?.password ?? DUMMY_HASH) && !!r && !!r.active;
          if (!ok) { loginTries.set(key, [...tries, Date.now()]); return send(res, 401, {error: 'Email or password is wrong'}); }
          loginTries.delete(key);
          res.setHeader('set-cookie', sessionCookie(createSession(tasks.db, r.id), info.id));
          return send(res, 200, {ok: true});
        }
        if (b === 'logout' && m === 'POST') { endSession(tasks.db, token); res.setHeader('set-cookie', `${cookieName(info.id)}=; Path=/; Max-Age=0`); return send(res, 200, {ok: true}); }
        if (b === 'google' && c === 'start') {
          const mode = q('mode') === 'connect' ? 'connect' : q('mode') === 'link' ? 'link' : 'login';
          // A browser link cannot send x-person, so in open mode the app passes ?as=.
          const who = actor ?? (!ws.requireLogin ? q('as') ?? null : null);
          return googleStart(tasks.db, req, res, mode, who, (q('want') ?? 'calendar').split(',').filter((w): w is 'calendar' | 'gmail' => w === 'calendar' || w === 'gmail'));
        }
        if (b === 'google' && c === 'callback') return googleCallback(tasks.db, req, res, url, actor, info.id);
      }
      // ---- Invites: the link works while signed out; accepting signs you in ----
      if (a === 'invites' && b && b.length > 20) {
        if (!c && m === 'GET') {
          const inv = findInvite(tasks.db, b);
          const w = listWorkspaces().find(x => x.id === info.id);
          return send(res, 200, {email: inv.email, name: inv.name, role: ws.roles.find(r => r.id === inv.role)?.name ?? inv.role, workspace: w?.name ?? 'Tasks',
            invitedBy: inv.by ? tasks.listPeople().find(p => p.id === inv.by)?.name ?? null : null, googleReady: !!(ws.google.clientId && ws.google.clientSecret)});
        }
        if (c === 'accept' && m === 'POST') {
          const key = `invite|${req.socket.remoteAddress}`;
          const tries = (loginTries.get(key) ?? []).filter(t => Date.now() - t < 15 * 60_000);
          if (tries.length >= 20) return send(res, 429, {error: 'Too many attempts. Wait 15 minutes and try again.'});
          loginTries.set(key, [...tries, Date.now()]);
          const pid = acceptInvite(tasks.db, b, body, (name, email) => tasks.createPerson({name, email}).id);
          res.setHeader('set-cookie', sessionCookie(createSession(tasks.db, pid), info.id));
          return send(res, 200, {ok: true, person: pid});
        }
      }
      if (ws.requireLogin && !actor) return send(res, 401, {error: 'Please sign in', signIn: true});

      // ---- API tokens for AI agents and integrations ----
      if (a === 'tokens') {
        if (!b && m === 'GET') return send(res, 200, listTokens(tasks.db, !ws.requireLogin || isAdmin(actor) ? undefined : actor ?? ''));
        if (!b && m === 'POST') {
          const person = body.person ?? actor;
          if (!person) throw new Invalid('Pick who the token acts as');
          if (person !== actor) needAdmin();
          if (bearer) throw new Denied('Tokens cannot create tokens');
          return send(res, 201, createToken(tasks.db, person, String(body.name ?? 'Token')));
        }
        if (b && m === 'DELETE') {
          const t = listTokens(tasks.db).find(x => x.id === b);
          if (!t) throw new NotFound('Token not found');
          if (t.person !== actor) needAdmin();
          deleteToken(tasks.db, b); return send(res, 200, {ok: true});
        }
      }
      if (a === 'guide' && m === 'GET') {
        res.statusCode = 200; res.setHeader('content-type', 'text/markdown; charset=utf-8');
        res.end(readFileSync(new URL('../docs/AI-GUIDE.md', import.meta.url), 'utf8'));
        return;
      }

      // ---- Invites (admins) ----
      if (a === 'invites' && (!b || b.length <= 20)) {
        needAdmin();
        if (!b && m === 'GET') return send(res, 200, listInvites(tasks.db));
        if (!b && m === 'POST') {
          const {invite, secret} = createInvite(tasks.db, body, actor, ws.roles.map(r => r.id));
          const origin = typeof req.headers.origin === 'string' && /^https?:\/\//.test(req.headers.origin) ? req.headers.origin : `http://${req.headers.host}`;
          const link = `${origin}/?ws=${info.id}#/invite/${secret}`;
          const who = actor ? tasks.listPeople().find(p => p.id === actor)?.name ?? 'Someone' : 'Someone';
          const wname = listWorkspaces().find(x => x.id === info.id)?.name ?? 'Cadence';
          let emailed = false;
          try { emailed = await sendEmail(tasks.db, invite.email, `${who} invited you to ${wname} on Cadence`, `${who} invited you to the ${wname} workspace on Cadence.\n\nJoin here (the link works once and expires in 7 days):\n${link}`); } catch (e) { console.error('Invite email failed', e); }
          return send(res, 201, {...invite, link, emailed});
        }
        if (b && m === 'DELETE') { revokeInvite(tasks.db, b); return send(res, 200, {ok: true}); }
      }
      // ---- Personal Google connections: calendars, events, Gmail ----
      if (a === 'google') {
        if (!actor) throw new Invalid('Pick who you are first');
        if (b === 'links' && !c && m === 'GET') return send(res, 200, listLinks(tasks.db, actor));
        if (b === 'links' && c && m === 'DELETE') { removeLink(tasks.db, actor, c); return send(res, 200, {ok: true}); }
        if (b === 'calendars' && m === 'GET') return send(res, 200, await calendars(tasks.db, actor, q('link') ?? ''));
        if (b === 'events' && m === 'GET') return send(res, 200, await events(tasks.db, actor, q('from') ?? '', q('to') ?? ''));
        if (b === 'events' && m === 'POST') return send(res, 201, await addEvent(tasks.db, actor, String(body.link ?? ''), String(body.calendar ?? 'primary'), {title: String(body.title ?? ''), date: String(body.date ?? ''), description: body.description}));
        if (b === 'gmail' && m === 'GET') return send(res, 200, await gmailSearch(tasks.db, actor, q('link') ?? '', q('q') ?? 'in:inbox', num(q('max'), 10, 25)));
      }
      // ---- Workspaces: list, create, rename, recolor, reorder ----
      if (a === 'workspaces') {
        if (!b && m === 'GET') return send(res, 200, {current: info.id, list: listWorkspaces().map(publicInfo)});
        if (!b && m === 'POST') {
          needAdmin();
          const w = createWorkspace(body);
          // The creator joins the new workspace as its admin, with a first project to start in.
          const t = openTasks(w);
          const me = actor ? tasks.listPeople().find(p => p.id === actor) : null;
          const p = t.createPerson({name: me?.name ?? (String(body.ownerName ?? '').trim() || 'Me'), email: me?.email ?? undefined});
          t.db.prepare('update people set admin = 1 where id = ?').run(p.id);
          t.createProject({name: String(body.firstProject ?? '').trim() || 'General'});
          return send(res, 201, {...publicInfo(w), me: p.id});
        }
        if (b === 'order' && m === 'PUT') { needAdmin(); if (!Array.isArray(body.ids)) throw new Invalid('ids must be a list'); return send(res, 200, reorderWorkspaces(body.ids.map(String).filter((x: string) => listWorkspaces().some(w => w.id === x))).map(publicInfo)); }
        if (b && m === 'DELETE') {
          if (b !== info.id) throw new Invalid('Open the workspace to delete it');
          if (b === 'main') throw new Invalid('The first workspace cannot be deleted');
          needAdmin();
          if (String(body.confirm ?? q('confirm') ?? '') !== listWorkspaces().find(x => x.id === b)?.name) throw new Invalid('Type the workspace name to confirm');
          closeWorkspace(b);
          return send(res, 200, {ok: true, movedTo: archiveWorkspace(b)});
        }
        if (b && m === 'PATCH') { if (b !== info.id) throw new Invalid('Open the workspace to change it'); needAdmin(); return send(res, 200, publicInfo(updateWorkspace(b, body))); }
      }
      if (a === 'events') {
        res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
        res.write(': connected\n\n');
        clients.set(res, actor);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (a === 'bootstrap' && m === 'GET') {
        const projects = tasks.listProjects().filter(p => canSee(p.id)), ids = new Set(projects.map(p => p.id));
        return send(res, 200, {
          people: tasks.listPeople(), projects, items: tasks.listItems().filter(i => ids.has(i.projectId)), today: tasks.today(),
          sprints: tasks.listSprints().filter(s => ids.has(s.projectId)), views: projects.flatMap(p => tasks.listViews(p.id, actor)),
        });
      }

      // ---- Team, roles, workspace (admins) ----
      if (a === 'team') {
        if (!b && m === 'GET') return send(res, 200, {people: team(), roles: ws.roles, caps: CAPS.map(id => ({id, label: CAP_LABELS[id]}))});
        if (b && m === 'PATCH') {
          const self = b === actor;
          // People may change their own password and email preferences; everything else needs an admin.
          if (!self || body.role !== undefined || body.admin !== undefined || body.active !== undefined) needAdmin();
          if (body.admin === false && b === actor && ws.requireLogin) throw new Invalid('You cannot remove your own admin rights');
          if (body.email !== undefined) {
            const email = String(body.email).trim().toLowerCase();
            if (email && !/^[^\s@<>",;:]+@[^\s@<>",;:]+\.[a-z]{2,}$/i.test(email)) throw new Invalid('That email address does not look valid');
            if (email && tasks.db.prepare('select 1 from people where lower(email) = ? and id != ?').get(email, b)) throw new Invalid('Another person already uses that email');
            tasks.db.prepare('update people set email = ? where id = ?').run(email || null, b);
          }
          if (body.name !== undefined) {
            const name = String(body.name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
            if (name) tasks.db.prepare('update people set name = ? where id = ?').run(name, b);
          }
          if (body.role !== undefined) tasks.db.prepare('update people set role = ? where id = ?').run(body.role, b);
          if (body.admin !== undefined) tasks.db.prepare('update people set admin = ? where id = ?').run(body.admin ? 1 : 0, b);
          if (body.active !== undefined) tasks.db.prepare('update people set active = ? where id = ?').run(body.active ? 1 : 0, b);
          if (body.kind !== undefined) { needAdmin(); tasks.db.prepare('update people set kind = ? where id = ?').run(body.kind === 'ai' ? 'ai' : 'human', b); }
          if (body.notifyEmail !== undefined) tasks.db.prepare('update people set notify_email = ? where id = ?').run(body.notifyEmail ? 1 : 0, b);
          if (body.password) {
            // Changing your own password needs the current one (when you have one); admins can reset others.
            const cur = (tasks.db.prepare('select password from people where id = ?').get(b) as {password: string | null}).password;
            if (ws.requireLogin && self && cur && !checkPassword(String(body.currentPassword ?? ''), cur)) throw new Invalid('Your current password is wrong');
            tasks.db.prepare('update people set password = ? where id = ?').run(hashPassword(String(body.password)), b);
            tasks.db.prepare('delete from sessions where person = ? and token != ?').run(b, token ?? '');
          }
          tasks.emit({kind: 'people'});
          return send(res, 200, team().find(p => p.id === b));
        }
      }
      if (a === 'workspace') {
        if (m === 'GET') return send(res, 200, {...ws, google: {clientId: ws.google.clientId, hasSecret: !!ws.google.clientSecret, senderEmail: ws.google.senderEmail ?? null, connected: !!ws.google.refreshToken}});
        if (m === 'PUT') {
          needAdmin();
          if (body.requireLogin && !ws.requireLogin) {
            const me = team().find(p => p.id === actor);
            if (!me?.admin || !me.email || !me.hasPassword) throw new Invalid('Before requiring sign in, give yourself an email and a password, and make sure you are an admin, so you can sign back in');
          }
          const patch: Record<string, unknown> = {};
          if (body.requireLogin !== undefined) patch.requireLogin = !!body.requireLogin;
          if (body.roles) patch.roles = body.roles;
          if (body.google) patch.google = {...ws.google, clientId: body.google.clientId ?? ws.google.clientId, ...(body.google.clientSecret ? {clientSecret: body.google.clientSecret} : {})};
          try { saveWorkspace(tasks.db, patch); } catch (e) { throw new Invalid(e instanceof Error ? e.message : 'Bad settings'); }
          return send(res, 200, {ok: true});
        }
      }

      if (a === 'sprints') {
        if (!b && m === 'GET') return send(res, 200, tasks.listSprints(q('projectId')).filter(s => canSee(s.projectId)));
        if (!b && m === 'POST') { need(body.projectId, 'sprints'); return send(res, 201, tasks.createSprint(body)); }
        const s = b ? tasks.sprint(b) : null;
        if (s && c === 'burndown' && m === 'GET') { need(s.projectId, 'view'); return send(res, 200, tasks.burndown(s.id)); }
        if (s) need(s.projectId, 'sprints');
        if (s && c === 'rollover' && m === 'POST') return send(res, 200, tasks.rolloverSprint(s.id, actor));
        if (s && !c && m === 'PATCH') return send(res, 200, tasks.updateSprint(s.id, body));
        if (s && !c && m === 'DELETE') { tasks.deleteSprint(s.id); return send(res, 200, {ok: true}); }
      }

      if (a === 'views') {
        if (!b && m === 'GET') { need(q('projectId') ?? '', 'view'); return send(res, 200, tasks.listViews(q('projectId') ?? '', actor)); }
        if (!b && m === 'POST') { need(body.projectId, 'views'); return send(res, 201, tasks.createView(body)); }
        if (b === 'order' && m === 'PUT') { need(String(body.projectId ?? ''), 'views'); return send(res, 200, tasks.reorderViews(String(body.projectId), (body.ids ?? []).map(String))); }
        const vr = b ? tasks.db.prepare('select project_id from views where id = ?').get(b) as {project_id: string} | undefined : undefined;
        if (b && !vr) throw new NotFound('View not found');
        if (vr) need(vr.project_id, 'views');
        // Only the owner can make a view private to themselves; nobody can make it private to someone else.
        if (b && m === 'PATCH') { if (body.config?.privateTo && body.config.privateTo !== actor) throw new Invalid('A view can only be made private to yourself'); return send(res, 200, tasks.updateView(b, body)); }
        if (b && m === 'DELETE') { tasks.deleteView(b); return send(res, 200, {ok: true}); }
      }

      if (a === 'calendar.ics' && m === 'GET') {
        if (q('project')) need(q('project')!, 'view');
        res.statusCode = 200;
        res.setHeader('content-type', 'text/calendar; charset=utf-8');
        const feed = calendarFeed(tasks, {person: q('person'), project: q('project'), baseUrl: `http://${req.headers.host}`, canSee});
        res.end(feed);
        return;
      }
      if (a === 'packs') {
        if (b === 'gallery' && m === 'GET') return send(res, 200, tasks.gallery());
        if (b === 'install' && m === 'POST') { if (body.projectId) need(body.projectId, 'settings'); else needAdmin(); return send(res, 200, tasks.installPack(body.pack ?? {gallery: body.gallery}, body.projectId, !!body.withAutomations)); }
        if (b === 'export' && m === 'POST') {
          res.setHeader('content-disposition', `attachment; filename="${String(body.name || 'templates').replace(/[^\w-]+/g, '-')}.tasks-pack.json"`);
          return send(res, 200, tasks.exportPack(body.ids ?? [], body.name ?? '', body.description ?? ''));
        }
      }
      if (a === 'templates') {
        if (!b && m === 'GET') return send(res, 200, tasks.listTemplates(q('kind') as 'item' | 'project' | undefined).filter(t => !t.projectId || !tasks.listProjects().some(p => p.id === t.projectId) || canSee(t.projectId)));
        // Who may change a template: its project's template managers, or admins for workspace-wide ones.
        const manage = (t: {projectId: string | null}) => { if (t.projectId && tasks.listProjects().some(p => p.id === t.projectId)) need(t.projectId, 'templates'); else needAdmin(); };
        if (!b && m === 'POST' && (body.data !== undefined || body.blank)) {
          manage({projectId: body.projectId ?? null});
          return send(res, 201, tasks.createTemplate({kind: body.kind, name: body.name ?? '', data: body.data, projectId: body.projectId ?? null}));
        }
        if (b && !c && m === 'GET') { const t = tasks.getTemplate(b); if (t.projectId && tasks.listProjects().some(p => p.id === t.projectId)) need(t.projectId, 'view'); return send(res, 200, t); }
        if (b && !c && m === 'PATCH') { manage(tasks.getTemplate(b)); return send(res, 200, tasks.updateTemplate(b, {name: body.name, data: body.data})); }
        if (b && c === 'duplicate' && m === 'POST') { manage(tasks.getTemplate(b)); return send(res, 201, tasks.duplicateTemplate(b)); }
        if (!b && m === 'POST') {
          if (body.kind === 'view') { const v = tasks.listViews(String(body.projectId ?? '')).find(x => x.id === body.viewId); if (!v) throw new NotFound('View not found'); need(v.projectId, 'templates'); return send(res, 201, tasks.saveViewTemplate(v.id, body.name ?? '', v.projectId)); }
          if (body.kind === 'project') { need(body.projectId, 'settings'); return send(res, 201, tasks.saveProjectTemplate(body.projectId, body.name ?? '', !!body.includeItems)); }
          need(tasks.findItem(body.itemId).projectId, 'templates');
          return send(res, 201, tasks.saveItemTemplate(body.itemId, body.name ?? ''));
        }
        if (b && c === 'use' && m === 'POST') {
          const t = tasks.listTemplates().find(x => x.id === b);
          if (!t) throw new NotFound('Template not found');
          if (t.projectId && tasks.listProjects().some(p => p.id === t.projectId)) need(t.projectId, 'view');
          if (t.kind === 'project') { needAdmin(); return send(res, 201, tasks.createProjectFromTemplate(b, body.name ?? t.name, actor)); }
          if (t.kind === 'view') { need(body.projectId, 'views'); return send(res, 201, tasks.useViewTemplate(b, body.projectId)); }
          need(body.projectId, 'create');
          return send(res, 201, tasks.useItemTemplate(b, body.projectId, body.parentId ?? null, actor, {title: body.title, due: body.due || undefined, start: body.start || undefined}));
        }
        if (b && m === 'DELETE') {
          const t = tasks.listTemplates().find(x => x.id === b);
          if (t?.projectId && tasks.listProjects().some(p => p.id === t.projectId)) need(t.projectId, 'templates'); else needAdmin();
          tasks.deleteTemplate(b); return send(res, 200, {ok: true});
        }
      }
      if (a === 'items' && b && c === 'apply-to-children' && m === 'POST') {
        const it = tasks.findItem(b);
        need(it.projectId, 'edit');
        return send(res, 200, tasks.applyToChildren(it.id, body.keys ?? [], actor));
      }

      if (a === 'export' && m === 'GET') {
        needAdmin();
        res.setHeader('content-disposition', `attachment; filename="tasks-export-${new Date().toISOString().slice(0, 10)}.json"`);
        return send(res, 200, exportAll(tasks.db));
      }
      if (a === 'import' && m === 'POST') { needAdmin(); const r = importAll(tasks.db, body, bdir); migrate(tasks.db); tasks.emit({kind: 'refresh'}); return send(res, 200, r); }
      if (a === 'backup-settings') {
        if (m === 'GET') return send(res, 200, getSettings(bdir));
        if (m === 'PUT') { needAdmin(); try { return send(res, 200, saveSettings(body, bdir)); } catch (e) { throw new Invalid(e instanceof Error ? e.message : 'Bad settings'); } }
      }
      if (a === 'backups') {
        if (m === 'GET') return send(res, 200, retention(listSnapshots(bdir), getSettings(bdir)));
        if (m === 'POST') { needAdmin(); mirrorFiles(join(tasks.dataDir, 'files'), bdir); return send(res, 201, {file: snapshot(tasks.db, 'manual', bdir)}); }
      }

      if (a === 'people') {
        if (m === 'GET') return send(res, 200, tasks.listPeople());
        if (m === 'POST') { needAdmin(); return send(res, 201, tasks.createPerson(body)); }
      }

      if (a === 'projects') {
        if (!b && m === 'GET') return send(res, 200, tasks.listProjects().filter(p => canSee(p.id)));
        if (b === 'rollup' && m === 'POST') { needAdmin(); return send(res, 201, tasks.createRollup(String(body.name ?? '').trim() || undefined)); }
        if (!b && m === 'POST') { needAdmin(); return send(res, 201, tasks.createProject(body)); }
        if (b && c === 'files' && m === 'GET') { need(b, 'view'); return send(res, 200, tasks.projectFiles(b)); }
        if (b && c === 'file-tasks' && m === 'POST') { need(b, 'create'); return send(res, 201, tasks.fileTask(b, actor, {name: String(body.name ?? 'file'), mime: String(body.mime ?? ''), data: String(body.data ?? ''), parentId: body.parentId ?? null, status: body.status})); }
        if (b && !c && m === 'GET') { need(b, 'view'); return send(res, 200, tasks.project(b)); }
        if (b && m === 'PATCH') {
          // Access rules decide who can do anything, so only admins may change them.
          if (body.settings && JSON.stringify((body.settings as {access?: Access}).access ?? null) !== JSON.stringify(access(tasks.project(b)) ?? null)) needAdmin();
          need(b, 'settings');
          return send(res, 200, tasks.updateProject(b, body));
        }
        if (b && m === 'DELETE') { needAdmin(); tasks.deleteProject(b); return send(res, 200, {ok: true}); }
      }

      if (a === 'items') {
        if (!b && m === 'GET') return send(res, 200, tasks.listItems({
          projectId: q('projectId'), assignee: q('assignee'), status: q('status'), text: q('text'),
          dueBefore: q('dueBefore'), open: q('open') === 'true',
        }).filter(i => canSee(i.projectId)));
        if (!b && m === 'POST') {
          need(body.projectId, 'create');
          for (const k of Object.keys(body)) if (!ITEM_FIELDS.has(k) && k !== 'projectId') delete body[k];
          for (const d of (body.deps ?? []) as string[]) need(tasks.item(d).projectId, 'view');
          return send(res, 201, tasks.createItem(body, actor));
        }
        if (b === 'quick' && m === 'POST') { need(body.projectId, 'create'); return send(res, 201, tasks.quickAdd(body, actor)); }
        const it = b ? tasks.findItem(b) : null;
        if (it) need(it.projectId, 'view');
        if (it && c === 'comments') {
          if (m === 'GET') return send(res, 200, tasks.listComments(it.id));
          if (m === 'POST') { need(it.projectId, 'comment'); if (!actor && !body.author) throw new Invalid('Pick who you are before commenting'); return send(res, 201, tasks.addComment(it.id, actor ?? body.author, body.body ?? '', body.assignee || null)); }
        }
        if (it && !c && m === 'GET') return send(res, 200, it);
        if (it && !c && m === 'PATCH') {
          need(it.projectId, 'edit');
          for (const k of Object.keys(body)) if (!ITEM_FIELDS.has(k)) delete body[k];
          for (const d of (body.deps ?? []) as string[]) need(tasks.item(d).projectId, 'view');
          if (body.parentId) need(tasks.item(body.parentId).projectId, 'view');
          if (body.projectId && body.projectId !== it.projectId) need(body.projectId, 'create');
          return send(res, 200, tasks.updateItem(it.id, body, actor, {keep: q('keep') === '1'}));
        }
        if (it && !c && m === 'DELETE') { need(it.projectId, 'delete'); return send(res, 200, tasks.deleteItem(it.id, actor)); }
      }

      if (a === 'timesheet') {
        // Your own week; admins can see and fill anyone's.
        const person = String((m === 'GET' ? q('person') : body.person) ?? actor ?? '');
        if (ws.requireLogin && person !== actor) needAdmin();
        if (m === 'GET') { const t = tasks.timesheet(person, q('week') ?? ''); return send(res, 200, {...t, rows: t.rows.filter(r => { try { return canSee(tasks.item(r.itemId).projectId); } catch { return false; } })}); }
        if (m === 'PUT') { need(tasks.findItem(String(body.itemId ?? '')).projectId, 'edit'); return send(res, 200, tasks.setDayMinutes(person, String(body.itemId), String(body.date ?? ''), Number(body.minutes))); }
      }
      if (a === 'time') {
        // Signed in, you can only log or time your own work.
        const person = ws.requireLogin ? actor : (actor ?? q('person') ?? body.person);
        if (!b && m === 'GET') return send(res, 200, tasks.listTime({itemId: q('itemId'), person: q('person')}).filter(t => { try { return canSee(tasks.item(t.itemId).projectId); } catch { return false; } }));
        if (!b && m === 'POST') { need(tasks.findItem(body.itemId).projectId, 'edit'); return send(res, 201, tasks.logTime({...body, person: ws.requireLogin ? actor : body.person ?? person})); }
        if (b === 'running' && m === 'GET') return send(res, 200, person ? tasks.runningTimer(person) : null);
        if (b === 'start' && m === 'POST') { need(tasks.findItem(body.itemId).projectId, 'edit'); return send(res, 201, tasks.startTimer(body.itemId, ws.requireLogin ? actor! : body.person ?? person)); }
        if (b === 'stop' && m === 'POST') return send(res, 200, tasks.stopTimer(ws.requireLogin ? actor! : body.person ?? person));
        if (b && m === 'DELETE') {
          const e = tasks.db.prepare('select person, item_id from time_entries where id = ?').get(b) as {person: string; item_id: string} | undefined;
          if (!e) throw new NotFound('Time entry not found');
          if (e.person !== actor) { need(tasks.item(e.item_id).projectId, 'edit'); needAdmin(); }
          tasks.deleteTime(b); return send(res, 200, {ok: true});
        }
      }

      if (a === 'notifications') {
        const person = ws.requireLogin ? actor : q('person') ?? actor;
        if (!person) throw new Invalid('person is required');
        if (!b && m === 'GET') return send(res, 200, tasks.listNotifications(person, q('unread') === 'true'));
        if (b === 'read' && m === 'POST') { tasks.markRead(person, body.ids); return send(res, 200, {ok: true}); }
      }

      if (a === 'activity') {
        if (!b && m === 'GET') return send(res, 200, tasks.listActivity({itemId: q('itemId'), projectId: q('projectId'), limit: num(q('limit'), 100, 500), before: q('before') ? num(q('before'), 0, Number.MAX_SAFE_INTEGER) : undefined}).filter(x => canSee(x.projectId)));
        if (b && c === 'revert' && m === 'POST') {
          const act = tasks.listActivity({before: Number(b) + 1, limit: 1})[0];
          if (!act || act.id !== Number(b)) throw new NotFound('Change not found');
          need(act.projectId, act.kind === 'delete' ? 'delete' : 'edit');
          return send(res, 200, tasks.revert(Number(b), actor));
        }
      }

      // ---- Planning: estimates, replan with approval, forecast ----
      if (a === 'plan') {
        const pid = q('projectId') ?? body.projectId;
        if (pid) need(pid, 'view');
        if (b === 'estimates' && m === 'GET') return send(res, 200, tasks.estimateMissing(pid).filter(e => canSee(tasks.item(e.itemId).projectId)));
        if (b === 'estimates' && m === 'POST') {
          let n = 0;
          for (const e of (body.estimates ?? []) as {itemId: string; hours: number}[]) { need(tasks.item(e.itemId).projectId, 'edit'); tasks.updateItem(e.itemId, {estimate: Number(e.hours)}, actor); n++; }
          return send(res, 200, {applied: n});
        }
        if (b === 'replan' && m === 'GET') {
          const r = tasks.replan({projectId: pid, reassign: q('reassign') === 'true'});
          return send(res, 200, {...r, changes: r.changes.filter(c => canSee(tasks.item(c.itemId).projectId))});
        }
        if (b === 'apply' && m === 'POST') {
          const changes = (body.changes ?? []) as {itemId: string}[];
          for (const c of changes) need(tasks.item(c.itemId).projectId, 'edit');
          let n = 0;
          for (const p of new Set(changes.map(c => tasks.item(c.itemId).projectId))) n += tasks.applyPlan(p, changes.filter(c => tasks.item(c.itemId).projectId === p) as never, actor).applied;
          return send(res, 200, {applied: n});
        }
        if (b === 'forecast' && m === 'GET') { if (!pid) needAdmin(); return send(res, 200, tasks.forecast({projectId: pid, months: num(q('months'), 6, 24)})); }
        if (b === 'people' && m === 'GET') return send(res, 200, planningPeople(tasks));
        if (b === 'people' && c && m === 'PATCH') {
          needAdmin();
          const map: Record<string, string> = {weeklyHours: 'weekly_hours', skill: 'skill', rate: 'rate', start: 'start_date', end: 'end_date', plannedHire: 'planned_hire'};
          for (const [k, col] of Object.entries(map)) if (body[k] !== undefined) tasks.db.prepare(`update people set ${col} = ? where id = ?`).run(k === 'plannedHire' ? (body[k] ? 1 : 0) : k === 'weeklyHours' || k === 'rate' ? Math.max(0, Number(body[k]) || 0) : (String(body[k] ?? '').slice(0, 60) || null), c);
          tasks.emit({kind: 'people'});
          return send(res, 200, planningPeople(tasks).find(p => p.id === c));
        }
      }

      if (a === 'reports' && b === 'flow' && m === 'GET') { need(q('projectId') ?? '', 'view'); return send(res, 200, tasks.flow(q('projectId')!, num(q('days'), 30, 180))); }
      // Email to task: point a Gmail filter, Zapier, Make or a mail service at this with a token.
      if (a === 'inbound' && b === 'email' && m === 'POST') {
        if (!bearer) return send(res, 401, {error: 'Use an API token (Team page) for inbound email'});
        need(body.projectId, 'create');
        return send(res, 201, tasks.fromEmail(body, actor));
      }

      // ---- Sync for CRMs and other systems ----
      if (a === 'changes' && m === 'GET') {
        const r = tasks.listChanges(q('since') ?? '1970-01-01', q('projectId'));
        return send(res, 200, {...r, items: r.items.filter(i => canSee(i.projectId)), deleted: r.deleted.filter(d => { try { return canSee(d.projectId); } catch { return false; } })});
      }
      if (a === 'external' && b && c && m === 'PUT') {
        need(body.projectId, 'create'); need(body.projectId, 'edit');
        for (const k of Object.keys(body)) if (!ITEM_FIELDS.has(k) && !['projectId', 'url', 'title'].includes(k)) delete body[k];
        return send(res, 200, tasks.upsertExternal({...body, source: b, externalId: decodeURIComponent(c)}, actor));
      }

      // ---- Approvals and signatures ----
      if (a === 'approvals') {
        if (!b && m === 'GET') {
          const list = tasks.listApprovals({itemId: q('itemId'), approver: q('mine') ? actor ?? '' : undefined, pending: q('pending') === 'true'});
          return send(res, 200, list.filter(x => { try { return canSee(tasks.item(x.itemId).projectId); } catch { return false; } }));
        }
        if (!b && m === 'POST') { const it = tasks.findItem(body.itemId); need(it.projectId, 'edit'); return send(res, 201, tasks.requestApproval(it.id, actor, body.approvers ?? [], body.meaning ?? 'approved', body.note ?? '')); }
        if (b && c === 'sign' && m === 'POST') {
          if (!actor) throw new Invalid('Pick who you are (or sign in) to sign');
          const ap = tasks.listApprovals({}).find(x => x.id === b);
          if (!ap) throw new NotFound('Approval not found');
          need(tasks.item(ap.itemId).projectId, 'view');
          return send(res, 200, tasks.signApproval(b, actor, body.decision, String(body.comment ?? ''), body.password));
        }
      }
      if (a === 'items' && b && c === 'approval-state' && m === 'GET') { const it = tasks.findItem(b); need(it.projectId, 'view'); return send(res, 200, tasks.approvalState(it.id)); }

      // ---- Human and AI work: claims, reviews, work log, files ----
      if (a === 'ai') {
        if (b === 'queue' && m === 'GET') return send(res, 200, tasks.aiQueue(q('agent') ?? null, q('projectId')).filter(x => canSee(x.item.projectId)));
        const it = body.itemId ? tasks.findItem(body.itemId) : null;
        if (it) need(it.projectId, b === 'log' ? 'comment' : 'edit');
        if (b === 'claim' && m === 'POST') return send(res, 200, tasks.claimTask(it!.id, actor ?? '', body.note ?? ''));
        if (b === 'decide' && m === 'POST') return send(res, 200, tasks.decideClaim(it!.id, actor, !!body.accept, body.note ?? ''));
        if (b === 'submit' && m === 'POST') return send(res, 200, tasks.submitWork(it!.id, actor ?? '', String(body.report ?? ''), String(body.missed ?? '')));
        if (b === 'review' && m === 'POST') return send(res, 200, tasks.reviewWork(it!.id, actor, !!body.approve, String(body.comment ?? '')));
        if (b === 'log' && m === 'POST') return send(res, 201, tasks.logWork(it!.id, actor, body.kind ?? 'note', String(body.text ?? ''), body.url ?? null));
      }
      if (a === 'items' && b && c === 'log' && m === 'GET') { const it = tasks.findItem(b); need(it.projectId, 'view'); return send(res, 200, tasks.workLog(it.id)); }
      if (a === 'items' && b && c === 'files') {
        const it = tasks.findItem(b); need(it.projectId, m === 'GET' ? 'view' : 'comment');
        if (m === 'GET') return send(res, 200, tasks.itemFiles(it.id));
        if (m === 'POST') return send(res, 201, tasks.attachFile(it.id, actor, String(body.name ?? 'file'), String(body.mime ?? ''), String(body.data ?? '')));
      }
      if (a === 'files' && b && m === 'GET') {
        const f = readFile(tasks, b);
        if (!f) throw new NotFound('File not found');
        need(tasks.item(f.itemId).projectId, 'view');
        res.statusCode = 200;
        res.setHeader('content-type', f.mime);
        res.setHeader('x-content-type-options', 'nosniff');
        // Locked down, except PDFs: Chrome's PDF viewer needs to run inside the frame.
        if (f.mime !== 'application/pdf') res.setHeader('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
        const ascii = f.name.replace(/[^ -~]/g, '_').replace(/"/g, '');
        res.setHeader('content-disposition', `${f.mime.startsWith('image/') || f.mime === 'application/pdf' ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
        res.end(f.data);
        return;
      }

      if (a === 'comments' && b && m === 'PATCH') {
        need(tasks.item(tasks.comment(b).itemId).projectId, 'comment');
        return send(res, 200, tasks.resolveComment(b, actor, !!body.resolved));
      }
      if (a === 'assigned-comments' && m === 'GET') {
        const person = ws.requireLogin ? actor : q('person') ?? actor;
        if (!person) throw new Invalid('person is required');
        return send(res, 200, tasks.assignedComments(person).filter(c => canSee(c.item.projectId)));
      }
      if (a === 'my-work' && m === 'GET') {
        const person = ws.requireLogin ? actor : q('person') ?? actor;
        if (!person) throw new Invalid('person is required');
        const w = tasks.myWork(person);
        return send(res, 200, Object.fromEntries(Object.entries(w).map(([k, list]) => [k, list.filter(i => canSee(i.projectId))])));
      }

      return send(res, 404, {error: `No route ${m} ${url.pathname}`});
    } catch (e) {
      if (e instanceof Denied) return send(res, 403, {error: e.message});
      if (e instanceof NotFound) return send(res, 404, {error: e.message});
      if (e instanceof Invalid) return send(res, 400, {error: e.message});
      console.error(e);
      return send(res, 500, {error: 'Something went wrong on the server. Details are in the server log.'});
    }
  };
}
