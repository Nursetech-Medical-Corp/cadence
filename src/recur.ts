// Recurrence rules shared by the server (spawning the next item) and the UI (preview and summary).
import {addDays, addUnit, daysBetween, parseDay, monday, skipWeekend} from './dates.ts';
import type {Recur} from './types.ts';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORD = ['1st', '2nd', '3rd', '4th', 'last'];

/** Which week of the month a date falls in: 1..4, or 5 meaning "last". */
export function nthOfMonth(day: string) {
  const d = parseDay(day), last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getDate() + 7 > last ? 5 : Math.ceil(d.getDate() / 7);
}

function nthWeekday(year: number, month: number, weekday: number, nth: number) {
  if (nth === 5) {
    const last = new Date(year, month + 1, 0);
    last.setDate(last.getDate() - ((last.getDay() - weekday + 7) % 7));
    return last;
  }
  const first = new Date(year, month, 1);
  first.setDate(1 + ((weekday - first.getDay() + 7) % 7) + (nth - 1) * 7);
  return first;
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Next date strictly after `base`. `anchor` is the original date the rule is measured from. */
export function nextOccurrence(r: Recur, base: string, anchor = base): string {
  let next: string;
  if (r.unit === 'day') next = addDays(base, r.every);
  else if (r.unit === 'week' && r.weekdays?.length) {
    // Walk forward to the next listed weekday in a week that matches the "every N weeks" cadence.
    const weekOf = (s: string) => Math.floor(daysBetween(monday(anchor), s) / 7);
    next = addDays(base, 1);
    for (let n = 0; n < 7 * r.every * 2 + 7; n++) {
      if (r.weekdays.includes(parseDay(next).getDay()) && ((weekOf(next) % r.every) + r.every) % r.every === 0) break;
      next = addDays(next, 1);
    }
  } else if (r.unit === 'week') next = addDays(base, 7 * r.every);
  else if (r.unit === 'month' && r.monthBy === 'nth') {
    const a = parseDay(anchor), b = parseDay(base);
    const target = new Date(b.getFullYear(), b.getMonth() + r.every, 1);
    next = iso(nthWeekday(target.getFullYear(), target.getMonth(), a.getDay(), nthOfMonth(anchor)));
  } else if (r.unit === 'month') {
    // Keep the anchor's day of month (31st clamps to the month's last day).
    const a = parseDay(anchor), b = parseDay(base);
    const target = new Date(b.getFullYear(), b.getMonth() + r.every, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(a.getDate(), last));
    next = iso(target);
  } else next = addUnit(base, 12 * r.every, 'month');
  return r.skipWeekends ? skipWeekend(next) : next;
}


/** Upcoming dates for a preview, honoring end conditions. */
export function upcoming(r: Recur, from: string, n = 8): string[] {
  const out: string[] = [];
  let cur = from, left = r.count ?? Infinity;
  while (out.length < n && left > 0) {
    cur = nextOccurrence(r, cur, from);
    if (r.until && cur > r.until) break;
    out.push(cur);
    left--;
  }
  return out;
}

export function describeRecur(r: Recur, anchor?: string | null) {
  const every = r.every === 1 ? '' : `${r.every} `;
  let s = '';
  if (r.unit === 'day') s = r.every === 1 ? 'Daily' : `Every ${r.every} days`;
  else if (r.unit === 'week') {
    const days = r.weekdays?.length ? ` on ${[...r.weekdays].sort().map(d => DAY_NAMES[d]).join(', ')}` : '';
    s = r.every === 1 ? `Weekly${days}` : `Every ${every}weeks${days}`;
    if (r.weekdays?.length === 5 && [1, 2, 3, 4, 5].every(d => r.weekdays!.includes(d)) && r.every === 1) s = 'Every weekday';
  } else if (r.unit === 'month') {
    const on = anchor ? (r.monthBy === 'nth' ? ` on the ${ORD[nthOfMonth(anchor) - 1]} ${DAY_NAMES[parseDay(anchor).getDay()]}` : ` on day ${parseDay(anchor).getDate()}`) : '';
    s = (r.every === 1 ? 'Monthly' : `Every ${r.every} months`) + on;
  } else s = r.every === 1 ? 'Yearly' : `Every ${r.every} years`;
  if (r.skipWeekends) s += ', skip weekends';
  if (r.mode === 'completion') s += ', after completion';
  if (r.until) s += `, until ${r.until}`;
  if (r.count) s += `, ${r.count} more`;
  return s;
}
