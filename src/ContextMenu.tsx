// Right-click menus, like ClickUp: on a task (List, Board, Table) and on a sidebar project.
// One listener for the whole app; text fields keep the browser's own menu.
import {useEffect, useState} from 'react';
import {Copy, ExternalLink, LayoutTemplate, Link2, Trash2} from 'lucide-react';
import {api, type Store} from './store.ts';
import {itemKey} from './components.tsx';

type At = {id: string; x: number; y: number};

export function ContextMenus({store, open}: {store: Store; open: (id: string) => void}) {
  const [at, setAt] = useState<At | null>(null);
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [contenteditable="true"], .popover')) return;
      // Sidebar project: open its ... menu.
      const proj = el.closest('.proj-row');
      if (proj) { const more = proj.querySelector<HTMLElement>('.proj-more'); if (more) { e.preventDefault(); more.click(); } return; }
      const row = el.closest<HTMLElement>('.list .row[data-id], .board .card[data-id], table.grid tr[data-id]');
      if (row && store.items.has(row.dataset.id!)) { e.preventDefault(); setAt({id: row.dataset.id!, x: e.clientX, y: e.clientY}); }
    };
    const close = () => setAt(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    addEventListener('contextmenu', onMenu); addEventListener('mousedown', close); addEventListener('scroll', close, true); addEventListener('keydown', key);
    return () => { removeEventListener('contextmenu', onMenu); removeEventListener('mousedown', close); removeEventListener('scroll', close, true); removeEventListener('keydown', key); };
  }, [store.items]);
  if (!at) return null;
  const item = store.items.get(at.id);
  if (!item) return null;
  const run = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); setAt(null); f(); };
  const saveTemplate = async () => {
    const name = prompt('Template name', item.title);
    if (name === null) return;
    try { const t = await api<{id: string}>('/templates', {method: 'POST', body: {kind: 'item', itemId: item.id, name}}); location.hash = `/templates/${t.id}`; } catch (e) { store.fail(e); }
  };
  const left = Math.min(at.x, innerWidth - 230), top = Math.min(at.y, innerHeight - 220);
  return (
    <div className="popover ctx-menu" style={{position: 'fixed', left, top}} onMouseDown={e => e.stopPropagation()}>
      <div className="pop-label">{itemKey(item, store.projects)} {item.title.slice(0, 40)}</div>
      <button className="pop-row" onClick={run(() => open(item.id))}><ExternalLink size={14} /> Open</button>
      <button className="pop-row" onClick={run(saveTemplate)}><LayoutTemplate size={14} /> Save as template</button>
      <button className="pop-row" onClick={run(() => store.createItem({projectId: item.projectId, parentId: item.parentId, title: `${item.title} (copy)`, type: item.type, priority: item.priority, assignees: item.assignees, tags: item.tags, start: item.start, due: item.due, estimate: item.estimate, body: item.body}))}><Copy size={14} /> Duplicate</button>
      <button className="pop-row" onClick={run(() => navigator.clipboard.writeText(itemKey(item, store.projects)))}><Link2 size={14} /> Copy key</button>
      <div className="pop-sep" />
      <button className="pop-row" style={{color: 'var(--danger)'}} onClick={run(() => { if (confirm(`Delete "${item.title}" and its subitems?`)) store.deleteItem(item.id); })}><Trash2 size={14} /> Delete</button>
    </div>
  );
}
