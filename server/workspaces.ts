// Workspaces: separate companies, or personal and work, each with its own database, files and backups.
// The list lives in data/workspaces.json. "main" is the original database (TASKS_DB) and always exists.
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Invalid, NotFound} from './errors.ts';

export type WorkspaceInfo = {id: string; name: string; color: string; icon: string; db: string; created: string; sort: number};
const MAIN_DB = () => process.env.TASKS_DB ?? 'data/tasks.db';
const ROOT = () => dirname(MAIN_DB());
const FILE = () => join(ROOT(), 'workspaces.json');
const COLORS = ['#7c5cff', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#6366f1'];
let cache: WorkspaceInfo[] | null = null;

export function listWorkspaces(): WorkspaceInfo[] {
  if (!cache) {
    try { cache = JSON.parse(readFileSync(FILE(), 'utf8')) as WorkspaceInfo[]; } catch { cache = []; }
    if (!cache.some(w => w.id === 'main')) cache.unshift({id: 'main', name: 'Cadence', color: COLORS[0], icon: '', db: '', created: new Date().toISOString(), sort: 0});
  }
  // The main database path always follows TASKS_DB so tests and moved installs keep working.
  return cache.map(w => w.id === 'main' ? {...w, db: MAIN_DB()} : w).sort((a, b) => a.sort - b.sort);
}
function save(list: WorkspaceInfo[]) {
  mkdirSync(ROOT(), {recursive: true});
  writeFileSync(FILE(), JSON.stringify(list.map(w => w.id === 'main' ? {...w, db: ''} : w), null, 2));
  cache = list;
}
/** Where a workspace keeps its files and backups. */
export const workspaceDir = (w: WorkspaceInfo) => w.id === 'main' ? ROOT() : dirname(w.db);
export const publicInfo = ({db: _db, ...w}: WorkspaceInfo) => w;

const color = (c: unknown) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
const cleanName = (n: unknown) => {
  const name = String(n ?? '').trim();
  if (!name) throw new Invalid('Name is required');
  if (name.length > 60) throw new Invalid('Names are limited to 60 characters');
  return name;
};

export function createWorkspace(input: {name?: unknown; color?: unknown; icon?: unknown}): WorkspaceInfo {
  const list = listWorkspaces();
  if (list.length >= 50) throw new Invalid('You can have up to 50 workspaces');
  const id = randomBytes(5).toString('hex');
  const w: WorkspaceInfo = {
    id, name: cleanName(input.name), color: color(input.color) ?? COLORS.find(c => !list.some(w => w.color === c)) ?? COLORS[list.length % COLORS.length], icon: String(input.icon ?? '').slice(0, 40),
    db: join(ROOT(), 'workspaces', id, 'tasks.db'), created: new Date().toISOString(), sort: Math.max(...list.map(x => x.sort)) + 1,
  };
  save([...list, w]);
  return w;
}
export function updateWorkspace(id: string, patch: {name?: unknown; color?: unknown; icon?: unknown}): WorkspaceInfo {
  const list = listWorkspaces(), w = list.find(x => x.id === id);
  if (!w) throw new NotFound('Workspace not found');
  const next = {...w, ...(patch.name !== undefined ? {name: cleanName(patch.name)} : {}), ...(color(patch.color) ? {color: color(patch.color)!} : {}), ...(patch.icon !== undefined ? {icon: String(patch.icon).slice(0, 40)} : {})};
  save(list.map(x => x.id === id ? next : x));
  return next;
}
/** Removes a workspace from the list and moves its folder to workspaces/_deleted, so it can still be recovered by hand. */
export function archiveWorkspace(id: string) {
  const list = listWorkspaces(), w = list.find(x => x.id === id);
  if (!w || id === 'main') throw new NotFound('Workspace not found');
  const to = join(ROOT(), 'workspaces', '_deleted', `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dirname(to), {recursive: true});
  try { renameSync(dirname(w.db), to); } catch { /* the folder may not exist yet */ }
  save(list.filter(x => x.id !== id));
  return to;
}
export function reorderWorkspaces(ids: string[]) {
  const list = listWorkspaces();
  save(list.map(w => ({...w, sort: ids.includes(w.id) ? ids.indexOf(w.id) : ids.length + w.sort})));
  return listWorkspaces();
}
/** Forget the in-memory list (tests point TASKS_DB somewhere new). */
export const resetWorkspaceCache = () => { cache = null; };
