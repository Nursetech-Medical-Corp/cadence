// Dates are local calendar days as YYYY-MM-DD.

export function iso(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDay(s: string) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number) {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function addUnit(s: string, every: number, unit: 'day' | 'week' | 'month') {
  if (unit === 'day') return addDays(s, every);
  if (unit === 'week') return addDays(s, every * 7);
  const d = parseDay(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + every);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return iso(d);
}

/** The Monday of the week a date falls in. */
export function monday(s: string) { return addDays(s, -((parseDay(s).getDay() + 6) % 7)); }
/** Saturday and Sunday roll forward to Monday; weekdays stay. */
export function skipWeekend(s: string) { const w = parseDay(s).getDay(); return w === 6 ? addDays(s, 2) : w === 0 ? addDays(s, 1) : s; }
/** Moves a start and due off Saturday and Sunday to Monday. keepLength: the due date moves as far as the start did. */
export function offWeekend(start: string | null, due: string | null, keepLength = false): [string | null, string | null] {
  const s = start ? skipWeekend(start) : null;
  const extra = keepLength && start && s ? daysBetween(start, s) : 0;
  return [s, due ? skipWeekend(extra ? addDays(due, extra) : due) : null];
}
export function daysBetween(a: string, b: string) {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86400000);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// today, tomorrow, mon..sun (next occurrence), +3d, +2w, 2026-11-20, 11/20
export function parseDateWord(word: string, today: string): string | null {
  const w = word.toLowerCase();
  if (w === 'today' || w === 'tod') return today;
  if (w === 'tomorrow' || w === 'tom') return addDays(today, 1);
  const rel = /^\+(\d+)([dwm])$/.exec(w);
  if (rel) return addUnit(today, Number(rel[1]), rel[2] === 'd' ? 'day' : rel[2] === 'w' ? 'week' : 'month');
  const wd = WEEKDAYS.findIndex(d => w.startsWith(d));
  if (wd >= 0 && w.length >= 3) {
    const cur = parseDay(today).getDay();
    return addDays(today, ((wd - cur + 7) % 7) || 7);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(w);
  if (mdy) {
    const y = mdy[3].length === 2 ? 2000 + Number(mdy[3]) : Number(mdy[3]);
    const d = new Date(y, Number(mdy[1]) - 1, Number(mdy[2]));
    return d.getMonth() === Number(mdy[1]) - 1 ? iso(d) : null;
  }
  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(w);
  if (md) {
    const y = parseDay(today).getFullYear();
    let s = iso(new Date(y, Number(md[1]) - 1, Number(md[2])));
    if (s < today) s = iso(new Date(y + 1, Number(md[1]) - 1, Number(md[2])));
    return s;
  }
  return null;
}
