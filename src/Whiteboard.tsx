// Whiteboards: a canvas to map, design and run workflows. Task cards link to real tasks and routines, link cards
// open documents (Google Drive SOPs), triggers and webhooks show where automations start and what they call.
// Saved to /api/boards; runs to /api/boards/:id/run. Agents reach the same through MCP (server/boards.ts).
import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {CirclePlay, Diamond, Heading, Info, Table2, MousePointer2, Hand, Bot, CheckSquare, Circle, Copy, ExternalLink, Frame, Link2, Maximize, Minus, Play, Plus, Repeat, Square, StickyNote, Trash2, Type, User, Webhook, Workflow, X, Zap, Flag, ListPlus, Map as MapIcon, History, Settings2} from 'lucide-react';
import type {Item, Person, Project} from './types.ts';
import {api, type Store} from './store.ts';
import {Avatars, itemKey} from './components.tsx';

type Kind = 'task' | 'sticky' | 'text' | 'shape' | 'frame' | 'link' | 'trigger' | 'webhook' | 'end' | 'terminal' | 'decision' | 'info' | 'table' | 'title';
type TriggerOn = 'manual' | 'webhook' | 'completed' | 'schedule';
export type WbNode = {id: string; kind: Kind; x: number; y: number; w: number; h: number; text: string; color?: string | null; itemId?: string | null; url?: string | null;
  assignees?: string[]; worker?: 'human' | 'ai' | 'either'; sop?: string | null; estimate?: number | null; repeat?: string | null; shape?: 'rect' | 'ellipse' | 'diamond'; table?: string[][];
  trigger?: {on: TriggerOn; tag?: string | null; every?: 'day' | 'week' | 'month' | null}};
export type WbEdge = {id: string; from: string; to: string; label?: string | null; kind?: 'flow' | 'link'};
type Hook = {id: string; url: string; events: string[]};
export type Board = {id: string; projectId: string | null; name: string; description: string; sop?: string | null; nodes: WbNode[]; edges: WbEdge[]; webhooks: Hook[]; hookKey?: string; hookUrl?: string; createdBy: string | null; updated: string};
type Step = {node: string; kind: Kind; title: string; itemId: string | null; state: string; at: string | null; note: string | null};
type Run = {id: string; boardId: string; state: string; trigger: string; started: string; finished: string | null; parentItem: string | null; steps: Step[]; log: {at: string; text: string}[]};

const SIZES: Record<Kind, [number, number]> = {task: [220, 96], sticky: [180, 140], text: [200, 40], shape: [160, 100], frame: [600, 400], link: [220, 64], trigger: [180, 64], webhook: [200, 72], end: [120, 52],
  terminal: [150, 56], decision: [170, 110], info: [240, 110], table: [360, 150], title: [480, 64]};
const STICKY = ['#fef3c7', '#dcfce7', '#dbeafe', '#fce7f3', '#ede9fe', '#ffedd5', '#f1f5f9'];
/** Toolbar, in two groups: the flow (steps and how a run moves) and notes (layout and information). key: keyboard shortcut. */
const KINDS: {kind: Kind; label: string; icon: typeof Square; hint: string; key: string; group: 'flow' | 'notes'}[] = [
  {kind: 'terminal', label: 'Start/stop', icon: CirclePlay, hint: 'Where the flow starts or stops (a pill)', key: 'O', group: 'flow'},
  {kind: 'task', label: 'Task', icon: CheckSquare, hint: 'A step. Link it to a task or routine, or create one from it', key: 'T', group: 'flow'},
  {kind: 'decision', label: 'Decision', icon: Diamond, hint: 'A yes or no question. Label the arrows out of it (yes, no)', key: 'D', group: 'flow'},
  {kind: 'trigger', label: 'Trigger', icon: Zap, hint: 'Where a run starts: by hand, from a webhook, on a schedule, or when a tagged task is done', key: 'G', group: 'flow'},
  {kind: 'webhook', label: 'Webhook', icon: Webhook, hint: 'Calls a URL (Zapier, n8n, Make) once the steps before it are done', key: 'W', group: 'flow'},
  {kind: 'end', label: 'End', icon: Flag, hint: 'The run is done when it gets here', key: 'E', group: 'flow'},
  {kind: 'title', label: 'Title', icon: Heading, hint: 'A heading for the board or an area: first line big, the rest a subtitle', key: 'H', group: 'notes'},
  {kind: 'text', label: 'Text', icon: Type, hint: 'A label', key: 'X', group: 'notes'},
  {kind: 'sticky', label: 'Sticky', icon: StickyNote, hint: 'A note', key: 'S', group: 'notes'},
  {kind: 'info', label: 'Info', icon: Info, hint: 'An information box: what to know at this step', key: 'I', group: 'notes'},
  {kind: 'table', label: 'Table', icon: Table2, hint: 'Rows and columns, first row is the header. Double-click a cell to edit', key: 'B', group: 'notes'},
  {kind: 'shape', label: 'Shape', icon: Circle, hint: 'Box or circle', key: 'R', group: 'notes'},
  {kind: 'frame', label: 'Frame', icon: Frame, hint: 'Group an area. Moving it moves what is inside', key: 'F', group: 'notes'},
  {kind: 'link', label: 'Link', icon: Link2, hint: 'A document, like a Google Drive SOP. Connect it to tasks to attach it', key: 'L', group: 'notes'},
];
const NOTE_KINDS = new Set<Kind>(['sticky', 'text', 'shape', 'frame', 'link', 'info', 'table', 'title']);
/** Every new board opens with a heading. */
const titleNode = (name: string): WbNode => ({id: rid(), kind: 'title', x: 0, y: 0, w: 480, h: 64, text: `${name}\nWhat this flow is for`});
const STATE_COLOR: Record<string, string> = {waiting: '#94a3b8', open: '#3b82f6', done: '#22c55e', fired: '#22c55e', firing: '#f59e0b', failed: '#ef4444', skipped: '#a1a1aa'};
const STEP_KINDS = new Set<Kind>(['task', 'webhook', 'end', 'trigger']);
const rid = () => Math.random().toString(36).slice(2, 10);
const snap = (v: number) => Math.round(v / 10) * 10;
/** A routine's finished copy points to the next one. */
const live = (items: Map<string, Item>, id: string | null | undefined) => { let it = id ? items.get(id) : undefined; for (let n = 0; it?.recur?.spawned && n < 200; n++) it = items.get(it.recur.spawned) ?? it; return it; };

/** Where the line from a box's center toward (tx, ty) leaves the box. */
function edgePoint(n: WbNode, tx: number, ty: number) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return {x: cx, y: cy};
  const s = Math.min(Math.abs((n.w / 2) / (dx || 1e-9)), Math.abs((n.h / 2) / (dy || 1e-9)));
  return {x: cx + dx * s, y: cy + dy * s};
}

export function WhiteboardsPage({store, id, open}: {store: Store; id?: string; open: (id: string) => void}) {
  if (id) return <BoardCanvas store={store} boardId={id} open={open} back />;
  return <BoardList store={store} />;
}

function BoardList({store}: {store: Store}) {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<Board[]>('/boards').then(setBoards).catch(e => store.fail(e)); }, [store.tick]);
  const make = async (path: string, body: unknown) => {
    setBusy(true);
    try { const b = await api<Board>(path, {method: 'POST', body}); location.hash = `/boards/${b.id}`; } catch (e) { store.fail(e); } finally { setBusy(false); }
  };
  const spaces = store.projects.filter(p => !p.settings.rollup);
  const bySop = async () => {
    setBusy(true);
    try { const r = await api<{made: Board[]; kept: Board[]}>('/boards/by-sop', {method: 'POST', body: {}}); store.flash(r.made.length ? `Made ${r.made.length} SOP board${r.made.length === 1 ? '' : 's'}${r.kept.length ? `, ${r.kept.length} already had one` : ''}` : r.kept.length ? 'Every SOP already has a board' : 'No routines have an SOP tag yet'); setBoards(await api<Board[]>('/boards')); }
    catch (e) { store.fail(e); } finally { setBusy(false); }
  };
  return <div className="wb-list">
    <header className="head"><div className="head-top"><h1><Workflow size={20} /> Whiteboards</h1></div>
      <p className="muted small space-note">Map how work flows: routines, automations, webhooks and who does each step, person or AI. Link cards to tasks and SOP documents, turn ideas into tasks, and run a board to make its tasks in order.</p></header>
    <div className="wb-new">
      <button className="btn primary" disabled={busy} onClick={() => make('/boards', {name: 'Untitled board', projectId: spaces[0]?.id ?? null, nodes: [titleNode('Untitled board')]})}><Plus size={14} /> New whiteboard</button>
      <button className="btn" disabled={busy} onClick={bySop} title="One board for each SOP: its routines in order, a title and the SOP document. SOPs that have a board keep it"><Repeat size={14} /> One board per SOP</button>
      <button className="btn ghost" disabled={busy} onClick={() => make('/boards/from-items', {routines: true})} title="Every routine on one big board, a frame per SOP"><MapIcon size={14} /> All routines on one board</button>
    </div>
    {!boards ? <div className="loading">Loading...</div> : !boards.length ? <p className="muted">No whiteboards yet.</p> :
      <div className="wb-cards">{boards.map(b => {
        const sp = store.projects.find(p => p.id === b.projectId);
        const tasks = b.nodes.filter(n => n.kind === 'task'), linked = tasks.filter(n => n.itemId).length;
        return <a key={b.id} className="wb-card" href={`#/boards/${b.id}`}>
          <MiniMap board={b} />
          <b>{b.name}</b>
          <span className="muted small">{b.sop ? <span className="tag">{b.sop}</span> : null} {sp ? sp.name : 'No space'} · {tasks.length} task card{tasks.length === 1 ? '' : 's'}{tasks.length ? `, ${linked} linked` : ''}</span>
        </a>;
      })}</div>}
  </div>;
}

function MiniMap({board}: {board: Board}) {
  const ns = board.nodes;
  if (!ns.length) return <div className="wb-mini empty" />;
  const x0 = Math.min(...ns.map(n => n.x)), y0 = Math.min(...ns.map(n => n.y)), x1 = Math.max(...ns.map(n => n.x + n.w)), y1 = Math.max(...ns.map(n => n.y + n.h));
  return <svg className="wb-mini" viewBox={`${x0 - 20} ${y0 - 20} ${x1 - x0 + 40} ${y1 - y0 + 40}`} preserveAspectRatio="xMidYMid meet">
    {ns.map(n => <rect key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} rx={8} fill={n.kind === 'frame' ? 'none' : n.kind === 'sticky' ? (n.color ?? STICKY[0]) : 'var(--accent-soft)'} stroke="var(--line)" strokeWidth={4} />)}
  </svg>;
}

/** A space's Whiteboard view: the board saved on the view, or a way to start one. */
export function WhiteboardView({store, project, open, config, setConfig}: {store: Store; project: Project; open: (id: string) => void; config: {board?: string}; setConfig: (p: {board?: string}) => void}) {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const scope = project.settings.rollup?.scope;
  const realSpace = !project.settings.rollup;
  useEffect(() => { if (!config.board) api<Board[]>(realSpace ? `/boards?projectId=${project.id}` : '/boards').then(setBoards).catch(() => setBoards([])); }, [config.board, project.id, realSpace]);
  if (config.board) return <BoardCanvas store={store} boardId={config.board} open={open} onGone={() => setConfig({board: undefined})} />;
  const make = async (path: string, body: unknown) => { try { const b = await api<Board>(path, {method: 'POST', body}); setConfig({board: b.id}); } catch (e) { store.fail(e); } };
  return <div className="wb-pick">
    <h3><Workflow size={16} /> Whiteboard</h3>
    <p className="muted small">Pick the board this view shows, or start one.</p>
    <div className="wb-new">
      {realSpace && <button className="btn primary" onClick={() => make('/boards', {name: `${project.name} flow`, projectId: project.id, nodes: [titleNode(`${project.name} flow`)]})}><Plus size={14} /> Blank board for {project.name}</button>}
      {scope === 'routines' && <button className="btn primary" onClick={() => make('/boards/from-items', {routines: true, name: 'Routines map'})}><Repeat size={14} /> Map every routine by SOP</button>}
      {realSpace && <button className="btn" onClick={() => make('/boards/from-items', {itemIds: [...store.items.values()].filter(i => i.projectId === project.id && !i.completed && !i.parentId).slice(0, 120).map(i => i.id), projectId: project.id, name: `${project.name} map`})}><MapIcon size={14} /> Draw this space's open work</button>}
    </div>
    {!!boards?.length && <><h4>Or show one of these</h4><div className="wb-cards">{boards.map(b => <button key={b.id} className="wb-card" onClick={() => setConfig({board: b.id})}><MiniMap board={b} /><b>{b.name}</b></button>)}</div></>}
  </div>;
}

type Drag =
  | {mode: 'pan'; sx: number; sy: number; ox: number; oy: number}
  | {mode: 'move'; sx: number; sy: number; orig: Map<string, {x: number; y: number}>; moved: boolean}
  | {mode: 'resize'; id: string; sx: number; sy: number; w: number; h: number}
  | {mode: 'connect'; from: string; x: number; y: number; target: string | null}
  | {mode: 'marquee'; x0: number; y0: number; x: number; y: number};

export function BoardCanvas({store, boardId, open, back, onGone}: {store: Store; boardId: string; open: (id: string) => void; back?: boolean; onGone?: () => void}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [nodes, setNodes] = useState<WbNode[]>([]);
  const [edges, setEdges] = useState<WbEdge[]>([]);
  const [cam, setCam] = useState({x: 40, y: 40, k: 1});
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Left drag on the board selects; middle drag, Space+drag or the hand tool pans.
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const spaceDown = useRef(false);
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target as HTMLElement).closest('input, textarea, [contenteditable]')) { spaceDown.current = true; if (e.target === canvas.current) e.preventDefault(); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown.current = false; };
    addEventListener('keydown', dn); addEventListener('keyup', up);
    return () => { removeEventListener('keydown', dn); removeEventListener('keyup', up); };
  }, []);
  const [panel, setPanel] = useState<'auto' | 'runs' | 'board'>('auto');
  const [runs, setRuns] = useState<Run[]>([]);
  const [showRun, setShowRun] = useState<string | null>(null);
  const [sops, setSops] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const dirty = useRef(false), timer = useRef<number | null>(null), fitted = useRef(false);
  const latest = useRef({nodes, edges});
  latest.current = {nodes, edges};

  const load = useCallback(() => {
    if (dirty.current) return;
    api<Board>(`/boards/${boardId}`).then(b => { setBoard(b); setNodes(b.nodes); setEdges(b.edges); setErr(null); }).catch(e => { setErr(String(e.message ?? e)); if (/No such/.test(String(e))) onGone?.(); });
    api<Run[]>(`/boards/${boardId}/runs?limit=15`).then(setRuns).catch(() => {});
  }, [boardId]);
  useEffect(load, [load, store.tick]);
  useEffect(() => { api<{code: string; url: string}[]>('/sops').then(l => setSops(Object.fromEntries(l.map(x => [x.code, x.url])))).catch(() => {}); }, []);
  // Fit the board in view once it loads.
  useEffect(() => { if (board && !fitted.current) { fitted.current = true; fit(board.nodes); } }, [board]);

  const save = useCallback((patch?: Partial<Board>) => {
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try { const b = await api<Board>(`/boards/${boardId}`, {method: 'PATCH', body: {nodes: latest.current.nodes, edges: latest.current.edges, ...patch}}); setBoard(b); }
      catch (e) { store.fail(e); dirty.current = false; load(); return; }
      dirty.current = false;
    }, patch ? 0 : 500);
  }, [boardId]);
  const setGraph = (ns: WbNode[], es: WbEdge[] = latest.current.edges) => { setNodes(ns); setEdges(es); latest.current = {nodes: ns, edges: es}; save(); };
  const patchNode = (id: string, p: Partial<WbNode>) => setGraph(latest.current.nodes.map(n => n.id === id ? {...n, ...p} : n));
  const saveBoard = async (p: Partial<Board> & {rotateKey?: boolean}) => { try { const b = await api<Board>(`/boards/${boardId}`, {method: 'PATCH', body: p}); setBoard(b); } catch (e) { store.fail(e); } };

  const toWorld = (cx: number, cy: number) => { const r = canvas.current!.getBoundingClientRect(); return {x: (cx - r.left - cam.x) / cam.k, y: (cy - r.top - cam.y) / cam.k}; };
  function fit(ns = nodes) {
    const el = canvas.current;
    if (!el || !ns.length) { setCam({x: 40, y: 40, k: 1}); return; }
    const x0 = Math.min(...ns.map(n => n.x)), y0 = Math.min(...ns.map(n => n.y)), x1 = Math.max(...ns.map(n => n.x + n.w)), y1 = Math.max(...ns.map(n => n.y + n.h));
    const r = el.getBoundingClientRect(), k = Math.min(1.2, Math.max(0.15, Math.min((r.width - 80) / (x1 - x0 || 1), (r.height - 80) / (y1 - y0 || 1))));
    setCam({k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k});
  }
  const zoomBy = (f: number, cx?: number, cy?: number) => {
    const r = canvas.current!.getBoundingClientRect(), px = cx ?? r.left + r.width / 2, py = cy ?? r.top + r.height / 2;
    setCam(c => { const k = Math.min(3, Math.max(0.1, c.k * f)); const wx = (px - r.left - c.x) / c.k, wy = (py - r.top - c.y) / c.k; return {k, x: px - r.left - wx * k, y: py - r.top - wy * k}; });
  };
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // Wheel scrolls (Shift+wheel sideways), Ctrl or pinch zooms.
    const onWheel = (e: WheelEvent) => { e.preventDefault(); if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
      else if (e.shiftKey) setCam(c => ({...c, x: c.x - (e.deltaY || e.deltaX)})); else setCam(c => ({...c, x: c.x - e.deltaX, y: c.y - e.deltaY})); };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  });

  const add = (kind: Kind, at?: {x: number; y: number}, extra: Partial<WbNode> = {}) => {
    const r = canvas.current!.getBoundingClientRect();
    const c = at ?? toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const [w, h] = SIZES[kind];
    const text = ({task: 'New step', trigger: 'Start', end: 'Done', frame: 'Group', webhook: 'Call a webhook', terminal: 'Start', decision: 'Yes or no?', title: 'Title\nSubtitle', info: 'Good to know'} as Partial<Record<Kind, string>>)[kind] ?? '';
    // Step down from the center until the spot is free, so new cards never pile up.
    let x = snap(c.x - w / 2), y = snap(c.y - h / 2);
    const busy = (yy: number) => !at && latest.current.nodes.some(o => o.kind !== 'frame' && x < o.x + o.w && x + w > o.x && yy < o.y + o.h && yy + h > o.y);
    for (let i = 0; i < 40 && busy(y); i++) y += 30;
    const n: WbNode = {id: rid(), kind, x, y, w, h, text,
      ...(kind === 'table' ? {table: [['Name', 'Owner', 'Notes'], ['', '', ''], ['', '', '']]} : {}),
      ...(kind === 'sticky' ? {color: STICKY[0]} : {}), ...(kind === 'trigger' ? {trigger: {on: 'manual'}} : {}), ...(kind === 'shape' ? {shape: 'rect'} : {}), ...(kind === 'task' ? {worker: 'either'} : {}), ...extra};
    // Frames go to the back so cards stay clickable.
    setGraph(kind === 'frame' ? [n, ...latest.current.nodes] : [...latest.current.nodes, n]);
    setSel(new Set([n.id])); setSelEdge(null);
    if (!['frame', 'trigger', 'end', 'table'].includes(kind) && !extra.text) setEditing(n.id);
    return n;
  };
  const removeSel = () => {
    if (selEdge) { setGraph(latest.current.nodes, latest.current.edges.filter(e => e.id !== selEdge)); setSelEdge(null); return; }
    if (!sel.size) return;
    setGraph(latest.current.nodes.filter(n => !sel.has(n.id)), latest.current.edges.filter(e => !sel.has(e.from) && !sel.has(e.to)));
    setSel(new Set());
  };
  const duplicate = () => {
    const map = new Map<string, string>();
    const copies = nodes.filter(n => sel.has(n.id)).map(n => { const id = rid(); map.set(n.id, id); return {...n, id, x: n.x + 30, y: n.y + 30, itemId: null}; });
    const es = edges.filter(e => map.has(e.from) && map.has(e.to)).map(e => ({...e, id: rid(), from: map.get(e.from)!, to: map.get(e.to)!}));
    setGraph([...nodes, ...copies], [...edges, ...es]); setSel(new Set(copies.map(c => c.id)));
  };

  // Pointer handling: pan the background, move or resize cards, draw connections, box-select with Shift.
  const hit = (p: {x: number; y: number}, skip?: string) => [...nodes].reverse().find(n => n.id !== skip && n.kind !== 'frame' && p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h)
    ?? [...nodes].reverse().find(n => n.id !== skip && n.kind === 'frame' && p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + 36);
  const onBgDown = (e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    canvas.current?.focus();
    setEditing(null);
    if (e.button === 1 || tool === 'hand' || spaceDown.current) { e.preventDefault(); setDrag({mode: 'pan', sx: e.clientX, sy: e.clientY, ox: cam.x, oy: cam.y}); return; }
    // Left drag draws a selection box (Shift adds to what is selected).
    if (!e.shiftKey) { setSel(new Set()); setSelEdge(null); }
    const p = toWorld(e.clientX, e.clientY); setDrag({mode: 'marquee', x0: p.x, y0: p.y, x: p.x, y: p.y});
  };
  /** The card a connection would land on: under the pointer (with a generous margin), else the nearest one close by. */
  const snapTarget = (p: {x: number; y: number}, from: string) => {
    const pad = 28 / cam.k, near = 110 / cam.k;
    const cands = nodes.filter(n => n.id !== from && n.kind !== 'frame');
    const inside = cands.filter(n => p.x >= n.x - pad && p.x <= n.x + n.w + pad && p.y >= n.y - pad && p.y <= n.y + n.h + pad);
    const dist = (n: WbNode) => Math.hypot(Math.max(n.x - p.x, 0, p.x - n.x - n.w), Math.max(n.y - p.y, 0, p.y - n.y - n.h));
    const pick = (inside.length ? inside : cands.filter(n => dist(n) < near)).sort((a, b) => dist(a) - dist(b))[0];
    return pick?.id ?? (hit(p, from)?.id ?? null);
  };
  const onNodeDown = (e: React.MouseEvent, n: WbNode) => {
    if (e.button !== 0 || editing === n.id) return;
    e.stopPropagation();
    canvas.current?.focus();
    let s = sel;
    if (e.shiftKey || e.metaKey || e.ctrlKey) { s = new Set(sel); if (s.has(n.id)) s.delete(n.id); else s.add(n.id); }
    else if (!sel.has(n.id)) s = new Set([n.id]);
    setSel(s); setSelEdge(null);
    // A frame carries the cards inside it.
    const ids = new Set(s);
    for (const f of nodes.filter(x => ids.has(x.id) && x.kind === 'frame'))
      for (const c of nodes) if (c.id !== f.id && c.x >= f.x && c.y >= f.y && c.x + c.w <= f.x + f.w && c.y + c.h <= f.y + f.h) ids.add(c.id);
    setDrag({mode: 'move', sx: e.clientX, sy: e.clientY, orig: new Map(nodes.filter(x => ids.has(x.id)).map(x => [x.id, {x: x.x, y: x.y}])), moved: false});
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag) return;
    if (drag.mode === 'pan') setCam(c => ({...c, x: drag.ox + e.clientX - drag.sx, y: drag.oy + e.clientY - drag.sy}));
    else if (drag.mode === 'move') {
      const dx = (e.clientX - drag.sx) / cam.k, dy = (e.clientY - drag.sy) / cam.k;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      drag.moved = true;
      setNodes(ns => ns.map(n => { const o = drag.orig.get(n.id); return o ? {...n, x: snap(o.x + dx), y: snap(o.y + dy)} : n; }));
    } else if (drag.mode === 'resize') {
      const dx = (e.clientX - drag.sx) / cam.k, dy = (e.clientY - drag.sy) / cam.k;
      setNodes(ns => ns.map(n => n.id === drag.id ? {...n, w: Math.max(60, snap(drag.w + dx)), h: Math.max(30, snap(drag.h + dy))} : n));
    } else if (drag.mode === 'connect') { const p = toWorld(e.clientX, e.clientY); setDrag({...drag, x: p.x, y: p.y, target: snapTarget(p, drag.from)}); }
    else if (drag.mode === 'marquee') { const p = toWorld(e.clientX, e.clientY); setDrag({...drag, x: p.x, y: p.y}); }
  };
  const onUp = (e: React.MouseEvent) => {
    if (!drag) return;
    if ((drag.mode === 'move' && drag.moved) || drag.mode === 'resize') { latest.current = {nodes, edges}; save(); }
    if (drag.mode === 'connect') {
      const tid = drag.target ?? snapTarget(toWorld(e.clientX, e.clientY), drag.from);
      const target = tid ? nodes.find(n => n.id === tid) : undefined;
      if (target && !edges.some(x => x.from === drag.from && x.to === target.id)) {
        const e2: WbEdge = {id: rid(), from: drag.from, to: target.id, ...(nodes.find(n => n.id === drag.from)?.kind === 'decision' ? {label: edges.some(x => x.from === drag.from) ? 'No' : 'Yes'} : {})};
        setGraph(nodes, [...edges, e2]); setSelEdge(e2.id); setSel(new Set());
      }
    }
    if (drag.mode === 'marquee') {
      const [x0, x1] = [Math.min(drag.x0, drag.x), Math.max(drag.x0, drag.x)], [y0, y1] = [Math.min(drag.y0, drag.y), Math.max(drag.y0, drag.y)];
      // A box selects what it touches; a frame only when fully inside.
      const touched = nodes.filter(n => n.kind === 'frame' ? n.x >= x0 && n.y >= y0 && n.x + n.w <= x1 && n.y + n.h <= y1 : n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0).map(n => n.id);
      if (Math.abs(drag.x - drag.x0) + Math.abs(drag.y - drag.y0) > 4) setSel(prev => e.shiftKey ? new Set([...prev, ...touched]) : new Set(touched));
    }
    setDrag(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (editing || (e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSel(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'd') { e.preventDefault(); duplicate(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); setSel(new Set(nodes.map(n => n.id))); }
    else if (e.key === 'Escape') { setSel(new Set()); setSelEdge(null); }
    else if (!e.metaKey && !e.ctrlKey && (e.key === 'v' || e.key === 'V')) setTool('select');
    else if (!e.metaKey && !e.ctrlKey && (e.key === 'p' || e.key === 'P')) setTool('hand');
    else if (e.key === 'Enter' && sel.size === 1) { e.preventDefault(); setEditing([...sel][0]); }
    else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      const k = KINDS.find(x => x.key.toLowerCase() === e.key.toLowerCase())?.kind;
      if (k) { e.preventDefault(); add(k); }
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing || (e.target as HTMLElement).closest('input, textarea')) return;
    const text = e.clipboardData.getData('text/plain').trim();
    if (!text) return;
    e.preventDefault();
    if (/^https?:\/\/\S+$/.test(text)) add('link', undefined, {url: text, text: /docs\.google|drive\.google/.test(text) ? 'Google document' : new URL(text).hostname});
    else add('sticky', undefined, {text: text.slice(0, 2000)});
  };

  // Run overlay: the run picked, else the newest one still going.
  const run = runs.find(r => r.id === showRun) ?? (showRun === null ? runs.find(r => r.state === 'running') : undefined);
  const stepOf = (id: string) => run?.steps.find(s => s.node === id);
  const one = sel.size === 1 ? nodes.find(n => n.id === [...sel][0]) : undefined;
  const edge = selEdge ? edges.find(e => e.id === selEdge) : undefined;
  const sideMode = panel !== 'auto' ? panel : one || edge ? 'node' : 'board';
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const doRun = async () => {
    try { const r = await api<Run>(`/boards/${boardId}/run`, {method: 'POST', body: {}}); setRuns(rs => [r, ...rs]); setShowRun(r.id); setPanel('runs'); } catch (e) { store.fail(e); }
  };
  const toTasks = async () => {
    const n = nodes.filter(x => x.kind === 'task' && !x.itemId).length;
    if (!n) { alert('Every task card is already linked to a task.'); return; }
    if (!confirm(`Create ${n} task${n === 1 ? '' : 's'} from the unlinked cards? Arrows become dependencies.`)) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; await api(`/boards/${boardId}`, {method: 'PATCH', body: {nodes: latest.current.nodes, edges: latest.current.edges}}).catch(() => {}); dirty.current = false; }
    try { const r = await api<{board: Board}>(`/boards/${boardId}/to-tasks`, {method: 'POST', body: {}}); setBoard(r.board); setNodes(r.board.nodes); setEdges(r.board.edges); } catch (e) { store.fail(e); }
  };

  if (err && !board) return <div className="content"><p className="muted">{err}</p>{back && <a href="#/boards">All whiteboards</a>}</div>;
  if (!board) return <div className="loading">Loading...</div>;
  const space = store.projects.find(p => p.id === board.projectId);
  return <div className="wb">
    <div className="wb-bar">
      {back && <a className="btn ghost small" href="#/boards">All whiteboards</a>}
      <input className="wb-name" defaultValue={board.name} key={board.id + board.name} onBlur={e => e.target.value.trim() && e.target.value !== board.name && saveBoard({name: e.target.value.trim()})} />
      <span className="wb-tools">
        <button className={'btn ghost small' + (tool === 'select' ? ' on' : '')} title="Select: drag on the board to box-select (V)" onClick={() => setTool('select')}><MousePointer2 size={14} /></button>
        <button className={'btn ghost small' + (tool === 'hand' ? ' on' : '')} title="Move around: drag to pan. Also middle mouse or Space+drag (P)" onClick={() => setTool('hand')}><Hand size={14} /></button>
        <span className="wb-sep" />
        {KINDS.filter(k => k.group === 'flow').map(k => <button key={k.kind} className="btn ghost small" title={`${k.hint} (${k.key})`} onClick={() => add(k.kind)}><k.icon size={14} /> {k.label}</button>)}
        <span className="wb-sep" />
        {KINDS.filter(k => k.group === 'notes').map(k => <button key={k.kind} className="btn ghost small" title={`${k.hint} (${k.key})`} onClick={() => add(k.kind)}><k.icon size={14} /> {k.label}</button>)}
      </span>
      <span className="spacer" />
      <button className="btn small" title="Create a task for every task card that has none. Arrows become dependencies" onClick={toTasks}><ListPlus size={13} /> Create tasks</button>
      <button className="btn small primary" title={space ? `Run it: makes its tasks in ${space.name}, in order, and fires its webhooks` : 'Put the board in a space first'} disabled={!space} onClick={doRun}><Play size={13} /> Run</button>
      <button className={'btn small' + (sideMode === 'runs' ? ' on' : '')} onClick={() => setPanel(p => p === 'runs' ? 'auto' : 'runs')}><History size={13} /> Runs{runs.some(r => r.state === 'running') ? ` (${runs.filter(r => r.state === 'running').length})` : ''}</button>
      <button className={'btn small' + (sideMode === 'board' && panel === 'board' ? ' on' : '')} onClick={() => setPanel(p => p === 'board' ? 'auto' : 'board')} title="Space, webhooks and the inbound link"><Settings2 size={13} /></button>
    </div>
    <div className="wb-main">
      <div className={'wb-canvas' + (drag?.mode === 'pan' ? ' panning' : '') + (tool === 'hand' ? ' hand' : '') + (drag?.mode === 'connect' ? ' connecting' : '')} onAuxClick={e => e.preventDefault()} ref={canvas} tabIndex={0} onMouseDown={onBgDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onKeyDown={onKey} onPaste={onPaste}
        onDoubleClick={e => { if (e.target === canvas.current || (e.target as HTMLElement).classList.contains('wb-world')) add('sticky', toWorld(e.clientX, e.clientY)); }}
        style={{backgroundSize: `${20 * cam.k}px ${20 * cam.k}px`, backgroundPosition: `${cam.x}px ${cam.y}px`}}>
        <div className="wb-world" style={{transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`}}>
          <svg className="wb-edges">
            <defs>
              <marker id="wb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--text2)" /></marker>
              <marker id="wb-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" /></marker>
            </defs>
            {edges.map(e => {
              const a = byId.get(e.from), b = byId.get(e.to);
              if (!a || !b) return null;
              const p1 = edgePoint(a, b.x + b.w / 2, b.y + b.h / 2), p2 = edgePoint(b, a.x + a.w / 2, a.y + a.h / 2);
              const isLink = e.kind === 'link' || NOTE_KINDS.has(a.kind) || NOTE_KINDS.has(b.kind);
              const on = selEdge === e.id, st = stepOf(e.from);
              const color = on ? 'var(--accent)' : st && (st.state === 'done' || st.state === 'fired') ? STATE_COLOR.done : 'var(--text2)';
              return <g key={e.id} onMouseDown={ev => { ev.stopPropagation(); setSelEdge(e.id); setSel(new Set()); canvas.current?.focus(); }}>
                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={14} style={{cursor: 'pointer'}} />
                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={color} strokeWidth={on ? 2.5 : 1.6} strokeDasharray={isLink ? '5 5' : undefined} markerEnd={isLink ? undefined : `url(#${on ? 'wb-arrow-on' : 'wb-arrow'})`} />
                {e.label && <text x={(p1.x + p2.x) / 2} y={(p1.y + p2.y) / 2 - 6} className="wb-elabel" textAnchor="middle">{e.label}</text>}
              </g>;
            })}
            {drag?.mode === 'connect' && byId.get(drag.from) && (() => {
              const a = byId.get(drag.from)!, t = drag.target ? byId.get(drag.target) : undefined;
              const end = t ? edgePoint(t, a.x + a.w / 2, a.y + a.h / 2) : {x: drag.x, y: drag.y}, p = edgePoint(a, end.x, end.y);
              return <line x1={p.x} y1={p.y} x2={end.x} y2={end.y} stroke="var(--accent)" strokeWidth={2} strokeDasharray={t ? undefined : '4 4'} markerEnd={t ? 'url(#wb-arrow-on)' : undefined} />; })()}
            {drag?.mode === 'marquee' && <rect x={Math.min(drag.x0, drag.x)} y={Math.min(drag.y0, drag.y)} width={Math.abs(drag.x - drag.x0)} height={Math.abs(drag.y - drag.y0)} fill="var(--accent-soft)" stroke="var(--accent)" />}
          </svg>
          {nodes.map(n => <NodeView key={n.id} store={store} n={n} sops={sops} selected={sel.has(n.id)} editing={editing === n.id} step={stepOf(n.id)} open={open}
            onDown={e => onNodeDown(e, n)} onEdit={() => setEditing(n.id)} onText={text => { setEditing(null); if (text !== n.text) patchNode(n.id, {text}); }}
            snapping={drag?.mode === 'connect' && drag.target === n.id} onTable={t => patchNode(n.id, {table: t})}
            onConnect={e => { e.stopPropagation(); const p = toWorld(e.clientX, e.clientY); setDrag({mode: 'connect', from: n.id, x: p.x, y: p.y, target: null}); }}
            onResize={e => { e.stopPropagation(); setDrag({mode: 'resize', id: n.id, sx: e.clientX, sy: e.clientY, w: n.w, h: n.h}); }} />)}
        </div>
        {!nodes.length && <div className="wb-empty muted">Add a card from the toolbar, double-click for a sticky, or paste a link. Drag from a card's dot to connect it.</div>}
        <div className="wb-zoom">
          <button className="btn small" onClick={() => zoomBy(1 / 1.2)} title="Zoom out"><Minus size={13} /></button>
          <span className="small muted">{Math.round(cam.k * 100)}%</span>
          <button className="btn small" onClick={() => zoomBy(1.2)} title="Zoom in"><Plus size={13} /></button>
          <button className="btn small" onClick={() => fit()} title="Fit the board"><Maximize size={13} /></button>
        </div>
        {run && <div className="wb-runbar small">Showing run of {new Date(run.started).toLocaleString()}: <b>{run.state}</b> <button className="btn ghost small" onClick={() => setShowRun('')}><X size={12} /></button></div>}
      </div>
      <aside className="wb-side">
        {sideMode === 'node' && one && <NodeInspector store={store} n={one} space={space} sops={sops} patch={p => patchNode(one.id, p)} remove={removeSel} duplicate={duplicate} open={open} />}
        {sideMode === 'node' && edge && <div className="wb-insp">
          <h4>Connection</h4>
          <label>Label<input className="plain-input" defaultValue={edge.label ?? ''} key={edge.id} onBlur={e => setGraph(nodes, edges.map(x => x.id === edge.id ? {...x, label: e.target.value || null} : x))} placeholder="yes, no, then..." /></label>
          <label className="row"><input type="checkbox" checked={edge.kind === 'link'} onChange={e => setGraph(nodes, edges.map(x => x.id === edge.id ? {...x, kind: e.target.checked ? 'link' : 'flow'} : x))} /> Only related (not the order of work)</label>
          <div className="row"><button className="btn small" onClick={() => setGraph(nodes, edges.map(x => x.id === edge.id ? {...x, from: x.to, to: x.from} : x))}>Reverse</button>
            <button className="btn small danger" onClick={removeSel}><Trash2 size={12} /> Delete</button></div>
        </div>}
        {sideMode === 'board' && <BoardSettings store={store} board={board} save={saveBoard} nodes={nodes} />}
        {sideMode === 'runs' && <RunsPanel store={store} runs={runs} shown={run?.id ?? null} show={setShowRun} open={open} board={board} reload={load} />}
      </aside>
    </div>
  </div>;
}

function NodeView({store, n, sops, selected, editing, step, open, onDown, onEdit, onText, onConnect, onResize, snapping, onTable}: {store: Store; n: WbNode; sops: Record<string, string>; selected: boolean; editing: boolean; step?: Step; open: (id: string) => void;
  onDown: (e: React.MouseEvent) => void; onEdit: () => void; onText: (t: string) => void; onConnect: (e: React.MouseEvent) => void; onResize: (e: React.MouseEvent) => void; snapping?: boolean; onTable: (t: string[][]) => void}) {
  const item = n.kind === 'task' ? live(store.items, step?.itemId ?? n.itemId) : undefined;
  const project = item ? store.projects.find(p => p.id === item.projectId) : undefined;
  const status = item && project ? project.statuses.find(s => s.id === item.status) : undefined;
  const style: React.CSSProperties = {left: n.x, top: n.y, width: n.w, height: n.h};
  if (n.kind === 'sticky') style.background = n.color ?? STICKY[0];
  else if (n.color && n.kind !== 'text') style.borderColor = n.color;
  if (step) style.boxShadow = `0 0 0 3px ${STATE_COLOR[step.state] ?? 'transparent'}`;
  const text = n.text || (item?.title ?? '');
  const sopUrl = n.sop ? sops[n.sop] ?? sops['*'] : undefined;
  let body: ReactNode;
  if (editing) body = <textarea className="wb-edit" autoFocus defaultValue={n.text} onFocus={e => e.target.select()} onMouseDown={e => e.stopPropagation()} onBlur={e => onText(e.target.value)}
    onKeyDown={e => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) (e.target as HTMLTextAreaElement).blur(); e.stopPropagation(); }} />;
  else if (n.kind === 'task') {
    const ws = n.worker ?? (item?.fields.worker as WbNode['worker']) ?? 'either';
    body = <>
      <div className="wb-task-top">
        {item ? <button className="wb-key" onMouseDown={e => e.stopPropagation()} onClick={() => open(item.id)} title="Open the task">{itemKey(item, store.projects)}</button> : <span className="wb-key idea" title="Not a task yet. Create tasks makes one">idea</span>}
        {status && <span className="wb-status" style={{color: status.color}}>{status.name}</span>}
        {item?.recur && <Repeat size={11} className="muted" />}
        <span className="spacer" />
        {ws === 'ai' ? <span className="wb-worker ai" title="AI agent does it"><Bot size={11} /> AI</span> : ws === 'human' ? <span className="wb-worker" title="A person does it"><User size={11} /></span> : null}
      </div>
      <div className={'wb-title' + (item?.completed ? ' done' : '')}>{text.split('\n')[0]}</div>
      <div className="wb-task-foot">
        <Avatars ids={item ? item.assignees : n.assignees ?? []} people={store.people} size={18} />
        {n.sop && (sopUrl ? <a className="tag" href={sopUrl} target="_blank" rel="noreferrer" onMouseDown={e => e.stopPropagation()}><ExternalLink size={9} /> {n.sop}</a> : <span className="tag">{n.sop}</span>)}
        {(item?.estimate ?? n.estimate) ? <span className="muted small">{item?.estimate ?? n.estimate}h</span> : null}
        {step && <span className="wb-step" style={{background: STATE_COLOR[step.state]}}>{step.state}</span>}
      </div>
    </>;
  } else if (n.kind === 'link') body = <div className="wb-linkbody"><Link2 size={14} />{n.url ? <a href={n.url} target="_blank" rel="noreferrer" onMouseDown={e => e.stopPropagation()}>{n.text || n.url}</a> : <span className="muted">{n.text || 'Set the link'}</span>}</div>;
  else if (n.kind === 'trigger') body = <div className="wb-iconbody"><Zap size={14} /> <span><b>{n.text || 'Start'}</b><br /><span className="muted small">{triggerText(n)}</span></span></div>;
  else if (n.kind === 'webhook') body = <div className="wb-iconbody"><Webhook size={14} /> <span><b>{n.text || 'Webhook'}</b><br /><span className="muted small">{n.url ? new URL(n.url).hostname : 'Set the URL'}</span>{step && <><br /><span className="wb-step" style={{background: STATE_COLOR[step.state]}}>{step.state}</span></>}</span></div>;
  else if (n.kind === 'end') body = <div className="wb-iconbody center"><Flag size={14} /> {n.text || 'Done'}</div>;
  else if (n.kind === 'frame') body = <div className="wb-frame-title">{n.text}</div>;
  else if (n.kind === 'title') { const [h, ...rest] = n.text.split('\n'); body = <div className="wb-titlebody"><div className="wb-h1">{h}</div>{rest.length > 0 && <div className="wb-sub">{rest.join(' ')}</div>}</div>; }
  else if (n.kind === 'terminal') body = <div className="wb-iconbody center">{/stop|end|done|finish/i.test(n.text) ? <Square size={13} /> : <CirclePlay size={14} />} <b>{n.text || 'Start'}</b></div>;
  else if (n.kind === 'decision') body = <div className="wb-decision-text">{n.text || 'Yes or no?'}</div>;
  else if (n.kind === 'info') body = <div className="wb-infobody"><Info size={14} className="wb-info-ico" /><div className="wb-text">{n.text}</div></div>;
  else if (n.kind === 'table') body = <TableBody rows={n.table ?? [['']]} onChange={onTable} />;
  else body = <div className="wb-text">{n.text}</div>;
  return <div className={`wb-node k-${n.kind}${n.kind === 'shape' ? ' s-' + (n.shape ?? 'rect') : ''}${selected ? ' sel' : ''}${snapping ? ' snap' : ''}`} style={style} onMouseDown={onDown} onDoubleClick={e => { e.stopPropagation(); onEdit(); }} data-node={n.id}>
    {((n.kind === 'shape' && n.shape === 'diamond') || n.kind === 'decision') && <svg className="wb-diamond" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="50,2 98,50 50,98 2,50" fill={n.kind === 'decision' ? 'color-mix(in srgb, #f59e0b 12%, var(--card))' : 'var(--card)'} stroke={n.color ?? (n.kind === 'decision' ? '#f59e0b' : 'var(--text2)')} strokeWidth={1.6} vectorEffect="non-scaling-stroke" /></svg>}
    {body}
    {/* Connection dots on all four sides: drag from any to another card. While connecting, the card it will join lights up. */}
    {!editing && (['t', 'r', 'b', 'l'] as const).map(side => <span key={side} className={`wb-port p-${side}`} title="Drag to another card to connect" onMouseDown={onConnect} />)}
    {selected && !editing && <span className="wb-resize" onMouseDown={onResize} />}
  </div>;
}
const triggerText = (n: WbNode) => { const t = n.trigger ?? {on: 'manual'}; return t.on === 'manual' ? 'By hand (Run)' : t.on === 'webhook' ? 'Inbound webhook' : t.on === 'schedule' ? `Every ${t.every ?? 'week'}` : `When ${t.tag ?? '...'} is done`; };

function NodeInspector({store, n, space, sops, patch, remove, duplicate, open}: {store: Store; n: WbNode; space?: Project; sops: Record<string, string>; patch: (p: Partial<WbNode>) => void; remove: () => void; duplicate: () => void; open: (id: string) => void}) {
  const [q, setQ] = useState('');
  const item = live(store.items, n.itemId);
  const people = store.people.filter((p: Person & {active?: boolean}) => p.active !== false);
  const matches = q.trim().length < 2 ? [] : [...store.items.values()].filter(i => !i.recur?.spawned && (itemKey(i, store.projects).toLowerCase() === q.trim().toLowerCase() || i.title.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => Number(!!a.completed) - Number(!!b.completed)).slice(0, 8);
  const makeTask = async () => {
    if (!space) { alert('Put the board in a space first (board settings).'); return; }
    const it = await store.createItem({projectId: space.id, title: n.text.split('\n')[0] || 'Untitled', body: n.text.split('\n').slice(1).join('\n').trim(), assignees: n.assignees ?? [], estimate: n.estimate ?? null, tags: n.sop ? [n.sop] : [], fields: {worker: n.worker ?? 'either'}});
    if (it) patch({itemId: it.id});
  };
  return <div className="wb-insp">
    <h4>{KINDS.find(k => k.kind === n.kind)?.label}</h4>
    <label>Text<textarea className="plain-input" rows={n.kind === 'sticky' ? 5 : 3} defaultValue={n.text} key={n.id + n.text} onBlur={e => e.target.value !== n.text && patch({text: e.target.value})} /></label>
    {n.kind === 'task' && <>
      <div className="wb-field"><span className="muted small">Task</span>
        {item ? <div className="row"><button className="btn small" onClick={() => open(item.id)}>{itemKey(item, store.projects)} {item.title.slice(0, 40)}</button><button className="btn ghost small" title="Unlink (the task stays)" onClick={() => patch({itemId: null})}><X size={12} /></button></div>
          : <><input className="plain-input" placeholder="Link a task: key or title" value={q} onChange={e => setQ(e.target.value)} />
            {matches.map(i => <button key={i.id} className="pop-row small" onClick={() => { patch({itemId: i.id, ...(n.text === 'New step' || !n.text ? {text: i.title} : {})}); setQ(''); }}>{itemKey(i, store.projects)} {i.title}{i.recur ? ' (routine)' : ''}{i.completed ? ' (done)' : ''}</button>)}
            <button className="btn small" onClick={makeTask} disabled={!space}><Plus size={12} /> Create task from card</button></>}
      </div>
      {!item && <>
        <div className="wb-field"><span className="muted small">Who does it</span>
          <div className="wb-people">{people.map(p => <label key={p.id} className="row small"><input type="checkbox" checked={(n.assignees ?? []).includes(p.id)} onChange={e => patch({assignees: e.target.checked ? [...(n.assignees ?? []), p.id] : (n.assignees ?? []).filter(x => x !== p.id)})} />{p.kind === 'ai' ? <Bot size={11} /> : null} {p.name}</label>)}</div></div>
        <label>Estimate (hours)<input className="plain-input" type="number" min={0} step={0.25} defaultValue={n.estimate ?? ''} key={n.id + 'e'} onBlur={e => patch({estimate: e.target.value ? Number(e.target.value) : null})} /></label>
        <label>Repeat (for Create tasks)<input className="plain-input" placeholder="week, 2w, month, weekdays" defaultValue={n.repeat ?? ''} key={n.id + 'r'} onBlur={e => patch({repeat: e.target.value.trim() || null})} /></label>
      </>}
      <label>Worker<select className="plain-input" value={n.worker ?? 'either'} onChange={e => patch({worker: e.target.value as WbNode['worker']})}><option value="either">Person or AI</option><option value="human">A person</option><option value="ai">AI agent</option></select></label>
      <label>SOP code<input className="plain-input" placeholder="Like SOP-07.2" defaultValue={n.sop ?? ''} key={n.id + 's'} onBlur={e => patch({sop: e.target.value.trim().toUpperCase() || null})} /></label>
      {n.sop && (sops[n.sop] ? <a className="small" href={sops[n.sop]} target="_blank" rel="noreferrer"><ExternalLink size={11} /> Open {n.sop}</a> : <span className="muted small">No document linked to {n.sop} yet. Admins set SOP links in Settings, or connect a Link card.</span>)}
    </>}
    {(n.kind === 'link' || n.kind === 'webhook') && <label>{n.kind === 'link' ? 'Link (Google Drive, Docs, any page)' : 'Webhook URL (POST)'}<input className="plain-input" placeholder="https://..." defaultValue={n.url ?? ''} key={n.id + 'u'} onBlur={e => { const v = e.target.value.trim(); if (v && !/^https?:\/\//.test(v)) { alert('Links start with https://'); return; } patch({url: v || null}); }} /></label>}
    {n.kind === 'webhook' && <p className="muted small">When every step before it is done, this posts JSON with the board, the run, its input and the finished tasks.</p>}
    {n.kind === 'trigger' && <>
      <label>Starts<select className="plain-input" value={n.trigger?.on ?? 'manual'} onChange={e => patch({trigger: {on: e.target.value as TriggerOn, tag: n.trigger?.tag ?? null, every: n.trigger?.every ?? 'week'}})}>
        <option value="manual">By hand (Run button)</option><option value="webhook">Inbound webhook</option><option value="schedule">On a schedule</option><option value="completed">When a tagged task is done</option></select></label>
      {n.trigger?.on === 'schedule' && <label>Every<select className="plain-input" value={n.trigger.every ?? 'week'} onChange={e => patch({trigger: {...n.trigger!, every: e.target.value as 'week'}})}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label>}
      {n.trigger?.on === 'completed' && <label>Tag or task key<input className="plain-input" placeholder="SOP-07.2 or OPS-12" defaultValue={n.trigger.tag ?? ''} key={n.id + 't'} onBlur={e => e.target.value.trim() && patch({trigger: {...n.trigger!, tag: e.target.value.trim()}})} /></label>}
      {n.trigger?.on === 'webhook' && <p className="muted small">The inbound link is in the board settings (gear button).</p>}
    </>}
    {n.kind === 'table' && <div className="row">
      <button className="btn small" onClick={() => { const t = n.table ?? [['']]; patch({table: [...t, Array(t[0]?.length ?? 1).fill('')], h: n.h + 32}); }}><Plus size={12} /> Row</button>
      <button className="btn small" onClick={() => { const t = n.table ?? [['']]; patch({table: t.map((r, i) => [...r, i === 0 ? 'Column' : '']), w: n.w + 110}); }}><Plus size={12} /> Column</button>
      <button className="btn small" disabled={(n.table?.length ?? 0) <= 1} onClick={() => patch({table: (n.table ?? []).slice(0, -1), h: Math.max(60, n.h - 32)})}><Minus size={12} /> Row</button>
      <button className="btn small" disabled={(n.table?.[0]?.length ?? 0) <= 1} onClick={() => patch({table: (n.table ?? []).map(r => r.slice(0, -1)), w: Math.max(120, n.w - 110)})}><Minus size={12} /> Column</button>
      <span className="muted small">Double-click a cell to type; Tab moves on; Enter on the last row adds one.</span></div>}
    {n.kind === 'shape' && <label>Shape<select className="plain-input" value={n.shape ?? 'rect'} onChange={e => patch({shape: e.target.value as 'rect'})}><option value="rect">Box</option><option value="ellipse">Circle</option><option value="diamond">Decision</option></select></label>}
    {n.kind !== 'text' && <div className="wb-field"><span className="muted small">Color</span><div className="row">{(n.kind === 'sticky' ? STICKY : ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b']).map(c => <button key={c} className={'wb-swatch' + ((n.color ?? '') === c ? ' on' : '')} style={{background: c}} onClick={() => patch({color: c})} />)}
      {n.kind !== 'sticky' && <button className="btn ghost small" onClick={() => patch({color: null})}>None</button>}</div></div>}
    <div className="row" style={{marginTop: 12}}><button className="btn small" onClick={duplicate}><Copy size={12} /> Duplicate</button><button className="btn small danger" onClick={remove}><Trash2 size={12} /> Delete</button></div>
    <p className="muted small">Drag the dot on a card's right edge to another card to connect them. Arrows between steps are the order of work.</p>
  </div>;
}

function BoardSettings({store, board, save, nodes}: {store: Store; board: Board; save: (p: Partial<Board> & {rotateKey?: boolean}) => void; nodes: WbNode[]}) {
  const [url, setUrl] = useState('');
  const steps = nodes.filter(n => STEP_KINDS.has(n.kind));
  return <div className="wb-insp">
    <h4>Board</h4>
    <label>Space (where its tasks go)<select className="plain-input" value={board.projectId ?? ''} onChange={e => save({projectId: e.target.value || null})}>
      <option value="">No space</option>{store.projects.filter(p => !p.settings.rollup).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>Description<textarea className="plain-input" rows={3} defaultValue={board.description} key={board.id + 'd'} onBlur={e => e.target.value !== board.description && save({description: e.target.value})} /></label>
    <p className="muted small">{steps.length} step{steps.length === 1 ? '' : 's'}, {nodes.filter(n => n.kind === 'task' && n.itemId).length} linked to tasks.</p>
    {board.hookUrl && <div className="wb-field"><span className="muted small">Inbound webhook: POST JSON here to start a run (Zapier, n8n, a form). Keep it secret.</span>
      <div className="row"><input className="plain-input grow" readOnly value={board.hookUrl} onFocus={e => e.target.select()} /><button className="btn small" onClick={() => navigator.clipboard?.writeText(board.hookUrl!)}><Copy size={12} /></button></div>
      <button className="btn ghost small" onClick={() => confirm('Make a new link? The old one stops working.') && save({rotateKey: true})}>New link</button></div>}
    <div className="wb-field"><span className="muted small">Outbound webhooks: told when runs start, steps finish, runs end or fail</span>
      {board.webhooks.map(h => <div key={h.id} className="row small"><span className="grow" style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>{h.url}</span><span className="muted">{h.events.join(', ') || 'all'}</span>
        <button className="icon" onClick={() => save({webhooks: board.webhooks.filter(x => x.id !== h.id)})}><Trash2 size={12} /></button></div>)}
      <div className="row"><input className="plain-input grow" placeholder="https://hooks.zapier.com/..." value={url} onChange={e => setUrl(e.target.value)} />
        <button className="btn small" disabled={!/^https?:\/\//.test(url)} onClick={() => { save({webhooks: [...board.webhooks, {id: rid(), url, events: []}]}); setUrl(''); }}><Plus size={12} /> Add</button></div></div>
    <div className="row" style={{marginTop: 16}}><button className="btn small danger" onClick={async () => { if (!confirm(`Delete "${board.name}" and its run history? Tasks made from it stay.`)) return; try { await api(`/boards/${board.id}`, {method: 'DELETE'}); location.hash = '/boards'; } catch (e) { store.fail(e); } }}><Trash2 size={12} /> Delete board</button></div>
    <p className="muted small">Drag on the board to select; middle mouse, Space+drag or the hand (P) to move around; Shift+wheel scrolls sideways; Ctrl+wheel zooms. Drag from a card's dot toward another card: the arrow snaps to it.</p>
    <p className="muted small">Keys: {KINDS.map(k => `${k.key} ${k.label.toLowerCase()}`).join(', ')}. V select. Enter edits, Delete removes, Ctrl+D duplicates. Paste a link to add it.</p>
  </div>;
}

function RunsPanel({store, runs, shown, show, open, board, reload}: {store: Store; runs: Run[]; shown: string | null; show: (id: string | null) => void; open: (id: string) => void; board: Board; reload: () => void}) {
  const act = async (r: Run, action: string, node?: string) => { try { await api(`/boards/runs/${r.id}/act`, {method: 'POST', body: {action, node}}); reload(); } catch (e) { store.fail(e); } };
  if (!runs.length) return <div className="wb-insp"><h4>Runs</h4><p className="muted small">No runs yet. Run starts one: its task cards become tasks in the board's space, in order, and its webhooks fire as steps finish. Triggers can start runs too.</p></div>;
  return <div className="wb-insp">
    <h4>Runs</h4>
    {runs.map(r => <div key={r.id} className={'wb-run' + (shown === r.id ? ' on' : '')}>
      <button className="wb-run-head" onClick={() => show(shown === r.id ? '' : r.id)}>
        <span className="wb-dot" style={{background: r.state === 'done' ? STATE_COLOR.done : r.state === 'failed' ? STATE_COLOR.failed : r.state === 'running' ? STATE_COLOR.open : STATE_COLOR.skipped}} />
        <b>{r.state}</b> <span className="muted small">{new Date(r.started).toLocaleString()} · {r.trigger}</span></button>
      {shown === r.id && <>
        {r.steps.map(s => { const it = live(store.items, s.itemId); return <div key={s.node} className="row small wb-steprow">
          <span className="wb-step" style={{background: STATE_COLOR[s.state]}}>{s.state}</span>
          {it ? <button className="link" onClick={() => open(it.id)}>{itemKey(it, store.projects)} {s.title}</button> : <span>{s.title || board.nodes.find(n => n.id === s.node)?.text}</span>}
          {s.note && <span className="muted" title={s.note}>{s.note.slice(0, 40)}</span>}
          {s.state === 'failed' && <button className="btn ghost small" onClick={() => act(r, 'retry', s.node)}>Retry</button>}
          {(s.state === 'waiting' || s.state === 'open' || s.state === 'failed') && r.state !== 'cancelled' && r.state !== 'done' && <button className="btn ghost small" onClick={() => act(r, 'skip', s.node)}>Skip</button>}
        </div>; })}
        <details className="small"><summary className="muted">Log ({r.log.length})</summary>{r.log.map((l, i) => <div key={i} className="muted">{new Date(l.at).toLocaleTimeString()} {l.text}</div>)}</details>
        <div className="row">{r.parentItem && store.items.get(r.parentItem) && <button className="btn small" onClick={() => open(r.parentItem!)}>Open run task</button>}
          {(r.state === 'running' || r.state === 'failed') && <button className="btn small" onClick={() => act(r, 'cancel')}>Cancel run</button>}</div>
      </>}
    </div>)}
  </div>;
}

/** In a task's panel: the whiteboards it is on. */
export function ItemBoards({store, item}: {store: Store; item: Item}) {
  const [list, setList] = useState<{id: string; name: string}[]>([]);
  useEffect(() => { api<Board[]>(`/boards?itemId=${item.id}`).then(l => setList(l.map(b => ({id: b.id, name: b.name})))).catch(() => setList([])); }, [item.id, store.tick]);
  if (!list.length) return null;
  return <span className="sop-links">{list.map(b => <a key={b.id} className="tag" href={`#/boards/${b.id}`} title="Open the whiteboard"><Workflow size={10} /> {b.name}</a>)}</span>;
}

/** A table card: the first row is the header. Double-click a cell to edit; Tab moves to the next cell, Enter on the last row adds one. */
function TableBody({rows, onChange}: {rows: string[][]; onChange: (t: string[][]) => void}) {
  const [cell, setCell] = useState<[number, number] | null>(null);
  const set = (r: number, c: number, v: string) => onChange(rows.map((row, i) => i === r ? row.map((x, j) => j === c ? v : x) : row));
  const cols = Math.max(1, ...rows.map(r => r.length));
  return <table className="wb-table" onMouseDown={e => { if (cell) e.stopPropagation(); }}>
    <tbody>{rows.map((row, r) => <tr key={r}>{Array.from({length: cols}, (_, c) => {
      const Tag = r === 0 ? 'th' : 'td';
      const on = cell?.[0] === r && cell[1] === c;
      return <Tag key={c} onDoubleClick={e => { e.stopPropagation(); setCell([r, c]); }}>
        {on ? <input autoFocus defaultValue={row[c] ?? ''} onMouseDown={e => e.stopPropagation()}
          onBlur={e => { setCell(null); if (e.target.value !== (row[c] ?? '')) set(r, c, e.target.value); }}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Escape') setCell(null);
            if (e.key === 'Tab') { e.preventDefault(); const v = (e.target as HTMLInputElement).value; if (v !== (row[c] ?? '')) set(r, c, v); const n = r * cols + c + (e.shiftKey ? -1 : 1); if (n >= 0 && n < rows.length * cols) setCell([Math.floor(n / cols), n % cols]); else setCell(null); }
            if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value; const next = rows.map((x, i) => i === r ? x.map((y, j) => j === c ? v : y) : x); if (r === rows.length - 1) next.push(Array(cols).fill('')); onChange(next); setCell([r + 1, c]); }
          }} /> : (row[c] || <span className="wb-cell-empty">{r === 0 ? 'Column' : ''}</span>)}
      </Tag>; })}</tr>)}</tbody>
  </table>;
}
