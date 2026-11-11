// Hours per person on a shared item. Each assignee can set their own hours (fields.hours: {personId: hours});
// then the item's estimate is their total, and anyone without a number counts 0. Without per-person hours,
// the estimate is shared evenly. Used by capacity, Workload and Replan, so everyone sees the same numbers.
import type {Item} from './types.ts';

export type PersonHours = Record<string, number>;
export const personHours = (i: Item) => (i.fields.hours && typeof i.fields.hours === 'object' ? i.fields.hours as PersonHours : null);

/** One person's hours on an item. */
export function hoursFor(i: Item, personId: string): number {
  const h = personHours(i);
  return h ? h[personId] ?? 0 : (i.estimate ?? 0) / Math.max(1, i.assignees.length);
}

/** Keeps per-person hours to the item's assignees and to sane numbers, and sets the estimate to their total. */
export function syncHours<T extends Item>(i: T): T {
  if (!('hours' in i.fields)) return i;
  const raw = i.fields.hours as Record<string, unknown> | null;
  const kept: PersonHours = Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {})
    .filter((e): e is [string, number] => i.assignees.includes(e[0]) && typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 10000));
  const fields = {...i.fields};
  if (Object.keys(kept).length) fields.hours = kept; else delete fields.hours;
  const total = Object.values(kept).reduce((a, b) => a + b, 0);
  return {...i, fields, estimate: Object.keys(kept).length ? Math.round(total * 100) / 100 : i.estimate};
}
