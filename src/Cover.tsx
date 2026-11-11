// Optional cover headers, like Notion: a color band or an uploaded picture at the top of a space,
// My work or Everything. Pictures are files on the server (shrunk to at most 1600 px first), so they never
// slow down loading the rest of the page. Change header, Reposition picture, then drag it to choose what shows.
import {useRef, useState} from 'react';
import {ImagePlus, Move, Trash2, Image as ImageIcon} from 'lucide-react';
import {api, wsId} from './store.ts';
import {Popover} from './components.tsx';
import {shrinkImage} from './images.ts';

/** x, y: which part of a picture shows, 0 to 100 (50 is the middle). */
export type Cover = {gradient: number} | {image: string; v: number; x?: number; y?: number};
export const GRADIENTS = [
  'linear-gradient(120deg, #6d5dfc, #a78bfa)', 'linear-gradient(120deg, #0ea5e9, #22d3ee)', 'linear-gradient(120deg, #10b981, #84cc16)',
  'linear-gradient(120deg, #f59e0b, #f97316)', 'linear-gradient(120deg, #ec4899, #f43f5e)', 'linear-gradient(120deg, #334155, #64748b)',
  'linear-gradient(120deg, #fde68a, #fbcfe8)', 'linear-gradient(120deg, #bfdbfe, #c7d2fe)',
];
const src = (c: {image: string; v: number}) => `/api/covers/${c.image}?v=${c.v}&ws=${encodeURIComponent(wsId())}`;
const background = (c: Cover) => 'gradient' in c ? GRADIENTS[c.gradient % GRADIENTS.length]
  : `${c.x ?? 50}% ${c.y ?? 50}% / cover no-repeat url("${src(c)}")`;
const clamp = (n: number) => Math.min(100, Math.max(0, n));

/** The header itself, or a small "Add header" button when there is none. name: where an uploaded picture is kept. */
export function CoverHeader({value, onChange, name, canEdit = true}: {value?: Cover | null; onChange: (c: Cover | null) => void; name: string; canEdit?: boolean}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Reposition: the position being dragged, saved with Save position.
  const [pos, setPos] = useState<{x: number; y: number} | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const shown: Cover | null | undefined = value && 'image' in value && pos ? {...value, ...pos} : value;

  const upload = async (f: File) => {
    setBusy(true); setErr('');
    try {
      // Keep enough of the picture to move around in: up to 1600 px wide and tall.
      const data = await shrinkImage(f, 1600, 1600, 'image/jpeg', 0.82);
      await api('/covers', {method: 'POST', body: {name, data}});
      onChange({image: name, v: Date.now()}); setOpen(false);
    } catch (e) { setErr(e instanceof Error ? e.message : 'That image could not be used'); }
    setBusy(false);
  };
  const remove = () => {
    if (value && 'image' in value) api(`/covers/${name}`, {method: 'DELETE'}).catch(() => {});
    onChange(null); setOpen(false);
  };
  // Dragging moves the picture under the frame. How far a pixel moves it depends on how much of the
  // picture is hidden at this size, so the picture follows the pointer.
  const startDrag = (e: React.PointerEvent) => {
    if (!pos || !value || !('image' in value) || !box.current) return;
    e.preventDefault();
    const frame = box.current.getBoundingClientRect(), start = {px: e.clientX, py: e.clientY, ...pos};
    const img = new Image();
    img.src = src(value);
    const k = () => Math.max(frame.width / (img.naturalWidth || frame.width), frame.height / (img.naturalHeight || frame.height));
    const move = (ev: PointerEvent) => {
      const hideX = (img.naturalWidth || frame.width) * k() - frame.width, hideY = (img.naturalHeight || frame.height) * k() - frame.height;
      setPos({x: hideX > 0 ? clamp(start.x - (ev.clientX - start.px) / hideX * 100) : 50, y: hideY > 0 ? clamp(start.y - (ev.clientY - start.py) / hideY * 100) : 50});
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };

  const menu = (
    <Popover open={open} onClose={() => setOpen(false)} className="wide cover-pop">
      <div className="pop-label">Colors</div>
      <div className="cover-swatches">{GRADIENTS.map((g, n) => <button key={n} className="cover-swatch" style={{background: g}} title="Use this color" onClick={() => { onChange({gradient: n}); setOpen(false); }} />)}</div>
      <label className="pop-row"><ImagePlus size={14} /> {busy ? 'Uploading...' : 'Upload a picture'}<input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} /></label>
      {value && 'image' in value && <button className="pop-row" onClick={() => { setPos({x: value.x ?? 50, y: value.y ?? 50}); setOpen(false); }}><Move size={14} /> Reposition picture</button>}
      {value && <button className="pop-row" onClick={remove}><Trash2 size={14} /> Remove header</button>}
      {err && <div className="small" style={{color: 'var(--danger)', padding: '0 8px'}}>{err}</div>}
    </Popover>
  );
  if (!value) return canEdit ? <div className="cover-add"><span className="picker"><button className="btn ghost small" onClick={() => setOpen(o => !o)}><ImageIcon size={13} /> Add header</button>{menu}</span></div> : null;
  const isImage = 'image' in value;
  return (
    <div ref={box} className={'cover' + (pos ? ' repositioning' : '')} style={{background: background(shown!)}} onPointerDown={startDrag}>
      {pos && <div className="cover-hint">Drag the picture to position it</div>}
      {canEdit && (pos
        ? <span className="cover-actions on">
            <button className="btn primary small" onClick={() => { if (isImage) onChange({...value, ...pos}); setPos(null); }}>Save position</button>
            <button className="btn small" onClick={() => setPos(null)}>Cancel</button>
          </span>
        : <span className="picker cover-actions">
            <button className="btn small" onClick={() => setOpen(o => !o)}>Change header</button>{menu}
          </span>)}
    </div>
  );
}
