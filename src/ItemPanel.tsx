import {Fragment, useEffect, useState} from 'react';
import {useQuickAssist} from './QuickAssist.tsx';
import {FieldCell} from './TableView.tsx';
import {COMPUTED} from './Fields.tsx';
import {GripVertical, Link2, Pause, Play, SlidersHorizontal, Trash2, X, ArrowLeft, ArrowRight, Pin, PinOff} from 'lucide-react';
import type {Comment, Item, TimeEntry} from './types.ts';
import {api, fmtClock, fmtMinutes, useNow, type Store} from './store.ts';
import {RecurEditor} from './RecurEditor.tsx';
import {BlockEditor} from './BlockEditor.tsx';
import {WorkSection} from './AIWork.tsx';
import {ApprovalsSection} from './Approvals.tsx';
import {ActivityList} from './History.tsx';
import {ApplyToChildrenButton, SaveTemplateButton} from './TemplateMenus.tsx';
import {Avatar, Check, DateInput, InlineText, PeoplePicker, Popover, PrioritySelect, SprintSelect, StatusSelect, TagEditor, TypeBadge, TypeSelect, itemKey} from './components.tsx';

type PanelNav = {back: () => void; forward: () => void; canBack: boolean; canForward: boolean; pinned: boolean; togglePin: () => void};
export function ItemPanel({store, id, close, open, me, nav}: {store: Store; id: string; close: () => void; open: (id: string) => void; me: string; nav?: PanelNav}) {
  const item = store.items.get(id);
  const [comments, setComments] = useState<Comment[]>([]);
  const [time, setTime] = useState<TimeEntry[]>([]);
  const [comment, setComment] = useState('');
  const [sub, setSub] = useState('');
  const qa = useQuickAssist(store, store.projects.find(p => p.id === item?.projectId)?.types ?? [], sub, setSub);
  const [minutes, setMinutes] = useState('');
  const [depPick, setDepPick] = useState('');
  const running = store.running?.itemId === id ? store.running : null;
  const layoutKey = 'panel-layout:' + (store.items.get(id)?.projectId ?? '');
  const [layout, setLayoutState] = useState<{order: string[]; hidden: string[]}>(() => JSON.parse(localStorage.getItem(layoutKey) ?? '{"order":[],"hidden":[]}'));
  const setLayout = (l: {order: string[]; hidden: string[]}) => { setLayoutState(l); localStorage.setItem(layoutKey, JSON.stringify(l)); };
  const now = useNow(!!running);

  useEffect(() => {
    api<Comment[]>(`/items/${id}/comments`).then(setComments).catch(() => {});
    api<TimeEntry[]>(`/time?itemId=${id}`).then(setTime).catch(() => {});
  }, [id, store.tick, store.running?.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input,textarea,select,.popover')) close(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [close]);

  if (!item) return null;
  const project = store.projects.find(p => p.id === item.projectId);
  if (!project) return null;
  const up = (patch: Parameters<Store['updateItem']>[1]) => store.updateItem(item.id, patch);
  const all = [...store.items.values()];
  const children = all.filter(i => i.parentId === item.id).sort((a, b) => a.sort - b.sort);
  const parent = item.parentId ? store.items.get(item.parentId) : null;
  const sprints = store.sprints.filter(s => s.projectId === project.id);
  const blockedBy = item.deps.map(d => store.items.get(d)).filter(Boolean) as Item[];
  const blocking = all.filter(i => i.deps.includes(item.id));
  const logged = time.reduce((s, t) => s + (t.minutes ?? 0), 0) + (running ? (now - Date.parse(running.start)) / 60000 : 0);
  const person = (pid: string) => store.people.find(p => p.id === pid);
  const candidates = all.filter(i => i.projectId === project.id && i.id !== item.id && !item.deps.includes(i.id));

  return (
    <aside className="panel">
      <div className="panel-head">
        {nav && <span className="panel-nav">
          <button className="icon" title="Previous task you opened" disabled={!nav.canBack} onClick={nav.back}><ArrowLeft size={15} /></button>
          <button className="icon" title="Next task you opened" disabled={!nav.canForward} onClick={nav.forward}><ArrowRight size={15} /></button>
        </span>}
        <span className="muted">
          {parent && <><button className="link" onClick={() => open(parent.id)}>{itemKey(parent, store.projects)} {parent.title.slice(0, 30)}</button> / </>}
          {itemKey(item, store.projects)}
        </span>
        <span className="spacer" />
        <SaveTemplateButton store={store} item={item} />
        <button className="icon" title="Delete" onClick={() => { if (confirm(`Delete "${item.title}"${children.length ? ' and its subitems' : ''}?`)) { store.deleteItem(item.id); close(); } }}><Trash2 size={16} /></button>
        {nav && <button className={'icon' + (nav.pinned ? ' on' : '')} title={nav.pinned ? 'Pinned: stays open when you click elsewhere. Click to unpin' : 'Pin open (otherwise clicking outside closes it)'} onClick={nav.togglePin}>{nav.pinned ? <Pin size={15} /> : <PinOff size={15} />}</button>}
        <button className="icon" title="Close (Esc)" onClick={close}><X size={16} /></button>
      </div>
      <div className="panel-title">
        <Check item={item} project={project} onToggle={status => up({status})} />
        <InlineText value={item.title} onSave={title => up({title})} className="h2" />
      </div>

      {(() => {
        // Each property is a row; the order and which rows show are yours to change (saved per project in this browser).
        const rows: [string, string, React.ReactNode][] = [
          ['status', 'Status', <StatusSelect project={project} value={item.status} onChange={status => up({status})} />],
          ['type', 'Type', <TypeSelect project={project} value={item.type} onChange={type => up({type})} />],
          ['assignees', 'Assignees', <PeoplePicker value={item.assignees} people={store.people} onChange={assignees => up({assignees})} />],
          ['priority', 'Priority', <PrioritySelect value={item.priority} onChange={priority => up({priority})} showLabel />],
          ['sprint', 'Sprint', <SprintSelect projectId={project.id} sprints={sprints} value={item.sprint} onChange={sprint => up({sprint})} />],
          ['start', 'Start', <DateInput value={item.start} onChange={start => up({start})} placeholder="Set start" />],
          ['due', 'Due', <DateInput value={item.due} today={item.completed ? undefined : store.today} onChange={due => up({due})} placeholder="Set due" />],
          ...((item.parentId || item.deps.length) ? [['follow', 'Dates', <select className="plain-select" title="Dynamic dates: move with the parent, or follow the item this one waits on" value={(item.fields.follow as string) ?? ''}
            onChange={e => up({fields: {...item.fields, follow: e.target.value || undefined}})}>
            <option value="">Fixed, set by hand</option>
            {item.parentId && <option value="parent">Move with the parent</option>}
            {item.deps.length > 0 && <option value="previous">Follow what it waits on</option>}
          </select>] as [string, string, React.ReactNode]] : []),
          ['estimate', 'Estimate', <span><input className="inline num" type="number" min={0} placeholder="hours" key={String(item.estimate)} defaultValue={item.estimate ?? ''} onBlur={e => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== item.estimate) up({estimate: v}); }} /></span>],
          ['parent', 'Parent', <select className="plain-select" value={item.parentId ?? ''} onChange={e => up({parentId: e.target.value || null})}>
            <option value="">None</option>
            {all.filter(i => i.projectId === project.id && i.id !== item.id && project.types.indexOf(i.type) < Math.max(project.types.indexOf(item.type), 1)).map(i => <option key={i.id} value={i.id}>{i.type}: {i.title.slice(0, 50)}</option>)}
          </select>],
          ['tags', 'Tags', <TagEditor tags={item.tags} onChange={tags => up({tags})} />],
          ['repeat', 'Repeat', <RecurEditor value={item.recur} onChange={recur => up({recur})} due={item.due} today={store.today} onDue={due => up({due})} />],
          ['project', 'Project', <select className="plain-select" value={item.projectId} onChange={e => up({projectId: e.target.value})}>{store.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>],
          ...project.fields.map(f => [`f:${f.id}`, f.name, ['multi', 'select', 'relation', 'phone', 'email', 'files', 'rating', 'money', ...COMPUTED].includes(f.kind)
            ? <FieldCell field={f} item={item} project={project} value={item.fields[f.id]} store={store} onChange={v => up({fields: {...item.fields, [f.id]: v}})} />
            : <FieldValue kind={f.kind} options={f.options} value={item.fields[f.id]} onChange={v => up({fields: {...item.fields, [f.id]: v}})} />] as [string, string, React.ReactNode]),
        ];
        const order = layout.order.length ? [...layout.order.filter(k => rows.some(r => r[0] === k)), ...rows.map(r => r[0]).filter(k => !layout.order.includes(k))] : rows.map(r => r[0]);
        const shown = order.filter(k => !layout.hidden.includes(k));
        return <>
          <div className="props">
            {shown.map(k => { const r = rows.find(x => x[0] === k)!; return <Fragment key={k}><label>{r[1]}</label>{r[2]}</Fragment>; })}
          </div>
          <PanelLayoutMenu rows={rows.map(r => [r[0], r[1]])} order={order} hidden={layout.hidden} onChange={setLayout} />
        </>;
      })()}

      <div className="body-wrap"><BlockEditor key={item.id} value={item.body} onSave={body => body !== item.body && up({body})} onUploadImage={async f => {
        const data = await new Promise<string>(ok => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(f); });
        try { return (await api<{url: string}>(`/items/${item.id}/files`, {method: 'POST', body: {name: f.name || 'screenshot.png', mime: f.type, data}})).url; } catch (e) { store.fail(e); return null; }
      }} /></div>

      <WorkSection item={item} store={store} />
      <ApprovalsSection item={item} store={store} me={me} />

      <h4>Subitems <span className="count">{children.filter(c => c.completed).length}/{children.length}</span>{children.length > 0 && <span style={{marginLeft: 'auto', textTransform: 'none', letterSpacing: 0}}><ApplyToChildrenButton store={store} item={item} project={project} /></span>}</h4>
      {children.map(c => (
        <div key={c.id} className={'sub' + (c.completed ? ' done' : '')}>
          <Check item={c} project={project} onToggle={status => store.updateItem(c.id, {status})} />
          {c.type !== 'Task' && <TypeBadge type={c.type} />}
          <button className="link grow" style={{color: 'var(--text)'}} onClick={() => open(c.id)}>{c.title}</button>
          {c.assignees.map(a => <Avatar key={a} person={person(a)} size={18} />)}
        </div>
      ))}
      <span className="qa-wrap" style={{display: 'block'}}><input className="inline" style={{width: '100%'}} placeholder="+ Add subitem. Enter to add. @ assign, due: date" value={sub} onChange={e => setSub(e.target.value)} {...qa.props}
        onKeyDown={async e => {
          if (qa.keyDown(e)) return;
          if (e.key !== 'Enter' || !sub.trim()) return;
          const t = sub; setSub('');
          // Subitems inherit sprint and assignee from the parent unless set in the text.
          // The server copies the fields this project inherits (Settings, Subitems inherit).
          await store.quickAdd(project.id, t, {parentId: item.id});
        }} />{qa.ui}</span>

      <RelatedLinks store={store} item={item} open={open} />

      <h4><Link2 size={13} /> Dependencies</h4>
      {blockedBy.map(b => (
        <div key={b.id} className="dep">
          <span className="small muted" style={{width: 70}}>Waits for</span>
          <Check item={b} project={project} onToggle={status => store.updateItem(b.id, {status})} />
          <button className="link grow" onClick={() => open(b.id)}>{itemKey(b, store.projects)} {b.title}</button>
          <button className="icon" title="Remove" onClick={() => up({deps: item.deps.filter(d => d !== b.id)})}><X size={13} /></button>
        </div>
      ))}
      {blocking.map(b => (
        <div key={b.id} className="dep">
          <span className="small muted" style={{width: 70}}>Blocks</span>
          <Check item={b} project={project} onToggle={status => store.updateItem(b.id, {status})} />
          <button className="link grow" onClick={() => open(b.id)}>{itemKey(b, store.projects)} {b.title}</button>
        </div>
      ))}
      <select className="plain-select" value={depPick} onChange={e => { if (e.target.value) up({deps: [...item.deps, e.target.value]}); setDepPick(''); }}>
        <option value="">+ Add "waits for"...</option>
        {candidates.map(i => <option key={i.id} value={i.id}>{itemKey(i, store.projects)} {i.title.slice(0, 60)}</option>)}
      </select>

      <h4>Time <span className="muted">{fmtMinutes(logged)} logged{item.estimate ? ` of ${item.estimate}h` : ''}</span></h4>
      <div className="time-row">
        {running
          ? <><span className="clock-big">{fmtClock(now - Date.parse(running.start))}</span><button className="btn danger" onClick={() => store.stopTimer()}><Pause size={14} /> Stop</button></>
          : <button className="btn" disabled={!me} onClick={() => store.startTimer(item.id)}><Play size={14} /> Start timer</button>}
        <span className="spacer" />
        <input className="inline num" placeholder="min" value={minutes} onChange={e => setMinutes(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={e => { if (e.key === 'Enter' && Number(minutes) > 0) { api('/time', {method: 'POST', body: {itemId: item.id, minutes: Number(minutes)}}).catch(store.fail); setMinutes(''); } }} />
        <button className="btn" disabled={!(Number(minutes) > 0)} onClick={() => { api('/time', {method: 'POST', body: {itemId: item.id, minutes: Number(minutes)}}).catch(store.fail); setMinutes(''); }}>Log</button>
      </div>
      {time.slice(0, 6).map(t => <div key={t.id} className="small muted" style={{padding: '2px 0'}}>{person(t.person)?.name}: {t.minutes ? fmtMinutes(t.minutes) : 'running'} on {new Date(t.start).toLocaleDateString()}</div>)}

      <h4>History</h4>
      <ActivityList store={store} itemId={item.id} limit={20} />

      <h4>Comments</h4>
      {comments.map(c => (
        <div key={c.id} className="comment"><Avatar person={person(c.author)} size={24} /><div><b>{person(c.author)?.name}</b> <span className="muted small">{new Date(c.created).toLocaleString()}</span><div style={{whiteSpace: 'pre-wrap'}}>{c.body}</div></div></div>
      ))}
      <textarea className="comment-box" placeholder="Comment. @Name to mention. Ctrl+Enter to send" disabled={!me} value={comment}
        onChange={e => setComment(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && comment.trim()) { api(`/items/${item.id}/comments`, {method: 'POST', body: {body: comment}}).catch(store.fail); setComment(''); } }} />
      <button className="btn" style={{marginTop: 6}} disabled={!comment.trim()} onClick={() => { api(`/items/${item.id}/comments`, {method: 'POST', body: {body: comment}}).catch(store.fail); setComment(''); }}>Send</button>
    </aside>
  );
}

function FieldValue({kind, options, value, onChange}: {kind: string; options?: string[]; value: unknown; onChange: (v: unknown) => void}) {
  return <>
    {kind === 'checkbox' ? <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
      : kind === 'date' ? <DateInput value={(value as string) ?? null} onChange={onChange} />
      : kind === 'select' ? <select className="plain-select" value={(value as string) ?? ''} onChange={e => onChange(e.target.value || null)}><option value="">-</option>{options?.map(o => <option key={o}>{o}</option>)}</select>
      : <InlineText value={String(value ?? '')} placeholder="-" onSave={v => onChange(kind === 'number' ? (v === '' ? null : Number(v)) : v)} />}
  </>;
}

/** Drag to reorder the panel's fields, untick to hide. Saved per project in this browser. */
function PanelLayoutMenu({rows, order, hidden, onChange}: {rows: [string, string][]; order: string[]; hidden: string[]; onChange: (l: {order: string[]; hidden: string[]}) => void}) {
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const label = (k: string) => rows.find(r => r[0] === k)?.[1] ?? k;
  return (
    <span className="picker" style={{display: 'flex', justifyContent: 'flex-end'}}>
      <button className="btn ghost small" onClick={() => setOpen(o => !o)}><SlidersHorizontal size={12} /> Arrange fields</button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="pop-label">Drag to reorder, untick to hide</div>
        {order.map((k, n) => (
          <div key={k} className={'pop-row' + (drag === n ? ' dragging' : '')} draggable onDragStart={() => setDrag(n)} onDragEnd={() => setDrag(null)}
            onDragOver={e => e.preventDefault()} onDrop={() => { if (drag === null || drag === n) return; const l = [...order]; const [m] = l.splice(drag, 1); l.splice(n, 0, m); onChange({order: l, hidden}); setDrag(null); }}>
            <GripVertical size={13} className="muted" style={{cursor: 'grab'}} />
            <input type="checkbox" checked={!hidden.includes(k)} onChange={() => onChange({order, hidden: hidden.includes(k) ? hidden.filter(x => x !== k) : [...hidden, k]})} />
            <span className="grow">{label(k)}</span>
          </div>
        ))}
        <button className="pop-row muted" onClick={() => onChange({order: [], hidden: []})}>Reset to default</button>
      </Popover>
    </span>
  );
}

const REL: Record<string, [string, string]> = {relates: ['Relates to', 'Relates to'], duplicates: ['Duplicates', 'Duplicated by'], verifies: ['Verifies', 'Verified by'], clones: ['Cloned from', 'Cloned as']};
/** Typed links (relates to, duplicates, verifies, cloned from), stored on the item that links and shown on both ends. */
function RelatedLinks({store, item, open}: {store: Store; item: Item; open: (id: string) => void}) {
  const [rel, setRel] = useState('relates');
  const [q, setQ] = useState('');
  const mine = ((item.fields.links as {rel: string; id: string}[]) ?? []).filter(l => store.items.has(l.id));
  const incoming = [...store.items.values()].flatMap(o => ((o.fields.links as {rel: string; id: string}[]) ?? []).filter(l => l.id === item.id).map(l => ({rel: l.rel, from: o})));
  const matches = q.trim() ? [...store.items.values()].filter(i => i.id !== item.id && (i.title.toLowerCase().includes(q.toLowerCase()) || itemKey(i, store.projects).toLowerCase() === q.toLowerCase())).slice(0, 6) : [];
  const save = (links: {rel: string; id: string}[]) => store.updateItem(item.id, {fields: {...item.fields, links}});
  return <>
    <h4>Linked items <span className="count">{mine.length + incoming.length}</span></h4>
    {mine.map(l => { const o = store.items.get(l.id)!; return <div key={l.rel + l.id} className="dep"><span className="small muted" style={{width: 90}}>{REL[l.rel]?.[0] ?? l.rel}</span><button className="link grow" onClick={() => open(o.id)}>{itemKey(o, store.projects)} {o.title}</button><button className="icon" onClick={() => save(mine.filter(x => x !== l))}><X size={13} /></button></div>; })}
    {incoming.map(l => <div key={'in' + l.rel + l.from.id} className="dep"><span className="small muted" style={{width: 90}}>{REL[l.rel]?.[1] ?? l.rel}</span><button className="link grow" onClick={() => open(l.from.id)}>{itemKey(l.from, store.projects)} {l.from.title}</button></div>)}
    <div className="time-row">
      <select className="plain-select" value={rel} onChange={e => setRel(e.target.value)}>{Object.entries(REL).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}</select>
      <input className="inline" style={{flex: 1}} placeholder="Find an item to link" value={q} onChange={e => setQ(e.target.value)} />
    </div>
    {matches.map(m => <button key={m.id} className="pop-row" onClick={() => { save([...mine.filter(l => !(l.id === m.id && l.rel === rel)), {rel, id: m.id}]); setQ(''); }}><span className="muted small">{itemKey(m, store.projects)}</span> {m.title}</button>)}
  </>;
}
