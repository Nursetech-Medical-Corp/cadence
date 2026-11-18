// Edit many items at once. Appears when rows are selected (checkboxes in Table and List, or Ctrl/Shift+click).
// Delete or Backspace removes the selected items (after a confirm) when you are not typing in a field.
import {useEffect, useRef, useState} from 'react';
import {CalendarDays, Trash2, X} from 'lucide-react';
import type {ItemPatch, Project, Sprint} from './types.ts';
import {PRIORITIES} from './types.ts';
import type {Store} from './store.ts';
import {Avatar, Menu, PriorityIcon, StatusIcon, TypeBadge} from './components.tsx';
import {uiConfirm} from './dialogs.tsx';

export function BulkBar({store, project, sprints, selected, clear}: {store: Store; project: Project; sprints: Sprint[]; selected: Set<string>; clear: () => void}) {
  const [date, setDate] = useState('');
  const [doneOn, setDoneOn] = useState('');
  const ids = [...selected].filter(id => store.items.has(id));
  const remove = async () => { if ((await uiConfirm(`Delete ${ids.length} item${ids.length === 1 ? '' : 's'} and their subitems?`))) { for (const id of ids) store.deleteItem(id); clear(); } };
  const removeRef = useRef(remove); removeRef.current = remove;
  useEffect(() => {
    if (!selected.size) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('textarea, select, [contenteditable="true"], .dlg') || (t.matches('input') && (t as HTMLInputElement).type !== 'checkbox')) return;
      e.preventDefault();
      void removeRef.current();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [selected.size > 0]);
  if (!selected.size) return null;
  const apply = (patch: (id: string) => ItemPatch) => { for (const id of ids) store.updateItem(id, patch(id)); };
  const doneId = project.statuses.find(s => s.category === 'done')?.id;
  return (
    <div className="bulk-bar">
      <b>{ids.length} selected</b>
      <Menu value={null as string | null} title="Status" onChange={v => v && apply(() => ({status: v}))} render={<span>Status</span>}
        options={project.statuses.map(s => ({value: s.id as string | null, label: s.name, icon: <StatusIcon status={s} />}))} />
      <Menu value={null as string | null} title="Assign" onChange={v => apply(() => ({assignees: v === '__none' ? [] : [v!]}))} render={<span>Assign</span>}
        options={[{value: '__none', label: 'Unassign'}, ...store.people.map(p => ({value: p.id as string | null, label: p.name, icon: <Avatar person={p} size={18} />}))]} />
      <Menu value={null as number | null} title="Priority" onChange={v => v !== null && apply(() => ({priority: v}))} render={<span>Priority</span>}
        options={[1, 2, 3, 4, 0].map(p => ({value: p as number | null, label: PRIORITIES[p], icon: <PriorityIcon value={p} />}))} />
      <Menu value={null as string | null} title="Type" onChange={v => v && apply(() => ({type: v}))} render={<span>Type</span>}
        options={project.types.map(t => ({value: t as string | null, label: t, icon: <TypeBadge type={t} />}))} />
      <Menu value={'' as string | null} title="Sprint" onChange={v => apply(() => ({sprint: v || null}))} render={<span>Sprint</span>}
        options={[{value: null, label: 'Backlog'}, ...sprints.map(s => ({value: s.id as string | null, label: s.name}))]} />
      <label className="bulk-date"><CalendarDays size={13} /><input type="date" value={date} onChange={e => { setDate(e.target.value); if (e.target.value) apply(() => ({due: e.target.value})); }} title="Set due date" /></label>
      {doneId && <button className="btn" onClick={() => apply(() => ({status: doneId}))}>Mark done</button>}
      {doneId && <label className="bulk-date" title="Mark done on a past date"><span className="small">Done on</span><input type="date" value={doneOn} max={store.today}
        onChange={e => { setDoneOn(e.target.value); if (e.target.value) apply(() => ({status: doneId, completed: e.target.value})); }} /></label>}
      <button className="btn danger" title="Delete the selected items (or press Delete)" onClick={() => void remove()}><Trash2 size={13} /></button>
      <button className="icon" title="Clear selection (Esc)" onClick={clear}><X size={15} /></button>
    </div>
  );
}
