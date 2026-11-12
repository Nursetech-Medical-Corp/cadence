// Under a repeating item's rule: this copy's date, the one after, and one-click Skip, Delay, Wait and Pause.
// Also opens the item's SOP when it has an SOP-xx.x tag and a link is set.
import {useEffect, useState} from 'react';
import {Clock3, ExternalLink, Hourglass, Pause, Play, Repeat, SkipForward} from 'lucide-react';
import type {Item} from './types.ts';
import {api, type Store} from './store.ts';
import {describeRecur, nextOccurrence} from './recur.ts';
import {itemKey} from './components.tsx';
import {addDays} from './dates.ts';

export function RoutineControls({store, item}: {store: Store; item: Item}) {
  const r = item.recur;
  if (!r || r.spawned || item.completed) return null;
  const sched = r.slot ?? item.due;
  const next = sched ? nextOccurrence(r, sched, sched) : null;
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    try { const res = await api<{errors?: string[]}>('/routines/act', {method: 'POST', body: {ids: [item.id], action, ...extra}}); if (res.errors?.length) alert(res.errors.join('\n')); } catch (e) { store.fail(e); }
  };
  const waitingOn = r.waiting ? item.deps.map(d => store.items.get(d)).filter(d => d && !d.completed).map(d => itemKey(d!, store.projects)) : [];
  return <div className="routine-ctl small">
    {r.paused ? <span className="rt-note paused">Paused</span> : r.waiting ? <span className="rt-note waiting">Waiting on {waitingOn.join(', ') || 'its dependencies'}</span>
      : <span className="muted">This one {item.due ?? 'no date'}{r.slot && ` (moved from ${r.slot})`}{next && <>, then <b>{next}</b></>}</span>}
    <span className="spacer" />
    <a className="btn ghost small" href={`#/routines/${item.id}`} title="See it with all routines: timeline, workload, pause or end"><Repeat size={12} /> In Routines</a>
    {!r.paused && !r.waiting && <button className="btn ghost small" title="Done for this cycle without doing it: moves to the next date" onClick={() => act('skip')}><SkipForward size={12} /> Skip</button>}
    {!r.paused && !r.waiting && <button className="btn ghost small" title="Push only this copy; the next one stays on schedule. Change the date above to move the whole schedule" onClick={() => { const to = prompt(`Delay only this copy to (YYYY-MM-DD). The next stays on ${next ?? 'schedule'}.`, item.due ? addDays(item.due, 3) : store.today); if (to) act('delay', {to}); }}><Clock3 size={12} /> Delay</button>}
    <button className="btn ghost small" title="Start only after other work is done, like a hire or a W-2 setup" onClick={() => { const k = prompt('Wait until which item is done? Its key, like GEN-12 (comma for several).'); if (!k) return; const on = k.split(/[,\s]+/).filter(Boolean).map(x => [...store.items.values()].find(i => itemKey(i, store.projects).toUpperCase() === x.toUpperCase())?.id ?? x); act('wait', {on}); }}><Hourglass size={12} /> Wait</button>
    {r.paused ? <button className="btn ghost small" onClick={() => act('resume')}><Play size={12} /> Turn on</button> : <button className="btn ghost small" title="Hide from views, sprints and plans; history kept" onClick={() => act('pause')}><Pause size={12} /> Pause</button>}
  </div>;
}

/** Links for this item's SOP tags. */
export function SopLinks({store, item}: {store: Store; item: Item}) {
  const codes = item.tags.filter(t => /^sop-[0-9a-z]+\.\d+$/i.test(t)).map(t => t.toUpperCase());
  const [links, setLinks] = useState<Record<string, string>>({});
  useEffect(() => { if (codes.length) api<{code: string; url: string}[]>('/sops').then(l => setLinks(Object.fromEntries(l.map(x => [x.code, x.url])))).catch(() => {}); }, [codes.join(), store.tick]);
  if (!codes.length) return null;
  return <span className="sop-links">{codes.map(c => { const u = links[c] ?? links['*']; return u ? <a key={c} className="tag" href={u} target="_blank" rel="noreferrer" title={links[c] ? 'Open the SOP' : 'No document linked yet; opens the SOP master list'}><ExternalLink size={10} /> {c}</a> : <span key={c} className="tag">{c}</span>; })}</span>;
}

/** Header chip on a repeating item: says it is a routine (on, delayed, waiting, paused) and opens it on the Routines page, where it can be paused, skipped or delayed. */
export function RoutineBadge({item}: {item: Item}) {
  const r = item.recur;
  if (!r) return null;
  const state = r.spawned || item.completed ? 'done' : r.paused ? 'paused' : r.waiting ? 'waiting' : r.slot ? 'delayed' : 'on';
  const label = state === 'done' ? 'Past routine copy' : state === 'on' ? 'Routine' : `Routine: ${state}`;
  return <a className={'routine-badge ' + state} href={`#/routines/${item.id}`} title="This task repeats. Open it on the Routines page to pause it, skip this one or delay it">
    <Repeat size={11} /> {label}
  </a>;
}

/** Small routine mark for lists, tables and boards: shows that an item repeats (and its state), click opens it on the Routines page. */
export function RoutineMark({item, label, corner}: {item: Item; label?: boolean; corner?: boolean}) {
  const r = item.recur;
  if (!r) return null;
  const state = r.spawned || item.completed ? 'done' : r.paused ? 'paused' : r.waiting ? 'waiting' : r.slot ? 'delayed' : 'on';
  const rule = describeRecur(r, item.due);
  return <a className={'routine-mark ' + state + (corner ? ' corner' : '')} href={`#/routines/${item.id}`} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
    title={`Routine (${state === 'on' ? 'on' : state}): ${rule}. Click to manage it on the Routines page (pause, skip, delay)`}>
    <Repeat size={corner ? 10 : 12} />{label && <span>{state === 'on' ? rule : state === 'done' ? 'past copy' : state}</span>}
  </a>;
}

/** Who may be assigned: auto-job routines are run by AI agents, so only agents are offered. */
export const peopleFor = <P extends {kind?: string}>(i: Pick<Item, 'tags'>, people: P[]) => i.tags.includes('auto-job') ? people.filter(p => p.kind === 'ai') : people;
