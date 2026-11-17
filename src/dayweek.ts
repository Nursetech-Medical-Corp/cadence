// Day planner across days: copying a time box to another day, and rolling brain dump lines over from earlier days.
import {entryDone, type CheckEntry, type CheckPlan, type TaskInfo} from './daycheck.ts';

type Box = CheckEntry & {start: string; minutes: number; remind?: boolean; remindBefore?: number; notified?: boolean; eventId?: string | null;
  planned?: {start: string; minutes: number} | null; fitted?: boolean; color?: string | null; note?: string; links?: string[]; at?: string | null};

/** A box copied to another day: same title, task, length, color, note and tied tasks; not done, not on the calendar, not fitted. */
export function copyBox<B extends Box>(b: B, newId: () => string, start = b.start): Box {
  const {id: _i, done: _d, notified: _n, eventId: _e, planned: _p, fitted: _f, at: _a, ...rest} = b;
  return {...rest, id: newId(), start};
}

/**
 * Open brain dump lines from earlier days that could come over to this day: plain lines (not tasks), not done,
 * not already on this day. One per text, from the newest day first.
 */
export function carryLines<P extends CheckPlan>(earlier: {date: string; plan: P}[], here: CheckPlan, task: TaskInfo): {date: string; entry: CheckEntry}[] {
  const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const seen = new Set([...here.top, ...here.dump, ...here.blocks].map(e => key(e.text)));
  const out: {date: string; entry: CheckEntry}[] = [];
  for (const {date, plan} of [...earlier].sort((a, b) => b.date.localeCompare(a.date))) {
    for (const e of plan.dump) {
      const k = key(e.text);
      if (e.itemId || !k || seen.has(k) || entryDone(plan, e, task)) continue;
      seen.add(k);
      out.push({date, entry: e});
    }
  }
  return out;
}

/**
 * The time boxes on a day that a line or task is already in, earliest first: boxes for the same task, and boxes
 * with the same text (or the task's title). A thing may sit in several boxes (work, a break, more work).
 */
export function boxesFor<B extends Box>(blocks: B[], e: {itemId?: string | null; text: string}, task: TaskInfo): B[] {
  const key = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const names = new Set([key(e.text), e.itemId ? key(task(e.itemId)?.title) : ''].filter(Boolean));
  return blocks.filter(b => (e.itemId && b.itemId === e.itemId) || (!b.itemId && names.has(key(b.text))) || (!e.itemId && b.itemId && names.has(key(task(b.itemId)?.title))))
    .sort((a, b) => a.start.localeCompare(b.start));
}
