import {Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {NewItemSpotlight, NewItemsButton, AddToSpace} from './NewItems.tsx';
import {CoverHeader} from './Cover.tsx';
import {canShare, saveMode, viewsFor, type ShownView} from './customize.ts';
import {ColorRulesButton} from './ColorRules.tsx';
import {CircleUser, FileSignature, GraduationCap, Sparkles, Repeat, LayoutTemplate, Bot, BarChart3, Shield, LogOut, Users, Keyboard, Bell, CalendarDays, CalendarRange, History, PanelLeft, PanelLeftClose, ChevronDown, Columns3, Copy, Database, Download, Filter, FolderInput, GanttChart, Kanban, Layers, List, MoreHorizontal, Pencil, Plus, Search, Settings, Square, Sun, Table, Trash2, Zap, Paperclip, X, ChevronLeft, Lock, Unlock, EyeOff, Clock, ChevronRight, Archive, Workflow, CalendarClock} from 'lucide-react';
import type {Item, Notification, Project, View, ViewConfig, ViewKind} from './types.ts';
import {api, fmtClock, getMe, useNow, useStore, type Store, storeMe, switchWorkspace, wsId} from './store.ts';
import {Avatar, Avatars, Check, Empty, InlineText, Popover, StoreContext, TypeBadge, itemKey} from './components.tsx';
import {AppearanceButton} from './appearance.tsx';
import {ListView} from './ListView.tsx';
import {TableView} from './TableView.tsx';
import {BoardView} from './BoardView.tsx';
import {BulkBar} from './BulkBar.tsx';
import {FilterButton, countRules, matchFilter} from './FilterBuilder.tsx';
import {SortButton} from './Sorting.tsx';
import {NewFromTemplate, NewProjectMenu} from './TemplateMenus.tsx';
import {QuickCapture, ShortcutsDialog, moveFocus, targetIds, useHotkeys, type ActionId} from './Hotkeys.tsx';
import {ItemPanel} from './ItemPanel.tsx';
import {DataPage, downloadCsv} from './DataPage.tsx';
import {MyWork} from './MyWork.tsx';
import {NotifySettings} from './NotifySettings.tsx';
import {setBadge} from './device.ts';
import {AccessCard, AcceptInvite, EmailLinkSignIn, NoAccess, SetupServer, SignIn, type Me} from './Team.tsx';
import {WorkspaceSwitcher, useWorkspaces} from './Workspaces.tsx';
import {QuickViewHost} from './QuickView.tsx';
import {ContextMenus} from './ContextMenu.tsx';
import {FileDrop, FilesView} from './FilesView.tsx';
import {ProjectList, includedIn, isRollup, rollupProject} from './ProjectNav.tsx';
import {HelpPage, TOURS, TourRunner} from './Tours.tsx';
import {AddField, DEFAULT_HIDDEN, tableColumns} from './TableView.tsx';
import {PropertyPanel} from './Fields.tsx';
import {resumeConnect} from './ConnectedApps.tsx';

// Pages and views beyond the everyday ones load on first use, so the first screen stays small and fast.
const GanttView = lazy(() => import('./GanttView.tsx').then(m => ({default: m.GanttView})));
const CalendarView = lazy(() => import('./CalendarView.tsx').then(m => ({default: m.CalendarView})));
const WorkloadView = lazy(() => import('./WorkloadView.tsx').then(m => ({default: m.WorkloadView})));
const BacklogView = lazy(() => import('./BacklogView.tsx').then(m => ({default: m.BacklogView})));
const SprintView = lazy(() => import('./SprintView.tsx').then(m => ({default: m.SprintView})));
const SettingsView = lazy(() => import('./SettingsView.tsx').then(m => ({default: m.SettingsView})));
const HistoryPage = lazy(() => import('./History.tsx').then(m => ({default: m.HistoryPage})));
const InsightsPage = lazy(() => import('./Insights.tsx').then(m => ({default: m.InsightsPage})));
const AIWorkPage = lazy(() => import('./AIWork.tsx').then(m => ({default: m.AIWorkPage})));
const TemplateEditor = lazy(() => import('./TemplateEditor.tsx').then(m => ({default: m.TemplateEditor})));
const Everything = lazy(() => import('./Everything.tsx').then(m => ({default: m.Everything})));
const PlanPage = lazy(() => import('./PlanPage.tsx').then(m => ({default: m.PlanPage})));
const ApprovalsPage = lazy(() => import('./Approvals.tsx').then(m => ({default: m.ApprovalsPage})));
const RoutinesView = lazy(() => import('./Routines.tsx').then(m => ({default: m.RoutinesView})));
const RoutineSummary = lazy(() => import('./Routines.tsx').then(m => ({default: m.RoutineSummary})));
const TemplatesPage = lazy(() => import('./Library.tsx').then(m => ({default: m.TemplatesPage})));
const DayPlanner = lazy(() => import('./DayPlanner.tsx').then(m => ({default: m.DayPlanner})));
const WhiteboardsPage = lazy(() => import('./Whiteboard.tsx').then(m => ({default: m.WhiteboardsPage})));
const WhiteboardView = lazy(() => import('./Whiteboard.tsx').then(m => ({default: m.WhiteboardView})));
const TimesheetPage = lazy(() => import('./Timesheet.tsx').then(m => ({default: m.TimesheetPage})));
const TeamPage = lazy(() => import('./Team.tsx').then(m => ({default: m.TeamPage})));

type Route = {page: 'project'; id: string; view: string} | {page: 'mywork'} | {page: 'inbox'} | {page: 'data'} | {page: 'history'} | {page: 'team'} | {page: 'signin'} | {page: 'insights'} | {page: 'ai'} | {page: 'templates'} | {page: 'timesheet'} | {page: 'invite'; id: string} | {page: 'signin-link'; id: string} | {page: 'today'} | {page: 'template'; id: string} | {page: 'routines'; focus?: string} | {page: 'parked'} | {page: 'plan'} | {page: 'help'} | {page: 'approvals'} | {page: 'boards'; id?: string} | {page: 'day'};

function readRoute(): Route {
  const [page, id, view] = location.hash.slice(2).split('?')[0].split('/');
  if (page === 'p' && id) return {page: 'project', id, view: view ?? ''};
  if (page === 'inbox') return {page: 'inbox'};
  if (page === 'data') return {page: 'data'};
  if (page === 'history') return {page: 'history'};
  if (page === 'team') return {page: 'team'};
  if (page === 'insights') return {page: 'insights'};
  if (page === 'ai') return {page: 'ai'};
  if (page === 'templates' && id) return {page: 'template', id};
  if (page === 'routines' && id) return {page: 'routines', focus: id};
  if (page === 'boards') return {page: 'boards', id: id || undefined};
  if (page === 'timesheet') return {page: 'timesheet'};
  if (page === 'invite' && id) return {page: 'invite', id};
  if (page === 'signin-link' && id) return {page: 'signin-link', id};
  if (page === 'today') return {page: 'today'};
  if (page === 'templates' || page === 'routines' || page === 'parked' || page === 'plan' || page === 'help' || page === 'approvals' || page === 'day') return {page};
  if (page === 'signin') return {page: 'signin'};
  if (page === 'open' && id) { sessionStorage.setItem('open-after', id); history.replaceState(null, '', '#/mywork'); return {page: 'mywork'}; }
  return {page: 'mywork'};
}
const go = (r: Route) => { location.hash = r.page === 'project' ? `/p/${r.id}/${r.view}` : r.page === 'routines' && r.focus ? `/routines/${r.focus}` : r.page === 'boards' && r.id ? `/boards/${r.id}` : `/${r.page}`; };

export const VIEW_KINDS: {kind: ViewKind; label: string; icon: typeof List; hint: string}[] = [
  {kind: 'list', label: 'List', icon: List, hint: 'Nested outline, fastest for writing'},
  {kind: 'table', label: 'Table', icon: Table, hint: 'Spreadsheet with resizable columns'},
  {kind: 'board', label: 'Board', icon: Kanban, hint: 'Kanban by status, person, type or sprint'},
  {kind: 'gantt', label: 'Timeline', icon: GanttChart, hint: 'Gantt: drag to schedule, link dependencies'},
  {kind: 'calendar', label: 'Calendar', icon: CalendarDays, hint: 'Month or week by due date. Drag to reschedule'},
  {kind: 'workload', label: 'Workload', icon: Users, hint: 'Hours per person per day vs capacity'},
  {kind: 'backlog', label: 'Backlog', icon: Layers, hint: 'Epics, features, stories. Plan into sprints'},
  {kind: 'sprint', label: 'Sprint', icon: Zap, hint: 'Sprint board, burndown, capacity'},
  {kind: 'files', label: 'Files', icon: Paperclip, hint: 'Every attachment in the space. Drop files to make a task per file'},
  {kind: 'routines', label: 'Routines', icon: Repeat, hint: 'Routines by SOP, frequency or person, with on/off switches, skip, delay and wait'},
  {kind: 'whiteboard', label: 'Whiteboard', icon: Workflow, hint: 'Map and run the flow: task cards, SOP links, triggers and webhooks on a canvas'},
];
export const viewIcon = (k: ViewKind) => VIEW_KINDS.find(v => v.kind === k)?.icon ?? CalendarRange;
/** A color per view kind, so tabs and the sidebar are easy to scan. */
export const VIEW_COLORS: Record<string, string> = {list: '#3b82f6', table: '#10b981', board: '#8b5cf6', gantt: '#ec4899', calendar: '#f97316', workload: '#14b8a6', backlog: '#64748b', sprint: '#ef4444', files: '#d97706', routines: '#0d9488', whiteboard: '#7c3aed'};

export function App() {
  const [me, setMeState] = useState(getMe);
  // Sign-in state. When sign-in is required the server decides who you are.
  const [auth, setAuth] = useState<Me | null>(null);
  useEffect(() => { api<Me>('/auth/me').then(a => {
    // Signed in on the way to connecting an AI app (server/oauth.ts): go back to its consent page, whichever way they signed in.
    if (a.account && resumeConnect()) return;
    setAuth(a); if (a.required && a.person) { sessionStorage.setItem('me', a.person.id); setMeState(a.person.id); }
  }).catch(() => {}); }, []);
  const store = useStore(me);
  const storeRef = useRef(store);
  storeRef.current = store;
  const [rawRoute, setRoute] = useState(readRoute);
  const off: Record<string, boolean> = {timesheet: !store.settings.features.timeTracking, ai: !store.settings.features.aiWork, approvals: !store.settings.features.approvals,
    routines: !store.settings.features.routines, insights: !store.settings.features.insights};
  const route: Route = off[rawRoute.page] ? {page: 'mywork'} : rawRoute;
  const [openId, setOpenId] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [unread, setUnread] = useState(0);
  // Sidebar: drag its edge to resize, collapse it to give views more room, drawer on small screens.
  const [sideW, setSideW] = useState(() => Number(localStorage.getItem('side-w')) || 248);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('side-collapsed') === '1');
  const [drawer, setDrawer] = useState(false);
  const toggleSide = () => {
    if (matchMedia('(max-width: 760px)').matches) { setDrawer(d => !d); return; }
    setCollapsed(c => { localStorage.setItem('side-collapsed', c ? '0' : '1'); return !c; });
  };
  // Going somewhere else closes the menu drawer, and on a phone the full-screen task too.
  useEffect(() => { const f = () => { setDrawer(false); if (matchMedia('(max-width: 760px)').matches) setOpenId(null); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = sideW;
    const move = (ev: PointerEvent) => setSideW(Math.min(420, Math.max(180, w0 + ev.clientX - x0)));
    const up = (ev: PointerEvent) => { localStorage.setItem('side-w', String(Math.min(420, Math.max(180, w0 + ev.clientX - x0)))); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };

  useEffect(() => { const f = () => setRoute(readRoute()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { if (store.ready && !store.people.some(p => p.id === me) && store.people[0]) setMe(store.people[0].id); }, [store.ready, store.people]);
  useEffect(() => { if (me) api<Notification[]>(`/notifications?person=${me}&unread=true`).then(n => { setUnread(n.length); setBadge(n.length); }).catch(() => {}); }, [me, store.tick]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Undo/redo for item changes. Text fields keep their own native undo.
      const typing = (e.target as HTMLElement).closest?.('input:not([type=checkbox]):not([type=date]), textarea');
      if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) storeRef.current.redo(); else storeRef.current.undo(); }
      if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); storeRef.current.redo(); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);

  const setMe = (id: string) => { storeMe(id); setMeState(id); };
  // Opening an item from another workspace switches here first, then opens it once this workspace has loaded.
  useEffect(() => {
    const id = sessionStorage.getItem('open-after');
    if (id && store.items.has(id)) { sessionStorage.removeItem('open-after'); open(id); }
  }, [store.items]);
  // Task panel history: back and forward through the tasks you opened, and reopen the last one after closing.
  const [hist, setHist] = useState<{list: string[]; at: number}>({list: [], at: -1});
  const [lastClosed, setLastClosed] = useState<string | null>(null);
  const [pinned, setPinned] = useState(() => localStorage.getItem('panel-pin') === '1');
  const open = useCallback((id: string) => {
    setOpenId(id);
    setHist(h => h.list[h.at] === id ? h : {list: [...h.list.slice(0, h.at + 1), id].slice(-50), at: Math.min(h.at + 1, 49)});
  }, []);
  const step = (d: number) => setHist(h => { const at = Math.max(0, Math.min(h.list.length - 1, h.at + d)); setOpenId(h.list[at]); return {...h, at}; });
  const [capture, setCapture] = useState(false);
  const [tour, setTour] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const focus = useRef<string | null>(null);
  const runRef = useRef<(a: ActionId) => void>(() => {});
  runRef.current = (a: ActionId) => {
    const s = storeRef.current;
    const ids = () => targetIds(focus.current);
    const sprintFor = async (projectId: string, which: 'now' | 'next') => {
      const list = s.sprints.filter(x => x.projectId === projectId).sort((x, y) => x.start.localeCompare(y.start));
      const cur = list.find(x => x.start <= s.today && s.today <= x.end);
      if (which === 'now') return cur?.id ?? (await s.createSprint(projectId))?.id ?? null;
      return list.find(x => cur && x.start > cur.start)?.id ?? (await s.createSprint(projectId))?.id ?? null;
    };
    switch (a) {
      case 'palette': setPalette(p => !p); break;
      case 'capture': setCapture(true); break;
      case 'help': setShortcuts(true); break;
      case 'filter': document.querySelector<HTMLInputElement>('.toolbar .search')?.focus(); break;
      case 'sidebar': toggleSide(); break;
      case 'goMyWork': go({page: 'mywork'}); break;
      case 'goInbox': go({page: 'inbox'}); break;
      case 'goHistory': go({page: 'history'}); break;
      case 'down': case 'up': focus.current = moveFocus(a === 'down' ? 1 : -1, focus.current); break;
      case 'open': if (focus.current) open(focus.current); break;
      case 'select': {
        const el = focus.current ? document.querySelector<HTMLElement>(`.content [data-id="${focus.current}"]`) : null;
        const cb = el?.querySelector<HTMLInputElement>('.sel-col input');
        if (cb) cb.click(); else el?.dispatchEvent(new MouseEvent('click', {bubbles: true, ctrlKey: true}));
        break;
      }
      case 'done': for (const id of ids()) { const it = s.items.get(id); const p = it && s.projects.find(x => x.id === it.projectId); if (!it || !p) continue;
        s.updateItem(id, {status: it.completed ? (p.statuses.find(x => x.category === 'todo')?.id ?? p.statuses[0].id) : (p.statuses.find(x => x.category === 'done')?.id ?? it.status)}); } break;
      case 'assignMe': for (const id of ids()) { const it = s.items.get(id); if (it && !it.assignees.includes(me)) s.updateItem(id, {assignees: [...it.assignees, me]}); } break;
      case 'sprintNow': case 'sprintNext': (async () => { for (const id of ids()) { const it = s.items.get(id); if (it) s.updateItem(id, {sprint: await sprintFor(it.projectId, a === 'sprintNow' ? 'now' : 'next')}); } })(); break;
      case 'backlog': for (const id of ids()) s.updateItem(id, {sprint: null}); break;
      default: if (a.startsWith('view')) document.querySelectorAll<HTMLElement>('.tabs > .picker > .tab')[Number(a.slice(4)) - 1]?.click();
    }
  };
  useHotkeys(useCallback((a: ActionId) => runRef.current(a), []));
  const close = useCallback(() => { if (openId) setLastClosed(openId); setOpenId(null); }, [openId]);
  // Clicking outside the panel closes it (unless pinned). Clicks on other tasks, menus and dialogs do not count.
  useEffect(() => {
    if (!openId || pinned) return;
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.isConnected || t.closest('.panel, .popover, .ctx-menu, .overlay, .panel-reopen, [data-id], .qv, dialog')) return;
      close();
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [openId, pinned, close]);
  // Item links inside descriptions ask to open an item through this event.
  useEffect(() => { const f = (e: Event) => open((e as CustomEvent<string>).detail); addEventListener('open-item', f); return () => removeEventListener('open-item', f); }, [open]);

  const project = route.page === 'project' ? store.projects.find(p => p.id === route.id) : undefined;
  const projectViews = useMemo(() => project ? viewsFor(store, project.id) : [], [store.views, store.prefs, store.settings, project]);
  const view = route.page === 'project' ? projectViews.find(v => v.id === route.view) ?? (route.view === 'settings' ? undefined : projectViews[0]) : undefined;

  if (route.page === 'invite') return <AcceptInvite secret={route.id} />;
  if (route.page === 'signin-link') return <EmailLinkSignIn token={route.id} />;
  if (auth?.required && !auth.person) return auth.setup ? <SetupServer /> : auth.account ? <NoAccess me={auth} /> : <SignIn google={!!auth.signInGoogle} emailLink={!!auth.signInLink} signup={auth.signup} />;
  if (!store.ready) return <div className="loading">{store.error ?? 'Loading...'}</div>;

  return (
    <StoreContext.Provider value={store}>
    <div className={'app' + (collapsed ? ' side-collapsed' : '') + (drawer ? ' drawer-open' : '')} style={{'--side-w': `${sideW}px`} as React.CSSProperties}>
      <div className="side-wrap">
        <NewItemSpotlight store={store} />
        <Sidebar store={store} me={me} setMe={setMe} route={route} unread={unread} openPalette={() => setPalette(true)} open={open} onToggle={toggleSide} onShortcuts={() => setShortcuts(true)} signedIn={!!auth?.required} />
        <div className="side-resize" onPointerDown={startResize} onDoubleClick={() => { setSideW(248); localStorage.setItem('side-w', '248'); }} title="Drag to resize, double-click to reset" />
      </div>
      {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}
      <button className="side-toggle" onClick={toggleSide} title="Show sidebar"><PanelLeft size={16} /></button>
      <main className="main">
        {route.page === 'project' && project && (
          <ProjectPage store={store} project={project} views={projectViews} view={view} settings={route.view === 'settings'} open={open} />
        )}
        <ViewBoundary key={route.page + ((route as {id?: string}).id ?? '')}>
        {route.page === 'project' && !project && store.ready && <FindProject id={route.id} />}
        {route.page === 'mywork' && <div className="content"><MyWork store={store} me={me} open={open} /></div>}
        {route.page === 'inbox' && <div className="content"><Inbox store={store} me={me} open={open} /></div>}
        {route.page === 'data' && <div className="content"><DataPage store={store} /></div>}
        {route.page === 'history' && <div className="content"><HistoryPage store={store} open={open} /></div>}
        {route.page === 'approvals' && <div className="content"><ApprovalsPage store={store} me={me} open={open} /></div>}
        {route.page === 'help' && <div className="content"><HelpPage start={id => setTour(id)} /></div>}
        {route.page === 'today' && <div className="content"><Everything store={store} open={open} /></div>}
        {route.page === 'templates' && <div className="content"><TemplatesPage store={store} open={open} /></div>}
        {route.page === 'template' && <div className="content"><TemplateEditor store={store} id={route.id} /></div>}
        {(route.page === 'routines' || route.page === 'parked') && <SystemRedirect store={store} scope={route.page === 'routines' ? 'routines' : 'parked'} focus={route.page === 'routines' ? route.focus : undefined} />}
        {route.page === 'day' && <div className="content dp-page"><DayPlanner store={store} me={me} open={open} /></div>}
        {route.page === 'boards' && <div className="content wb-page"><WhiteboardsPage store={store} id={route.id} open={open} /></div>}
        {route.page === 'timesheet' && <div className="content"><TimesheetPage store={store} open={open} /></div>}
        {route.page === 'plan' && <div className="content"><PlanPage store={store} /></div>}
        {route.page === 'ai' && <div className="content"><AIWorkPage store={store} open={open} /></div>}
        {route.page === 'insights' && <div className="content"><InsightsPage store={store} open={open} /></div>}
        {route.page === 'team' && auth && <div className="content"><TeamPage store={store} me={auth} /></div>}
        </ViewBoundary>
      </main>
      {openId && store.items.has(openId) && <ItemPanel key={openId} store={store} id={openId} close={close} open={open} me={me}
        nav={{back: () => step(-1), forward: () => step(1), canBack: hist.at > 0, canForward: hist.at < hist.list.length - 1, pinned, togglePin: () => setPinned(p => { localStorage.setItem('panel-pin', p ? '0' : '1'); return !p; })}} />}
      {!openId && lastClosed && store.items.has(lastClosed) && <button className="panel-reopen" title={`Reopen ${store.items.get(lastClosed)!.title}`} onClick={() => open(lastClosed)}><ChevronLeft size={16} /></button>}
      {palette && <Palette store={store} close={() => setPalette(false)} open={id => { setPalette(false); open(id); }} />}
      <QuickViewHost />
      <ContextMenus store={store} open={open} />
      {capture && <QuickCapture store={store} me={me} projectId={route.page === 'project' ? route.id : undefined} close={() => setCapture(false)} />}
      {shortcuts && <ShortcutsDialog close={() => setShortcuts(false)} />}
      {tour && TOURS.find(t => t.id === tour) && <TourRunner tour={TOURS.find(t => t.id === tour)!} store={store} close={() => setTour(null)} />}
      <nav className="tabbar">
        <button className={route.page === 'mywork' ? 'on' : ''} onClick={() => go({page: 'mywork'})}><Sun size={20} />My work</button>
        <button className={route.page === 'inbox' ? 'on' : ''} onClick={() => go({page: 'inbox'})}><span className="tab-icon"><Bell size={20} />{unread > 0 && <span className="dot-count">{unread > 99 ? '99+' : unread}</span>}</span>Inbox</button>
        <button className="tab-new" onClick={() => setCapture(true)} aria-label="New task"><Plus size={24} /></button>
        <button onClick={() => setPalette(true)}><Search size={20} />Search</button>
        <button className={drawer ? 'on' : ''} onClick={() => setDrawer(d => !d)}><Layers size={20} />Spaces</button>
      </nav>
      {store.error && <div className="toast">{store.error}</div>}
      {!store.error && store.notice && <div className="toast">{store.notice} <span className="small" style={{opacity: .6}}>Ctrl+Z undo, Ctrl+Shift+Z redo</span></div>}
    </div>
    </StoreContext.Provider>
  );
}

function Sidebar({store, me, setMe, route, unread, openPalette, open, onToggle, onShortcuts, signedIn}: {store: Store; me: string; setMe: (id: string) => void; route: Route; unread: number; openPalette: () => void; open: (id: string) => void; onToggle: () => void; onShortcuts: () => void; signedIn: boolean}) {
  const [who, setWho] = useState(false);
  const [wsOpen, setWsOpen] = useState(() => localStorage.getItem('side-ws') !== '0');
  // Projects whose views are shown under them (the arrow next to each project).
  const [openProjects, setOpenProjects] = useState<string[]>(() => JSON.parse(localStorage.getItem('side-open-projects') ?? '[]'));
  const toggleProject = (id: string) => setOpenProjects(l => { const n = l.includes(id) ? l.filter(x => x !== id) : [...l, id]; localStorage.setItem('side-open-projects', JSON.stringify(n)); return n; });
  const [newName, setNewName] = useState('');
  const person = store.people.find(p => p.id === me);
  const projectId = route.page === 'project' ? route.id : null;
  // Everything (all workspaces) only makes sense with more than one.
  const [wsList] = useWorkspaces();
  const wsCount = wsList.length;
  return (
    <nav className="sidebar">
      <div className="brand"><WorkspaceSwitcher store={store} me={me} /><button className="icon" title="Hide sidebar" onClick={onToggle}><PanelLeftClose size={16} /></button></div>
      <span className="picker" style={{display: 'block'}}>
        <button data-pop-trigger className="me nav-btn" onClick={() => setWho(o => !o)} title="Switch person">
          <Avatar person={person} size={22} /><span className="grow">{person?.name ?? 'Pick a person'}</span><ChevronDown size={14} />
        </button>
        <Popover open={who} onClose={() => setWho(false)}>
          {signedIn ? <>
            <div className="pop-label">Signed in</div>
            <button className="pop-row" onClick={async () => { await api('/auth/logout', {method: 'POST'}); location.reload(); }}><LogOut size={14} /> Sign out</button>
          </> : <>
          <div className="pop-label">Working as (sign-in is off, see Team)</div>
          {store.people.map(p => <button key={p.id} className={'pop-row' + (p.id === me ? ' on' : '')} onClick={() => { setMe(p.id); setWho(false); }}><Avatar person={p} />{p.name}</button>)}
          <div className="pop-sep" />
          <input className="pop-search" placeholder="Add person, Enter" value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={async e => { if (e.key === 'Enter' && newName.trim()) { await store.createPerson(newName); setNewName(''); } }} />
          </>}
        </Popover>
      </span>
      <button className="nav-btn" onClick={openPalette}><Search size={15} /> Search <kbd>Ctrl K</kbd></button>
      <button className={'nav-btn' + (route.page === 'mywork' ? ' active' : '')} onClick={() => go({page: 'mywork'})}><Sun size={15} /> My work</button>
      <button className={'nav-btn' + (route.page === 'day' ? ' active' : '')} title="Top 3, brain dump and time boxes for today" onClick={() => go({page: 'day'})}><CalendarClock size={15} /> Day planner</button>
      {wsCount > 1 && <button className={'nav-btn' + (route.page === 'today' ? ' active' : '')} onClick={() => go({page: 'today'})}><Layers size={15} /> Everything</button>}
      <button className={'nav-btn' + (route.page === 'inbox' ? ' active' : '')} onClick={() => go({page: 'inbox'})}><Bell size={15} /> Inbox {unread > 0 && <span className="badge">{unread}</span>}</button>
      {store.settings.features.approvals && <button className={'nav-btn' + (route.page === 'approvals' ? ' active' : '')} onClick={() => go({page: 'approvals'})}><FileSignature size={15} /> Approvals</button>}
      {store.settings.features.aiWork && <button className={'nav-btn' + (route.page === 'ai' ? ' active' : '')} onClick={() => go({page: 'ai'})}><Bot size={15} /> AI work</button>}

      <div className="nav-section">Spaces
        <NewProjectMenu store={store} onCreated={id => go({page: 'project', id, view: ''})} />
      </div>
      <ProjectList store={store} activeId={projectId} render={(p, n, x) => {
        const active = projectId === p.id, expanded = openProjects.includes(p.id);
        const views = expanded ? viewsFor(store, p.id) : [];
        return <>
          <ProjectNavButton store={store} project={p} active={active} extra={x} onOpen={() => go({page: 'project', id: p.id, view: viewsFor(store, p.id)[0]?.id ?? ''})}
            expanded={expanded} onToggle={() => toggleProject(p.id)} />
          {expanded && views.map(v => {
            const Icon = viewIcon(v.kind);
            const on = route.page === 'project' && (route.view === v.id || (!route.view && v === views[0]));
            return <ViewNavButton key={v.id} on={on} name={v.name} icon={<Icon size={14} color={VIEW_COLORS[v.kind]} />} onOpen={() => go({page: 'project', id: p.id, view: v.id})} onRename={name => store.updateView(v.id, {name})} />;
          })}
        </>;
      }} />

      <div className="side-bottom">
        <RunningTimer store={store} open={open} />
        <button className="nav-section nav-toggle" onClick={() => setWsOpen(o => { localStorage.setItem('side-ws', o ? '0' : '1'); return !o; })}>
          Workspace <ChevronDown size={13} style={{marginLeft: 'auto', transform: wsOpen ? 'none' : 'rotate(-90deg)'}} />
        </button>
        {wsOpen && <>
          <button className={'nav-btn' + (route.page === 'plan' ? ' active' : '')} onClick={() => go({page: 'plan'})}><Sparkles size={15} /> Plan and forecast</button>
          {(['routines', 'parked'] as const).map(scope => { const sp = store.projects.find(p => p.settings.rollup?.scope === scope); const on = !!sp && route.page === 'project' && route.id === sp.id;
            return <button key={scope} className={'nav-btn' + (on ? ' active' : '')} title={scope === 'routines' ? 'Every repeating task from every space' : 'Archived ideas, rejected work and snoozed items'} onClick={() => go({page: scope})}>
              {scope === 'routines' ? <Repeat size={15} /> : <Archive size={15} />} {sp?.name ?? (scope === 'routines' ? 'Routines' : 'Archive and later')}</button>; })}
          <button className={'nav-btn' + (route.page === 'boards' ? ' active' : '')} title="Map, design and run workflows on a canvas" onClick={() => go({page: 'boards'})}><Workflow size={15} /> Whiteboards</button>
          {store.settings.features.timeTracking && <button className={'nav-btn' + (route.page === 'timesheet' ? ' active' : '')} onClick={() => go({page: 'timesheet'})}><Clock size={15} /> Timesheet</button>}
          <button className={'nav-btn' + (route.page === 'templates' ? ' active' : '')} onClick={() => go({page: 'templates'})}><LayoutTemplate size={15} /> Templates</button>
          {store.settings.features.insights && <button className={'nav-btn' + (route.page === 'insights' ? ' active' : '')} onClick={() => go({page: 'insights'})}><BarChart3 size={15} /> Team insights</button>}
          <button className={'nav-btn' + (route.page === 'history' ? ' active' : '')} onClick={() => go({page: 'history'})}><History size={15} /> History</button>
          <button className={'nav-btn' + (route.page === 'team' ? ' active' : '')} onClick={() => go({page: 'team'})}>{store.settings.admin ? <><Shield size={15} /> Team and permissions</> : <><CircleUser size={15} /> My account</>}</button>
          <button className={'nav-btn' + (route.page === 'data' ? ' active' : '')} onClick={() => go({page: 'data'})}><Database size={15} /> Data and backups</button>
        </>}
        <div className="side-row">
          <button className={'nav-btn' + (route.page === 'help' ? ' active' : '')} onClick={() => go({page: 'help'})} title="Learn and tours"><GraduationCap size={15} /> Learn</button>
          <button className="nav-btn" onClick={onShortcuts} title="Keyboard shortcuts (?)"><Keyboard size={15} /></button>
          <AppearanceButton />
        </div>
      </div>
    </nav>
  );
}
/** Click opens the project, double-click renames it in place. */
/** Click opens the project, double-click renames it in place. Grip, icon kit and star show on hover. */
/** Space header: who can see this space, and (for personal spaces) inviting others in. */
function ShareButton({store, project}: {store: Store; project: Project}) {
  const [open, setOpen] = useState(false);
  const personal = !!project.settings.access?.private;
  return <span className="picker">
    <button className="tab" title={personal ? 'Personal space: only you and people you share with' : 'Who can see this space'} onClick={() => setOpen(o => !o)}>
      {personal ? <Lock size={14} /> : <Users size={14} />} Share
    </button>
    <Popover open={open} onClose={() => setOpen(false)} className="wide share-pop"><AccessCard store={store} project={project} /></Popover>
  </span>;
}

function ProjectNavButton({store, project, active, extra, onOpen, expanded, onToggle}: {store: Store; project: Project; active: boolean; extra: {grip: React.ReactNode; star: React.ReactNode; icon: React.ReactNode; menu: React.ReactNode}; onOpen: () => void; expanded: boolean; onToggle: () => void}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const done = () => { setEditing(false); if (name.trim() && name !== project.name) store.updateProject(project.id, {name: name.trim()}); else setName(project.name); };
  return (
    <div role="button" tabIndex={0} className={'nav-btn proj-nav' + (active ? ' active' : '') + (isRollup(project) ? ' is-rollup' : '')} onClick={() => !editing && onOpen()}
      onKeyDown={e => { if (e.key === 'Enter' && !editing) onOpen(); }} onDoubleClick={() => { setName(project.name); setEditing(true); }} title={isRollup(project) ? 'Work from many spaces together. Double-click to rename' : 'Double-click to rename'}>
      {extra.grip}
      <button className={'proj-caret' + (expanded ? ' open' : '')} title={expanded ? 'Hide views' : 'Show views'} aria-expanded={expanded} onClick={e => { e.stopPropagation(); onToggle(); }}><ChevronRight size={13} /></button>
      {extra.icon}
      {editing
        ? <input autoFocus className="nav-edit" value={name} onChange={e => setName(e.target.value)} onBlur={done} onClick={e => e.stopPropagation()}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') done(); if (e.key === 'Escape') { setName(project.name); setEditing(false); } }} />
        : <span className="grow proj-label">{project.name}</span>}
      {project.settings.access?.private && <Lock size={11} className="muted" aria-label="Personal space" />}
      {extra.menu}{extra.star}
    </div>
  );
}


/** A view under a space in the sidebar. Click opens it; double-click renames it in place, like a space. */
function ViewNavButton({on, name, icon, onOpen, onRename}: {on: boolean; name: string; icon: React.ReactNode; onOpen: () => void; onRename: (name: string) => void}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const done = () => { setEditing(false); if (text.trim() && text.trim() !== name) onRename(text.trim()); else setText(name); };
  return <button className={'nav-btn nav-sub' + (on ? ' active' : '')} title="Double-click to rename" onClick={() => !editing && onOpen()} onDoubleClick={() => { setText(name); setEditing(true); }}>
    {icon}
    {editing
      ? <input autoFocus className="nav-edit" value={text} onChange={e => setText(e.target.value)} onBlur={done} onClick={e => e.stopPropagation()}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') done(); if (e.key === 'Escape') { setText(name); setEditing(false); } }} />
      : name}
  </button>;
}

/** Live clock for the running timer, always visible. */
function RunningTimer({store, open}: {store: Store; open: (id: string) => void}) {
  const run = store.running;
  const now = useNow(!!run);
  if (!run) return null;
  const item = store.items.get(run.itemId);
  return (
    <div className="timer-chip">
      <span className="clock">{fmtClock(now - Date.parse(run.start))}</span>
      <span className="what" onClick={() => open(run.itemId)} title="Open item">{item?.title ?? 'Item'}</span>
      <button className="icon" title="Stop timer" onClick={() => store.stopTimer()}><Square size={13} fill="currentColor" /></button>
    </div>
  );
}

export function applyFilters(items: Item[], c: ViewConfig, ctx?: {project: Project; today: string; currentSprint: string | null; scope?: 'routines' | 'parked'}) {
  const text = c.text?.toLowerCase();
  // Paused and waiting routines show only in the Routines space; archived and snoozed items only in Archive and later.
  const keepRoutines = ctx?.scope === 'routines', keepParked = ctx?.scope === 'parked';
  return items.filter(i => (keepRoutines || (!i.recur?.paused && !i.recur?.waiting)) && (keepParked || (!i.fields.archived && !(typeof i.fields.snooze === 'string' && ctx && i.fields.snooze > ctx.today))) && (!ctx || matchFilter(i, c.filter, ctx)) &&
    (!text || i.title.toLowerCase().includes(text) || i.tags.some(t => t.toLowerCase().includes(text))) &&
    (!c.assignee || (c.assignee === 'none' ? !i.assignees.length : i.assignees.includes(c.assignee))) &&
    (!c.hideDone || !i.completed) &&
    (!c.types?.length || c.types.includes(i.type)));
}

/** Old links (#/routines, #/routines/<item>, #/parked) open the built-in space; a routine link scrolls to that routine. */
function SystemRedirect({store, scope, focus}: {store: Store; scope: 'routines' | 'parked'; focus?: string}) {
  const p = store.projects.find(x => x.settings.rollup?.scope === scope);
  useEffect(() => {
    if (!p) return;
    const vs = store.views.filter(v => v.projectId === p.id).sort((a, b) => a.sort - b.sort);
    const v = (focus ? vs.find(x => x.kind === 'routines') : undefined) ?? vs[0];
    if (focus) sessionStorage.setItem('routine-focus', focus);
    history.replaceState(null, '', `#/p/${p.id}/${v?.id ?? ''}`);
    dispatchEvent(new HashChangeEvent('hashchange'));
  }, [p?.id, focus, store.views.length]);
  return p ? null : <Empty title="Loading">Setting up the built-in space.</Empty>;
}

function ProjectPage({store, project: own, views, view, settings, open}: {store: Store; project: Project; views: ShownView[]; view?: ShownView; settings: boolean; open: (id: string) => void}) {
  // A rollup shows the chosen projects' work together, with their statuses, levels and fields merged.
  const included = useMemo(() => isRollup(own) ? includedIn(own, store.projects) : [], [own, store.projects]);
  const project = useMemo(() => isRollup(own) ? rollupProject(own, included) : own, [own, included]);
  const ids = useMemo(() => new Set([own.id, ...included.map(p => p.id)]), [own.id, included]);
  // Built-in spaces pick their items by kind: every live routine, or every archived or snoozed item.
  const scope = own.settings.rollup?.scope;
  const items = useMemo(() => [...store.items.values()].filter(i => ids.has(i.projectId) && (
    scope === 'routines' ? !!i.recur && !i.recur.spawned && !i.completed
    : scope === 'parked' ? !!i.fields.archived || (typeof i.fields.snooze === 'string' && i.fields.snooze > store.today)
    : true)), [store.items, ids, scope, store.today]);
  const config = view?.config ?? {};
  // A locked view keeps its setup; only unlocking changes it. Otherwise a change is yours or the team's,
  // by the workspace rule (src/customize.ts). Locking and privacy are about the view itself, so always the team's.
  const team = view ? store.views.find(v => v.id === view.id) ?? view : undefined;
  const setConfig = (patch: Partial<ViewConfig>) => {
    if (!view || !team || (view.config.locked && !('locked' in patch))) return;
    const mode = 'locked' in patch || 'privateTo' in patch ? 'team' : saveMode(store, 'viewSettings');
    if (mode === 'mine') store.setPref(`view:${view.id}`, {...view.mine, ...patch});
    else store.updateView(view.id, {config: {...team.config, ...patch}});
  };
  const currentSprint = useMemo(() => { const t = store.today; const list = store.sprints.filter(s => s.projectId === project.id); return (list.find(s => s.start <= t && t <= s.end) ?? null)?.id ?? null; }, [store.sprints, store.today, project.id]);
  const filtered = useMemo(() => applyFilters(items, config, {project, today: store.today, currentSprint, scope}), [items, config, project, store.today, currentSprint, scope]);
  const sprints = useMemo(() => store.sprints.filter(s => s.projectId === project.id), [store.sprints, project.id]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Drag view tabs to reorder them.
  const [dragView, setDragView] = useState<string | null>(null);
  const [overView, setOverView] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  useEffect(() => { setSelected(new Set()); }, [view?.id, project.id, JSON.stringify(config.filter ?? null), config.text, config.assignee, (config.types ?? []).join(), config.hideDone]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && selected.size && !(e.target as HTMLElement).closest('input,textarea,.popover')) setSelected(new Set()); };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, [selected]);
  const toggle = (id: string, e: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}, order: string[]) => {
    const next = new Set(selected);
    if (e.shiftKey && anchor.current && order.includes(anchor.current)) {
      const [a, b] = [order.indexOf(anchor.current), order.indexOf(id)].sort((x, y) => x - y);
      for (const x of order.slice(a, b + 1)) next.add(x);
    } else if (next.has(id)) next.delete(id); else next.add(id);
    anchor.current = id;
    setSelected(next);
  };
  const props = {store, project, items: filtered, allItems: items, sprints, open, config, setConfig, selected, toggle, setSelected};

  return <>
    <header className="head">
      {!isRollup(own) && <CoverHeader name={`space-${own.id}`} value={own.settings.cover} onChange={cover => store.updateProject(own.id, {settings: {...own.settings, cover}})} />}
      <div className="head-top">
        <span className="crumb">Spaces /</span>
        <InlineText value={project.name} onSave={name => name && store.updateProject(project.id, {name})} className="h1-edit" />
        <span className="muted small">{items.filter(i => !i.completed).length} open</span>
        {isRollup(own) && !scope && <button className="tag rollup-tag" onClick={() => go({page: 'project', id: own.id, view: 'settings'})} title="Choose which spaces show here">Rollup of {included.length} project{included.length === 1 ? '' : 's'}</button>}
        {scope && <span className="tag rollup-tag" title="Built in: always here, shows work from every space">Built in</span>}
      </div>
      {scope === 'routines' && !settings && <Suspense fallback={null}><RoutineSummary items={items} /></Suspense>}
      {scope === 'parked' && !settings && <p className="muted small space-note">Ideas you might do later, work parked for now, rejected items, and items snoozed until a date. Nothing here shows in other views. Open one to restore it, or use Restore in the table.</p>}
      <div className="tabs">
        {views.map(v => <span key={v.id} className={'tab-drag' + (dragView === v.id ? ' dragging' : '') + (overView === v.id && dragView && dragView !== v.id ? ' drop' : '')}
          draggable onDragStart={() => setDragView(v.id)} onDragEnd={() => { setDragView(null); setOverView(null); }}
          onDragOver={e => { if (dragView) { e.preventDefault(); setOverView(v.id); } }}
          onDrop={() => {
            if (!dragView || dragView === v.id) return;
            const list = views.filter(x => x.id !== dragView); list.splice(list.findIndex(x => x.id === v.id), 0, views.find(x => x.id === dragView)!);
            const order = saveMode(store, 'viewOrder');
            if (order === 'mine') store.setPref(`views:${project.id}`, list.map(x => x.id));
            else store.reorderViews(project.id, list.map(x => x.id));
            setDragView(null); setOverView(null);
          }}><ViewTab store={store} view={v} active={!settings && view?.id === v.id} project={project} /></span>)}
        <AddView store={store} project={project} />
        <span className="spacer" />
        {!isRollup(own) && <ShareButton store={store} project={own} />}
        <button className={'tab' + (settings ? ' active' : '')} onClick={() => go({page: 'project', id: project.id, view: 'settings'})}><Settings size={14} /> Settings</button>
      </div>
    </header>
    {!settings && view?.mine && <div className="locked-note mine-note">Your own changes to this view: only you see them.
      {canShare(store, 'viewSettings') ? <button className="btn ghost small" title="Make your changes the team setup for this view" onClick={() => { store.updateView(view.id, {config: {...(team?.config ?? {}), ...view.mine}}); store.setPref(`view:${view.id}`, null); }}>Save for everyone</button> : null}
      <button className="btn ghost small" title="Go back to the team setup" onClick={() => store.setPref(`view:${view.id}`, null)}>Reset to team view</button></div>}
    {!settings && view && view.config.locked && <div className="locked-note"><Lock size={12} /> This view is locked, so its filters, sort and columns stay as they are. Unlock it from the view's ... menu.</div>}
    {!settings && view && <Toolbar store={store} project={project} view={view} config={config} setConfig={setConfig} openItem={open} />}
    {/* Keyed by view, so one view's scroll position never carries into the next. */}
    <div className="content" key={(view?.id ?? '') + (settings ? 's' : '')}>
      <ViewBoundary key={(view?.id ?? '') + (settings ? 's' : '')}>
      {settings && <SettingsView store={store} project={own} onDeleted={() => go({page: 'mywork'})} />}
      {!settings && view?.kind === 'list' && <FileDrop store={store} projectId={own.id}><ListView {...props} /></FileDrop>}
      {!settings && view?.kind === 'table' && <TableView {...props} />}
      {!settings && view?.kind === 'board' && <FileDrop store={store} projectId={own.id}><BoardView {...props} /></FileDrop>}
      {!settings && view?.kind === 'files' && <FilesView {...props} />}
      {!settings && view?.kind === 'routines' && <Suspense fallback={null}><RoutinesView {...props} /></Suspense>}
      {!settings && view?.kind === 'whiteboard' && <Suspense fallback={null}><WhiteboardView store={store} project={project} open={open} config={config} setConfig={setConfig} /></Suspense>}
      {!settings && view?.kind === 'gantt' && <GanttView {...props} />}
      {!settings && view?.kind === 'calendar' && <CalendarView {...props} />}
      {!settings && view?.kind === 'workload' && <WorkloadView {...props} />}
      {!settings && view?.kind === 'backlog' && <BacklogView {...props} />}
      {!settings && view?.kind === 'sprint' && <SprintView {...props} />}
      {!settings && !view && <Empty title="No views yet">Add one with + View.</Empty>}
      </ViewBoundary>
      {!settings && <BulkBar store={store} project={project} sprints={sprints} selected={new Set([...selected].filter(id => filtered.some(i => i.id === id)))} clear={() => setSelected(new Set())} />}
    </div>
  </>;
}

function ViewTab({store, view, active, project}: {store: Store; view: View; active: boolean; project: Project}) {
  const teamConfig = () => store.views.find(v => v.id === view.id)?.config ?? view.config;
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(view.name);
  const Icon = viewIcon(view.kind);
  const save = () => { setEditing(false); if (name.trim() && name !== view.name) store.updateView(view.id, {name: name.trim()}); else setName(view.name); };
  return (
    <span className="picker">
      <button className={'tab' + (active ? ' active' : '')} onClick={() => go({page: 'project', id: project.id, view: view.id})} onDoubleClick={() => setEditing(true)} onContextMenu={e => { e.preventDefault(); setMenu(true); }}>
        <Icon size={14} color={VIEW_COLORS[view.kind]} />
        {view.config.locked && <Lock size={11} className="muted" />}{view.config.privateTo && <EyeOff size={11} className="muted" />}
        {editing ? <input autoFocus value={name} onChange={e => setName(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setName(view.name); setEditing(false); } }} onClick={e => e.stopPropagation()} /> : view.name}
        {active && !editing && <span data-pop-trigger className="icon" role="button" aria-label="View options" onClick={e => { e.stopPropagation(); setMenu(m => !m); }}><MoreHorizontal size={13} /></span>}
      </button>
      <Popover open={menu} onClose={() => setMenu(false)}>
        <button className="pop-row" onClick={() => { setMenu(false); setEditing(true); }}><Pencil size={14} /> Rename</button>
        <button className="pop-row" onClick={() => { setMenu(false); store.updateView(view.id, {config: {...teamConfig(), locked: !view.config.locked}}); }}>{view.config.locked ? <><Unlock size={14} /> Unlock view</> : <><Lock size={14} /> Lock view (keep filters, sort and columns)</>}</button>
        <button className="pop-row" onClick={() => { setMenu(false); store.updateView(view.id, {config: {...teamConfig(), privateTo: view.config.privateTo ? undefined : getMe() || undefined}}); }}>{view.config.privateTo ? <><Users size={14} /> Share with everyone</> : <><EyeOff size={14} /> Make private (only you see it)</>}</button>
        <button className="pop-row" onClick={async () => { setMenu(false); const v = await store.createView(project.id, view.name + ' copy', view.kind, view.config); if (v) go({page: 'project', id: project.id, view: v.id}); }}><Copy size={14} /> Duplicate</button>
        <button className="pop-row" onClick={async () => {
          setMenu(false);
          const n = prompt('Template name', `${view.name} view`);
          if (n === null) return;
          try { await api('/templates', {method: 'POST', body: {kind: 'view', viewId: view.id, projectId: project.id, name: n}}); alert(`Saved "${n || view.name}" as a view template. Add it to any space from + View.`); } catch (e) { store.fail(e); }
        }}><LayoutTemplate size={14} /> Save as template</button>
        {store.projects.length > 1 && <>
          <div className="pop-label">Copy to space</div>
          {store.projects.filter(p => p.id !== project.id).map(p => (
            <button key={p.id} className="pop-row" onClick={async () => { setMenu(false); const v = await store.createView(p.id, view.name, view.kind, {...view.config, columns: undefined, sprint: undefined}); if (v) go({page: 'project', id: p.id, view: v.id}); }}><FolderInput size={14} /> {p.name}</button>
          ))}
        </>}
        <div className="pop-sep" />
        <div className="pop-label">Change type</div>
        {VIEW_KINDS.filter(k => k.kind !== 'routines' || project.settings.rollup?.scope === 'routines').map(k => <button key={k.kind} className={'pop-row' + (k.kind === view.kind ? ' on' : '')} onClick={() => { setMenu(false); store.updateView(view.id, {kind: k.kind}); }}><k.icon size={14} /> {k.label}</button>)}
        <div className="pop-sep" />
        <button className="pop-row" style={{color: 'var(--danger)'}} onClick={() => { setMenu(false); if (confirm(`Delete view "${view.name}"? Items are not affected.`)) { store.deleteView(view.id); go({page: 'project', id: project.id, view: ''}); } }}><Trash2 size={14} /> Delete view</button>
      </Popover>
    </span>
  );
}

function AddView({store, project}: {store: Store; project: Project}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="picker">
      <button data-pop-trigger className="tab" onClick={() => setOpen(o => !o)}><Plus size={14} /> View</button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide">
        <div className="pop-label">Add a view</div>
        <ViewTemplatesList store={store} project={project} close={() => setOpen(false)} />
        {VIEW_KINDS.filter(k => k.kind !== 'routines' || project.settings.rollup?.scope === 'routines').map(k => (
          <button key={k.kind} className="pop-row" onClick={async () => { setOpen(false); const v = await store.createView(project.id, k.label, k.kind, k.kind === 'gantt' ? {zoom: 'week'} : {}); if (v) go({page: 'project', id: project.id, view: v.id}); }}>
            <k.icon size={16} /><span className="grow"><div>{k.label}</div><div className="muted small">{k.hint}</div></span>
          </button>
        ))}
      </Popover>
    </span>
  );
}

function Toolbar({store, project, view, config, setConfig, openItem}: {store: Store; project: Project; view: View; config: ViewConfig; setConfig: (p: Partial<ViewConfig>) => void; openItem: (id: string) => void}) {
  const [text, setText] = useState(config.text ?? '');
  const [typesOpen, setTypesOpen] = useState(false);
  useEffect(() => setText(config.text ?? ''), [view.id]);
  useEffect(() => { const t = setTimeout(() => { if ((config.text ?? '') !== text) setConfig({text}); }, 300); return () => clearTimeout(t); }, [text]);
  const types = config.types ?? [];
  const active = !!(config.text || config.assignee || config.hideDone || types.length || countRules(config.filter));
  return (
    <div className="toolbar">
      <NewFromTemplate store={store} project={project} onCreated={openItem} />
      <input className="search" placeholder="Filter by title or tag" value={text} onChange={e => setText(e.target.value)} />
      <select className="plain-select" value={config.assignee ?? ''} onChange={e => setConfig({assignee: e.target.value || undefined})} title="Assignee">
        <option value="">Anyone</option><option value="none">Unassigned</option>
        {store.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <span className="picker">
        <button data-pop-trigger className={'btn' + (types.length ? ' on' : '')} onClick={() => setTypesOpen(o => !o)}><Filter size={13} /> {types.length ? types.join(', ') : 'All types'}</button>
        <Popover open={typesOpen} onClose={() => setTypesOpen(false)}>
          {project.types.map(t => (
            <button key={t} className={'pop-row' + (types.includes(t) ? ' on' : '')} onClick={() => setConfig({types: types.includes(t) ? types.filter(x => x !== t) : [...types, t]})}>
              <TypeBadge type={t} /><span className="grow" />{types.includes(t) && '✓'}
            </button>
          ))}
        </Popover>
      </span>
      {(['list', 'table', 'board', 'gantt', 'calendar', 'workload', 'routines'] as string[]).includes(view.kind) && <SortButton project={project} config={config} setConfig={setConfig} />}
      <FilterButton store={store} project={project} sprints={store.sprints.filter(s => s.projectId === project.id)} value={config.filter} onChange={filter => setConfig({filter})} />
      <NewItemsButton store={store} />
      <AddToSpace store={store} project={project} />
      <button className={'btn' + (config.hideDone ? ' on' : '')} onClick={() => setConfig({hideDone: !config.hideDone})}>{config.hideDone ? 'Done hidden' : 'Showing done'}</button>
      {view.kind === 'board' && (
        <select className="plain-select" value={config.groupBy ?? 'status'} onChange={e => setConfig({groupBy: e.target.value as ViewConfig['groupBy']})} title="Group by">
          <option value="status">Group: Status</option><option value="assignee">Group: Assignee</option><option value="priority">Group: Priority</option><option value="type">Group: Type</option><option value="sprint">Group: Sprint</option>
        </select>
      )}
      {view.kind === 'board' && (
        <select className="plain-select" value={config.swimlane ?? 'none'} onChange={e => setConfig({swimlane: e.target.value as ViewConfig['swimlane']})} title="Swimlanes">
          <option value="none">No swimlanes</option><option value="assignee">Lanes: Assignee</option><option value="priority">Lanes: Priority</option><option value="type">Lanes: Type</option><option value="parent">Lanes: Parent</option><option value="worker">Lanes: Human or AI</option>
        </select>
      )}
      {view.kind === 'table' && <ColumnsMenu store={store} project={project} config={config} setConfig={setConfig} />}
      {['list', 'table', 'board'].includes(view.kind) && <ColorRulesButton store={store} project={project} config={config} setConfig={setConfig} />}
      {(view.kind === 'gantt' || view.kind === 'board') && <button className="btn" onClick={() => store.createSprint(project.id)}><Plus size={13} /> New sprint</button>}
      {view.kind === 'gantt' && (
        <select className="plain-select" value={config.colorBy ?? 'type'} onChange={e => setConfig({colorBy: e.target.value as ViewConfig['colorBy']})} title="Bar colors">
          <option value="type">Color: Type</option><option value="assignee">Color: Person</option><option value="status">Color: Status</option><option value="priority">Color: Priority</option>
        </select>
      )}
      {view.kind === 'board' && <button className={'btn' + (config.covers ? ' on' : '')} title="Show the first image attached to each card" onClick={() => setConfig({covers: !config.covers})}>Card covers</button>}
      {view.kind === 'gantt' && <button className={'btn' + (config.critical ? ' on' : '')} title="Highlight the tasks with no slack" onClick={() => setConfig({critical: !config.critical})}>Critical path</button>}
      {view.kind === 'gantt' && <BaselineMenu store={store} project={project} config={config} setConfig={setConfig} />}
      {view.kind === 'gantt' && (
        <div className="seg">{(['day', 'week', 'month'] as const).map(z => <button key={z} className={(config.zoom ?? 'week') === z ? 'on' : ''} onClick={() => setConfig({zoom: z})}>{z[0].toUpperCase() + z.slice(1)}</button>)}</div>
      )}
      {active && <button className="btn ghost" title="Clears the search, person, types, Showing done and filter rules. Sort and colors stay." onClick={() => { setText(''); setConfig({text: '', assignee: undefined, hideDone: false, types: [], filter: undefined}); }}><X size={13} /> Clear filters</button>}
      <span className="spacer" />
      <button className="btn ghost" title="Download the rows in this view as CSV" onClick={() => downloadCsv(`${project.key}-${view.name}`, project, applyFilters([...store.items.values()].filter(i => i.projectId === project.id), config, {project, today: store.today, currentSprint: store.sprints.find(s => s.projectId === project.id && s.start <= store.today && store.today <= s.end)?.id ?? null}).sort((a, b) => a.sort - b.sort), store)}><Download size={13} /> Export CSV</button>
    </div>
  );
}

function ColumnsMenu({store, project, config, setConfig}: {store: Store; project: Project; config: ViewConfig; setConfig: (p: Partial<ViewConfig>) => void}) {
  const [open, setOpen] = useState(false);
  const hidden = config.hidden ?? DEFAULT_HIDDEN;
  return (
    <span className="picker">
      <button data-pop-trigger className="btn" onClick={() => setOpen(o => !o)}><Columns3 size={13} /> Properties</button>
      <Popover open={open} onClose={() => setOpen(false)} className="wide">
        <div className="pop-label">Property visibility</div>
        <PropertyPanel cols={tableColumns(project)} config={config} setConfig={setConfig} defaultHidden={DEFAULT_HIDDEN} />
        {config.columns && <button className="pop-row muted" onClick={() => setConfig({columns: undefined})}>Reset widths and order</button>}
        <div className="pop-sep" />
        <div className="pop-label">New column</div>
        <AddField store={store} project={project} />
      </Popover>
    </span>
  );
}

/** Notifications the app sends on its own (no person behind them). */
const REMINDERS = ['due', 'overdue', 'timer', 'automation'];

function Inbox({store, me, open}: {store: Store; me: string; open: (id: string) => void}) {
  const [list, setList] = useState<Notification[]>([]);
  const [tab, setTab] = useState<'unread' | 'all'>('unread');
  const [settings, setSettings] = useState(false);
  useEffect(() => { if (me) api<Notification[]>(`/notifications?person=${me}`).then(setList).catch(() => {}); }, [me, store.tick]);
  const person = (id: string | null) => store.people.find(p => p.id === id);
  const unread = list.filter(n => !n.read).length;
  const shown = tab === 'unread' ? list.filter(n => !n.read) : list;
  return (
    <div className="page">
      <h1>Inbox <span className="spacer" />
        <button className={'btn' + (settings ? ' active' : '')} onClick={() => setSettings(s => !s)} title="Notification settings"><Settings size={14} /> Settings</button>
      </h1>
      {settings && <NotifySettings />}
      <div className="inbox-bar">
        <div className="seg"><button className={tab === 'unread' ? 'on' : ''} onClick={() => setTab('unread')}>Unread{unread ? ` ${unread}` : ''}</button><button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All</button></div>
        <span className="spacer" />
        {unread > 0 && <button className="btn ghost" onClick={() => api('/notifications/read?person=' + me, {method: 'POST', body: {}}).then(() => setList(l => l.map(n => ({...n, read: true}))))}>Mark all read</button>}
      </div>
      <div>
        {shown.map(n => (
          <div key={n.id} className={'note' + (n.read ? ' read' : '')} onClick={() => {
            if (!n.read) api('/notifications/read?person=' + me, {method: 'POST', body: {ids: [n.id]}});
            if (n.itemId && store.items.has(n.itemId)) open(n.itemId);
          }}>
            <Avatar person={person(n.actor)} size={24} />
            <span className="grow">{n.actor || !REMINDERS.includes(n.kind) ? <><b>{person(n.actor)?.name ?? 'Someone'}</b> </> : null}{n.text}</span>
            <span className="muted small">{new Date(n.created).toLocaleString()}</span>
          </div>
        ))}
      </div>
      {!shown.length && <Empty title="All caught up">You get notified when someone assigns you, mentions you, or comments on or completes your items, and before things are due.</Empty>}
    </div>
  );
}

function Palette({store, close, open}: {store: Store; close: () => void; open: (id: string) => void}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const results = useMemo(() => {
    const s = q.toLowerCase();
    return [...store.items.values()].filter(i => !s || i.title.toLowerCase().includes(s) || itemKey(i, store.projects).toLowerCase() === s).slice(0, 12);
  }, [q, store.items, store.projects]);
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={e => e.stopPropagation()}>
        <input autoFocus placeholder="Search items by title or key (GS-3)" value={q} onChange={e => { setQ(e.target.value); setSel(0); }}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); close(); }
            if (e.key === 'ArrowDown') setSel(s => Math.min(s + 1, results.length - 1));
            if (e.key === 'ArrowUp') setSel(s => Math.max(s - 1, 0));
            if (e.key === 'Enter' && results[sel]) open(results[sel].id);
          }} />
        {results.map((i, n) => (
          <div key={i.id} className={'pal-row' + (n === sel ? ' sel' : '')} onMouseEnter={() => setSel(n)} onClick={() => open(i.id)}>
            <span className="muted small">{itemKey(i, store.projects)}</span><TypeBadge type={i.type} /><span className="grow">{i.title}</span><Avatars ids={i.assignees} people={store.people} />
          </div>
        ))}
        {!results.length && <div className="pal-row muted">No matches</div>}
      </div>
    </div>
  );
}

/** Keeps one broken view from blanking the whole app; shows the error and a way back. */
class ViewBoundary extends Component<{children: ReactNode}, {error: Error | null}> {
  state = {error: null as Error | null};
  static getDerivedStateFromError(error: Error) { return {error}; }
  componentDidCatch(error: Error) { console.error('View crashed', error); }
  render() {
    if (!this.state.error) return <Suspense fallback={<div className="loading">Loading...</div>}>{this.props.children}</Suspense>;
    return <div className="empty"><div className="empty-title">This view hit a problem</div>
      <div className="muted small" style={{marginBottom: 10}}>{this.state.error.message}</div>
      <button className="btn" onClick={() => this.setState({error: null})}>Try again</button></div>;
  }
}

/** Timeline baselines: save today's dates under a name, then compare the live plan against it. */
function BaselineMenu({store, project, config, setConfig}: {store: Store; project: Project; config: ViewConfig; setConfig: (p: Partial<ViewConfig>) => void}) {
  const [open, setOpen] = useState(false);
  const list = config.baselines ?? [];
  const save = () => {
    const name = prompt('Name this baseline', `Plan ${new Date().toLocaleDateString()}`);
    if (!name) return;
    const dates: Record<string, [string | null, string | null]> = {};
    for (const i of store.items.values()) if (i.projectId === project.id && (i.start || i.due)) dates[i.id] = [i.start, i.due];
    const next = [...list, {name: name.slice(0, 60), at: new Date().toISOString(), dates}].slice(-10);
    setConfig({baselines: next, baseline: next.length - 1});
    setOpen(false);
  };
  return (
    <span className="picker">
      <button className={'btn' + (config.baseline != null ? ' on' : '')} onClick={() => setOpen(o => !o)} title="Compare the plan with a saved baseline">Baseline{config.baseline != null && list[config.baseline] ? `: ${list[config.baseline].name}` : ''}</button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <button className="pop-row" onClick={save}><Plus size={13} /> Save current dates as a baseline</button>
        {list.length > 0 && <div className="pop-sep" />}
        <button className={'pop-row' + (config.baseline == null ? ' on' : '')} onClick={() => { setConfig({baseline: null}); setOpen(false); }}>Do not show a baseline</button>
        {list.map((b, n) => (
          <div key={b.at} className={'pop-row' + (config.baseline === n ? ' on' : '')}>
            <button className="grow link-btn" onClick={() => { setConfig({baseline: n}); setOpen(false); }}>{b.name} <span className="muted small">{new Date(b.at).toLocaleDateString()}, {Object.keys(b.dates).length} items</span></button>
            <button className="icon" title="Delete baseline" onClick={() => setConfig({baselines: list.filter((_, k) => k !== n), baseline: config.baseline === n ? null : config.baseline != null && config.baseline > n ? config.baseline - 1 : config.baseline})}><X size={12} /></button>
          </div>
        ))}
      </Popover>
    </span>
  );
}

/** A link to a project from another workspace: find which one has it and offer to switch. */
function FindProject({id}: {id: string}) {
  const [where, setWhere] = useState<{id: string; name: string} | null | undefined>(undefined);
  useEffect(() => {
    api<{list: {id: string; name: string}[]}>('/workspaces').then(async r => {
      for (const w of r.list) if (w.id !== wsId()) {
        const ps = await fetch('/api/projects', {headers: {'x-workspace': w.id, 'x-person': ''}}).then(x => x.ok ? x.json() : []).catch(() => []);
        if ((ps as {id: string}[]).some(p => p.id === id)) return setWhere(w);
      }
      setWhere(null);
    }).catch(() => setWhere(null));
  }, [id]);
  if (where === undefined) return <Empty title="Looking for this space...">Checking your other workspaces.</Empty>;
  if (!where) return <Empty title="Space not found">It may have been deleted. Pick a space in the sidebar.</Empty>;
  return <Empty title={`This space is in ${where.name}`}><button className="btn primary" onClick={() => switchWorkspace(where.id, location.hash.slice(1))}>Open {where.name}</button></Empty>;
}

/** Saved view templates, offered at the top of + View. */
function ViewTemplatesList({store, project, close}: {store: Store; project: Project; close: () => void}) {
  const [list, setList] = useState<{id: string; name: string; data: {kind: ViewKind}}[]>([]);
  useEffect(() => { api<typeof list>('/templates?kind=view').then(setList).catch(() => {}); }, []);
  if (!list.length) return null;
  return <>
    {list.map(t => { const Icon = viewIcon(t.data.kind); return (
      <button key={t.id} className="pop-row" onClick={async () => { close(); try { const v = await api<View>(`/templates/${t.id}/use`, {method: 'POST', body: {projectId: project.id}}); go({page: 'project', id: project.id, view: v.id}); } catch (e) { store.fail(e); } }}>
        <Icon size={16} /><span className="grow"><div>{t.name}</div><div className="muted small">Saved view template</div></span>
      </button>); })}
    <div className="pop-sep" />
  </>;
}
