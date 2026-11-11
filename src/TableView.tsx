import {Fragment, useEffect, useRef, useState} from 'react';
import {TimeCell} from './TimeTracker.tsx';
import {activeColors, colorOf, tint} from './ColorRules.tsx';
import {ArrowDown, ArrowUp, EyeOff, MoreHorizontal, Plus, Trash2, Pencil} from 'lucide-react';
import type {FieldDef, Item, Project} from './types.ts';
import {between, fmtMinutes, type Store} from './store.ts';
import {Check, DateInput, InlineText, Menu, PeoplePicker, Popover, PrioritySelect, SprintSelect, StatusSelect, TypeSelect} from './components.tsx';
import type {ViewProps} from './viewProps.ts';
import {AddField, CalcCell, COMPUTED, ComputedCell, RatingCell, RelationCell, calc, fmtMoney, valueOf} from './Fields.tsx';
import {FilesCell} from './FilesCell.tsx';
import {sortItems, sortsOf, type SortRule, hasOrder} from './Sorting.tsx';

type Col = {id: string; name: string; width: number; sortVal: (i: Item) => string | number; cell: (i: Item) => React.ReactNode; raw?: (i: Item) => unknown};
export const DEFAULT_HIDDEN = ['start', 'estimate', 'tags', 'parent'];
const CALC_LABEL: Record<string, string> = {count: 'Count', filled: 'Filled', empty: 'Empty', unique: 'Unique', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', checked: 'Checked', done: 'Done'};
/** Column ids and names, for the Columns menu in the toolbar. */
export const tableColumns = (project: Project) => [
  ['key', 'ID'], ['title', 'Title'], ['parent', 'Parent'], ['status', 'Status'], ['type', 'Type'], ['assignees', 'Assignee'], ['priority', 'Priority'], ['sprint', 'Sprint'],
  ['start', 'Start'], ['due', 'Due'], ['estimate', 'Estimate'], ['tags', 'Tags'], ...project.fields.map(f => ['f:' + f.id, f.name]),
] as [string, string][];

export function TableView({store, project, items, allItems, sprints, open, config, setConfig, selected, toggle, setSelected}: ViewProps) {
  // New rows: type a title in the draft row, Enter adds it and opens another draft, Tab adds it and moves to the next cell.
  // New rows stay pinned at the bottom (ignoring sort and filters) until you press Done or leave the view.
  const [drafting, setDrafting] = useState(false);
  // Adding a row in between: the row it goes next to.
  const [insertAt, setInsertAt] = useState<{id: string; above: boolean} | null>(null);
  const [draft, setDraft] = useState('');
  const [pinned, setPinned] = useState<string[]>([]);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [live, setLive] = useState<{id: string; width: number} | null>(null);
  const resizing = useRef<{id: string; x: number; w: number} | null>(null);
  const hidden = config.hidden ?? DEFAULT_HIDDEN;
  const up = (i: Item) => (patch: Parameters<Store['updateItem']>[1]) => store.updateItem(i.id, patch);

  const base: Col[] = [
    {id: 'key', name: 'ID', width: 80, sortVal: i => i.number, cell: i => <button className="link" onClick={() => open(i.id)}>{project.key}-{i.number}</button>},
    {id: 'title', name: 'Title', width: 340, sortVal: i => i.title.toLowerCase(), raw: i => i.title, cell: i => (
      <span className="title-cell"><Check item={i} project={project} onToggle={status => up(i)({status})} /><InlineText value={i.title} onSave={title => up(i)({title})} /></span>)},
    {id: 'parent', name: 'Parent', width: 200, sortVal: i => (i.parentId ? store.items.get(i.parentId)?.title ?? '' : '~'), raw: i => i.parentId, cell: i => (
      <select className="plain-select parent-select" value={i.parentId ?? ''} onChange={e => up(i)({parentId: e.target.value || null})} title="Parent">
        <option value="">None</option>
        {project.types.slice(0, Math.max(project.types.indexOf(i.type), 1)).map(t => (
          <optgroup key={t} label={t}>{allItems.filter(p => p.type === t && p.id !== i.id && (!p.completed || p.id === i.parentId)).map(p => <option key={p.id} value={p.id}>{p.title.slice(0, 60)}</option>)}</optgroup>
        ))}
      </select>)},
    {id: 'status', name: 'Status', width: 140, sortVal: i => project.statuses.findIndex(s => s.id === i.status), cell: i => <StatusSelect project={project} value={i.status} onChange={status => up(i)({status})} />},
    {id: 'type', name: 'Type', width: 100, sortVal: i => project.types.indexOf(i.type), cell: i => <TypeSelect project={project} value={i.type} onChange={type => up(i)({type})} />},
    {id: 'assignees', name: 'Assignee', width: 120, sortVal: i => i.assignees.length, raw: i => i.assignees, cell: i => <PeoplePicker value={i.assignees} people={store.people} onReorder={store.reorderPeople} onChange={assignees => up(i)({assignees})} />},
    {id: 'priority', name: 'Priority', width: 110, sortVal: i => i.priority || 9, cell: i => <PrioritySelect value={i.priority} onChange={priority => up(i)({priority})} showLabel />},
    {id: 'sprint', name: 'Sprint', width: 130, sortVal: i => sprints.find(s => s.id === i.sprint)?.start ?? '9', raw: i => i.sprint, cell: i => <SprintSelect projectId={project.id} sprints={sprints} value={i.sprint} onChange={sprint => up(i)({sprint})} />},
    {id: 'start', name: 'Start', width: 130, sortVal: i => i.start ?? '9', raw: i => i.start, cell: i => <DateInput value={i.start} onChange={start => up(i)({start})} />},
    {id: 'due', name: 'Due', width: 130, sortVal: i => i.due ?? '9', raw: i => i.due, cell: i => <DateInput value={i.due} today={i.completed ? undefined : store.today} onChange={due => up(i)({due})} />},
    {id: 'estimate', name: 'Estimate (h)', width: 110, sortVal: i => i.estimate ?? 0, raw: i => i.estimate, cell: i => (
      <input className="inline num" type="number" defaultValue={i.estimate ?? ''} key={String(i.estimate)} onBlur={e => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== i.estimate) up(i)({estimate: v}); }} />)},
    {id: 'tags', name: 'Tags', width: 160, sortVal: i => i.tags.join(','), raw: i => i.tags, cell: i => (
      <InlineText value={i.tags.join(', ')} placeholder="-" onSave={v => up(i)({tags: v.split(',').map(s => s.trim()).filter(Boolean)})} />)},
    ...project.fields.map((f): Col => {
      const val = (i: Item) => { try { return valueOf(f, i, project, store); } catch { return null; } };
      return {id: 'f:' + f.id, name: f.name, width: COMPUTED.includes(f.kind) && f.kind !== 'formula' ? 170 : 140,
        sortVal: i => { const v = val(i); return typeof v === 'number' ? v : String(v ?? '~'); }, raw: val,
        cell: i => <FieldCell field={f} item={i} project={project} value={i.fields[f.id]} store={store} onChange={v => up(i)({fields: {...i.fields, [f.id]: v}})} />};
    }),
  ];
  // Saved order and widths win; new columns append at the end.
  const saved = config.columns ?? [];
  const cols = [...base].sort((a, b) => {
    const ia = saved.findIndex(c => c.id === a.id), ib = saved.findIndex(c => c.id === b.id);
    return (ia < 0 ? 999 + base.indexOf(a) : ia) - (ib < 0 ? 999 + base.indexOf(b) : ib);
  }).map(c => ({...c, width: live?.id === c.id ? live.width : saved.find(s => s.id === c.id)?.width || c.width}));
  const shown = cols.filter(c => !hidden.includes(c.id));
  const saveCols = (list: {id: string; width: number}[]) => setConfig({columns: list});

  const sorts = sortsOf(config);
  const rows = sortItems(items.filter(i => !pinned.includes(i.id)), sorts, project, store);
  // Large tables: render only the rows near the screen (plus a buffer), with spacers keeping the scroll height.
  const wrap = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({top: 0, height: 900, rowH: 36});
  useEffect(() => {
    const scroller = wrap.current?.closest('.content') as HTMLElement | null;
    if (!scroller) return;
    const measure = () => {
      const rowH = (wrap.current?.querySelector('tbody tr[data-id]') as HTMLElement | null)?.offsetHeight || 36;
      const offset = (wrap.current?.offsetTop ?? 0) + 34;
      setWin({top: Math.max(0, scroller.scrollTop - offset), height: scroller.clientHeight, rowH});
    };
    measure();
    scroller.addEventListener('scroll', measure, {passive: true});
    addEventListener('resize', measure);
    return () => { scroller.removeEventListener('scroll', measure); removeEventListener('resize', measure); };
  }, []);
  const virtual = rows.length > 150;
  const first = virtual ? Math.max(0, Math.floor(win.top / win.rowH) - 20) : 0;
  const last = virtual ? Math.min(rows.length, Math.ceil((win.top + win.height) / win.rowH) + 20) : rows.length;
  const visibleRows = rows.slice(first, last);
  const fresh = pinned.map(id => allItems.find(i => i.id === id)).filter(Boolean) as Item[];
  const commit = async (moveRight: boolean) => {
    const text = draft.trim();
    if (!text) { if (!moveRight) setDrafting(false); return; }
    setDraft('');
    const item = await store.quickAdd(project.id, text, {sort: (allItems.reduce((m, i) => Math.max(m, i.sort), 0)) + 1});
    if (!item) { setDraft(text); return; }
    setPinned(p => [...p, item.id]);
    if (moveRight) {
      setDrafting(false);
      // Focus the first control after the title in the new row.
      setTimeout(() => {
        const tr = document.querySelector(`tr[data-id="${item.id}"]`);
        const cells = tr ? [...tr.querySelectorAll('td')] : [];
        const titleIdx = shown.findIndex(c => c.id === 'title');
        (cells.slice(titleIdx + 1).map(td => td.querySelector('button, input, select')).find(Boolean) as HTMLElement | undefined)?.focus();
      }, 50);
    }
  };

  const startResize = (e: React.PointerEvent, c: Col) => {
    e.preventDefault(); e.stopPropagation();
    resizing.current = {id: c.id, x: e.clientX, w: c.width};
    let frame = 0;
    const move = (ev: PointerEvent) => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { const r = resizing.current; if (r) setLive({id: r.id, width: Math.max(60, r.w + ev.clientX - r.x)}); }); };
    const upFn = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      const r = resizing.current; resizing.current = null; setLive(null);
      removeEventListener('pointermove', move); removeEventListener('pointerup', upFn);
      if (r) saveCols(cols.map(x => ({id: x.id, width: x.id === r.id ? Math.max(60, r.w + ev.clientX - r.x) : x.width})));
    };
    addEventListener('pointermove', move); addEventListener('pointerup', upFn);
  };
  const dropCol = (target: string) => {
    if (!dragCol || dragCol === target) return;
    const order = cols.map(c => ({id: c.id, width: c.width}));
    const from = order.findIndex(c => c.id === dragCol), [moved] = order.splice(from, 1);
    order.splice(order.findIndex(c => c.id === target), 0, moved);
    saveCols(order);
  };
  const total = items.reduce((a, i) => a + (i.estimate ?? 0), 0);

  return (
    <div className="table-wrap" ref={wrap}>
      <table className="grid" style={{width: 50 + shown.reduce((a, c) => a + c.width, 0) + 44}}>
        <thead><tr>
          <th className="sel-col">{(() => {
            const n = rows.filter(i => selected.has(i.id)).length, all = rows.length > 0 && n === rows.length;
            // Checked when all are selected, a dash when some are; clicking selects all, or clears when any are selected.
            return <input type="checkbox" title={n ? `${n} selected. Click to clear` : 'Select all'} checked={all}
              ref={el => { if (el) el.indeterminate = n > 0 && !all; }}
              onChange={() => setSelected(n ? new Set() : new Set(rows.map(i => i.id)))} />;
          })()}</th>
          {shown.map(c => (
            <th key={c.id} style={{width: c.width}} className={overCol === c.id && dragCol !== c.id ? 'drop' : ''}
              draggable onDragStart={e => { if (resizing.current) { e.preventDefault(); return; } setDragCol(c.id); }} onDragEnd={() => { setDragCol(null); setOverCol(null); }}
              onDragOver={e => { e.preventDefault(); setOverCol(c.id); }} onDrop={() => { dropCol(c.id); setOverCol(null); }}>
              <ColumnHeader col={c} sorts={sorts} project={project} store={store}
                setSorts={s => setConfig({sorts: s, sort: null})} hide={() => setConfig({hidden: [...hidden, c.id]})} />
              <span className={'resize' + (live?.id === c.id ? ' on' : '')} onPointerDown={e => startResize(e, c)} onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }} onClick={e => e.stopPropagation()} title="Drag to resize" />
            </th>
          ))}
          <th className="add-col"><AddColumnButton store={store} project={project} /></th>
        </tr></thead>
        <tbody>
          {first > 0 && <tr aria-hidden style={{height: first * win.rowH}}><td colSpan={shown.length + 2} /></tr>}
          {visibleRows.map(i => <Fragment key={i.id}><tr data-id={i.id} style={tint(colorOf(i, activeColors(config), {project, today: store.today}))} className={(i.completed ? 'done' : '') + (selected.has(i.id) ? ' sel' : '')}>
            <td className="sel-col"><button className="row-add" title="Add a row below (Alt+click: above)" onClick={e => setInsertAt({id: i.id, above: e.altKey})}><Plus size={12} /></button><input type="checkbox" checked={selected.has(i.id)} onChange={() => {}} onClick={e => toggle(i.id, {shiftKey: e.shiftKey, ctrlKey: true, metaKey: false}, rows.map(r => r.id))} /></td>
            {shown.map(c => <td key={c.id}>{c.cell(i)}</td>)}<td><button className="icon more" title="Open details" onClick={() => open(i.id)}><MoreHorizontal size={16} /></button></td></tr>
            {insertAt?.id === i.id && <InsertRow cols={shown.length} onDone={() => setInsertAt(null)} onAdd={async text => {
              // Between this row and the one shown next to it.
              const sibs = rows, at = sibs.findIndex(x => x.id === i.id);
              const sort = insertAt.above ? between(sibs[at - 1]?.sort, i.sort) : between(i.sort, sibs[at + 1]?.sort);
              const made = await store.quickAdd(project.id, text, {parentId: i.parentId, sort});
              if (made) setInsertAt({id: made.id, above: false});
            }} />}
          </Fragment>)}
          {last < rows.length && <tr aria-hidden style={{height: (rows.length - last) * win.rowH}}><td colSpan={shown.length + 2} /></tr>}
          {fresh.map(i => <tr key={i.id} data-id={i.id} className={'fresh' + (i.completed ? ' done' : '')}><td className="sel-col" />{shown.map(c => <td key={c.id}>{c.cell(i)}</td>)}<td><span className="new-tag">new</span></td></tr>)}
          {drafting ? (
            <tr className="draft">
              <td className="sel-col" />
              {shown.map(c => <td key={c.id}>{c.id === 'title'
                ? <span className="title-cell"><span className="check ghost" /><input autoFocus className="inline" placeholder="Name it, then Tab to fill other columns" value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={() => { if (!draft.trim()) setDrafting(false); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); commit(false); }
                      if (e.key === 'Tab' && !e.shiftKey && draft.trim()) { e.preventDefault(); commit(true); }
                      if (e.key === 'Escape') { setDraft(''); setDrafting(false); }
                    }} /></span>
                : c.id === 'key' ? <span className="muted small">new</span> : <span className="muted small">-</span>}</td>)}
              <td />
            </tr>
          ) : (
            <tr><td colSpan={shown.length + 2}>
              <button className="add-row" onClick={() => setDrafting(true)}><Plus size={14} /> New row <span className="small">Enter adds another, Tab moves to the next column. Shortcuts also work: @sam !high due:fri #tag ~2h</span></button>
            </td></tr>
          )}
          {fresh.length > 0 && !drafting && <tr><td colSpan={shown.length + 2}><button className="btn" onClick={() => setPinned([])}>Done adding ({fresh.length}), apply sort and filters</button></td></tr>}
          <tr className="calc-row"><td className="sel-col" />{shown.map(c => {
            const k = config.calcs?.[c.id] ?? '';
            const label = k ? CALC_LABEL[k] : '';
            return <td key={c.id}><CalcCell numeric={['estimate', 'priority'].includes(c.id) || ['number', 'money', 'rating', 'formula', 'rollup'].includes(project.fields.find(f => 'f:' + f.id === c.id)?.kind ?? '')} label={label} value={k ? calc(k, rows.map(i => (c.raw ?? c.sortVal)(i)), rows) : ''} onPick={v => setConfig({calcs: {...config.calcs, [c.id]: v}})} /></td>;
          })}<td /></tr>
          <tr><td colSpan={shown.length + 2} className="muted small">{rows.length} items{total ? `, ${fmtMinutes(total * 60)} estimated` : ''}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/** One custom column's cell, for tables and the item panel. Worked-out kinds are read-only. */
export function FieldCell({field, item, project, value, onChange, store}: {field: FieldDef; item: Item; project: Project; value: unknown; onChange: (v: unknown) => void; store: Store}) {
  if (field.kind === 'time') return <TimeCell item={item} store={store} />;
  if (COMPUTED.includes(field.kind)) return <ComputedCell field={field} item={item} project={project} store={store} />;
  switch (field.kind) {
    case 'relation': return <RelationCell value={(value as string[]) ?? []} onChange={onChange} store={store} self={item.id} />;
    case 'files': return <FilesCell item={item} store={store} />;
    case 'rating': return <RatingCell value={(value as number) ?? null} onChange={onChange} />;
    case 'money': return <MoneyCell value={value} currency={field.currency} onChange={onChange} />;
    case 'phone': return <ContactCell value={(value as string) ?? ''} href={v => `tel:${v.replace(/[^+0-9]/g, '')}`} onChange={onChange} />;
    case 'email': return <ContactCell value={(value as string) ?? ''} href={v => `mailto:${v}`} onChange={onChange} />;
    case 'checkbox': return <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />;
    case 'date': return <DateInput value={(value as string) ?? null} onChange={onChange} />;
    case 'number': return <input className="inline num" type="number" defaultValue={(value as number) ?? ''} key={String(value)} onBlur={e => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'select': return <SelectField field={field} value={(value as string) ?? null} onChange={onChange} store={store} />;
    case 'multi': return <MultiField field={field} value={(value as string[]) ?? []} onChange={onChange} store={store} />;
    case 'person': return <PeoplePicker value={(value as string[]) ?? []} people={store.people} onReorder={store.reorderPeople} onChange={onChange} />;
    case 'url': return value ? <span className="title-cell"><a className="link" href={String(value)} target="_blank" rel="noreferrer">{String(value).replace(/^https?:\/\//, '').slice(0, 30)}</a><InlineText value={String(value)} placeholder="-" onSave={onChange} /></span> : <InlineText value="" placeholder="https://" onSave={onChange} />;
    default: return <InlineText value={(value as string) ?? ''} placeholder="-" onSave={onChange} />;
  }
}

function ColumnHeader({col, sorts, setSorts, hide, project, store}: {
  col: Col; sorts: SortRule[]; setSorts: (s: SortRule[]) => void; hide: () => void; project: Project; store: Store;
}) {
  const idx = sorts.findIndex(s => s.col === col.id), mine = sorts[idx];
  const setSort = (s: SortRule | null) => setSorts(s ? [s] : []);
  const addLevel = (dir: 1 | -1) => setSorts([...sorts.filter(s => s.col !== col.id), {col: col.id, dir, by: mine?.by}]);
  const setBy = (by: 'order' | 'alpha') => setSorts(mine ? sorts.map(s => s.col === col.id ? {...s, by} : s) : [...sorts, {col: col.id, dir: 1, by}]);
  const toLevel = (n: number) => { const l = sorts.filter(s => s.col !== col.id); l.splice(n, 0, mine!); setSorts(l); };
  const [open, setOpen] = useState(false);
  const field = col.id.startsWith('f:') ? project.fields.find(f => 'f:' + f.id === col.id) : undefined;
  const [name, setName] = useState(col.name);
  const saveName = () => { if (field && name.trim() && name !== field.name) store.updateProject(project.id, {fields: project.fields.map(f => f.id === field.id ? {...f, name: name.trim()} : f)}); };
  return (
    <span className="picker th">
      <span className="grow" title="Click for options. Shift+click adds a sort level. Drag to reorder."
        onClick={e => { if (e.shiftKey) { addLevel(mine?.dir === 1 ? -1 : 1); return; } setOpen(o => !o); }}>
        {col.name}{mine && <span className="sort-badge">{mine.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{sorts.length > 1 && idx + 1}</span>}
      </span>
      <Popover open={open} onClose={() => { saveName(); setOpen(false); }}>
        {field && <input className="pop-search" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { saveName(); setOpen(false); } }} />}
        <button className="pop-row" onClick={() => { setSort({col: col.id, dir: 1, by: mine?.by}); setOpen(false); }}><ArrowUp size={14} /> Sort ascending</button>
        <button className="pop-row" onClick={() => { setSort({col: col.id, dir: -1, by: mine?.by}); setOpen(false); }}><ArrowDown size={14} /> Sort descending</button>
        {hasOrder(col.id, project) && <div className="pop-seg"><span>Order by</span><div className="seg">
          <button className={mine?.by !== 'alpha' ? 'on' : ''} title={col.id === 'priority' ? 'Urgent first' : col.id === 'sprint' ? 'By sprint start date' : 'The order arranged in the dropdown (drag the dots there)'} onClick={() => setBy('order')}>Arranged</button>
          <button className={mine?.by === 'alpha' ? 'on' : ''} onClick={() => setBy('alpha')}>A to Z</button></div></div>}
        {mine && sorts.length > 1 && <div className="pop-seg"><span>Sort level</span><div className="seg">
          {sorts.map((s, n) => <button key={s.col} className={n === idx ? 'on' : ''} title={n === 0 ? 'Sort by this first' : `Sort by this after level ${n}`} onClick={() => toLevel(n)}>{n + 1}</button>)}</div></div>}
        <button className="pop-row" onClick={() => { addLevel(1); setOpen(false); }}><Plus size={14} /> Add as next sort level</button>
        {mine && <button className="pop-row" onClick={() => { setSorts(sorts.filter(s => s.col !== col.id)); setOpen(false); }}>Remove this sort</button>}
        {sorts.length > 0 && <button className="pop-row" onClick={() => { setSort(null); setOpen(false); }}>Clear all sorting</button>}
        {col.id !== 'title' && <button className="pop-row" onClick={() => { hide(); setOpen(false); }}><EyeOff size={14} /> Hide column</button>}
        {field && <button className="pop-row" style={{color: 'var(--danger)'}} onClick={() => { if (confirm(`Delete field "${field.name}" from this project? Values stay on items but are hidden.`)) store.updateProject(project.id, {fields: project.fields.filter(f => f.id !== field.id)}); setOpen(false); }}><Trash2 size={14} /> Delete field</button>}
      </Popover>
    </span>
  );
}

function AddColumnButton({store, project}: {store: Store; project: Project}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="picker">
      <button className="icon" title="Add a column" onClick={() => setOpen(o => !o)}><Plus size={15} /></button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide"><AddField store={store} project={project} onDone={() => setOpen(false)} /></Popover>
    </span>
  );
}

/** Several options at once, shown as chips; new options can be added inline. */
export function MultiField({field, value, onChange, store}: {field: FieldDef; value: string[]; onChange: (v: unknown) => void; store: Store}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const project = store.projects.find(p => p.fields.some(f => f.id === field.id));
  const opts = field.options ?? [];
  return (
    <span className="picker">
      <button className="cell-btn" onClick={() => setOpen(o => !o)}>{value.length ? value.slice(0, 3).map(v => <span key={v} className="tag">{v}</span>) : <span className="muted">-</span>}{value.length > 3 && <span className="tag">+{value.length - 3}</span>}</button>
      <Popover open={open} onClose={() => setOpen(false)}>
        {opts.map(o => <button key={o} className={'pop-row' + (value.includes(o) ? ' on' : '')} onClick={() => onChange(value.includes(o) ? value.filter(x => x !== o) : [...value, o])}><input type="checkbox" readOnly checked={value.includes(o)} /> {o}</button>)}
        {project && <input className="pop-search" placeholder="+ Add option, Enter" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => {
          if (e.key !== 'Enter' || !text.trim()) return;
          const v = text.trim(); setText('');
          if (!opts.includes(v)) store.updateProject(project.id, {fields: project.fields.map(f => f.id === field.id ? {...f, options: [...opts, v]} : f)});
          onChange([...new Set([...value, v])]);
        }} />}
      </Popover>
    </span>
  );
}

export function SelectField({field, value, onChange, store}: {field: FieldDef; value: string | null; onChange: (v: unknown) => void; store: Store}) {
  const project = store.projects.find(p => p.fields.some(f => f.id === field.id));
  return <Menu value={value} onChange={onChange} title={field.name}
    onReorder={project ? (opts: string[]) => { store.updateProject(project.id, {fields: project.fields.map(f => f.id === field.id ? {...f, options: opts} : f)}); } : undefined}
    options={[{value: null, label: 'None'}, ...(field.options ?? []).map(o => ({value: o as string | null, label: o}))]}
    render={value ? <span className="tag">{value}</span> : <span className="muted">-</span>}
    onAdd={project ? (name: string) => { store.updateProject(project.id, {fields: project.fields.map(f => f.id === field.id ? {...f, options: [...(f.options ?? []), name]} : f)}); return name; } : undefined} />;
}

export {AddField} from './Fields.tsx';

function MoneyCell({value, currency, onChange}: {value: unknown; currency?: string; onChange: (v: unknown) => void}) {
  const [edit, setEdit] = useState(false);
  return edit ? <input className="inline num" type="number" step="0.01" autoFocus defaultValue={(value as number) ?? ''} onBlur={e => { setEdit(false); onChange(e.target.value === '' ? null : Number(e.target.value)); }} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    : <button className="cell-btn money" onClick={() => setEdit(true)}>{fmtMoney(value, currency) || <span className="muted">-</span>}</button>;
}

/** Phone or email: a link to call or write, pencil to edit, empty to clear. */
function ContactCell({value, href, onChange}: {value: string; href: (v: string) => string; onChange: (v: unknown) => void}) {
  const [edit, setEdit] = useState(false);
  if (edit || !value) return <InlineText value={value} placeholder="-" onSave={v => { setEdit(false); const t = v.trim(); if (t !== value) onChange(t || null); }} />;
  return <span className="title-cell"><a className="link" href={href(value)}>{value}</a><button className="icon cell-edit" title="Edit" onClick={() => setEdit(true)}><Pencil size={12} /></button></span>;
}

/** An inline row for adding a task between two rows. Enter adds and opens another below it, Esc stops. */
function InsertRow({cols, onAdd, onDone}: {cols: number; onAdd: (text: string) => Promise<void>; onDone: () => void}) {
  const [text, setText] = useState('');
  return <tr className="draft insert-row"><td className="sel-col" /><td colSpan={cols + 1}>
    <span className="title-cell"><span className="check ghost" /><input autoFocus className="inline" placeholder="New row here. Enter to add, Esc to stop" value={text}
      onChange={e => setText(e.target.value)} onBlur={() => { if (!text.trim()) onDone(); }}
      onKeyDown={async e => { if (e.key === 'Escape') onDone(); if (e.key === 'Enter' && text.trim()) { e.preventDefault(); const t = text; setText(''); await onAdd(t); } }} /></span>
  </td></tr>;
}
