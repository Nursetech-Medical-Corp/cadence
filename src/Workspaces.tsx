// Workspace switcher (top of the sidebar) and the cross-workspace Today page.
// Each workspace is a separate company or a personal space with its own projects, people and data.
import {shrinkImage} from './images.ts';
import {useEffect, useState} from 'react';
import {Check, ChevronDown, Plus, Settings2, Sun, Trash2} from 'lucide-react';
import type {Item} from './types.ts';
import {api, apiIn, getMe, meIn, switchWorkspace, wsId, type Store} from './store.ts';
import {Empty, Popover, itemKey} from './components.tsx';

export type Workspace = {id: string; name: string; color: string; icon: string; logo?: string; sort: number};
const COLORS = ['#7c5cff', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#6366f1', '#64748b'];

export function useWorkspaces() {
  const [list, setList] = useState<Workspace[]>([]);
  const reload = () => api<{list: Workspace[]}>('/workspaces').then(r => setList(r.list)).catch(() => {});
  useEffect(() => { reload(); }, []);
  return [list, reload] as const;
}

export function WsMark({w, size = 22}: {w?: Workspace; size?: number}) {
  if (w?.logo) return <img className="ws-mark ws-logo" src={w.logo} alt="" style={{width: size, height: size}} />;
  return <span className="ws-mark" style={{background: w?.color ?? '#7c5cff', width: size, height: size, fontSize: size * 0.5}}>{w?.icon || (w?.name ?? 'T').slice(0, 1).toUpperCase()}</span>;
}

/** The workspace button at the top of the sidebar: switch, add, rename, and open Today across all of them. */
export function WorkspaceSwitcher({store, me}: {store: Store; me: string}) {
  const [list, reload] = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'new' | 'edit'>('list');
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[1]);
  const [icon, setIcon] = useState('');
  const [logo, setLogo] = useState('');
  const [err, setErr] = useState('');
  const cur = list.find(w => w.id === wsId()) ?? list[0];
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || !/^Digit[1-9]$/.test(e.code)) return;
      const w = list[Number(e.code.slice(5)) - 1];
      if (w && w.id !== wsId()) { e.preventDefault(); switchWorkspace(w.id); }
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, [list]);
  const close = () => { setOpen(false); setMode('list'); setErr(''); };
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const w = await api<Workspace & {me: string}>('/workspaces', {method: 'POST', body: {name, color, icon, ownerName: store.people.find(p => p.id === me)?.name}});
      localStorage.setItem(`me:${w.id}`, w.me);
      switchWorkspace(w.id);
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); setBusy(false); }
  };
  const save = async () => {
    try { await api(`/workspaces/${cur!.id}`, {method: 'PATCH', body: {name, color, icon, logo}}); reload(); setMode('list'); } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  };
  const form = (onSave: () => void, label: string) => (
    <div className="ws-form">
      <input className="pop-search" autoFocus placeholder="Name, like Acme or Personal" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && onSave()} />
      <div className="ws-colors">{COLORS.map(c => <button key={c} className={'ws-color' + (c === color ? ' on' : '')} style={{background: c}} onClick={() => setColor(c)} title={c} />)}</div>
      <input className="pop-search" placeholder="Icon: one letter or emoji (optional)" maxLength={4} value={icon} onChange={e => setIcon(e.target.value)} />
      {mode === 'edit' && <div className="ws-logo-row">
        {logo ? <img src={logo} alt="" className="ws-logo-preview" /> : <span className="muted small">No logo</span>}
        <label className="btn small">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { try { setLogo(await shrinkImage(f, 128)); } catch { setErr('That image could not be read'); } } }} /></label>
        {logo && <button className="btn ghost small" onClick={() => setLogo('')}>Remove</button>}
      </div>}
      {err && <div className="small" style={{color: 'var(--danger)', padding: '0 8px'}}>{err}</div>}
      <div style={{display: 'flex', gap: 6, padding: 6}}><button className="btn primary small" disabled={!name.trim() || busy} onClick={onSave}>{label}</button><button className="btn small" onClick={() => setMode('list')}>Cancel</button></div>
    </div>
  );
  return (
    <span className="picker ws-switch" style={{display: 'block', flex: 1, minWidth: 0}}>
      <button className="ws-btn" onClick={() => setOpen(o => !o)} title="Switch workspace">
        <WsMark w={cur} /><span className="grow ws-name">{cur?.name ?? 'Cadence'}</span><ChevronDown size={14} />
      </button>
      <Popover open={open} onClose={close}>
        {mode === 'list' && <>
          <div className="pop-label">Workspaces</div>
          {list.map((w, n) => (
            <button key={w.id} className={'pop-row' + (w.id === cur?.id ? ' on' : '')} onClick={() => w.id === cur?.id ? close() : switchWorkspace(w.id)}>
              <WsMark w={w} size={18} /><span className="grow">{w.name}</span>{w.id === cur?.id ? <Check size={14} /> : n < 9 && <kbd>Alt {n + 1}</kbd>}
            </button>
          ))}
          <div className="pop-sep" />
          {list.length > 1 && <button className="pop-row" onClick={() => { close(); location.hash = '/today'; }}><Sun size={14} /> Everything, all workspaces</button>}
          <button className="pop-row" onClick={() => { setName(''); setIcon(''); setColor(COLORS[list.length % COLORS.length]); setMode('new'); }}><Plus size={14} /> New workspace</button>
          {cur && <button className="pop-row" onClick={() => { setName(cur.name); setIcon(cur.icon); setColor(cur.color); setLogo(cur.logo ?? ''); setMode('edit'); }}><Settings2 size={14} /> Rename or recolor {cur.name}</button>}
          {cur && cur.id !== 'main' && <button className="pop-row danger-row" onClick={async () => {
            const typed = prompt(`Delete the workspace "${cur.name}"? Its spaces, people and files are moved to a deleted folder on this computer and disappear from the app. Type the name to confirm.`);
            if (typed === null) return;
            try { await api(`/workspaces/${cur.id}?confirm=${encodeURIComponent(typed)}`, {method: 'DELETE'}); switchWorkspace('main'); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
          }}><Trash2 size={14} /> Delete {cur.name}</button>}
        </>}
        {mode === 'new' && <><div className="pop-label">New workspace</div><div className="muted small" style={{padding: '0 8px 4px'}}>Its own spaces, people, templates and backups. You join as its admin and are its only member until you invite people; admins of your other workspaces cannot see into it.</div>{form(create, 'Create and open')}</>}
        {mode === 'edit' && <><div className="pop-label">Workspace</div>{form(save, 'Save')}</>}
      </Popover>
    </span>
  );
}
