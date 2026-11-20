// Focus for the work you are doing now.
//   Focus bar: the tasks you are focused on, at the top of every page. Starting a timer adds its task. One timer
//     runs at a time (per person); each task in the bar has play or stop, Done and remove.
//   Focus view: one task fills the screen, the rest goes dark: title, details, notes, subitems, the timer
//     against its estimate, and the other tasks in focus to switch to.
//   Pop out: a small always-on-top window (Chrome and Edge keep it above every window and app).
// Each person picks what starting a timer does (prefs "focus"): open the focus view, pop out, show the bar.
// Any of these can be on together. Set on the bar's gear, in the focus view, or on the Team page (My account).
import {TaskClock, TimeProgress} from './TimeTracker.tsx';
import {useEffect, useRef, useState, type PointerEvent as PE} from 'react';
import {wsId} from './store.ts';
import {createPortal} from 'react-dom';
import {Calendar, CheckCircle2, ChevronDown, ChevronUp, Focus as FocusIcon, GripVertical, ListX, Maximize, Minimize, PictureInPicture2, Play, Settings2, Square, X} from 'lucide-react';
import {fmtClock, fmtMinutes, useSharedNow, type Store} from './store.ts';
import {BlockEditor} from './BlockEditor.tsx';
import {Check, InlineText, Popover, PriorityIcon, StatusIcon, itemKey} from './components.tsx';
import type {Item, Project} from './types.ts';
import {PRIORITIES} from './types.ts';
import './focus.css';

export type FocusPrefs = {onStart: 'none' | 'focus'; bar: boolean; popOut: boolean};
export const focusPrefs = (store: Pick<Store, 'prefs'>): FocusPrefs => ({onStart: 'none', bar: true, popOut: false, ...(store.prefs.focus as Partial<FocusPrefs> | undefined)});
const focusList = (store: Store): Item[] => {
  const ids = (store.prefs.focusList as string[] | undefined) ?? [];
  const run = store.running?.itemId;
  return [...new Set([...ids, ...(run ? [run] : [])])].map(id => store.items.get(id)).filter((i): i is Item => !!i);
};

const doneStatus = (p: Project) => p.statuses.find(s => s.category === 'done')?.id;
/** Stops the timer if it runs on this task, marks the task done, and takes it out of focus. */
async function finish(store: Store, item: Item) {
  if (store.running?.itemId === item.id) await store.stopTimer();
  const p = store.projects.find(x => x.id === item.projectId), done = p && doneStatus(p);
  if (done && !item.completed) store.updateItem(item.id, {status: done});
  store.focusRemove(item.id);
}

/** Everything focus related; mount once in the app. */
export function FocusHost({store, open}: {store: Store; open: (id: string) => void}) {
  const cfg = focusPrefs(store);
  // The pop-out: a small always-on-top window in the corner (Chrome and Edge), showing on top of every page and app.
  // The browser closes it when this page reloads; it comes back by itself on your next click or key press here
  // (browsers only open it after one). Browsers without it get a plain small window instead.
  const [pip, setPip] = useState<Window | null>(null);
  const dpip = (window as unknown as {documentPictureInPicture?: {requestWindow: (o: {width: number; height: number}) => Promise<Window>}}).documentPictureInPicture;
  const popOut = async () => {
    if (pip && !pip.closed) { pip.focus(); return; }
    if (!dpip) {
      const w = window.open('', POPOUT_NAME, 'width=400,height=320,popup=yes');
      if (!w) { store.flash('Allow pop-ups for this site to pop out the timer'); return; }
      try { if (w.location.href === 'about:blank' || !w.location.hash.startsWith('#/popout')) w.location.href = `${location.pathname}${location.search}#/popout`; } catch { /* leave it */ }
      return;
    }
    let w: Window;
    try { w = await dpip.requestWindow({width: 380, height: 300}); } catch { store.flash('Click once on the page, then Pop out again'); return; }
    w.document.title = 'Cadence focus';
    for (const ss of [...document.styleSheets]) {
      try { const st = w.document.createElement('style'); st.textContent = [...ss.cssRules].map(r => r.cssText).join('\n'); w.document.head.appendChild(st); }
      catch { if (ss.href) { const l = w.document.createElement('link'); l.rel = 'stylesheet'; l.href = ss.href; w.document.head.appendChild(l); } }
    }
    w.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
    w.document.body.className = 'pip-body';
    // Closing it yourself forgets it; this page reloading or leaving closes it too, and then it comes back.
    w.addEventListener('pagehide', () => { setPip(null); if (!unloading) localStorage.removeItem(PIP_KEY); });
    localStorage.setItem(PIP_KEY, '1');
    setPip(w);
  };
  useEffect(() => {
    const bye = () => { unloading = true; };
    window.addEventListener('pagehide', bye);
    if (!dpip || localStorage.getItem(PIP_KEY) !== '1') return () => window.removeEventListener('pagehide', bye);
    // After a reload: the first click or key press anywhere brings the pop-out back. It listens after the page has
    // handled the click, so the click still does what you meant.
    const back = () => { off(); if (localStorage.getItem(PIP_KEY) === '1') void popOut(); };
    const off = () => { window.removeEventListener('click', back); window.removeEventListener('keydown', back); };
    window.addEventListener('click', back); window.addEventListener('keydown', back);
    return () => { off(); window.removeEventListener('pagehide', bye); };
  }, []);
  useEffect(() => () => { pip?.close(); }, [pip]);
  // The plain-window pop-out (other browsers) asks for the full page focus view here.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(`cadence-focus-${wsId()}`);
    ch.onmessage = m => { const id = (m.data as {focus?: string}).focus; if (id && !document.hidden) { fullPage(true); store.setFocusId(id); window.focus(); } };
    return () => ch.close();
  }, []);

  // Starting a timer anywhere puts its task in focus, and opens the focus view or the pop-out if this person wants that.
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{itemId: string}>).detail.itemId;
      store.focusAdd(id, cfg.onStart === 'focus');
      if (cfg.popOut) void popOut();
    };
    window.addEventListener('cadence:timer-start', on);
    return () => window.removeEventListener('cadence:timer-start', on);
  });

  const list = focusList(store);
  const focusItem = store.focusId ? store.items.get(store.focusId) : undefined;
  return <>
    {/* On document.body so they sit above the sidebar and the task panel. */}
    {cfg.bar && list.length > 0 && createPortal(<FocusBar store={store} list={list} open={open} popOut={popOut} />, document.body)}
    {focusItem && createPortal(<FocusView store={store} item={focusItem} list={list} close={() => store.setFocusId(null)} popOut={popOut} />, document.body)}
    {pip && !pip.closed && createPortal(<div className="popout-page"><MiniFocus store={store} list={list} focus={id => { fullPage(true); store.setFocusId(id); window.focus(); }} /><PopoutNotes store={store} list={list} /></div>, pip.document.body)}
  </>;
}

function Clock({start, className = 'fx-clock'}: {start: string; className?: string}) {
  const now = useSharedNow(true, start);
  return <span className={className}>{fmtClock(now - Date.parse(start))}</span>;
}

const POPOUT_NAME = 'cadence-popout';
const PIP_KEY = 'pip-open';
/** Set while this page unloads, so the pop-out closing with it is not taken as you closing it. */
let unloading = false;

/** Whether the focus view fills the screen (kept per browser). */
const isFullPage = () => localStorage.getItem('fv-full') === '1';
const fullPage = (on: boolean) => { try { localStorage.setItem('fv-full', on ? '1' : ''); } catch { /* private mode */ } };

/** What starting a timer does, for this person. */
function FocusChoices({store}: {store: Store}) {
  const cfg = focusPrefs(store);
  const set = (p: Partial<FocusPrefs>) => store.setPref('focus', {...cfg, ...p});
  return <>
    <label className="pop-row"><input type="checkbox" checked={cfg.onStart === 'focus'} onChange={e => set({onStart: e.target.checked ? 'focus' : 'none'})} /> Open the full-screen focus view</label>
    <label className="pop-row"><input type="checkbox" checked={cfg.popOut} onChange={e => set({popOut: e.target.checked})} /> Pop out the timer (stays on top of every window)</label>
    <label className="pop-row"><input type="checkbox" checked={cfg.bar} onChange={e => set({bar: e.target.checked})} /> Show the focus bar on every page</label>
  </>;
}
export function FocusSettings({store}: {store: Store}) {
  const [openPop, setOpen] = useState(false);
  return <span className="picker">
    <button className="fb-btn" title="When I start a timer..." onClick={() => setOpen(o => !o)}><Settings2 size={14} /></button>
    <Popover open={openPop} onClose={() => setOpen(false)} className="wide">
      <div className="pop-label">When I start a timer</div>
      <FocusChoices store={store} />
      <div className="muted small" style={{padding: '4px 8px'}}>Any of these can be on together. Saved for you, on every task.</div>
    </Popover>
  </span>;
}
/** Team page, My account. */
export function FocusSettingsCard({store}: {store: Store}) {
  return <section className="set-card">
    <div className="set-card-head"><h3><FocusIcon size={15} /> Focus and timer</h3><span className="muted small">What happens when you start a timer on any task. Any of these can be on together. The task always joins your focus bar.</span></div>
    <FocusChoices store={store} />
  </section>;
}

/** Where the bar sits: one of six spots it snaps to (kept per browser, since screens differ). */
type Spot = 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br';
const SPOTS: Spot[] = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];
const getLocal = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const setLocal = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
/** The nearest spot to a point: left, middle or right third; top or bottom half. */
export const nearestSpot = (x: number, y: number, w: number, h: number): Spot =>
  `${y < h / 2 ? 't' : 'b'}${x < w / 3 ? 'l' : x > w * 2 / 3 ? 'r' : 'c'}` as Spot;

function FocusBar({store, list, open, popOut}: {store: Store; list: Item[]; open: (id: string) => void; popOut: () => void}) {
  const run = store.running;
  const [spot, setSpot] = useState<Spot>(() => SPOTS.includes(getLocal('fb-pos') as Spot) ? getLocal('fb-pos') as Spot : 'tc');
  const [min, setMin] = useState(() => getLocal('fb-min') === '1');
  const [drag, setDrag] = useState<{x: number; y: number} | null>(null);
  const grab = useRef<{dx: number; dy: number} | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const place = (s: Spot) => { setSpot(s); setLocal('fb-pos', s); };
  const toggleMin = () => { setMin(!min); setLocal('fb-min', min ? '' : '1'); };
  const onDown = (e: PE) => {
    if (e.button !== 0 || !bar.current) return;
    const r = bar.current.getBoundingClientRect();
    grab.current = {dx: e.clientX - r.left, dy: e.clientY - r.top};
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PE) => { if (grab.current) setDrag({x: e.clientX - grab.current.dx, y: e.clientY - grab.current.dy}); };
  const onUp = (e: PE) => {
    if (!grab.current) return;
    grab.current = null;
    if (drag) place(nearestSpot(e.clientX, e.clientY, innerWidth, innerHeight));
    setDrag(null);
  };
  const shown = min ? list.filter(i => run?.itemId === i.id) : list;
  const others = list.filter(i => i.id !== run?.itemId);
  return <div ref={bar} className={`focus-bar at-${spot}` + (drag ? ' dragging' : '') + (min ? ' min' : '')} role="status"
    style={drag ? {left: drag.x, top: drag.y, right: 'auto', bottom: 'auto', transform: 'none'} : undefined}>
    <span className="fb-label fb-grip" title="Drag to move. It snaps to the nearest corner or edge. Double-click to put it back at the top."
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { grab.current = null; setDrag(null); }}
      onDoubleClick={() => place('tc')}><GripVertical size={12} /><FocusIcon size={13} /> Focus{min && list.length > shown.length ? <span className="muted"> ({list.length})</span> : null}</span>
    <div className="fb-items">
      {shown.map(i => {
        const on = run?.itemId === i.id;
        return <div key={i.id} className={'fb-item' + (on ? ' on' : '')}>
          {on ? <button className="fb-btn" title="Stop the timer" onClick={() => store.stopTimer()}><Square size={10} fill="currentColor" /></button>
            : <button className="fb-btn" title="Start the timer on this task" onClick={() => store.startTimer(i.id)}><Play size={10} fill="currentColor" /></button>}
          {on && <TaskClock store={store} itemId={i.id} className="fx-clock" />}
          <button className="fb-title" title={`${i.title}. Click to open the task`} onClick={() => open(i.id)}>{i.title}</button>
          <button className="fb-btn" title="Full page focus on this task" onClick={() => { fullPage(true); store.setFocusId(i.id); }}><Maximize size={12} /></button>
          <button className="fb-btn" title="Done: stops the timer and completes the task" onClick={() => finish(store, i)}><CheckCircle2 size={13} /></button>
          <button className="fb-btn" title="Take out of focus" onClick={() => store.focusRemove(i.id)}><X size={12} /></button>
        </div>;
      })}
    </div>
    {!min && <>
      <button className="fb-btn fb-labeled" title="Full page focus on the running task (or the first one)" onClick={() => { fullPage(true); store.setFocusId(store.running && list.some(i => i.id === store.running!.itemId) ? store.running.itemId : list[0].id); }}><Maximize size={13} /> Full page</button>
      <button className="fb-btn fb-labeled" title="Pop out a small timer that stays in the corner on top of every window" onClick={popOut}><PictureInPicture2 size={13} /> Pop out</button>
      {others.length > 0 && <button className="fb-btn" title={run ? 'Clear the others (keeps the running task)' : 'Clear all tasks from focus'} onClick={() => store.focusClear()}><ListX size={14} /></button>}
      <FocusSettings store={store} />
    </>}
    <button className="fb-btn" title={min ? 'Show all focus tasks' : 'Shrink to the running timer'} onClick={toggleMin}>{min ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
  </div>;
}

function FocusView({store, item, list, close, popOut}: {store: Store; item: Item; list: Item[]; close: () => void; popOut: () => void}) {
  const project = store.projects.find(p => p.id === item.projectId);
  const now = useSharedNow(store.running?.itemId === item.id);
  const [full, setFull] = useState(isFullPage);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input,textarea,[contenteditable=true],.popover')) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', k, true);
    return () => document.removeEventListener('keydown', k, true);
  }, [close]);
  if (!project) return null;
  const run = store.running?.itemId === item.id ? store.running : null;
  const children = [...store.items.values()].filter(i => i.parentId === item.id).sort((a, b) => a.sort - b.sort);
  const logged = (store.timeTotals.get(item.id) ?? 0) + (run ? (now - Date.parse(run.start)) / 60000 : 0);
  const est = (item.estimate ?? 0) * 60;
  const pct = est ? Math.min(100, Math.round(logged / est * 100)) : 0;
  const status = project.statuses.find(s => s.id === item.status);
  const others = list.filter(i => i.id !== item.id);
  return <div className={'fv-backdrop' + (full ? ' full' : '')} role="dialog" aria-label="Focus" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="fv">
      <header className="fv-head">
        <span className="fv-crumb"><span className="fv-space">{project.name}</span> {itemKey(item, store.projects)}</span>
        <span className="spacer" />
        <button className="btn small" onClick={() => { fullPage(!full); setFull(!full); }} title={full ? 'Back to a window over the page' : 'Fill the whole screen'}>{full ? <><Minimize size={13} /> Window</> : <><Maximize size={13} /> Full page</>}</button>
        <button className="btn small" onClick={popOut} title="A small timer that stays on top of other windows"><PictureInPicture2 size={13} /> Pop out</button>
        <FocusSettings store={store} />
        <button className="fb-btn" title="Leave the focus view (Esc)" onClick={close}><X size={18} /></button>
      </header>
      <div className="fv-body">
        <main className="fv-main">
          <div className="fv-title"><Check item={item} project={project} onToggle={s => store.updateItem(item.id, {status: s})} /><InlineText value={item.title} onSave={title => store.updateItem(item.id, {title})} className="h2" /></div>
          <div className="fv-meta">
            {status && <span className="fv-chip"><StatusIcon status={status} size={13} /> {status.name}</span>}
            {item.priority > 0 && <span className="fv-chip"><PriorityIcon value={item.priority} size={13} /> {PRIORITIES[item.priority]}</span>}
            {item.due && <span className={'fv-chip' + (item.due < store.today && !item.completed ? ' late' : '')}><Calendar size={13} /> Due {item.due}</span>}
            {item.estimate ? <span className="fv-chip">Estimate {fmtMinutes(est)}</span> : null}
          </div>
          <section className="fv-card">
            <h4>Notes</h4>
            <BlockEditor key={item.id} value={item.body} placeholder="Notes, links, what done looks like" onSave={body => body !== item.body && store.updateItem(item.id, {body})} />
          </section>
          {children.length > 0 && <section className="fv-card">
            <h4>Subitems <span className="count">{children.filter(c => c.completed).length}/{children.length}</span></h4>
            {children.map(c => <div key={c.id} className="fv-sub"><Check item={c} project={project} onToggle={s => store.updateItem(c.id, {status: s})} /><span className={c.completed ? 'muted strike' : ''}>{c.title}</span></div>)}
          </section>}
        </main>
        <aside className="fv-side">
          <section className={'fv-timer' + (run ? ' on' : '')}>
            <TaskClock store={store} itemId={item.id} total="below" className={'fv-clock' + (run ? '' : ' idle')} />
            <TimeProgress store={store} itemId={item.id} />
            {run ? <button className="btn fv-wide" onClick={() => store.stopTimer()}><Square size={12} fill="currentColor" /> Stop timer</button>
              : <button className="btn primary fv-wide" onClick={() => store.startTimer(item.id)}><Play size={12} fill="currentColor" /> Start timer</button>}
            <button className="btn fv-wide" disabled={!!item.completed} onClick={() => finish(store, item).then(close)}><CheckCircle2 size={14} /> {item.completed ? 'Done' : 'Done (stops the timer)'}</button>
          </section>
          {others.length > 0 && <section className="fv-card">
            <h4>Also in focus</h4>
            {others.map(o => <button key={o.id} className="fv-other" onClick={() => store.setFocusId(o.id)}>{store.running?.itemId === o.id && <span className="fx-dot" />}<span className="ellipsis">{o.title}</span></button>)}
          </section>}
        </aside>
      </div>
    </div>
  </div>;
}

/** Inside the pop-out window: the tasks in focus, with the running one on top. */
export function MiniFocus({store, list, focus}: {store: Store; list: Item[]; focus: (id: string) => void}) {
  const run = store.running;
  if (!list.length) return <div className="pip-timer"><span className="muted">Nothing in focus. Start a timer in Cadence.</span></div>;
  const sorted = [...list].sort((a, b) => (b.id === run?.itemId ? 1 : 0) - (a.id === run?.itemId ? 1 : 0));
  return <div className="pip-timer">
    {sorted.map(i => {
      const on = run?.itemId === i.id;
      return <div key={i.id} className={'pip-card' + (on ? ' on' : '')}>
        <div className="pip-row">
          {on ? <button className="fb-btn" title="Stop" onClick={() => store.stopTimer()}><Square size={11} fill="currentColor" /></button>
            : <button className="fb-btn" title="Start" onClick={() => store.startTimer(i.id)}><Play size={11} fill="currentColor" /></button>}
          <span className="pip-title" title={i.title}>{i.title}</span>
          <button className="fb-btn" title="Done: stops the timer and completes the task" onClick={() => finish(store, i)}><CheckCircle2 size={13} /></button>
          <button className="fb-btn" title="Full page focus in Cadence" onClick={() => { fullPage(true); focus(i.id); }}><Maximize size={12} /></button>
        </div>
        {on && <TaskClock store={store} itemId={i.id} className="pip-clock" />}
        <TimeProgress store={store} itemId={i.id} compact={!on} />
      </div>;
    })}
  </div>;
}

/** The pop-out window's page (#/popout): the tasks in focus with their clocks and progress. Its own window, so the main
 *  page can reload. Keep on top moves it into an always-on-top window (Chrome and Edge) owned by this pop-out. */
export function PopoutPage({store}: {store: Store}) {
  const list = focusList(store);
  const [pip, setPip] = useState<Window | null>(null);
  useEffect(() => { document.title = 'Cadence timer'; document.body.classList.add('pip-body'); }, []);
  // Full page asks the Cadence tab to show the focus view; this pop-out stays open. With no Cadence tab left, it opens one.
  const toMain = (id: string) => {
    const main = window.opener as Window | null;
    if (!main || main.closed) { window.open(`${location.pathname}${location.search}#/open/${id}`, '_blank'); return; }
    try { new BroadcastChannel(`cadence-focus-${wsId()}`).postMessage({focus: id}); } catch { /* old browser */ }
    try { main.focus(); } catch { /* not allowed */ }
  };
  const dpip = (window as unknown as {documentPictureInPicture?: {requestWindow: (o: {width: number; height: number}) => Promise<Window>}}).documentPictureInPicture;
  const onTop = async () => {
    if (!dpip) return;
    const w = await dpip.requestWindow({width: 380, height: 220});
    w.document.title = 'Cadence timer';
    for (const ss of [...document.styleSheets]) {
      try { const st = w.document.createElement('style'); st.textContent = [...ss.cssRules].map(r => r.cssText).join('\n'); w.document.head.appendChild(st); }
      catch { if (ss.href) { const l = w.document.createElement('link'); l.rel = 'stylesheet'; l.href = ss.href; w.document.head.appendChild(l); } }
    }
    w.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
    w.document.body.className = 'pip-body';
    w.addEventListener('pagehide', () => setPip(null));
    setPip(w);
  };
  return <div className="popout-page">
    <header className="popout-head"><b>Focus</b><span className="spacer" />
      {dpip && !pip && <button className="btn small" title="Keep the timer above every window (closes if this pop-out window reloads)" onClick={onTop}><PictureInPicture2 size={12} /> Keep on top</button>}
    </header>
    {pip && !pip.closed ? <p className="muted small" style={{padding: '0 10px'}}>Shown on top of your windows. Close that small window to bring it back here.</p> : <><MiniFocus store={store} list={list} focus={toMain} /><PopoutNotes store={store} list={list} /></>}
    {pip && !pip.closed && createPortal(<><MiniFocus store={store} list={list} focus={toMain} /><PopoutNotes store={store} list={list} /></>, pip.document.body)}
  </div>;
}

/** Under the timers in the pop-out: the running (or first) task's notes and subitems, editable, filling the space. */
function PopoutNotes({store, list}: {store: Store; list: Item[]}) {
  const item = list.find(i => i.id === store.running?.itemId) ?? list[0];
  if (!item) return null;
  const project = store.projects.find(p => p.id === item.projectId);
  const children = [...store.items.values()].filter(i => i.parentId === item.id).sort((a, b) => a.sort - b.sort);
  return <div className="popout-notes">
    <div className="small muted">Notes: {item.title}</div>
    <BlockEditor key={item.id} value={item.body} placeholder="Notes, links, what done looks like" onSave={body => body !== item.body && store.updateItem(item.id, {body})} />
    {children.length > 0 && project && <div className="popout-subs"><div className="small muted">Subitems {children.filter(c => c.completed).length}/{children.length}</div>
      {children.map(c => <div key={c.id} className="row small"><Check item={c} project={project} onToggle={st => store.updateItem(c.id, {status: st})} /> <span className={c.completed ? 'muted' : ''}>{c.title}</span></div>)}</div>}
  </div>;
}

/** Button for the task panel. */
export function FocusButton({store, item}: {store: Store; item: Item}) {
  return <button className="icon" title="Focus on this task: full screen with notes and timer, and it joins your focus bar" onClick={() => store.focusAdd(item.id, true)}><FocusIcon size={15} /></button>;
}
