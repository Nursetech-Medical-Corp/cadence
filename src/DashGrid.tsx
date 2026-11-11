// Free-placement dashboard grid. Widgets sit at (x, y) on a 6-column grid in steps of ROW px, so you can drop one
// on a new row, between rows, or leave gaps. Drag by the grip, resize from the corner. Overlaps push others down.
import {useRef, useState, type ReactNode} from 'react';
import {GripVertical, RotateCcw, X} from 'lucide-react';

export const COLS = 6, ROW = 40, GAP = 12;
export type Cell = {id: string; x: number; y: number; w: number; h: number};

const overlaps = (a: Cell, b: Cell) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Keeps `fixed` where it is and pushes anything it overlaps (and anything those overlap) down. */
export function settle(cells: Cell[], fixed: string): Cell[] {
  const out = cells.map(c => ({...c}));
  const queue = [fixed];
  for (let guard = 0; queue.length && guard < 500; guard++) {
    const id = queue.shift(), a = out.find(c => c.id === id);
    if (!a) continue;
    for (const b of out) if (b.id !== a.id && overlaps(a, b)) { b.y = a.y + a.h; queue.push(b.id); }
  }
  return out;
}
/** First free spot for a new widget, scanning rows top to bottom. */
export function place(cells: Cell[], id: string, w: number, h: number): Cell {
  for (let y = 0; y < 400; y++) for (let x = 0; x + w <= COLS; x++) {
    const c = {id, x, y, w, h};
    if (!cells.some(o => overlaps(o, c))) return c;
  }
  return {id, x: 0, y: Math.max(0, ...cells.map(c => c.y + c.h)), w, h};
}

export function DashGrid({cells, onChange, title, body, extra, defaultH}: {
  cells: Cell[]; onChange: (c: Cell[]) => void; title: (id: string) => ReactNode; body: (id: string) => ReactNode;
  extra?: (id: string) => ReactNode; defaultH: (id: string) => number;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<{id: string; x: number; y: number; w: number; h: number; mode: 'move' | 'size'} | null>(null);
  const metrics = () => { const r = grid.current!.getBoundingClientRect(); return {r, colW: (r.width + GAP) / COLS}; };

  const start = (e: React.PointerEvent, c: Cell, mode: 'move' | 'size') => {
    e.preventDefault(); e.stopPropagation();
    const {r, colW} = metrics(), x0 = e.clientX, y0 = e.clientY;
    const grab = {dx: x0 - (r.left + c.x * colW), dy: y0 - (r.top + c.y * (ROW + GAP))};
    let cur = {...c, mode};
    setLive(cur);
    const move = (ev: PointerEvent) => {
      if (mode === 'move') {
        const x = Math.max(0, Math.min(COLS - c.w, Math.round((ev.clientX - grab.dx - r.left) / colW)));
        const y = Math.max(0, Math.round((ev.clientY - grab.dy - r.top) / (ROW + GAP)));
        cur = {...cur, x, y};
      } else {
        const w = Math.max(1, Math.min(COLS - c.x, Math.round(c.w + (ev.clientX - x0) / colW)));
        const h = Math.max(2, Math.round(c.h + (ev.clientY - y0) / (ROW + GAP)));
        cur = {...cur, w, h};
      }
      setLive({...cur});
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      setLive(null);
      onChange(settle(cells.map(x => x.id === c.id ? {id: c.id, x: cur.x, y: cur.y, w: cur.w, h: cur.h} : x), c.id));
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  // While dragging, show where everything would land.
  const shown = live ? settle(cells.map(x => x.id === live.id ? {id: x.id, x: live.x, y: live.y, w: live.w, h: live.h} : x), live.id) : cells;
  const rows = Math.max(...shown.map(c => c.y + c.h), 1) + (live ? 4 : 1);
  const setW = (id: string, w: number) => { const c = cells.find(x => x.id === id)!; onChange(settle(cells.map(x => x.id === id ? {...x, w, x: Math.min(x.x, COLS - w)} : x), id)); void c; };

  return (
    <div className={'free-grid' + (live ? ' dragging' : '')} ref={grid} style={{gridTemplateColumns: `repeat(${COLS}, 1fr)`, gridAutoRows: ROW, gap: GAP, minHeight: rows * (ROW + GAP)}}>
      {live && <div className="free-ghost" style={{gridColumn: `${live.x + 1} / span ${live.w}`, gridRow: `${live.y + 1} / span ${live.h}`}} />}
      {shown.map(c => (
        <section key={c.id} className={'widget free' + (live?.id === c.id ? ' lifted' : '')} style={{gridColumn: `${c.x + 1} / span ${c.w}`, gridRow: `${c.y + 1} / span ${c.h}`}}>
          <div className="widget-head">
            <span className="grip" title="Drag to move. Drop anywhere, gaps are fine" onPointerDown={e => start(e, c, 'move')}><GripVertical size={15} /></span>
            <b>{title(c.id)}</b>
            <span className="spacer" />
            {extra?.(c.id)}
            <div className="seg w-seg" title="Width">{[[2, 'S'], [4, 'M'], [6, 'L']].map(([w, l]) => <button key={l} className={c.w === w ? 'on' : ''} onClick={() => setW(c.id, w as number)}>{l}</button>)}</div>
            <button className="icon" title="Default height" onClick={() => onChange(settle(cells.map(x => x.id === c.id ? {...x, h: defaultH(c.id)} : x), c.id))}><RotateCcw size={12} /></button>
            <button className="icon" title="Remove widget" onClick={() => onChange(cells.filter(x => x.id !== c.id))}><X size={14} /></button>
          </div>
          <div className="widget-body">{body(c.id)}</div>
          <span className="w-resize" title="Drag to resize" onPointerDown={e => start(e, c, 'size')} />
        </section>
      ))}
    </div>
  );
}

/** Converts the older flowing layout ({id, w 1-3, h in 80px rows}) into grid cells, in order. */
export function fromFlow(list: {id: string; w: number; h?: number}[], defaultH: (id: string) => number): Cell[] {
  const out: Cell[] = [];
  for (const s of list) out.push(place(out, s.id, Math.min(COLS, Math.max(2, s.w * 2)), s.h ? Math.max(2, Math.round(s.h * 80 / (ROW + GAP))) : defaultH(s.id)));
  return out;
}
