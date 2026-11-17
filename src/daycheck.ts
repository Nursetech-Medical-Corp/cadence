// Day planner check-offs. One thing can show up in several places on the page: a top 3 priority, a brain dump
// line and a time box. Checking any of them off marks all of them done, and the task they stand for too.
// Used by the page (src/DayPlanner.tsx) and the server (server/dayplan.ts), so people and agents get the same result.

export type CheckEntry = {id: string; text: string; itemId?: string | null; done?: boolean};
export type CheckPlan<E extends CheckEntry = CheckEntry> = {top: E[]; dump: E[]; blocks: E[]};
/** What the page knows about a task: its title and whether it is done. undefined: no such task (deleted). */
export type TaskInfo = (itemId: string) => {title: string; completed: boolean} | undefined;

const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const all = <E extends CheckEntry>(p: CheckPlan<E>) => [...p.top, ...p.dump, ...p.blocks];

/**
 * The entries that stand for the same thing as entry id, and the task they share (if any).
 * Same thing: the same task, or the same text (a plain line and a task with that title count as the same).
 * A plain line whose text matches two different tasks ties to neither, so a check never completes the wrong one.
 * null: no entry with that id.
 */
export function sameEntries<E extends CheckEntry>(plan: CheckPlan<E>, id: string, task: TaskInfo): {ids: Set<string>; itemId: string | null} | null {
  const list = all(plan), e = list.find(x => x.id === id);
  if (!e) return null;
  const names = new Set<string>();
  const add = (s: string | null | undefined) => { const n = norm(s); if (n) names.add(n); };
  let itemId: string | null = e.itemId ?? null;
  add(e.text);
  if (!itemId && names.size) {
    // A plain line: is it a task somewhere else on the page (same text, or the task's title)?
    const found = new Set(list.filter(x => x.itemId && (names.has(norm(x.text)) || names.has(norm(task(x.itemId)?.title)))).map(x => x.itemId!));
    if (found.size === 1) itemId = [...found][0];
  }
  if (itemId) list.filter(x => x.itemId === itemId).forEach(x => add(x.text)), add(task(itemId)?.title);
  const ids = new Set(list.filter(x => x.id === id || (itemId && x.itemId === itemId) || (!x.itemId && names.has(norm(x.text)))).map(x => x.id));
  return {ids, itemId};
}

/** Whether an entry shows as done: a task entry (or a plain line tied to one by its text) is done when the task is. */
export function entryDone<E extends CheckEntry>(plan: CheckPlan<E>, e: E, task: TaskInfo): boolean {
  if (e.itemId) { const t = task(e.itemId); return t ? t.completed : !!e.done; }
  const g = sameEntries(plan, e.id, task);
  const t = g?.itemId ? task(g.itemId) : undefined;
  if (t) return t.completed;
  // Plain lines with the same text show done together, also when only one was checked (days saved before checks were shared).
  return !!e.done || (!!g && all(plan).some(x => g.ids.has(x.id) && !x.itemId && x.done));
}

/**
 * Check entry id off (done true) or back on (done false) everywhere it shows. Plain entries take the done flag;
 * entries for a task follow the task, so itemId says which task the caller completes or reopens (null: none).
 */
export function checkEntries<E extends CheckEntry, P extends CheckPlan<E>>(plan: P, id: string, done: boolean, task: TaskInfo): {plan: P; itemId: string | null} | null {
  const g = sameEntries(plan, id, task);
  if (!g) return null;
  const set = (x: E): E => {
    // A task entry follows its task; one whose task was deleted keeps its own flag like a plain line.
    if (!g.ids.has(x.id) || (x.itemId && task(x.itemId))) return x;
    if (done) return {...x, done: true};
    const {done: _d, ...rest} = x;
    return rest as E;
  };
  const t = g.itemId ? task(g.itemId) : undefined;
  return {plan: {...plan, top: plan.top.map(set), dump: plan.dump.map(set), blocks: plan.blocks.map(set)}, itemId: t ? g.itemId : null};
}
