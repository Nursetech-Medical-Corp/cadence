// Conditional colors: rules that tint rows and cards, like "overdue = red" or "priority urgent = orange".
// The first matching rule wins. Saved with the view.
import {useState} from 'react';
import {Palette, Plus, X} from 'lucide-react';
import type {FilterRule, Item, Project, ViewConfig} from './types.ts';
import type {Store} from './store.ts';
import {Popover} from './components.tsx';
import {OPS, filterFields, matchFilter} from './FilterBuilder.tsx';

export type ColorRule = {rule: FilterRule; color: string};
const SWATCHES = ['#ef4444', '#f97316', '#eab308', '#10b981', '#0ea5e9', '#6d5dfc', '#ec4899', '#64748b'];
const PRESETS: [string, ColorRule][] = [
  ['Overdue in red', {rule: {field: 'due', op: 'before', value: 'today'}, color: '#ef4444'}],
  ['Due today in orange', {rule: {field: 'due', op: 'is', value: 'today'}, color: '#f97316'}],
  ['Urgent in red', {rule: {field: 'priority', op: 'is', value: '1'}, color: '#ef4444'}],
  ['High priority in orange', {rule: {field: 'priority', op: 'is', value: '2'}, color: '#f97316'}],
  ['Done in green', {rule: {field: 'statusGroup', op: 'is', value: 'done'}, color: '#10b981'}],
];

/** The color for an item under a view's rules, if any rule matches. */
export function colorOf(i: Item, rules: ColorRule[] | undefined, ctx: {project: Project; today: string}) {
  for (const r of rules ?? []) if (matchFilter(i, {join: 'and', rules: [r.rule]}, {...ctx, currentSprint: null})) return r.color;
  return undefined;
}
/** Style for a tinted row or card. */
export const tint = (c: string | undefined) => c ? {boxShadow: `inset 3px 0 0 ${c}`, background: `color-mix(in srgb, ${c} 9%, transparent)`} : undefined;

export function ColorRulesButton({store, project, config, setConfig}: {store: Store; project: Project; config: ViewConfig; setConfig: (p: Partial<ViewConfig>) => void}) {
  const [open, setOpen] = useState(false);
  const rules = config.colors ?? [];
  const fields = filterFields(project, store, store.sprints.filter(s => s.projectId === project.id));
  const save = (l: ColorRule[]) => setConfig({colors: l});
  const set = (n: number, patch: Partial<FilterRule> | {color: string}) => save(rules.map((r, k) => k !== n ? r : 'color' in patch ? {...r, color: patch.color} : {...r, rule: {...r.rule, ...patch}}));
  return (
    <span className="picker">
      <button className={'btn' + (rules.length ? ' on' : '')} onClick={() => setOpen(o => !o)} title="Color rows and cards by rules"><Palette size={13} /> Colors{rules.length ? ` ${rules.length}` : ''}</button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide">
        <div className="pop-label">Color rows and cards when... (the first rule that matches wins)</div>
        {rules.map((r, n) => {
          const f = fields.find(x => x.id === r.rule.field) ?? fields[0];
          return (
            <div key={n} className="f-row color-rule">
              <select className="plain-select" value={r.rule.field} onChange={e => { const nf = fields.find(x => x.id === e.target.value)!; set(n, {field: nf.id, op: OPS[nf.kind][0].op, value: nf.options?.[0]?.value ?? ''}); }}>
                {fields.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
              <select className="plain-select" value={r.rule.op} onChange={e => set(n, {op: e.target.value as FilterRule['op']})}>{OPS[f.kind].map(o => <option key={o.op} value={o.op}>{o.label}</option>)}</select>
              {!['empty', 'not-empty'].includes(r.rule.op) && (f.options
                ? <select className="plain-select" value={r.rule.value ?? ''} onChange={e => set(n, {value: e.target.value})}>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                : <input className="inline" style={{width: 110}} placeholder={f.kind === 'date' ? 'today, +7, 2026-12-01' : 'value'} value={r.rule.value ?? ''} onChange={e => set(n, {value: e.target.value})} />)}
              <span className="swatches">{SWATCHES.map(c => <button key={c} className={'ws-color' + (r.color === c ? ' on' : '')} style={{background: c}} onClick={() => set(n, {color: c})} />)}</span>
              <button className="icon" title="Remove" onClick={() => save(rules.filter((_, k) => k !== n))}><X size={13} /></button>
            </div>
          );
        })}
        <div className="f-actions" style={{padding: 4, flexWrap: 'wrap', gap: 4}}>
          <button className="btn ghost small" onClick={() => save([...rules, {rule: {field: 'status', op: 'is', value: project.statuses[0]?.id ?? ''}, color: '#6d5dfc'}])}><Plus size={12} /> Add rule</button>
          {PRESETS.filter(([, p]) => !rules.some(r => JSON.stringify(r) === JSON.stringify(p))).map(([label, p]) => <button key={label} className="btn ghost small" onClick={() => save([...rules, p])}>{label}</button>)}
        </div>
      </Popover>
    </span>
  );
}
