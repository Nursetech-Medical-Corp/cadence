// Time tracking on any task: a play/stop button with a live clock in a "Time tracked" column, and a box to
// log time by duration ("3h 20m") or by start and end, with the entries grouped by person.
import {useEffect, useMemo, useState} from 'react';
import {ChevronDown, ChevronRight, Play, Square, Trash2} from 'lucide-react';
import type {Item, TimeEntry} from './types.ts';
import {api, fmtClock, fmtMinutes, useNow, type Store} from './store.ts';
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
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

/** Time since start, counting up every second. Only this re-renders while a timer runs. */
export function Elapsed({start, className}: {start: string; className?: string}) {
  const now = useNow(true);
  return <span className={className}>{fmtClock(now - Date.parse(start))}</span>;
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
        {mine ? <Elapsed start={mine.start} /> : total ? fmtMinutes(total) : compact ? null : <span className="time-add">Add time</span>}
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
          {running && <Elapsed start={running.start} className="time-live" />}
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
            {!shut && list.map(e => (
              <div key={e.id} className="time-entry">
                <span className="grow">{e.kind === 'review' && <span className="tag review-tag">review</span>} {when(e.start)}{(e.minutes ?? 0) < 10 ? `:${new Date(e.start).getSeconds().toString().padStart(2, '0')}` : ''}{e.end ? ` to ${clockOf(e.end, (e.minutes ?? 0) < 10)}` : ''}{e.note && <span className="muted"> · {e.note}</span>}</span>
                <b>{e.end ? shortSpan(e.minutes ?? 0) : <span className="time-live">running</span>}</b>
                {e.end && <button className="icon" title="Delete this entry" onClick={() => remove(e.id)}><Trash2 size={13} /></button>}
              </div>
            ))}
          </div>;
        })}
      </div>}
    </div>
  );
}
