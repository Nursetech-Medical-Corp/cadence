// Focus modes for the task you are working on.
//   Focus mode: one task fills the screen, everything else goes dark. Title, notes, subitems and the timer.
//     Done stops the timer and completes the task. Esc or Exit leaves.
//   Timer bar: while a timer runs, a bar at the top of the app shows the task and the clock on every page.
//   Pop out: a small always-on-top timer window (Chrome and Edge keep it above every window and app;
//     other browsers get a normal small window). Start, stop, done and back to focus from there.
// Each person picks what happens when they start a timer (saved in their prefs, key "focus").
import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {CheckCircle2, ExternalLink, Focus as FocusIcon, Play, Settings2, Square, X} from 'lucide-react';
import {fmtClock, fmtMinutes, useNow, type Store} from './store.ts';
import {BlockEditor} from './BlockEditor.tsx';
import {Check, InlineText, Popover, itemKey} from './components.tsx';
import type {Item, Project} from './types.ts';

export type FocusPrefs = {onStart: 'none' | 'focus'; bar: boolean; popOut: boolean};
export const focusPrefs = (store: Pick<Store, 'prefs'>): FocusPrefs => ({onStart: 'none', bar: true, popOut: false, ...(store.prefs.focus as Partial<FocusPrefs> | undefined)});

const doneStatus = (p: Project) => p.statuses.find(s => s.category === 'done')?.id;
/** Stops the timer if it runs on this task, then marks the task done. */
async function finish(store: Store, item: Item) {
  if (store.running?.itemId === item.id) await store.stopTimer();
  const p = store.projects.find(x => x.id === item.projectId), done = p && doneStatus(p);
  if (done && !item.completed) store.updateItem(item.id, {status: done});
}

/** Everything focus related; mount once in the app. */
export function FocusHost({store, open}: {store: Store; open: (id: string) => void}) {
  const cfg = focusPrefs(store);
  const [pip, setPip] = useState<Window | null>(null);
  const [last, setLast] = useState<string | null>(null);

  const popOut = async () => {
    if (pip && !pip.closed) { pip.focus(); return; }
    const dpip = (window as unknown as {documentPictureInPicture?: {requestWindow: (o: {width: number; height: number}) => Promise<Window>}}).documentPictureInPicture;
    let w: Window | null = null;
    try { w = dpip ? await dpip.requestWindow({width: 380, height: 150}) : window.open('', 'cadence-timer', 'width=400,height=180,popup=yes'); }
    catch { w = window.open('', 'cadence-timer', 'width=400,height=180,popup=yes'); }
    if (!w) { store.flash('Allow pop-ups for this site to pop out the timer'); return; }
    w.document.title = 'Cadence timer';
    // Same styles as the app so the mini timer matches the theme.
    for (const ss of [...document.styleSheets]) {
      try { const st = w.document.createElement('style'); st.textContent = [...ss.cssRules].map(r => r.cssText).join('\n'); w.document.head.appendChild(st); }
      catch { if (ss.href) { const l = w.document.createElement('link'); l.rel = 'stylesheet'; l.href = ss.href; w.document.head.appendChild(l); } }
    }
    w.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
    w.document.body.className = 'pip-body';
    w.addEventListener('pagehide', () => setPip(null));
    setPip(w);
  };

  // Starting a timer anywhere: remember the task, open focus mode or the pop-out if this person wants that.
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{itemId: string}>).detail.itemId;
      setLast(id);
      if (cfg.onStart === 'focus') store.setFocusId(id);
      if (cfg.popOut) void popOut();
    };
    window.addEventListener('cadence:timer-start', on);
    return () => window.removeEventListener('cadence:timer-start', on);
  });
  useEffect(() => () => { pip?.close(); }, [pip]);
  useEffect(() => { if (store.running) setLast(store.running.itemId); }, [store.running?.itemId]);

  const focusItem = store.focusId ? store.items.get(store.focusId) : undefined;
  return <>
    {/* On document.body so they sit above the sidebar and the task panel, whatever page is open. */}
    {cfg.bar && store.running && createPortal(<TimerBar store={store} open={open} popOut={popOut} />, document.body)}
    {focusItem && createPortal(<FocusOverlay store={store} item={focusItem} close={() => store.setFocusId(null)} popOut={popOut} />, document.body)}
    {pip && !pip.closed && createPortal(<MiniTimer store={store} itemId={store.running?.itemId ?? last} focus={id => { window.focus(); store.setFocusId(id); }} />, pip.document.body)}
  </>;
}

function Clock({start}: {start: string}) {
  const now = useNow(true);
  return <span className="fx-clock">{fmtClock(now - Date.parse(start))}</span>;
}

/** Choices for what starting a timer does. */
export function FocusSettings({store}: {store: Store}) {
  const [openPop, setOpen] = useState(false);
  const cfg = focusPrefs(store);
  const set = (p: Partial<FocusPrefs>) => store.setPref('focus', {...cfg, ...p});
  return <span className="picker">
    <button className="icon" title="Focus settings" onClick={() => setOpen(o => !o)}><Settings2 size={15} /></button>
    <Popover open={openPop} onClose={() => setOpen(false)} className="wide">
      <div className="pop-label">When I start a timer</div>
      <label className="pop-row"><input type="checkbox" checked={cfg.onStart === 'focus'} onChange={e => set({onStart: e.target.checked ? 'focus' : 'none'})} /> Open focus mode</label>
      <label className="pop-row"><input type="checkbox" checked={cfg.popOut} onChange={e => set({popOut: e.target.checked})} /> Pop out the timer (stays on top of every window)</label>
      <label className="pop-row"><input type="checkbox" checked={cfg.bar} onChange={e => set({bar: e.target.checked})} /> Show the timer bar on every page</label>
    </Popover>
  </span>;
}

function TimerBar({store, open, popOut}: {store: Store; open: (id: string) => void; popOut: () => void}) {
  const run = store.running!, item = store.items.get(run.itemId);
  return <div className="timer-bar" role="status">
    <span className="fx-dot" />
    <Clock start={run.start} />
    <button className="link grow ellipsis" title="Open the task" onClick={() => open(run.itemId)}>{item ? `${itemKey(item, store.projects)} ${item.title}` : 'Task'}</button>
    <button className="btn small" title="Stop the timer" onClick={() => store.stopTimer()}><Square size={11} fill="currentColor" /> Stop</button>
    {item && <button className="btn small" title="Stop the timer and complete the task" onClick={() => finish(store, item)}><CheckCircle2 size={13} /> Done</button>}
    {item && <button className="btn small" title="Focus mode: just this task" onClick={() => store.setFocusId(item.id)}><FocusIcon size={13} /> Focus</button>}
    <button className="btn small" title="Pop out a small timer that stays on top of other windows" onClick={popOut}><ExternalLink size={13} /> Pop out</button>
    <FocusSettings store={store} />
  </div>;
}

function TimerButtons({store, item}: {store: Store; item: Item}) {
  const mine = store.running?.itemId === item.id;
  return <>
    {mine
      ? <button className="btn" onClick={() => store.stopTimer()}><Square size={12} fill="currentColor" /> Stop</button>
      : <button className="btn primary" onClick={() => store.startTimer(item.id)}><Play size={12} fill="currentColor" /> Start</button>}
    <button className="btn" title="Stops the timer and completes the task" onClick={() => finish(store, item)} disabled={!!item.completed}><CheckCircle2 size={14} /> {item.completed ? 'Done' : 'Done'}</button>
  </>;
}

function FocusOverlay({store, item, close, popOut}: {store: Store; item: Item; close: () => void; popOut: () => void}) {
  const project = store.projects.find(p => p.id === item.projectId);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input,textarea,[contenteditable=true],.popover')) close(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [close]);
  // Done closes focus mode after a moment, so you see it land.
  useEffect(() => { if (item.completed) { const t = setTimeout(close, 900); return () => clearTimeout(t); } }, [item.completed]);
  if (!project) return null;
  const run = store.running?.itemId === item.id ? store.running : null;
  const children = [...store.items.values()].filter(i => i.parentId === item.id).sort((a, b) => a.sort - b.sort);
  const total = store.timeTotals.get(item.id) ?? 0;
  return <div className="focus-mode" role="dialog" aria-label="Focus mode">
    <div className="focus-card">
      <div className="focus-top">
        <span className="muted">{itemKey(item, store.projects)} · {project.name}</span>
        <span className="spacer" />
        <button className="btn small" onClick={popOut} title="Pop out a timer that stays on top of other windows"><ExternalLink size={13} /> Pop out</button>
        <FocusSettings store={store} />
        <button className="icon" title="Leave focus mode (Esc)" onClick={close}><X size={18} /></button>
      </div>
      <div className="focus-title"><Check item={item} project={project} onToggle={status => store.updateItem(item.id, {status})} /><InlineText value={item.title} onSave={title => store.updateItem(item.id, {title})} className="h2" /></div>
      <div className="focus-timer">
        {run ? <Clock start={run.start} /> : <span className="fx-clock idle">{fmtClock(0)}</span>}
        <TimerButtons store={store} item={item} />
        <span className="muted small">Logged on this task: {fmtMinutes(total)}</span>
      </div>
      <div className="focus-notes"><BlockEditor key={item.id} value={item.body} placeholder="Notes for this task" onSave={body => body !== item.body && store.updateItem(item.id, {body})} /></div>
      {children.length > 0 && <div className="focus-subs">
        <h4>Subitems <span className="count">{children.filter(c => c.completed).length}/{children.length}</span></h4>
        {children.map(c => <div key={c.id} className="focus-sub"><Check item={c} project={project} onToggle={status => store.updateItem(c.id, {status})} /><span className={c.completed ? 'muted strike' : ''}>{c.title}</span></div>)}
      </div>}
    </div>
  </div>;
}

/** Inside the pop-out window. */
function MiniTimer({store, itemId, focus}: {store: Store; itemId: string | null; focus: (id: string) => void}) {
  const item = itemId ? store.items.get(itemId) : undefined;
  const run = item && store.running?.itemId === item.id ? store.running : null;
  if (!item) return <div className="pip-timer"><span className="muted">No timer running. Start one in Cadence.</span></div>;
  return <div className="pip-timer">
    <div className="pip-title" title={item.title}>{item.title}</div>
    <div className="pip-row">
      {run ? <Clock start={run.start} /> : <span className="fx-clock idle">{fmtClock(0)}</span>}
      <span className="spacer" />
      {run ? <button className="btn small" onClick={() => store.stopTimer()}><Square size={11} fill="currentColor" /> Stop</button>
        : <button className="btn small primary" onClick={() => store.startTimer(item.id)}><Play size={11} fill="currentColor" /> Start</button>}
      <button className="btn small" onClick={() => finish(store, item)} disabled={!!item.completed}><CheckCircle2 size={12} /> Done</button>
      <button className="btn small" title="Open focus mode in Cadence" onClick={() => focus(item.id)}><FocusIcon size={12} /></button>
    </div>
  </div>;
}

/** Button for the task panel and menus. */
export function FocusButton({store, item}: {store: Store; item: Item}) {
  return <button className="icon" title="Focus mode: just this task, timer and notes" onClick={() => store.setFocusId(item.id)}><FocusIcon size={15} /></button>;
}
