// Files column: the item's attachments as small thumbnails or chips, quick view on click, + to add more.
import {useRef} from 'react';
import {FileText, Plus} from 'lucide-react';
import type {Item} from './types.ts';
import {api, type Store} from './store.ts';
import {quickView} from './QuickView.tsx';
import {useItemFiles} from './projectFiles.ts';

export function FilesCell({item, store}: {item: Item; store: Store}) {
  const files = useItemFiles(item.projectId, store.tick).get(item.id) ?? [];
  const input = useRef<HTMLInputElement>(null);
  const add = async (list: File[]) => {
    for (const f of list) {
      const data = await new Promise<string>(ok => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(f); });
      try { await api(`/items/${item.id}/files`, {method: 'POST', body: {name: f.name, mime: f.type, data}}); } catch (e) { store.fail(e); }
    }
  };
  return (
    <span className="files-cell" onDragOver={e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); } }}
      onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); add([...e.dataTransfer.files]); } }}>
      {files.slice(0, 3).map(f => <button key={f.id} className="fc-item" title={f.name} onClick={() => quickView({url: f.url, name: f.name, mime: f.mime})}>
        {f.mime.startsWith('image/') ? <img src={f.url} alt="" loading="lazy" /> : <FileText size={13} />}</button>)}
      {files.length > 3 && <span className="muted small">+{files.length - 3}</span>}
      <button className="fc-add" title="Attach files (or drop them here)" onClick={() => input.current?.click()}><Plus size={12} /></button>
      <input ref={input} type="file" hidden multiple onChange={e => { const l = [...(e.target.files ?? [])]; e.target.value = ''; add(l); }} />
    </span>
  );
}

/** First image attachment of an item, for board card covers. */
export function CardCover({item, store}: {item: Item; store: Store}) {
  const img = (useItemFiles(item.projectId, store.tick).get(item.id) ?? []).find(f => f.mime.startsWith('image/'));
  return img ? <img className="card-cover" src={img.url} alt="" loading="lazy" onClick={e => { e.stopPropagation(); quickView({url: img.url, name: img.name, mime: img.mime}); }} /> : null;
}
