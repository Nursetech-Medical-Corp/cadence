// Calendar: month or week grid by due date. Drag a chip to another day to reschedule (start moves with it),
// drag from "No date" onto a day to schedule, click + on a day to add an item due that day.
import {useState} from 'react';
import {ChevronLeft, ChevronRight, Plus} from 'lucide-react';
import type {Item} from './types.ts';
import {addDays, daysBetween, iso, parseDay} from './dates.ts';
import {Avatars, PriorityIcon, StatusIcon} from './components.tsx';
import type {ViewProps} from './viewProps.ts';

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CalendarView({store, project, items, open, config, setConfig}: ViewProps) {
  const mode = config.zoom === 'day' ? 'week' : 'month';
  const [cursor, setCursor] = useState(store.today);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState<{day: string; text: string} | null>(null);

  const c = parseDay(cursor);
  const first = mode === 'month' ? iso(new Date(c.getFullYear(), c.getMonth(), 1)) : cursor;
  const start = addDays(first, -((parseDay(first).getDay() + 6) % 7));
  const weeks = mode === 'month' ? Math.ceil((daysBetween(start, iso(new Date(c.getFullYear(), c.getMonth() + 1, 0))) + 1) / 7) : 1;
  const days = Array.from({length: weeks * 7}, (_, n) => addDays(start, n));
  // Items with a start and due date show on every day they cover (like ClickUp and Google Calendar), unless "Due dates only".
  const byDay = new Map<string, Item[]>();
  const put = (d: string, i: Item) => byDay.set(d, [...(byDay.get(d) ?? []), i]);
  const last = days[days.length - 1];
  for (const i of items) {
    if (!i.due) continue;
    if (config.dueOnly || !i.start || i.start >= i.due) { put(i.due, i); continue; }
    for (let d = i.start < start ? start : i.start; d <= i.due && d <= last; d = addDays(d, 1)) put(d, i);
  }
  const segment = (i: Item, d: string) => config.dueOnly || !i.start || i.start >= i.due! ? '' : d === i.start ? ' seg-start' : d === i.due ? ' seg-end' : ' seg-mid';
  // Keep multi-day items in the same row order on every day so bars line up.
  const order = (a: Item, b: Item) => Number(!!a.completed) - Number(!!b.completed) || (a.start ?? a.due!).localeCompare(b.start ?? b.due!) || a.sort - b.sort;
  const undated = items.filter(i => !i.due && !i.completed);

  const moveTo = (id: string, day: string) => {
    const i = store.items.get(id);
    if (!i || i.due === day) return;
    const shift = i.due ? daysBetween(i.due, day) : 0;
    store.updateItem(id, {due: day, ...(i.start && i.due ? {start: addDays(i.start, shift)} : {})});
  };
  const step = (n: number) => setCursor(mode === 'month' ? iso(new Date(c.getFullYear(), c.getMonth() + n, 1)) : addDays(cursor, 7 * n));
  const title = mode === 'month'
    ? c.toLocaleDateString(undefined, {month: 'long', year: 'numeric'})
    : `${parseDay(start).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})} to ${parseDay(addDays(start, 6)).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})}`;

  return (
    <div className="cal-wrap">
      <div className="cal-main">
        <div className="cal-bar">
          <button className="icon" onClick={() => step(-1)} title="Previous"><ChevronLeft size={16} /></button>
          <button className="btn" onClick={() => setCursor(store.today)}>Today</button>
          <button className="icon" onClick={() => step(1)} title="Next"><ChevronRight size={16} /></button>
          <b className="cal-title">{title}</b>
          <span className="spacer" />
          <label className="small muted" title="Show items only on their due date instead of across start to due"><input type="checkbox" checked={!!config.dueOnly} onChange={e => setConfig({dueOnly: e.target.checked})} /> Due dates only</label>
          <div className="seg">
            <button className={mode === 'month' ? 'on' : ''} onClick={() => setConfig({zoom: 'month'})}>Month</button>
            <button className={mode === 'week' ? 'on' : ''} onClick={() => setConfig({zoom: 'day'})}>Week</button>
          </div>
        </div>
        <div className="cal-grid">
          {WD.map(w => <div key={w} className="cal-head">{w}</div>)}
          {days.map(d => {
            const list = (byDay.get(d) ?? []).sort(order);
            const out = mode === 'month' && parseDay(d).getMonth() !== c.getMonth();
            const weekend = [0, 6].includes(parseDay(d).getDay());
            return (
              <div key={d} className={'cal-day' + (out ? ' out' : '') + (weekend ? ' weekend' : '') + (d === store.today ? ' today' : '') + (over === d ? ' over' : '') + (mode === 'week' ? ' tall' : '')}
                onDragOver={e => { e.preventDefault(); setOver(d); }} onDragLeave={() => setOver(o => o === d ? null : o)}
                onDrop={() => { if (drag) moveTo(drag, d); setDrag(null); setOver(null); }}>
                <div className="cal-num"><span>{parseDay(d).getDate()}</span><button className="icon cal-add" title="Add item due this day" onClick={() => setAdding({day: d, text: ''})}><Plus size={13} /></button></div>
                {list.slice(0, mode === 'week' ? 50 : 4).map(i => (
                  <div key={i.id} className={'cal-chip' + segment(i, d) + (i.completed ? ' done' : '') + (i.due! < store.today && !i.completed ? ' late' : '')} draggable
                    onDragStart={() => setDrag(i.id)} onDragEnd={() => { setDrag(null); setOver(null); }} onClick={() => open(i.id)} title={i.title}>
                    <StatusIcon status={project.statuses.find(s => s.id === i.status)} size={12} />
                    {i.priority > 0 && i.priority < 3 && <PriorityIcon value={i.priority} size={11} />}
                    <span className="cal-text">{i.title}</span>
                    {mode === 'week' && <Avatars ids={i.assignees} people={store.people} size={16} />}
                  </div>
                ))}
                {mode === 'month' && list.length > 4 && <button className="cal-more" onClick={() => { setCursor(d); setConfig({zoom: 'day'}); }}>+{list.length - 4} more</button>}
                {adding?.day === d && (
                  <input autoFocus className="cal-input" placeholder="Title, Enter" value={adding.text}
                    onChange={e => setAdding({day: d, text: e.target.value})}
                    onBlur={() => !adding.text.trim() && setAdding(null)}
                    onKeyDown={async e => {
                      if (e.key === 'Escape') setAdding(null);
                      if (e.key === 'Enter' && adding.text.trim()) {
                        const t = adding.text; setAdding({day: d, text: ''});
                        const it = await store.quickAdd(project.id, t);
                        if (it && !it.due) store.updateItem(it.id, {due: d});
                      }
                    }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <aside className="cal-side" onDragOver={e => e.preventDefault()} onDrop={() => { if (drag) store.updateItem(drag, {due: null, start: null}); setDrag(null); }}>
        <b>No date</b> <span className="count">{undated.length}</span>
        <div className="muted small" style={{margin: '4px 0 8px'}}>Drag onto a day to schedule. Drop here to clear a date.</div>
        {undated.map(i => (
          <div key={i.id} className="cal-chip side" draggable onDragStart={() => setDrag(i.id)} onDragEnd={() => setDrag(null)} onClick={() => open(i.id)}>
            <StatusIcon status={project.statuses.find(s => s.id === i.status)} size={12} /><span className="cal-text">{i.title}</span>
          </div>
        ))}
      </aside>
    </div>
  );
}
