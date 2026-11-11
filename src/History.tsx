// Saved change history. Unlike Ctrl+Z (this tab only), this survives reloads and covers everyone's edits.
import {useEffect, useState} from 'react';
import {RotateCcw} from 'lucide-react';
import type {Activity, Item} from './types.ts';
import {PRIORITIES} from './types.ts';
import {api, type Store} from './store.ts';
import {Avatar, Empty} from './components.tsx';

const LABELS: Record<string, string> = {due: 'due date', start: 'start date', assignees: 'assignees', parentId: 'parent', deps: 'dependencies', recur: 'repeat', projectId: 'project', body: 'description'};

function ago(at: string) {
  const s = (Date.now() - Date.parse(at)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

const clip = (t: string) => t.length > 120 ? t.slice(0, 120) + '...' : t;

function show(key: string, v: unknown, store: Store, a: Activity) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return 'none';
  if (key === 'assignees') return (v as string[]).map(id => store.people.find(p => p.id === id)?.name ?? '?').join(', ');
  if (key === 'status') return store.projects.find(p => p.id === a.projectId)?.statuses.find(s => s.id === v)?.name ?? String(v);
  if (key === 'priority') return PRIORITIES[v as number];
  if (key === 'sprint') return store.sprints.find(s => s.id === v)?.name ?? 'a sprint';
  if (key === 'parentId') return store.items.get(v as string)?.title ?? 'another item';
  if (key === 'recur') return 'repeat rule';
  if (key === 'deps') return `${(v as string[]).length} item(s)`;
  if (key === 'body') return `"${String(v).slice(0, 40)}${String(v).length > 40 ? '...' : ''}"`;
  const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return t.length > 120 ? t.slice(0, 120) + '...' : t;
}

function describe(a: Activity, store: Store) {
  if (a.kind === 'create') return <>created <b>{clip(a.title)}</b></>;
  if (a.kind === 'delete') { const n = (Array.isArray(a.before) ? a.before : (a.before as {items: Item[]}).items).length; return <>deleted <b>{clip(a.title)}</b>{n > 1 ? ` and ${n - 1} subitems` : ''}</>; }
  if (a.kind === 'revert') return <>restored <b>{clip(a.title)}</b></>;
  const before = a.before as Record<string, unknown>, after = a.after as Record<string, unknown>;
  return <>changed <b>{clip(a.title)}</b>: {Object.keys(after).map((k, n) => (
    <span key={k}>{n > 0 && ', '}{LABELS[k] ?? k} <span className="muted">{show(k, before[k], store, a)}</span> to {show(k, after[k], store, a)}</span>
  ))}</>;
}

export function ActivityList({store, itemId, projectId, limit = 50, open}: {store: Store; itemId?: string; projectId?: string; limit?: number; open?: (id: string) => void}) {
  const [list, setList] = useState<Activity[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const q = new URLSearchParams({limit: String(limit), ...(itemId ? {itemId} : {}), ...(projectId ? {projectId} : {})});
  useEffect(() => { api<Activity[]>(`/activity?${q}`).then(setList).catch(() => {}); }, [itemId, projectId, store.tick]);
  if (!list.length) return <div className="muted small" style={{padding: 6}}>No changes recorded yet.</div>;
  return (
    <div className="history">
      {list.map(a => (
        <div key={a.id} className="hist-row">
          <Avatar person={store.people.find(p => p.id === a.actor)} size={20} />
          <span className="grow small" onClick={() => open && store.items.has(a.itemId) && open(a.itemId)} style={{cursor: open ? 'pointer' : undefined}}>
            <b>{store.people.find(p => p.id === a.actor)?.name ?? 'Automation or API'}</b> {describe(a, store)}
          </span>
          <span className="muted small nowrap">{ago(a.at)}</span>
          {a.kind !== 'revert' && <button className="btn ghost small" disabled={busy === a.id} title="Put this back the way it was"
            onClick={async () => { setBusy(a.id); try { await api(`/activity/${a.id}/revert`, {method: 'POST'}); } catch (e) { store.fail(e); } setBusy(null); }}><RotateCcw size={12} /> Revert</button>}
        </div>
      ))}
    </div>
  );
}

export function HistoryPage({store, open}: {store: Store; open: (id: string) => void}) {
  const [project, setProject] = useState('');
  return (
    <div className="page">
      <h1>History</h1>
      <p className="muted">Every change is saved with who made it. Revert any one of them, even after a reload. Ctrl+Z still undoes your own recent changes in this tab.</p>
      <select className="plain-select" value={project} onChange={e => setProject(e.target.value)} style={{marginBottom: 10}}>
        <option value="">All projects</option>{store.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {store.projects.length ? <ActivityList store={store} projectId={project || undefined} limit={200} open={open} /> : <Empty title="No projects" />}
    </div>
  );
}
