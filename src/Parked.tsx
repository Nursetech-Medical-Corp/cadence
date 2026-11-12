// Archive and later: ideas parked for someday, work decided against, and items snoozed until a date.
// Nothing here shows in views, sprints or plans. Restore puts an item back where it was.
import {useEffect, useMemo, useState} from 'react';
import {Archive, ArchiveRestore, Clock} from 'lucide-react';
import type {Item} from './types.ts';
import {api, type Store} from './store.ts';
import {Empty, itemKey} from './components.tsx';

type Parked = {on?: string; kind?: 'idea' | 'parked' | 'rejected'; reason?: string};
const KIND: Record<string, string> = {idea: 'Idea for later', parked: 'Parked', rejected: 'Decided no', snoozed: 'Snoozed'};

export function ParkedPage({store, open}: {store: Store; open: (id: string) => void}) {
  const [list, setList] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const load = () => api<Item[]>('/parked').then(setList).catch(e => store.fail(e));
  useEffect(() => { load(); }, [store.tick]);
  const kindOf = (i: Item) => (i.fields.archived as Parked | undefined)?.kind ?? 'snoozed';
  const shown = useMemo(() => list.filter(i => (!kind || kindOf(i) === kind) && (!q || (i.title + ' ' + i.body).toLowerCase().includes(q.toLowerCase()))), [list, q, kind]);
  const act = async (i: Item, body: Record<string, unknown>) => { try { await api(`/park/${i.id}`, {method: 'POST', body}); load(); } catch (e) { store.fail(e); } };
  return (
    <div className="page" style={{maxWidth: 1000}}>
      <h1><Archive size={20} /> Archive and later</h1>
      <p className="muted small">Ideas you may come back to, work you decided against, and items snoozed until a date. They stay out of every view, sprint and plan. Restore puts one back in its space; a snoozed item comes back by itself on its date. In any item, use the archive button to park it.</p>
      <div className="toolbar" style={{padding: '0 0 10px', border: 0, gap: 6}}>
        <input className="plain-input" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} />
        {['', 'idea', 'parked', 'rejected', 'snoozed'].map(k => <button key={k} className={'chip-toggle' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>{k ? KIND[k] : 'All'}</button>)}
      </div>
      {shown.map(i => {
        const a = i.fields.archived as Parked | undefined, k = kindOf(i);
        return <div key={i.id} className="row" style={{gap: 8}}>
          {k === 'snoozed' ? <Clock size={14} className="muted" /> : <Archive size={14} className="muted" />}
          <span className="grow" style={{cursor: 'pointer'}} onClick={() => open(i.id)}>{i.title}
            {a?.reason && <span className="muted small"> · {a.reason}</span>}</span>
          <span className="tag">{KIND[k]}</span>
          <span className="muted small">{itemKey(i, store.projects)}</span>
          <span className="muted small" style={{width: 90, textAlign: 'right'}}>{k === 'snoozed' ? `until ${i.fields.snooze}` : a?.on}</span>
          <button className="btn small" title="Put it back in its space" onClick={() => act(i, {action: 'restore'})}><ArchiveRestore size={12} /> Restore</button>
        </div>;
      })}
      {!shown.length && <Empty title="Nothing parked">Open an item and press Archive to park an idea or a decision you want to keep without cluttering your lists.</Empty>}
    </div>
  );
}

/** Archive or snooze buttons for the item panel. */
export function ParkButtons({store, item}: {store: Store; item: Item}) {
  const parked = !!item.fields.archived || (typeof item.fields.snooze === 'string' && item.fields.snooze > store.today);
  const act = async (body: Record<string, unknown>) => { try { await api(`/park/${item.id}`, {method: 'POST', body}); } catch (e) { store.fail(e); } };
  if (parked) return <button className="icon" title={item.fields.archived ? 'Archived. Restore it to its space' : `Snoozed until ${item.fields.snooze}. Bring it back now`} onClick={() => act({action: 'restore'})}><ArchiveRestore size={16} /></button>;
  return <>
    <button className="icon" title="Snooze: hide until a date, then it comes back" onClick={() => { const until = prompt('Hide until (YYYY-MM-DD). It comes back to its list on that day.', ''); if (until) act({action: 'snooze', until}); }}><Clock size={16} /></button>
    <button className="icon" title="Archive: park an idea or a decided-no item without deleting it" onClick={() => {
      const k = prompt('Archive as: 1 idea for later, 2 parked (not now), 3 decided no', '1');
      if (!k) return;
      const reason = prompt('Why? (optional, shows in Archive and later)', '') ?? '';
      act({action: 'archive', kind: k === '3' ? 'rejected' : k === '2' ? 'parked' : 'idea', reason});
    }}><Archive size={16} /></button>
  </>;
}
