// Routines: the Routines view of the built-in Routines space (which also has the usual table, board, timeline,
// calendar and workload views). Groups every repeating item by SOP, frequency, person, space or mode, and edits
// who, estimate, next date and mode inline.
// A routine has one live copy; finishing it makes the next. Switch one (or a whole SOP) off, delay this copy,
// skip it, make it wait for other work (a hire, a W-2 setup), or end it.
import {Fragment, useEffect, useMemo, useState} from 'react';
import {Workflow, CircleStop, Clock3, ExternalLink, Hourglass, Plus, Repeat, SkipForward} from 'lucide-react';
import type {Item, Template} from './types.ts';
import {api, type Store, realProjects} from './store.ts';
import {Avatar, DateInput, Empty, PeoplePicker, fmtHours, itemKey} from './components.tsx';
import {describeRecur, nextOccurrence, perWeek, upcoming} from './recur.ts';
import {addDays, daysBetween, monday, parseDay} from './dates.ts';
import {useTemplates} from './SettingsExtras.tsx';
import type {ViewProps} from './viewProps.ts';
import {peopleFor} from './RoutineControls.tsx';

const MODES = ['auto-job', 'hybrid', 'manual'] as const;
export type Mode = typeof MODES[number] | 'unset';
const MODE_LABEL: Record<Mode, string> = {'auto-job': 'Auto job', hybrid: 'Hybrid', manual: 'Manual', unset: 'Not set'};
const MODE_TIP: Record<Mode, string> = {
  'auto-job': 'A job runs it. A person checks the output and approves.',
  hybrid: 'A job drafts it. A person reviews, fixes and sends.',
  manual: 'A person does it.',
  unset: 'Tag it auto-job, hybrid or manual.',
};
export const modeOf = (i: Item): Mode => (MODES.find(m => i.tags.includes(m)) ?? (i.fields.worker === 'ai' ? 'auto-job' : 'unset'));
export const sopOf = (i: Item) => i.tags.find(t => /^sop-/i.test(t))?.toUpperCase() ?? 'No SOP';
type State = 'on' | 'paused' | 'waiting' | 'delayed';
const stateOf = (i: Item): State => i.recur?.paused ? 'paused' : i.recur?.waiting ? 'waiting' : i.recur?.slot ? 'delayed' : 'on';
const live = (i: Item) => stateOf(i) === 'on' || stateOf(i) === 'delayed';
const hoursWeek = (list: Item[]) => list.filter(live).reduce((h, i) => h + (i.estimate ?? 0) * perWeek(i.recur!), 0);
const sopNum = (s: string) => s === 'No SOP' ? [999] : s.replace(/^SOP-/, '').split('.').map(x => Number(x) || 0);
const bySop = (a: string, b: string) => { const x = sopNum(a), y = sopNum(b); for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] ?? 0) !== (y[k] ?? 0)) return (x[k] ?? 0) - (y[k] ?? 0); return a.localeCompare(b); };
const months = (i: Item) => { const r = i.recur!; return r.unit === 'month' ? r.every : r.unit === 'year' ? 12 * r.every : 0; };
const OFTEN: [string, (i: Item) => boolean][] = [
  ['Daily', i => i.recur!.unit === 'day' || (i.recur!.unit === 'week' && (i.recur!.weekdays?.length ?? 0) >= 5)],
  ['Weekly', i => i.recur!.unit === 'week' && i.recur!.every === 1 && (i.recur!.weekdays?.length ?? 0) < 5],
  ['Every 2 weeks', i => i.recur!.unit === 'week' && i.recur!.every >= 2],
  ['Monthly', i => months(i) >= 1 && months(i) < 3],
  ['Quarterly', i => months(i) >= 3 && months(i) < 12],
  ['Yearly', i => months(i) >= 12],
];
/** This copy's date and the dates after it, honoring a delayed copy's original slot. */
export function routineDates(i: Item, until: string, max = 400): string[] {
  const r = i.recur; if (!r || !i.due || r.paused || r.waiting) return [];
  const out = [i.due];
  const anchor = r.slot ?? i.due;
  for (const d of upcoming(r, anchor, max)) { if (d > until) break; if (d > i.due) out.push(d); }
  return out;
}
export const nextAfter = (i: Item) => i.recur && i.due ? nextOccurrence(i.recur, i.recur.slot ?? i.due, i.recur.slot ?? i.due) : null;

/** One line of what is going on with a routine. */
export function routineNote(i: Item, items: Map<string, Item>, projects: Store['projects']) {
  const s = stateOf(i);
  if (s === 'paused') return 'Paused';
  if (s === 'waiting') return 'Waiting on ' + i.deps.map(d => items.get(d)).filter(d => d && !d.completed).map(d => itemKey(d!, projects)).join(', ');
  if (s === 'delayed') return `Delayed from ${i.recur!.slot}`;
  return null;
}

export function useSopLinks(store: Store) {
  const [links, setLinks] = useState<Record<string, string>>({});
  useEffect(() => { api<{code: string; url: string}[]>('/sops').then(l => setLinks(Object.fromEntries(l.map(x => [x.code, x.url])))).catch(() => {}); }, [store.tick]);
  return (code: string) => links[code.toUpperCase()] ?? (code !== 'No SOP' ? links['*'] : undefined);
}

type Group = 'sop' | 'often' | 'person' | 'space' | 'mode';

/** Summary band at the top of the Routines space: what is on, waiting, paused, and the hours it all takes. */
export function RoutineSummary({items}: {items: Item[]}) {
  const all = items.filter(i => i.recur && !i.recur.spawned && !i.completed);
  const counts = {on: all.filter(i => live(i)).length, paused: all.filter(i => stateOf(i) === 'paused').length, waiting: all.filter(i => stateOf(i) === 'waiting').length};
  return <div className="routine-summary">
    <div className="routine-stats">
      <div title="Routines that are on (including delayed copies)"><b>{counts.on}</b><span>on</span></div>
      <div title="Waiting for other work, like a hire"><b>{counts.waiting}</b><span>waiting</span></div>
      <div title="Switched off; history kept"><b>{counts.paused}</b><span>paused</span></div>
      <div title="Estimate times how often each comes back, for routines that are on"><b>{fmtHours(hoursWeek(all))}</b><span>per week</span></div>
      {MODES.map(m => <div key={m} title={MODE_TIP[m]}><b>{fmtHours(hoursWeek(all.filter(i => modeOf(i) === m)))}</b><span>{MODE_LABEL[m].toLowerCase()} / wk</span></div>)}
    </div>
    <p className="muted small">Every repeating task from every space. Each has one live copy; finish it and the next appears. <b>Skip</b> closes this cycle. <b>Delay</b> moves only this copy. <b>Wait</b> holds it until other work is done. <b>Switch off</b> pauses it everywhere. Auto jobs go to AI agents only (once the workspace has one).</p>
  </div>;
}

/** The Routines view (in the Routines space): routines grouped by SOP, frequency, person, space or mode, with switches and actions. */
export function RoutinesView({store, items, open}: ViewProps) {
  const all = useMemo(() => items.filter(i => i.recur && !i.recur.spawned && !i.completed).sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9')), [items]);
  const [group, setGroup] = useState<Group>(() => (localStorage.getItem('routines-group') as Group) ?? 'sop');
  const [show, setShow] = useState<Mode | 'all' | State>('all');
  const [busy, setBusy] = useState(false);
  const sopLink = useSopLinks(store);
  // Opened from a task's Routine link: scroll to that row and flash it.
  useEffect(() => {
    const focus = sessionStorage.getItem('routine-focus');
    if (!focus) return;
    sessionStorage.removeItem('routine-focus');
    setShow('all');
    let tries = 0;
    const t = setInterval(() => {
      const el = document.querySelector(`[data-rid="${focus}"]`) as HTMLElement | null;
      if (el || ++tries > 30) {
        clearInterval(t);
        if (el) { el.scrollIntoView({block: 'center', behavior: 'smooth'}); el.setAttribute('data-flash', ''); el.setAttribute('data-focus', ''); setTimeout(() => el.removeAttribute('data-flash'), 2500); }
      }
    }, 100);
    return () => clearInterval(t);
  }, []);
  const act = async (ids: string[], action: 'skip' | 'pause' | 'resume' | 'end' | 'delay' | 'wait', extra: {to?: string; on?: string[]} = {}) => {
    if (!ids.length) return;
    if (action === 'end' && !confirm(ids.length === 1 ? 'Stop repeating this? The current copy stays as a normal task.' : `Stop repeating ${ids.length} routines? Their current copies stay as normal tasks.`)) return;
    setBusy(true);
    try {
      const r = await api<{errors?: string[]} | unknown[]>('/routines/act', {method: 'POST', body: {ids, action, ...extra}});
      if (Array.isArray(r)) alert('Held for approval on the AI work page.');
      else if (r.errors?.length) alert(r.errors.join('\n'));
    } catch (e) { store.fail(e); } finally { setBusy(false); }
  };
  const delay = (i: Item) => { const to = prompt(`Delay only this copy to (YYYY-MM-DD). The next one stays on ${nextAfter(i) ?? 'schedule'}.`, i.due ? addDays(i.due, 3) : store.today); if (to) act([i.id], 'delay', {to}); };
  const wait = (i: Item) => {
    const ref = prompt('Start this routine only after which item is done? Type its key, like GEN-12 (comma for several).');
    if (!ref) return;
    const keys = ref.split(/[,\s]+/).filter(Boolean);
    const ids = keys.map(k => [...store.items.values()].find(x => itemKey(x, store.projects).toUpperCase() === k.toUpperCase())?.id ?? k);
    act([i.id], 'wait', {on: ids});
  };
  const shown = all.filter(i => show === 'all' || (['on', 'paused', 'waiting', 'delayed'].includes(show) ? stateOf(i) === show : modeOf(i) === show));
  const nameOf = (id: string) => store.people.find(p => p.id === id)?.name ?? 'Unknown';
  const groups: [string, Item[]][] = (() => {
    const by = (f: (i: Item) => string[]) => { const m = new Map<string, Item[]>(); for (const i of shown) for (const k of f(i)) m.set(k, [...(m.get(k) ?? []), i]); return [...m]; };
    if (group === 'often') return OFTEN.map(([l, t]) => [l, shown.filter(t)] as [string, Item[]]).filter(([, l]) => l.length);
    if (group === 'person') return by(i => i.assignees.length ? i.assignees.map(nameOf) : ['Unassigned']).sort((a, b) => a[0].localeCompare(b[0]));
    if (group === 'space') return by(i => [store.projects.find(p => p.id === i.projectId)?.name ?? '']).sort((a, b) => a[0].localeCompare(b[0]));
    if (group === 'mode') return by(i => [MODE_LABEL[modeOf(i)]]);
    return by(i => [sopOf(i)]).sort((a, b) => bySop(a[0], b[0]));
  })();
  return (
    <div className="page routines-page" style={{maxWidth: 1320}}>
      <div className="toolbar" style={{padding: '0 0 8px', border: 0, gap: 6, flexWrap: 'wrap'}}>
        <span className="small muted">Group</span>
        <select className="plain-select" value={group} onChange={e => { setGroup(e.target.value as Group); localStorage.setItem('routines-group', e.target.value); }}>
          <option value="sop">By SOP</option><option value="often">By how often</option><option value="person">By person</option><option value="space">By space</option><option value="mode">By mode</option>
        </select>
        {(['all', 'on', 'waiting', 'paused', ...MODES] as const).map(k => <button key={k} className={'chip-toggle' + (show === k ? ' on' : '')} onClick={() => setShow(k)}>{k === 'all' ? 'All' : k === 'on' ? 'On' : k === 'waiting' ? 'Waiting' : k === 'paused' ? 'Paused' : MODE_LABEL[k]}</button>)}
      </div>
      <RoutineList store={store} groups={groups} group={group} open={open} busy={busy} act={act} delay={delay} wait={wait} sopLink={sopLink} />
      {!all.length && <Empty title="No routines yet">Add some from below, or open any item and press Make it repeat.</Empty>}
      <AddFromTemplate store={store} open={open} />
    </div>
  );
}

function RoutineList({store, groups, group, open, busy, act, delay, wait, sopLink}: {store: Store; groups: [string, Item[]][]; group: Group; open: (id: string) => void; busy: boolean;
  act: (ids: string[], a: 'skip' | 'pause' | 'resume' | 'end') => void; delay: (i: Item) => void; wait: (i: Item) => void; sopLink: (code: string) => string | undefined}) {
  // Auto jobs are run by AI agents, so switching to Auto job drops people from the assignees.
  const setMode = (i: Item, m: Mode) => store.updateItem(i.id, {tags: [...i.tags.filter(t => !(MODES as readonly string[]).includes(t)), ...(m === 'unset' ? [] : [m])],
    ...(m === 'auto-job' && store.people.some(p => p.kind === 'ai') ? {assignees: i.assignees.filter(a => store.people.find(p => p.id === a)?.kind === 'ai')} : {})});
  return (
    <div className="routine-table">
      <div className="rt-row rt-head small muted">
        <span /><span>Routine</span><span>Mode</span><span>Repeats</span><span>Who reviews or does it</span><span>Est.</span><span>This one</span><span>Then</span><span>Per wk</span><span />
      </div>
      {groups.map(([label, list]) => {
        const on = list.filter(i => !i.recur!.paused);
        const link = group === 'sop' ? sopLink(label) : undefined;
        return <Fragment key={label}>
          <div className="rt-group">
            {group === 'sop' && <button className={'switch' + (on.length ? ' on' : '')} disabled={busy} title={on.length ? `Pause all ${list.length} in ${label}` : `Turn on all ${list.length} in ${label}`}
              onClick={() => act((on.length ? on : list).map(i => i.id), on.length ? 'pause' : 'resume')} />}
            <b>{label}</b> <span className="count">{list.length}</span>
            {link && <a className="small" href={link} target="_blank" rel="noreferrer" title="Open the SOP"><ExternalLink size={12} /> SOP</a>}
            {group === 'sop' && /^SOP-/i.test(label) && <button className="small link" title="Open this SOP's whiteboard (made the first time from its routines, in order)" onClick={async () => {
              try { const b = await api<{id: string}>('/boards/from-items', {method: 'POST', body: {routines: true, tag: label}}); location.hash = `/boards/${b.id}`; } catch (e) { store.fail(e); } }}><Workflow size={12} /> Whiteboard</button>}
            <span className="muted small" style={{marginLeft: 'auto'}}>{fmtHours(hoursWeek(list))} / week</span>
          </div>
          {list.map(i => {
            const s = stateOf(i), m = modeOf(i), note = routineNote(i, store.items, store.projects);
            const sop = sopOf(i), href = sopLink(sop);
            return (
              <div key={i.id} data-rid={i.id} className={'rt-row routine-row' + (s === 'paused' || s === 'waiting' ? ' paused' : '')}>
                <button className={'switch' + (s === 'paused' ? '' : ' on')} disabled={busy} title={s === 'paused' ? 'Off. Turn on to schedule the next one.' : 'On. Turn off to pause it.'} onClick={() => act([i.id], s === 'paused' ? 'resume' : 'pause')} />
                <span className="rt-title">
                  <span className="grow" style={{cursor: 'pointer'}} onClick={() => open(i.id)} title={i.title}>{i.title}</span>
                  <span className="muted small">{itemKey(i, store.projects)}{group !== 'sop' && sop !== 'No SOP' && <> · {href ? <a href={href} target="_blank" rel="noreferrer">{sop}</a> : sop}</>}{note && <> · <span className={'rt-note ' + s}>{note}</span></>}</span>
                </span>
                <select className={'plain-select mode-chip mode-' + m} title={MODE_TIP[m]} value={m} onChange={e => setMode(i, e.target.value as Mode)}>
                  {[...MODES, 'unset' as const].map(x => <option key={x} value={x}>{MODE_LABEL[x]}</option>)}
                </select>
                <span className="muted small rt-rule" title={describeRecur(i.recur!, i.due)}>{describeRecur(i.recur!, i.due)}</span>
                <span className="rt-who">{i.assignees.length ? null : <span className="muted small">Nobody</span>}<PeoplePicker compact value={i.assignees} people={peopleFor(i, store.people)} onChange={assignees => store.updateItem(i.id, {assignees})} /></span>
                <input className="plain-input rt-est" type="number" min={0} step={0.25} title="Hours per copy (review time for auto jobs)" defaultValue={i.estimate ?? ''} key={i.id + String(i.estimate)}
                  onBlur={e => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== i.estimate) store.updateItem(i.id, {estimate: v}); }} />
                <DateInput value={i.due} today={store.today} onChange={due => store.updateItem(i.id, {due})} />
                <span className="muted small" title="The date after this one">{live(i) && nextAfter(i) ? parseDay(nextAfter(i)!).toLocaleDateString() : ''}</span>
                <span className="muted small">{live(i) && i.estimate ? fmtHours(i.estimate * perWeek(i.recur!)) : '-'}</span>
                <span className="routine-actions">
                  {live(i) && <button className="icon" disabled={busy} title="Skip this one: done for this cycle without doing it; moves to the next date" onClick={() => act([i.id], 'skip')}><SkipForward size={13} /></button>}
                  {live(i) && <button className="icon" disabled={busy} title="Delay only this copy; the next stays on schedule" onClick={() => delay(i)}><Clock3 size={13} /></button>}
                  <button className="icon" disabled={busy} title={s === 'waiting' ? 'Waiting. Change what it waits on' : 'Wait: start only after other work is done (a hire, a W-2 setup)'} onClick={() => wait(i)}><Hourglass size={13} /></button>
                  <button className="icon" disabled={busy} title="End routine: stop repeating; this copy stays as a normal task" onClick={() => act([i.id], 'end')}><CircleStop size={13} /></button>
                </span>
              </div>
            );
          })}
        </Fragment>;
      })}
    </div>
  );
}

function AddFromTemplate({store, open}: {store: Store; open: (id: string) => void}) {
  const [templates] = useTemplates(store);
  const [project, setProject] = useState(realProjects(store.projects)[0]?.id ?? '');
  const repeatTemplates = templates.filter(t => t.kind === 'item' && (t.data as {recur?: unknown}).recur);
  const add = async (t: Template) => {
    const due = prompt(`First due date for "${t.name}" (YYYY-MM-DD)`, store.today);
    if (due === null) return;
    try { const it = await api<Item>(`/templates/${t.id}/use`, {method: 'POST', body: {projectId: project, due: due || undefined}}); open(it.id); } catch (e) { store.fail(e); }
  };
  return <>
    <h3 style={{marginTop: 28}}>Add a routine from your templates</h3>
    <div className="toolbar" style={{padding: '0 0 8px', border: 0}}>
      <span className="small muted">Into space</span>
      <select className="plain-select" value={project} onChange={e => setProject(e.target.value)}>{realProjects(store.projects).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <a className="btn ghost small" href="#/templates">More in Templates</a>
    </div>
    <div className="chips">{repeatTemplates.map(t => <button key={t.id} className="btn small" onClick={() => add(t)}><Plus size={12} /> {t.name}</button>)}</div>
  </>;
}
