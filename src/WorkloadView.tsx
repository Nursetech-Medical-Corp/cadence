// Workload: hours per person per day against capacity. Each item's estimate is spread evenly over the
// weekdays from its start (or due) to its due date. Expand a person to see their items; drag one onto
// another person to reassign it.
import {hoursFor} from './hours.ts';
import {useEffect, useMemo, useState} from 'react';
import {api} from './store.ts';
import {ChevronDown, ChevronLeft, ChevronRight} from 'lucide-react';
import type {Item} from './types.ts';
import {addDays, daysBetween, parseDay} from './dates.ts';
import {Avatar} from './components.tsx';
import type {ViewProps} from './viewProps.ts';
import {upcoming} from './recur.ts';
import {sortItems, sortsOf} from './Sorting.tsx';

const isWeekend = (d: string) => [0, 6].includes(parseDay(d).getDay());

export function WorkloadView({store, project, items, allItems, open, config, setConfig}: ViewProps) {
  const weeks = config.zoom === 'month' ? 6 : config.zoom === 'day' ? 1 : 2;
  const [weekly, setWeekly] = useState<Record<string, number>>({});
  useEffect(() => { api<{id: string; weeklyHours: number}[]>('/plan/people').then(l => setWeekly(Object.fromEntries(l.map(p => [p.id, p.weeklyHours])))).catch(() => {}); }, [store.tick]);
  const perDayFor = (pid: string) => config.dailyHours ?? (weekly[pid] ?? 40) / 5;
  const perDay = config.dailyHours ?? 8;
  const [from, setFrom] = useState(() => { const d = parseDay(store.today); return addDays(store.today, -((d.getDay() + 6) % 7)); });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const days = Array.from({length: weeks * 7}, (_, n) => addDays(from, n));
  // Only leaf items count: a parent's estimate usually sums its children, so counting both would double it.
  const parents = new Set(allItems.map(i => i.parentId).filter(Boolean));
  const open_ = items.filter(i => !i.completed && i.due && !parents.has(i.id));

  // Hours per day for one item, over its working days.
  const spread = (i: Item, personId: string) => {
    const s = i.start && i.start <= i.due! ? i.start : i.due!;
    const work = Array.from({length: daysBetween(s, i.due!) + 1}, (_, n) => addDays(s, n)).filter(d => !isWeekend(d));
    const span = work.length ? work : [i.due!];
    const each = (personId ? hoursFor(i, personId) : i.estimate ?? 0) / span.length;
    return new Map(span.map(d => [d, each]));
  };
  // Routines count on every date they come back inside the window (unless Hide repeats), not just the live copy.
  const live = (i: Item) => !!i.recur && !i.recur.paused && !i.recur.waiting && !i.recur.spawned && !i.completed && !config.hideRepeats;
  const repeats = (i: Item) => live(i) ? upcoming(i.recur!, i.due!, Math.max(0, Math.min(400, daysBetween(i.due!, days[days.length - 1]) + 1))).filter(d => d <= days[days.length - 1]) : [];
  const rows = useMemo(() => {
    const people = [...store.people.map(p => ({id: p.id, person: p})), {id: '', person: undefined}];
    return people.map(r => {
      const mine = open_.filter(i => r.id ? i.assignees.includes(r.id) : !i.assignees.length);
      const hours = new Map<string, number>(), count = new Map<string, number>();
      for (const i of mine) {
        for (const [d, h] of spread(i, r.id)) { hours.set(d, (hours.get(d) ?? 0) + h); count.set(d, (count.get(d) ?? 0) + 1); }
        const each = r.id ? hoursFor(i, r.id) : i.estimate ?? 0;
        for (const d of repeats(i)) if (d >= days[0]) { hours.set(d, (hours.get(d) ?? 0) + each); count.set(d, (count.get(d) ?? 0) + 1); }
      }
      return {...r, items: mine, hours, count};
    }).filter(r => r.id || r.items.length);
  }, [open_, store.people, from, weeks, config.hideRepeats]);

  const level = (h: number, cap: number) => h === 0 ? '' : h <= cap * 0.8 ? 'ok' : h <= cap ? 'full' : 'over';
  const W = weeks === 6 ? 34 : weeks === 1 ? 110 : 64;
  const fmt = (h: number) => h ? (h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)) : '';

  return (
    <div className="wl">
      <div className="cal-bar" style={{padding: '10px 16px'}}>
        <button className="icon" onClick={() => setFrom(addDays(from, -7 * weeks))}><ChevronLeft size={16} /></button>
        <button className="btn" onClick={() => { const d = parseDay(store.today); setFrom(addDays(store.today, -((d.getDay() + 6) % 7))); }}>This week</button>
        <button className="icon" onClick={() => setFrom(addDays(from, 7 * weeks))}><ChevronRight size={16} /></button>
        <b className="cal-title">{parseDay(from).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})} to {parseDay(days.at(-1)!).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}</b>
        <span className="spacer" />
        <label className="small muted" title="Leave empty to use each person's weekly hours from Plan, Capacity and rates">Hours per day <input className="plain-select" type="number" min={1} max={24} style={{width: 64}} placeholder="per person" value={config.dailyHours ?? ''} onChange={e => setConfig({dailyHours: e.target.value ? Math.max(1, Number(e.target.value)) : undefined})} /></label>
        <div className="seg">
          <button className={weeks === 1 ? 'on' : ''} onClick={() => setConfig({zoom: 'day'})}>1 week</button>
          <button className={weeks === 2 ? 'on' : ''} onClick={() => setConfig({zoom: 'week'})}>2 weeks</button>
          <button className={weeks === 6 ? 'on' : ''} onClick={() => setConfig({zoom: 'month'})}>6 weeks</button>
        </div>
      </div>
      <div className="wl-grid" style={{gridTemplateColumns: `220px repeat(${days.length}, ${W}px) 80px`}}>
        <div className="wl-h">Person</div>
        {days.map(d => <div key={d} className={'wl-h day' + (isWeekend(d) ? ' we' : '') + (d === store.today ? ' today' : '')}>{weeks === 6 ? parseDay(d).getDate() : parseDay(d).toLocaleDateString(undefined, {weekday: 'short', day: 'numeric'})}</div>)}
        <div className="wl-h">Total</div>
        {rows.map(r => {
          const total = days.reduce((a, d) => a + (r.hours.get(d) ?? 0), 0);
          const cap = days.filter(d => !isWeekend(d)).length * perDayFor(r.id);
          const isOpen = expanded.has(r.id);
          return (
            <div key={r.id || 'none'} className={'wl-person' + (over === r.id && drag ? ' over' : '')} style={{display: 'contents'}}>
              <div className="wl-name" onClick={() => setExpanded(x => { const n = new Set(x); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })}
                onDragOver={e => { e.preventDefault(); setOver(r.id); }} onDrop={() => { if (drag) store.updateItem(drag, {assignees: r.id ? [r.id] : []}); setDrag(null); setOver(null); }}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {r.person ? <Avatar person={r.person} size={22} /> : <span className="assign-empty" />}
                <span className="grow">{r.person?.name ?? 'Unassigned'}</span><span className="count">{r.items.length}</span>
              </div>
              {days.map(d => {
                const h = r.hours.get(d) ?? 0;
                return <div key={d} className={'wl-cell ' + level(h, perDayFor(r.id)) + (isWeekend(d) ? ' we' : '')} title={`${r.person?.name ?? 'Unassigned'}, ${d}: ${h.toFixed(1)}h in ${r.count.get(d) ?? 0} item(s), capacity ${perDayFor(r.id)}h`}
                  onDragOver={e => { e.preventDefault(); setOver(r.id); }} onDrop={() => { if (drag) store.updateItem(drag, {assignees: r.id ? [r.id] : []}); setDrag(null); setOver(null); }}>
                  {fmt(h)}
                </div>;
              })}
              <div className={'wl-cell total ' + (total > cap ? 'over' : '')}>{Math.round(total)}h<span className="muted small"> / {cap}</span></div>
              {isOpen && (sortsOf(config).length ? sortItems(r.items, sortsOf(config), project, store) : r.items.sort((a, b) => (a.start ?? a.due!).localeCompare(b.start ?? b.due!))).map(i => {
                const s = i.start && i.start <= i.due! ? i.start : i.due!;
                const a = Math.max(0, daysBetween(from, s)), b = Math.min(days.length - 1, daysBetween(from, i.due!));
                return (
                  <div key={i.id} style={{display: 'contents'}}>
                    <div className="wl-item-name" onClick={() => open(i.id)} title={i.title}>{i.title}</div>
                    <div className="wl-lane" style={{gridColumn: `2 / span ${days.length}`}}>
                      {b >= 0 && a < days.length && <div className="wl-bar" draggable onDragStart={() => setDrag(i.id)} onDragEnd={() => { setDrag(null); setOver(null); }} onClick={() => open(i.id)}
                        style={{left: a * W, width: (b - a + 1) * W - 4}} title={`${i.title}: ${i.estimate ?? 0}h, drag onto a person to reassign`}>
                        {i.estimate ? `${i.estimate}h` : 'no estimate'}</div>}
                      {repeats(i).map(d => { const n = daysBetween(from, d); return n >= 0 && n < days.length ? <div key={d} className="wl-bar ghost" onClick={() => open(i.id)} style={{left: n * W, width: W - 4}} title={`${i.title} repeats on ${d}`}>{i.estimate ? `${i.estimate}h` : ''}</div> : null; })}
                    </div>
                    <div />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="muted small" style={{padding: '10px 16px'}}>
        Estimates are spread over weekdays from start to due; shared items use each person's own hours, or an even split. Parents with subitems are skipped so hours are not counted twice. Items without an estimate count as 0 hours. Routines count on each date they repeat (faded bars). Green is under 80% of capacity, amber is near full, red is over. {open_.filter(i => !i.estimate).length} open items have no estimate.
      </div>
    </div>
  );
}
