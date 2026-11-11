import {useEffect, useRef, useState} from 'react';
import {Trash2} from 'lucide-react';
import type {BurnPoint, Item, Person, Sprint} from './types.ts';
import {api, type Store} from './store.ts';
import {daysBetween} from './dates.ts';
import {Avatar, DateInput, InlineText} from './components.tsx';

export function sprintState(s: Sprint, today: string) {
  return today < s.start ? 'upcoming' : today > s.end ? 'closed' : 'current';
}

/** Per-person open estimate vs capacity. Capacity hours are editable inline. */
export function Capacity({store, sprint, items}: {store: Store; sprint: Sprint; items: Item[]}) {
  const open = items.filter(i => i.sprint === sprint.id && !i.completed);
  const people = store.people.filter(p => sprint.capacity[p.id] || open.some(i => i.assignees.includes(p.id)));
  const unassigned = open.filter(i => !i.assignees.length).reduce((a, i) => a + (i.estimate ?? 0), 0);
  if (!people.length && !unassigned) return <div className="muted small" style={{marginTop: 8}}>Assign work or set capacity to see load.</div>;
  return (
    <div className="cap">
      {people.map(p => <CapRow key={p.id} store={store} sprint={sprint} person={p} hours={open.filter(i => i.assignees.includes(p.id)).reduce((a, i) => a + (i.estimate ?? 0), 0)} />)}
      {unassigned > 0 && <><span className="muted">Unassigned</span><span /><span className="muted">{unassigned}h</span></>}
    </div>
  );
}

function CapRow({store, sprint, person, hours}: {store: Store; sprint: Sprint; person: Person; hours: number}) {
  const cap = sprint.capacity[person.id] ?? 0;
  const pct = cap ? Math.min(100, (100 * hours) / cap) : hours ? 100 : 0;
  return <>
    <span style={{display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden'}}><Avatar person={person} size={16} />{person.name.split(' ')[0]}</span>
    <div className={'meter' + (cap && hours > cap ? ' over' : '')} title={`${hours}h planned of ${cap || '?'}h capacity`}><div style={{width: `${pct}%`}} /></div>
    <span style={{display: 'flex', alignItems: 'center', gap: 2}}>
      {+hours.toFixed(1)}/<input className="inline tiny" type="number" min={0} defaultValue={cap || ''} placeholder="cap" key={cap}
        title="Capacity hours for this sprint"
        onBlur={e => { const v = Number(e.target.value) || 0; if (v !== cap) store.updateSprint(sprint.id, {capacity: {...sprint.capacity, [person.id]: v}}); }} />h
    </span>
  </>;
}

export function SprintCard({store, sprint, items, over, onDragOver, onDrop, current}: {
  store: Store; sprint: Sprint; items: Item[]; over: boolean; current: boolean;
  onDragOver: (e: React.DragEvent) => void; onDrop: () => void;
}) {
  const mine = items.filter(i => i.sprint === sprint.id);
  const done = mine.filter(i => i.completed).length;
  const hours = mine.reduce((a, i) => a + (i.estimate ?? 0), 0);
  const state = sprintState(sprint, store.today);
  return (
    <div className={'sprint-card' + (over ? ' over' : '') + (current ? ' current' : '')} onDragOver={onDragOver} onDrop={onDrop}>
      <div className="sc-head">
        <InlineText value={sprint.name} onSave={name => store.updateSprint(sprint.id, {name})} />
        <span className={'small ' + (state === 'current' ? 'sprint-chip' : 'muted')}>{state}</span>
        <button className="icon" title="Delete sprint (items go back to the backlog)" onClick={() => confirm(`Delete ${sprint.name}? Its items return to the backlog.`) && store.deleteSprint(sprint.id)}><Trash2 size={13} /></button>
      </div>
      <div style={{display: 'flex', alignItems: 'center', gap: 4}} className="small">
        <DateInput value={sprint.start} onChange={start => start && store.updateSprint(sprint.id, {start})} /> to
        <DateInput value={sprint.end} onChange={end => end && store.updateSprint(sprint.id, {end})} />
      </div>
      <InlineText value={sprint.goal} placeholder="Sprint goal" onSave={goal => store.updateSprint(sprint.id, {goal})} className="small" />
      <div className="small muted" style={{padding: '4px 6px'}}>{mine.length} items, {done} done{hours ? `, ${hours}h estimated` : ''}. Drop items here.</div>
      <Capacity store={store} sprint={sprint} items={items} />
    </div>
  );
}

/** Burndown or burnup, sized to its container, with a today marker and a projection at the current pace. */
export function Burndown({sprint, tick, height = 240}: {sprint: Sprint; tick: number; height?: number}) {
  const [points, setPoints] = useState<BurnPoint[]>([]);
  const [unit, setUnit] = useState<'items' | 'hours'>('items');
  const [mode, setMode] = useState<'down' | 'up'>('down');
  const [W, setW] = useState(560);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { api<BurnPoint[]>(`/sprints/${sprint.id}/burndown`).then(p => setPoints(p.map(x => ({...x, remaining: x.remaining ?? NaN, remainingHours: x.remainingHours ?? NaN})))).catch(() => {}); }, [sprint.id, sprint.start, sprint.end, tick]);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const H = height, L = 36, B = 26, T = 14, R = 14;
  const total = points.length ? (unit === 'items' ? points[0].ideal : points[0].idealHours) : 0;
  const rem = (p: BurnPoint) => unit === 'items' ? p.remaining : p.remainingHours;
  const val = (p: BurnPoint) => mode === 'down' ? rem(p) : total - rem(p);
  const ideal = (p: BurnPoint) => { const i = unit === 'items' ? p.ideal : p.idealHours; return mode === 'down' ? i : total - i; };
  const max = Math.max(1, total);
  const sx = (k: number) => L + (k * (W - L - R)) / Math.max(1, points.length - 1);
  const sy = (v: number) => T + (H - T - B) * (1 - v / max);
  const actual = points.map((p, k) => [k, val(p)] as const).filter(([, v]) => Number.isFinite(v));
  const todayIdx = actual.length ? actual[actual.length - 1][0] : -1;
  // Projection: a straight line from the first day through today, carried to the sprint's end.
  let projection: string | null = null, forecast = '';
  if (actual.length >= 2) {
    const [k0, v0] = actual[0], [k1, v1] = actual[actual.length - 1];
    const rate = (v1 - v0) / Math.max(1, k1 - k0);
    const end = points.length - 1, vEnd = v1 + rate * (end - k1);
    projection = `${sx(k1)},${sy(v1)} ${sx(end)},${sy(Math.max(0, Math.min(max, vEnd)))}`;
    const done = mode === 'down' ? vEnd <= 0.001 : vEnd >= total - 0.001;
    const days = mode === 'down' ? (rate < 0 ? v1 / -rate : Infinity) : (rate > 0 ? (total - v1) / rate : Infinity);
    forecast = done ? 'On pace to finish in time' : Number.isFinite(days) ? `At this pace, done about ${Math.ceil(days - (end - k1))} days late` : 'No progress yet at this pace';
  }
  const steps = 4;
  return (
    <div className="chart-card" ref={box}>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
        <b>{mode === 'down' ? 'Burndown' : 'Burnup'}</b><span className="muted small">{sprint.name}, {daysBetween(sprint.start, sprint.end) + 1} days</span><span className="spacer" />
        <div className="seg"><button className={mode === 'down' ? 'on' : ''} onClick={() => setMode('down')}>Down</button><button className={mode === 'up' ? 'on' : ''} onClick={() => setMode('up')}>Up</button></div>
        <div className="seg"><button className={unit === 'items' ? 'on' : ''} onClick={() => setUnit('items')}>Items</button><button className={unit === 'hours' ? 'on' : ''} onClick={() => setUnit('hours')}>Hours</button></div>
      </div>
      {!points.length ? <div className="muted small">Loading...</div> : <>
      <svg width={W} height={H} style={{display: 'block', marginTop: 8, overflow: 'visible'}}>
        {Array.from({length: steps + 1}, (_, k) => {
          const v = (max * k) / steps;
          return <g key={k}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="var(--line2)" /><text x={L - 6} y={sy(v) + 3} textAnchor="end">{Math.round(v)}</text></g>;
        })}
        {points.map((p, k) => (k % Math.ceil(points.length / Math.max(2, Math.floor(W / 70))) === 0 || k === points.length - 1) && <text key={p.date} x={sx(k)} y={H - 8} textAnchor="middle">{p.date.slice(5).replace('-', '/')}</text>)}
        {mode === 'up' && <line x1={L} x2={W - R} y1={sy(total)} y2={sy(total)} stroke="var(--text2)" strokeWidth="1.5"><title>Scope</title></line>}
        <polyline points={points.map((p, k) => `${sx(k)},${sy(ideal(p))}`).join(' ')} fill="none" stroke="var(--muted)" strokeDasharray="5 4" strokeWidth="1.5" />
        {todayIdx >= 0 && todayIdx < points.length - 1 && <><line x1={sx(todayIdx)} x2={sx(todayIdx)} y1={T} y2={H - B} stroke="var(--danger)" strokeWidth="1" opacity=".6" /><text x={sx(todayIdx) + 4} y={T} style={{fill: 'var(--danger)'}}>today</text></>}
        {projection && <polyline points={projection} fill="none" stroke="var(--accent)" strokeDasharray="2 4" strokeWidth="2" opacity=".7" />}
        {actual.length > 0 && <>
          <polygon points={`${sx(actual[0][0])},${sy(0)} ${actual.map(([k, v]) => `${sx(k)},${sy(v)}`).join(' ')} ${sx(actual.at(-1)![0])},${sy(0)}`} fill="var(--accent)" opacity=".08" />
          <polyline points={actual.map(([k, v]) => `${sx(k)},${sy(v)}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
          {actual.map(([k, v]) => <circle key={k} cx={sx(k)} cy={sy(v)} r="3.5" fill="var(--accent)"><title>{`${points[k].date}: ${+v.toFixed(1)} ${unit} ${mode === 'down' ? 'left' : 'done'}`}</title></circle>)}
        </>}
      </svg>
      <div className="legend"><span><i style={{background: 'var(--accent)'}} />{mode === 'down' ? 'Remaining' : 'Completed'}</span><span><i style={{background: 'var(--muted)'}} />Ideal</span>{projection && <span><i style={{background: 'var(--accent)', opacity: .5}} />Projection</span>}{mode === 'up' && <span><i style={{background: 'var(--text2)'}} />Scope</span>}</div>
      <div className="small" style={{marginTop: 4, color: forecast.includes('late') ? 'var(--danger)' : forecast.startsWith('On pace') ? 'var(--ok)' : 'var(--muted)'}}>{forecast || 'The trend line appears once the sprint has run for a day.'}</div>
      </>}
    </div>
  );
}

/** Done work per sprint, for the last few sprints. */
export function Velocity({store, projectId}: {store: Store; projectId: string}) {
  const sprints = store.sprints.filter(s => s.projectId === projectId && s.start <= store.today).sort((a, b) => a.start.localeCompare(b.start)).slice(-6);
  const items = [...store.items.values()].filter(i => i.projectId === projectId);
  const rows = sprints.map(s => {
    const mine = items.filter(i => i.sprint === s.id);
    return {s, done: mine.filter(i => i.completed).length, total: mine.length, hours: mine.filter(i => i.completed).reduce((a, i) => a + (i.estimate ?? 0), 0)};
  });
  const finished = rows.filter(r => r.s.end < store.today);
  const avg = finished.length ? finished.reduce((a, r) => a + r.done, 0) / finished.length : 0;
  const max = Math.max(1, ...rows.map(r => r.total));
  return (
    <div className="chart-card">
      <b>Velocity</b> <span className="muted small">items done per sprint{avg ? `, average ${avg.toFixed(1)} over finished sprints` : ''}</span>
      <div className="velo">
        {rows.map(r => <div key={r.s.id} className="velo-col" title={`${r.s.name}: ${r.done} of ${r.total} done, ${+r.hours.toFixed(1)}h`}>
          <div className="velo-bars"><div className="velo-total" style={{height: `${100 * r.total / max}%`}}><div className="velo-done" style={{height: `${r.total ? 100 * r.done / r.total : 0}%`}} /></div></div>
          <span className="small">{r.done}/{r.total}</span><span className="muted small velo-name">{r.s.name}</span>
        </div>)}
        {!rows.length && <div className="muted small">Velocity shows once sprints have run.</div>}
      </div>
    </div>
  );
}
