// Time tracking on any task: a play/stop button with a live clock in a "Time tracked" column, and a box to
// log time by duration ("3h 20m") or by start and end, with the entries grouped by person.
import {useEffect, useMemo, useState} from 'react';
import {ChevronDown, ChevronRight, Pencil, Play, Square, Trash2} from 'lucide-react';
import type {Item, TimeEntry} from './types.ts';
import {api, fmtClock, fmtMinutes, useSharedNow, type Store} from './store.ts';
import {parseDuration} from './dates.ts';
import {Avatar, Popover} from './components.tsx';

export {parseDuration};

const pad = (n: number) => String(n).padStart(2, '0');
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const label = (hhmm: string) => { const m = toMin(hhmm), h = Math.floor(m / 60); return `${h % 12 || 12}:${pad(m % 60)} ${h < 12 ? 'am' : 'pm'}`; };
const QUARTERS = Array.from({length: 96}, (_, n) => toHHMM(n * 15));
const nowHHMM = () => { const d = new Date(); return toHHMM(Math.floor((d.getHours() * 60 + d.getMinutes()) / 15) * 15); };
/** Short spans show seconds (timers record them); totals elsewhere round down to minutes. */
const shortSpan = (min: number) => min < 1 ? `${Math.round(min * 60)}s` : fmtMinutes(min);
const clockOf = (iso: string, secs: boolean) => new Date(iso).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit', ...(secs ? {second: '2-digit'} : {})});
const when = (iso: string, secs = false) => new Date(iso).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(secs ? {second: '2-digit'} : {})});
const dayOnly = (iso: string) => new Date(iso).toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
/** An entry added as minutes has no start and stop time (its end is its start). */
export const addedAsMinutes = (e: TimeEntry) => !!e.end && e.end === e.start;
/** How an entry reads in a list: day and times (seconds for short timer runs), or the day for one added as minutes. */
export const entryWhen = (e: TimeEntry) => {
  if (addedAsMinutes(e)) return `${dayOnly(e.start)}, added as time`;
  const secs = !!e.end && (e.minutes ?? 0) < 10;
  return `${when(e.start, secs)}${e.end ? ` to ${clockOf(e.end, secs)}` : ''}`;
};
const localParts = (iso: string) => { const d = new Date(iso); return {date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`}; };

/**
 * Edit one time entry in place: a timed entry by day, start and end; an entry added as minutes by day and length;
 * a running timer by its start. A time left as it was keeps the seconds the timer recorded.
 */
export function TimeEntryEdit({entry, onDone}: {entry: TimeEntry; onDone: (saved: boolean) => void}) {
  const byHand = addedAsMinutes(entry), running = !entry.end;
  const s0 = localParts(entry.start), e0 = entry.end ? localParts(entry.end) : null;
  const [date, setDate] = useState(s0.date), [from, setFrom] = useState(s0.time), [to, setTo] = useState(e0?.time ?? '');
  const [dur, setDur] = useState(byHand ? fmtMinutes(entry.minutes ?? 0) : ''), [note, setNote] = useState(entry.note ?? ''), [err, setErr] = useState('');
  const startIso = date === s0.date && from === s0.time ? entry.start : new Date(`${date}T${from}:00`).toISOString();
  // The end is on the start's day, or the next day when it is earlier than the start (past midnight).
  const endIso = running || byHand || !to ? null : date === s0.date && to === e0?.time && from === s0.time ? entry.end! : (() => {
    const e = new Date(`${date}T${to}:00`); if (e.getTime() <= Date.parse(startIso)) e.setDate(e.getDate() + 1); return e.toISOString(); })();
  const span = endIso ? (Date.parse(endIso) - Date.parse(startIso)) / 60000 : byHand ? parseDuration(dur) : 0;
  const save = async () => {
    const body: Record<string, unknown> = {start: startIso, note: note.trim() || null};
    if (byHand) { const m = parseDuration(dur); if (!(m > 0 && m <= 1440)) { setErr('Enter a time like 1h 20m'); return; } body.minutes = m; }
    else if (!running) { if (!endIso) { setErr('Pick an end time'); return; } body.end = endIso; }
    try { await api(`/time/${entry.id}`, {method: 'PATCH', body}); onDone(true); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const keys = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } if (e.key === 'Escape') { e.stopPropagation(); onDone(false); } };
  return <div className="time-edit" onKeyDown={keys}>
    <div className="time-when">
      <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} title="Day" />
      <input type="time" value={from} onChange={e => e.target.value && setFrom(e.target.value)} title="Start" />
      {!running && !byHand && <><span className="muted">to</span><input type="time" value={to} onChange={e => setTo(e.target.value)} title="End" /></>}
      {byHand && <input className="time-dur-in" value={dur} onChange={e => setDur(e.target.value)} placeholder="1h 20m" title="How long" />}
      {running ? <span className="muted small">running</span> : span > 0 && !byHand ? <span className="muted small">{shortSpan(span)}</span> : null}
    </div>
    <input className="time-note" placeholder="Notes" value={note} onChange={e => setNote(e.target.value)} />
    {err && <div className="small" style={{color: 'var(--danger)'}}>{err}</div>}
    <div className="time-actions"><button className="btn ghost small" onClick={() => onDone(false)}>Cancel</button><button className="btn primary small" onClick={save}>Save</button></div>
  </div>;
}

/** Time since start, counting up every second. Only this re-renders while a timer runs. */
export function Elapsed({start, className}: {start: string; className?: string}) {
  const now = useSharedNow(true, start);
  return <span className={className}>{fmtClock(now - Date.parse(start))}</span>;
}

/** The one clock for a task, used everywhere (focus bar, pop-out, focus view, top bar, task panel, lists). Every place
 *  reads the same running timer (store.running) and the same app clock (useSharedNow), so they always agree and a start
 *  or stop anywhere changes them all. The big number is this run; the total on the task (this run included) sits beside
 *  or below it (total: 'below', 'beside' or 'hidden'). With no timer running it shows the total. */
export function TaskClock({store, itemId, className, total = 'beside'}: {store: Store; itemId: string; className?: string; total?: 'below' | 'beside' | 'hidden'}) {
  const run = store.running?.itemId === itemId ? store.running : null;
  const now = useSharedNow(!!run, run?.start);
  const before = store.timeTotals.get(itemId) ?? 0;
  const session = run ? Math.max(0, now - Date.parse(run.start)) : 0;
  const sum = fmtClock(before * 60000 + session);
  if (!run) return <span className={className} title="Total on the task">{sum}</span>;
  return <span className={'task-clock ' + total + (className ? ' ' + className : '')} title={`This run ${fmtClock(session)}. Total on the task ${sum}`}>
    <span className="tc-run">{fmtClock(session)}</span>{total !== 'hidden' && <span className="tc-total">{total === 'below' ? `Total on the task ${sum}` : `total ${sum}`}</span>}
  </span>;
}

/** Time on the task against its estimate, as a bar: accent while under 80%, amber from 80%, red once past the estimate
 *  (the overrun is shown). The same component in the focus view and the pop-out. */
export function TimeProgress({store, itemId, compact}: {store: Store; itemId: string; compact?: boolean}) {
  const item = store.items.get(itemId);
  const run = store.running?.itemId === itemId ? store.running : null;
  const now = useSharedNow(!!run, run?.start);
  const est = (item?.estimate ?? 0) * 60;
  if (!est) return compact ? null : <div className="tp none"><div className="tp-bar"><span style={{width: 0}} /></div><span className="tp-label">No estimate. Set one on the task to see progress.</span></div>;
  const logged = (store.timeTotals.get(itemId) ?? 0) + (run ? Math.max(0, now - Date.parse(run.start)) / 60000 : 0);
  const ratio = logged / est, level = ratio > 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok';
  const left = est - logged;
  return <div className={'tp ' + level + (compact ? ' compact' : '')} title={`${fmtMinutes(Math.round(logged))} of the ${fmtMinutes(est)} estimate (${Math.round(ratio * 100)}%)`}>
    <div className="tp-bar"><span style={{width: `${Math.min(100, ratio * 100)}%`}} /></div>
    <span className="tp-label">{left >= 0 ? `${fmtMinutes(Math.round(left))} left of ${fmtMinutes(est)}` : `${fmtMinutes(Math.round(-left))} over ${fmtMinutes(est)}`}</span>
  </div>;
}

/** Table and list cell: play or stop, then the total (or the running clock). Click the total for the full box. */
/** compact: with no time yet, only a play button that shows on hover (board cards, list rows). */
export function TimeCell({item, store, compact}: {item: Item; store: Store; compact?: boolean}) {
  const mine = store.running?.itemId === item.id ? store.running : null;
  const total = store.timeTotals.get(item.id) ?? 0;
  const [open, setOpen] = useState(false);
  if (!store.settings.features.timeTracking) return null;
  return (
    <span className={'picker time-cell' + (compact && !mine && !total ? ' idle' : '')} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      <button className={'time-play' + (mine ? ' on' : '')} title={mine ? 'Stop timer' : 'Start timer'}
        onClick={e => { e.stopPropagation(); if (mine) store.stopTimer(); else store.startTimer(item.id); }}>
        {mine ? <Square size={8} fill="currentColor" /> : <Play size={9} fill="currentColor" />}
      </button>
      <button data-pop-trigger className={'time-total' + (mine ? ' on' : '')} onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
        {mine ? <TaskClock store={store} itemId={item.id} total="hidden" /> : total ? fmtMinutes(total) : compact ? null : <span className="time-add">Add time</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="time-pop"><TimeBox item={item} store={store} /></Popover>
    </span>
  );
}

/** The full time box: totals, a timer, logging by duration or by start and end, and the entries. */
export function TimeBox({item, store}: {item: Item; store: Store}) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const load = () => api<TimeEntry[]>(`/time?itemId=${item.id}`).then(setEntries).catch(() => {});
  useEffect(() => { load(); }, [item.id]);
  useEffect(() => { const e = store.lastEvent.current; if (e?.kind === 'time' && e.itemId === item.id) load(); }, [store.tick]);
  const running = store.running?.itemId === item.id ? store.running : null;
  const own = store.timeTotals.get(item.id) ?? 0;
  const withSubs = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const i of store.items.values()) if (i.parentId) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i.id]);
    const sum = (pid: string): number => (kids.get(pid) ?? []).reduce((a, c) => a + (store.timeTotals.get(c) ?? 0) + sum(c), 0);
    return own + sum(item.id);
  }, [store.items, store.timeTotals, item.id, own]);

  const [dur, setDur] = useState('');
  const [date, setDate] = useState(store.today);
  const [to, setTo] = useState(nowHHMM);
  const [from, setFrom] = useState(to);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const span = toMin(to) - toMin(from);
  // Typing a duration moves the start back from the end; picking times fills in the duration.
  const typeDur = (v: string) => { setDur(v); const m = parseDuration(v); if (m > 0 && m < 1440) setFrom(toHHMM(Math.max(0, toMin(to) - m))); };
  const pick = (f: string, t: string) => { setFrom(f); setTo(t); const d = toMin(t) - toMin(f); setDur(d > 0 ? fmtMinutes(d) : ''); };
  const save = async () => {
    if (Number.isNaN(parseDuration(dur)) || !(span > 0)) { setErr('Enter a time like 3h 20m, or pick a start and an end'); return; }
    try {
      await api('/time', {method: 'POST', body: {itemId: item.id, start: new Date(`${date}T${from}:00`).toISOString(), end: new Date(`${date}T${to}:00`).toISOString(), note: note.trim() || null}});
      setDur(''); setNote(''); setErr(''); const t = nowHHMM(); setTo(t); setFrom(t); load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const remove = (id: string) => api(`/time/${id}`, {method: 'DELETE'}).then(load).catch(store.fail);
  const byPerson = useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries) m.set(e.person, [...(m.get(e.person) ?? []), e]);
    return [...m.entries()];
  }, [entries]);
  const [closed, setClosed] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const times = (keep: string) => QUARTERS.includes(keep) ? QUARTERS : [...QUARTERS, keep].sort();

  return (
    <div className="time-box">
      <div className="time-head"><b>Time on this task</b><b>{fmtMinutes(own)}{item.estimate ? <span className="muted"> of {item.estimate}h</span> : null}</b></div>
      {withSubs !== own && <div className="time-head muted small"><span>With subtasks</span><span>{fmtMinutes(withSubs)}</span></div>}
      <div className="time-form">
        <div className="time-dur">
          <input placeholder="Enter time (ex: 3h 20m) or start the timer" value={running ? '' : dur} disabled={!!running} onChange={e => typeDur(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
          {running
            ? <button className="time-play on big" title="Stop timer" onClick={() => store.stopTimer()}><Square size={10} fill="currentColor" /></button>
            : <button className="time-play big" title="Start timer" onClick={() => store.startTimer(item.id)}><Play size={11} fill="currentColor" /></button>}
          {running && <TaskClock store={store} itemId={item.id} className="time-live" />}
        </div>
        <div className="time-when">
          <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} />
          <select value={from} onChange={e => pick(e.target.value, toMin(e.target.value) >= toMin(to) ? toHHMM(Math.min(1439, toMin(e.target.value) + 15)) : to)} title="Start time">
            {times(from).map(t => <option key={t} value={t}>{label(t)}</option>)}</select>
          <span className="muted">to</span>
          <select value={to} onChange={e => pick(from, e.target.value)} title="End time">
            {times(to).map(t => <option key={t} value={t} disabled={toMin(t) < toMin(from)}>{label(t)}</option>)}</select>
        </div>
        <input className="time-note" placeholder="Notes" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
        {err && <div className="small" style={{color: 'var(--danger)'}}>{err}</div>}
        <div className="time-actions"><button className="btn primary small" disabled={!!running || !(span > 0)} onClick={save}>Save</button></div>
      </div>
      {byPerson.length > 0 && <div className="time-entries">
        <div className="pop-label">Time entries</div>
        {byPerson.map(([pid, list]) => {
          const shut = closed.includes(pid), p = store.people.find(x => x.id === pid);
          return <div key={pid}>
            <button className="time-person" onClick={() => setClosed(c => shut ? c.filter(x => x !== pid) : [...c, pid])}>
              {shut ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<Avatar person={p} size={18} /><span className="grow">{p?.name ?? 'Someone'}</span>
              <b>{fmtMinutes(list.reduce((a, e) => a + (e.minutes ?? 0), 0))}</b>
            </button>
            {!shut && list.map(e => editing === e.id ? <TimeEntryEdit key={e.id} entry={e} onDone={saved => { setEditing(null); if (saved) load(); }} /> : (
              <div key={e.id} className="time-entry" onDoubleClick={() => setEditing(e.id)} title="Double-click to edit">
                <span className="grow">{e.kind === 'review' && <span className="tag review-tag">review</span>} {entryWhen(e)}{e.note && <span className="muted"> · {e.note}</span>}</span>
                <b>{e.end ? shortSpan(e.minutes ?? 0) : <span className="time-live">running</span>}</b>
                <button className="icon" title={e.end ? 'Edit this entry: day, start, end, notes' : 'Edit when this timer started'} onClick={() => setEditing(e.id)}><Pencil size={13} /></button>
                {e.end && <button className="icon" title="Delete this entry" onClick={() => remove(e.id)}><Trash2 size={13} /></button>}
              </div>
            ))}
          </div>;
        })}
      </div>}
    </div>
  );
}
