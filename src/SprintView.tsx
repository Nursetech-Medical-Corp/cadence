// Sprint view: pick a sprint, see stats, burndown, capacity and a board of just that sprint's work.
import {ListView} from './ListView.tsx';
import {TableView} from './TableView.tsx';
import {useMemo, useState} from 'react';
import {ArrowRightToLine, Plus, Trash2} from 'lucide-react';
import {api} from './store.ts';
import {daysBetween} from './dates.ts';
import {DateInput, Empty, InlineText, Popover, TypeBadge, itemKey} from './components.tsx';
import {Board} from './BoardView.tsx';
import {Burndown, Capacity, Velocity, sprintState} from './SprintParts.tsx';
import type {ViewProps} from './viewProps.ts';

export function SprintView(props: ViewProps) {
  const {store, project, items, allItems, sprints, open, config, setConfig} = props;
  type Tab = 'board' | 'list' | 'table' | 'charts';
  const [tab, setTabState] = useState<Tab>(() => (localStorage.getItem('sprint-tab') as Tab) || 'board');
  const setTab = (t: Tab) => { setTabState(t); localStorage.setItem('sprint-tab', t); };
  const current = useMemo(() => sprints.find(s => sprintState(s, store.today) === 'current') ?? sprints.find(s => sprintState(s, store.today) === 'upcoming') ?? sprints.at(-1), [sprints, store.today]);
  const sprint = sprints.find(s => s.id === config.sprint) ?? current;
  const [groupBy, setGroupBy] = useState<'status' | 'assignee'>('status');
  if (!sprint) return <Empty title="No sprints yet"><p>Sprints are time boxes (usually 2 weeks) you plan work into.</p><button className="btn primary" onClick={() => store.createSprint(project.id)}><Plus size={14} /> Create first sprint</button></Empty>;

  const mine = items.filter(i => i.sprint === sprint.id);
  const all = allItems.filter(i => i.sprint === sprint.id);
  const done = all.filter(i => i.completed);
  const hours = all.reduce((a, i) => a + (i.estimate ?? 0), 0), hoursLeft = all.filter(i => !i.completed).reduce((a, i) => a + (i.estimate ?? 0), 0);
  const state = sprintState(sprint, store.today);
  const unfinished = all.filter(i => !i.completed).length;
  const left = state === 'current' ? daysBetween(store.today, sprint.end) : state === 'upcoming' ? daysBetween(store.today, sprint.start) : 0;

  return (
    <div>
      <div className="sprint-head">
        <select className="plain-select" value={sprint.id} onChange={e => setConfig({sprint: e.target.value})}>
          {sprints.map(s => <option key={s.id} value={s.id}>{s.name} ({sprintState(s, store.today)})</option>)}
        </select>
        <button className="btn" onClick={async () => { const s = await store.createSprint(project.id); if (s) setConfig({sprint: s.id}); }}><Plus size={14} /> New sprint</button>
        <span style={{display: 'flex', alignItems: 'center', gap: 4}}>
          <DateInput value={sprint.start} onChange={start => start && store.updateSprint(sprint.id, {start})} /> to
          <DateInput value={sprint.end} onChange={end => end && store.updateSprint(sprint.id, {end})} />
        </span>
        <button className="btn" disabled={!unfinished}
          title={unfinished ? `Move the ${unfinished} unfinished item${unfinished === 1 ? '' : 's'} to the next sprint (made for you if there is none). Settings, Automations can do this when a sprint ends.` : 'Nothing unfinished to move. When the sprint ends, unfinished items can move to the next one here.'} onClick={async () => {
          if (!confirm(`Move ${unfinished} unfinished item${unfinished === 1 ? '' : 's'} from ${sprint.name} to the next sprint?`)) return;
          try { const r = await api<{moved: number; to: {id: string}}>(`/sprints/${sprint.id}/rollover`, {method: 'POST'}); setConfig({sprint: r.to.id}); } catch (e) { store.fail(e); }
        }}><ArrowRightToLine size={14} /> Roll over unfinished</button>
        <button className="icon" title="Delete sprint (items return to the backlog)" onClick={() => confirm(`Delete ${sprint.name}? Its items return to the backlog.`) && store.deleteSprint(sprint.id)}><Trash2 size={14} /></button>
      </div>
      <div className="sprint-head">
        <InlineText value={sprint.name} onSave={name => store.updateSprint(sprint.id, {name})} className="h2" />
        <InlineText value={sprint.goal} placeholder="Add a sprint goal" onSave={goal => store.updateSprint(sprint.id, {goal})} className="grow" />
      </div>
      <div className="sprint-head">
        <div className="stat"><b>{state === 'closed' ? 'Closed' : left}</b><span>{state === 'current' ? 'days left' : state === 'upcoming' ? 'days until start' : 'sprint ended'}</span></div>
        <div className="stat"><b>{done.length}/{all.length}</b><span>items done</span></div>
        <div className="stat"><b>{+hoursLeft.toFixed(1)}h</b><span>of {+hours.toFixed(1)}h remaining</span></div>
        <div className="stat"><b>{all.length ? Math.round((100 * done.length) / all.length) : 0}%</b><span>complete</span></div>
      </div>
      <div className="seg sprint-tabs">{([['board', 'Board'], ['list', 'List'], ['table', 'Table'], ['charts', 'Burndown and capacity']] as const).map(([k, l]) =>
        <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'charts' && <div className="sprint-charts">
        <Burndown sprint={sprint} tick={store.tick} />
        <Velocity store={store} projectId={project.id} />
        <div className="chart-card"><b>Capacity</b><div className="muted small">Open estimate vs hours available. Click a number to set capacity.</div><Capacity store={store} sprint={sprint} items={allItems} /></div>
      </div>}
      {tab !== 'charts' && <>
      <div className="toolbar" style={{borderBottom: 0, paddingTop: 14}}>
        <b>{tab === 'list' ? 'Sprint list' : tab === 'table' ? 'Sprint table' : 'Sprint board'}</b><span className="muted small">{mine.length} items</span>
        <AddToSprint store={store} sprintId={sprint.id} items={allItems} />
        <span className="muted small">Or type in a column's + Add, drag from the Backlog view, or set Sprint on any item.</span>
        <span className="spacer" />
        {tab === 'board' && <div className="seg"><button className={groupBy === 'status' ? 'on' : ''} onClick={() => setGroupBy('status')}>By status</button><button className={groupBy === 'assignee' ? 'on' : ''} onClick={() => setGroupBy('assignee')}>By person</button></div>}
      </div>
      {tab === 'board' ? <Board store={store} project={project} items={mine} allItems={allItems} sprints={sprints} open={open} groupBy={groupBy} createExtra={{sprint: sprint.id}} />
        : tab === 'list' ? <ListView {...props} items={mine} createExtra={{sprint: sprint.id}} />
        : <TableView {...props} items={mine} createExtra={{sprint: sprint.id}} />}
      </>}
    </div>
  );
}

/** Pick backlog items to pull into this sprint. Children come along. */
function AddToSprint({store, sprintId, items}: {store: ViewProps['store']; sprintId: string; items: ViewProps['allItems']}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const candidates = items.filter(i => !i.completed && i.sprint !== sprintId && i.title.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.sprint ? 1 : 0) - (b.sprint ? 1 : 0) || (a.priority || 9) - (b.priority || 9));
  const add = (id: string) => {
    const family = (pid: string): string[] => [pid, ...items.filter(i => i.parentId === pid && !i.completed).flatMap(i => family(i.id))];
    for (const x of family(id)) store.updateItem(x, {sprint: sprintId});
  };
  return (
    <span className="picker">
      <button className="btn primary" onClick={() => setOpen(o => !o)}><Plus size={14} /> Add work</button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide">
        <input autoFocus className="pop-search" placeholder="Search backlog" value={q} onChange={e => setQ(e.target.value)} />
        <div className="pop-label">Click to add to this sprint (subitems come too)</div>
        {candidates.slice(0, 40).map(i => (
          <button key={i.id} className="pop-row" onClick={() => add(i.id)}>
            <span className="muted small">{itemKey(i, store.projects)}</span><TypeBadge type={i.type} /><span className="grow" style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>{i.title}</span>
            {i.sprint && <span className="muted small">{store.sprints.find(s => s.id === i.sprint)?.name}</span>}
          </button>
        ))}
        {!candidates.length && <div className="pop-row muted">Nothing left to add</div>}
      </Popover>
    </span>
  );
}
