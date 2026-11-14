// Client state: everything loads once, edits apply instantly, server confirms, SSE keeps every tab in sync.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {defaultTokens} from './QuickAssist.tsx';
import {rollupTarget} from './rollup.ts';
export {rollupTarget, rollupSpaces} from './rollup.ts';
import type {ChangeEvent, Item, ItemPatch, Person, Project, Sprint, TimeEntry, View, ViewKind} from './types.ts';
import {DEFAULT_CUSTOM, DEFAULT_FEATURES, type Customization, type Features} from './types.ts';

// Which workspace this tab works in. The cookie lets images, file links and live updates reach the same one.
// An invite link carries its workspace (?ws=), so the person lands in the right one.
{
  const fromLink = new URLSearchParams(location.search).get('ws');
  if (fromLink && /^[a-z0-9]+$/i.test(fromLink)) { localStorage.setItem('tasks-ws', fromLink); sessionStorage.setItem('tasks-ws', fromLink); history.replaceState(null, '', location.pathname + location.hash); }
}
// Fixed for the life of this tab, so another tab switching workspace cannot redirect this one's edits.
const CURRENT_WS = sessionStorage.getItem('tasks-ws') || localStorage.getItem('tasks-ws') || 'main';
sessionStorage.setItem('tasks-ws', CURRENT_WS);
export const wsId = () => CURRENT_WS;
const setWsCookie = (id: string) => { document.cookie = `tasks_ws=${id}; path=/; SameSite=Lax; max-age=31536000`; };
setWsCookie(CURRENT_WS);
addEventListener('focus', () => setWsCookie(CURRENT_WS));
export function switchWorkspace(id: string, hash = '/mywork') {
  localStorage.setItem('tasks-ws', id);
  sessionStorage.setItem('tasks-ws', id);
  setWsCookie(id);
  location.hash = hash;
  location.reload();
}

// Who you are, per workspace. Per tab first, so two tabs can be two people while testing.
const meKey = () => `me:${wsId()}`;
export function getMe() {
  return sessionStorage.getItem(meKey()) ?? localStorage.getItem(meKey()) ?? (wsId() === 'main' ? sessionStorage.getItem('me') ?? localStorage.getItem('me') ?? '' : '');
}
export function storeMe(id: string) { sessionStorage.setItem(meKey(), id); localStorage.setItem(meKey(), id); }

/** A request to another workspace, as a given person there. */
export async function apiIn<T = any>(ws: string, path: string, me: string): Promise<T> {
  const res = await fetch('/api' + path, {headers: {'content-type': 'application/json', 'x-person': me, 'x-workspace': ws}});
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data as T;
}
/** Who you are in another workspace: your pick there, else the person with your email, else your name. */
export async function meIn(ws: string, email: string, name: string): Promise<string> {
  const saved = localStorage.getItem(`me:${ws}`) ?? (ws === 'main' ? localStorage.getItem('me') : null);
  if (saved) return saved;
  const people = await apiIn<{id: string; name: string; email: string | null}[]>(ws, '/people', '');
  const p = people.find(x => email && x.email?.toLowerCase() === email.toLowerCase()) ?? people.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (p) localStorage.setItem(`me:${ws}`, p.id);
  return p?.id ?? '';
}

export async function api<T = any>(path: string, init: {method?: string; body?: unknown} = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init.method ?? 'GET',
    headers: {'content-type': 'application/json', 'x-person': getMe(), 'x-workspace': wsId()},
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data as T;
}

/** Projects new work can go into (a rollup only shows work from other projects). */
export const validProject = (store: {projects: Project[]}, id: string | null) => id && store.projects.some(p => p.id === id && !p.settings.rollup) ? id : null;
export const realProjects = (ps: Project[]) => ps.filter(p => !p.settings.rollup).sort((a, b) => a.sort - b.sort);
export type Store = ReturnType<typeof useStore>;

type Settings = {custom: Customization; features: Features; admin: boolean};
type Boot = {people: Person[]; projects: Project[]; items: Item[]; today: string; sprints: Sprint[]; views: View[]; time?: Record<string, number>; prefs?: Record<string, unknown>; settings?: Settings};

export function useStore(me: string) {
  const [people, setPeople] = useState<Person[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [items, setItems] = useState<Map<string, Item>>(new Map());
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [views, setViews] = useState<View[]>([]);
  const [today, setToday] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0); // bumps on any server event so panels refetch comments/time
  const [calTick, setCalTick] = useState(0); // bumps when meetings or calendar events change
  const [running, setRunning] = useState<TimeEntry | null>(null);
  const [timeTotals, setTimeTotals] = useState<Map<string, number>>(new Map()); // logged minutes per item
  const [prefs, setPrefs] = useState<Record<string, unknown>>({}); // your own layout (src/customize.ts)
  const [settings, setSettings] = useState<Settings>({custom: DEFAULT_CUSTOM, features: DEFAULT_FEATURES, admin: true});
  const lastEvent = useRef<ChangeEvent | null>(null);
  const projectsRef = useRef<Project[]>([]);
  const itemsRef = useRef<Map<string, Item>>(new Map());
  const prefsRef = useRef<Record<string, unknown>>({});
  prefsRef.current = prefs;
  // Items you just made in this window: the views tint them and scroll to the newest one (New items menu).
  const [lastNew, setLastNew] = useState<{id: string; at: number} | null>(null);
  const markNew = (id: string) => setLastNew({id, at: Date.now()});
  // A rollup shows other spaces' work. New items go to the parent's space, or the space you picked for this rollup
  // ("Add to" in the toolbar, kept in your prefs), or the rollup's first space. Reads refs: the actions are memoized.
  const peopleRef = useRef<Person[]>([]);
  peopleRef.current = people;
  const realProject = (pid: string, parentId?: string | null) => {
    if (parentId) return itemsRef.current.get(parentId)?.projectId ?? pid;
    return rollupTarget(projectsRef.current, prefsRef.current, pid)?.id ?? pid;
  };
  // After adding from a rollup, say where the item went so it is never lost.
  const saidWhere = (pid: string, item: Item) => {
    if (!projectsRef.current.find(x => x.id === pid)?.settings.rollup) return;
    const sp = projectsRef.current.find(x => x.id === item.projectId);
    if (sp) flash(`Added to ${sp.name} as ${sp.key}-${item.number}`);
  };
  itemsRef.current = items;
  // Undo history for item edits, creates and deletes. Steps pushed in the same tick (one drop that moves a family) undo together.
  const undoStack = useRef<Step[][]>([]);
  const redoStack = useRef<Step[][]>([]);
  const batchOpen = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const push = (step: Step) => {
    if (batchOpen.current && undoStack.current.length) undoStack.current.at(-1)!.push(step);
    else { undoStack.current.push([step]); batchOpen.current = true; queueMicrotask(() => { batchOpen.current = false; }); }
    if (undoStack.current.length > 200) undoStack.current.shift();
    redoStack.current = [];
  };
  projectsRef.current = projects;

  const load = useCallback(async () => {
    const b = await api<Boot>('/bootstrap');
    setPeople(b.people); setProjects(b.projects); setToday(b.today); setSprints(b.sprints); setViews(b.views); setTimeTotals(new Map(Object.entries(b.time ?? {})));
    setPrefs(b.prefs ?? {}); if (b.settings) setSettings(prev => JSON.stringify(prev) === JSON.stringify(b.settings) ? prev : b.settings!);
    setItems(new Map(b.items.map(i => [i.id, i])));
    setReady(true);
  }, []);
  const loadSprints = useCallback(() => api<Sprint[]>('/sprints').then(setSprints), []);
  const loadViews = useCallback(async () => {
    const ps = await api<Project[]>('/projects');
    setViews((await Promise.all(ps.map(p => api<View[]>(`/views?projectId=${p.id}`)))).flat());
  }, []);

  // Who you are decides your private views, your own layout and admin rights: reload when that changes
  // (picking a person, or the first visit before you are known). The first load happens below.
  const firstMe = useRef(true);
  useEffect(() => { if (firstMe.current) { firstMe.current = false; return; } load().catch(() => {}); }, [me]);
  useEffect(() => {
    load().catch(e => setError(String(e)));
    const es = new EventSource(`/api/events?ws=${wsId()}`);
    es.onmessage = m => {
      const e = JSON.parse(m.data) as ChangeEvent;
      lastEvent.current = e;
      if (e.kind === 'item') setItems(prev => new Map(prev).set(e.item.id, e.item));
      else if (e.kind === 'item-deleted') setItems(prev => { const n = new Map(prev); n.delete(e.id); return n; });
      else if (e.kind === 'project') setProjects(prev => prev.some(p => p.id === e.project.id) ? prev.map(p => p.id === e.project.id ? e.project : p) : [...prev, e.project]);
      else if (e.kind === 'project-deleted') setProjects(prev => prev.filter(p => p.id !== e.id));
      else if (e.kind === 'people') api<Person[]>('/people').then(setPeople);
      else if (e.kind === 'time') api<number>(`/time/totals?itemId=${e.itemId}`).then(m => setTimeTotals(prev => new Map(prev).set(e.itemId, m))).catch(() => {});
      else if (e.kind === 'sprint') loadSprints();
      else if (e.kind === 'view') loadViews();
      else if (e.kind === 'refresh') { load(); setCalTick(t => t + 1); }
      else if (e.kind === 'events') setCalTick(t => t + 1);
      setTick(t => t + 1);
    };
    es.onerror = () => {}; // EventSource reconnects on its own
    return () => es.close();
  }, [load, loadSprints, loadViews]);

  useEffect(() => {
    if (!me) { setRunning(null); return; }
    api<TimeEntry | null>(`/time/running?person=${me}`).then(setRunning).catch(() => {});
  }, [me, tick]);

  const fail = useCallback((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setTimeout(() => setError(null), 4000); }, []);

  const actions = useMemo(() => ({
    updateItem(id: string, patch: ItemPatch, record = true) {
      const cur0 = itemsRef.current.get(id);
      if (record && cur0) {
        const before = Object.fromEntries(Object.keys(patch).map(k => [k, (cur0 as any)[k]])) as ItemPatch;
        push({kind: 'update', id, before, after: patch, label: describe(patch, cur0.title)});
      }
      // Apply instantly, including done state, so checks feel immediate.
      setItems(prev => {
        const cur = prev.get(id);
        if (!cur) return prev;
        const next = {...cur, ...patch};
        if (patch.status) {
          const cat = projectsRef.current.find(p => p.id === next.projectId)?.statuses.find(s => s.id === patch.status)?.category;
          next.completed = cat === 'done' ? (cur.completed ?? new Date().toISOString()) : null;
        }
        return new Map(prev).set(id, next);
      });
      return api<Item>(`/items/${id}`, {method: 'PATCH', body: patch}).catch(e => { fail(e); load(); });
    },
    async quickAdd(projectId: string, text: string, extra: {parentId?: string | null; status?: string; sort?: number; sprint?: string | null} = {}) {
      const asked = projectId;
      projectId = realProject(projectId, extra.parentId);
      // "Always add my defaults" (New items menu): fill in what the line does not set itself.
      if ((prefsRef.current.newDefaults as {auto?: boolean} | undefined)?.auto) { const d = defaultTokens({people: peopleRef.current, me, prefs: prefsRef.current}, text); if (d) text = `${text} ${d}`; }
      try { const item = await api<Item>('/items/quick', {method: 'POST', body: {projectId, text, ...extra}}); markNew(item.id); if (!extra.parentId) saidWhere(asked, item); setItems(prev => new Map(prev).set(item.id, item)); push({kind: 'create', id: item.id, label: `create "${item.title}"`}); return item; }
      catch (e) { fail(e); return null; }
    },
    async createItem(input: ItemPatch & {projectId: string; title: string}) {
      const asked = input.projectId;
      input = {...input, projectId: realProject(input.projectId, input.parentId)};
      try { const item = await api<Item>('/items', {method: 'POST', body: input}); markNew(item.id); if (!input.parentId) saidWhere(asked, item); setItems(prev => new Map(prev).set(item.id, item)); push({kind: 'create', id: item.id, label: `create "${item.title}"`}); return item; }
      catch (e) { fail(e); return null; }
    },
    deleteItem(id: string, record = true) {
      if (record) {
        // Snapshot the item and its descendants, parents first, so undo can rebuild the tree.
        const all = [...itemsRef.current.values()];
        const tree: Item[] = [];
        const walk = (x: string) => { const it = itemsRef.current.get(x); if (it) { tree.push(it); all.filter(c => c.parentId === x).forEach(c => walk(c.id)); } };
        walk(id);
        if (tree.length) push({kind: 'delete', items: tree, label: `delete "${tree[0].title}"`});
      }
      setItems(prev => { const n = new Map(prev); n.delete(id); return n; });
      return api(`/items/${id}`, {method: 'DELETE'}).catch(e => { fail(e); load(); });
    },
    async createProject(name: string) {
      try { const p = await api<Project>('/projects', {method: 'POST', body: {name}}); setProjects(prev => prev.some(x => x.id === p.id) ? prev : [...prev, p]); await loadViews(); return p; }
      catch (e) { fail(e); return null; }
    },
    updateProject(id: string, patch: Partial<Project>) {
      setProjects(prev => prev.map(p => p.id === id ? {...p, ...patch} : p));
      return api<Project>(`/projects/${id}`, {method: 'PATCH', body: patch}).catch(e => { fail(e); load(); });
    },
    deleteProject(id: string) { return api(`/projects/${id}`, {method: 'DELETE'}).catch(fail); },
    async createPerson(name: string) {
      try { return await api<Person>('/people', {method: 'POST', body: {name}}); } catch (e) { fail(e); return null; }
    },
    async createView(projectId: string, name: string, kind: ViewKind, config = {}) {
      const add = (v: View) => { setViews(prev => [...prev.filter(x => x.id !== v.id), v]); return v; };
      try { return add(await api<View>('/views', {method: 'POST', body: {projectId, name, kind, config}})); }
      catch (e) {
        // No permission to add shared views here: make it a private view of your own instead.
        const me = await api<{person: {id: string} | null}>('/auth/me').then(r => r.person?.id ?? '').catch(() => '');
        if (me && e instanceof Error && /Create and change views/.test(e.message)) {
          try { return add(await api<View>('/views', {method: 'POST', body: {projectId, name, kind, config: {...config, privateTo: me}}})); } catch (e2) { fail(e2); return null; }
        }
        fail(e); return null;
      }
    },
    updateView(id: string, patch: Partial<View>) {
      setViews(prev => prev.map(v => v.id === id ? {...v, ...patch} : v));
      return api<View>(`/views/${id}`, {method: 'PATCH', body: patch}).catch(e => { fail(e); load(); });
    },
    /** Saves part of your own layout; null removes it. */
    setPref(key: string, value: unknown) {
      setPrefs(prev => { const n = {...prev}; if (value === null) delete n[key]; else n[key] = value; return n; });
      return api('/prefs', {method: 'PUT', body: {key, value}}).catch(fail);
    },
    reorderPeople(ids: string[]) {
      setPeople(prev => [...prev].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)));
      return api('/people/order', {method: 'PUT', body: {ids}}).catch(e => { fail(e); load(); });
    },
    reorderViews(projectId: string, ids: string[]) {
      setViews(prev => prev.map(v => ids.includes(v.id) ? {...v, sort: ids.indexOf(v.id)} : v));
      return api('/views/order', {method: 'PUT', body: {projectId, ids}}).catch(e => { fail(e); load(); });
    },
    deleteView(id: string) {
      setViews(prev => prev.filter(v => v.id !== id));
      return api(`/views/${id}`, {method: 'DELETE'}).catch(fail);
    },
    async createSprint(projectId: string, input: Partial<Sprint> = {}) {
      try { const s = await api<Sprint>('/sprints', {method: 'POST', body: {projectId, ...input}}); setSprints(prev => [...prev.filter(x => x.id !== s.id), s]); return s; }
      catch (e) { fail(e); return null; }
    },
    updateSprint(id: string, patch: Partial<Sprint>) {
      setSprints(prev => prev.map(s => s.id === id ? {...s, ...patch} : s));
      return api<Sprint>(`/sprints/${id}`, {method: 'PATCH', body: patch}).catch(e => { fail(e); loadSprints(); });
    },
    deleteSprint(id: string) {
      setSprints(prev => prev.filter(s => s.id !== id));
      return api(`/sprints/${id}`, {method: 'DELETE'}).catch(fail);
    },
    async startTimer(itemId: string, kind: 'work' | 'review' = 'work') {
      try { setRunning(await api<TimeEntry>('/time/start', {method: 'POST', body: {itemId, kind}})); } catch (e) { fail(e); }
    },
    async stopTimer() {
      try { await api('/time/stop', {method: 'POST', body: {}}); setRunning(null); } catch (e) { fail(e); }
    },
    fail,
    async undo() { await replay(undoStack.current.pop(), 'undo'); },
    async redo() { await replay(redoStack.current.pop(), 'redo'); },
  }), [load, loadSprints, loadViews, fail]);

  // Apply a group of steps backwards (undo) or forwards (redo) without recording new history.
  async function replay(group: Step[] | undefined, dir: 'undo' | 'redo') {
    if (!group) { flash(dir === 'undo' ? 'Nothing to undo' : 'Nothing to redo'); return; }
    const steps = dir === 'undo' ? [...group].reverse() : group;
    const out: Step[] = [];
    for (const st of steps) {
      if (st.kind === 'update') {
        actions.updateItem(st.id, dir === 'undo' ? st.before : st.after, false);
        out.push(st);
      } else if (st.kind === 'create') {
        const snap = itemsRef.current.get(st.id);
        actions.deleteItem(st.id, false);
        out.push(snap ? {kind: 'delete', items: [snap], label: st.label, fromCreate: true} : st);
      } else if (dir === 'undo' && !st.fromCreate) {
        // Restore through the saved history: same ids, comments and links come back.
        try {
          const acts = await api<{id: number; kind: string}[]>(`/activity?itemId=${st.items[0].id}&limit=5`);
          const del = acts.find(x => x.kind === 'delete');
          if (del) { await api(`/activity/${del.id}/revert`, {method: 'POST'}); out.push(st); continue; }
        } catch (e) { fail(e); }
      } else {
        // Recreate deleted items (new ids), remapping parents and dependencies inside the group.
        const map = new Map<string, string>();
        for (const it of st.items) {
          try {
            const {id, projectId, parentId, type, title, body, status, priority, assignees, start, due, estimate, tags, sprint, sort, recur, fields, deps} = it;
            const made = await api<Item>('/items', {method: 'POST', body: {
              projectId, type, title, body, status, priority, assignees, start, due, estimate, tags, sprint, sort, recur, fields,
              parentId: parentId ? map.get(parentId) ?? (itemsRef.current.has(parentId) ? parentId : null) : null,
              deps: deps.map(d => map.get(d) ?? d).filter(d => itemsRef.current.has(d) || [...map.values()].includes(d)),
            }});
            map.set(id, made.id);
            setItems(prev => new Map(prev).set(made.id, made));
            itemsRef.current = new Map(itemsRef.current).set(made.id, made);
          } catch (e) { fail(e); }
        }
        out.push(st.fromCreate
          ? {kind: 'create', id: map.get(st.items[0].id) ?? st.items[0].id, label: st.label}
          : {kind: 'delete', items: st.items.map(i => ({...i, id: map.get(i.id) ?? i.id, parentId: i.parentId ? map.get(i.parentId) ?? i.parentId : null})), label: st.label});
      }
    }
    // A create that was undone becomes a delete; redoing it recreates. Mirror steps onto the other stack.
    // An undone delete is redone by deleting the same item again.
    const mirrored = out.map(st => st.kind === 'delete' && !st.fromCreate && dir === 'undo' ? {kind: 'create', id: st.items[0].id, label: st.label} as Step : st);
    (dir === 'undo' ? redoStack : undoStack).current.push(dir === 'undo' ? mirrored.reverse() : mirrored);
    flash(`${dir === 'undo' ? 'Undid' : 'Redid'} ${group[0].label}${group.length > 1 ? ` and ${group.length - 1} more` : ''}`);
  }
  function flash(msg: string) { setNotice(msg); setTimeout(() => setNotice(n => n === msg ? null : n), 2500); }

  return {me, people, projects, items, sprints, views, today, error, ready, tick, calTick, running, timeTotals, prefs, settings, lastEvent, notice, lastNew, flash, ...actions};
}

// Sort key between two neighbors, for drag and insert.
export function between(a: number | undefined, b: number | undefined) {
  if (a === undefined && b === undefined) return 1;
  if (a === undefined) return b! - 1;
  if (b === undefined) return a + 1;
  return (a + b) / 2;
}

/** Re-renders every `ms` so running timers count up on screen. */
export function useNow(active: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function fmtMinutes(m: number) {
  if (m < 1) return '0m';
  return m < 60 ? `${Math.floor(m)}m` : `${Math.floor(m / 60)}h ${Math.floor(m % 60)}m`;
}
export function fmtClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000)), p = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

type Step =
  | {kind: 'update'; id: string; before: ItemPatch; after: ItemPatch; label: string}
  | {kind: 'create'; id: string; label: string}
  | {kind: 'delete'; items: Item[]; label: string; fromCreate?: boolean};

function describe(patch: ItemPatch, title: string) {
  const keys = Object.keys(patch).filter(k => k !== 'sort');
  if (!keys.length) return `reorder "${title}"`;
  if (keys.every(k => k === 'start' || k === 'due')) return `date change on "${title}"`;
  return `${keys.join(', ')} change on "${title}"`;
}
