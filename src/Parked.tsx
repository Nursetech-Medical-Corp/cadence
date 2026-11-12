// Archive and later: ideas parked for someday, work decided against, and items snoozed until a date.
// Nothing here shows in views, sprints or plans. Restore puts an item back where it was.
import {useEffect, useMemo, useState} from 'react';
import {Archive, ArchiveRestore, Clock} from 'lucide-react';
import type {Item} from './types.ts';
import {api, type Store} from './store.ts';
import {Empty, itemKey} from './components.tsx';

type Parked = {on?: string; kind?: 'idea' | 'parked' | 'rejected'; reason?: string};
const KIND: Record<string, string> = {idea: 'Idea for later', parked: 'Parked', rejected: 'Decided no', snoozed: 'Snoozed'};

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
