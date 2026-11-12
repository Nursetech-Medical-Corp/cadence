import {TimeCell} from './TimeTracker.tsx';
import {useState} from 'react';
import {activeColors, colorOf, tint} from './ColorRules.tsx';
import {useQuickAssist} from './QuickAssist.tsx';
import {CardCover} from './FilesCell.tsx';
import {GripVertical, Link2} from 'lucide-react';
import {RoutineMark} from './RoutineControls.tsx';
import type {Item, ItemPatch, Sprint} from './types.ts';
import {PRIORITIES} from './types.ts';
import {between, type Store} from './store.ts';
import {Avatars, PriorityIcon, StatusIcon, TypeBadge, EstimateText, itemKey, SpaceChip} from './components.tsx';
import type {ViewProps} from './viewProps.ts';
import {sortItems, sortsOf, type SortRule} from './Sorting.tsx';

type Group = {id: string; name: string; color: string; icon?: React.ReactNode; match: (i: Item) => boolean; patch: (i: Item) => ItemPatch};

export function BoardView({store, project, items, allItems, sprints, open, config}: ViewProps) {
  const lane = config.swimlane ?? 'none';
  if (lane === 'none') return <Board store={store} project={project} items={items} allItems={allItems} sprints={sprints} open={open} groupBy={config.groupBy ?? 'status'} sorts={sortsOf(config)} covers={config.covers} colors={activeColors(config)} />;
  // Swimlanes: one board per lane; adding a card in a lane sets that lane's value.
  const lanes: {id: string; name: string; match: (i: Item) => boolean; extra: ItemPatch}[] =
    lane === 'assignee' ? [...store.people.map(p => ({id: p.id, name: p.name, match: (i: Item) => i.assignees[0] === p.id, extra: {assignees: [p.id]}})), {id: '', name: 'Unassigned', match: (i: Item) => !i.assignees.length, extra: {}}]
    : lane === 'priority' ? [1, 2, 3, 4, 0].map(p => ({id: String(p), name: PRIORITIES[p], match: (i: Item) => i.priority === p, extra: {priority: p}}))
    : lane === 'type' ? project.types.map(t => ({id: t, name: t, match: (i: Item) => i.type === t, extra: {type: t}}))
    : lane === 'worker' ? (['human', 'ai', 'either'] as const).map(w => ({id: w, name: w === 'ai' ? 'AI' : w[0].toUpperCase() + w.slice(1), match: (i: Item) => ((i.fields.worker as string) ?? 'either') === w, extra: {fields: {worker: w}}}))
    : [...allItems.filter(p => allItems.some(c => c.parentId === p.id) && items.some(c => c.parentId === p.id)).map(p => ({id: p.id, name: p.title, match: (i: Item) => i.parentId === p.id, extra: {parentId: p.id}})),
       {id: '', name: 'No parent', match: (i: Item) => !i.parentId || !items.some(c => c.parentId === i.parentId), extra: {}}];
  return <div className="lanes">{lanes.map(l => {
    const mine = items.filter(l.match);
    if (!mine.length && lane === 'parent') return null;
    return <details key={l.id} className="lane" open>
      <summary><b>{l.name}</b> <span className="muted small">{mine.length}</span></summary>
      <Board store={store} project={project} items={mine} allItems={allItems} sprints={sprints} open={open} groupBy={config.groupBy ?? 'status'} sorts={sortsOf(config)} createExtra={l.extra} compact covers={config.covers} colors={activeColors(config)} />
    </details>;
  })}</div>;
}

/** Shared by the Board view and the Sprint view. */
export function Board({store, project, items, allItems, sprints, open, groupBy, createExtra = {}, sorts = [], compact, covers, colors}: {
  store: Store; project: ViewProps['project']; items: Item[]; allItems: Item[]; sprints: Sprint[]; open: (id: string) => void;
  groupBy: NonNullable<ViewProps['config']['groupBy']>; createExtra?: ItemPatch; sorts?: SortRule[]; compact?: boolean; covers?: boolean; colors?: ViewProps['config']['colors'];
}) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{group: string; before: string | null} | null>(null);
  const [adding, setAdding] = useState<{group: string; text: string} | null>(null);

  const groups: Group[] =
    groupBy === 'priority' ? [1, 2, 3, 4, 0].map(p => ({id: String(p), name: PRIORITIES[p], color: 'transparent', icon: <PriorityIcon value={p} />, match: i => i.priority === p, patch: () => ({priority: p})}))
    : groupBy === 'type' ? project.types.map(t => ({id: t, name: t, color: 'transparent', icon: <TypeBadge type={t} />, match: (i: Item) => i.type === t, patch: () => ({type: t})}))
    : groupBy === 'sprint' ? [{id: '', name: 'Backlog', color: '#8b8d98', match: (i: Item) => !i.sprint, patch: () => ({sprint: null})},
        ...sprints.map(s => ({id: s.id, name: s.name, color: '#6d5dfc', match: (i: Item) => i.sprint === s.id, patch: () => ({sprint: s.id})}))]
    : groupBy === 'assignee' ? [{id: '', name: 'Unassigned', color: '#8b8d98', match: (i: Item) => !i.assignees.length, patch: () => ({assignees: []})},
        ...store.people.map(p => ({id: p.id, name: p.name, color: p.color, match: (i: Item) => i.assignees.includes(p.id), patch: () => ({assignees: [p.id]})}))]
    : project.statuses.map(s => ({id: s.id, name: s.name, color: s.color, icon: <StatusIcon status={s} />, match: (i: Item) => i.status === s.id, patch: () => ({status: s.id})}));

  // Columns: drag a header to reorder. Status columns reorder the project's statuses, type columns its types.
  const [colDrag, setColDrag] = useState<string | null>(null);
  const [colOver, setColOver] = useState<string | null>(null);
  const reorderable = groupBy === 'status' || groupBy === 'type';
  const moveColumn = (from: string, to: string) => {
    if (from === to) return;
    if (groupBy === 'status') {
      const l = [...project.statuses]; const [m] = l.splice(l.findIndex(s => s.id === from), 1); l.splice(l.findIndex(s => s.id === to), 0, m);
      store.updateProject(project.id, {statuses: l});
    } else {
      const l = [...project.types]; const [m] = l.splice(l.indexOf(from), 1); l.splice(l.indexOf(to), 0, m);
      store.updateProject(project.id, {types: l});
    }
  };
  const sorted = sortItems(items, sorts, project, store);
  const drop = (g: Group, beforeId: string | null) => {
    const item = items.find(i => i.id === drag);
    setDrag(null); setOver(null);
    if (!item) return;
    const col = sorted.filter(g.match).filter(i => i.id !== item.id);
    const idx = beforeId ? col.findIndex(i => i.id === beforeId) : col.length;
    store.updateItem(item.id, {...(g.match(item) ? {} : g.patch(item)), sort: between(col[idx - 1]?.sort, col[idx]?.sort)});
  };

  return (
    <div className={'board' + (compact ? ' board-lane' : '')}>
      {groups.map(g => {
        const cards = sorted.filter(g.match);
        const hours = cards.reduce((a, i) => a + (Number(i.estimate) || 0), 0);
        return (
          <div key={g.id} className={'column' + (over?.group === g.id && drag ? ' over' : '')}
            onDragOver={e => { e.preventDefault(); if (!colDrag && over?.group !== g.id) setOver({group: g.id, before: null}); }} onDrop={() => !colDrag && drop(g, over?.before ?? null)}>
            <div className={'col-head' + (reorderable ? ' movable' : '') + (colOver === g.id && colDrag && colDrag !== g.id ? ' col-drop' : '')} style={g.color ? {boxShadow: `inset 0 3px 0 ${g.color}`, background: `color-mix(in srgb, ${g.color} 8%, transparent)`} : undefined}
              draggable={reorderable} title={reorderable ? 'Drag to reorder columns' : undefined}
              onDragStart={e => { e.stopPropagation(); setColDrag(g.id); }} onDragEnd={() => { setColDrag(null); setColOver(null); }}
              onDragOver={e => { if (colDrag) { e.preventDefault(); e.stopPropagation(); setColOver(g.id); } }}
              onDrop={e => { if (!colDrag) return; e.stopPropagation(); moveColumn(colDrag, g.id); setColDrag(null); setColOver(null); }}>
              {reorderable && <GripVertical size={13} className="muted col-grip" />}
              {g.icon ?? <span className="dot" style={{background: g.color}} />}{g.name}
              {(() => {
                // WIP limit: set on status columns; the count turns red when the column holds more.
                const st = groupBy === 'status' ? project.statuses.find(s => s.id === g.id) : undefined;
                const total = st ? items.filter(i => i.status === st.id).length : cards.length;
                const over = st?.wip ? total > st.wip : false;
                return <span className={over ? 'wip-over' : 'muted'} title={st ? (st.wip ? `Limit ${st.wip} in progress. Click to change` : 'Click to set a work-in-progress limit') : undefined}
                  onClick={st ? e => { e.stopPropagation(); const v = prompt(`Most items allowed in "${st.name}" at once (empty for no limit)`, st.wip ? String(st.wip) : ''); if (v === null) return; const n = Number(v); store.updateProject(project.id, {statuses: project.statuses.map(x => x.id === st.id ? {...x, wip: v.trim() && n > 0 ? Math.floor(n) : null} : x)}); } : undefined}
                  style={st ? {cursor: 'pointer'} : undefined}>{cards.length}{st?.wip ? `/${st.wip}` : ''}{hours ? `, ${+hours.toFixed(1)}h` : ''}</span>;
              })()}</div>
            {cards.map(i => {
              const kids = allItems.filter(k => k.parentId === i.id);
              const blocked = i.deps.some(d => !allItems.find(x => x.id === d)?.completed);
              return (
                <div key={i.id} data-id={i.id} style={tint(colorOf(i, colors, {project, today: store.today}))} className={'card' + (drag === i.id ? ' dragging' : '') + (i.completed ? ' done' : '') + (over?.before === i.id && drag !== i.id ? ' drop-before' : '')} draggable
                  onDragStart={() => setDrag(i.id)} onDragEnd={() => { setDrag(null); setOver(null); }}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); setOver({group: g.id, before: i.id}); }}
                  onClick={() => open(i.id)}>
                  <div className="card-top">
                    <span className="muted small">{itemKey(i, store.projects)}</span>
                    {project.settings.rollup && <SpaceChip item={i} projects={store.projects} />}
                    {i.type !== 'Task' && <TypeBadge type={i.type} />}
                    <span className="spacer" />
                    {groupBy !== 'priority' && i.priority > 0 && <PriorityIcon value={i.priority} />}
                  </div>
                  {covers && <CardCover item={i} store={store} />}
                  <div className="card-title">{i.title}</div>
                  {kids.length > 0 && <div className="card-progress" title={`${kids.filter(k => k.completed).length} of ${kids.length} subitems done`}><div style={{width: `${100 * kids.filter(k => k.completed).length / kids.length}%`}} /></div>}
                  <div className="card-meta">
                    {groupBy !== 'status' && <StatusIcon status={project.statuses.find(s => s.id === i.status)} />}
                    {i.due && <span className={'small' + (i.due < store.today && !i.completed ? ' overdue' : ' muted')}>{i.due.slice(5).replace('-', '/')}</span>}
                    <span className="small"><EstimateText item={i} items={store.items} /></span>
                    <RoutineMark item={i} />
                    {blocked && <span className="small overdue" title="Blocked by unfinished work"><Link2 size={12} /> blocked</span>}
                    {i.tags.map(t => <span key={t} className="tag">{t}</span>)}
                    <span className="spacer" />
                    <TimeCell item={i} store={store} compact />
                    <Avatars ids={i.assignees} people={store.people} size={20} />
                  </div>
                </div>
              );
            })}
            {adding?.group === g.id ? (
              <CardInput store={store} types={project.types} text={adding.text} setText={t => setAdding({group: g.id, text: t})}
                onBlur={() => !adding.text.trim() && setAdding(null)}
                onKeyDown={async e => {
                  if (e.key === 'Escape') setAdding(null);
                  if (e.key === 'Enter' && adding.text.trim()) {
                    const text = adding.text;
                    setAdding({group: g.id, text: ''});
                    const item = await store.quickAdd(project.id, text, groupBy === 'status' ? {status: g.id} : {});
                    if (!item) { setAdding({group: g.id, text}); return; }
                    const patch = {...createExtra, ...(groupBy === 'status' ? {} : g.patch(item))};
                    if (item && Object.keys(patch).length) store.updateItem(item.id, patch);
                  }
                }} />
            ) : <button className="add-card" onClick={() => setAdding({group: g.id, text: ''})}>+ Add</button>}
          </div>
        );
      })}
    </div>
  );
}

function CardInput({store, types, text, setText, onBlur, onKeyDown}: {store: Store; types: string[]; text: string; setText: (t: string) => void; onBlur: () => void; onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void}) {
  const qa = useQuickAssist(store, types, text, setText);
  return <span className="qa-wrap" style={{display: 'block'}}>
    <input autoFocus className="card-input" placeholder="Title. @ assign, ! priority, due: date" value={text} {...qa.props}
      onChange={e => setText(e.target.value)} onBlur={() => { qa.props.onBlur(); onBlur(); }} onKeyDown={e => { if (!qa.keyDown(e)) onKeyDown(e); }} />
    {qa.ui}
  </span>;
}
