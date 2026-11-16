// Sidebar project list: search, favorites, drag to reorder (grip on hover), icon and color kit,
// and the rollup project that shows work from many projects together.
import {projectsFor, saveMode} from './customize.ts';
import {useMemo, useState} from 'react';
import {GripVertical, LayoutTemplate, Layers, MoreHorizontal, Plus, Search, Settings, X, type LucideIcon} from 'lucide-react';
// Only the icons offered in the kit are bundled (importing the whole icon set would add about 1 MB).
import {Rocket, Briefcase, House, Heart, Star, Flag, Target, Megaphone, ShoppingCart, Truck, Package, Wrench, Code, Cpu, Database, Shield, Stethoscope, HeartPulse, Pill, Syringe, FlaskConical, BookOpen, GraduationCap, Users, DollarSign, PiggyBank, Scale, Gavel, FileText, ClipboardList, Calendar, Camera, Music, Palette, Plane, Leaf, Lightbulb, Zap, Globe, Bot, Sparkles, Coffee} from 'lucide-react';
import type {Project} from './types.ts';
import {api, wsId, type Store} from './store.ts';
import {Popover} from './components.tsx';

export const PROJECT_COLORS = ['#6d5dfc', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#64748b', '#0f172a'];
const ICON_SET: Record<string, LucideIcon> = {Rocket, Briefcase, House, Heart, Star, Flag, Target, Megaphone, ShoppingCart, Truck, Package, Wrench, Code, Cpu, Database, Shield, Stethoscope, HeartPulse, Pill, Syringe, FlaskConical, BookOpen, GraduationCap, Users, DollarSign, PiggyBank, Scale, Gavel, FileText, ClipboardList, Calendar, Camera, Music, Palette, Plane, Leaf, Lightbulb, Zap, Globe, Bot, Sparkles, Coffee};
const ICONS = ['Rocket', 'Briefcase', 'House', 'Heart', 'Star', 'Flag', 'Target', 'Megaphone', 'ShoppingCart', 'Truck', 'Package', 'Wrench', 'Code', 'Cpu', 'Database',
  'Shield', 'Stethoscope', 'HeartPulse', 'Pill', 'Syringe', 'FlaskConical', 'BookOpen', 'GraduationCap', 'Users', 'DollarSign', 'PiggyBank', 'Scale', 'Gavel', 'FileText',
  'ClipboardList', 'Calendar', 'Camera', 'Music', 'Palette', 'Plane', 'Leaf', 'Lightbulb', 'Zap', 'Globe', 'Bot', 'Sparkles', 'Coffee'] as const;

export const isRollup = (p: Project) => !!p.settings.rollup;

/** A project's mark: its chosen icon (or emoji) on its color, else the first letters of its key. */
export function ProjectIcon({project, index = 0, big}: {project: Project; index?: number; big?: boolean}) {
  const s = project.settings, color = s.color ?? (isRollup(project) ? undefined : PROJECT_COLORS[index % PROJECT_COLORS.length]);
  const Icon = s.icon?.startsWith('lucide:') ? ICON_SET[s.icon.slice(7)] : null;
  const size = big ? 22 : 11;
  return <span className={'proj-icon' + (big ? ' big' : '') + (isRollup(project) && !s.color ? ' rollup' : '')} style={color ? {background: color} : {}}>
    {Icon ? <Icon size={size} /> : isRollup(project) && !s.icon ? <Layers size={size} /> : s.icon && !s.icon.startsWith('lucide:') ? <span className="proj-emoji">{s.icon}</span> : project.key.slice(0, 2)}
  </span>;
}

/** Icon and color picker for a project. Wraps its trigger. */
export function IconKit({store, project, index, big}: {store: Store; project: Project; index: number; big?: boolean}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const set = (patch: {icon?: string; color?: string}) => store.updateProject(project.id, {settings: {...project.settings, ...patch}});
  return (
    <span className="picker" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
      <button className="icon-kit-btn" title="Change icon and color" onClick={() => setOpen(o => !o)}><ProjectIcon project={project} index={index} big={big} /></button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide">
        <div className="pop-label">Color</div>
        <div className="ws-colors">{PROJECT_COLORS.map(c => <button key={c} className={'ws-color' + (project.settings.color === c ? ' on' : '')} style={{background: c}} onClick={() => set({color: c})} />)}</div>
        <div className="pop-label">Icon</div>
        <input className="pop-search" placeholder="Search icons, or type an emoji" value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && q.trim() && !ICONS.some(n => n.toLowerCase().includes(q.toLowerCase()))) { set({icon: [...q.trim()].slice(0, 2).join('')}); setOpen(false); } }} />
        <div className="icon-grid">
          {ICONS.filter(n => n.toLowerCase().includes(q.toLowerCase())).map(n => { const I = ICON_SET[n]; return I &&
            <button key={n} className={'icon-cell' + (project.settings.icon === 'lucide:' + n ? ' on' : '')} title={n} onClick={() => { set({icon: 'lucide:' + n}); setOpen(false); }}><I size={16} /></button>; })}
        </div>
        {q.trim() && !ICONS.some(n => n.toLowerCase().includes(q.toLowerCase())) && <button className="pop-row" onClick={() => { set({icon: [...q.trim()].slice(0, 2).join('')}); setOpen(false); }}>Use "{[...q.trim()].slice(0, 2).join('')}" as the icon</button>}
        <button className="pop-row" onClick={() => { set({icon: undefined, color: undefined}); setOpen(false); }}><X size={13} /> Back to letters</button>
      </Popover>
    </span>
  );
}

const favKey = () => `fav:${wsId()}`;

export function ProjectList({store, activeId, render}: {store: Store; activeId: string | null; render: (p: Project, index: number, extra: {grip: React.ReactNode; star: React.ReactNode; icon: React.ReactNode; menu: React.ReactNode}) => React.ReactNode}) {
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [favs, setFavs] = useState<string[]>(() => JSON.parse(localStorage.getItem(favKey()) ?? '[]'));
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{id: string; after: boolean} | null>(null);
  const ordered = useMemo(() => projectsFor(store), [store.projects, store.prefs, store.settings]);
  const mode = saveMode(store, 'projectOrder');
  const shown = useMemo(() => q ? ordered.filter(p => (p.name + ' ' + p.key).toLowerCase().includes(q.toLowerCase())) : ordered, [ordered, q]);
  const toggleFav = (id: string) => { const n = favs.includes(id) ? favs.filter(x => x !== id) : [...favs, id]; setFavs(n); localStorage.setItem(favKey(), JSON.stringify(n)); };
  const drop = (target: string, after: boolean) => {
    if (!drag || drag === target) return;
    const list = ordered.filter(p => p.id !== drag);
    const at = list.findIndex(p => p.id === target) + (after ? 1 : 0);
    list.splice(at, 0, ordered.find(p => p.id === drag)!);
    if (mode === 'mine') store.setPref('projects', list.map(p => p.id));
    else list.forEach((p, n) => { if (p.sort !== n) store.updateProject(p.id, {sort: n}); });
  };
  const row = (p: Project, fav: boolean) => {
    const n = ordered.indexOf(p);
    const grip = !q && !fav ? <span className="proj-grip" title="Drag to reorder"><GripVertical size={12} /></span> : <span className="proj-grip blank" />;
    const star = <button className={'proj-star' + (favs.includes(p.id) ? ' on' : '')} title={favs.includes(p.id) ? 'Remove from favorites' : 'Add to favorites'} onClick={e => { e.stopPropagation(); toggleFav(p.id); }} onKeyDown={e => e.stopPropagation()}><Star size={12} /></button>;
    const icon = <IconKit store={store} project={p} index={n} />;
    const menu = <ProjectMenu store={store} project={p} />;
    return (
      <div key={(fav ? 'f' : '') + p.id} className={'proj-row' + (drag === p.id ? ' dragging' : '') + (over?.id === p.id ? (over.after ? ' drop-after' : ' drop-before') : '') + (p.id === activeId ? ' current' : '')}
        draggable={!q && !fav} onDragStart={e => { setDrag(p.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDrag(null); setOver(null); }}
        onDragOver={e => { if (!drag || fav) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setOver({id: p.id, after: e.clientY > r.top + Math.min(r.height, 32) / 2}); }}
        onDrop={e => { e.preventDefault(); if (over) drop(over.id, over.after); setDrag(null); setOver(null); }}
        data-sub={!fav && !q && p.settings.parent && store.projects.some(x => x.id === p.settings.parent) ? '1' : undefined}>
        {render(p, n, {grip, star, icon, menu})}
      </div>
    );
  };
  const favList = ordered.filter(p => favs.includes(p.id));
  return <>
    {favList.length > 0 && !q && <><div className="nav-section">Favorites</div>{favList.map(p => row(p, true))}</>}
    {(searching || ordered.length > 8) && <div className="proj-search">
      <Search size={12} /><input placeholder={`Find among ${ordered.length} spaces`} value={q} autoFocus={searching} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && (setQ(''), setSearching(false))} />
      {q && <button className="icon" onClick={() => setQ('')}><X size={12} /></button>}
    </div>}
    {(() => {
      // Shared spaces first, then the ones only you (and people you share with) can see, like Google Drive.
      // Built-in spaces (Routines, Archive and later) are reached from the Workspace section, not listed here.
      // Sub-spaces sit right under their parent (while searching, every match is listed flat).
      const all = shown.filter(p => !p.settings.rollup?.scope);
      const ids = new Set(all.map(p => p.id));
      const rest = q ? all : all.filter(p => !p.settings.parent || !ids.has(p.settings.parent)).flatMap(p => [p, ...all.filter(c => c.settings.parent === p.id)]);
      const priv = rest.filter(p => p.settings.access?.private), team = rest.filter(p => !p.settings.access?.private);
      if (q || !priv.length) return rest.map(p => row(p, false));
      return <>{team.map(p => row(p, false))}<div className="nav-subhead" title="Personal spaces: only you and the people you share them with">Private to me</div>{priv.map(p => row(p, false))}</>;
    })()}
    {q && !shown.length && <div className="muted small" style={{padding: '4px 12px'}}>No space matches.</div>}
    <SearchToggle onClick={() => setSearching(s => !s)} hidden={ordered.length > 8} />
  </>;
}
function SearchToggle({onClick, hidden}: {onClick: () => void; hidden: boolean}) {
  return hidden ? null : <button className="proj-find" onClick={onClick}><Search size={12} /> Find a space</button>;
}

/** Merges the included projects' statuses, levels and fields so the views can show them together. */
export function rollupProject(rollup: Project, included: Project[]): Project {
  const order = {todo: 0, doing: 1, done: 2};
  const statuses = [...new Map([rollup, ...included].flatMap(p => p.statuses).map(s => [s.id, s])).values()].sort((a, b) => order[a.category] - order[b.category]);
  const types = [...new Set([rollup, ...included].flatMap(p => p.types))];
  const fields = [...new Map([rollup, ...included].flatMap(p => p.fields).map(f => [f.id, f])).values()];
  return {...rollup, statuses, types, fields};
}
export {includedIn} from './rollup.ts';

/** Settings card: which projects a rollup shows. */
export function RollupCard({store, project}: {store: Store; project: Project}) {
  const inc = project.settings.rollup!.include;
  const others = store.projects.filter(p => p.id !== project.id && !isRollup(p));
  const set = (include: string[] | null) => store.updateProject(project.id, {settings: {...project.settings, rollup: {include}}});
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Spaces in this rollup</h3><span className="muted small">Every view here shows work from these spaces together. Each item still belongs to its own space.</span></div>
      <label className="row" style={{cursor: 'pointer'}}><input type="checkbox" checked={!inc} onChange={e => set(e.target.checked ? null : others.map(p => p.id))} /> <b>All spaces</b> <span className="muted small">new spaces join automatically</span></label>
      {others.map((p, n) => (
        <label key={p.id} className="row" style={{cursor: 'pointer', opacity: inc ? 1 : .6}}>
          <input type="checkbox" disabled={!inc} checked={!inc || inc.includes(p.id)} onChange={e => set(e.target.checked ? [...(inc ?? []), p.id] : (inc ?? []).filter(x => x !== p.id))} />
          <ProjectIcon project={p} index={store.projects.indexOf(p)} /> {p.name} <span className="muted small">{[...store.items.values()].filter(i => i.projectId === p.id && !i.completed).length} open</span>
        </label>
      ))}
    </section>
  );
}

/** Project ... menu in the sidebar: settings and Save as template (setup only, or with its items). */
function ProjectMenu({store, project}: {store: Store; project: Project}) {
  const [open, setOpen] = useState(false);
  const sub = async (kind: 'tasks' | 'pipeline' | 'contacts') => {
    setOpen(false);
    const name = prompt(kind === 'pipeline' ? 'Name the pipeline (like Investors)' : kind === 'contacts' ? 'Name the list (like Distributors)' : 'Name the sub-space');
    if (!name?.trim()) return;
    try { const p = await api<Project>(`/projects/${project.id}/subspaces`, {method: 'POST', body: {name: name.trim(), kind}}); location.hash = `/p/${p.id}/`; } catch (e) { store.fail(e); }
  };
  const save = async (includeItems: boolean) => {
    setOpen(false);
    try {
      const t = await api<{id: string}>('/templates', {method: 'POST', body: {kind: 'project', projectId: project.id, name: `${project.name}${includeItems ? '' : ' setup'}`, includeItems}});
      location.hash = `/templates/${t.id}`;
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <span className="picker" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
      <button className="proj-more" title="Space options" onClick={() => setOpen(o => !o)} onKeyDown={e => e.stopPropagation()}><MoreHorizontal size={13} /></button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <button className="pop-row" onClick={() => { setOpen(false); location.hash = `/p/${project.id}/settings`; }}><Settings size={14} /> Settings</button>
        {!isRollup(project) && <>
          <div className="pop-sep" />
          {!project.settings.parent && <>
            <div className="pop-label">Add a sub-space</div>
            <button className="pop-row" onClick={() => sub('tasks')} title="A normal space with tasks, shown under this one"><Plus size={14} /> Tasks</button>
            <button className="pop-row" onClick={() => sub('pipeline')} title="Records, not tasks: stages from To contact to Committed, amount, contact columns. Kept out of All spaces and My work"><Target size={14} /> Pipeline (investors, deals)</button>
            <button className="pop-row" onClick={() => sub('contacts')} title="Records, not tasks: people or companies to reach once or a few times. Kept out of All spaces and My work"><Users size={14} /> Contact list (distributors, leads)</button>
            <div className="pop-sep" />
          </>}
          <button className="pop-row" onClick={() => save(false)}><LayoutTemplate size={14} /> Save as template (setup only)</button>
          <button className="pop-row" onClick={() => save(true)}><LayoutTemplate size={14} /> Save as template with its items</button>
        </>}
      </Popover>
    </span>
  );
}

/** Settings card: put this space under another one, and whether its entries are tasks or records (a list). */
export function SubspaceCard({store, project}: {store: Store; project: Project}) {
  const set = (patch: Partial<Project['settings']>) => store.updateProject(project.id, {settings: {...project.settings, ...patch}});
  const hasKids = store.projects.some(p => p.settings.parent === project.id);
  const parents = store.projects.filter(p => p.id !== project.id && !isRollup(p) && !p.settings.parent);
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Sub-space and list</h3><span className="muted small">Put this space under another one in the sidebar. A list space holds records (investors, distributors, leads), not tasks.</span></div>
      <label className="row">Under <select className="plain-select" disabled={hasKids} value={project.settings.parent ?? ''} onChange={e => set({parent: e.target.value || null})} title={hasKids ? 'This space has sub-spaces, so it stays at the top' : ''}>
        <option value="">Top level</option>{parents.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="row" style={{cursor: 'pointer'}}><input type="checkbox" checked={!!project.settings.records} onChange={e => set({records: e.target.checked})} />
        <span>List space: entries are records, not tasks <span className="muted small">(left out of All spaces, My work, the day planner and due reminders; routines and tasks elsewhere can still point at them)</span></span></label>
    </section>
  );
}
