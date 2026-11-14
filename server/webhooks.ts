// Outbound webhooks: every service event (Tasks.event) is matched against the space's endpoints and the
// workspace-wide ones, and written to hook_deliveries as a pending delivery. The sender started by the web server
// posts pending deliveries, retries failures after 1, 5 and 30 minutes with the same body, and prunes the log
// after 14 days. Writes from another process (the stdio MCP server) are picked up by the same sender.
import {createHmac, randomBytes, randomUUID} from 'node:crypto';
import {Invalid} from './errors.ts';
import {safeTarget} from './integrations.ts';
import type {Db} from './db.ts';
import type {HookEvent, Tasks} from './service.ts';
import type {Action, Project, Rule} from '../src/types.ts';
import {HOOK_EVENTS, normalizeHook, type Hook, type HookDelivery} from '../src/hooks.ts';

export const RETRY_MINUTES = [1, 5, 30];
const KEEP_DAYS = 14;
const KNOWN = new Set(HOOK_EVENTS.map(e => e.key));

export const signature = (secret: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const secretOf = (db: Db, key: string | null) => key ? (db.prepare('select secret from hook_secrets where key = ?').get(key) as {secret: string} | undefined)?.secret ?? null : null;
const setSecret = (db: Db, key: string, secret: string | undefined) => {
  if (secret === undefined) return;
  if (secret) db.prepare('insert into hook_secrets (key, secret) values (?, ?) on conflict(key) do update set secret = excluded.secret').run(key, secret);
  else db.prepare('delete from hook_secrets where key = ?').run(key);
};

/** Checks endpoints before saving. Secrets move to their own table; what is stored and sent to browsers only says hasSecret. */
export function cleanHooks(db: Db, list: unknown, before: {id: string}[] = []): Hook[] {
  if (!Array.isArray(list) || list.length > 50) throw new Invalid('Webhooks must be a list of up to 50 endpoints');
  const out = list.map(raw => {
    if (!raw || typeof raw !== 'object' || typeof (raw as Hook).url !== 'string') throw new Invalid('Each webhook needs a url');
    const h = normalizeHook({...(raw as Hook), id: typeof (raw as Hook).id === 'string' && (raw as Hook).id ? (raw as Hook).id : randomBytes(6).toString('hex')});
    if (h.url.length > 2000 || !/^https?:\/\/[^\s]+$/i.test(h.url)) throw new Invalid('Webhook URLs start with http:// or https://');
    if (typeof h.name !== 'string' || h.name.length > 100) throw new Invalid('Webhook names are text under 100 characters');
    const bad = h.events.filter(e => !KNOWN.has(e));
    if (bad.length) throw new Invalid(`Unknown webhook event: ${bad.join(', ')}. See docs/WEBHOOKS.md for the list.`);
    if (h.secret !== undefined && h.secret.length > 200) throw new Invalid('Webhook secrets are limited to 200 characters');
    setSecret(db, `hook:${h.id}`, h.secret);
    const {secret: _s, hasSecret: _h, ...rest} = h; void _s; void _h;
    return {...rest, ...(secretOf(db, `hook:${h.id}`) ? {hasSecret: true} : {})};
  });
  for (const b of before) if (!out.some(h => h.id === b.id)) setSecret(db, `hook:${b.id}`, '');
  return out;
}
const ruleKey = (rule: Rule, a: {value: string}) => `rule:${rule.id}:${a.value}`;
/** The same for webhook actions inside automation rules. */
export function cleanRuleSecrets(db: Db, rules: Rule[]): Rule[] {
  return rules.map(r => ({...r, actions: r.actions.map((a): Action => {
    if (a.kind !== 'webhook') return a;
    setSecret(db, ruleKey(r, a), a.secret);
    return {kind: 'webhook', value: a.value, ...(secretOf(db, ruleKey(r, a)) ? {hasSecret: true} : {})};
  })}));
}

// ---- Workspace-level endpoints: they receive events from every space except private ones ----
export type WorkspaceHooks = {webhooks: Hook[]; dueSoonDays: number[]};
export function workspaceHooks(db: Db): WorkspaceHooks {
  const r = db.prepare("select value from workspace where key = 'hooks'").get() as {value: string} | undefined;
  const v = r ? JSON.parse(r.value) : {};
  return {webhooks: (v.webhooks ?? []).map(normalizeHook), dueSoonDays: Array.isArray(v.dueSoonDays) ? v.dueSoonDays : [1, 3]};
}
export function saveWorkspaceHooks(db: Db, patch: {webhooks?: unknown; dueSoonDays?: unknown}): WorkspaceHooks {
  const cur = workspaceHooks(db);
  const next = {...cur};
  if (patch.webhooks !== undefined) next.webhooks = cleanHooks(db, patch.webhooks, cur.webhooks);
  if (patch.dueSoonDays !== undefined) {
    const d = patch.dueSoonDays;
    if (!Array.isArray(d) || d.length > 10 || d.some(n => !Number.isInteger(n) || n < 1 || n > 365)) throw new Invalid('Due soon days are up to 10 whole numbers from 1 to 365, like [1, 3]');
    next.dueSoonDays = [...new Set(d as number[])].sort((a, b) => a - b);
  }
  db.prepare("insert into workspace (key, value) values ('hooks', ?) on conflict(key) do update set value = excluded.value").run(JSON.stringify(next));
  return next;
}

/** Writes one pending delivery per endpoint that wants this event. No network here; the sender posts them. */
export function queueHooks(tasks: Tasks, e: HookEvent) {
  let p: Project | null = null;
  if (e.projectId) { try { p = tasks.project(e.projectId); } catch { /* the space is gone */ } }
  const project = e.project ?? (p ? {id: p.id, key: p.key, name: p.name} : null);
  let targets: {hook: string; scope: string; url: string; secretKey: string | null}[];
  if (e.target) targets = [e.target];
  else {
    const wants = (h: Hook) => h.active && (!h.events.length || h.events.includes(e.event));
    const own = (p?.settings.webhooks ?? []).map(normalizeHook).filter(wants).map(h => ({hook: h.id, scope: p!.id, url: h.url, secretKey: `hook:${h.id}`}));
    // Private spaces stay private: workspace endpoints do not hear about them.
    const shared = p?.settings.access?.private ? [] : workspaceHooks(tasks.db).webhooks.filter(wants).map(h => ({hook: h.id, scope: 'workspace', url: h.url, secretKey: `hook:${h.id}`}));
    targets = [...own, ...shared];
  }
  const at = new Date().toISOString();
  const ids: string[] = [];
  for (const t of targets) {
    const id = randomUUID();
    const body = JSON.stringify({id, event: e.event, at, workspace: tasks.workspace, project, item: e.item ?? null, ...(e.changes ? {changes: e.changes} : {}), actor: e.actor ?? null, ...e.details});
    tasks.db.prepare("insert into hook_deliveries (id, hook, scope, url, secret_key, event, body, status, next_at, created) values (?,?,?,?,?,?,?,'pending',?,?)")
      .run(id, t.hook, t.scope, t.url, t.secretKey, e.event, body, at, at);
    ids.push(id);
  }
  return ids;
}

export function listDeliveries(db: Db, q: {scope: string; hook?: string; limit?: number}): HookDelivery[] {
  return db.prepare(`select id, hook, scope, url, event, status, attempts, code, error, created, updated, next_at from hook_deliveries where scope = ? ${q.hook ? 'and hook = ?' : ''} order by created desc, rowid desc limit ${Math.min(q.limit ?? 50, 200)}`)
    .all(...(q.hook ? [q.scope, q.hook] : [q.scope]))
    .map(r => ({id: r.id as string, hook: r.hook as string, scope: r.scope as string, url: r.url as string, event: r.event as string, status: r.status as HookDelivery['status'], attempts: r.attempts as number,
      code: (r.code as number) ?? null, error: (r.error as string) ?? null, created: r.created as string, updated: (r.updated as string) ?? null, nextAt: (r.next_at as string) ?? null}));
}

export type Sender = (url: string, init: {headers: Record<string, string>; body: string}) => Promise<{ok: boolean; status: number}>;
const post: Sender = (url, init) => fetch(url, {method: 'POST', headers: init.headers, body: init.body, redirect: 'error', signal: AbortSignal.timeout(10_000)});

/** Starts the sender for one workspace. run(now) sends what is due at that time (tests pass a later time to reach the retries). */
export function startWebhooks(tasks: Tasks, opts: {send?: Sender; safe?: (url: string) => Promise<boolean>; timer?: boolean} = {}) {
  const send = opts.send ?? post, safe = opts.safe ?? safeTarget, db = tasks.db;
  const attempt = async (r: {id: string; url: string; secret_key: string | null; event: string; body: string; attempts: number}, now: number) => {
    const secret = secretOf(db, r.secret_key);
    const headers: Record<string, string> = {'content-type': 'application/json', 'user-agent': 'Cadence-Webhooks/1', 'x-cadence-event': r.event, 'x-cadence-delivery': r.id,
      ...(secret ? {'x-cadence-signature': signature(secret, r.body)} : {})};
    let code: number | null = null, error: string | null = null, blocked = false;
    try {
      if (!(await safe(r.url))) { blocked = true; error = 'Blocked: private or local address'; }
      else { const res = await send(r.url, {headers, body: r.body}); code = res.status; if (!res.ok) error = `HTTP ${res.status}`; }
    } catch (e) { error = (e instanceof Error ? e.message : String(e)).slice(0, 300); }
    const attempts = r.attempts + 1, wait = RETRY_MINUTES[attempts - 1];
    const status = !error ? 'ok' : blocked || wait === undefined ? 'failed' : 'pending';
    db.prepare('update hook_deliveries set status = ?, attempts = ?, code = ?, error = ?, updated = ?, next_at = ? where id = ?')
      .run(status, attempts, code, error, new Date(now).toISOString(), status === 'pending' ? new Date(now + wait * 60_000).toISOString() : null, r.id);
    if (error) console.error('Webhook failed', r.url, error);
  };
  let running: Promise<void> | null = null, again = false;
  const pass = async (now?: number) => {
    for (;;) {
      again = false;
      const at = now ?? Date.now();
      const due = db.prepare("select id, url, secret_key, event, body, attempts from hook_deliveries where status = 'pending' and next_at <= ? order by created limit 50").all(new Date(at).toISOString()) as Parameters<typeof attempt>[0][];
      await Promise.all(due.map(r => attempt(r, at)));
      if (!again && due.length < 50) return;
    }
  };
  /** Sends what is due. Events that arrive while a pass is running are picked up by it. */
  const run = (now?: number): Promise<void> => {
    if (running && now === undefined) { again = true; return running; }
    const mine: Promise<void> = (running ?? Promise.resolve()).then(() => pass(now)).catch(e => console.error('Webhook sender failed', e)).finally(() => { if (running === mine) running = null; });
    running = mine;
    return mine;
  };
  const off = tasks.onEvent(() => { void run(); });
  const tick = () => {
    db.prepare('delete from hook_deliveries where created < ?').run(new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString());
    void run();
  };
  const timer = opts.timer === false ? null : setInterval(tick, 30_000);
  timer?.unref();
  return {run, prune: tick, stop: () => { off(); if (timer) clearInterval(timer); }};
}
