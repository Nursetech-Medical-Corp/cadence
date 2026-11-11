// Template editor. Task templates are a tree of steps at any level (one task, a workstream, an initiative).
// Project templates are a whole board: levels, statuses (the board columns), views and starting items.
// Timing is relative so a template works for any date: each step starts a number of days after its parent
// starts, or the day after the step above it, or has no date. Items made from it keep that link, so moving
// the parent (or the step before) moves them too.
import {useEffect, useMemo, useState} from 'react';
import {ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronRight, Plus, Save, Trash2} from 'lucide-react';
import type {Recur, Status, Template} from './types.ts';
import {api, type Store} from './store.ts';
import {Empty} from './components.tsx';

export type Step = {
  type?: string; title: string; body?: string; priority?: number; tags?: string[]; estimate?: number | null; recur?: Recur | null;
  worker?: 'human' | 'ai' | 'either'; days?: number | null; offset?: number; anchor?: 'start' | 'after' | 'none'; children?: Step[];
  assignees?: string[]; fields?: Record<string, unknown>;
};
type ProjectData = {statuses: Status[]; types: string[]; fields: unknown[]; settings: unknown; views: {name: string; kind: string; config?: unknown}[]; items: Step[]};

const REPEATS: [string, string, Recur | null][] = [
  ['', 'Does not repeat', null],
  ['d', 'Daily', {every: 1, unit: 'day', mode: 'schedule'}],
  ['w', 'Weekly', {every: 1, unit: 'week', mode: 'schedule'}],
  ['m', 'Monthly', {every: 1, unit: 'month', mode: 'schedule'}],
  ['q', 'Quarterly', {every: 3, unit: 'month', mode: 'schedule'}],
  ['h', 'Twice a year', {every: 6, unit: 'month', mode: 'schedule'}],
  ['y', 'Yearly', {every: 1, unit: 'year', mode: 'schedule'}],
  ['2y', 'Every 2 years', {every: 2, unit: 'year', mode: 'schedule'}],
  ['3y', 'Every 3 years', {every: 3, unit: 'year', mode: 'schedule'}],
  ['5y', 'Every 5 years', {every: 5, unit: 'year', mode: 'schedule'}],
];
const repeatKey = (r?: Recur | null) => !r ? '' : REPEATS.find(([, , x]) => x && x.every === r.every && x.unit === r.unit)?.[0] ?? 'custom';
const anchorOf = (s: Step) => s.anchor ?? (s.offset != null ? 'start' : 'none');
export const VIEW_KINDS = [['list', 'List'], ['table', 'Table'], ['board', 'Board'], ['gantt', 'Timeline'], ['calendar', 'Calendar'], ['backlog', 'Backlog'], ['sprint', 'Sprint'], ['workload', 'Workload'], ['files', 'Files']];

/** Day numbers for each step relative to the top step's start (day 0), the same way the server schedules them. */
function schedule(root: Step) {
  const out = new Map<Step, [number, number] | null>();
  const walk = (n: Step, pStart: number | null, prevDue: number | null, top: boolean) => {
    let span: [number, number] | null = null;
    if (top) span = [0, n.days ?? 0];
    else {
      const a = anchorOf(n);
      const at = a === 'after' && prevDue != null ? prevDue + 1 + (n.offset ?? 0) : a !== 'none' && pStart != null ? pStart + (n.offset ?? 0) : null;
      if (at != null) span = [at, at + (n.days ?? 0)];
    }
    out.set(n, span);
    let prev: number | null = null;
    for (const c of n.children ?? []) prev = walk(c, span ? span[0] : null, prev, false)?.[1] ?? null;
    return span;
  };
  walk(root, null, null, true);
  return out;
}

/** Editable tree of steps. `hideRoot` shows only the children (project starting items). */
function StepTree({root, onChange, types, hideRoot}: {root: Step; onChange: (r: Step) => void; types: string[]; hideRoot?: boolean}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const days = useMemo(() => schedule(root), [root]);
  // Copy-on-write update along a path of child indexes.
  const edit = (path: number[], fn: (siblings: Step[], i: number, parent: Step) => void) => {
    const copy = structuredClone(root) as Step;
    let parent = copy;
    for (const k of path.slice(0, -1)) parent = parent.children![k];
    parent.children = parent.children ?? [];
    fn(parent.children, path[path.length - 1], parent);
    onChange(copy);
  };
  const set = (path: number[], patch: Partial<Step>) => path.length ? edit(path, (s, i) => { s[i] = {...s[i], ...patch}; }) : onChange({...root, ...patch});
  const rows: {n: Step; path: number[]; depth: number}[] = [];
  const walk = (n: Step, path: number[], depth: number) => { rows.push({n, path, depth}); (n.children ?? []).forEach((c, i) => walk(c, [...path, i], depth + 1)); };
  if (hideRoot) (root.children ?? []).forEach((c, i) => walk(c, [i], 0)); else walk(root, [], 0);
  const blank = (): Step => ({type: types.includes('Task') ? 'Task' : types[types.length - 1] ?? 'Task', title: '', worker: 'either', anchor: hideRoot ? 'none' : 'after', offset: 0, days: 1});

  return (
    <div className="tpl-tree">
      <datalist id="tpl-types">{types.map(t => <option key={t} value={t} />)}</datalist>
      <div className="tpl-row tpl-head">
        <span /><span>Step</span><span>Level</span><span>Who</span><span>Hours</span><span>When it starts</span><span>Length</span><span>Repeats</span><span />
      </div>
      {rows.map(({n, path, depth}) => {
        const isRoot = !hideRoot && path.length === 0, d = days.get(n), a = anchorOf(n), key = path.join('.'), expanded = open.has(key);
        const top = hideRoot && path.length === 1;
        const sibs = path.length ? (path.slice(0, -1).reduce((n: Step, k) => n.children![k], root).children ?? []) : [];
        const last = path.length > 0 && path[path.length - 1] === sibs.length - 1;
        return (
          <div key={path.join('.') || 'root'} className={'tpl-item' + (isRoot ? ' root' : '')}>
            <div className="tpl-row">
              <button className="icon" title="Description and tags" onClick={() => setOpen(s => { const x = new Set(s); x.has(key) ? x.delete(key) : x.add(key); return x; })}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
              <span style={{paddingLeft: depth * 18, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0}}>
                <input className="inline tpl-title" value={n.title} placeholder={isRoot ? 'Title, use {name} to fill in when used' : 'Step name'} onChange={e => set(path, {title: e.target.value})} />
              </span>
              <input className="inline" list="tpl-types" value={n.type ?? ''} placeholder="Task" onChange={e => set(path, {type: e.target.value})} />
              <select className="plain-select" value={n.worker ?? 'either'} onChange={e => set(path, {worker: e.target.value as Step['worker']})}>
                <option value="either">Either</option><option value="human">Human</option><option value="ai">AI</option>
              </select>
              <input className="inline num" type="number" min={0} step={0.25} value={n.estimate ?? ''} placeholder="-" onChange={e => set(path, {estimate: e.target.value === '' ? null : Math.max(0, Number(e.target.value))})} />
              <span className="tpl-when">
                {isRoot ? <span className="muted small">Day 0, the date you pick</span> : top ? <span className="muted small">Set when the project is made</span> : <>
                  <select className="plain-select" value={a} onChange={e => set(path, {anchor: e.target.value as Step['anchor'], offset: n.offset ?? 0})}>
                    <option value="start">Days after parent starts</option>
                    <option value="after">After the step above</option>
                    <option value="none">No date</option>
                  </select>
                  {a !== 'none' && <input className="inline num tiny" type="number" value={n.offset ?? 0} title={a === 'after' ? 'Gap in days after the step above is due' : 'Days after the parent starts'}
                    onChange={e => set(path, {offset: Math.round(Number(e.target.value) || 0)})} />}
                </>}
              </span>
              <span className="tpl-when">
                {(!top) && <><input className="inline num tiny" type="number" min={0} value={n.days ?? ''} placeholder="-" title="Days from start to due. Empty: a single due date"
                  onChange={e => set(path, {days: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value)))})} /><span className="muted small">d</span></>}
                {d && <span className="tpl-day" title="Relative to the day you pick when using the template">day {d[0]}{d[1] !== d[0] ? `-${d[1]}` : ''}</span>}
              </span>
              <select className="plain-select" value={repeatKey(n.recur)} onChange={e => e.target.value !== 'custom' && set(path, {recur: REPEATS.find(r => r[0] === e.target.value)?.[2] ?? null})}>
                {REPEATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                {repeatKey(n.recur) === 'custom' && <option value="custom">Custom</option>}
              </select>
              <span className="tpl-actions">
                <button className="icon" title="Add a substep" onClick={() => edit([...path, (n.children ?? []).length], s => s.push(blank()))}><Plus size={13} /></button>
                {!isRoot && <>
                  <button className="icon" title="Move up" disabled={path[path.length - 1] === 0} onClick={() => edit(path, (s, i) => { [s[i - 1], s[i]] = [s[i], s[i - 1]]; })}><ArrowUp size={13} /></button>
                  <button className="icon" title="Move down" disabled={last} onClick={() => edit(path, (s, i) => { if (i < s.length - 1) [s[i + 1], s[i]] = [s[i], s[i + 1]]; })}><ArrowDown size={13} /></button>
                  <button className="icon" title="Make it a substep of the step above" disabled={path[path.length - 1] === 0} onClick={() => edit(path, (s, i) => { const [x] = s.splice(i, 1); s[i - 1].children = [...(s[i - 1].children ?? []), x]; })}><ArrowRight size={13} /></button>
                  <button className="icon" title="Move it out one level" disabled={path.length < (hideRoot ? 2 : 2)} onClick={() => {
                    const copy = structuredClone(root) as Step;
                    let grand = copy; for (const k of path.slice(0, -2)) grand = grand.children![k];
                    const parent = grand.children![path[path.length - 2]];
                    const [x] = parent.children!.splice(path[path.length - 1], 1);
                    grand.children!.splice(path[path.length - 2] + 1, 0, x);
                    onChange(copy);
                  }}><ArrowLeft size={13} /></button>
                  <button className="icon" title="Delete this step and its substeps" onClick={() => edit(path, (s, i) => { s.splice(i, 1); })}><Trash2 size={13} /></button>
                </>}
              </span>
            </div>
            {expanded && <div className="tpl-more" style={{paddingLeft: 30 + depth * 18}}>
              <textarea className="comment-box" placeholder="Description, instructions, checklists, links. AI workers read this." value={n.body ?? ''} onChange={e => set(path, {body: e.target.value})} />
              <input className="inline" placeholder="Tags, comma separated" value={(n.tags ?? []).join(', ')} onChange={e => set(path, {tags: e.target.value.split(',').map(x => x.trim()).filter(Boolean)})} />
            </div>}
          </div>
        );
      })}
      <button className="btn ghost small" style={{marginTop: 6}} onClick={() => edit([(root.children ?? []).length], s => s.push(blank()))}><Plus size={12} /> Add {hideRoot ? 'an item' : 'a step'}</button>
    </div>
  );
}

export function TemplateEditor({store, id}: {store: Store; id: string}) {
  const [t, setT] = useState<Template | null>(null);
  const [name, setName] = useState('');
  const [data, setData] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { api<Template>(`/templates/${id}`).then(x => { setT(x); setName(x.name); setData(x.data); setDirty(false); }).catch(e => setMsg(String(e instanceof Error ? e.message : e))); }, [id]);
  useEffect(() => {
    if (!dirty) return;
    const here = location.hash;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    const leave = () => { if (location.hash !== here && !confirm('Leave without saving your template changes?')) history.pushState(null, '', here); };
    addEventListener('beforeunload', warn); addEventListener('hashchange', leave);
    return () => { removeEventListener('beforeunload', warn); removeEventListener('hashchange', leave); };
  }, [dirty]);
  const types = useMemo(() => [...new Set(store.projects.flatMap(p => p.types))], [store.projects]);
  if (!t) return msg ? <Empty title="Template not found">{msg}</Empty> : null;
  const change = (d: unknown) => { setData(d); setDirty(true); setMsg(''); };
  const save = async () => {
    try { const x = await api<Template>(`/templates/${id}`, {method: 'PATCH', body: {name, data}}); setT(x); setDirty(false); setMsg('Saved.'); }
    catch (e) { setMsg(String(e instanceof Error ? e.message : e)); }
  };
  const back = () => { if (!dirty || confirm('Leave without saving your changes?')) location.hash = '/templates'; };
  const pd = data as ProjectData;
  return (
    <div className="page" style={{maxWidth: 1200}}>
      <div className="toolbar" style={{padding: '0 0 10px', border: 0}}>
        <button className="btn ghost" onClick={back}><ArrowLeft size={14} /> Templates</button>
        <span className="tag">{t.kind === 'project' ? 'Project template' : t.kind === 'view' ? 'View template' : 'Task template'}</span>
        <span className="spacer" />
        {msg && <span className={'small' + (msg === 'Saved.' ? ' muted' : '')} style={msg === 'Saved.' ? {} : {color: 'var(--danger)'}}>{msg}</span>}
        <button className="btn primary" disabled={!dirty} onClick={save}><Save size={14} /> Save</button>
      </div>
      <input className="inline tpl-name" value={name} onChange={e => { setName(e.target.value); setDirty(true); }} placeholder="Template name" />
      {t.kind === 'view' ? <ViewTemplateForm data={data as {name: string; kind: string; config?: Record<string, unknown>}} onChange={change} /> : t.kind === 'item' ? <>
        <p className="muted small">The first row is what gets created; the rows under it become its subitems. Pick a start or due date when you use it and every step's date follows.
          Steps set to <b>Days after parent starts</b> move when the parent moves. Steps set to <b>After the step above</b> slide when that step runs late. <b>No date</b> stays as you set it.</p>
        <StepTree root={data as Step} onChange={change} types={types} />
      </> : <ProjectTemplateForm data={pd} onChange={change} types={types} />}
    </div>
  );
}

function ProjectTemplateForm({data, onChange, types}: {data: ProjectData; onChange: (d: ProjectData) => void; types: string[]}) {
  const up = (patch: Partial<ProjectData>) => onChange({...data, ...patch});
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'status';
  const uniqueId = (base: string, list: Status[], self: string) => { let v = 'new-' + base, n = 2; while (list.some(s => s.id === v && s.id !== self)) v = `new-${base}-${n++}`; return v; };
  const addStatus = () => { let id = 'new', n = 2; while (data.statuses.some(s => s.id === id)) id = `new-${n++}`; up({statuses: [...data.statuses, {id, name: 'New status', category: 'doing', color: '#8b8b8b'}]}); };
  const move = <T,>(list: T[], i: number, d: number) => { const l = [...list]; const j = i + d; if (j < 0 || j >= l.length) return l; [l[i], l[j]] = [l[j], l[i]]; return l; };
  return <>
    <p className="muted small">Everything a new project starts with. Use it from the sidebar + or the Templates page.</p>
    <div className="tpl-grid">
      <div className="chart-card">
        <h4>Levels, top first</h4>
        <p className="muted small">The hierarchy, like Initiative, Workstream, Task, Subtask.</p>
        {data.types.map((ty, i) => <div key={i} className="tpl-line">
          <input className="inline" value={ty} onChange={e => up({types: data.types.map((x, k) => k === i ? e.target.value : x)})} />
          <button className="icon" title="Move up" onClick={() => up({types: move(data.types, i, -1)})}><ArrowUp size={13} /></button>
          <button className="icon" title="Remove" disabled={data.types.length < 2} onClick={() => up({types: data.types.filter((_, k) => k !== i)})}><Trash2 size={13} /></button>
        </div>)}
        <button className="btn ghost small" onClick={() => up({types: [...data.types, 'New level']})}><Plus size={12} /> Add level</button>
      </div>
      <div className="chart-card">
        <h4>Statuses (board columns)</h4>
        <p className="muted small">Done statuses count as finished.</p>
        {data.statuses.map((s, i) => <div key={s.id} className="tpl-line">
          <input type="color" value={s.color} onChange={e => up({statuses: data.statuses.map((x, k) => k === i ? {...x, color: e.target.value} : x)})} />
          <input className="inline" value={s.name} onChange={e => up({statuses: data.statuses.map((x, k) => k === i ? {...x, name: e.target.value, id: x.id.startsWith('new') ? uniqueId(slug(e.target.value), data.statuses, x.id) : x.id} : x)})} />
          <select className="plain-select" value={s.category} onChange={e => up({statuses: data.statuses.map((x, k) => k === i ? {...x, category: e.target.value as Status['category']} : x)})}>
            <option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option>
          </select>
          <button className="icon" title="Move up" onClick={() => up({statuses: move(data.statuses, i, -1)})}><ArrowUp size={13} /></button>
          <button className="icon" title="Remove" disabled={data.statuses.length < 2} onClick={() => up({statuses: data.statuses.filter((_, k) => k !== i)})}><Trash2 size={13} /></button>
        </div>)}
        <button className="btn ghost small" onClick={addStatus}><Plus size={12} /> Add status</button>
      </div>
      <div className="chart-card">
        <h4>Views</h4>
        <p className="muted small">The tabs the project opens with.</p>
        {data.views.map((v, i) => <div key={i} className="tpl-line">
          <input className="inline" value={v.name} onChange={e => up({views: data.views.map((x, k) => k === i ? {...x, name: e.target.value} : x)})} />
          <select className="plain-select" value={v.kind} onChange={e => up({views: data.views.map((x, k) => k === i ? {...x, kind: e.target.value, config: {}} : x)})}>
            {VIEW_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="icon" title="Move up" onClick={() => up({views: move(data.views, i, -1)})}><ArrowUp size={13} /></button>
          <button className="icon" title="Remove" onClick={() => up({views: data.views.filter((_, k) => k !== i)})}><Trash2 size={13} /></button>
        </div>)}
        <button className="btn ghost small" onClick={() => up({views: [...data.views, {name: 'Board', kind: 'board', config: {}}]})}><Plus size={12} /> Add view</button>
      </div>
    </div>
    <h3>Starting items <span className="count">{data.items?.length ?? 0}</span></h3>
    <p className="muted small">Work every new project begins with, with substeps and timing.</p>
    <StepTree root={{title: '', children: data.items ?? []}} hideRoot types={data.types.length ? data.types : types} onChange={r => up({items: r.children ?? []})} />
  </>;
}

/** Counts for a template list row. */
export function stepCount(d: unknown): number {
  const n = d as Step | null;
  return n ? 1 + (n.children ?? []).reduce((a, c) => a + stepCount(c), 0) : 0;
}

/** A view template: the view's name and layout; its filters, sort, grouping and columns come from the saved view. */
function ViewTemplateForm({data, onChange}: {data: {name: string; kind: string; config?: Record<string, unknown>}; onChange: (d: unknown) => void}) {
  const keys = Object.keys(data.config ?? {}).filter(k => data.config![k] !== undefined);
  return (
    <div className="chart-card" style={{maxWidth: 520}}>
      <div className="tpl-line"><span style={{width: 110}}>View name</span><input className="inline" value={data.name} onChange={e => onChange({...data, name: e.target.value})} /></div>
      <div className="tpl-line"><span style={{width: 110}}>Layout</span>
        <select className="plain-select" value={data.kind} onChange={e => onChange({...data, kind: e.target.value})}>{VIEW_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <p className="muted small">Saved settings: {keys.length ? keys.join(', ') : 'none'}. To change filters or columns, adjust a view in a project and save it as a template again.</p>
    </div>
  );
}
