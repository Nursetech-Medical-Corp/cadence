import {createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {personHours} from './hours.ts';
import {parseDuration} from './dates.ts';
import {createPortal} from 'react-dom';
import {Check as CheckIcon, Circle, CircleCheck, CircleDashed, CircleDot, Plus, X as XIcon, GripVertical} from 'lucide-react';
import type {Item, Person, Project, Sprint, Status} from './types.ts';
import {PRIORITIES} from './types.ts';
import type {Store} from './store.ts';

/** The store, for components deep in the tree that need project edits (adding an option from a dropdown). */
export const StoreContext = createContext<Store | null>(null);
const useStoreCtx = () => useContext(StoreContext);

export function Avatar({person, size = 22}: {person?: Person; size?: number}) {
  if (!person) return null;
  const initials = person.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return <span className="avatar" title={person.name} style={{background: person.color, width: size, height: size, fontSize: size * 0.42}}>{initials}</span>;
}

/** Overlapping avatars, at most `max`; the rest collapse into "+N" so rows keep their width. */
export function Avatars({ids, people, size = 22, max = 3}: {ids: string[]; people: Person[]; size?: number; max?: number}) {
  const shown = ids.length > max ? ids.slice(0, max - 1) : ids;
  const rest = ids.length - shown.length;
  const names = ids.map(id => people.find(p => p.id === id)?.name ?? '?').join(', ');
  return <span className="avatars" title={names}>{shown.map(id => <Avatar key={id} person={people.find(p => p.id === id)} size={size} />)}
    {rest > 0 && <span className="avatar more-avatars" style={{width: size, height: size, fontSize: size * 0.4}}>+{rest}</span>}</span>;
}

/**
 * Floating panel, rendered on document.body so no table cell, scroll area or sidebar can clip it.
 * Anchored to its parent element (the `.picker` wrapper). Opens below, flips above or left to stay on screen.
 * `className` "up" prefers opening above.
 */
export function Popover({open, onClose, children, className = ''}: {open: boolean; onClose: () => void; children: ReactNode; className?: string}) {
  const ref = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const anchor = () => marker.current?.parentElement ?? null;
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor()?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, onClose]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = ref.current, a = anchor();
      if (!el || !a) return;
      const r = a.getBoundingClientRect(), w = el.offsetWidth, h = el.scrollHeight, gap = 4, pad = 8;
      const below = innerHeight - r.bottom - gap - pad, above = r.top - gap - pad;
      const up = className.includes('up') ? above > 160 || above > below : below < Math.min(h, 240) && above > below;
      const room = up ? above : below;
      el.style.maxHeight = `${Math.max(120, Math.min(420, room))}px`;
      const height = Math.min(h, Math.max(120, Math.min(420, room)));
      el.style.top = `${up ? r.top - gap - height : r.bottom + gap}px`;
      let left = r.left;
      if (left + w > innerWidth - pad) left = Math.max(pad, r.right - w);
      if (left + w > innerWidth - pad) left = Math.max(pad, innerWidth - pad - w);
      el.style.left = `${left}px`;
    };
    place();
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    return () => { removeEventListener('resize', place); removeEventListener('scroll', place, true); };
  }, [open, className]);
  return <>
    <span ref={marker} hidden />
    {open && createPortal(<div ref={ref} className={'popover ' + className} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>{children}</div>, document.body)}
  </>;
}

/** Button that opens a list of options. */
/** A copy of the list with the entry at `from` moved to position `to`. */
export function move<T>(list: T[], from: number, to: number): T[] {
  const l = [...list];
  if (to < 0 || to >= l.length || from === to) return l;
  const [m] = l.splice(from, 1);
  l.splice(to, 0, m);
  return l;
}
/** Drag rows of a popover list into a new order. Returns props for row n, and whether it is the one being dragged. */
export function useDragRows<T>(list: T[], onReorder?: (list: T[]) => void) {
  const [drag, setDrag] = useState<number | null>(null);
  const row = (n: number, enabled = true) => !onReorder || !enabled ? {} : {
    draggable: true, onDragStart: () => setDrag(n), onDragEnd: () => setDrag(null),
    onDragOver: (e: React.DragEvent) => { if (drag !== null) e.preventDefault(); },
    onDrop: () => { if (drag !== null && drag !== n) onReorder(move(list, drag, n)); setDrag(null); },
  };
  return {row, dragging: (n: number) => drag === n};
}

export function Menu<T extends string | number | null>({value, options, onChange, render, className = '', title, onAdd, addLabel = 'Add option', onReorder}: {
  value: T; options: {value: T; label: string; icon?: ReactNode}[]; onChange: (v: T) => void;
  render: ReactNode; className?: string; title?: string;
  /** When set, the menu ends with an inline "+ Add option" field. Return the new value to select it. */
  onAdd?: (label: string) => T | undefined | Promise<T | undefined>; addLabel?: string;
  /** When set, options can be dragged into a new order (grip shows on hover). */
  /** Called with the option values (None left out) in their new order. */
  onReorder?: (values: NonNullable<T>[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const rows = useDragRows(options.map(o => o.value), onReorder && (l => onReorder(l.filter((x): x is NonNullable<T> => x !== null))));
  return (
    <span className="picker">
      <button data-pop-trigger className={'cell-btn ' + className} title={title} onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>{render}</button>
      <Popover open={open} onClose={() => setOpen(false)}>
        {options.map((o, n) => (
          <button key={String(o.value)} className={'pop-row' + (o.value === value ? ' on' : '') + (onReorder ? ' reorderable' : '') + (rows.dragging(n) ? ' dragging' : '')} onClick={() => { onChange(o.value); setOpen(false); }}
            {...rows.row(n, o.value !== null)}>
            {onReorder && o.value !== null && <GripVertical size={12} className="opt-grip" />}{o.icon}<span className="grow">{o.label}</span>{o.value === value && <CheckIcon size={14} />}
          </button>
        ))}
        {onAdd && (adding === null
          ? <button className="pop-row muted" onClick={() => setAdding('')}><Plus size={14} /> {addLabel}</button>
          : <input autoFocus className="pop-search" placeholder="Name, then Enter" value={adding} onChange={e => setAdding(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.stopPropagation(); setAdding(null); }
                if (e.key === 'Enter' && adding.trim()) { const label = adding.trim(); setAdding(null); Promise.resolve(onAdd(label)).then(v => { if (v !== undefined) { onChange(v); setOpen(false); } }); }
              }} />)}
      </Popover>
    </span>
  );
}

export function StatusIcon({status, size = 14}: {status?: Status; size?: number}) {
  const c = status?.color ?? '#999';
  if (!status) return <Circle size={size} color={c} />;
  if (status.category === 'done') return <CircleCheck size={size} color={c} />;
  if (status.category === 'doing') return <CircleDot size={size} color={c} />;
  return <CircleDashed size={size} color={c} />;
}

export function StatusSelect({project, value, onChange, compact}: {project: Project; value: string; onChange: (v: string) => void; compact?: boolean}) {
  const s = project.statuses.find(s => s.id === value);
  const store = useStoreCtx();
  const onAdd = store ? (name: string) => {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36).slice(-3);
    const doneIdx = project.statuses.findIndex(x => x.category === 'done');
    const list = [...project.statuses];
    list.splice(doneIdx < 0 ? list.length : doneIdx, 0, {id, name, category: 'doing', color: '#0ea5e9'});
    store.updateProject(project.id, {statuses: list});
    return id;
  } : undefined;
  return <Menu value={value} title="Status" onChange={onChange} className="status-btn" onReorder={store ? (ids: string[]) => store.updateProject(project.id, {statuses: ids.map(id => project.statuses.find(s => s.id === id)!)}) : undefined} onAdd={onAdd} addLabel="Add status"
    options={project.statuses.map(s => ({value: s.id, label: s.name, icon: <StatusIcon status={s} />}))}
    render={<span className="status-pill" style={{'--c': s?.color ?? '#999'} as React.CSSProperties}><StatusIcon status={s} size={13} />{!compact && <span>{s?.name ?? value}</span>}</span>} />;
}

const PRIO_COLORS = ['var(--muted)', '#e5484d', '#f76b15', '#e2a400', '#8b8d98'];
export function PriorityIcon({value, size = 14}: {value: number; size?: number}) {
  if (value === 1) return <svg width={size} height={size} viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill={PRIO_COLORS[1]} /><rect x="7.2" y="4" width="1.6" height="5" fill="#fff" /><rect x="7.2" y="10.5" width="1.6" height="1.6" fill="#fff" /></svg>;
  const bars = value === 0 ? 0 : 5 - value;
  return <svg width={size} height={size} viewBox="0 0 16 16">{[0, 1, 2].map(i => <rect key={i} x={2 + i * 4.5} y={11 - i * 4} width="3" height={3 + i * 4} rx="1" fill={i < bars ? PRIO_COLORS[value] : 'var(--line)'} />)}</svg>;
}
export function PrioritySelect({value, onChange, showLabel}: {value: number; onChange: (v: number) => void; showLabel?: boolean}) {
  return <Menu value={value} title="Priority" onChange={onChange}
    options={[1, 2, 3, 4, 0].map(p => ({value: p, label: PRIORITIES[p], icon: <PriorityIcon value={p} />}))}
    render={<span className="prio-btn"><PriorityIcon value={value} />{showLabel && <span className={value ? '' : 'muted'}>{PRIORITIES[value]}</span>}</span>} />;
}

export function TypeSelect({project, value, onChange}: {project: Project; value: string; onChange: (v: string) => void}) {
  const store = useStoreCtx();
  const onAdd = store ? (name: string) => { if (!project.types.includes(name)) store.updateProject(project.id, {types: [...project.types, name]}); return name; } : undefined;
  return <Menu value={value} title="Type" onChange={onChange} onAdd={onAdd} addLabel="Add type" options={project.types.map(t => ({value: t, label: t, icon: <TypeBadge type={t} />}))} render={<TypeBadge type={value} />} />;
}

/** Hours as 10h, 1h 30m or 45m. */
export const fmtHours = (h: number) => { const m = Math.round(h * 60); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };
// Subitems by parent and estimates by item, worked out once per version of the item list.
const estCache = new WeakMap<Map<string, Item>, {kids: Map<string, Item[]>; est: Map<string, {hours: number | null; rolled: boolean}>}>();
/** An item's estimate: its own, or for a parent the total of its subitems' estimates (Σ), so nothing counts twice. */
export function estimateOf(item: Item, items: Map<string, Item>): {hours: number | null; rolled: boolean} {
  let c = estCache.get(items);
  if (!c) {
    const kids = new Map<string, Item[]>();
    for (const i of items.values()) if (i.parentId) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
    estCache.set(items, c = {kids, est: new Map()});
  }
  const hit = c.est.get(item.id);
  if (hit) return hit;
  let sum = 0, any = false;
  for (const k of c.kids.get(item.id) ?? []) { const e = estimateOf(k, items).hours; if (e != null) { sum += e; any = true; } }
  const r = any ? {hours: sum, rolled: true} : {hours: item.estimate, rolled: false};
  c.est.set(item.id, r);
  return r;
}
/** Read-only estimate text: Σ marks a total of subitems. */
export function EstimateText({item, items}: {item: Item; items: Map<string, Item>}) {
  const e = estimateOf(item, items);
  return e.hours == null ? null : <span className="muted est-text" title={e.rolled ? 'Total of its subitems' : 'Estimate'}>{e.rolled ? '\u03a3 ' : ''}{fmtHours(e.hours)}</span>;
}
/** Editable estimate: type 2h, 1h 30m, 90m or 1.5 (hours). Parents show their subitems' total instead. */
export function EstimateCell({item, items, onChange}: {item: Item; items: Map<string, Item>; onChange: (hours: number | null) => void}) {
  const e = estimateOf(item, items);
  if (e.rolled) return <EstimateText item={item} items={items} />;
  if (personHours(item)) return <span className="muted est-text" title="Total of each person's hours (set them below)">{fmtHours(item.estimate ?? 0)}</span>;
  return <input className="inline num est-input" placeholder="-" defaultValue={item.estimate != null ? fmtHours(item.estimate) : ''} key={String(item.estimate)} title="Hours: 2h, 1h 30m, 90m or 1.5"
    onBlur={ev => { const m = parseDuration(ev.target.value); if (Number.isNaN(m)) { ev.target.value = item.estimate != null ? fmtHours(item.estimate) : ''; return; } const h = m ? Math.round(m / 60 * 100) / 100 : null; if (h !== item.estimate) onChange(h); }}
    onKeyDown={ev => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} />;
}

/** Each assignee's own hours on a shared item. Empty means not set; with none set, the estimate is shared evenly. */
export function PersonHoursEditor({item, people, onChange}: {item: Item; people: Person[]; onChange: (hours: Record<string, number> | null) => void}) {
  const h = personHours(item) ?? {};
  const share = item.estimate != null && !personHours(item) ? fmtHours(item.estimate / Math.max(1, item.assignees.length)) : 'not set';
  return <span className="person-hours">{item.assignees.map(pid => (
    <span key={pid} className="ph" title={`${people.find(p => p.id === pid)?.name ?? 'Someone'}'s hours on this`}>
      <Avatar person={people.find(p => p.id === pid)} size={18} />
      <input className="inline num est-input" placeholder={share} defaultValue={h[pid] != null ? fmtHours(h[pid]) : ''} key={pid + String(h[pid])}
        onBlur={ev => {
          const v = ev.target.value.trim(), m = parseDuration(v);
          if (Number.isNaN(m)) { ev.target.value = h[pid] != null ? fmtHours(h[pid]) : ''; return; }
          const next = {...h};
          if (!v) delete next[pid]; else next[pid] = Math.round(m / 60 * 100) / 100;
          if (JSON.stringify(next) !== JSON.stringify(h)) onChange(Object.keys(next).length ? next : null);
        }} onKeyDown={ev => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} />
    </span>))}</span>;
}

export function TypeBadge({type}: {type: string}) {
  return <span className={'type type-' + type.toLowerCase().replace(/[^a-z]/g, '')} title={type}>{type}</span>;
}

export function SprintSelect({sprints, value, onChange, projectId}: {sprints: Sprint[]; value: string | null; onChange: (v: string | null) => void; projectId?: string}) {
  const s = sprints.find(s => s.id === value);
  const store = useStoreCtx();
  const pid = projectId ?? sprints[0]?.projectId;
  const onAdd = store && pid ? async (name: string) => (await store.createSprint(pid, {name}))?.id : undefined;
  return <Menu value={value} title="Sprint" onChange={onChange} onAdd={onAdd} addLabel="New sprint (2 weeks after the last)"
    options={[{value: null, label: 'Backlog'}, ...sprints.map(s => ({value: s.id as string | null, label: `${s.name} (${s.start.slice(5)} to ${s.end.slice(5)})`}))]}
    render={<span className={s ? 'sprint-chip' : 'muted'} title={s?.name}>{s?.name ?? 'Backlog'}</span>} />;
}

export function PeoplePicker({value, people, onChange, compact, onReorder}: {value: string[]; people: Person[]; onChange: (v: string[]) => void; compact?: boolean; onReorder?: (ids: string[]) => void}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const movable = !!onReorder && !q;
  const list = people.filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
  const rows = useDragRows(list.map(p => p.id), movable ? onReorder : undefined);
  return (
    <span className="picker">
      <button data-pop-trigger className="cell-btn" onClick={e => { e.stopPropagation(); setOpen(o => !o); }} title="Assign">
        {value.length ? <Avatars ids={value} people={people} /> : <span className="assign-empty">{compact ? '' : 'Assign'}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <input autoFocus className="pop-search" placeholder="Search people" value={q} onChange={e => setQ(e.target.value)} />
        {list.map((p, n) => (
          <button key={p.id} className={'pop-row' + (value.includes(p.id) ? ' on' : '') + (movable ? ' reorderable' : '') + (rows.dragging(n) ? ' dragging' : '')}
            onClick={() => onChange(value.includes(p.id) ? value.filter(x => x !== p.id) : [...value, p.id])} {...rows.row(n)}>
            {movable && <GripVertical size={12} className="opt-grip" />}<Avatar person={p} /><span className="grow">{p.name}</span>{value.includes(p.id) && <CheckIcon size={14} />}
          </button>
        ))}
      </Popover>
    </span>
  );
}

export function DateInput({value, onChange, today, className = '', placeholder = ''}: {value: string | null; onChange: (v: string | null) => void; today?: string; className?: string; placeholder?: string}) {
  const overdue = today && value && value < today;
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { ref.current?.focus(); try { ref.current?.showPicker(); } catch { /* not supported */ } } }, [editing]);
  // Empty dates show a light button: Chrome's empty date input renders its mm/dd/yyyy text oddly in tight cells.
  if (!value && !editing) return <button className={'date-empty ' + className} onClick={e => { e.stopPropagation(); setEditing(true); }} title="Set date">{placeholder || <span className="date-dash">-</span>}</button>;
  return (
    <span className={'date-wrap ' + className + (overdue ? ' overdue' : '')}>
      <input ref={ref} type="date" className="date" value={value ?? ''} onClick={e => e.stopPropagation()}
        onChange={e => { onChange(e.target.value || null); setEditing(false); }} onBlur={() => setEditing(false)} />
    </span>
  );
}

/** Round checkbox. Completed items stay visible (struck through) until filtered by "Hide done". */
export function Check({item, project, onToggle}: {item: Item; project: Project; onToggle: (status: string) => void}) {
  const done = item.completed !== null;
  const doneStatus = project.statuses.find(s => s.category === 'done')?.id;
  const todoStatus = project.statuses.find(s => s.category === 'todo')?.id ?? project.statuses[0].id;
  return (
    <button className={'check' + (done ? ' on' : '')} aria-label={done ? 'Mark not done' : 'Mark done'} title={done ? 'Mark not done' : 'Mark done'}
      onClick={e => { e.stopPropagation(); onToggle(done ? todoStatus : (doneStatus ?? todoStatus)); }}>
      {done && <CheckIcon size={11} strokeWidth={3} />}
    </button>
  );
}

/** The space an item belongs to, as a small colored label (used in rollup views, where spaces mix). */
export function SpaceChip({item, projects}: {item: Item; projects: Project[]}) {
  const p = projects.find(x => x.id === item.projectId);
  if (!p) return null;
  const color = (p.settings as {color?: string}).color ?? 'var(--accent)';
  return <span className="space-chip" title={`In ${p.name}`} style={{'--chip': color} as React.CSSProperties}>{p.name}</span>;
}
export function itemKey(item: Item, projects: Project[]) {
  return `${projects.find(p => p.id === item.projectId)?.key ?? '?'}-${item.number}`;
}

export function InlineText({value, onSave, className = '', placeholder}: {value: string; onSave: (v: string) => void; className?: string; placeholder?: string}) {
  const [v, setV] = useState(value);
  const [focused, setFocused] = useState(false);
  // Outside changes (another person, an agent) update the field, but never while you are typing in it.
  useEffect(() => { if (!focused) setV(value); }, [value, focused]);
  return <input className={'inline ' + className} value={v} placeholder={placeholder} onFocus={() => setFocused(true)}
    onClick={e => e.stopPropagation()}
    onChange={e => setV(e.target.value)}
    onBlur={() => { setFocused(false); if (v.trim() !== value) { if (v.trim() || placeholder) onSave(v.trim()); else setV(value); } }}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value); setTimeout(() => (e.target as HTMLInputElement).blur()); } }} />;
}

export function Empty({title, children}: {title: string; children?: ReactNode}) {
  return <div className="empty"><div className="empty-title">{title}</div>{children && <div className="muted">{children}</div>}</div>;
}

/** Subitem progress: a small bar with "done/total", explained on hover. */
export function Progress({done, total}: {done: number; total: number}) {
  return <span className="progress" title={`${done} of ${total} subitems done`}>
    <span className="progress-bar"><span style={{width: `${total ? 100 * done / total : 0}%`}} /></span>{done}/{total}
  </span>;
}

/** Tags as chips: click one to rename or remove it, + to add. All tags in the workspace are suggested. */
export function TagEditor({tags, onChange}: {tags: string[]; onChange: (t: string[]) => void}) {
  const store = useStoreCtx();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const all = store ? [...new Set([...store.items.values()].flatMap(i => i.tags))].sort() : [];
  const add = (t: string) => { const v = t.trim().replace(/^#/, ''); if (v && !tags.includes(v)) onChange([...tags, v]); setText(''); };
  return (
    <span className="picker tag-editor">
      <span className="tag-chips" onClick={e => { e.stopPropagation(); setOpen(true); }} title="Tags. Click to edit">
        {tags.slice(0, 3).map(t => <span key={t} className="tag">#{t}</span>)}
        {tags.length > 3 && <span className="tag" title={tags.join(', ')}>+{tags.length - 3}</span>}
        {!tags.length && <span className="tag add-tag">+ tag</span>}
      </span>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="pop-label">Tags</div>
        <div className="chips" style={{padding: '0 6px 6px'}}>{tags.map(t => <span key={t} className="tag">#{t}<button className="icon" style={{padding: 0}} title="Remove" onClick={() => onChange(tags.filter(x => x !== t))}><XIcon size={11} /></button></span>)}</div>
        <input autoFocus className="pop-search" placeholder="Add a tag, Enter" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(text); }} />
        {all.filter(t => !tags.includes(t) && t.toLowerCase().includes(text.toLowerCase())).slice(0, 8).map(t => <button key={t} className="pop-row" onClick={() => add(t)}>#{t}</button>)}
      </Popover>
    </span>
  );
}
