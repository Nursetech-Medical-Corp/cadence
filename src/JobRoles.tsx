// Team page cards for job roles (company roles that open spaces at a permission level) and company domain join.
// Job roles replace setting access space by space: set it once per job role, then give people job roles.
import {useState} from 'react';
import {Briefcase, ChevronDown, GripVertical, Plus, Trash2} from 'lucide-react';
import type {Project} from './types.ts';
import {api} from './store.ts';
import {Popover} from './components.tsx';

export type JobRole = {id: string; name: string; spaces: Record<string, string>; others: string};
export type DomainJoin = {domains: string[]; level: string; jobRoles: string[]};
type Level = {id: string; name: string};

/** Spaces a job role can open: shared spaces only (personal spaces are the owner's to share; rollups show what you can already see). */
export const jobRoleSpaces = (projects: Project[]) => projects.filter(p => !p.settings.access?.private && !p.settings.rollup);

const levelOptions = (levels: Level[], inherit: string) => <>
  <option value="inherit">{inherit}</option>
  {levels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
  <option value="none">No access</option>
</>;

/** Pick any number of job roles for a person or an invite. */
export function JobRolePicker({all, value, onChange, disabled}: {all: {id: string; name: string}[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean}) {
  const [open, setOpen] = useState(false);
  const label = value.length ? value.map(id => all.find(j => j.id === id)?.name ?? id).join(', ') : 'No job role';
  if (!all.length) return null;
  return <span className="picker">
    <button className="plain-select jr-pick" disabled={disabled} title="Job roles" onClick={() => setOpen(o => !o)}><Briefcase size={12} /> <span className="jr-pick-label">{label}</span> <ChevronDown size={12} /></button>
    <Popover open={open} onClose={() => setOpen(false)}>
      <div className="pop-label">Job roles</div>
      {all.map(j => <label key={j.id} className="pop-row"><input type="checkbox" checked={value.includes(j.id)} onChange={e => onChange(e.target.checked ? [...value, j.id] : value.filter(x => x !== j.id))} /> {j.name}</label>)}
    </Popover>
  </span>;
}

/** Job role names for a person, in the order the job roles are listed. */
export const jobRoleNames = (all: {id: string; name: string}[], ids: string[] = []) => all.filter(j => ids.includes(j.id)).map(j => j.name);

/** The job role matrix: rows are job roles (drag the grip to reorder), columns are shared spaces, each cell a permission level. */
export function JobRolesCard({jobRoles, levels, projects, counts, onSave}: {jobRoles: JobRole[]; levels: Level[]; projects: Project[]; counts: Record<string, number>; onSave: (j: JobRole[]) => Promise<void>}) {
  const [rows, setRows] = useState(jobRoles);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drop = (target: string) => {
    if (!drag || drag === target) return;
    const moving = rows.find(r => r.id === drag)!, rest = rows.filter(r => r.id !== drag);
    const at = rest.findIndex(r => r.id === target);
    save([...rest.slice(0, at), moving, ...rest.slice(at)]);
  };
  const spaces = jobRoleSpaces(projects);
  const save = (next: JobRole[]) => { setRows(next); void onSave(next); };
  const set = (id: string, patch: Partial<JobRole>) => save(rows.map(r => r.id === id ? {...r, ...patch} : r));
  const cell = (r: JobRole, pid: string, v: string) => { const s = {...r.spaces}; if (v === 'inherit') delete s[pid]; else s[pid] = v; set(r.id, {spaces: s}); };
  return (
    <section className="set-card">
      <div className="set-card-head"><h3><Briefcase size={15} /> Job roles</h3><span className="muted small">Drag the grip to reorder. Your company's roles, like Executive, Sales rep, Clinical rep, R&amp;D engineer, Quality, VA or Logistics. Set once here which spaces each one opens and at what level, then give people job roles (People, below) or pick one when you invite. A person with two job roles gets the stronger level. "Default" falls back to the space's own setting, then the person's level. A per-person entry on a space still wins. Admins see every shared space; nobody sees another person's personal space unless it is shared with them.</span></div>
      {rows.length > 0 && <div className="jr-wrap"><table className="jr-table">
        <thead><tr><th /><th>Job role</th>{spaces.map(p => <th key={p.id} title={p.name}>{p.key}</th>)}<th title="Spaces not listed, including new ones">Other spaces</th><th /></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id} className={(drag === r.id ? 'dragging' : '') + (over === r.id && drag && drag !== r.id ? ' drop-here' : '')}
          onDragOver={e => { if (drag) { e.preventDefault(); setOver(r.id); } }} onDragLeave={() => setOver(o => o === r.id ? null : o)} onDrop={e => { e.preventDefault(); drop(r.id); setDrag(null); setOver(null); }}>
          <td className="jr-grip" draggable onDragStart={e => { setDrag(r.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); }} onDragEnd={() => { setDrag(null); setOver(null); }} title="Drag to reorder"><GripVertical size={14} /></td>
          <td><input className="inline" defaultValue={r.name} onBlur={e => e.target.value.trim() && e.target.value !== r.name && set(r.id, {name: e.target.value.trim()})} /><div className="muted small">{counts[r.id] ?? 0} people</div></td>
          {spaces.map(p => <td key={p.id}><select className={'plain-select jr-cell' + ((r.spaces[p.id] ?? 'inherit') === 'none' ? ' none' : (r.spaces[p.id] ?? 'inherit') === 'inherit' ? ' inherit' : '')} value={r.spaces[p.id] ?? 'inherit'} onChange={e => cell(r, p.id, e.target.value)}>{levelOptions(levels, 'Default')}</select></td>)}
          <td><select className="plain-select jr-cell" value={r.others} onChange={e => set(r.id, {others: e.target.value})}>{levelOptions(levels, 'Default')}</select></td>
          <td><button className="icon" title="Delete job role" onClick={() => { if (confirm(`Delete the job role "${r.name}"? People who have it keep their other access.`)) save(rows.filter(x => x.id !== r.id)); }}><Trash2 size={12} /></button></td>
        </tr>)}</tbody>
      </table></div>}
      <button className="btn" style={{marginTop: 8}} onClick={() => save([...rows, {id: 'job-' + Math.random().toString(36).slice(2, 7), name: 'New job role', spaces: {}, others: 'inherit'}])}><Plus size={14} /> New job role</button>
    </section>
  );
}

/** Company email domain: people signing in with Google on these domains join on their own. */
export function DomainJoinCard({value, levels, jobRoles, googleOn, onSaved}: {value: DomainJoin; levels: Level[]; jobRoles: JobRole[]; googleOn: boolean; onSaved: (m: string) => void}) {
  const [domains, setDomains] = useState(value.domains.join(', '));
  const [level, setLevel] = useState(value.level);
  const [jr, setJr] = useState(value.jobRoles);
  const save = async () => {
    try { await api('/workspace', {method: 'PUT', body: {domainJoin: {domains: domains.split(/[\s,]+/).filter(Boolean), level, jobRoles: jr}}}); onSaved('Company domain saved.'); }
    catch (e) { onSaved(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Company email domain</h3><span className="muted small">People who sign in with Google on these domains join this workspace without an invite, with the level and job roles below. Google confirms they own the address. Turning someone off on the People list keeps them out.{!googleOn && ' Google sign-in is not set up on this server yet, so this has no effect until it is.'}</span></div>
      <div className="set-item"><span className="grow">Domains</span><input className="inline" style={{width: 260}} placeholder="company.com" value={domains} onChange={e => setDomains(e.target.value)} /></div>
      <div className="set-item"><span className="grow">Starting level</span><select className="plain-select" value={level} onChange={e => setLevel(e.target.value)}>{levels.filter(l => l.id !== 'admin').map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
      <div className="set-item"><span className="grow">Starting job roles</span><JobRolePicker all={jobRoles} value={jr} onChange={setJr} /></div>
      <div className="set-item"><span className="grow" /><button className="btn primary small" onClick={save}>Save</button></div>
    </section>
  );
}
