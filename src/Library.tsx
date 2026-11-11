// Templates (gallery, yours, export and import of packs) and Routines (all repeating work in one place).
import {useEffect, useMemo, useRef, useState} from 'react';
import {Bot, Copy, Download, LayoutTemplate, Pencil, Plus, Repeat, Trash2, Upload, User} from 'lucide-react';
import type {Item, Template} from './types.ts';
import {api, type Store, realProjects, validProject} from './store.ts';
import {Avatar, Empty, Popover, itemKey} from './components.tsx';
import {stepCount} from './TemplateEditor.tsx';
import {describeRecur} from './recur.ts';
import {useTemplates} from './SettingsExtras.tsx';

type GalleryPack = {name: string; description: string; templates: {name: string; steps: number; repeats: boolean}[]; automations: number};

export function TemplatesPage({store, open}: {store: Store; open: (id: string) => void}) {
  const [gallery, setGallery] = useState<GalleryPack[]>([]);
  const [mine, reload] = useTemplates(store);
  const [msg, setMsg] = useState('');
  const [pick, setPick] = useState<Set<string>>(new Set());
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { api<GalleryPack[]>('/packs/gallery').then(setGallery).catch(() => {}); }, []);
  const err = (e: unknown) => setMsg(String(e instanceof Error ? e.message : e));
  const install = async (body: object, label: string) => {
    try { const r = await api<{installed: number}>('/packs/install', {method: 'POST', body}); setMsg(`${label}: ${r.installed} templates added. Edit them below.`); reload(); }
    catch (e) { err(e); }
  };
  const edit = (t: {id: string}) => { location.hash = `/templates/${t.id}`; };
  const create = async (kind: 'item' | 'project') => {
    try { edit(await api<Template>('/templates', {method: 'POST', body: {kind, blank: true, name: kind === 'project' ? 'New project template' : 'New template'}})); } catch (e) { err(e); }
  };
  const saveProject = async (pid: string) => {
    const p = store.projects.find(x => x.id === pid);
    if (!p) return;
    const withItems = confirm(`Include the items in ${p.name} as starting items?\n\nOK: setup and items. Cancel: setup only (levels, statuses, views).`);
    try { edit(await api<Template>('/templates', {method: 'POST', body: {kind: 'project', projectId: pid, name: `${p.name} setup`, includeItems: withItems}})); } catch (e) { err(e); }
  };
  const exportPick = async () => {
    const name = prompt('Pack name', 'Our templates');
    if (!name) return;
    const pack = await api('/packs/export', {method: 'POST', body: {ids: [...pick], name}});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], {type: 'application/json'}));
    a.download = `${name.replace(/[^\w-]+/g, '-')}.tasks-pack.json`; a.click();
  };
  const items = mine.filter(t => t.kind === 'item'), projects = mine.filter(t => t.kind === 'project');
  const isRepeat = (t: Template) => !!(t.data as {recur?: unknown})?.recur;
  const workerSummary = (t: Template) => {
    const count = {ai: 0, human: 0};
    const walk = (n: {worker?: string; fields?: {worker?: string}; children?: unknown[]}) => { const w = n.worker ?? n.fields?.worker; if (w === 'ai') count.ai++; if (w === 'human') count.human++; (n.children as typeof n[] ?? []).forEach(walk); };
    walk(t.data as never);
    return count;
  };
  const row = (t: Template) => {
    const w = t.kind === 'item' ? workerSummary(t) : {ai: 0, human: 0}, d = t.data as {days?: number | null; type?: string; items?: unknown[]; statuses?: unknown[]};
    return (
      <div key={t.id} className="row tpl-list-row">
        {t.kind === 'item' && <input type="checkbox" checked={pick.has(t.id)} onChange={() => setPick(s => { const n = new Set(s); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })} title="Select for export" />}
        {isRepeat(t) ? <Repeat size={14} className="muted" /> : <LayoutTemplate size={14} className="muted" />}
        <div className="grow tpl-name-cell">
          <button className="link-btn" onClick={() => edit(t)} title="Edit">{t.name}</button>
          <div className="muted small">{t.kind === 'item' ? `${d.type ?? 'Task'}, ${stepCount(t.data) - 1} steps${d.days ? `, ${d.days} days` : ''}` : `${d.statuses?.length ?? 0} statuses, ${d.items?.length ?? 0} starting items`}
            {t.projectId && store.projects.some(p => p.id === t.projectId) ? `, from ${store.projects.find(p => p.id === t.projectId)!.name}` : ''}</div>
        </div>
        <span className="tpl-tags">
          {w.ai > 0 && <span className="tag"><Bot size={11} /> {w.ai} AI</span>}
          {w.human > 0 && <span className="tag"><User size={11} /> {w.human} human</span>}
        </span>
        <span className="tpl-row-actions">
        <UseTemplate t={t} store={store} open={open} onError={err} />
        <button className="btn small" onClick={() => edit(t)}><Pencil size={12} /> Edit</button>
        <button className="icon" title="Duplicate" onClick={async () => { try { edit(await api<Template>(`/templates/${t.id}/duplicate`, {method: 'POST', body: {}})); } catch (e) { err(e); } }}><Copy size={14} /></button>
        <button className="icon" title="Delete template" onClick={async () => { if (confirm(`Delete template "${t.name}"? Items made from it stay.`)) { try { await api(`/templates/${t.id}`, {method: 'DELETE'}); reload(); } catch (e) { err(e); } } }}><Trash2 size={14} /></button>
        </span>
      </div>
    );
  };
  return (
    <div className="page" style={{maxWidth: 1100}}>
      <h1><LayoutTemplate size={20} /> Templates</h1>
      <p className="muted">Build once, reuse forever. <b>Task templates</b> are any level of work with its steps: a single task, a vendor onboarding workstream, a whole initiative. <b>Project templates</b> are a full board: levels, statuses, views and starting items.
        Dates are relative, so steps land on the right days from whatever start you pick. AI agents can read, write and use templates through MCP (get_template, create_template, update_template, use_template) or the API.</p>
      <div className="toolbar" style={{padding: '0 0 12px', border: 0, flexWrap: 'wrap'}}>
        <button className="btn primary" onClick={() => create('item')}><Plus size={14} /> New task template</button>
        <button className="btn" onClick={() => create('project')}><Plus size={14} /> New project template</button>
        <select className="plain-select" value="" onChange={e => saveProject(e.target.value)}>
          <option value="">Save a project as a template...</option>{realProjects(store.projects).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="spacer" />
        <button className="btn" onClick={() => file.current?.click()}><Upload size={14} /> Import pack</button>
        <input ref={file} type="file" hidden accept=".json,application/json" onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { await install({pack: JSON.parse(await f.text())}, f.name); } catch { setMsg('That file is not a template pack.'); } }} />
        <button className="btn" disabled={!pick.size} onClick={exportPick}><Download size={14} /> Export {pick.size || ''} selected</button>
      </div>
      {msg && <p className="small">{msg}</p>}

      <h3>Task templates <span className="count">{items.length}</span></h3>
      {items.map(row)}
      {!items.length && <Empty title="No task templates yet">Press New task template, add one from the gallery, or open any item and press the template icon to save it with its subitems.</Empty>}

      <h3 style={{marginTop: 24}}>Project templates <span className="count">{projects.length}</span></h3>
      {projects.map(row)}
      {!projects.length && <p className="muted small">None yet. Press New project template, or save an existing project's setup.</p>}

      <h3 style={{marginTop: 24}}>Gallery</h3>
      <div className="gallery">
        {gallery.map(g => (
          <div key={g.name} className="chart-card gal-card">
            <b>{g.name}</b>
            <div className="muted small">{g.description}</div>
            <div className="small" style={{margin: '6px 0'}}>{g.templates.map(t => <div key={t.name}>{t.repeats ? <Repeat size={11} /> : <LayoutTemplate size={11} />} {t.name}{t.steps > 1 ? `, ${t.steps - 1} steps` : ''}</div>)}</div>
            <button className="btn primary small" onClick={() => install({gallery: g.name}, g.name)}><Plus size={12} /> Add to my templates</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Use a template: name, where it goes, and a start or due date. */
function UseTemplate({t, store, open, onError}: {t: Template; store: Store; open: (id: string) => void; onError: (e: unknown) => void}) {
  const [show, setShow] = useState(false);
  const [project, setProject] = useState(validProject(store, t.projectId) ?? realProjects(store.projects)[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState<'start' | 'due'>('start');
  const [date, setDate] = useState(store.today);
  const go = async () => {
    try {
      if (t.kind === 'project') {
        const p = await api<{id: string}>(`/templates/${t.id}/use`, {method: 'POST', body: {name: title || t.name}});
        setShow(false); location.hash = `/p/${p.id}/`; return;
      }
      const it = await api<{id: string}>(`/templates/${t.id}/use`, {method: 'POST', body: {projectId: project, title: title || undefined, [when]: date || undefined}});
      setShow(false); open(it.id);
    } catch (e) { onError(e); }
  };
  return (
    <span className="picker">
      <button className="btn small primary" onClick={() => setShow(s => !s)}>Use</button>
      <Popover open={show} onClose={() => setShow(false)} className="wide">
        <div className="use-tpl">
          <div className="pop-label">{t.kind === 'project' ? 'New project name' : 'Name (fills {name} in the title)'}</div>
          <input className="inline" autoFocus value={title} placeholder={t.name} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
          {t.kind === 'item' && <>
            <div className="pop-label">Project</div>
            <select className="plain-select" value={project} onChange={e => setProject(e.target.value)}>{realProjects(store.projects).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <div className="pop-label">Dates</div>
            <div className="seg"><button className={when === 'start' ? 'on' : ''} onClick={() => setWhen('start')}>Starts on</button><button className={when === 'due' ? 'on' : ''} onClick={() => setWhen('due')}>Due by</button></div>
            <input className="inline" type="date" value={date} onChange={e => setDate(e.target.value)} />
            <div className="muted small">Steps get their dates from this. Clear it for no dates.</div>
          </>}
          <button className="btn primary" style={{marginTop: 8}} onClick={go}>Create</button>
        </div>
      </Popover>
    </span>
  );
}

// Months between repeats, so every rule lands in exactly one group.
const months = (i: Item) => { const r = i.recur!; return r.unit === 'year' ? r.every * 12 : r.unit === 'month' ? r.every : r.unit === 'week' ? r.every / 4.35 : r.every / 30; };
const CADENCE: [string, (i: Item) => boolean][] = [
  ['Daily', i => i.recur!.unit === 'day'],
  ['Weekly', i => i.recur!.unit === 'week' && i.recur!.every <= 2],
  ['Monthly', i => i.recur!.unit !== 'day' && !(i.recur!.unit === 'week' && i.recur!.every <= 2) && months(i) < 3],
  ['Quarterly', i => months(i) >= 3 && months(i) < 6],
  ['Twice a year', i => months(i) >= 6 && months(i) < 12],
  ['Yearly', i => months(i) >= 12 && months(i) < 24],
  ['Every few years', i => months(i) >= 24],
];

/** Every repeating item across projects, grouped by how often it comes back. */
export function RoutinesPage({store, open}: {store: Store; open: (id: string) => void}) {
  const routines = useMemo(() => [...store.items.values()].filter(i => i.recur && !i.completed).sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9')), [store.items]);
  const [templates] = useTemplates(store);
  const [project, setProject] = useState(realProjects(store.projects)[0]?.id ?? '');
  const repeatTemplates = templates.filter(t => t.kind === 'item' && (t.data as {recur?: unknown}).recur);
  const add = async (t: Template) => {
    const due = prompt(`First due date for "${t.name}" (YYYY-MM-DD)`, store.today);
    if (due === null) return;
    try { const it = await api<Item>(`/templates/${t.id}/use`, {method: 'POST', body: {projectId: project, due: due || undefined}}); open(it.id); } catch (e) { store.fail(e); }
  };
  return (
    <div className="page" style={{maxWidth: 1100}}>
      <h1><Repeat size={20} /> Routines</h1>
      <p className="muted">Repeating work across all projects: filings, reviews, payments, reorders, follow-ups. Finish one and the next appears on schedule. Open any routine to change how often it repeats, who does it, or when it ends.</p>
      {CADENCE.map(([label, test]) => {
        const list = routines.filter(test);
        if (!list.length) return null;
        return <section key={label}><h3>{label} <span className="count">{list.length}</span></h3>
          {list.map(i => (
            <div key={i.id} className="row" style={{cursor: 'pointer'}} onClick={() => open(i.id)}>
              {i.fields.worker === 'ai' ? <Bot size={14} className="muted" /> : <User size={14} className="muted" />}
              <span className="grow">{i.title}</span>
              <span className="muted small">{describeRecur(i.recur!, i.due)}</span>
              <span className="muted small">{itemKey(i, store.projects)}</span>
              {i.assignees.slice(0, 2).map(a => <Avatar key={a} person={store.people.find(p => p.id === a)} size={18} />)}
              <span className={'small' + (i.due && i.due < store.today ? ' overdue' : ' muted')}>{i.due ?? 'no date'}</span>
            </div>
          ))}
        </section>;
      })}
      {!routines.length && <Empty title="No routines yet">Add some from below, or open any item and press Make it repeat.</Empty>}
      <h3 style={{marginTop: 28}}>Add a routine from your templates</h3>
      <div className="toolbar" style={{padding: '0 0 8px', border: 0}}>
        <span className="small muted">Into project</span>
        <select className="plain-select" value={project} onChange={e => setProject(e.target.value)}>{realProjects(store.projects).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <a className="btn ghost small" href="#/templates">More in Templates</a>
      </div>
      <div className="chips">{repeatTemplates.map(t => <button key={t.id} className="btn small" onClick={() => add(t)}><Plus size={12} /> {t.name}</button>)}</div>
      {!repeatTemplates.length && <p className="muted small">Install "Business and compliance routines" from Templates to get FDA registration, payroll and sales tax filings, SOP reviews, HR audits, insurance, budget updates, vendor reorders and follow-ups.</p>}
    </div>
  );
}
