// Plan and forecast: AI-style help you approve before anything changes.
// 1. Estimates for work that has none, from similar finished work.
// 2. Replan: new dates (and optionally owners) that fit capacity; tick what to apply.
// 3. Forecast: demand vs capacity by month and skill, when to hire, and spend.
// 4. Planning details per person: weekly hours, skill, hourly rate, start/end, planned hires.
import {useEffect, useState} from 'react';
import {CalendarClock, Sparkles, TrendingUp, Users} from 'lucide-react';
import {api, type Store} from './store.ts';
import {Avatar, itemKey} from './components.tsx';

type Est = {itemId: string; title: string; hours: number; basis: string; confidence: string};
type Change = {itemId: string; title: string; from: {start: string | null; due: string | null; assignees: string[]}; to: {start: string; due: string; assignees: string[]}; reason: string; late: number};
type Month = {month: string; demand: number; capacity: number; plannedHireCapacity: number; gap: number; peopleNeeded: number; spend: {labor: number; other: number; total: number}; bySkill: Record<string, {demand: number; capacity: number; gap: number}>};
type Forecast = {months: Month[]; unscheduledHours: number; overdueHours: number; missingEstimates: number; hireSignals: {month: string; skill: string; shortHours: number; people: number}[]; note: string};
type PPerson = {id: string; name: string; weeklyHours: number; skill: string; rate: number; start: string | null; end: string | null; plannedHire: boolean; active: boolean};

export function PlanPage({store}: {store: Store}) {
  const [project, setProject] = useState(() => store.projects[0]?.id ?? '');
  const [tab, setTab] = useState<'replan' | 'estimates' | 'forecast' | 'people'>('replan');
  const q = project ? `projectId=${project}` : '';
  return (
    <div className="page" style={{maxWidth: 1200}}>
      <h1><Sparkles size={20} /> Plan and forecast</h1>
      <p className="muted">Suggestions you review first: nothing changes until you approve. AI agents can run the same steps through the API and MCP.</p>
      <div className="toolbar" style={{padding: '0 0 12px', border: 0}}>
        <select className="plain-select" value={project} onChange={e => setProject(e.target.value)}><option value="">All projects</option>{store.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <div className="seg">
          <button className={tab === 'replan' ? 'on' : ''} onClick={() => setTab('replan')}><CalendarClock size={13} /> Replan</button>
          <button className={tab === 'estimates' ? 'on' : ''} onClick={() => setTab('estimates')}>Estimates</button>
          <button className={tab === 'forecast' ? 'on' : ''} onClick={() => setTab('forecast')}><TrendingUp size={13} /> Forecast and hiring</button>
          <button className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}><Users size={13} /> Capacity and rates</button>
        </div>
      </div>
      {tab === 'replan' && <Replan store={store} q={q} />}
      {tab === 'estimates' && <Estimates store={store} q={q} />}
      {tab === 'forecast' && <ForecastView q={q} />}
      {tab === 'people' && <PeoplePlanning store={store} />}
    </div>
  );
}

function Replan({store, q}: {store: Store; q: string}) {
  const [reassign, setReassign] = useState(false);
  const [data, setData] = useState<{changes: Change[]; note: string} | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const load = () => api<{changes: Change[]; note: string}>(`/plan/replan?${q}&reassign=${reassign}`).then(d => { setData(d); setPick(new Set()); }).catch(store.fail);
  useEffect(() => { load(); }, [q, reassign]);
  const name = (ids: string[]) => ids.map(id => store.people.find(p => p.id === id)?.name ?? '?').join(', ') || 'nobody';
  if (!data) return <p className="muted">Working out a schedule...</p>;
  return <>
    <div className="chart-card" style={{marginBottom: 12}}>
      <b>Reschedule open work to fit real capacity</b>
      <div className="muted small">Uses each person's weekly hours, estimates, dependencies and priority. Overdue work moves to the earliest realistic dates. {data.note}</div>
      <label className="small" style={{display: 'block', marginTop: 6}}><input type="checkbox" checked={reassign} onChange={e => setReassign(e.target.checked)} /> Also suggest a different owner when someone else could finish before the due date</label>
    </div>
    {data.changes.length ? <>
      <div className="toolbar" style={{padding: '0 0 8px', border: 0}}>
        <b>{data.changes.length} suggested changes</b>
        <button className="btn ghost small" onClick={() => setPick(new Set(pick.size ? [] : data.changes.map(c => c.itemId)))}>{pick.size ? 'Clear all' : 'Select all'}</button>
        <span className="spacer" />
        <button className="btn primary" disabled={!pick.size} onClick={async () => {
          const changes = data.changes.filter(c => pick.has(c.itemId)).map(c => ({itemId: c.itemId, start: c.to.start, due: c.to.due, assignees: c.to.assignees}));
          try { const r = await api<{applied: number}>('/plan/apply', {method: 'POST', body: {changes}}); alert(`Applied ${r.applied} changes. Undo any of them from History.`); load(); } catch (e) { store.fail(e); }
        }}>Approve {pick.size} changes</button>
      </div>
      <table className="ins-table">
        <thead><tr><th /><th>Item</th><th>Due now</th><th>Suggested</th><th>Owner</th><th>Why</th></tr></thead>
        <tbody>{data.changes.map(c => {
          const it = store.items.get(c.itemId);
          return <tr key={c.itemId}>
            <td><input type="checkbox" checked={pick.has(c.itemId)} onChange={() => setPick(s => { const n = new Set(s); n.has(c.itemId) ? n.delete(c.itemId) : n.add(c.itemId); return n; })} /></td>
            <td style={{whiteSpace: 'normal', maxWidth: 320}}>{it && <span className="muted small">{itemKey(it, store.projects)} </span>}{c.title}</td>
            <td className={c.from.due && c.from.due < store.today ? 'bad' : ''}>{c.from.due ?? 'none'}</td>
            <td><b>{c.to.start === c.to.due ? c.to.due : `${c.to.start.slice(5)} to ${c.to.due.slice(5)}`}</b>{c.late > 0 && <span className="bad"> ({c.late}d late)</span>}</td>
            <td>{c.to.assignees.join() !== c.from.assignees.join() ? <><s className="muted">{name(c.from.assignees)}</s> {name(c.to.assignees)}</> : name(c.to.assignees)}</td>
            <td className="small muted" style={{whiteSpace: 'normal'}}>{c.reason}</td>
          </tr>;
        })}</tbody>
      </table>
    </> : <p className="muted">Everything fits. No changes suggested.</p>}
  </>;
}

function Estimates({store, q}: {store: Store; q: string}) {
  const [list, setList] = useState<Est[]>([]);
  const [hours, setHours] = useState<Record<string, number>>({});
  const load = () => api<Est[]>(`/plan/estimates?${q}`).then(l => { setList(l); setHours(Object.fromEntries(l.map(e => [e.itemId, e.hours]))); }).catch(store.fail);
  useEffect(() => { load(); }, [q]);
  return <>
    <div className="chart-card" style={{marginBottom: 12}}><b>Suggested estimates</b><div className="muted small">From similar finished work and logged time. Edit any number, then apply. Estimates feed replanning, workload and forecasts.</div></div>
    {list.length ? <>
      <button className="btn primary" style={{marginBottom: 8}} onClick={async () => { await api('/plan/estimates', {method: 'POST', body: {estimates: list.map(e => ({itemId: e.itemId, hours: hours[e.itemId]}))}}).catch(store.fail); load(); }}>Apply {list.length} estimates</button>
      {list.map(e => <div key={e.itemId} className="row">
        <span className="grow">{e.title}</span>
        <span className={'tag'}>{e.confidence}</span>
        <span className="muted small" style={{maxWidth: 280}}>{e.basis}</span>
        <input className="plain-select" type="number" step={0.25} min={0} style={{width: 70}} value={hours[e.itemId] ?? e.hours} onChange={ev => setHours(h => ({...h, [e.itemId]: Number(ev.target.value)}))} />h
      </div>)}
    </> : <p className="muted">Every open item has an estimate.</p>}
  </>;
}

function ForecastView({q}: {q: string}) {
  const [f, setF] = useState<Forecast | null>(null);
  const [months, setMonths] = useState(6);
  useEffect(() => { api<Forecast>(`/plan/forecast?${q}&months=${months}`).then(setF).catch(() => {}); }, [q, months]);
  if (!f) return <p className="muted">Loading...</p>;
  const max = Math.max(1, ...f.months.map(m => Math.max(m.demand, m.capacity + m.plannedHireCapacity)));
  const money = (n: number) => n ? '$' + n.toLocaleString() : '-';
  return <>
    <div className="sprint-head" style={{padding: '0 0 12px'}}>
      <div className="stat"><b>{f.overdueHours}h</b><span>overdue work</span></div>
      <div className="stat"><b>{f.unscheduledHours}h</b><span>open with no due date</span></div>
      <div className="stat"><b>{f.missingEstimates}</b><span>items with no estimate</span></div>
      <div className="seg">{[3, 6, 12].map(n => <button key={n} className={months === n ? 'on' : ''} onClick={() => setMonths(n)}>{n} months</button>)}</div>
    </div>
    <div className="chart-card">
      <b>Work vs capacity by month</b>
      <div className="fc-bars">
        {f.months.map(m => <div key={m.month} className="fc-col" title={`${m.month}: ${m.demand}h of work, ${m.capacity}h capacity${m.plannedHireCapacity ? ` + ${m.plannedHireCapacity}h planned hires` : ''}`}>
          <div className="fc-pair">
            <div className={'fc-demand' + (m.gap > 0 ? ' over' : '')} style={{height: `${100 * m.demand / max}%`}} />
            <div className="fc-cap" style={{height: `${100 * m.capacity / max}%`}}><div className="fc-hire" style={{height: `${m.plannedHireCapacity / Math.max(1, m.capacity + m.plannedHireCapacity) * 100}%`}} /></div>
          </div>
          <span className="small">{m.month.slice(5)}/{m.month.slice(2, 4)}</span>
          {m.peopleNeeded > 0 && <span className="small bad">+{m.peopleNeeded} people</span>}
        </div>)}
      </div>
      <div className="legend"><span><i style={{background: 'var(--accent)'}} />Work (estimates)</span><span><i style={{background: 'var(--ok)'}} />Capacity</span><span><i style={{background: '#e2a400'}} />Planned hires</span><span><i style={{background: 'var(--danger)'}} />Over capacity</span></div>
    </div>
    <table className="ins-table" style={{marginTop: 14}}>
      <thead><tr><th>Month</th><th>Work</th><th>Capacity</th><th>Gap</th><th>People needed</th><th>Labor</th><th>Other costs</th><th>Total spend</th></tr></thead>
      <tbody>{f.months.map(m => <tr key={m.month}><td>{m.month}</td><td>{m.demand}h</td><td>{m.capacity}h{m.plannedHireCapacity ? ` + ${m.plannedHireCapacity}h` : ''}</td>
        <td className={m.gap > 0 ? 'bad' : 'good'}>{m.gap > 0 ? `+${m.gap}h short` : `${-m.gap}h spare`}</td><td>{m.peopleNeeded || '-'}</td><td>{money(m.spend.labor)}</td><td>{money(m.spend.other)}</td><td><b>{money(m.spend.total)}</b></td></tr>)}</tbody>
    </table>
    <h3>When to hire</h3>
    {f.hireSignals.length ? f.hireSignals.map((h, n) => <div key={n} className="row"><span className="bad">{h.month}</span><span className="grow"><b>{h.skill}</b>: {h.shortHours}h more work than capacity</span><span>about {h.people} people</span></div>)
      : <p className="muted small">No skill is short of capacity in this window.</p>}
    <p className="muted small">{f.note} Other costs come from a number custom field named Cost (or Budget) on items; the skill a task needs comes from a field named Skill. Add them in project Settings, Custom fields.</p>
  </>;
}

function PeoplePlanning({store}: {store: Store}) {
  const [list, setList] = useState<PPerson[]>([]);
  const load = () => api<PPerson[]>('/plan/people').then(setList).catch(() => {});
  useEffect(() => { load(); }, [store.tick]);
  const save = async (id: string, patch: Partial<PPerson>) => { try { await api(`/plan/people/${id}`, {method: 'PATCH', body: patch}); load(); } catch (e) { store.fail(e); } };
  return <>
    <div className="chart-card" style={{marginBottom: 12}}><b>Capacity and rates</b><div className="muted small">Weekly hours drive replanning, workload and forecasts. Skill groups people for hiring signals. Hourly rate turns hours into labor cost. Add a planned hire (a person with a future start date, ticked Planned) to see how a hire closes a gap.</div></div>
    <table className="ins-table">
      <thead><tr><th>Person</th><th>Hours / week</th><th>Skill</th><th>Rate $/h</th><th>Starts</th><th>Ends</th><th>Planned hire</th></tr></thead>
      <tbody>{list.map(p => <tr key={p.id}>
        <td><span style={{display: 'flex', gap: 6, alignItems: 'center'}}><Avatar person={store.people.find(x => x.id === p.id)} size={20} />{p.name}</span></td>
        <td><input className="plain-select" type="number" min={0} max={80} style={{width: 64}} defaultValue={p.weeklyHours} key={'w' + p.weeklyHours} onBlur={e => Number(e.target.value) !== p.weeklyHours && save(p.id, {weeklyHours: Number(e.target.value)})} /></td>
        <td><input className="plain-select" style={{width: 130}} placeholder="e.g. Regulatory" defaultValue={p.skill} key={'s' + p.skill} onBlur={e => e.target.value !== p.skill && save(p.id, {skill: e.target.value})} /></td>
        <td><input className="plain-select" type="number" min={0} style={{width: 70}} defaultValue={p.rate} key={'r' + p.rate} onBlur={e => Number(e.target.value) !== p.rate && save(p.id, {rate: Number(e.target.value)})} /></td>
        <td><input className="plain-select" type="date" defaultValue={p.start ?? ''} key={'a' + p.start} onBlur={e => (e.target.value || null) !== p.start && save(p.id, {start: e.target.value || null})} /></td>
        <td><input className="plain-select" type="date" defaultValue={p.end ?? ''} key={'b' + p.end} onBlur={e => (e.target.value || null) !== p.end && save(p.id, {end: e.target.value || null})} /></td>
        <td><input type="checkbox" checked={p.plannedHire} onChange={e => save(p.id, {plannedHire: e.target.checked})} /></td>
      </tr>)}</tbody>
    </table>
    <button className="btn" style={{marginTop: 10}} onClick={async () => { const name = prompt('Planned hire, e.g. "Hire: Regulatory specialist"'); if (!name) return; const p = await store.createPerson(name); if (p) { await save(p.id, {plannedHire: true, start: store.today}); } }}>+ Add a planned hire</button>
  </>;
}
