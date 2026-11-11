// Backups and export. Three layers:
// 1. Snapshots: a full copy of the SQLite file (VACUUM INTO) on a schedule you set, pruned with a
//    grandfather-father-son policy: keep the latest N, then one per day, one per week and one per month.
//    Manual and before-restore snapshots are never pruned automatically.
// 2. JSON export: every table as JSON, readable by people and by the import below.
// 3. JSON import: replaces the workspace after taking a snapshot first, so a restore can be undone.
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {Db} from './db.ts';
import {getWorkspace, saveWorkspace, type Workspace} from './auth.ts';

// Exports include history, AI work logs, approvals, templates, file records, personal layouts and workspace settings.
// Secrets (passwords, sessions, tokens, Google keys) never leave.
const TABLES = ['people', 'projects', 'sprints', 'views', 'items', 'comments', 'time_entries', 'notifications', 'activity', 'work_log', 'approvals', 'templates', 'files', 'prefs'] as const;
const DIR = () => process.env.TASKS_BACKUPS ?? 'data/backups';
const SETTINGS_FILE = (dir: string) => join(dir, 'settings.json');

export type BackupSettings = {
  enabled: boolean; intervalHours: number;
  keepRecent: number; keepDaily: number; keepWeekly: number; keepMonthly: number;
};
export const DEFAULT_SETTINGS: BackupSettings = {enabled: true, intervalHours: 6, keepRecent: 8, keepDaily: 14, keepWeekly: 8, keepMonthly: 12};

export function getSettings(dir = DIR()): BackupSettings {
  try { return {...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE(dir), 'utf8'))}; } catch { return DEFAULT_SETTINGS; }
}
export function saveSettings(patch: Partial<BackupSettings>, dir = DIR()) {
  const s = {...getSettings(dir), ...patch};
  for (const k of ['intervalHours', 'keepRecent', 'keepDaily', 'keepWeekly', 'keepMonthly'] as const) {
    if (!(Number.isFinite(s[k]) && s[k] >= 0)) throw new Error(`${k} must be a number of 0 or more`);
  }
  if (s.intervalHours < 0.25) throw new Error('Interval must be at least 15 minutes');
  mkdirSync(dirname(SETTINGS_FILE(dir)), {recursive: true});
  writeFileSync(SETTINGS_FILE(dir), JSON.stringify(s, null, 2));
  return s;
}

export function snapshot(db: Db, reason: 'auto' | 'manual' | 'before-restore' = 'auto', dir = DIR()) {
  mkdirSync(dir, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Two snapshots in the same second get a counter, so neither overwrites nor fails.
  let file = join(dir, `tasks-${stamp}-${reason}.db`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `tasks-${stamp}-${n}-${reason}.db`);
  db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  if (reason === 'auto') prune(dir);
  return file;
}

export type Snap = {name: string; bytes: number; created: string; reason: string; keptAs?: string};
export function listSnapshots(dir = DIR()): Snap[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.db')).map(name => {
    const st = statSync(join(dir, name));
    return {name, bytes: st.size, created: st.mtime.toISOString(), reason: /-(auto|manual|before-restore)\.db$/.exec(name)?.[1] ?? 'auto'};
  }).sort((a, b) => b.created.localeCompare(a.created));
}

/** Which auto snapshots the policy keeps, and why. Exported for tests and the settings preview. */
export function retention(snaps: Snap[], s: BackupSettings): Snap[] {
  const autos = snaps.filter(x => x.reason === 'auto');
  const keep = new Map<string, string>();
  autos.slice(0, s.keepRecent).forEach(x => keep.set(x.name, 'recent'));
  const bucket = (label: string, n: number, key: (d: Date) => string) => {
    const seen = new Set<string>();
    for (const x of autos) {
      const k = key(new Date(x.created));
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > n) break;
      if (!keep.has(x.name)) keep.set(x.name, label);
    }
  };
  bucket('daily', s.keepDaily, d => d.toISOString().slice(0, 10));
  bucket('weekly', s.keepWeekly, d => { const m = new Date(d); m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7)); return m.toISOString().slice(0, 10); });
  bucket('monthly', s.keepMonthly, d => d.toISOString().slice(0, 7));
  return snaps.map(x => ({...x, keptAs: x.reason !== 'auto' ? x.reason : keep.get(x.name)}));
}

function prune(dir: string) {
  for (const x of retention(listSnapshots(dir), getSettings(dir))) if (!x.keptAs) rmSync(join(dir, x.name));
}

/** Takes an auto snapshot when the newest one is older than the interval. Call on start and periodically. */
/** Copies uploaded files not yet in the backup folder. Files are written once and never changed, so this is complete. */
export function mirrorFiles(filesDir: string, dir = DIR()) {
  if (!existsSync(filesDir)) return 0;
  const to = join(dir, 'files');
  mkdirSync(to, {recursive: true});
  let n = 0;
  for (const f of readdirSync(filesDir)) if (!existsSync(join(to, f))) { copyFileSync(join(filesDir, f), join(to, f)); n++; }
  return n;
}
export function maybeSnapshot(db: Db, dir = DIR()) {
  const s = getSettings(dir);
  if (!s.enabled) return null;
  const last = listSnapshots(dir).find(x => x.reason === 'auto');
  if (last && Date.now() - Date.parse(last.created) < s.intervalHours * 3600_000) return null;
  return snapshot(db, 'auto', dir);
}

export function exportAll(db: Db) {
  const data: Record<string, unknown[]> = {};
  const has = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map(r => r.name as string));
  for (const t of TABLES) if (has.has(t)) data[t] = db.prepare(`select * from ${t}`).all().map(r => t === 'people' ? {...r, password: null} : r);
  // Workspace settings travel too (roles, customization, features); Google secrets and the sign-in switch do not.
  const w = has.has('workspace') ? getWorkspace(db) : null;
  return {app: 'cadence', version: 1, exported: new Date().toISOString(), ...(w ? {settings: {roles: w.roles, custom: w.custom, features: w.features}} : {}), tables: data};
}

export function importAll(db: Db, dump: {app?: string; version?: number; settings?: Partial<Workspace>; tables?: Record<string, Record<string, unknown>[]>}, dir = DIR()) {
  if (!['cadence', 'tasks'].includes(dump?.app ?? '') || !dump.tables) throw new Error('Not a Cadence export file');
  const before = snapshot(db, 'before-restore', dir);
  db.exec('begin');
  try {
    const has = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map(r => r.name as string));
    // Tables missing from an older export are left as they are.
    for (const t of [...TABLES].reverse()) if (has.has(t) && t in dump.tables) db.exec(`delete from ${t}`);
    for (const t of TABLES) {
      if (!has.has(t) || !(t in dump.tables)) continue;
      const cols = (db.prepare(`pragma table_info(${t})`).all() as {name: string}[]).map(c => c.name);
      for (const row of dump.tables[t] ?? []) {
        const keys = cols.filter(c => c in row);
        db.prepare(`insert into ${t} (${keys.join(',')}) values (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k] as never));
      }
    }
    if (dump.settings && has.has('workspace')) { const {roles, custom, features} = dump.settings; saveWorkspace(db, {...(roles ? {roles} : {}), ...(custom ? {custom} : {}), ...(features ? {features} : {})}); }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return {restored: Object.fromEntries(TABLES.map(t => [t, dump.tables![t]?.length ?? 0])), snapshotBefore: before};
}
