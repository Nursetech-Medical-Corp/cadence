// Azure-style backlog: pick a level (Epics, Features, Stories...), see each item with its children,
// rank by dragging, and plan by dragging items onto sprint cards on the right.
import {useQuickAssist} from './QuickAssist.tsx';
import {Fragment, useMemo, useState} from 'react';
import {ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, MoreHorizontal, Plus} from 'lucide-react';
import type {Item} from './types.ts';
import {between} from './store.ts';
import {Check, PeoplePicker, PriorityIcon, SprintSelect, StatusSelect, TypeBadge, EstimateText} from './components.tsx';
import {SprintCard, sprintState} from './SprintParts.tsx';
import type {ViewProps} from './viewProps.ts';

export function BacklogView({store, project, items, allItems, sprints, open, config, setConfig, selected, toggle}: ViewProps) {
  const level = config.level ?? 'all';
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);
  const [overSprint, setOverSprint] = useState<string | null>(null);
  const [text, setText] = useState('');
  const qa = useQuickAssist(store, project.types, text, setText);
  const shown = useMemo(() => new Set(items.map(i => i.id)), [items]);
  const rank = (i: Item) => project.types.indexOf(i.type);

  const kids = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of allItems) if (i.parentId) m.set(i.parentId, [...(m.get(i.parentId) ?? []), i]);
    for (const l of m.values()) l.sort((a, b) => a.sort - b.sort);
    return m;
  }, [allItems]);
  const visible = (i: Item): boolean => shown.has(i.id) || (kids.get(i.id) ?? []).some(visible);
  const underLevel = (i: Item) => { let p = i.parentId ? store.items.get(i.parentId) : undefined; while (p) { if (p.type === level) return true; p = p.parentId ? store.items.get(p.parentId) : undefined; } return false; };
  const roots = level === 'all'
    ? allItems.filter(i => !i.parentId || !store.items.has(i.parentId))
    : allItems.filter(i => i.type === level);
  // Lower-level items with no ancestor at this level, shown separately like Azure's "unparented".
  const unparented = level === 'all' ? [] : allItems.filter(i => rank(i) > project.types.indexOf(level) && !underLevel(i) && !(i.parentId && store.items.get(i.parentId) && rank(store.items.get(i.parentId)!) > project.types.indexOf(level)));
  const sortedRoots = roots.filter(visible).sort((a, b) => a.sort - b.sort);

  const dropOnRow = (target: Item) => {
    if (!drag || drag === target.id) return;
    const sibs = sortedRoots.includes(target) ? sortedRoots : (kids.get(target.parentId!) ?? []);
    const idx = sibs.indexOf(target);
    store.updateItem(drag, {sort: between(sibs[idx - 1]?.sort, target.sort)});
  };
  const dropOnSprint = (sid: string | null) => {
    if (!drag) return;
    const item = store.items.get(drag)!;
    // Moving a parent moves its open children too, like planning a feature into a sprint.
    const family = [item, ...descendants(item.id)].filter(i => !i.completed || i.id === item.id);
    for (const i of family) if (i.sprint !== sid) store.updateItem(i.id, {sprint: sid});
    setDrag(null); setOverSprint(null);
  };
  const descendants = (id: string): Item[] => (kids.get(id) ?? []).flatMap(k => [k, ...descendants(k.id)]);

  const row = (i: Item, depth: number): React.ReactNode => {
    const ch = (kids.get(i.id) ?? []).filter(visible);
    const done = descendants(i.id).filter(d => d.completed).length, total = descendants(i.id).length;
    return (
      <Fragment key={i.id}>
        <div data-id={i.id} onClickCapture={e => { if (e.ctrlKey || e.metaKey || e.shiftKey) { e.preventDefault(); e.stopPropagation(); toggle(i.id, e, [...document.querySelectorAll<HTMLElement>('.split .row[data-id]')].map(r => r.dataset.id!)); } }}
          className={'row' + (selected.has(i.id) ? ' sel' : '') + (i.completed ? ' done' : '') + (drag === i.id ? ' dragging' : '') + (overRow === i.id && drag !== i.id ? ' drop-before' : '')} draggable
          onDragStart={() => setDrag(i.id)} onDragEnd={() => { setDrag(null); setOverRow(null); setOverSprint(null); }}
          onDragOver={e => { e.preventDefault(); setOverRow(i.id); }} onDrop={() => { dropOnRow(i); setOverRow(null); }}>
          <span className="indent" style={{width: depth * 20}} />
          <button className="twisty" style={{visibility: ch.length ? 'visible' : 'hidden'}} onClick={() => setCollapsed(c => { const n = new Set(c); n.has(i.id) ? n.delete(i.id) : n.add(i.id); return n; })}>
            {collapsed.has(i.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <Check item={i} project={project} onToggle={status => store.updateItem(i.id, {status})} />
          <TypeBadge type={i.type} />
          <span className="grow title" style={{cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}} onClick={() => open(i.id)}>{i.title}</span>
          {i.priority > 0 && <PriorityIcon value={i.priority} />}
          {total > 0 && <span className="count" title="Done of all descendants">{done}/{total}</span>}
          <span className="row-meta">
            <span className="small est-slot"><EstimateText item={i} items={store.items} /></span>
            <span className="sprint-slot"><SprintSelect projectId={project.id} sprints={sprints} value={i.sprint} onChange={sprint => store.updateItem(i.id, {sprint})} /></span>
            <span className="person-slot"><PeoplePicker value={i.assignees} people={store.people} onReorder={store.reorderPeople} onChange={assignees => store.updateItem(i.id, {assignees})} compact /></span>
            <StatusSelect project={project} value={i.status} onChange={status => store.updateItem(i.id, {status})} compact />
            <button className="icon more" title="Open details" onClick={() => open(i.id)}><MoreHorizontal size={16} /></button>
          </span>
        </div>
        {!collapsed.has(i.id) && ch.map(c => row(c, depth + 1))}
      </Fragment>
    );
  };

  const levels = project.types.filter(t => t !== 'Bug');
  const current = sprints.find(s => sprintState(s, store.today) === 'current');
  // Which sprints the planning panel lists: current and upcoming (soonest first), past (latest first), or all.
  const [show, setShowState] = useState<'next' | 'past' | 'all'>(() => (localStorage.getItem('plan-show') as 'next') || 'next');
  const setShow = (v: 'next' | 'past' | 'all') => { setShowState(v); localStorage.setItem('plan-show', v); };
  const [folded, setFoldedState] = useState(() => localStorage.getItem('plan-folded') === '1');
  const setFolded = (v: boolean) => { setFoldedState(v); localStorage.setItem('plan-folded', v ? '1' : '0'); };
  const listed = useMemo(() => {
    const closed = (s: typeof sprints[number]) => sprintState(s, store.today) === 'closed';
    const next = sprints.filter(s => !closed(s)).sort((a, b) => a.start.localeCompare(b.start));
    const past = sprints.filter(closed).sort((a, b) => b.start.localeCompare(a.start));
    return show === 'next' ? next : show === 'past' ? past : [...next, ...past];
  }, [sprints, show, store.today]);
  return (
    <div className="split">
      <div className="left">
        <div className="toolbar" style={{borderBottom: 0}}>
          <span className="muted small">Backlog level</span>
          <div className="seg">
            <button className={level === 'all' ? 'on' : ''} onClick={() => setConfig({level: 'all'})}>All</button>
            {levels.map(t => <button key={t} className={level === t ? 'on' : ''} onClick={() => setConfig({level: t})}>{plural(t)}</button>)}
          </div>
          <span className="muted small">Drag to rank. Drag onto a sprint to plan it (children follow).</span>
        </div>
        <div className="list" style={{paddingTop: 0}}>
          {sortedRoots.map(i => row(i, 0))}
          <div className="row quick" style={{background: 'transparent'}}>
            <Plus size={14} className="muted" />
            <span className="qa-wrap grow"><input className="inline" placeholder={`New ${level === 'all' ? 'item' : level}. Enter to add. @ assign, ! priority, due: date`} value={text} onChange={e => setText(e.target.value)} {...qa.props}
              onKeyDown={async e => {
                if (qa.keyDown(e)) return;
                if (e.key !== 'Enter' || !text.trim()) return;
                const t = text; setText('');
                const item = await store.quickAdd(project.id, t);
                if (item && level !== 'all' && item.type !== level) store.updateItem(item.id, {type: level});
              }} />{qa.ui}</span>
          </div>
          {unparented.filter(visible).length > 0 && <>
            <div className="group-head">Not under any {level} <span className="count">{unparented.filter(visible).length}</span></div>
            {unparented.filter(visible).map(i => row(i, 0))}
          </>}
        </div>
      </div>
      {folded ? <button className="plan-folded" title="Show sprint planning" onClick={() => setFolded(false)}><ChevronsLeft size={14} /><span>Planning</span></button> :
      <div className="right">
        <div style={{display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8}}>
          <b>Planning</b><span className="spacer" />
          <button className="btn primary small" onClick={() => store.createSprint(project.id)}><Plus size={13} /> New sprint</button>
          <button className="icon" title="Hide planning (fold to the right)" onClick={() => setFolded(true)}><ChevronsRight size={15} /></button>
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10}}>
          <select className="plain-select" value={show} onChange={e => setShow(e.target.value as 'next')}>
            <option value="next">Current and upcoming</option><option value="past">Past sprints</option><option value="all">All sprints</option>
          </select>
          {current && <button className="btn ghost small" title="Scroll to the current sprint" onClick={() => document.querySelector('.split .right .sprint-card.current')?.scrollIntoView({behavior: 'smooth', block: 'start'})}>Go to current</button>}
        </div>
        <div className={'sprint-card' + (overSprint === 'backlog' ? ' over' : '')} onDragOver={e => { e.preventDefault(); setOverSprint('backlog'); }} onDrop={() => dropOnSprint(null)}>
          <div className="sc-head">Backlog</div>
          <div className="small muted">{allItems.filter(i => !i.sprint && !i.completed).length} open items not in a sprint. Drop here to unplan.</div>
        </div>
        {listed.map(s => (
          <SprintCard key={s.id} store={store} sprint={s} items={allItems} current={s.id === current?.id} over={overSprint === s.id} open={open} onDragItem={setDrag}
            onDragOver={e => { e.preventDefault(); setOverSprint(s.id); }} onDrop={() => dropOnSprint(s.id)} />
        ))}
        {show === 'next' && sprints.some(s => sprintState(s, store.today) === 'closed') && <button className="link small" onClick={() => setShow('past')}>{sprints.filter(s => sprintState(s, store.today) === 'closed').length} past sprints. Show them</button>}
        {!sprints.length ? <div className="muted small">No sprints yet. Create one, then drag items onto it.</div> : !listed.length && <div className="muted small">No sprints here.</div>}
      </div>}
    </div>
  );
}

const plural = (t: string) => /y$/i.test(t) ? t.slice(0, -1) + 'ies' : /s$/i.test(t) ? t + 'es' : t + 's';
