// Files view: every attachment in the project in one place, as a gallery or a table, with quick view.
// Drop files here (or on a List or Board) to turn each file into its own task with the file attached.
import {useEffect, useMemo, useRef, useState} from 'react';
import {FileText, Grid2X2, List as ListIcon, Upload} from 'lucide-react';
import {api, type Store} from './store.ts';
import type {ViewProps} from './viewProps.ts';
import {Empty, itemKey} from './components.tsx';
import {quickView} from './QuickView.tsx';

export type ProjectFile = {id: string; itemId: string; name: string; mime: string; size: number; created: string; by: string | null; url: string};
const kb = (n: number) => n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;
const KIND: [string, (m: string) => boolean][] = [['Images', m => m.startsWith('image/')], ['PDFs', m => m === 'application/pdf'], ['Documents', m => /word|sheet|excel|presentation|powerpoint|opendocument/.test(m)], ['Text', m => m.startsWith('text/')]];

const read = (f: File) => new Promise<string>(ok => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(f); });

/** Uploads files and makes one task per file (named after the file). Returns how many were made. */
export async function filesToTasks(store: Store, projectId: string, files: File[], extra: {parentId?: string | null; status?: string} = {}) {
  let made = 0;
  for (const f of files) {
    if (f.size > 10_000_000) { store.fail(new Error(`${f.name} is over 10 MB`)); continue; }
    try {
      await api(`/projects/${projectId}/file-tasks`, {method: 'POST', body: {name: f.name, mime: f.type || 'application/octet-stream', data: await read(f), ...extra}});
      made++;
    } catch (e) { store.fail(e); }
  }
  return made;
}

/** Wraps a view so dropping files from the computer creates a task per file. */
export function FileDrop({store, projectId, children, extra}: {store: Store; projectId: string; children: React.ReactNode; extra?: {parentId?: string | null; status?: string}}) {
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState('');
  const isFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  return (
    <div className={'file-drop' + (over ? ' over' : '')}
      onDragOver={e => { if (isFiles(e)) { e.preventDefault(); setOver(true); } }} onDragLeave={e => { if (e.currentTarget === e.target) setOver(false); }}
      onDrop={async e => {
        if (!isFiles(e)) return;
        e.preventDefault(); setOver(false);
        const n = await filesToTasks(store, projectId, [...e.dataTransfer.files], extra);
        setMsg(n ? `Made ${n} task${n === 1 ? '' : 's'} from your file${n === 1 ? '' : 's'}.` : ''); setTimeout(() => setMsg(''), 4000);
      }}>
      {children}
      {over && <div className="file-drop-hint"><Upload size={20} /> Drop to make one task per file</div>}
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

export function FilesView({store, project, items, open, config, setConfig}: ViewProps) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const layout = (config as {layout?: string}).layout ?? 'gallery';
  useEffect(() => { api<ProjectFile[]>(`/projects/${project.id}/files`).then(setFiles).catch(() => {}); }, [project.id, store.tick]);
  const visible = new Set(items.map(i => i.id));
  const shown = useMemo(() => files.filter(f => visible.has(f.itemId) && (!kind || KIND.find(k => k[0] === kind)![1](f.mime)) && f.name.toLowerCase().includes(q.toLowerCase())), [files, items, kind, q]);
  const view = (f: ProjectFile) => /^(image\/|application\/pdf|text\/)/.test(f.mime) ? quickView({url: f.url, name: f.name, mime: f.mime}) : window.open(f.url, '_blank');
  const person = (id: string | null) => store.people.find(p => p.id === id)?.name ?? '';
  return (
    <FileDrop store={store} projectId={project.id}>
      <div className="files-view">
        <div className="toolbar" style={{padding: '0 0 10px', border: 0}}>
          <button className="btn primary" onClick={() => input.current?.click()}><Upload size={14} /> Upload files as tasks</button>
          <input ref={input} type="file" hidden multiple onChange={async e => { const l = [...(e.target.files ?? [])]; e.target.value = ''; await filesToTasks(store, project.id, l); }} />
          <div className="seg">{['', ...KIND.map(k => k[0])].map(k => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k || 'All'}</button>)}</div>
          <input className="plain-select" placeholder="Find a file" value={q} onChange={e => setQ(e.target.value)} />
          <span className="spacer" />
          <div className="seg">
            <button className={layout === 'gallery' ? 'on' : ''} onClick={() => setConfig({layout: 'gallery'} as never)} title="Gallery"><Grid2X2 size={13} /></button>
            <button className={layout === 'table' ? 'on' : ''} onClick={() => setConfig({layout: 'table'} as never)} title="Table"><ListIcon size={13} /></button>
          </div>
        </div>
        {!files.length && <Empty title="No files yet">Drop files anywhere here, or press Upload files as tasks. Each file becomes a task with the file attached. Files added to any task in this project also show here.</Empty>}
        {layout === 'gallery' ? <div className="file-gallery">{shown.map(f => {
          const it = store.items.get(f.itemId);
          return (
            <div key={f.id} className="file-card">
              <button className="file-preview" onClick={() => view(f)} title="Quick view">{f.mime.startsWith('image/') ? <img src={f.url} alt={f.name} loading="lazy" /> : <span className="file-ext"><FileText size={28} /><b>{(f.name.split('.').pop() ?? '').toUpperCase()}</b></span>}</button>
              <div className="file-meta"><div className="file-name" title={f.name}>{f.name}</div>
                {it && <button className="link-btn small muted" onClick={() => open(it.id)}>{itemKey(it, store.projects)} {it.title}</button>}
                <div className="muted small">{kb(f.size)}, {new Date(f.created).toLocaleDateString()}</div></div>
            </div>
          );
        })}</div> : <table className="grid files-table"><thead><tr><th>Name</th><th>Task</th><th>Type</th><th>Size</th><th>Added</th><th>By</th></tr></thead>
          <tbody>{shown.map(f => { const it = store.items.get(f.itemId); return (
            <tr key={f.id}><td><button className="link-btn" onClick={() => view(f)}>{f.name}</button></td><td>{it && <button className="link-btn" onClick={() => open(it.id)}>{itemKey(it, store.projects)} {it.title}</button>}</td>
              <td className="muted small">{f.mime.split('/')[1]}</td><td>{kb(f.size)}</td><td>{new Date(f.created).toLocaleDateString()}</td><td>{person(f.by)}</td></tr>); })}</tbody></table>}
      </div>
    </FileDrop>
  );
}
