// Optional cover headers, like Notion: a color band or an uploaded picture at the top of a space,
// My work or Everything. Pictures are files on the server (shrunk to 1600 x 500 first), so they never
// slow down loading the rest of the page.
import {useState} from 'react';
import {ImagePlus, Trash2, Image as ImageIcon} from 'lucide-react';
import {api, wsId} from './store.ts';
import {Popover} from './components.tsx';
import {shrinkImage} from './images.ts';

export type Cover = {gradient: number} | {image: string; v: number};
export const GRADIENTS = [
  'linear-gradient(120deg, #6d5dfc, #a78bfa)', 'linear-gradient(120deg, #0ea5e9, #22d3ee)', 'linear-gradient(120deg, #10b981, #84cc16)',
  'linear-gradient(120deg, #f59e0b, #f97316)', 'linear-gradient(120deg, #ec4899, #f43f5e)', 'linear-gradient(120deg, #334155, #64748b)',
  'linear-gradient(120deg, #fde68a, #fbcfe8)', 'linear-gradient(120deg, #bfdbfe, #c7d2fe)',
];
const background = (c: Cover) => 'gradient' in c ? GRADIENTS[c.gradient % GRADIENTS.length]
  : `center / cover no-repeat url("/api/covers/${c.image}?v=${c.v}&ws=${encodeURIComponent(wsId())}")`;

/** The header itself, or a small "Add cover" button when there is none. name: where an uploaded picture is kept. */
export function CoverHeader({value, onChange, name, canEdit = true}: {value?: Cover | null; onChange: (c: Cover | null) => void; name: string; canEdit?: boolean}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const upload = async (f: File) => {
    setBusy(true); setErr('');
    try {
      const data = await shrinkImage(f, 1600, 500, 'image/jpeg', 0.82);
      await api('/covers', {method: 'POST', body: {name, data}});
      onChange({image: name, v: Date.now()}); setOpen(false);
    } catch (e) { setErr(e instanceof Error ? e.message : 'That image could not be used'); }
    setBusy(false);
  };
  const remove = () => {
    if (value && 'image' in value) api(`/covers/${name}`, {method: 'DELETE'}).catch(() => {});
    onChange(null); setOpen(false);
  };
  const menu = (
    <Popover open={open} onClose={() => setOpen(false)} className="wide cover-pop">
      <div className="pop-label">Colors</div>
      <div className="cover-swatches">{GRADIENTS.map((g, n) => <button key={n} className="cover-swatch" style={{background: g}} title="Use this color" onClick={() => { onChange({gradient: n}); setOpen(false); }} />)}</div>
      <label className="pop-row"><ImagePlus size={14} /> {busy ? 'Uploading...' : 'Upload a picture'}<input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} /></label>
      {value && <button className="pop-row" onClick={remove}><Trash2 size={14} /> Remove header</button>}
      {err && <div className="small" style={{color: 'var(--danger)', padding: '0 8px'}}>{err}</div>}
    </Popover>
  );
  if (!value) return canEdit ? <div className="cover-add"><span className="picker"><button className="btn ghost small" onClick={() => setOpen(o => !o)}><ImageIcon size={13} /> Add header</button>{menu}</span></div> : null;
  return (
    <div className="cover" style={{background: background(value)}}>
      {canEdit && <span className="picker cover-actions"><button className="btn small" onClick={() => setOpen(o => !o)}>Change header</button>{menu}</span>}
    </div>
  );
}
