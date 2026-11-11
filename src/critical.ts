// Critical path over scheduled items and their dependencies. An item is critical when it has no slack:
// delaying it by a day delays the last finish date. Late finish = earliest late start of the items waiting on it,
// minus one day; the items with nothing waiting on them can finish as late as the overall last finish.
import {daysBetween} from './dates.ts';

type Dated = {id: string; start: string | null; due: string | null; deps: string[]; completed: string | null};

export function criticalPath(items: Dated[]): Set<string> {
  const dated = items.filter(i => i.due || i.start);
  if (!dated.length) return new Set();
  const base = dated.reduce((m, i) => (i.start ?? i.due!) < m ? (i.start ?? i.due!) : m, dated[0].start ?? dated[0].due!);
  const span = new Map(dated.map(i => { const s = daysBetween(base, i.start ?? i.due!), e = daysBetween(base, i.due ?? i.start!); return [i.id, {s, e, dur: e - s}]; }));
  const succ = new Map<string, string[]>();
  for (const i of dated) for (const d of i.deps) if (span.has(d)) succ.set(d, [...(succ.get(d) ?? []), i.id]);
  const end = Math.max(...[...span.values()].map(x => x.e));
  const lateFinish = new Map<string, number>();
  const lf = (id: string, seen = new Set<string>()): number => {
    if (lateFinish.has(id)) return lateFinish.get(id)!;
    if (seen.has(id)) return end; // a loop should not exist; stop rather than recurse forever
    seen.add(id);
    const next = succ.get(id) ?? [];
    const v = next.length ? Math.min(...next.map(n => lf(n, seen) - span.get(n)!.dur - 1)) : end;
    lateFinish.set(id, v);
    return v;
  };
  const out = new Set<string>();
  for (const i of dated) if (!i.completed && lf(i.id) - span.get(i.id)!.e <= 0) out.add(i.id);
  return out;
}
