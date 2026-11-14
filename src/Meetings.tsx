// Meetings on the calendar: an hour grid (week or one day) with meetings, time-blocks and synced Google events,
// and the meeting editor (time, repeat, attendees, Meet link, find a time). Saved meetings go to the organizer's
// Google calendar when they connected one (Team page, Calendar settings).
import {useEffect, useMemo, useRef, useState} from 'react';
import {CalendarClock, Repeat, Trash2, Users, Video, X} from 'lucide-react';
import type {Item, Person} from './types.ts';
import {api, type Store} from './store.ts';
import {addDays, parseDay} from './dates.ts';

export type Attendee = {person: string | null; email: string | null; name?: string | null; response: string; optional?: boolean};
export type CalEvent = {id: string; projectId: string | null; itemId: string | null; kind: 'meeting' | 'timeblock' | 'deadline'; title: string; body: string; location: string;
  meetUrl: string | null; start: string; end: string; allDay: boolean; tz: string; rrule: string | null; recurringId: string | null; originalStart: string | null;
  organizer: string; visibility: string; attendees: Attendee[]; source: 'cadence' | 'google'; readonly: boolean; occurrenceOf?: string;
  google?: {ok: boolean; skipped?: string; error?: string} | null; color?: string | null; googleUrl?: string | null};

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toIso = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
const HOUR = 44; // px per hour

/** Events between two days, refetched when meetings change anywhere. */
export function useMeetings(store: Store, from: string, to: string, projectId?: string) {
  const [list, setList] = useState<CalEvent[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<CalEvent[]>(`/meetings?from=${addDays(from, -1)}&to=${addDays(to, 1)}&mine=1${projectId ? `&project=${projectId}` : ''}`)
      .then(r => { if (live) { setList(r); setError(''); } }).catch(e => live && setError(String(e instanceof Error ? e.message : e)));
    return () => { live = false; };
  }, [from, to, projectId, store.calTick, store.me]);
  return {list, error};
}

/** Week or day with hours. Drag on empty space to schedule a meeting; drop a task to block time for it. */
export function TimeGrid({store, days, projectId, items, open, onDropTask}: {store: Store; days: string[]; projectId?: string; items: Item[]; open: (id: string) => void; onDropTask?: (itemId: string, start: string, end: string) => void}) {
  const {list, error} = useMeetings(store, days[0], days[days.length - 1], projectId);
  const [edit, setEdit] = useState<{event?: CalEvent; draft?: Partial<CalEvent>} | null>(null);
  const [drag, setDrag] = useState<{day: string; from: number; to: number} | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({top: HOUR * 7.5}); }, []);
  const timed = list.filter(e => !e.allDay), allDay = list.filter(e => e.allDay);
  const dueOn = (d: string) => items.filter(i => i.due === d && !i.completed);
  const minutesAt = (ev: React.MouseEvent | React.DragEvent, el: HTMLElement) => Math.max(0, Math.min(24 * 60 - 15, Math.floor(((ev.clientY - el.getBoundingClientRect().top) / HOUR) * 4) * 15));
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const todayStr = localDay(new Date());
  return (
    <div className="tg">
      {error && <div className="tg-err small">{error}</div>}
      <div className="tg-head" style={{gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))`}}>
        <div />
        {days.map(d => (
          <div key={d} className={'tg-day-head' + (d === todayStr ? ' today' : '')}>
            <b>{parseDay(d).toLocaleDateString(undefined, {weekday: 'short'})}</b> <span>{parseDay(d).getDate()}</span>
            <div className="tg-allday">
              {allDay.filter(e => e.start.slice(0, 10) <= d && e.end.slice(0, 10) > d).map(e => <EventChip key={e.id + e.start} e={e} people={store.people} onClick={() => setEdit({event: e})} />)}
              {dueOn(d).map(i => <div key={i.id} className="tg-due" draggable onDragStart={ev => ev.dataTransfer.setData('text/item', i.id)} onClick={() => open(i.id)} title="Task due this day. Drag onto an hour to block time for it.">{i.title}</div>)}
            </div>
          </div>
        ))}
      </div>
      <div className="tg-body" ref={scroller}>
        <div className="tg-grid" style={{gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))`, height: HOUR * 24}}>
          <div className="tg-hours">{Array.from({length: 24}, (_, h) => <div key={h} style={{height: HOUR}}>{h ? `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}` : ''}</div>)}</div>
          {days.map(d => {
            const mine = timed.filter(e => localDay(new Date(e.start)) === d);
            return (
              <div key={d} className={'tg-col' + ([0, 6].includes(parseDay(d).getDay()) ? ' weekend' : '')}
                onMouseDown={ev => { if ((ev.target as HTMLElement).closest('.tg-ev')) return; const m = minutesAt(ev, ev.currentTarget); setDrag({day: d, from: m, to: m + 30}); }}
                onMouseMove={ev => { if (drag?.day === d && ev.buttons) setDrag({...drag, to: Math.max(drag.from + 15, minutesAt(ev, ev.currentTarget) + 15)}); }}
                onMouseUp={() => { if (drag?.day === d) { const s = `${pad(Math.floor(drag.from / 60))}:${pad(drag.from % 60)}`, e = `${pad(Math.floor(drag.to / 60))}:${pad(drag.to % 60)}`; setEdit({draft: {start: toIso(d, s), end: toIso(d, e), projectId: projectId ?? null}}); setDrag(null); } }}
                onDragOver={ev => ev.preventDefault()}
                onDrop={ev => { const id = ev.dataTransfer.getData('text/item'); if (!id || !onDropTask) return; const m = minutesAt(ev, ev.currentTarget); onDropTask(id, toIso(d, `${pad(Math.floor(m / 60))}:${pad(m % 60)}`), toIso(d, `${pad(Math.floor((m + 60) / 60))}:${pad((m + 60) % 60)}`)); }}>
                {Array.from({length: 24}, (_, h) => <div key={h} className="tg-slot" style={{height: HOUR}} />)}
                {d === todayStr && <div className="tg-now" style={{top: (nowMin / 60) * HOUR}} />}
                {drag?.day === d && <div className="tg-ev draft" style={{top: (drag.from / 60) * HOUR, height: ((drag.to - drag.from) / 60) * HOUR}}>New meeting</div>}
                {layout(mine).map(({e, col, cols}) => {
                  const s = new Date(e.start), en = new Date(e.end);
                  const top = ((s.getHours() * 60 + s.getMinutes()) / 60) * HOUR, h = Math.max(18, ((en.getTime() - s.getTime()) / 3600000) * HOUR);
                  const me = e.attendees.find(a => a.person === store.me);
                  return (
                    <div key={e.id + e.start} className={`tg-ev ${e.kind}${e.readonly ? ' ro' : ''}${me?.response === 'declined' ? ' declined' : ''}`} title={`${e.title}\n${hhmm(s)} to ${hhmm(en)}`}
                      style={{top, height: h, left: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)`}} onClick={() => setEdit({event: e})}>
                      <b>{e.title}</b><span>{hhmm(s)} to {hhmm(en)}{e.rrule || e.occurrenceOf ? ' ⟳' : ''}{e.meetUrl ? ' · Meet' : ''}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {edit && <EventEditor store={store} event={edit.event} draft={edit.draft} items={items} onClose={() => setEdit(null)} open={open} />}
    </div>
  );
}

/** Side-by-side columns for overlapping events. */
function layout(list: CalEvent[]) {
  const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  const out: {e: CalEvent; col: number; cols: number}[] = [];
  let group: {e: CalEvent; col: number}[] = [], groupEnd = '';
  const flush = () => { const cols = Math.max(1, ...group.map(g => g.col + 1)); for (const g of group) out.push({...g, cols}); group = []; };
  for (const e of sorted) {
    if (group.length && e.start >= groupEnd) flush();
    const used = new Set(group.filter(g => g.e.end > e.start).map(g => g.col));
    let col = 0; while (used.has(col)) col++;
    group.push({e, col});
    groupEnd = groupEnd && groupEnd > e.end && group.length > 1 ? groupEnd : e.end > groupEnd ? e.end : groupEnd;
  }
  if (group.length) flush();
  return out;
}

function EventChip({e, people, onClick}: {e: CalEvent; people: Person[]; onClick: () => void}) {
  void people;
  return <div className={`tg-chip ${e.kind}${e.readonly ? ' ro' : ''}`} onClick={onClick} title={e.title} style={e.color && GCAL_COLORS[e.color] ? {background: GCAL_COLORS[e.color][1], color: '#fff'} : undefined}>{e.title}</div>;
}

const REPEATS: {label: string; rule: (d: Date) => string | null}[] = [
  {label: 'Does not repeat', rule: () => null},
  {label: 'Every weekday', rule: () => 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'},
  {label: 'Weekly', rule: d => `RRULE:FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()]}`},
  {label: 'Every 2 weeks', rule: d => `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()]}`},
  {label: 'Monthly (same weekday)', rule: d => `RRULE:FREQ=MONTHLY;BYDAY=${Math.ceil(d.getDate() / 7) > 4 ? -1 : Math.ceil(d.getDate() / 7)}${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()]}`},
  {label: 'Daily', rule: () => 'RRULE:FREQ=DAILY'},
];
const repeatLabel = (rule: string | null) => {
  if (!rule) return 'Does not repeat';
  if (/BYDAY=MO,TU,WE,TH,FR/.test(rule)) return 'Every weekday';
  if (/INTERVAL=2/.test(rule) && /WEEKLY/.test(rule)) return 'Every 2 weeks';
  if (/WEEKLY/.test(rule)) return 'Weekly';
  if (/MONTHLY/.test(rule)) return 'Monthly (same weekday)';
  if (/DAILY/.test(rule)) return 'Daily';
  return 'Custom';
};

/** Create or change a meeting. Repeating meetings ask: this one or all. */
/** Google Calendar's event colors (colorId 1 to 11). */
export const GCAL_COLORS: Record<string, [string, string]> = {'1': ['Lavender', '#7986cb'], '2': ['Sage', '#33b679'], '3': ['Grape', '#8e24aa'], '4': ['Flamingo', '#e67c73'], '5': ['Banana', '#f6bf26'], '6': ['Tangerine', '#f4511e'],
  '7': ['Peacock', '#039be5'], '8': ['Graphite', '#616161'], '9': ['Blueberry', '#3f51b5'], '10': ['Basil', '#0b8043'], '11': ['Tomato', '#d50000']};
export function EventEditor({store, event, draft, items, onClose, open, onSaved}: {store: Store; event?: CalEvent; draft?: Partial<CalEvent>; items: Item[]; onClose: () => void; open: (id: string) => void; onSaved?: (e: CalEvent) => void}) {
  const base = event ?? draft ?? {};
  const s0 = new Date(base.start ?? new Date(Math.ceil(Date.now() / 1800000) * 1800000).toISOString()), e0 = new Date(base.end ?? new Date(s0.getTime() + 1800000).toISOString());
  const [title, setTitle] = useState(base.title ?? '');
  const [day, setDay] = useState(localDay(s0));
  const [start, setStart] = useState(hhmm(s0));
  const [end, setEnd] = useState(hhmm(e0));
  const [allDay, setAllDay] = useState(!!base.allDay);
  const [repeat, setRepeat] = useState(repeatLabel(base.rrule ?? (event?.occurrenceOf ? 'x' : null)));
  const [rule] = useState(base.rrule ?? null);
  const [people, setPeople] = useState<string[]>((base.attendees ?? []).filter(a => a.person && a.person !== (event?.organizer ?? store.me)).map(a => a.person!));
  const [emails, setEmails] = useState((base.attendees ?? []).filter(a => !a.person && a.email).map(a => a.email).join(', '));
  const [meet, setMeet] = useState(!event);
  const [location, setLocation] = useState(base.location ?? '');
  const [notes, setNotes] = useState(base.body ?? '');
  const [itemId, setItemId] = useState(base.itemId ?? '');
  const [visibility, setVisibility] = useState(base.visibility ?? 'space');
  const [color, setColor] = useState<string | null>(base.color ?? null);
  const [scope, setScope] = useState<'one' | 'all'>(event?.occurrenceOf ? 'one' : 'all');
  const [slots, setSlots] = useState<{start: string; end: string}[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const isRepeating = !!(event?.rrule || event?.occurrenceOf);
  const canEdit = !event || (!event.readonly && (event.organizer === store.me));
  const me = event?.attendees.find(a => a.person === store.me);
  const organizer = store.people.find(p => p.id === (event?.organizer ?? store.me));
  const durationMin = Math.max(15, (new Date(toIso(day, end)).getTime() - new Date(toIso(day, start)).getTime()) / 60000);
  const attendees = useMemo(() => [...people, ...emails.split(/[,\s]+/).map(x => x.trim()).filter(x => /@/.test(x))], [people, emails]);

  const body = () => {
    const d = new Date(toIso(day, start));
    const pick = REPEATS.find(r => r.label === repeat);
    return {title: title.trim(), start: allDay ? day : toIso(day, start), end: allDay ? addDays(day, 1) : toIso(day, end), allDay, attendees,
      location, body: notes, itemId: itemId || null, visibility, color, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(repeat === 'Custom' ? {rrule: rule} : {rrule: pick ? pick.rule(d) : null}), ...(event ? {} : {meet, projectId: draft?.projectId ?? null})};
  };
  const report = (r: CalEvent) => {
    if (r.google && !r.google.ok) { setMsg(`Saved in Cadence. Google: ${r.google.error}`); setBusy(false); return false; }
    return true;
  };
  const save = async () => {
    if (!title.trim()) { setMsg('Give it a title'); return; }
    setBusy(true); setMsg('');
    try {
      const b = body();
      // All occurrences: move the series by as much as this occurrence moved, keeping its first date.
      if (event && isRepeating && scope === 'all' && !allDay) {
        const master = await api<CalEvent>(`/meetings/${event.occurrenceOf ?? event.id}`);
        const shift = new Date(b.start).getTime() - new Date(event.start).getTime(), len = new Date(b.end).getTime() - new Date(b.start).getTime();
        b.start = new Date(new Date(master.start).getTime() + shift).toISOString(); b.end = new Date(new Date(b.start).getTime() + len).toISOString();
      }
      const r = event
        ? await api<CalEvent>(`/meetings/${event.occurrenceOf ?? event.id}`, {method: 'PATCH', body: {...b, ...(scope === 'one' && isRepeating ? {rrule: undefined, scope: 'one', occurrence: event.originalStart ?? event.start} : {})}})
        : await api<CalEvent>('/meetings', {method: 'POST', body: b});
      onSaved?.(r);
      if (report(r)) onClose();
    } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); setBusy(false); }
  };
  const remove = async () => {
    if (!event) return;
    if (!confirm(isRepeating && scope === 'all' ? 'Cancel every occurrence? Attendees are told.' : 'Cancel this meeting? Attendees are told.')) return;
    setBusy(true);
    try {
      const q = isRepeating && scope === 'one' ? `?scope=one&occurrence=${encodeURIComponent(event.originalStart ?? event.start)}` : '';
      await api(`/meetings/${event.occurrenceOf ?? event.id}${q}`, {method: 'DELETE'});
      onClose();
    } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); setBusy(false); }
  };
  const answer = async (response: string) => { try { await api(`/meetings/${event!.occurrenceOf ?? event!.id}`, {method: 'PATCH', body: {response}}); onClose(); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } };
  const findTime = async () => {
    setMsg(''); setSlots(null);
    try { const r = await api<{slots: {start: string; end: string}[]}>('/meetings/free', {method: 'POST', body: {attendees, duration: durationMin, from: day, to: addDays(day, 13), max: 6}}); setSlots(r.slots); if (!r.slots.length) setMsg('No common free time in the next 2 weeks inside your work hours.'); }
    catch (e) { setMsg(String(e instanceof Error ? e.message : e)); }
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ev-editor" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
        <div className="ev-head"><CalendarClock size={16} /><b>{event ? (canEdit ? 'Meeting' : event.title) : 'New meeting'}</b><span className="spacer" /><button className="icon" onClick={onClose} title="Close"><X size={16} /></button></div>
        {!canEdit && event && <p className="small muted">{event.readonly ? 'From someone else\'s Google calendar. Change it there.' : `Organized by ${organizer?.name ?? 'someone else'}.`}</p>}
        {canEdit && <input autoFocus className="ev-title" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); }} />}
        <div className="ev-row">
          <input type="date" value={day} disabled={!canEdit} onChange={e => setDay(e.target.value)} />
          {!allDay && <><input type="time" step={900} value={start} disabled={!canEdit} onChange={e => { const d = durationMin; setStart(e.target.value); const t = new Date(toIso(day, e.target.value)).getTime() + d * 60000; setEnd(hhmm(new Date(t))); }} />
            <span className="muted">to</span><input type="time" step={900} value={end} disabled={!canEdit} onChange={e => setEnd(e.target.value)} /></>}
          <label className="small"><input type="checkbox" checked={allDay} disabled={!canEdit} onChange={e => setAllDay(e.target.checked)} /> All day</label>
        </div>
        <div className="ev-row"><Repeat size={14} />
          <select className="plain-select" value={repeat} disabled={!canEdit || (isRepeating && scope === 'one')} onChange={e => setRepeat(e.target.value)}>
            {[...REPEATS.map(r => r.label), ...(repeat === 'Custom' ? ['Custom'] : [])].map(l => <option key={l}>{l}</option>)}
          </select>
          {isRepeating && canEdit && <div className="seg"><button className={scope === 'one' ? 'on' : ''} onClick={() => setScope('one')}>This one</button><button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All</button></div>}
        </div>
        <div className="ev-row ev-people"><Users size={14} />
          <div className="ev-people-list">
            {store.people.filter(p => p.id !== (event?.organizer ?? store.me)).map(p => (
              <label key={p.id} className={'ev-person' + (people.includes(p.id) ? ' on' : '')}>
                <input type="checkbox" disabled={!canEdit} checked={people.includes(p.id)} onChange={e => setPeople(e.target.checked ? [...people, p.id] : people.filter(x => x !== p.id))} />
                {p.name}{event && (() => { const a = event.attendees.find(x => x.person === p.id); return a ? <span className={'ev-resp ' + a.response}>{a.response === 'needsAction' ? '?' : a.response}</span> : null; })()}
              </label>
            ))}
          </div>
        </div>
        <input className="plain-select ev-wide" placeholder="Guests outside Cadence: emails, comma separated" value={emails} disabled={!canEdit} onChange={e => setEmails(e.target.value)} />
        {canEdit && <div className="ev-row"><button className="btn small" onClick={findTime} disabled={busy}>Find a time</button>
          {slots?.map(s => <button key={s.start} className="btn small ghost" onClick={() => { const a = new Date(s.start), b = new Date(s.end); setDay(localDay(a)); setStart(hhmm(a)); setEnd(hhmm(b)); setSlots(null); }}>
            {new Date(s.start).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}</button>)}</div>}
        <div className="ev-row"><Video size={14} />
          {event?.meetUrl ? <a href={event.meetUrl} target="_blank" rel="noreferrer">{event.meetUrl}</a>
            : !event ? <label className="small"><input type="checkbox" checked={meet} onChange={e => setMeet(e.target.checked)} /> Add a Google Meet link (needs Google Calendar connected)</label> : <span className="small muted">No video link</span>}
        </div>
        <div className="ev-row"><span className="small muted">Color</span>
          <button className={'ev-color' + (!color ? ' on' : '')} title="Calendar color" disabled={!canEdit} onClick={() => setColor(null)} style={{background: 'var(--line)'}} />
          {Object.entries(GCAL_COLORS).map(([id, [name, hex]]) => <button key={id} className={'ev-color' + (color === id ? ' on' : '')} title={name} disabled={!canEdit} onClick={() => setColor(id)} style={{background: hex}} />)}
          {event?.googleUrl && <a className="btn small ghost" href={event.googleUrl} target="_blank" rel="noreferrer" title="Open it in Google Calendar for everything Google offers there">Open in Google Calendar</a>}
        </div>
        <input className="plain-select ev-wide" placeholder="Location" value={location} disabled={!canEdit} onChange={e => setLocation(e.target.value)} />
        <textarea className="comment-box ev-wide" placeholder="Agenda or notes" value={notes} disabled={!canEdit} onChange={e => setNotes(e.target.value)} />
        <div className="ev-row">
          <span className="small muted">Linked task</span>
          <select className="plain-select" value={itemId} disabled={!canEdit} onChange={e => setItemId(e.target.value)}>
            <option value="">None</option>
            {items.filter(i => !i.completed || i.id === itemId).slice(0, 300).map(i => <option key={i.id} value={i.id}>{i.title.slice(0, 60)}</option>)}
          </select>
          {itemId && <button className="btn small ghost" onClick={() => { onClose(); open(itemId); }}>Open</button>}
          <select className="plain-select" value={visibility} disabled={!canEdit} onChange={e => setVisibility(e.target.value)} title="Who sees it in Cadence">
            <option value="space">Everyone in the space</option><option value="attendees">Attendees only</option><option value="private">Only me</option>
          </select>
        </div>
        {msg && <div className="small ev-msg">{msg}</div>}
        <div className="ev-actions">
          {event && canEdit && <button className="btn danger ghost" onClick={remove} disabled={busy}><Trash2 size={13} /> Cancel meeting</button>}
          {me && event && event.organizer !== store.me && !event.readonly && <>
            <span className="small muted">Going?</span>
            {(['accepted', 'tentative', 'declined'] as const).map(r => <button key={r} className={'btn small' + (me.response === r ? ' primary' : '')} onClick={() => answer(r)}>{r === 'accepted' ? 'Yes' : r === 'tentative' ? 'Maybe' : 'No'}</button>)}
          </>}
          <span className="spacer" />
          {canEdit && <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving...' : event ? 'Save' : 'Schedule'}</button>}
        </div>
      </div>
    </div>
  );
}
