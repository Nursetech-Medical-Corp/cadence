// Team insights for project managers: who finished what, time logged, estimate vs actual, and flagged work.
// Flags: overdue, over estimate (logged more than 125%), stalled (open, untouched for 14 days), blocked, no owner, no estimate.
import {useEffect, useMemo, useState} from 'react';
import {AlertTriangle, Clock, Flag} from 'lucide-react';
import type {Item, TimeEntry} from './types.ts';
import {addDays} from './dates.ts';
import {api, fmtMinutes, type Store} from './store.ts';
import {Avatar, Empty, itemKey} from './components.tsx';

type Flagged = {item: Item; reasons: string[]};

export function InsightsPage({store, open}: {store: Store; open: (id: string) => void}) {
  const [days, setDays] = useState(14);
  const [project, setProject] = useState('');
  const [time, setTime] = useState<TimeEntry[]>([]);
  useEffect(() => { api<TimeEntry[]>('/time').then(setTime).catch(() => {}); }, [store.tick]);
  const today = store.today, since = addDays(today, -days + 1);
  const items = useMemo(() => [...store.items.values()].filter(i => !project || i.projectId === project), [store.items, project]);
  const parents = new Set(items.map(i => i.parentId).filter(Boolean));
  const logged = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of time) m.set(t.itemId, (m.get(t.itemId) ?? 0) + (t.minutes ?? 0));
    return m;
  }, [time]);
  const inRange = (iso: string) => iso.slice(0, 10) >= since && iso.slice(0, 10) <= today;

  const people = store.people.map(p => {
    const mine = items.filter(i => i.assignees.includes(p.id));
    const done = mine.filter(i => i.completed && inRange(i.completed));
    const open = mine.filter(i => !i.completed);
    const mins = time.filter(t => t.person === p.id && inRange(t.start) && items.some(i => i.id === t.itemId)).reduce((a, t) => a + (t.minutes ?? 0), 0);
    // Accuracy: completed leaf items with both an estimate and logged time.
    const measured = mine.filter(i => i.completed && i.estimate && logged.get(i.id) && !parents.has(i.id));
    const est = measured.reduce((a, i) => a + i.estimate! * 60, 0), act = measured.reduce((a, i) => a + logged.get(i.id)!, 0);
    const onTime = done.filter(i => !i.due || i.completed!.slice(0, 10) <= i.due).length;
    return {p, done: done.length, open: open.length, overdue: open.filter(i => i.due && i.due < today).length, mins, est, act, measured: measured.length,
      onTime: done.length ? Math.round(100 * onTime / done.length) : null, openHours: open.filter(i => !parents.has(i.id)).reduce((a, i) => a + (i.estimate ?? 0), 0)};
  });

  const flagged: Flagged[] = items.filter(i => !i.completed).map(i => {
    const r: string[] = [];
    if (i.due && i.due < today) { const d = Math.round((Date.parse(today) - Date.parse(i.due)) / 86400000); r.push(d > 365 ? `overdue ${Math.floor(d / 365)}+ years` : `overdue ${d}d`); }
    const l = logged.get(i.id) ?? 0;
    if (i.estimate && l > i.estimate * 60 * 1.25) r.push(`over estimate: ${fmtMinutes(l)} of ${i.estimate}h`);
    if (i.updated.slice(0, 10) < addDays(today, -14)) r.push('no change in 14+ days');
    if (i.deps.some(d => !store.items.get(d)?.completed)) r.push('blocked');
    if (!i.assignees.length && !parents.has(i.id)) r.push('no owner');
    if (!i.estimate && !parents.has(i.id) && i.sprint) r.push('in a sprint with no estimate');
    return {item: i, reasons: r};
  }).filter(f => f.reasons.length).sort((a, b) => b.reasons.length - a.reasons.length || (a.item.due ?? '9').localeCompare(b.item.due ?? '9'));

  const totalMins = people.reduce((a, x) => a + x.mins, 0);
  const pct = (a: number, b: number) => b ? Math.round(100 * a / b) : null;

  return (
    <div className="page" style={{maxWidth: 1200}}>
      <h1>Team insights</h1>
      <p className="muted">How work is going across people. Estimates are compared with logged time on finished items, so accuracy improves as people use timers.</p>
      <div className="toolbar" style={{padding: '0 0 12px', border: 0}}>
        <div className="seg">{[7, 14, 30, 90].map(d => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} days</button>)}</div>
        <select className="plain-select" value={project} onChange={e => setProject(e.target.value)}><option value="">All projects</option>{store.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <span className="muted small">{fmtMinutes(totalMins)} logged in this period, {items.filter(i => i.completed && inRange(i.completed)).length} items finished</span>
      </div>

      <div className="chart-card" style={{overflowX: 'auto'}}>
        <table className="ins-table">
          <thead><tr><th>Person</th><th>Finished</th><th>On time</th><th>Open</th><th>Overdue</th><th>Open estimate</th><th>Time logged</th><th>Estimate vs actual</th></tr></thead>
          <tbody>{people.map(x => {
            const ratio = pct(x.act, x.est);
            return (
              <tr key={x.p.id}>
                <td><span style={{display: 'flex', alignItems: 'center', gap: 8}}><Avatar person={x.p} size={22} />{x.p.name}</span></td>
                <td>{x.done}</td>
                <td>{x.onTime === null ? '-' : <span className={x.onTime < 70 ? 'bad' : 'good'}>{x.onTime}%</span>}</td>
                <td>{x.open}</td>
                <td>{x.overdue ? <span className="bad">{x.overdue}</span> : 0}</td>
                <td>{+x.openHours.toFixed(1)}h</td>
                <td><span className="ins-bar"><span style={{width: `${pct(x.mins, Math.max(...people.map(y => y.mins), 1))}%`}} /></span>{fmtMinutes(x.mins)}</td>
                <td title={`${x.measured} finished items with an estimate and logged time`}>{ratio === null ? <span className="muted">not enough data</span> :
                  <span className={ratio > 125 ? 'bad' : ratio < 75 ? 'warn' : 'good'}>{ratio}% <span className="muted small">({fmtMinutes(x.act)} vs {fmtMinutes(x.est)})</span></span>}</td>
              </tr>
            );
          })}</tbody>
        </table>
        <div className="muted small" style={{marginTop: 6}}>Estimate vs actual: 100% means spot on, above 125% means work takes longer than planned, below 75% means estimates run high.</div>
      </div>

      <h3 style={{marginTop: 24}}><Flag size={15} /> Flagged work <span className="count">{flagged.length}</span></h3>
      {flagged.slice(0, 60).map(f => (
        <div key={f.item.id} className="row" style={{cursor: 'pointer'}} onClick={() => open(f.item.id)}>
          <AlertTriangle size={14} style={{color: f.reasons.some(r => r.startsWith('overdue') || r.startsWith('over')) ? 'var(--danger)' : '#e2a400'}} />
          <span className="muted small">{itemKey(f.item, store.projects)}</span>
          <span className="grow title" style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{f.item.title}</span>
          {f.reasons.map(r => <span key={r} className="tag flag-tag">{r}</span>)}
          {f.item.assignees.slice(0, 2).map(a => <Avatar key={a} person={store.people.find(p => p.id === a)} size={18} />)}
        </div>
      ))}
      {!flagged.length && <Empty title="Nothing flagged">No overdue, over-estimate, stalled or blocked work.</Empty>}

      <h3 style={{marginTop: 24}}><Clock size={15} /> Recent time entries</h3>
      {time.filter(t => inRange(t.start) && items.some(i => i.id === t.itemId)).slice(0, 30).map(t => {
        const it = store.items.get(t.itemId);
        return <div key={t.id} className="row small"><Avatar person={store.people.find(p => p.id === t.person)} size={18} /><span className="grow">{it?.title}</span><span className="muted">{new Date(t.start).toLocaleDateString()}</span><b>{t.minutes ? fmtMinutes(t.minutes) : 'running'}</b></div>;
      })}
    </div>
  );
}
