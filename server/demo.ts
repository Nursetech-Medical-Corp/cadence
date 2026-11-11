// Sample data for trying the app and for screenshots: a "work" workspace (the built-in demo projects) and a
// "personal" one with home, health and travel projects. Runs only in demo mode (pnpm demo), on an empty data folder.
import type {Tasks} from './service.ts';
import {createWorkspace, listWorkspaces, updateWorkspace, type WorkspaceInfo} from './workspaces.ts';
import {addUnit} from '../src/dates.ts';

export function seedSampleWorkspaces(open: (w: WorkspaceInfo) => Tasks) {
  if (listWorkspaces().length > 1) return;
  const main = listWorkspaces()[0];
  updateWorkspace(main.id, {name: 'Acme Studio', color: '#0ea5e9', icon: 'A'});
  const work = open(main); // seeds the work projects
  // An AI agent to connect over MCP, as in docs/MCP.md.
  const bot = work.createPerson({name: 'secretary-bot-1'});
  work.db.prepare("update people set kind = 'ai', role = 'contributor' where id = ?").run(bot.id);
  const w = createWorkspace({name: 'Personal', color: '#10b981', icon: 'P'});
  const t = open(w);
  const me = t.createPerson({name: 'David', email: 'david@example.com'});
  t.db.prepare('update people set admin = 1 where id = ?').run(me.id);
  const bot2 = t.createPerson({name: 'secretary-bot-1'});
  t.db.prepare("update people set kind = 'ai', role = 'contributor' where id = ?").run(bot2.id);
  const d = (n: number) => addUnit(t.today(), n, 'day');
  const by = me.id, mine = {assignees: [me.id]};

  const home = t.createProject({name: 'Home', key: 'HOME', types: ['Project', 'Task', 'Subtask'], settings: {icon: 'lucide:House', color: '#10b981'}});
  t.createItem({projectId: home.id, title: 'Pay rent', ...mine, due: d(3), priority: 2, recur: {every: 1, unit: 'month', mode: 'schedule'}, tags: ['bills']}, by);
  t.createItem({projectId: home.id, title: 'Fix the leaky kitchen faucet', ...mine, due: d(1), estimate: 1}, by);
  t.createItem({projectId: home.id, title: 'Renew car registration', ...mine, due: d(9), recur: {every: 1, unit: 'year', mode: 'schedule'}, tags: ['car']}, by);
  t.createItem({projectId: home.id, title: 'Clean the gutters', ...mine, due: d(16), recur: {every: 6, unit: 'month', mode: 'schedule'}}, by);
  const garden = t.createItem({projectId: home.id, title: 'Spring garden', type: 'Project', start: d(4), due: d(24), ...mine}, by);
  for (const [title, off, len] of [['Order seeds and soil', 0, 2], ['Build raised beds', 4, 5], ['Plant tomatoes and herbs', 11, 3]] as const)
    t.createItem({projectId: home.id, parentId: garden.id, title, start: d(4 + off), due: d(4 + off + len), ...mine, fields: {follow: 'parent'}}, by);
  t.createItem({projectId: home.id, title: 'Overdue: return library books', ...mine, due: d(-2)}, by);

  const health = t.createProject({name: 'Health', key: 'HLTH', types: ['Task', 'Subtask'], settings: {icon: 'lucide:HeartPulse', color: '#ef4444'}});
  t.createItem({projectId: health.id, title: 'Morning run', ...mine, due: d(0), recur: {every: 1, unit: 'week', mode: 'schedule', weekdays: [1, 3, 5]}, estimate: 0.5}, by);
  t.createItem({projectId: health.id, title: 'Dentist cleaning', ...mine, due: d(12), recur: {every: 6, unit: 'month', mode: 'schedule'}}, by);
  t.createItem({projectId: health.id, title: 'Annual physical', ...mine, due: d(30), recur: {every: 1, unit: 'year', mode: 'schedule'}}, by);
  t.createItem({projectId: health.id, title: 'Renew passport', ...mine, due: d(0), priority: 2, tags: ['travel']}, by);

  const trip = t.createProject({name: 'Lisbon trip', key: 'TRIP', types: ['Trip', 'Task', 'Subtask'], settings: {icon: 'lucide:Plane', color: '#f59e0b'}});
  const root = t.createItem({projectId: trip.id, title: 'Lisbon, spring', type: 'Trip', start: d(5), due: d(40), ...mine}, by);
  let prev = null as null | {id: string; due: string | null};
  for (const [title, len] of [['Book flights', 1], ['Book the apartment', 2], ['Plan day trips to Sintra and Cascais', 4], ['Pack and arrange pet sitter', 2]] as const) {
    const start = prev?.due ? addUnit(prev.due, 1, 'day') : d(5);
    const it = t.createItem({projectId: trip.id, parentId: root.id, title, start, due: addUnit(start, len, 'day'), ...mine, deps: prev ? [prev.id] : [], fields: {follow: prev ? 'previous' : 'parent'}}, by);
    prev = it;
  }
}
