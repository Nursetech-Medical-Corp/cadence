// ClickUp-style repeat editor: presets, weekday picker, monthly by date or weekday position,
// schedule vs after completion, skip weekends, end conditions, and a calendar preview of upcoming dates.
import {useState} from 'react';
import {Repeat} from 'lucide-react';
import type {Recur} from './types.ts';
import {addDays, iso, parseDay} from './dates.ts';
import {describeRecur, nthOfMonth, upcoming} from './recur.ts';
import {Popover} from './components.tsx';

const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORD = ['1st', '2nd', '3rd', '4th', 'last'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function RecurEditor({value, onChange, due, today, onDue}: {
  value: Recur | null; onChange: (r: Recur | null) => void; due: string | null; today: string; onDue: (d: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = due ?? today;
  const [draft, setDraft] = useState<Recur>(value ?? {every: 1, unit: 'week', mode: 'schedule', weekdays: [parseDay(anchor).getDay()]});
  const set = (patch: Partial<Recur>) => setDraft(d => ({...d, ...patch, spawned: undefined}));
  const openEditor = () => { setDraft(value ?? {every: 1, unit: 'week', mode: 'schedule', weekdays: [parseDay(anchor).getDay()]}); setOpen(true); };
  const preset = (name: string) => {
    const wd = parseDay(anchor).getDay();
    const base = {mode: draft.mode, until: draft.until, count: draft.count, reopen: draft.reopen, copySubitems: draft.copySubitems};
    if (name === 'daily') setDraft({...base, every: 1, unit: 'day'});
    if (name === 'weekdays') setDraft({...base, every: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5]});
    if (name === 'weekly') setDraft({...base, every: 1, unit: 'week', weekdays: [wd]});
    if (name === 'biweekly') setDraft({...base, every: 2, unit: 'week', weekdays: [wd]});
    if (name === 'monthly') setDraft({...base, every: 1, unit: 'month', monthBy: 'day'});
    if (name === 'quarterly') setDraft({...base, every: 3, unit: 'month', monthBy: 'day'});
    if (name === 'semiannual') setDraft({...base, every: 6, unit: 'month', monthBy: 'day'});
    if (name === 'yearly') setDraft({...base, every: 1, unit: 'year'});
    if (name === '2y') setDraft({...base, every: 2, unit: 'year'});
    if (name === '3y') setDraft({...base, every: 3, unit: 'year'});
    if (name === '5y') setDraft({...base, every: 5, unit: 'year'});
  };
  const next = upcoming(draft, anchor, 12);
  const endMode = draft.until ? 'until' : draft.count ? 'count' : 'never';

  return (
    <span className="picker">
      <button className={'cell-btn' + (value ? '' : ' muted')} onClick={() => open ? setOpen(false) : openEditor()}>
        <Repeat size={13} /> {value ? describeRecur(value, due) : 'Make it repeat'}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide recur-pop">
        <div className="recur-grid">
          <div>
            <div className="pop-label">Repeat</div>
            <div className="chips">
              {[['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['semiannual', 'Twice a year'], ['yearly', 'Yearly'], ['2y', 'Every 2 years'], ['3y', 'Every 3 years'], ['5y', 'Every 5 years']].map(([k, l]) =>
                <button key={k} className="btn" onClick={() => preset(k)}>{l}</button>)}
            </div>
            <div className="recur-row">
              Every <input className="inline num tiny" type="number" min={1} value={draft.every} onChange={e => set({every: Math.max(1, Number(e.target.value) || 1)})} />
              <select className="plain-select" value={draft.unit} onChange={e => set({unit: e.target.value as Recur['unit']})}>
                <option value="day">{draft.every === 1 ? 'day' : 'days'}</option><option value="week">{draft.every === 1 ? 'week' : 'weeks'}</option>
                <option value="month">{draft.every === 1 ? 'month' : 'months'}</option><option value="year">{draft.every === 1 ? 'year' : 'years'}</option>
              </select>
            </div>
            {draft.unit === 'week' && (
              <div className="recur-row">On
                <div className="weekdays">{WD.map((w, n) => (
                  <button key={n} className={draft.weekdays?.includes(n) ? 'on' : ''} title={DAY_NAMES[n]}
                    onClick={() => { const cur = draft.weekdays ?? []; const nextDays = cur.includes(n) ? cur.filter(x => x !== n) : [...cur, n]; set({weekdays: nextDays.length ? nextDays : [n]}); }}>{w}</button>
                ))}</div>
              </div>
            )}
            {draft.unit === 'month' && (
              <div className="recur-row">
                <select className="plain-select" value={draft.monthBy ?? 'day'} onChange={e => set({monthBy: e.target.value as Recur['monthBy']})}>
                  <option value="day">On day {parseDay(anchor).getDate()}</option>
                  <option value="nth">On the {ORD[nthOfMonth(anchor) - 1]} {DAY_NAMES[parseDay(anchor).getDay()]}</option>
                </select>
                <span className="muted small">(based on the due date)</span>
              </div>
            )}
            <div className="pop-label">Next one is created</div>
            <div className="seg">
              <button className={draft.mode === 'schedule' ? 'on' : ''} onClick={() => set({mode: 'schedule'})}>On schedule</button>
              <button className={draft.mode === 'completion' ? 'on' : ''} onClick={() => set({mode: 'completion'})}>After I complete it</button>
            </div>
            <label className="recur-check"><input type="checkbox" checked={!!draft.skipWeekends} onChange={e => set({skipWeekends: e.target.checked})} /> Skip weekends</label>
            <label className="recur-check"><input type="checkbox" checked={!!draft.reopen} onChange={e => set({reopen: e.target.checked})} /> Reopen this item instead of creating a new one</label>
            {!draft.reopen && <label className="recur-check"><input type="checkbox" checked={!!draft.copySubitems} onChange={e => set({copySubitems: e.target.checked})} /> Copy subitems into each new one</label>}
            <div className="pop-label">Ends</div>
            <div className="recur-row">
              <select className="plain-select" value={endMode} onChange={e => set(e.target.value === 'never' ? {until: null, count: null} : e.target.value === 'until' ? {until: addDays(anchor, 90), count: null} : {count: 10, until: null})}>
                <option value="never">Never</option><option value="until">On date</option><option value="count">After a number of times</option>
              </select>
              {endMode === 'until' && <input type="date" className="plain-select" value={draft.until ?? ''} onChange={e => set({until: e.target.value || null})} />}
              {endMode === 'count' && <><input className="inline num tiny" type="number" min={1} value={draft.count ?? 1} onChange={e => set({count: Math.max(1, Number(e.target.value) || 1)})} /> times</>}
            </div>
          </div>
          <MiniCalendar anchor={anchor} dates={next} today={today} onPick={d => onDue(d)} />
        </div>
        <div className="recur-foot">
          <span className="muted small grow">{describeRecur(draft, anchor)}{!due && '. No due date yet: counting from today.'}</span>
          {value && <button className="btn ghost" onClick={() => { onChange(null); setOpen(false); }}>Stop repeating</button>}
          <button className="btn primary" onClick={() => { onChange(draft); if (!due) onDue(today); setOpen(false); }}>Save</button>
        </div>
      </Popover>
    </span>
  );
}

/** Two months, due date ringed, upcoming occurrences filled. Click a day to set the due date. */
function MiniCalendar({anchor, dates, today, onPick}: {anchor: string; dates: string[]; today: string; onPick: (d: string) => void}) {
  const set = new Set(dates);
  const a = parseDay(anchor);
  const months = [new Date(a.getFullYear(), a.getMonth(), 1), new Date(a.getFullYear(), a.getMonth() + 1, 1)];
  return (
    <div className="mini-cal">
      {months.map(m => {
        const first = (m.getDay() + 7) % 7, days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
        return (
          <div key={m.getMonth()}>
            <div className="mc-title">{MONTHS[m.getMonth()]} {m.getFullYear()}</div>
            <div className="mc-grid">
              {WD.map((w, n) => <span key={'h' + n} className="mc-h">{w}</span>)}
              {Array.from({length: first}, (_, n) => <span key={'e' + n} />)}
              {Array.from({length: days}, (_, n) => {
                const d = iso(new Date(m.getFullYear(), m.getMonth(), n + 1));
                return <button key={d} className={'mc-d' + (set.has(d) ? ' hit' : '') + (d === anchor ? ' anchor' : '') + (d === today ? ' today' : '')}
                  title={set.has(d) ? 'Repeats here' : d === anchor ? 'Due date' : 'Set as due date'} onClick={() => onPick(d)}>{n + 1}</button>;
              })}
            </div>
          </div>
        );
      })}
      <div className="muted small">Next: {dates.slice(0, 4).map(d => parseDay(d).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})).join(', ') || 'none'}</div>
    </div>
  );
}
