// Timeline / Gantt. Drag a bar to move it, drag its edges to resize, drag across an empty lane to schedule,
// drag the dot at a bar's end onto another bar to add a dependency. Click an arrow to remove it.
import {api} from './store.ts';
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ChevronDown, ChevronRight, Maximize2} from 'lucide-react';
import type {Item} from './types.ts';
import {addDays, daysBetween, iso, parseDay, onWorkdays} from './dates.ts';
import {criticalPath} from './critical.ts';
import {upcoming} from './recur.ts';
import {InlineText, PeoplePicker, TypeBadge} from './components.tsx';
import type {ViewProps} from './viewProps.ts';

const PX = {day: 36, week: 16, month: 5} as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TYPE_COLORS: Record<string, string> = {epic: '#8b5cf6', feature: '#0ea5e9', story: '#22a06b', 'user story': '#22a06b', bug: '#e5484d'};

type Drag =
  | {mode: 'move' | 'left' | 'right'; id: string; x0: number; s0: string; d0: string; start: string; due: string; moved: boolean}
  | {mode: 'create'; id: string; d0: string; d1: string}
  | {mode: 'link'; id: string; x: number; y: number; target: string | null}
  | {mode: 'group'; id: string; x0: number; delta: number; members: string[]};

export function GanttView({store, project, items, allItems, sprints, open, config}: ViewProps) {
  const zoom = config.zoom ?? 'week';
  const px = PX[zoom];
  const today = store.today;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [tip, setTip] = useState<{x: number; y: number; text: string} | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [rowH, setRowH] = useState(36);
  const wrap = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);

  // Tree order: parents then children, filtered rows keep their visible ancestors.
  const rows = useMemo(() => {
    const shown = new Set(items.map(i => i.id));
    const byId = new Map(allItems.map(i => [i.id, i]));
    for (const i of items) { let p = i.parentId; while (p && byId.has(p)) { shown.add(p); p = byId.get(p)!.parentId; } }
    const kids = new Map<string | null, Item[]>();
    for (const i of allItems) if (shown.has(i.id)) {
      const parent = i.parentId && shown.has(i.parentId) ? i.parentId : null;
      kids.set(parent, [...(kids.get(parent) ?? []), i]);
    }
    for (const l of kids.values()) l.sort((a, b) => a.sort - b.sort);
    const out: {item: Item; depth: number; hasKids: boolean}[] = [];
    const walk = (p: string | null, depth: number) => (kids.get(p) ?? []).forEach(i => {
      out.push({item: i, depth, hasKids: kids.has(i.id)});
      if (!collapsed.has(i.id)) walk(i.id, depth + 1);
    });
    walk(null, 0);
    return {list: out, kids};
  }, [items, allItems, collapsed]);

  // Effective dates, including live drag preview.
  const span = (i: Item): [string, string] | null => {
    if (drag && drag.id === i.id && (drag.mode === 'move' || drag.mode === 'left' || drag.mode === 'right')) return [drag.start, drag.due];
    // Dragging a parent span previews every dated descendant shifted together.
    if (drag?.mode === 'group' && drag.members.includes(i.id) && (i.start || i.due)) {
      const a = i.start ?? i.due!, b = i.due ?? i.start!;
      return [addDays(a, drag.delta), addDays(b, drag.delta)];
    }
    if (drag && drag.id === i.id && drag.mode === 'create') return drag.d0 <= drag.d1 ? [drag.d0, drag.d1] : [drag.d1, drag.d0];
    if (i.start && i.due) return [i.start, i.due];
    if (i.due) return [i.due, i.due];
    if (i.start) return [i.start, i.start];
    return null;
  };
  // Parents with dated children show a summary bracket over all of them.
  const summary = (id: string): [string, string] | null => {
    let lo: string | null = null, hi: string | null = null;
    const visit = (pid: string) => (allItems.filter(c => c.parentId === pid)).forEach(c => {
      const s = span(c);
      if (s) { if (!lo || s[0] < lo) lo = s[0]; if (!hi || s[1] > hi) hi = s[1]; }
      visit(c.id);
    });
    visit(id);
    return lo && hi ? [lo, hi] : null;
  };

  const range = useMemo(() => {
    let lo = addDays(today, zoom === 'month' ? -60 : -21), hi = addDays(today, zoom === 'month' ? 300 : zoom === 'week' ? 120 : 45);
    for (const i of allItems) for (const d of [i.start, i.due]) if (d) { if (d < lo) lo = addDays(d, -14); if (d > hi) hi = addDays(d, 30); }
    for (const s of sprints) { if (s.start < lo) lo = addDays(s.start, -7); if (s.end > hi) hi = addDays(s.end, 14); }
    const start = parseDay(lo); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // align to Monday
    return {start: iso(start), days: daysBetween(iso(start), hi) + 1};
  }, [allItems, sprints, today, zoom]);
  const x = (d: string) => daysBetween(range.start, d) * px;
  const dayAt = (clientX: number) => {
    const r = lanes.current!.getBoundingClientRect();
    return addDays(range.start, Math.floor((clientX - r.left) / px));
  };
  const width = range.days * px;
  // Routines: faded copies on their next dates. Only the live copy is a real item; these are previews.
  const ghosts = (i: Item, s: [string, string]) => {
    const r = i.recur;
    if (!r || r.paused || r.waiting || r.spawned || i.completed || !i.due) return [];
    const end = addDays(range.start, range.days), len = daysBetween(s[0], s[1]);
    return upcoming(r, i.due, 120).filter(d => d <= end).map(d => [addDays(d, -len), d] as [string, string]);
  };

  useLayoutEffect(() => {
    const lane = lanes.current?.querySelector('.g-lane');
    if (lane) setRowH(lane.getBoundingClientRect().height);
  });
  // Start scrolled so today is near the left.
  useEffect(() => {
    const scroller = wrap.current?.closest('.content') as HTMLElement | null;
    if (scroller) scroller.scrollLeft = Math.max(0, x(today) - 7 * px);
  }, [zoom, project.id]);

  // Pointer handling for move, resize, create and link.
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (drag.mode === 'link') {
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-bar]') as HTMLElement | null;
        const target = el?.dataset.bar && el.dataset.bar !== drag.id ? el.dataset.bar : null;
        setDrag({...drag, x: e.clientX, y: e.clientY, target});
        return;
      }
      if (drag.mode === 'create') { setDrag({...drag, d1: dayAt(e.clientX)}); return; }
      if (drag.mode === 'group') {
        const delta = Math.round((e.clientX - drag.x0) / px);
        setDrag({...drag, delta});
        setTip({x: e.clientX + 12, y: e.clientY + 14, text: `Shift ${drag.members.length} items ${delta >= 0 ? '+' : ''}${delta} day${Math.abs(delta) === 1 ? '' : 's'}`});
        return;
      }
      const delta = Math.round((e.clientX - drag.x0) / px);
      let [s, d] = [drag.s0, drag.d0];
      if (drag.mode === 'move') { s = addDays(s, delta); d = addDays(d, delta); }
      if (drag.mode === 'left') { s = addDays(s, delta); if (s > d) s = d; }
      if (drag.mode === 'right') { d = addDays(d, delta); if (d < s) d = s; }
      setDrag({...drag, start: s, due: d, moved: drag.moved || delta !== 0});
      setTip({x: e.clientX + 12, y: e.clientY + 14, text: `${fmt(s)} to ${fmt(d)} (${daysBetween(s, d) + 1}d)`});
    };
    const up = () => {
      const d = drag;
      setDrag(null); setTip(null);
      if (d.mode === 'link') {
        if (d.target) {
          const t = store.items.get(d.target)!;
          if (!t.deps.includes(d.id)) store.updateItem(t.id, {deps: [...t.deps, d.id]});
        }
        return;
      }
      // Projects that skip weekends: a bar dropped on Saturday or Sunday starts Monday (moves keep their length).
      const off = (id: string, st: string | null, du: string | null, keep: boolean) => {
        const pr = store.projects.find(p => p.id === store.items.get(id)?.projectId);
        return onWorkdays(pr?.settings.dates?.skipWeekends, st, du, keep);
      };
      if (d.mode === 'group') {
        if (!d.delta) return;
        const moved = new Set(d.members);
        for (const mid of d.members) {
          const m = store.items.get(mid);
          // Steps that follow their parent or the step before them are moved by the server along with it.
          if (m && ((m.fields.follow === 'parent' && m.parentId && moved.has(m.parentId) && (store.items.get(m.parentId)?.start || store.items.get(m.parentId)?.due)) || (m.fields.follow === 'previous' && m.deps.some(x => moved.has(x))))) continue;
          if (m && (m.start || m.due)) { const [st, du] = off(mid, m.start ? addDays(m.start, d.delta) : null, m.due ? addDays(m.due, d.delta) : null, true); store.updateItem(mid, {...(st ? {start: st} : {}), ...(du ? {due: du} : {})}); }
        }
        return;
      }
      if (d.mode === 'create') {
        const [s, e] = d.d0 <= d.d1 ? [d.d0, d.d1] : [d.d1, d.d0];
        const [st, du] = off(d.id, s, e, false);
        store.updateItem(d.id, {start: st, due: du});
        return;
      }
      if (!d.moved) { open(d.id); return; }
      const [st, du] = off(d.id, d.start, d.due, d.mode === 'move');
      store.updateItem(d.id, {start: st, due: du});
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  }, [drag]);

  // Click and drag empty timeline space to scroll around (bars, handles and unscheduled lanes keep their own drags).
  const [panning, setPanning] = useState(false);
  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.defaultPrevented) return;
    const scroller = wrap.current?.closest('.content') as HTMLElement | null;
    if (!scroller) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, l0 = scroller.scrollLeft, t0 = scroller.scrollTop;
    setPanning(true);
    const move = (ev: PointerEvent) => { scroller.scrollLeft = l0 - (ev.clientX - x0); scroller.scrollTop = t0 - (ev.clientY - y0); };
    const up = () => { setPanning(false); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };

  const beginBar = (e: React.PointerEvent, i: Item, mode: 'move' | 'left' | 'right') => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const s = span(i)!;
    setDrag({mode, id: i.id, x0: e.clientX, s0: s[0], d0: s[1], start: s[0], due: s[1], moved: false});
  };

  // Header scales.
  const months: {label: string; left: number; w: number}[] = [];
  const ticks: {label: string; left: number}[] = [];
  const weekends: number[] = [];
  for (let n = 0; n < range.days; n++) {
    const d = addDays(range.start, n), dt = parseDay(d);
    if (dt.getDate() === 1 || n === 0) months.push({label: `${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`, left: n * px, w: 0});
    if (zoom === 'day') ticks.push({label: String(dt.getDate()), left: n * px});
    else if (dt.getDay() === 1 && zoom === 'week') ticks.push({label: `${dt.getDate()}`, left: n * px});
    else if (dt.getDay() === 1 && zoom === 'month' && dt.getDate() <= 7) ticks.push({label: '', left: n * px});
    if (zoom !== 'month' && (dt.getDay() === 0 || dt.getDay() === 6)) weekends.push(n * px);
  }
  months.forEach((m, k) => m.w = (months[k + 1]?.left ?? width) - m.left);

  const rowIndex = new Map(rows.list.map((r, k) => [r.item.id, k]));
  const arrows = rows.list.flatMap(({item}) => item.deps.filter(d => rowIndex.has(d)).map(d => {
    const src = store.items.get(d)!, a = span(src), b = span(item);
    if (!a || !b) return null;
    const x1 = x(a[1]) + px, y1 = rowIndex.get(d)! * rowH + rowH / 2;
    const x2 = x(b[0]), y2 = rowIndex.get(item.id)! * rowH + rowH / 2;
    const bad = b[0] <= a[1];
    const mid = Math.max(x1 + 10, Math.min(x2 - 10, x1 + 10));
    const path = x2 - 10 > x1 + 10 ? `M${x1},${y1} H${mid} V${y2} H${x2 - 2}` : `M${x1},${y1} h10 V${(y1 + y2) / 2} H${x2 - 12} V${y2} H${x2 - 2}`;
    return {key: d + '>' + item.id, path, bad, from: src, to: item};
  })).filter(Boolean) as {key: string; path: string; bad: boolean; from: Item; to: Item}[];

  // Fit a parent around its subitems without shifting the subitems that follow it.
  const stretch = (i: Item, patch: {start: string; due: string}) => api(`/items/${i.id}?keep=1`, {method: 'PATCH', body: patch}).catch(store.fail);
  // Critical path (when turned on) and the baseline to compare against.
  const critical = useMemo(() => config.critical ? criticalPath(rows.list.map(r => r.item)) : new Set<string>(), [config.critical, rows]);
  const base = config.baseline != null ? config.baselines?.[config.baseline] : undefined;
  // Bar color follows the view's "Color by" setting. Done items turn green with a check whatever the setting.
  const PRIO = ['#8b8d98', '#e5484d', '#f76b15', '#e2a400', '#8b8d98'];
  const color = (i: Item) => {
    if (i.completed) return 'var(--ok)';
    const by = config.colorBy ?? 'type';
    if (by === 'assignee') return store.people.find(p => p.id === i.assignees[0])?.color ?? '#8b8d98';
    if (by === 'status') return project.statuses.find(s => s.id === i.status)?.color ?? '#8b8d98';
    if (by === 'priority') return PRIO[i.priority];
    return TYPE_COLORS[i.type.toLowerCase()] ?? 'var(--accent)';
  };

  return (
    <div className="gantt" ref={wrap}>
      <div className="g-left">
        <div className="g-head g-legend">
          <span title="Work with a start and due date. Drag to move, drag the ends to resize."><i className="lg-bar" />Scheduled</span>
          <span title="A parent (epic, feature, story). The bracket spans all of its children's dates."><i className="lg-sum" />Parent span</span>
          <span title="Only a due date, no start. Add a start date or drag its edge to make it a bar."><i className="lg-ms" />Due date only</span>
          <span title="Hover a bar, drag the dot on its right end onto another bar. Click an arrow to remove it."><i className="lg-arrow" />Drag dot to link</span>
          {config.critical && <span title="No slack: a day late here moves the last finish date"><i className="lg-crit" />Critical path</span>}
          {base && <span title={`Saved ${new Date(base.at).toLocaleDateString()}`}><i className="lg-base" />Baseline: {base.name}</span>}
        </div>
        {rows.list.map(({item: i, depth, hasKids}) => (
          <div key={i.id} className={'g-row' + (hover === i.id ? ' hl' : '')} onMouseEnter={() => setHover(i.id)} onMouseLeave={() => setHover(null)}>
            <span style={{width: depth * 16, flex: 'none'}} />
            <button className="twisty" style={{visibility: hasKids ? 'visible' : 'hidden'}} onClick={() => setCollapsed(c => { const n = new Set(c); n.has(i.id) ? n.delete(i.id) : n.add(i.id); return n; })}>
              {collapsed.has(i.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
            {i.type !== 'Task' && <TypeBadge type={i.type} />}
            <span className={'g-title' + (i.completed ? ' done' : '')} title={i.title}><InlineText value={i.title} onSave={title => store.updateItem(i.id, {title})} /></span>
            <PeoplePicker value={i.assignees} people={store.people} onReorder={store.reorderPeople} onChange={assignees => store.updateItem(i.id, {assignees})} compact />
            <button className="icon more" title="Open details" onClick={() => open(i.id)}><Maximize2 size={13} /></button>
          </div>
        ))}
      </div>
      <div className={'g-right' + (panning ? ' panning' : '')} style={{width}} onPointerDown={startPan}>
        <div className="g-head">
          <div className="g-scale top">{months.map(m => <div key={m.left} style={{left: m.left, width: m.w}}>{m.label}</div>)}</div>
          <div className="g-scale">{ticks.map(t => <div key={t.left} style={{left: t.left, width: zoom === 'day' ? px : 7 * px}}>{t.label}</div>)}</div>
          {sprints.map(s => <div key={s.id} className="g-sprint" style={{left: x(s.start), width: x(addDays(s.end, 1)) - x(s.start)}} title={`${s.name}: ${s.start} to ${s.end}`}>{s.name}</div>)}
        </div>
        <div className="g-grid">
          {weekends.map(l => <div key={l} className="wk" style={{left: l, width: px}} />)}
          {ticks.map(t => <div key={t.left} className="ln" style={{left: t.left}} />)}
        </div>
        <div className="g-today" style={{left: x(today) + px / 2}} />
        <div ref={lanes} style={{position: 'relative'}}>
          {rows.list.map(({item: i, hasKids}) => {
            const s = span(i), sum = hasKids ? summary(i.id) : null;
            const draggingThis = drag?.id === i.id;
            return (
              <div key={i.id} className={'g-lane' + (hover === i.id ? ' hl' : '')} onMouseEnter={() => setHover(i.id)} onMouseLeave={() => setHover(null)}
                onPointerDown={e => { if (!s && e.button === 0) { e.preventDefault(); const d = dayAt(e.clientX); setDrag({mode: 'create', id: i.id, d0: d, d1: d}); } }}>
                {!s && !sum && <span className="hint" style={{left: x(today)}}>Drag here to schedule</span>}
                {sum && !s && <span className="ms-label sum-label" style={{left: x(addDays(sum[1], 1)) + 6}}>{i.title}</span>}
                {sum && !s && <div className={'bar summary' + (drag?.mode === 'group' && drag.id === i.id ? ' dragging' : '')} style={{left: x(sum[0]), width: x(addDays(sum[1], 1)) - x(sum[0]), '--c': color(i), cursor: 'grab'} as React.CSSProperties}
                  title={`${i.title}: ${sum[0]} to ${sum[1]}. Drag to shift everything under it.`}
                  onPointerDown={e => {
                    if (e.button !== 0) return;
                    e.preventDefault(); e.stopPropagation();
                    const members: string[] = [];
                    const walk = (pid: string) => allItems.filter(c => c.parentId === pid).forEach(c => { members.push(c.id); walk(c.id); });
                    walk(i.id);
                    setDrag({mode: 'group', id: i.id, x0: e.clientX, delta: 0, members});
                  }} />}
                {s && !i.start && i.due && !draggingThis && <span className="ms-label" style={{left: x(s[0]) + px + 6}}>{i.title}</span>}
                {base?.dates[i.id] && (() => { const [bs, bd] = base.dates[i.id]; const a0 = bs ?? bd!, a1 = bd ?? bs!; const late = s && s[1] > a1 ? daysBetween(a1, s[1]) : 0;
                  return <div className={'baseline-bar' + (late ? ' late' : '')} style={{left: x(a0), width: Math.max(px, x(addDays(a1, 1)) - x(a0))}} title={`Baseline "${base.name}": ${a0} to ${a1}${late ? `. Now ${late} day(s) later` : ''}`} />; })()}
                {s && (
                  <div data-bar={i.id}
                    className={'bar' + (critical.has(i.id) ? ' critical' : '') + (i.completed ? ' done' : '') + (draggingThis ? ' dragging' : '') + (drag?.mode === 'link' && drag.target === i.id ? ' drop-target' : '') + (!i.start && i.due && !draggingThis ? ' milestone' : '')}
                    style={{left: x(s[0]), width: Math.max(px, x(addDays(s[1], 1)) - x(s[0])), '--c': color(i)} as React.CSSProperties}
                    onMouseEnter={e => !drag && setTip({x: e.clientX + 12, y: e.clientY + 14, text: `${i.title}: ${fmt(s[0])}${s[0] !== s[1] ? ` to ${fmt(s[1])}` : ''}${i.assignees.length ? `, ${i.assignees.map(a => store.people.find(p => p.id === a)?.name).join(', ')}` : ''}${i.completed ? ' (done)' : ''}`})}
                    onMouseMove={e => !drag && setTip(t => t && {...t, x: e.clientX + 12, y: e.clientY + 14})}
                    onMouseLeave={() => !drag && setTip(null)}
                    onPointerDown={e => beginBar(e, i, 'move')}>
                    {sum && <div className="bar-fill" style={{width: '100%', opacity: .3}} />}
                    <span className="h l" onPointerDown={e => beginBar(e, i, 'left')} />
                    {(i.start || draggingThis) && <span className="bar-label">{i.completed && '✓ '}{i.title}</span>}
                    <span className="h r" onPointerDown={e => beginBar(e, i, 'right')} />
                    <span className={'link-dot' + (drag?.mode === 'link' && drag.id === i.id ? ' on' : '')} title="Drag onto another bar: it starts after this one"
                      onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDrag({mode: 'link', id: i.id, x: e.clientX, y: e.clientY, target: null}); }} />
                  </div>
                )}
                {s && !draggingThis && ghosts(i, s).map(([g0, g1]) => <div key={g1} className={'bar gantt-ghost' + (!i.start ? ' milestone' : '')} style={{left: x(g0), width: Math.max(px, x(addDays(g1, 1)) - x(g0)), '--c': color(i)} as React.CSSProperties} />)}
                {/* A parent's own dates are its plan. When subitems run outside it, show the overrun instead of hiding it; click to stretch the plan. */}
                {s && sum && !draggingThis && sum[1] > s[1] && <div className="overrun" style={{left: x(addDays(s[1], 1)), width: x(addDays(sum[1], 1)) - x(addDays(s[1], 1))}}
                  title={`Subitems run ${daysBetween(s[1], sum[1])} day(s) past this ${i.type}'s due date (${fmt(s[1])}). Click to move the due date to ${fmt(sum[1])}.`}
                  onPointerDown={e => e.stopPropagation()} onClick={() => stretch(i, {start: i.start ?? s[0], due: sum[1]})} />}
                {s && sum && !draggingThis && sum[0] < s[0] && <div className="overrun before" style={{left: x(sum[0]), width: x(s[0]) - x(sum[0])}}
                  title={`Subitems start ${daysBetween(sum[0], s[0])} day(s) before this ${i.type} starts (${fmt(s[0])}). Click to move the start to ${fmt(sum[0])}.`}
                  onPointerDown={e => e.stopPropagation()} onClick={() => stretch(i, {start: sum[0], due: i.due ?? s[1]})} />}
              </div>
            );
          })}
          <svg className="g-arrows" width={width} height={rows.list.length * rowH} style={{top: 0}}>
            <defs>
              <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" /></marker>
              <marker id="arr-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" /></marker>
            </defs>
            {arrows.map(a => (
              <g key={a.key}>
                <path className="hit" d={a.path} onClick={() => confirm(`Remove dependency: "${a.to.title}" waits for "${a.from.title}"?`) && store.updateItem(a.to.id, {deps: a.to.deps.filter(d => d !== a.from.id)})}>
                  <title>{`${a.to.title} waits for ${a.from.title}${a.bad ? ' (starts too early)' : ''}. Click to remove.`}</title>
                </path>
                <path d={a.path} className={a.bad ? 'bad' : ''} markerEnd={`url(#${a.bad ? 'arr-bad' : 'arr'})`} />
              </g>
            ))}
          </svg>
        </div>
      </div>
      {drag?.mode === 'link' && <LinkLine drag={drag} />}
      <BudgetStrip months={months} items={items} project={project} x={x} width={width} />
      {tip && <div className="g-tip" style={{left: tip.x, top: tip.y}}>{tip.text}</div>}
    </div>
  );
}

function LinkLine({drag}: {drag: Extract<Drag, {mode: 'link'}>}) {
  const src = document.querySelector(`[data-bar="${drag.id}"]`)?.getBoundingClientRect();
  if (!src) return null;
  return (
    <svg style={{position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 95}} width="100%" height="100%">
      <line x1={src.right} y1={src.top + src.height / 2} x2={drag.x} y2={drag.y} stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 3" />
    </svg>
  );
}

const fmt = (d: string) => { const t = parseDay(d); return `${MONTHS[t.getMonth()]} ${t.getDate()}`; };

/** Per month: estimated hours due and planned costs (a number field named Cost or Budget). */
function BudgetStrip({months, items, project, x, width}: {months: {label: string; left: number; w: number}[]; items: Item[]; project: {fields: {id: string; name: string; kind: string}[]}; x: (d: string) => number; width: number}) {
  const costField = project.fields.find(f => f.kind === 'number' && /^(cost|budget|amount|spend)/i.test(f.name))?.id;
  const parents = new Set(items.map(i => i.parentId).filter(Boolean));
  const per = new Map<number, {h: number; c: number}>();
  for (const i of items) {
    if (!i.due) continue;
    const left = x(i.due);
    const m = months.find(mm => left >= mm.left && left < mm.left + mm.w);
    if (!m) continue;
    const r = per.get(m.left) ?? {h: 0, c: 0};
    if (!parents.has(i.id)) r.h += i.estimate ?? 0;
    if (costField) r.c += Number(i.fields[costField]) || 0;
    per.set(m.left, r);
  }
  if (![...per.values()].some(r => r.h || r.c)) return null;
  return (
    <div className="g-budget" style={{width: 320 + width}}>
      <div className="g-budget-label">Per month: hours due{costField ? ' and cost' : ''}</div>
      <div style={{position: 'relative', width, height: 30}}>
        {months.map(m => { const r = per.get(m.left); return r && (r.h || r.c) ? <div key={m.left} className="g-budget-cell" style={{left: m.left, width: m.w}} title={`${m.label}: ${Math.round(r.h)}h${costField ? `, $${Math.round(r.c).toLocaleString()}` : ''}`}>
          <b>{Math.round(r.h)}h</b>{costField && r.c ? <span> ${Math.round(r.c).toLocaleString()}</span> : null}</div> : null; })}
      </div>
    </div>
  );
}
