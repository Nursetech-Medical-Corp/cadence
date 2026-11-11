// Small menus for templates: save an item as one, apply parent fields to subitems, create from templates.
import {useState} from 'react';
import {ArrowDownToLine, LayoutTemplate, Plus, Layers} from 'lucide-react';
import type {InheritKey, Item, Project} from './types.ts';
import {api, type Store} from './store.ts';
import {Popover} from './components.tsx';
import {useTemplates} from './SettingsExtras.tsx';

export function SaveTemplateButton({store, item}: {store: Store; item: Item}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(item.title);
  const [saved, setSaved] = useState(false);
  return (
    <span className="picker">
      <button className="icon" title="Save as template" onClick={() => { setName(item.title); setSaved(false); setOpen(o => !o); }}><LayoutTemplate size={16} /></button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide">
        <div className="pop-label">Save as template, with all subitems</div>
        <input autoFocus className="pop-search" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
        <button className="btn primary" onClick={go}>{saved ? 'Saved' : 'Save template'}</button>
      </Popover>
    </span>
  );
  async function go() {
    try { await api('/templates', {method: 'POST', body: {kind: 'item', itemId: item.id, name}}); setSaved(true); setTimeout(() => setOpen(false), 600); } catch (e) { store.fail(e); }
  }
}

export function ApplyToChildrenButton({store, item, project}: {store: Store; item: Item; project: Project}) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<InheritKey[]>(['assignees', 'sprint']);
  const all: [InheritKey, string][] = [['assignees', 'Assignees'], ['sprint', 'Sprint'], ['priority', 'Priority'], ['tags', 'Tags'], ['due', 'Due date'], ['start', 'Start date'],
    ...project.fields.map(f => [`f:${f.id}` as InheritKey, f.name] as [InheritKey, string])];
  return (
    <span className="picker">
      <button className="btn ghost small" onClick={() => setOpen(o => !o)}><ArrowDownToLine size={12} /> Apply to subitems</button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="pop-label">Copy this item's values to every subitem</div>
        {all.map(([k, label]) => (
          <button key={k} className={'pop-row' + (keys.includes(k) ? ' on' : '')} onClick={() => setKeys(x => x.includes(k) ? x.filter(y => y !== k) : [...x, k])}>
            <input type="checkbox" readOnly checked={keys.includes(k)} /> {label}
          </button>
        ))}
        <button className="btn primary" style={{margin: 6}} disabled={!keys.length} onClick={async () => {
          try { await api(`/items/${item.id}/apply-to-children`, {method: 'POST', body: {keys}}); setOpen(false); } catch (e) { store.fail(e); }
        }}>Apply</button>
      </Popover>
    </span>
  );
}

/** "+ New" in the toolbar: blank item or any item template, optionally with a title and due date. */
export function NewFromTemplate({store, project, onCreated}: {store: Store; project: Project; onCreated: (id: string) => void}) {
  const [templates] = useTemplates(store);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const items = templates.filter(t => t.kind === 'item');
  const create = async () => {
    try {
      const it = await api<Item>(`/templates/${pick}/use`, {method: 'POST', body: {projectId: project.id, title: title.trim() || undefined, due: due || undefined}});
      setOpen(false); setPick(null); setTitle(''); setDue('');
      onCreated(it.id);
    } catch (e) { store.fail(e); }
  };
  return (
    <span className="picker">
      <button className="btn primary" onClick={() => setOpen(o => !o)}><Plus size={13} /> New</button>
      <Popover open={open} onClose={() => { setOpen(false); setPick(null); }} className="wide">
        {!pick ? <>
          <button className="pop-row" onClick={async () => { const it = await store.createItem({projectId: project.id, title: 'Untitled'}); setOpen(false); if (it) onCreated(it.id); }}><Plus size={14} /> Blank item</button>
          <div className="pop-label">From a template</div>
          {items.map(t => <button key={t.id} className="pop-row" onClick={() => { setPick(t.id); setTitle(t.name); }}><LayoutTemplate size={14} /> {t.name}</button>)}
          {!items.length && <div className="pop-row muted small">No templates yet. Open any item and press the template icon to save one.</div>}
        </> : <>
          <div className="pop-label">New from "{items.find(t => t.id === pick)?.name}"</div>
          <input autoFocus className="pop-search" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} />
          <label className="pop-row" style={{cursor: 'default'}}>Due <input type="date" className="plain-select" value={due} onChange={e => setDue(e.target.value)} /></label>
          <div className="muted small" style={{padding: '0 8px 6px'}}>Subitems and their relative dates come along.</div>
          <button className="btn primary" style={{margin: 6}} onClick={create}>Create</button>
        </>}
      </Popover>
    </span>
  );
}

/** Sidebar "+": blank project or from a project template. */
export function NewProjectMenu({store, onCreated}: {store: Store; onCreated: (id: string) => void}) {
  const [templates] = useTemplates(store);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [tpl, setTpl] = useState('');
  const [preset, setPreset] = useState(0);
  const create = async () => {
    if (!name.trim()) return;
    try {
      const p = tpl ? await api<Project>(`/templates/${tpl}/use`, {method: 'POST', body: {name}}) : await api<Project>('/projects', {method: 'POST', body: {name, types: LEVELS[preset].types}});
      setOpen(false); setName(''); setTpl('');
      if (p) onCreated(p.id);
    } catch (e) { store.fail(e); }
  };
  return (
    <span className="picker" style={{marginLeft: 'auto'}}>
      <button className="icon" title="New project" onClick={() => setOpen(o => !o)}><Plus size={14} /></button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide">
        <div className="pop-label">New project</div>
        <input autoFocus className="pop-search" placeholder="Project name" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} />
        {!tpl && <>
          <div className="pop-label">Level names (rename any time in Settings)</div>
          <select className="plain-select" style={{width: '100%', marginBottom: 6}} value={preset} onChange={e => setPreset(Number(e.target.value))}>
            {LEVELS.map((l, n) => <option key={l.name} value={n}>{l.name}: {l.types.join(' > ')}</option>)}
          </select>
        </>}
        <button className="pop-row" onClick={async () => { try { const p = await api<Project>('/projects/rollup', {method: 'POST', body: {name: name.trim() || 'Rollup'}}); setOpen(false); setName(''); onCreated(p.id); } catch (e) { store.fail(e); } }}>
          <Layers size={14} /> Or make a rollup: views across chosen projects
        </button>
        <div className="pop-label">Start from</div>
        <select className="plain-select" style={{width: '100%', marginBottom: 6}} value={tpl} onChange={e => setTpl(e.target.value)}>
          <option value="">Blank (default statuses and views)</option>
          {templates.filter(t => t.kind === 'project').map(t => <option key={t.id} value={t.id}>Template: {t.name}</option>)}
        </select>
        <button className="btn primary" disabled={!name.trim()} onClick={create}>Create project</button>
      </Popover>
    </span>
  );
}

/** Naming presets for a new project's levels. Every name can be changed later in Settings > Item types. */
const LEVELS = [
  {name: 'General', types: ['Initiative', 'Workstream', 'Task', 'Subtask']},
  {name: 'Simple', types: ['Project', 'Task', 'Subtask']},
  {name: 'Quality and regulatory', types: ['Program', 'Deliverable', 'Task', 'Subtask', 'Issue']},
  {name: 'Operations', types: ['Area', 'Process', 'Task', 'Subtask']},
  {name: 'Software (Azure style)', types: ['Epic', 'Feature', 'Story', 'Task', 'Bug']},
];
