// Column kinds beyond plain values: formula, relation, rollup, and automatic ones (created, edited, created by),
// plus phone and email. Also the column picker, the property visibility panel and column totals.
import {useMemo, useState} from 'react';
import {AtSign, DollarSign, Paperclip, Star, Calculator, Calendar, CheckSquare, Clock, Eye, EyeOff, GripVertical, Hash, Link2, List, ListChecks, Phone, Plus, Search, Sigma, Text, User, UserPlus, Workflow, X, Timer} from 'lucide-react';
import type {FieldDef, FieldKind, Item, Project, ViewConfig} from './types.ts';
import type {Store} from './store.ts';
import {Popover, itemKey} from './components.tsx';

type Kind = {kind: FieldKind; label: string; icon: typeof Text; hint: string};
export const FIELD_KINDS: {group: string; kinds: Kind[]}[] = [
  {group: 'Basic', kinds: [
    {kind: 'text', label: 'Text', icon: Text, hint: 'Any text'},
    {kind: 'number', label: 'Number', icon: Hash, hint: 'Costs, counts, scores'},
    {kind: 'select', label: 'Select', icon: List, hint: 'One option from a list'},
    {kind: 'multi', label: 'Multi-select', icon: ListChecks, hint: 'Several options'},
    {kind: 'date', label: 'Date', icon: Calendar, hint: 'A day'},
    {kind: 'person', label: 'Person', icon: User, hint: 'People in this workspace'},
    {kind: 'checkbox', label: 'Checkbox', icon: CheckSquare, hint: 'Yes or no'},
    {kind: 'url', label: 'URL', icon: Link2, hint: 'A link'},
    {kind: 'phone', label: 'Phone', icon: Phone, hint: 'Tap to call'},
    {kind: 'email', label: 'Email', icon: AtSign, hint: 'Click to write'},
    {kind: 'money', label: 'Money', icon: DollarSign, hint: 'Amounts with a currency'},
    {kind: 'rating', label: 'Rating', icon: Star, hint: 'One to five stars'},
    {kind: 'files', label: 'Files', icon: Paperclip, hint: "The item's attachments, with quick view"},
  ]},
  {group: 'Advanced', kinds: [
    {kind: 'relation', label: 'Relation', icon: Workflow, hint: 'Link to other items, any project'},
    {kind: 'rollup', label: 'Rollup', icon: Sigma, hint: 'Count or sum over related items or subitems'},
    {kind: 'formula', label: 'Formula', icon: Calculator, hint: 'Math and logic over other columns'},
  ]},
  {group: 'Automatic', kinds: [
    {kind: 'created', label: 'Created time', icon: Clock, hint: 'When the item was made'},
    {kind: 'updated', label: 'Last edited time', icon: Clock, hint: 'When it last changed'},
    {kind: 'creator', label: 'Created by', icon: UserPlus, hint: 'Who made it'},
    {kind: 'time', label: 'Time tracked', icon: Timer, hint: 'Start and stop a timer, or log time'},
  ]},
];
export const COMPUTED: FieldKind[] = ['formula', 'rollup', 'created', 'updated', 'creator', 'time'];
export const kindIcon = (k: FieldKind) => FIELD_KINDS.flatMap(g => g.kinds).find(x => x.kind === k)?.icon ?? Text;

import {evalFormula, type Val} from './formula.ts';
export {evalFormula};

// ---------- Computed values ----------
export const ROLLUP_FNS: [string, string][] = [['count', 'Count'], ['sum', 'Sum'], ['avg', 'Average'], ['min', 'Min'], ['max', 'Max'], ['percentDone', 'Progress (percent done)'], ['earliestDue', 'Earliest due'], ['latestDue', 'Latest due']];

/** Builds a reader for one item: built-in properties and every column by name. */
export function reader(item: Item, project: Project, store: Store, depth = 0) {
  const kids = () => [...store.items.values()].filter(i => i.parentId === item.id);
  const builtIn: Record<string, () => Val> = {
    title: () => item.title, status: () => project.statuses.find(s => s.id === item.status)?.name ?? item.status, type: () => item.type,
    priority: () => item.priority, estimate: () => item.estimate, due: () => item.due, start: () => item.start,
    created: () => item.created.slice(0, 10), updated: () => item.updated.slice(0, 10), done: () => !!item.completed,
    assignees: () => item.assignees.length, subitems: () => kids().length, tags: () => item.tags.join(', '), key: () => itemKey(item, store.projects),
  };
  return (name: string): Val => {
    const f = project.fields.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (f) return depth > 6 ? null : valueOf(f, item, project, store, depth + 1);
    const b = builtIn[name.toLowerCase()];
    if (b) return b();
    throw new Error(`No column named {${name}}`);
  };
}
/** The value of a column for an item: stored for plain kinds, worked out for the rest. */
export function valueOf(f: FieldDef, item: Item, project: Project, store: Store, depth = 0): Val {
  switch (f.kind) {
    case 'created': return item.created;
    case 'updated': return item.updated;
    case 'creator': return store.people.find(p => p.id === item.createdBy)?.name ?? null;
    case 'time': return store.timeTotals.get(item.id) ?? 0; // minutes
    case 'formula': return evalFormula(f.formula ?? '', reader(item, project, store, depth), store.today);
    case 'rollup': {
      const r = f.rollup;
      if (!r) return null;
      const linked = r.via === 'children' ? [...store.items.values()].filter(i => i.parentId === item.id)
        : ((item.fields[r.via] as string[] | undefined) ?? []).map(id => store.items.get(id)).filter((x): x is Item => !!x);
      if (r.fn === 'count') return linked.length;
      if (r.fn === 'percentDone') return linked.length ? Math.round(100 * linked.filter(i => i.completed).length / linked.length) : null;
      if (r.fn === 'earliestDue' || r.fn === 'latestDue') { const d = linked.map(i => i.due).filter(Boolean).sort() as string[]; return (r.fn === 'earliestDue' ? d[0] : d.at(-1)) ?? null; }
      const nums = linked.map(i => r.prop === 'estimate' ? i.estimate : r.prop === 'priority' ? i.priority : Number(i.fields[r.prop.replace(/^f:/, '')])).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (!nums.length) return null;
      return r.fn === 'sum' ? nums.reduce((a, b) => a + b, 0) : r.fn === 'avg' ? Math.round(100 * nums.reduce((a, b) => a + b, 0) / nums.length) / 100 : r.fn === 'min' ? Math.min(...nums) : Math.max(...nums);
    }
    default: { const v = item.fields[f.id]; return Array.isArray(v) ? v.length : (v as Val) ?? null; }
  }
}
export function showValue(v: Val, kind: FieldKind) {
  if (v === null || v === undefined || v === '') return '';
  if (kind === 'created' || kind === 'updated') return new Date(String(v)).toLocaleString(undefined, {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'});
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(+v.toFixed(4));
  return String(v);
}

/** Read-only cell for worked-out columns. Formula errors show what went wrong on hover. */
export function ComputedCell({field, item, project, store}: {field: FieldDef; item: Item; project: Project; store: Store}) {
  try {
    const v = valueOf(field, item, project, store);
    if (field.kind === 'rollup' && field.rollup?.fn === 'percentDone' && typeof v === 'number') return <span className="progress-cell" title={`${v}% done`}><span className="progress-track"><span style={{width: `${v}%`}} /></span>{v}%</span>;
    return <span className={'computed' + (typeof v === 'number' ? ' num' : '')} title={field.kind === 'formula' ? field.formula : undefined}>{showValue(v, field.kind) || <span className="muted">-</span>}</span>;
  } catch (e) {
    return <span className="computed err" title={String(e instanceof Error ? e.message : e)}>#error</span>;
  }
}

/** Links to other items in any project, shown as chips. */
export function RelationCell({value, onChange, store, self}: {value: string[]; onChange: (v: string[]) => void; store: Store; self: string}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const linked = value.map(id => store.items.get(id)).filter((x): x is Item => !!x);
  const found = useMemo(() => !open ? [] : [...store.items.values()].filter(i => i.id !== self && !value.includes(i.id) && (i.title + ' ' + itemKey(i, store.projects)).toLowerCase().includes(q.toLowerCase())).slice(0, 12), [open, q, store.items, value, self]);
  return (
    <span className="picker">
      <button className="cell-btn" onClick={() => setOpen(o => !o)}>
        {linked.length ? linked.slice(0, 2).map(i => <span key={i.id} className="tag rel-chip">{itemKey(i, store.projects)} {i.title.slice(0, 24)}</span>) : <span className="muted">-</span>}
        {linked.length > 2 && <span className="tag">+{linked.length - 2}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide">
        {linked.map(i => <div key={i.id} className="pop-row"><span className="grow">{itemKey(i, store.projects)} {i.title}</span><button className="icon" title="Unlink" onClick={() => onChange(value.filter(x => x !== i.id))}><X size={12} /></button></div>)}
        <input className="pop-search" autoFocus placeholder="Find an item to link" value={q} onChange={e => setQ(e.target.value)} />
        {found.map(i => <button key={i.id} className="pop-row" onClick={() => { onChange([...value, i.id]); setQ(''); }}><span className="muted small">{itemKey(i, store.projects)}</span> {i.title}</button>)}
      </Popover>
    </span>
  );
}

/** Notion-style column picker: name, then a type from a grid, with settings for formulas and rollups. */
export function AddField({store, project, onDone}: {store: Store; project: Project; onDone?: () => void}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FieldKind | null>(null);
  const [options, setOptions] = useState('');
  const [formula, setFormula] = useState('');
  const [via, setVia] = useState('children');
  const [prop, setProp] = useState('estimate');
  const [fn, setFn] = useState('sum');
  const [q, setQ] = useState('');
  const relations = project.fields.filter(f => f.kind === 'relation');
  const numbers = project.fields.filter(f => f.kind === 'number');
  // Syntax errors block adding; a missing column is fine until a matching column exists.
  const formulaError = useMemo(() => {
    if (kind !== 'formula' || !formula.trim()) return '';
    if (name.trim() && formula.toLowerCase().includes(`{${name.trim().toLowerCase()}}`)) return 'A formula cannot read its own column';
    try { evalFormula(formula, () => 0, store.today); return ''; } catch (e) { return String(e instanceof Error ? e.message : e); }
  }, [kind, formula, name]);
  const preview = useMemo(() => {
    if (kind !== 'formula' || !formula.trim()) return '';
    const sample = [...store.items.values()].find(i => i.projectId === project.id);
    if (!sample) return '';
    try { return `On "${sample.title.slice(0, 30)}": ${showValue(evalFormula(formula, reader(sample, project, store), store.today), 'formula') || 'empty'}`; } catch (e) { return String(e instanceof Error ? e.message : e); }
  }, [kind, formula, store, project]);
  const add = () => {
    if (!kind) return;
    const label = name.trim() || FIELD_KINDS.flatMap(g => g.kinds).find(k => k.kind === kind)!.label;
    const f: FieldDef = {id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString(36).slice(-3), name: label, kind};
    if (kind === 'select' || kind === 'multi') f.options = options.split(',').map(s => s.trim()).filter(Boolean);
    if (kind === 'formula') f.formula = formula;
    if (kind === 'money') f.currency = options || 'USD';
    if (kind === 'rollup') f.rollup = {via, prop, fn};
    store.updateProject(project.id, {fields: [...project.fields, f]});
    setName(''); setKind(null); setOptions(''); setFormula('');
    onDone?.();
  };
  return (
    <div className="add-field2">
      <input className="pop-search" autoFocus placeholder="Column name" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && kind && add()} />
      {!kind && <>
        <div className="pop-search-row"><Search size={12} /><input placeholder="Find a type" value={q} onChange={e => setQ(e.target.value)} /></div>
        {FIELD_KINDS.map(g => {
          const list = g.kinds.filter(k => (k.label + k.hint).toLowerCase().includes(q.toLowerCase()));
          return list.length > 0 && <div key={g.group}>
            <div className="pop-label">{g.group}</div>
            <div className="kind-grid">{list.map(k => <button key={k.kind} className="kind-cell" title={k.hint} onClick={() => setKind(k.kind)}><k.icon size={14} /> {k.label}</button>)}</div>
          </div>;
        })}
      </>}
      {kind && <div className="kind-settings">
        <div className="pop-label">{FIELD_KINDS.flatMap(g => g.kinds).find(k => k.kind === kind)!.label} <button className="link-btn small muted" onClick={() => setKind(null)}>change type</button></div>
        {(kind === 'select' || kind === 'multi') && <input className="pop-search" placeholder="Options, comma separated" value={options} onChange={e => setOptions(e.target.value)} />}
        {kind === 'money' && <select className="plain-select" value={options || 'USD'} onChange={e => setOptions(e.target.value)}>{['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR', 'MXN', 'BRL', 'CHF'].map(c => <option key={c}>{c}</option>)}</select>}
        {kind === 'formula' && <>
          <textarea className="comment-box formula-box" placeholder={'{Cost} * {Quantity}\nif({Done}, 0, days(today(), {Due}))'} value={formula} onChange={e => setFormula(e.target.value)} />
          <div className="muted small">Columns in braces: {['Title', 'Status', 'Estimate', 'Priority', 'Due', 'Start', 'Done', 'Subitems', ...project.fields.map(f => f.name)].slice(0, 14).map(n => <code key={n} className="chip-code" onClick={() => setFormula(x => x + `{${n}}`)}>{`{${n}}`}</code>)}</div>
          <div className="muted small">Functions: if, round, min, max, sum, days, today, dateAdd, concat, len, empty, contains</div>
          {preview && <div className="small formula-preview">{preview}</div>}
        </>}
        {kind === 'rollup' && <div className="rollup-form">
          <label>Over <select className="plain-select" value={via} onChange={e => setVia(e.target.value)}>
            <option value="children">Subitems</option>{relations.map(r => <option key={r.id} value={r.id}>Relation: {r.name}</option>)}
          </select></label>
          <label>Calculate <select className="plain-select" value={fn} onChange={e => setFn(e.target.value)}>{ROLLUP_FNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {['sum', 'avg', 'min', 'max'].includes(fn) && <label>Of <select className="plain-select" value={prop} onChange={e => setProp(e.target.value)}>
            <option value="estimate">Estimate</option><option value="priority">Priority</option>{numbers.map(n => <option key={n.id} value={'f:' + n.id}>{n.name}</option>)}
          </select></label>}
          {!relations.length && <div className="muted small">Add a Relation column to roll up linked items too.</div>}
        </div>}
        <button className="btn primary small" style={{marginTop: 6}} disabled={kind === 'formula' && (!formula.trim() || formulaError !== '')} title={formulaError} onClick={add}><Plus size={12} /> Add column</button>
      </div>}
    </div>
  );
}

/** Property visibility: search, show or hide each column, drag to reorder, hide or show all. */
export function PropertyPanel({cols, config, setConfig, defaultHidden}: {cols: [string, string][]; config: ViewConfig; setConfig: (p: Partial<ViewConfig>) => void; defaultHidden: string[]}) {
  const [q, setQ] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const hidden = config.hidden ?? defaultHidden;
  const saved = config.columns ?? [];
  const ordered = [...cols].sort((a, b) => { const ia = saved.findIndex(c => c.id === a[0]), ib = saved.findIndex(c => c.id === b[0]); return (ia < 0 ? 999 + cols.indexOf(a) : ia) - (ib < 0 ? 999 + cols.indexOf(b) : ib); });
  const match = (n: string) => n.toLowerCase().includes(q.toLowerCase());
  const drop = (target: string) => {
    if (!drag || drag === target) return;
    const ids = ordered.map(c => c[0]).filter(id => id !== drag);
    ids.splice(ids.indexOf(target), 0, drag);
    setConfig({columns: ids.map(id => ({id, width: saved.find(s => s.id === id)?.width ?? 0}))}); // 0 keeps the default width
  };
  const row = ([id, name]: [string, string]) => (
    <div key={id} className={'prop-row' + (drag === id ? ' dragging' : '')} draggable={!q} onDragStart={() => setDrag(id)} onDragEnd={() => setDrag(null)} onDragOver={e => e.preventDefault()} onDrop={() => drop(id)}>
      <GripVertical size={12} className="muted" /><span className="grow">{name}</span>
      {id === 'title' ? <Eye size={14} className="muted" /> : <button className="icon" title={hidden.includes(id) ? 'Show' : 'Hide'} onClick={() => setConfig({hidden: hidden.includes(id) ? hidden.filter(h => h !== id) : [...hidden, id]})}>{hidden.includes(id) ? <EyeOff size={14} className="muted" /> : <Eye size={14} />}</button>}
    </div>
  );
  const shown = ordered.filter(c => !hidden.includes(c[0]) && match(c[1])), off = ordered.filter(c => hidden.includes(c[0]) && match(c[1]));
  return (
    <div className="prop-panel">
      <div className="pop-search-row"><Search size={12} /><input autoFocus placeholder="Search for a property" value={q} onChange={e => setQ(e.target.value)} /></div>
      <div className="pop-label prop-head">Shown <button className="link-btn small" onClick={() => setConfig({hidden: cols.map(c => c[0]).filter(id => id !== 'title')})}>Hide all</button></div>
      {shown.map(row)}
      {off.length > 0 && <><div className="pop-label prop-head">Hidden <button className="link-btn small" onClick={() => setConfig({hidden: []})}>Show all</button></div>{off.map(row)}</>}
    </div>
  );
}

// ---------- Column totals ----------
export const CALCS: [string, string][] = [['', 'None'], ['count', 'Count all'], ['filled', 'Count filled'], ['empty', 'Count empty'], ['unique', 'Count unique'], ['sum', 'Sum'], ['avg', 'Average'], ['min', 'Min'], ['max', 'Max'], ['checked', 'Percent checked'], ['done', 'Percent done']];
export function calc(kind: string, values: unknown[], items: Item[]): string {
  const filled = values.filter(v => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
  const nums = filled.map(Number).filter(Number.isFinite);
  const r = (n: number) => String(+n.toFixed(2));
  switch (kind) {
    case 'count': return `${values.length}`;
    case 'filled': return `${filled.length}`;
    case 'empty': return `${values.length - filled.length}`;
    case 'unique': return `${new Set(filled.map(v => JSON.stringify(v))).size}`;
    case 'sum': return r(nums.reduce((a, b) => a + b, 0));
    case 'avg': return nums.length ? r(nums.reduce((a, b) => a + b, 0) / nums.length) : '-';
    case 'min': return nums.length ? r(Math.min(...nums)) : '-';
    case 'max': return nums.length ? r(Math.max(...nums)) : '-';
    case 'checked': return values.length ? `${Math.round(100 * values.filter(v => v === true).length / values.length)}%` : '-';
    case 'done': return items.length ? `${Math.round(100 * items.filter(i => i.completed).length / items.length)}%` : '-';
    default: return '';
  }
}
export function CalcCell({value, label, onPick, numeric = true}: {value: string; label: string; onPick: (k: string) => void; numeric?: boolean}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="picker calc-cell">
      <button className="calc-btn" onClick={() => setOpen(o => !o)}>{label ? <><span className="muted">{label}</span> <b>{value}</b></> : <span className="calc-hint">Calculate</span>}</button>
      <Popover open={open} onClose={() => setOpen(false)}>{CALCS.filter(([k]) => numeric || !['sum', 'avg', 'min', 'max'].includes(k)).map(([k, l]) => <button key={k} className="pop-row" onClick={() => { onPick(k); setOpen(false); }}>{l}</button>)}</Popover>
    </span>
  );
}

/** Stars from one to five; click the same star again to clear. */
export function RatingCell({value, onChange}: {value: number | null; onChange: (v: number | null) => void}) {
  return <span className="rating">{[1, 2, 3, 4, 5].map(n => <button key={n} className={(value ?? 0) >= n ? 'on' : ''} title={`${n} of 5`} onClick={() => onChange(value === n ? null : n)}><Star size={13} /></button>)}</span>;
}
export const fmtMoney = (v: unknown, currency = 'USD') => typeof v === 'number' && Number.isFinite(v) ? new Intl.NumberFormat(undefined, {style: 'currency', currency}).format(v) : '';
