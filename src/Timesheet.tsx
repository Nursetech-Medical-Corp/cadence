// Timesheet: one person's week. Tasks as rows, days as columns, hours in the cells. Filled from timers and
// logged time; type in a cell to set that day's hours (it replaces the day's logged entries for that task).
import {useEffect, useMemo, useState} from 'react';
import {ChevronLeft, ChevronRight, Clock, Plus} from 'lucide-react';
import {api, getMe, type Store} from './store.ts';
import {addDays, parseDay} from './dates.ts';
import {itemKey} from './components.tsx';

type Sheet = {weekStart: string; days: string[]; rows: {itemId: string; minutes: number[]}[]};
const monday = (d: string) => { const w = (parseDay(d).getDay() + 6) % 7; return addDays(d, -w); };
const hrs = (m: number) => m ? String(+(m / 60).toFixed(2)) : '';
/** "1.5", "1:30", "90m" all mean 90 minutes. */
const parseHours = (v: string) => {
  const t = v.trim().toLowerCase();
  if (!t) return 0;
  const hm = /^(\d+):(\d{1,2})$/.exec(t); if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const m = /^(\d+(?:\.\d+)?)m$/.exec(t); if (m) return Math.round(Number(m[1]));
  const h = Number(t.replace(/h$/, '')); return Number.isFinite(h) && h >= 0 ? Math.round(h * 60) : NaN;
};

export function TimesheetPage({store, open}: {store: Store; open: (id: string) => void}) {
  const [week, setWeek] = useState(() => monday(store.today));
  const [person, setPerson] = useState(getMe());
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const load = () => person && api<Sheet>(`/timesheet?person=${person}&week=${week}`).then(setSheet).catch(e => setErr(String(e instanceof Error ? e.message : e)));
  useEffect(() => { load(); }, [person, week, store.tick]);
  const rows = useMemo(() => {
    const have = new Map((sheet?.rows ?? []).map(r => [r.itemId, r.minutes]));
    for (const id of extra) if (!have.has(id)) have.set(id, [0, 0, 0, 0, 0, 0, 0]);
    return [...have.entries()].filter(([id]) => store.items.has(id));
  }, [sheet, extra, store.items]);
  const save = async (itemId: string, day: string, text: string) => {
    const minutes = parseHours(text);
    if (Number.isNaN(minutes) || minutes > 1440) { setErr('Use hours like 1.5, 1:30 or 90m'); return; }
    setErr('');
    try { await api('/timesheet', {method: 'PUT', body: {person, itemId, date: day, minutes}}); load(); } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  };
  const days = sheet?.days ?? Array.from({length: 7}, (_, n) => addDays(week, n));
  const dayTotal = (n: number) => rows.reduce((a, [, m]) => a + m[n], 0);
  const total = rows.reduce((a, [, m]) => a + m.reduce((x, y) => x + y, 0), 0);
  const found = q ? [...store.items.values()].filter(i => !i.completed && (i.title + itemKey(i, store.projects)).toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
  return (
    <div className="page" style={{maxWidth: 1100}}>
      <h1><Clock size={20} /> Timesheet</h1>
      <p className="muted">Hours per task per day, from timers and logged time. Type in a cell to set that day's hours (1.5, 1:30 or 90m); clear it to remove them.</p>
      <div className="toolbar" style={{padding: '0 0 10px', border: 0}}>
        <select className="plain-select" value={person} onChange={e => setPerson(e.target.value)}>{store.people.filter(p => p.kind !== 'ai').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button className="icon" onClick={() => setWeek(addDays(week, -7))}><ChevronLeft size={16} /></button>
        <b>{parseDay(week).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})} to {parseDay(addDays(week, 6)).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})}</b>
        <button className="icon" onClick={() => setWeek(addDays(week, 7))}><ChevronRight size={16} /></button>
        <button className="btn ghost small" onClick={() => setWeek(monday(store.today))}>This week</button>
        <span className="spacer" />
        <b>{hrs(total) || 0}h total</b>
      </div>
      {err && <p className="small" style={{color: 'var(--danger)'}}>{err}</p>}
      <table className="grid timesheet">
        <thead><tr><th>Task</th>{days.map(d => <th key={d} className={d === store.today ? 'today' : ''}>{parseDay(d).toLocaleDateString(undefined, {weekday: 'short', day: 'numeric'})}</th>)}<th>Total</th></tr></thead>
        <tbody>
          {rows.map(([id, m]) => { const it = store.items.get(id)!; return (
            <tr key={id}><td><button className="link-btn" onClick={() => open(id)}><span className="muted small">{itemKey(it, store.projects)}</span> {it.title}</button></td>
              {days.map((d, n) => <td key={d} className={d === store.today ? 'today' : ''}><input className="ts-cell" defaultValue={hrs(m[n])} key={`${id}-${d}-${m[n]}`} placeholder="-"
                onBlur={e => { if (e.target.value !== hrs(m[n])) save(id, d, e.target.value); }} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></td>)}
              <td className="ts-total">{hrs(m.reduce((a, b) => a + b, 0))}</td></tr>); })}
          <tr className="ts-sum"><td>Day total</td>{days.map((d, n) => <td key={d}>{hrs(dayTotal(n))}</td>)}<td className="ts-total">{hrs(total)}</td></tr>
        </tbody>
      </table>
      <div className="picker" style={{display: 'block', marginTop: 10, maxWidth: 420}}>
        <div className="pop-search-row"><Plus size={12} /><input placeholder="Add a task to this week" value={q} onChange={e => setQ(e.target.value)} /></div>
        {found.map(i => <button key={i.id} className="pop-row" onClick={() => { setExtra(x => [...x, i.id]); setQ(''); }}><span className="muted small">{itemKey(i, store.projects)}</span> {i.title}</button>)}
      </div>
    </div>
  );
}
