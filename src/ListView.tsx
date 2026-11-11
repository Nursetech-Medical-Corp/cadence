import {Fragment, useState} from 'react';
import {TimeCell} from './TimeTracker.tsx';
import {activeColors, colorOf, tint} from './ColorRules.tsx';
import {useQuickAssist} from './QuickAssist.tsx';
import {ChevronDown, ChevronRight, GripVertical, Plus, Repeat, Maximize2} from 'lucide-react';
import type {Item, Project} from './types.ts';
import {between, type Store} from './store.ts';
import {Check, DateInput, InlineText, PeoplePicker, PrioritySelect, Progress, StatusSelect, TagEditor, TypeBadge, move, SpaceChip} from './components.tsx';
import {rowFieldsOf, type RowField, type ViewProps} from './viewProps.ts';
import {sortItems, sortsOf} from './Sorting.tsx';
import {countRules} from './FilterBuilder.tsx';

type Insert = {parentId: string | null; afterSort: number | undefined; beforeSort: number | undefined; depth: number; afterId: string | null; beforeId?: string};

export function ListView({store, project, items: shown, allItems: items, open, selected, toggle, config, setConfig, createExtra}: ViewProps) {
  const flat = !!(config.types?.length || countRules(config.filter) || config.text || config.assignee);
  const sorts = sortsOf(config);
  const shownIds = new Set(shown.map(i => i.id));
  const matches = (i: Item) => shownIds.has(i.id);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [insert, setInsert] = useState<Insert | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [quickText, setQuickText] = useState('');
  const [overId, setOverId] = useState<string | null>(null);
  const [dragField, setDragField] = useState<RowField | null>(null);
  const [overField, setOverField] = useState<RowField | null>(null);
  const fields = rowFieldsOf(config);

  const kids = new Map<string | null, Item[]>();
  const ids = new Set(items.map(i => i.id));
  for (const i of flat ? shown : items) {
    const parent = !flat && i.parentId && ids.has(i.parentId) ? i.parentId : null;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent)!.push(i);
  }
  for (const [k, l] of kids) kids.set(k, sortItems(l, sorts, project, store));
  const visible = (i: Item): boolean => matches(i) || (kids.get(i.id) ?? []).some(visible);
  const siblingsOf = (i: Item) => kids.get(i.parentId && ids.has(i.parentId) ? i.parentId : null) ?? [];

  const startInsertAfter = (i: Item, depth: number) => {
    const sibs = siblingsOf(i), idx = sibs.indexOf(i);
    setInsert({parentId: i.parentId, afterSort: i.sort, beforeSort: sibs[idx + 1]?.sort, depth, afterId: i.id});
  };
  const startInsertBefore = (i: Item, depth: number) => {
    const sibs = siblingsOf(i), prev = sibs[sibs.indexOf(i) - 1];
    setInsert({parentId: i.parentId, afterSort: prev?.sort, beforeSort: i.sort, depth, afterId: prev?.id ?? null, beforeId: i.id});
  };
  const indent = (i: Item) => {
    const sibs = siblingsOf(i), prev = sibs[sibs.indexOf(i) - 1];
    if (prev) { store.updateItem(i.id, {parentId: prev.id, sort: (kids.get(prev.id)?.at(-1)?.sort ?? 0) + 1}); setCollapsed(c => { const n = new Set(c); n.delete(prev.id); return n; }); }
  };
  const outdent = (i: Item) => {
    const parent = i.parentId ? items.find(x => x.id === i.parentId) : null;
    if (parent) store.updateItem(i.id, {parentId: parent.parentId, sort: between(parent.sort, siblingsOf(parent)[siblingsOf(parent).indexOf(parent) + 1]?.sort)});
  };
  const dropOn = (target: Item) => {
    if (!dragId || dragId === target.id) return;
    const sibs = siblingsOf(target), idx = sibs.indexOf(target);
    store.updateItem(dragId, {parentId: target.parentId, sort: between(sibs[idx - 1]?.sort, target.sort)});
    setDragId(null);
  };

  // Priority, assignee and status: drag one onto another to reorder them in every row of this view. Alt+Left and Alt+Right do the same.
  const slot = (id: RowField, i: Item) => (
    <span key={id} data-field={id} title="Drag to reorder. Alt+Left and Alt+Right also move it" draggable
      className={'meta-slot' + (id === 'assignees' ? ' person-slot' : '') + (dragField === id ? ' dragging' : '') + (overField === id && dragField && dragField !== id ? ' drop' : '')}
      onDragStart={e => { e.stopPropagation(); setDragField(id); }} onDragEnd={() => { setDragField(null); setOverField(null); }}
      onDragOver={e => { if (!dragField) return; e.preventDefault(); e.stopPropagation(); setOverField(id); }}
      onDrop={e => { if (!dragField) return; e.stopPropagation(); setConfig({rowFields: move(fields, fields.indexOf(dragField), fields.indexOf(id))}); setDragField(null); setOverField(null); }}
      onKeyDown={e => {
        if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        const from = fields.indexOf(id), to = from + (e.key === 'ArrowLeft' ? -1 : 1);
        if (to < 0 || to >= fields.length) return;
        setConfig({rowFields: move(fields, from, to)});
        // Moving the element can drop keyboard focus, so put it back.
        const row = e.currentTarget.closest('.row');
        requestAnimationFrame(() => (row?.querySelector(`[data-field="${id}"] button`) as HTMLElement | null)?.focus());
      }}>
      {id === 'priority' ? <PrioritySelect value={i.priority} onChange={priority => store.updateItem(i.id, {priority})} />
        : id === 'assignees' ? <PeoplePicker value={i.assignees} people={store.people} onReorder={store.reorderPeople} onChange={assignees => store.updateItem(i.id, {assignees})} compact />
        : <StatusSelect project={project} value={i.status} onChange={status => store.updateItem(i.id, {status})} />}
    </span>
  );

  const rows = (parent: string | null, depth: number): React.ReactNode =>
    (kids.get(parent) ?? []).filter(visible).map(i => {
      const children = kids.get(i.id) ?? [];
      const isCollapsed = collapsed.has(i.id);
      return (
        <Fragment key={i.id}>
          {insert?.beforeId === i.id && <QuickRow store={store} project={project} insert={insert} setInsert={setInsert} items={items} text={quickText} setText={setQuickText} createExtra={createExtra} />}
          <div onClickCapture={e => { if (e.ctrlKey || e.metaKey || e.shiftKey) { e.preventDefault(); e.stopPropagation(); toggle(i.id, e, [...document.querySelectorAll<HTMLElement>('.list .row[data-id]')].map(r => r.dataset.id!)); } }} data-id={i.id}
            style={tint(colorOf(i, activeColors(config), {project, today: store.today}))}
            className={'row' + (selected.has(i.id) ? ' sel' : '') + (i.completed ? ' done' : '') + (dragId === i.id ? ' dragging' : '') + (overId === i.id && dragId !== i.id ? ' drop-before' : '')} draggable
            onDragStart={e => { if ((e.target as HTMLElement).closest('input')) { e.preventDefault(); return; } setDragId(i.id); }} onDragEnd={() => { setDragId(null); setOverId(null); }}
            onDragOver={e => { if (dragField) return; e.preventDefault(); setOverId(i.id); }} onDrop={() => { dropOn(i); setOverId(null); }}>
            <span className="row-gutter">
              <button className="gutter-btn" title="Click to add below. Alt+click to add above" onClick={e => { e.stopPropagation(); if (e.altKey) startInsertBefore(i, depth); else startInsertAfter(i, depth); }}><Plus size={14} /></button>
              <span className="gutter-btn grip" title="Drag to move"><GripVertical size={14} /></span>
            </span>
            <span className="indent" style={{width: depth * 20}} />
            <button className="twisty" style={{visibility: children.length ? 'visible' : 'hidden'}}
              onClick={() => setCollapsed(c => { const n = new Set(c); n.has(i.id) ? n.delete(i.id) : n.add(i.id); return n; })}>
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
            <Check item={i} project={project} onToggle={status => store.updateItem(i.id, {status})} />
            {project.settings.rollup && <SpaceChip item={i} projects={store.projects} />}
            {i.type !== 'Task' && <TypeBadge type={i.type} />}
            <RowTitle item={i}
              onSave={title => store.updateItem(i.id, {title})}
              onEnter={() => startInsertAfter(i, depth)}
              onTab={shift => shift ? outdent(i) : indent(i)} />
            {children.length > 0 && <Progress done={children.filter(c => c.completed).length} total={children.length} />}
            {i.recur && <Repeat size={13} className="muted" aria-label="Repeats" />}
            <TagEditor tags={i.tags} onChange={tags => store.updateItem(i.id, {tags})} />
            <span className="spacer" />
            <span className="row-meta">
              <TimeCell item={i} store={store} compact />
              {slot(fields[0], i)}
              <DateInput value={i.due} today={i.completed ? undefined : store.today} onChange={due => store.updateItem(i.id, {due})} placeholder="Due" />
              {slot(fields[1], i)}
              {slot(fields[2], i)}
              <button className="icon more" title="Open details" onClick={() => open(i.id)}><Maximize2 size={14} /></button>
            </span>
          </div>
          {!isCollapsed && rows(i.id, depth + 1)}
          {insert?.afterId === i.id && !insert.beforeId && <QuickRow store={store} project={project} insert={insert} setInsert={setInsert} items={items} text={quickText} setText={setQuickText} createExtra={createExtra} />}
        </Fragment>
      );
    });

  const top = kids.get(null) ?? [];
  return (
    <div className="list">
      {rows(null, 0)}
      {insert && insert.afterId === null && !insert.beforeId && <QuickRow store={store} project={project} insert={insert} setInsert={setInsert} items={items} text={quickText} setText={setQuickText} createExtra={createExtra} />}
      {!insert && (
        <button className="add-row" onClick={() => setInsert({parentId: null, afterSort: top.at(-1)?.sort, beforeSort: undefined, depth: 0, afterId: null})}>
          <span className="check ghost" /> Add item <span className="small">Enter adds the next one, Tab nests it. Try: Call vendor @sam !high due:fri #ops ~2h every:w</span>
        </button>
      )}
    </div>
  );
}

function RowTitle({item, onSave, onEnter, onTab}: {item: Item; onSave: (v: string) => void; onEnter: () => void; onTab: (shift: boolean) => void}) {
  return (
    <span className="title-wrap" onKeyDownCapture={e => {
      if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); onEnter(); }
      if (e.key === 'Tab') { e.preventDefault(); onTab(e.shiftKey); }
      // Up and Down move between rows, like an outline.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const all = [...document.querySelectorAll<HTMLInputElement>('.list .row .title-wrap input, .list .row.quick input')];
        const idx = all.indexOf(e.target as HTMLInputElement);
        const next = all[idx + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) { e.preventDefault(); next.focus(); }
      }
    }}>
      <InlineText value={item.title} onSave={onSave} className="title" />
    </span>
  );
}

// Inline creator: Enter adds and keeps a fresh row below, Tab indents under the row above, Esc closes.
// Text lives in the parent so it survives the row moving below the item it just created.
function QuickRow({store, project, insert, setInsert, items, text, setText, createExtra}: {store: Store; project: Project; insert: Insert; setInsert: (i: Insert | null) => void; items: Item[]; text: string; setText: (t: string) => void; createExtra?: {sprint?: string}}) {
  const qa = useQuickAssist(store, project.types, text, setText);
  const submit = async () => {
    if (!text.trim()) return;
    const value = text;
    setText('');
    const item = await store.quickAdd(project.id, value, {...createExtra, parentId: insert.parentId, sort: between(insert.afterSort, insert.beforeSort)});
    if (item) setInsert({...insert, afterSort: item.sort, afterId: item.id});
    else setText(value);
  };
  return (
    <div className="row quick">
      <span className="indent" style={{width: insert.depth * 20 + 22}} />
      <span className="check ghost" />
      <span className="qa-wrap grow">
      <input autoFocus className="inline title" placeholder="New item. Type @ to assign, ! for priority, due: for a date" value={text} {...qa.props}
        onChange={e => setText(e.target.value)}
        onBlur={() => { qa.props.onBlur(); if (!text.trim()) setInsert(null); }}
        onKeyDown={e => {
          if (qa.keyDown(e)) return;
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          if (e.key === 'Escape') setInsert(null);
          if (e.key === 'Tab' && !e.shiftKey && insert.afterId) {
            e.preventDefault();
            const above = items.find(i => i.id === insert.afterId)!;
            setInsert({parentId: above.id, afterSort: items.filter(i => i.parentId === above.id).sort((a, b) => a.sort - b.sort).at(-1)?.sort, beforeSort: undefined, depth: insert.depth + 1, afterId: insert.afterId});
          }
          if (e.key === 'Tab' && e.shiftKey && insert.parentId) {
            e.preventDefault();
            const parent = items.find(i => i.id === insert.parentId)!;
            const next = items.filter(i => i.parentId === parent.parentId && i.sort > parent.sort).sort((a, b) => a.sort - b.sort)[0];
            setInsert({parentId: parent.parentId, afterSort: parent.sort, beforeSort: next?.sort, depth: Math.max(0, insert.depth - 1), afterId: insert.afterId});
          }
        }} />
      {qa.ui}</span>
    </div>
  );
}
