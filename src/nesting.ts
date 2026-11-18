// Organizing by drag: drop an item on another to nest it one level down (Project > Phase > Task > Subtask, as the
// space names its levels), or beside it to reorder. Used by the List and Table views.

type Node = {id: string; parentId: string | null; type: string; sort: number; projectId?: string};
const otherSpace = (a?: Node, b?: Node) => !!a?.projectId && !!b?.projectId && a.projectId !== b.projectId;
export type Patch = {id: string; patch: {parentId?: string | null; sort?: number; type?: string}};

/** True when target is item itself or sits somewhere under it (dropping there would make a loop). */
export function isUnder<T extends Node>(items: T[], target: string, item: string): boolean {
  const byId = new Map(items.map(i => [i.id, i]));
  for (let t: T | undefined = byId.get(target), n = 0; t && n < 100; t = t.parentId ? byId.get(t.parentId) : undefined, n++) if (t.id === item) return true;
  return false;
}

/**
 * Drop item onto target (in the same space): it becomes target's last subitem, one level below target. An item already deeper keeps its
 * level. When it moves down, its own subitems move down with it (never past the last level). null when not allowed.
 */
export function nestUnder<T extends Node>(items: T[], itemId: string, targetId: string, types: string[]): Patch[] | null {
  const item = items.find(i => i.id === itemId), target = items.find(i => i.id === targetId);
  if (!item || !target || otherSpace(item, target) || isUnder(items, targetId, itemId)) return null;
  const last = types.length - 1, ti = types.indexOf(target.type), di = types.indexOf(item.type);
  const want = ti < 0 ? di : Math.min(ti + 1, last);
  const down = di >= 0 && want > di ? want - di : 0;
  const sort = Math.max(0, ...items.filter(i => i.parentId === targetId && i.id !== itemId).map(i => i.sort)) + 1;
  const out: Patch[] = [{id: itemId, patch: {parentId: targetId, sort, ...(want >= 0 && (di < 0 || want > di) ? {type: types[want]} : {})}}];
  if (down) {
    const walk = (pid: string) => { for (const c of items.filter(i => i.parentId === pid)) {
      const ci = types.indexOf(c.type);
      if (ci >= 0 && Math.min(ci + down, last) !== ci) out.push({id: c.id, patch: {type: types[Math.min(ci + down, last)]}});
      walk(c.id);
    } };
    walk(itemId);
  }
  return out;
}

/** Drop item just before or after target, among target's siblings. null when it would go under itself or into another space. */
export function placeBeside<T extends Node>(items: T[], itemId: string, targetId: string, after: boolean): Patch | null {
  const target = items.find(i => i.id === targetId);
  if (!target || itemId === targetId || otherSpace(items.find(i => i.id === itemId), target) || isUnder(items, targetId, itemId)) return null;
  const sibs = items.filter(i => i.parentId === target.parentId && i.id !== itemId).sort((a, b) => a.sort - b.sort);
  const k = sibs.findIndex(i => i.id === targetId);
  const lo = after ? target.sort : sibs[k - 1]?.sort, hi = after ? sibs[k + 1]?.sort : target.sort;
  const sort = lo === undefined ? (hi ?? 0) - 1 : hi === undefined ? lo + 1 : (lo + hi) / 2;
  return {id: itemId, patch: {parentId: target.parentId, sort}};
}
