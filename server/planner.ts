// Planning helpers. Deterministic and explainable, so a person (or an AI agent through MCP) can review
// every proposal before applying it.
//
// - estimateMissing: hours for open work without an estimate, from similar finished work.
// - replan: schedule open work against each person's capacity, respecting dependencies and priority;
//   moves overdue work to the earliest realistic dates, optionally reassigns to meet due dates.
// - forecast: monthly demand vs capacity (overall and by skill), people needed, and spend.
//
// Planning data lives on people (weekly hours, skill, hourly rate, start/end, planned hire) and on items
// (estimate, plus custom values fields.cost for non-labor spend and fields.skill for the skill needed).
import {hoursFor} from '../src/hours.ts';
import {Invalid} from './errors.ts';
import type {Item, ItemPatch} from '../src/types.ts';
import type {Tasks} from './service.ts';
import {addUnit, daysBetween, parseDay} from '../src/dates.ts';
import {busyHours} from './events.ts';

export type Person = {id: string; name: string; weeklyHours: number; skill: string; rate: number; start: string | null; end: string | null; plannedHire: boolean; active: boolean};

export function planningPeople(tasks: Tasks): Person[] {
  return tasks.db.prepare('select id, name, weekly_hours, skill, rate, start_date, end_date, planned_hire, active from people').all().map(r => ({
    id: r.id as string, name: r.name as string, weeklyHours: (r.weekly_hours as number) ?? 40, skill: (r.skill as string) ?? '', rate: (r.rate as number) ?? 0,
    start: (r.start_date as string) ?? null, end: (r.end_date as string) ?? null, plannedHire: !!r.planned_hire, active: r.active !== 0,
  }));
}
export function migratePlanning(tasks: Tasks) {
  const cols = tasks.db.prepare('pragma table_info(people)').all().map(r => r.name);
  for (const [c, def] of [['weekly_hours', 'real not null default 40'], ['skill', "text not null default ''"], ['rate', 'real not null default 0'], ['start_date', 'text'], ['end_date', 'text'], ['planned_hire', 'integer not null default 0']] as const)
    if (!cols.includes(c)) tasks.db.exec(`alter table people add column ${c} ${def}`);
}

const weekday = (d: string) => { const w = parseDay(d).getDay(); return w !== 0 && w !== 6; };
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const leafOpen = (tasks: Tasks, projectId?: string) => {
  const all = tasks.listItems({projectId});
  const parents = new Set(all.map(i => i.parentId).filter(Boolean));
  return {all, parents, open: all.filter(i => !i.completed && !i.recur?.paused && !parents.has(i.id))};
};

export function estimateMissing(tasks: Tasks, projectId?: string) {
  const {all, parents, open} = leafOpen(tasks, projectId);
  const logged = new Map<string, number>();
  for (const t of tasks.listTime({})) logged.set(t.itemId, (logged.get(t.itemId) ?? 0) + (t.minutes ?? 0) / 60);
  const done = all.filter(i => i.completed && !parents.has(i.id) && (logged.get(i.id) || i.estimate));
  const actual = (i: Item) => logged.get(i.id) || i.estimate || 0;
  return open.filter(i => !i.estimate).map(i => {
    const w = words(i.title);
    const similar = done.filter(d => d.type === i.type && ([...words(d.title)].some(x => w.has(x)) || d.tags.some(t => i.tags.includes(t))));
    let hours: number, basis: string, confidence: 'high' | 'medium' | 'low';
    if (similar.length >= 2) { hours = median(similar.map(actual)); basis = `median of ${similar.length} similar finished ${i.type.toLowerCase()}s`; confidence = similar.length >= 4 ? 'high' : 'medium'; }
    else {
      const sameType = done.filter(d => d.type === i.type).map(actual).concat(open.filter(o => o.type === i.type && o.estimate).map(o => o.estimate!));
      if (sameType.length >= 2) { hours = median(sameType); basis = `typical ${i.type.toLowerCase()} in this space (${sameType.length} examples)`; confidence = 'low'; }
      else { hours = 2; basis = 'no history yet, default 2h'; confidence = 'low'; }
    }
    return {itemId: i.id, title: i.title, hours: Math.max(0.25, Math.round(hours * 4) / 4), basis, confidence};
  });
}

export type PlanChange = {itemId: string; title: string; from: {start: string | null; due: string | null; assignees: string[]}; to: {start: string; due: string; assignees: string[]}; reason: string; late: number};

export function replan(tasks: Tasks, opts: {projectId?: string; reassign?: boolean; horizonDays?: number} = {}) {
  const today = tasks.today();
  const people = planningPeople(tasks).filter(p => p.active && !p.plannedHire);
  // Schedule every project so cross-project load counts; propose changes only for the chosen one.
  const {open} = leafOpen(tasks);
  const items = open.filter(i => i.estimate && i.estimate > 0 && i.fields.worker !== 'ai');
  const byId = new Map(items.map(i => [i.id, i]));
  // Capacity left per person per day.
  const load = new Map<string, Map<string, number>>();
  // Meetings (and time-blocks for other work) take hours out of each day.
  let meetings = new Map<string, Map<string, number>>();
  try { meetings = busyHours(tasks, today, addUnit(today, 365, 'day')); } catch { /* no events table in old data */ }
  const capOn = (p: Person, d: string) => (!weekday(d) || (p.start && d < p.start) || (p.end && d > p.end)) ? 0 : Math.max(0, p.weeklyHours / 5 - (meetings.get(p.id)?.get(d) ?? 0));
  const left = (p: Person, d: string) => capOn(p, d) - (load.get(p.id)?.get(d) ?? 0);
  // Order: dependencies first, then earliest due, then priority.
  const order: Item[] = [], seen = new Set<string>();
  const visit = (i: Item) => { if (seen.has(i.id)) return; seen.add(i.id); for (const d of i.deps) { const x = byId.get(d); if (x) visit(x); } order.push(i); };
  [...items].sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || (a.priority || 9) - (b.priority || 9)).forEach(visit);
  const finish = new Map<string, string>();
  const simulate = (p: Person, hours: number, from: string, commit: boolean) => {
    let d = from, need = hours, first: string | null = null, guard = 0;
    while (need > 0.001 && guard++ < 730) {
      const room = left(p, d);
      if (room > 0.001) {
        const take = Math.min(room, need);
        if (commit) { const m = load.get(p.id) ?? new Map(); m.set(d, (m.get(d) ?? 0) + take); load.set(p.id, m); }
        need -= take; first ??= d;
      }
      if (need > 0.001) d = addUnit(d, 1, 'day');
    }
    return {start: first ?? from, end: d};
  };
  const changes: PlanChange[] = [];
  for (const i of order) {
    const depEnd = i.deps.map(d => finish.get(d) ?? (tasks.listItems({}).find(x => x.id === d)?.due ?? null)).filter(Boolean).sort().at(-1) as string | undefined;
    let earliest = depEnd && depEnd >= today ? addUnit(depEnd, 1, 'day') : today;
    if (i.start && i.start > earliest && !(i.due && i.due < today)) earliest = i.start; // keep planned starts in the future
    const owners = people.filter(p => i.assignees.includes(p.id));
    const hours = (i.estimate ?? 0) / Math.max(1, owners.length);
    let best = owners[0] ?? null, bestEnd = best ? simulate(best, hours, earliest, false).end : null;
    if (opts.reassign && i.due && (!bestEnd || bestEnd > i.due)) {
      const skill = (i.fields.skill as string) || '';
      for (const p of people.filter(p => !skill || p.skill === skill || !p.skill)) {
        const e = simulate(p, i.estimate ?? 0, earliest, false).end;
        if (!bestEnd || e < bestEnd) { best = p; bestEnd = e; }
      }
    }
    if (!best) continue; // unassigned: nothing to schedule against
    const assignees = owners.length && owners.includes(best) ? i.assignees : [best.id];
    const sched = owners.length > 1 && assignees === i.assignees
      ? owners.map(o => simulate(o, hoursFor(i, o.id), earliest, true)).reduce((a, b) => ({start: a.start < b.start ? a.start : b.start, end: a.end > b.end ? a.end : b.end}))
      : simulate(best, i.estimate ?? 0, earliest, true);
    finish.set(i.id, sched.end);
    const late = i.due ? Math.max(0, daysBetween(i.due, sched.end)) : 0;
    const overdue = !!i.due && i.due < today;
    if (opts.projectId && i.projectId !== opts.projectId) continue;
    // Leave work that already fits alone: only overdue, late, or reassigned items get a proposal.
    if (!overdue && !late && assignees === i.assignees) continue;
    const moved = sched.end !== i.due || sched.start !== i.start || assignees !== i.assignees;
    if (!moved) continue;
    const reason = [
      overdue ? `overdue since ${i.due}` : '',
      assignees !== i.assignees ? `reassigned to ${best.name} who can finish sooner` : '',
      late && !overdue ? `cannot fit before its due date, ${late} days late at current capacity` : '',
      depEnd && depEnd >= today ? 'waits for its dependencies' : '',
      !overdue && !late ? 'fits the schedule' : '',
    ].filter(Boolean).join('; ');
    changes.push({itemId: i.id, title: i.title, from: {start: i.start, due: i.due, assignees: i.assignees}, to: {start: sched.start, due: sched.end, assignees}, reason, late});
  }
  const skipped = open.filter(i => !i.estimate).length + items.filter(i => !i.assignees.length && !opts.reassign).length;
  return {changes: changes.sort((a, b) => b.late - a.late || a.to.due.localeCompare(b.to.due)), skipped, note: skipped ? `${skipped} open items were skipped (no estimate, or no owner). Run estimates first.` : ''};
}

export function applyPlan(tasks: Tasks, changes: {itemId: string; start?: string | null; due?: string | null; assignees?: string[]}[], actor: string | null) {
  let n = 0;
  for (const c of changes) {
    const patch: ItemPatch = {};
    if (c.start !== undefined) patch.start = c.start;
    if (c.due !== undefined) patch.due = c.due;
    if (c.assignees) patch.assignees = c.assignees;
    // Clear start first if the new due would precede the old start.
    const cur = tasks.item(c.itemId);
    if (patch.due && cur.start && cur.start > patch.due && patch.start === undefined) patch.start = patch.due;
    tasks.updateItem(c.itemId, patch, actor);
    n++;
  }
  return {applied: n};
}

export function forecast(tasks: Tasks, opts: {projectId?: string; months?: number} = {}) {
  const today = tasks.today(), months = Math.min(24, opts.months ?? 6);
  const people = planningPeople(tasks).filter(p => p.active);
  const {open, all} = leafOpen(tasks, opts.projectId);
  const monthOf = (d: string) => d.slice(0, 7);
  const keys = Array.from({length: months}, (_, k) => { const d = parseDay(today); d.setDate(1); d.setMonth(d.getMonth() + k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const row = () => ({demand: 0, capacity: 0, hireCapacity: 0, labor: 0, other: 0, bySkill: {} as Record<string, {demand: number; capacity: number}>});
  const out = new Map(keys.map(k => [k, row()]));
  const avgRate = median(people.filter(p => p.rate).map(p => p.rate)) || 0;
  // Cost and skill come from custom fields named like "Cost"/"Budget" and "Skill" (or the keys cost/skill).
  const fieldIds = new Map(tasks.listProjects().map(p => [p.id, {
    cost: p.fields.find(f => f.kind === 'number' && /^(cost|budget|amount|spend)/i.test(f.name))?.id ?? 'cost',
    skill: p.fields.find(f => /^skill/i.test(f.name))?.id ?? 'skill'}]));
  const costOf = (i: Item) => Number(i.fields[fieldIds.get(i.projectId)?.cost ?? 'cost']) || 0;
  let unscheduled = 0;
  const overdue = open.filter(i => i.due && i.due < today).reduce((a, i) => a + (i.estimate ?? 0), 0);
  for (const i of open) {
    const h = i.estimate ?? 0;
    if (!h) continue;
    if (!i.due) { unscheduled += h; continue; }
    // Overdue work lands in the current month.
    const s = i.due < today ? today : (i.start && i.start >= today ? i.start : today);
    const e = i.due < today ? today : i.due;
    const days = Array.from({length: Math.max(1, daysBetween(s, e) + 1)}, (_, n) => addUnit(s, n, 'day')).filter(weekday);
    const span = days.length ? days : [e];
    const owner = people.find(p => i.assignees.includes(p.id));
    const rate = owner?.rate || avgRate;
    const skill = (i.fields[fieldIds.get(i.projectId)?.skill ?? 'skill'] as string) || owner?.skill || 'Unspecified';
    for (const d of span) {
      const r = out.get(monthOf(d)); if (!r) continue;
      const part = h / span.length;
      r.demand += part; r.labor += part * rate;
      (r.bySkill[skill] ??= {demand: 0, capacity: 0}).demand += part;
    }
  }
  for (const i of all) {
    const cost = costOf(i);
    if (!cost || !i.due) continue;
    const r = out.get(monthOf(i.due < today ? today : i.due)); if (r) r.other += cost;
  }
  for (const k of keys) {
    const r = out.get(k)!;
    const first = `${k}-01`, last = addUnit(addUnit(first, 1, 'month'), -1, 'day');
    for (const p of people) {
      const days = Array.from({length: daysBetween(first, last) + 1}, (_, n) => addUnit(first, n, 'day'))
        .filter(d => weekday(d) && d >= today.slice(0, 7) + '-01' && (!p.start || d >= p.start) && (!p.end || d <= p.end));
      const cap = days.length * p.weeklyHours / 5;
      if (p.plannedHire) r.hireCapacity += cap; else r.capacity += cap;
      (r.bySkill[p.skill || 'Unspecified'] ??= {demand: 0, capacity: 0}).capacity += p.plannedHire ? 0 : cap;
    }
  }
  const workdays = (k: string) => { const first = `${k}-01`; const last = addUnit(addUnit(first, 1, 'month'), -1, 'day'); return Array.from({length: daysBetween(first, last) + 1}, (_, n) => addUnit(first, n, 'day')).filter(weekday).length; };
  const rows = keys.map(k => {
    const r = out.get(k)!;
    const gap = r.demand - r.capacity - r.hireCapacity;
    return {month: k, demand: round(r.demand), capacity: round(r.capacity), plannedHireCapacity: round(r.hireCapacity), gap: round(gap),
      peopleNeeded: gap > 0 ? Math.ceil((gap / (8 * workdays(k))) * 10) / 10 : 0,
      spend: {labor: Math.round(r.labor), other: Math.round(r.other), total: Math.round(r.labor + r.other)},
      bySkill: Object.fromEntries(Object.entries(r.bySkill).map(([s, v]) => [s, {demand: round(v.demand), capacity: round(v.capacity), gap: round(v.demand - v.capacity)}]))};
  });
  const hires = rows.flatMap(r => Object.entries(r.bySkill).filter(([, v]) => v.gap > 20).map(([skill, v]) => ({month: r.month, skill, shortHours: v.gap, people: Math.ceil(v.gap / (8 * workdays(r.month)) * 10) / 10})));
  return {months: rows, unscheduledHours: round(unscheduled), overdueHours: round(overdue), missingEstimates: open.filter(i => !i.estimate).length, hireSignals: hires,
    note: 'Demand is open estimates spread over working days to each due date (overdue work counts now). Capacity is weekly hours of active people. Add planned hires on the Team page to test scenarios.'};
}
const round = (n: number) => Math.round(n * 10) / 10;
