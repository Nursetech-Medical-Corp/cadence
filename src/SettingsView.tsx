import {useState} from 'react';
import {kindIcon} from './Fields.tsx';
import {IconKit, RollupCard} from './ProjectNav.tsx';
import {Calendar, CheckSquare, GripVertical, Hash, Link, List, Plus, Trash2, Type, Users, X} from 'lucide-react';
import type {FieldKind, Project, Status, StatusCategory} from './types.ts';
import type {Store} from './store.ts';
import {InlineText, Popover, StatusIcon, TypeBadge} from './components.tsx';
import {AddField} from './TableView.tsx';
import {AccessCard} from './Team.tsx';
import {WorkflowCard} from './Approvals.tsx';
import {AutomationsCard, InheritCard, IntegrationsCard, TagsCard, TemplatesCard, useTemplates} from './SettingsExtras.tsx';

const COLORS = ['#8b8d98', '#2f80ed', '#0ea5e9', '#14b8a6', '#30a46c', '#e2a400', '#f76b15', '#e5484d', '#d6336c', '#a855f7', '#6d5dfc', '#495057'];
const CATS: {id: StatusCategory; label: string; hint: string}[] = [
  {id: 'todo', label: 'Not started', hint: 'Backlog, New, To do'},
  {id: 'doing', label: 'Active', hint: 'In progress, Review, Blocked'},
  {id: 'done', label: 'Done', hint: 'Checks the item off, counts as complete'},
];
const FIELD_ICONS: Partial<Record<FieldKind, typeof Type>> = {text: Type, number: Hash, select: List, multi: List, date: Calendar, checkbox: CheckSquare, person: Users, url: Link};

export function SettingsView({store, project, onDeleted}: {store: Store; project: Project; onDeleted: () => void}) {
  const [newStatus, setNewStatus] = useState('');
  const [newType, setNewType] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  const [templates, reloadTemplates] = useTemplates(store);
  const save = (patch: Partial<Project>) => store.updateProject(project.id, patch);
  const setStatus = (id: string, patch: Partial<Status>) => save({statuses: project.statuses.map(s => s.id === id ? {...s, ...patch} : s)});
  const items = [...store.items.values()].filter(i => i.projectId === project.id);
  const count = (sid: string) => items.filter(i => i.status === sid).length;
  const addStatus = () => {
    if (!newStatus.trim()) return;
    const id = newStatus.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36).slice(-3);
    const doneIdx = project.statuses.findIndex(s => s.category === 'done');
    const s = [...project.statuses];
    s.splice(doneIdx < 0 ? s.length : doneIdx, 0, {id, name: newStatus.trim(), category: 'doing', color: '#0ea5e9'});
    save({statuses: s}); setNewStatus('');
  };

  return (
    <div className="page settings">
      <div className="set-hero">
        <IconKit store={store} project={project} index={store.projects.indexOf(project)} big />
        <div className="grow">
          <InlineText value={project.name} onSave={name => save({name})} className="h2" />
          <div className="muted small" style={{paddingLeft: 6}}>{items.length} items, {items.filter(i => !i.completed).length} open, {store.sprints.filter(s => s.projectId === project.id).length} sprints, {store.views.filter(v => v.projectId === project.id).length} views</div>
        </div>
        <label className="key-field">Key<InlineText value={project.key} onSave={key => save({key: key.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || project.key})} /></label>
      </div>

      {project.settings.rollup && <RollupCard store={store} project={project} />}
      <section className="set-card">
        <div className="set-card-head"><h3>Statuses</h3><span className="muted small">Drag to reorder. Order sets the board columns. The group decides what counts as done.</span></div>
        {project.statuses.map((s, idx) => (
          <div key={s.id} className={'set-item' + (drag === idx ? ' dragging' : '')} draggable
            onDragStart={e => { if ((e.target as HTMLElement).closest('input')) { e.preventDefault(); return; } setDrag(idx); }} onDragEnd={() => setDrag(null)}
            onDragOver={e => e.preventDefault()}
            onDrop={() => { if (drag === null || drag === idx) return; const list = [...project.statuses]; const [m] = list.splice(drag, 1); list.splice(idx, 0, m); save({statuses: list}); setDrag(null); }}>
            <GripVertical size={14} className="muted grip" />
            <ColorDot color={s.color} onPick={color => setStatus(s.id, {color})} />
            <StatusIcon status={s} />
            <InlineText value={s.name} onSave={name => setStatus(s.id, {name})} />
            <div className="seg small-seg">
              {CATS.map(c => <button key={c.id} className={s.category === c.id ? 'on' : ''} title={c.hint} onClick={() => setStatus(s.id, {category: c.id})}>{c.label}</button>)}
            </div>
            <span className="count" title="Items in this status">{count(s.id)}</span>
            <button className="icon" disabled={count(s.id) > 0 || project.statuses.length < 2} title={count(s.id) ? 'Move items out of this status first' : 'Remove status'}
              onClick={() => save({statuses: project.statuses.filter(x => x.id !== s.id)})}><Trash2 size={14} /></button>
          </div>
        ))}
        <div className="set-add"><Plus size={14} className="muted" /><input className="inline" placeholder="Add status, e.g. Blocked or QA. Enter to add" value={newStatus} onChange={e => setNewStatus(e.target.value)} onKeyDown={e => e.key === 'Enter' && addStatus()} /></div>
      </section>

      <section className="set-card">
        <div className="set-card-head"><h3>Item types</h3><span className="muted small">Top to bottom is the hierarchy used by the Backlog levels, like Azure: Epic, Feature, Story, Task.</span></div>
        {project.types.map((t, idx) => (
          <div key={t} className="set-item">
            <span className="muted small" style={{width: 18}}>{idx + 1}</span>
            <TypeBadge type={t} />
            <InlineText value={t} onSave={name => {
              if (!name || project.types.includes(name)) return;
              save({types: project.types.map(x => x === t ? name : x)});
              for (const i of items.filter(i => i.type === t)) store.updateItem(i.id, {type: name}, false);
            }} />
            <span className="count">{items.filter(i => i.type === t).length}</span>
            <button className="icon" disabled={idx === 0} title="Move up" onClick={() => { const l = [...project.types]; [l[idx - 1], l[idx]] = [l[idx], l[idx - 1]]; save({types: l}); }}>{'↑'}</button>
            <button className="icon" disabled={idx === project.types.length - 1} title="Move down" onClick={() => { const l = [...project.types]; [l[idx + 1], l[idx]] = [l[idx], l[idx + 1]]; save({types: l}); }}>{'↓'}</button>
            <button className="icon" disabled={project.types.length < 2 || items.some(i => i.type === t)} title={items.some(i => i.type === t) ? 'Change those items to another type first' : 'Remove type'} onClick={() => save({types: project.types.filter(x => x !== t)})}><Trash2 size={14} /></button>
          </div>
        ))}
        <div className="set-add"><Plus size={14} className="muted" /><input className="inline" placeholder="Add type, e.g. Sub-epic, Issue, Spike. Enter to add" value={newType} onChange={e => setNewType(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && newType.trim() && !project.types.includes(newType.trim())) { save({types: [...project.types, newType.trim()]}); setNewType(''); } }} /></div>
      </section>

      <section className="set-card">
        <div className="set-card-head"><h3>Custom fields</h3><span className="muted small">Show them as table columns and in the item panel.</span></div>
        {project.fields.map(f => {
          const Icon = FIELD_ICONS[f.kind] ?? kindIcon(f.kind);
          return (
            <div key={f.id} className="set-item">
              <Icon size={15} className="muted" />
              <InlineText value={f.name} onSave={name => name && save({fields: project.fields.map(x => x.id === f.id ? {...x, name} : x)})} />
              <span className="tag">{f.kind}</span>
              {(f.kind === 'select' || f.kind === 'multi') && <span className="chips" style={{margin: 0}}>
                {(f.options ?? []).map(o => <span key={o} className="tag">{o}<button className="icon" style={{padding: 0}} title="Remove option" onClick={() => save({fields: project.fields.map(x => x.id === f.id ? {...x, options: x.options?.filter(y => y !== o)} : x)})}><X size={11} /></button></span>)}
                <input className="inline" style={{width: 110}} placeholder="+ option" onKeyDown={e => { const v = (e.target as HTMLInputElement).value.trim(); if (e.key === 'Enter' && v) { save({fields: project.fields.map(x => x.id === f.id ? {...x, options: [...(x.options ?? []), v]} : x)}); (e.target as HTMLInputElement).value = ''; } }} />
              </span>}
              <span className="spacer" />
              <button className="icon" title="Delete field" onClick={() => confirm(`Delete field "${f.name}"? Values stay on items but are hidden.`) && save({fields: project.fields.filter(x => x.id !== f.id)})}><Trash2 size={14} /></button>
            </div>
          );
        })}
        {!project.fields.length && <div className="muted small" style={{padding: '4px 2px 8px'}}>No custom fields yet.</div>}
        <div className="set-inline-add"><AddField store={store} project={project} /></div>
      </section>

      <AccessCard store={store} project={project} />
      <TagsCard store={store} project={project} />
      <InheritCard store={store} project={project} />
      <WorkflowCard store={store} project={project} />
      <AutomationsCard store={store} project={project} templates={templates} />
      <TemplatesCard store={store} project={project} templates={templates} reload={reloadTemplates} />
      <IntegrationsCard store={store} project={project} />

      <section className="set-card danger-card">
        <div className="set-card-head"><h3>Delete project</h3><span className="muted small">Removes the project, its items, sprints and views. A backup snapshot is kept in Data and backups.</span></div>
        <button className="btn danger" onClick={() => { if (confirm(`Delete project "${project.name}" and all its items? This cannot be undone here, but automatic snapshots keep older copies.`)) { store.deleteProject(project.id); onDeleted(); } }}><Trash2 size={14} /> Delete project</button>
      </section>
    </div>
  );
}

function ColorDot({color, onPick}: {color: string; onPick: (c: string) => void}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="picker">
      <button className="color-dot" style={{background: color}} title="Change color" onClick={() => setOpen(o => !o)} />
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="swatches" style={{padding: 6, width: 196}}>{COLORS.map(c => <button key={c} className={'swatch' + (c === color ? ' on' : '')} style={{background: c}} onClick={() => { onPick(c); setOpen(false); }} />)}</div>
      </Popover>
    </span>
  );
}
