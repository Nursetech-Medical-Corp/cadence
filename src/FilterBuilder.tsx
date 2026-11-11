// AND/OR filter builder, saved with the view. One level of nested groups, like Notion's advanced filters.
import {useState} from 'react';
import {Filter, Plus, Trash2, X} from 'lucide-react';
import type {FilterGroup, FilterRule, Item, Project, Sprint} from './types.ts';
import {PRIORITIES} from './types.ts';
import type {Store} from './store.ts';
import {Popover} from './components.tsx';

type FieldSpec = {id: string; label: string; kind: 'text' | 'choice' | 'date' | 'number'; options?: {value: string; label: string}[]};

export function filterFields(project: Project, store: Store, sprints: Sprint[]): FieldSpec[] {
  return [
    {id: 'title', label: 'Title', kind: 'text'},
    {id: 'status', label: 'Status', kind: 'choice', options: project.statuses.map(s => ({value: s.id, label: s.name}))},
    {id: 'statusGroup', label: 'Status group', kind: 'choice', options: [{value: 'todo', label: 'Not started'}, {value: 'doing', label: 'Active'}, {value: 'done', label: 'Done'}]},
    {id: 'type', label: 'Type', kind: 'choice', options: project.types.map(t => ({value: t, label: t}))},
    {id: 'priority', label: 'Priority', kind: 'choice', options: [1, 2, 3, 4, 0].map(p => ({value: String(p), label: PRIORITIES[p]}))},
    {id: 'assignee', label: 'Assignee', kind: 'choice', options: store.people.map(p => ({value: p.id, label: p.name}))},
    {id: 'tag', label: 'Tag', kind: 'text'},
    {id: 'sprint', label: 'Sprint', kind: 'choice', options: [{value: 'current', label: 'Current sprint'}, ...sprints.map(s => ({value: s.id, label: s.name}))]},
    {id: 'due', label: 'Due date', kind: 'date'},
    {id: 'start', label: 'Start date', kind: 'date'},
    {id: 'estimate', label: 'Estimate (h)', kind: 'number'},
    {id: 'recurring', label: 'Repeats', kind: 'choice', options: [{value: 'yes', label: 'Yes'}]},
    ...project.fields.map(f => ({id: 'f:' + f.id, label: f.name, kind: (f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : f.kind === 'select' ? 'choice' : 'text') as FieldSpec['kind'],
      options: f.options?.map(o => ({value: o, label: o}))})).map(x => project.fields.find(f => 'f:' + f.id === x.id)?.kind === 'multi' ? {...x, kind: 'choice' as const} : x),
  ];
}

const OPS: Record<FieldSpec['kind'], {op: FilterRule['op']; label: string}[]> = {
  text: [{op: 'contains', label: 'contains'}, {op: 'is', label: 'is'}, {op: 'is-not', label: 'is not'}, {op: 'empty', label: 'is empty'}, {op: 'not-empty', label: 'is not empty'}],
  choice: [{op: 'is', label: 'is'}, {op: 'is-not', label: 'is not'}, {op: 'empty', label: 'is empty'}, {op: 'not-empty', label: 'is set'}],
  date: [{op: 'before', label: 'is before'}, {op: 'after', label: 'is after'}, {op: 'is', label: 'is on'}, {op: 'empty', label: 'is empty'}, {op: 'not-empty', label: 'is set'}],
  number: [{op: 'gte', label: 'at least'}, {op: 'lte', label: 'at most'}, {op: 'is', label: 'equals'}, {op: 'empty', label: 'is empty'}],
};

const isGroup = (r: FilterRule | FilterGroup): r is FilterGroup => 'rules' in r;

/** Date values accept "today", "+7" (days from today) or YYYY-MM-DD. */
function dateValue(v: string | undefined, today: string) {
  if (!v) return '';
  if (v === 'today') return today;
  const m = /^([+-]\d+)$/.exec(v);
  if (m) { const d = new Date(today + 'T00:00'); d.setDate(d.getDate() + Number(m[1])); return d.toISOString().slice(0, 10); }
  return v;
}

export function matchFilter(i: Item, g: FilterGroup | undefined, ctx: {project: Project; today: string; currentSprint: string | null}): boolean {
  if (!g || !g.rules.length) return true;
  const test = (r: FilterRule | FilterGroup): boolean => isGroup(r) ? matchFilter(i, r, ctx) : rule(r);
  const rule = (r: FilterRule): boolean => {
    let vals: string[];
    if (r.field === 'title') vals = [i.title];
    else if (r.field === 'status') vals = [i.status];
    else if (r.field === 'statusGroup') vals = [ctx.project.statuses.find(s => s.id === i.status)?.category ?? ''];
    else if (r.field === 'type') vals = [i.type];
    else if (r.field === 'priority') vals = [String(i.priority)];
    else if (r.field === 'assignee') vals = i.assignees;
    else if (r.field === 'tag') vals = i.tags;
    else if (r.field === 'sprint') vals = i.sprint ? [i.sprint] : [];
    else if (r.field === 'due') vals = i.due ? [i.due] : [];
    else if (r.field === 'start') vals = i.start ? [i.start] : [];
    else if (r.field === 'estimate') vals = i.estimate != null ? [String(i.estimate)] : [];
    else if (r.field === 'recurring') vals = i.recur ? ['yes'] : [];
    else { const v = i.fields[r.field.slice(2)]; vals = v == null || v === '' ? [] : Array.isArray(v) ? v.map(String) : [String(v)]; }
    const v = r.field === 'sprint' && r.value === 'current' ? ctx.currentSprint ?? '' : (r.field === 'due' || r.field === 'start') ? dateValue(r.value, ctx.today) : r.value ?? '';
    switch (r.op) {
      case 'empty': return !vals.length;
      case 'not-empty': return vals.length > 0;
      case 'is': return vals.some(x => x.toLowerCase() === v.toLowerCase());
      case 'is-not': return !vals.some(x => x.toLowerCase() === v.toLowerCase());
      case 'contains': return vals.some(x => x.toLowerCase().includes(v.toLowerCase()));
      case 'before': return vals.some(x => x < v);
      case 'after': return vals.some(x => x > v);
      case 'gte': return vals.some(x => Number(x) >= Number(v));
      case 'lte': return vals.some(x => Number(x) <= Number(v));
    }
  };
  return g.join === 'and' ? g.rules.every(test) : g.rules.some(test);
}

export function countRules(g?: FilterGroup): number {
  return g ? g.rules.reduce((n, r) => n + (isGroup(r) ? countRules(r) : 1), 0) : 0;
}

export function FilterButton({store, project, sprints, value, onChange}: {store: Store; project: Project; sprints: Sprint[]; value?: FilterGroup; onChange: (g: FilterGroup | undefined) => void}) {
  const [open, setOpen] = useState(false);
  const fields = filterFields(project, store, sprints);
  const g = value ?? {join: 'and', rules: []};
  const n = countRules(value);
  return (
    <span className="picker">
      <button className={'btn' + (n ? ' on' : '')} onClick={() => setOpen(o => !o)}><Filter size={13} /> {n ? `${n} filter${n > 1 ? 's' : ''}` : 'Filter'}</button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide filter-pop">
        <GroupEditor group={g} fields={fields} depth={0} onChange={next => onChange(next.rules.length ? next : undefined)} />
        <div className="muted small" style={{marginTop: 8}}>Dates accept today, +7 or -3 (days from today), or a date. Saved with this view.</div>
      </Popover>
    </span>
  );
}

function GroupEditor({group, fields, depth, onChange, onRemove}: {group: FilterGroup; fields: FieldSpec[]; depth: number; onChange: (g: FilterGroup) => void; onRemove?: () => void}) {
  const set = (k: number, r: FilterRule | FilterGroup | null) => onChange({...group, rules: r ? group.rules.map((x, n) => n === k ? r : x) : group.rules.filter((_, n) => n !== k)});
  return (
    <div className={'f-group' + (depth ? ' nested' : '')}>
      {group.rules.map((r, k) => (
        <div key={k} className="f-row">
          <span className="f-join">{k === 0 ? 'Where' : k === 1
            ? <select className="plain-select" value={group.join} onChange={e => onChange({...group, join: e.target.value as 'and' | 'or'})}><option value="and">and</option><option value="or">or</option></select>
            : group.join}</span>
          {isGroup(r)
            ? <GroupEditor group={r} fields={fields} depth={depth + 1} onChange={x => set(k, x)} onRemove={() => set(k, null)} />
            : <RuleEditor rule={r} fields={fields} onChange={x => set(k, x)} onRemove={() => set(k, null)} />}
        </div>
      ))}
      <div className="f-actions">
        <button className="btn ghost small" onClick={() => onChange({...group, rules: [...group.rules, {field: 'status', op: 'is', value: fields[1].options?.[0]?.value}]})}><Plus size={12} /> Add rule</button>
        {depth === 0 && <button className="btn ghost small" onClick={() => onChange({...group, rules: [...group.rules, {join: group.join === 'and' ? 'or' : 'and', rules: [{field: 'assignee', op: 'is', value: fields.find(f => f.id === 'assignee')?.options?.[0]?.value}]}]})}><Plus size={12} /> Add group</button>}
        {onRemove && <button className="btn ghost small" onClick={onRemove}><Trash2 size={12} /> Remove group</button>}
        {depth === 0 && group.rules.length > 0 && <button className="btn ghost small" onClick={() => onChange({join: 'and', rules: []})}>Clear all</button>}
      </div>
    </div>
  );
}

function RuleEditor({rule, fields, onChange, onRemove}: {rule: FilterRule; fields: FieldSpec[]; onChange: (r: FilterRule) => void; onRemove: () => void}) {
  const f = fields.find(x => x.id === rule.field) ?? fields[0];
  const ops = OPS[f.kind];
  const needsValue = rule.op !== 'empty' && rule.op !== 'not-empty';
  return (
    <span className="f-rule">
      <select className="plain-select" value={rule.field} onChange={e => { const nf = fields.find(x => x.id === e.target.value)!; onChange({field: nf.id, op: OPS[nf.kind][0].op, value: nf.options?.[0]?.value ?? ''}); }}>
        {fields.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      <select className="plain-select" value={rule.op} onChange={e => onChange({...rule, op: e.target.value as FilterRule['op']})}>
        {ops.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>
      {needsValue && (f.options
        ? <select className="plain-select" value={rule.value ?? ''} onChange={e => onChange({...rule, value: e.target.value})}>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        : <input className="plain-select" style={{width: 120}} placeholder={f.kind === 'date' ? 'today, +7, 2026-12-01' : 'value'} value={rule.value ?? ''} onChange={e => onChange({...rule, value: e.target.value})} />)}
      <button className="icon" title="Remove rule" onClick={onRemove}><X size={13} /></button>
    </span>
  );
}
