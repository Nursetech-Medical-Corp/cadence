// Multi-level sort: sort by one field, then the next, then the next. Saved with the view.
import {useState} from 'react';
import {ArrowDown, ArrowUp, ArrowUpDown, GripVertical, Plus, X} from 'lucide-react';
import type {Item, Project, ViewConfig} from './types.ts';
import type {Store} from './store.ts';
import {Popover} from './components.tsx';

/** by: for status, type, priority and dropdown columns, 'order' follows the order you arranged; 'alpha' sorts A to Z by name. */
export type SortRule = {col: string; dir: 1 | -1; by?: 'order' | 'alpha'};
/** Columns whose values have an arranged order. */
export const hasOrder = (col: string, project: Project) => ['status', 'type', 'priority'].includes(col) || ['select', 'multi'].includes(project.fields.find(f => 'f:' + f.id === col)?.kind ?? '');

export function sortFields(project: Project): {id: string; label: string}[] {
  return [
    {id: 'title', label: 'Title'}, {id: 'status', label: 'Status'}, {id: 'type', label: 'Type'}, {id: 'priority', label: 'Priority'},
    {id: 'assignees', label: 'Assignee'}, {id: 'due', label: 'Due date'}, {id: 'start', label: 'Start date'}, {id: 'estimate', label: 'Estimate'},
    {id: 'sprint', label: 'Sprint'}, {id: 'parent', label: 'Parent'}, {id: 'key', label: 'ID'}, {id: 'created', label: 'Created'}, {id: 'updated', label: 'Last updated'},
    ...project.fields.map(f => ({id: 'f:' + f.id, label: f.name})),
  ];
}

/** Saved sorts, accepting the older single-sort setting. */
export const sortsOf = (c: ViewConfig): SortRule[] => c.sorts ?? (c.sort ? [c.sort] : []);

/** Empty values always sort last, whatever the direction. */
export function sortItems(items: Item[], rules: SortRule[], project: Project, store: Store): Item[] {
  if (!rules.length) return [...items].sort((a, b) => a.sort - b.sort);
  const PRIO = ['', 'urgent', 'high', 'medium', 'low'];
  const val = (i: Item, col: string, alpha: boolean): string | number | null => {
    const f = col.startsWith('f:') ? project.fields.find(x => x.id === col.slice(2)) : undefined;
    if (f && (f.kind === 'select' || f.kind === 'multi')) {
      // Dropdown columns: the option order you arranged, or A to Z.
      const v = i.fields[f.id], first = Array.isArray(v) ? (f.options ?? []).find(o => (v as string[]).includes(o)) : (v as string | undefined);
      if (!first) return null;
      return alpha ? first.toLowerCase() : (f.options ?? []).indexOf(first);
    }
    switch (col) {
      case 'title': return i.title.toLowerCase();
      case 'status': return alpha ? (project.statuses.find(s => s.id === i.status)?.name ?? '').toLowerCase() : project.statuses.findIndex(s => s.id === i.status);
      case 'type': return alpha ? i.type.toLowerCase() : project.types.indexOf(i.type);
      case 'priority': return !i.priority ? null : alpha ? PRIO[i.priority] : i.priority;
      case 'assignees': return i.assignees.length ? (store.people.find(p => p.id === i.assignees[0])?.name ?? '').toLowerCase() : null;
      case 'due': return i.due; case 'start': return i.start; case 'estimate': return i.estimate;
      case 'sprint': return i.sprint ? store.sprints.find(s => s.id === i.sprint)?.start ?? null : null;
      case 'parent': return i.parentId ? store.items.get(i.parentId)?.title.toLowerCase() ?? null : null;
      case 'tags': return i.tags.length ? [...i.tags].sort()[0].toLowerCase() : null;
      case 'key': return i.number; case 'created': return i.created; case 'updated': return i.updated;
      default: { const v = i.fields[col.slice(2)]; return v == null || v === '' ? null : typeof v === 'number' ? v : String(v).toLowerCase(); }
    }
  };
  return [...items].sort((a, b) => {
    for (const r of rules) {
      const alpha = r.by === 'alpha';
      const x = val(a, r.col, alpha), y = val(b, r.col, alpha);
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * r.dir;
    }
    return a.sort - b.sort;
  });
}

export function SortButton({project, config, setConfig}: {project: Project; config: ViewConfig; setConfig: (p: Partial<ViewConfig>) => void}) {
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const rules = sortsOf(config);
  const fields = sortFields(project);
  const save = (r: SortRule[]) => setConfig({sorts: r, sort: null});
  return (
    <span className="picker">
      <button className={'btn' + (rules.length ? ' on' : '')} onClick={() => setOpen(o => !o)}><ArrowUpDown size={13} /> {rules.length ? `Sorted by ${rules.length}` : 'Sort'}</button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide">
        <div className="pop-label">Sort by, in order. Drag the handle to change which comes first. Shift+click a table header to add a level.</div>
        {rules.map((r, n) => (
          <div key={r.col + n} className={'f-row sort-row' + (drag === n ? ' dragging' : '') + (over === n && drag !== null && drag !== n ? ' drop' : '')} style={{alignItems: 'center', padding: '3px 2px'}}
            draggable onDragStart={e => { if (!(e.target as HTMLElement).closest('.sort-grip')) { e.preventDefault(); return; } setDrag(n); }}
            onDragOver={e => { e.preventDefault(); setOver(n); }} onDragEnd={() => { setDrag(null); setOver(null); }}
            onDrop={() => { if (drag === null || drag === n) return; const l = [...rules]; const [m] = l.splice(drag, 1); l.splice(n, 0, m); save(l); setDrag(null); setOver(null); }}>
            <span className="sort-grip" title="Drag to change the order"><GripVertical size={14} /></span>
            <span className="f-join" style={{paddingTop: 0, width: 50}}>{n === 0 ? 'Sort by' : 'then'}</span>
            <select className="plain-select" value={r.col} onChange={e => save(rules.map((x, k) => k === n ? {...x, col: e.target.value} : x))}>
              {fields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            {hasOrder(r.col, project) && <div className="seg" title="Your order follows how the options are arranged; drag them in any dropdown to change it">
              <button className={r.by !== 'alpha' ? 'on' : ''} onClick={() => save(rules.map((x, k) => k === n ? {...x, by: 'order'} : x))}>Your order</button>
              <button className={r.by === 'alpha' ? 'on' : ''} onClick={() => save(rules.map((x, k) => k === n ? {...x, by: 'alpha'} : x))}>A to Z</button>
            </div>}
            <div className="seg">
              <button className={r.dir === 1 ? 'on' : ''} onClick={() => save(rules.map((x, k) => k === n ? {...x, dir: 1} : x))}><ArrowUp size={12} /> Asc</button>
              <button className={r.dir === -1 ? 'on' : ''} onClick={() => save(rules.map((x, k) => k === n ? {...x, dir: -1} : x))}><ArrowDown size={12} /> Desc</button>
            </div>
            <button className="icon" title="Remove" onClick={() => save(rules.filter((_, k) => k !== n))}><X size={13} /></button>
          </div>
        ))}
        <div className="f-actions" style={{padding: 4}}>
          <button className="btn ghost small" onClick={() => save([...rules, {col: fields.find(f => !rules.some(r => r.col === f.id))?.id ?? 'title', dir: 1}])}><Plus size={12} /> Add sort</button>
          {rules.length > 0 && <button className="btn ghost small" onClick={() => save([])}>Clear (manual order)</button>}
        </div>
      </Popover>
    </span>
  );
}
