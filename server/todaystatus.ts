// The Today status follows the day planner. A task put in a time box on the person's current day moves from
// To do (or Backlog) to Today. Once a day, after the person's local midnight: Today tasks they are assigned that are
// not done and not boxed on the new day go back to To do, and tasks boxed ahead for the new day arrive in Today.
// Only spaces with a status named Today take part; Doing and later statuses are never moved back.
import type {Tasks} from './service.ts';
import type {Project} from '../src/types.ts';
import {calendarSettings, localDay} from './events.ts';
import {capsFor, type Access} from './auth.ts';

const todayOf = (p: Project) => p.statuses.find(s => s.id === 'today' || s.name.trim().toLowerCase() === 'today');
const todoOf = (p: Project) => p.statuses.find(s => s.category === 'todo' && (s.id === 'todo' || /^to ?do$/i.test(s.name.trim()))) ?? p.statuses.find(s => s.category === 'todo');

/** The person's current day: in the time zone of their latest day plan, else their calendar settings. */
export function personDay(tasks: Tasks, person: string, now = new Date()) {
  let tz: string | undefined;
  try { tz = (JSON.parse((tasks.db.prepare('select data from day_plans where person = ? order by date desc limit 1').get(person) as {data: string} | undefined)?.data ?? '{}') as {tz?: string}).tz; } catch { /* no plans yet */ }
  if (!tz) { try { tz = calendarSettings(tasks, person).tz; } catch { tz = 'UTC'; } }
  try { return localDay(now, tz); } catch { return localDay(now, 'UTC'); }
}

/** Tasks just boxed on the person's current day: from a To do status to Today (spaces that have one), when the person may edit tasks there. */
export function markBoxedToday(tasks: Tasks, itemIds: string[], person: string) {
  for (const id of new Set(itemIds)) {
    let it; try { it = tasks.item(id); } catch { continue; }
    if (it.completed) continue;
    const p = tasks.project(it.projectId), today = todayOf(p);
    if (!today || it.status === today.id || p.statuses.find(s => s.id === it.status)?.category !== 'todo') continue;
    if (!capsFor(tasks.db, person, (p.settings as {access?: Access}).access, false, p.id).has('edit')) continue;
    tasks.updateItem(id, {status: today.id}, person, {system: true});
  }
}

const boxedOn = (tasks: Tasks, person: string, day: string) => new Set(tasks.dayPlan(person, day).blocks.map(b => b.itemId).filter((x): x is string => !!x));

/** Once per person per local day (run hourly). The first run after an upgrade only marks the day. */
export function rollTodayStatuses(tasks: Tasks, now = new Date()) {
  tasks.db.exec('create table if not exists today_rolls (person text not null, day text not null, primary key (person, day))');
  const first = !tasks.db.prepare('select 1 from today_rolls limit 1').get();
  const boxedCache = new Map<string, Set<string>>();
  const boxedNow = (person: string) => { let s = boxedCache.get(person); if (!s) { s = boxedOn(tasks, person, personDay(tasks, person, now)); boxedCache.set(person, s); } return s; };
  for (const person of tasks.listPeople()) {
    const day = personDay(tasks, person.id, now);
    if (!tasks.db.prepare('insert or ignore into today_rolls (person, day) values (?, ?)').run(person.id, day).changes || first) continue;
    markBoxedToday(tasks, [...boxedNow(person.id)], person.id);
    for (const it of tasks.listItems({open: true})) {
      if (!it.assignees.includes(person.id)) continue;
      const p = tasks.project(it.projectId), today = todayOf(p), todo = todoOf(p);
      if (!today || !todo || it.status !== today.id) continue;
      // Kept while any assignee has it in a box on their current day.
      if (it.assignees.some(a => boxedNow(a).has(it.id))) continue;
      tasks.updateItem(it.id, {status: todo.id}, null, {system: true});
    }
  }
}
