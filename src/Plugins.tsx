// Plugin store: browse, search, install for me or the workspace, turn off without removing, settings,
// apply view presets and setups, make your own (JSON, checked live), test it on yourself, submit for review,
// download and import plugin files. Plugin pages render here too. The format is in docs/PLUGINS.md.
import {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, Copy, Download, Puzzle, RefreshCw, Search, ShieldCheck, Upload} from 'lucide-react';
import {api, type Store} from './store.ts';
import {matchFilter} from './FilterBuilder.tsx';
import {safeMode, pluginPages} from './pluginsClient.ts';
import {itemKey} from './components.tsx';
import type {Install, Manifest} from '../server/plugins.ts';
import type {Item, ViewKind} from './types.ts';
import './plugins.css';

type Card = {id: string; name: string; description: string; publisher: string; icon?: string; tags: string[]; version: string; status: string; builtin: boolean; mine: boolean; note: string; installed: ('workspace' | 'me')[]; created: string; updated: string; shot: string | null};
type Listing = {catalog: Card[]; installed: Install[]; reviewer: boolean};
type Info = {id: string; manifest: Manifest; owner: string; status: string; note: string; builtin: boolean; mine: boolean; reviewer: boolean; effects: string[]; installed: Install[]; created: string; updated: string};
const day = (iso: string) => iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'}) : '';

const go = (h: string) => { location.hash = h; };
export function PluginIcon({icon, size = 40}: {icon?: string; size?: number}) {
  if (icon?.startsWith('data:image/')) return <img className="pl-icon" src={icon} alt="" width={size} height={size} />;
  return <span className="pl-icon" style={{width: size, height: size, fontSize: size * .55}}>{icon || <Puzzle size={size * .5} />}</span>;
}
const STATUS: Record<string, string> = {draft: 'Draft, only you see it', pending: 'Waiting for review', listed: 'Approved', rejected: 'Not approved'};

export function PluginsPage({store, id}: {store: Store; id?: string}) {
  if (id === 'new' || id?.startsWith('edit:')) return <PluginEditor store={store} editId={id === 'new' ? undefined : id.slice(5)} />;
  if (id) return <PluginDetail store={store} id={id} />;
  return <PluginBrowse store={store} />;
}

function PluginBrowse({store}: {store: Store}) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'all' | 'installed' | 'mine' | 'review'>('all');
  const [data, setData] = useState<Listing | null>(null);
  const [safe, setSafe] = useState(safeMode());
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setTimeout(() => api<Listing>(`/plugins?q=${encodeURIComponent(q)}`).then(setData).catch(store.fail), 150); return () => clearTimeout(t); }, [q, store.plugins]);
  const list = (data?.catalog ?? []).filter(c => tab === 'all' ? c.status === 'listed' || c.mine : tab === 'installed' ? c.installed.length > 0 : tab === 'mine' ? c.mine : c.status === 'pending');
  const importFile = async (f: File) => {
    try { const m = JSON.parse(await f.text()); const e = await api<{id: string}>('/plugins', {method: 'POST', body: {manifest: m}}); store.flash(`Imported ${m.name}. Install it for yourself to try it.`); go(`/plugins/${e.id}`); }
    catch (e) { store.fail(e); }
  };
  const tabs = ([['all', 'Store'], ['installed', 'Installed'], ['mine', 'Made by me'], ...(data?.reviewer ? [['review', 'To review']] : [])] as [typeof tab, string][]);
  const count = (k: typeof tab) => (data?.catalog ?? []).filter(c => k === 'all' ? c.status === 'listed' || c.mine : k === 'installed' ? c.installed.length > 0 : k === 'mine' ? c.mine : c.status === 'pending').length;
  return <div className="pl-page">
    <header className="pl-hero">
      <div className="pl-hero-text">
        <h1><Puzzle size={22} /> Plugins</h1>
        <p>Themes, extra pages, view sets and full setups for Cadence. Plugins are data only: they run no code and cannot read or change your work by themselves.</p>
      </div>
      <div className="pl-hero-actions">
        <button className="btn" onClick={() => file.current?.click()}><Upload size={14} /> Import file</button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        <button className="btn primary" onClick={() => go('/plugins/new')}>Make a plugin</button>
      </div>
    </header>
    <div className="pl-bar">
      <label className="pl-search"><Search size={16} /><input placeholder="Search by name, maker or tag" value={q} onChange={e => setQ(e.target.value)} autoFocus /></label>
      <nav className="pl-tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l} <span className="pl-count-pill">{count(k)}</span></button>)}</nav>
      <label className="pl-safe-toggle" title="Turns every plugin off in this browser until you switch it back. Adding ?safe to the address does the same.">
        <input type="checkbox" checked={safe} onChange={e => { localStorage.setItem('plugins-safe', e.target.checked ? '1' : '0'); setSafe(e.target.checked); location.reload(); }} /> <ShieldCheck size={14} /> Safe mode
      </label>
    </div>
    {safe && <div className="pl-safe">Safe mode is on: plugins stay installed but are not applied in this browser.</div>}
    <div className="pl-grid">
      {list.map(c => <button key={c.id} className="pl-card" onClick={() => go(`/plugins/${c.id}`)}>
        {c.shot && <img className="pl-card-shot" src={c.shot} alt="" loading="lazy" />}
        <div className="pl-card-top">
          <PluginIcon icon={c.icon} size={48} />
          <div className="pl-card-title">
            <b>{c.name}</b>
            <span className="pl-maker">by {c.publisher}{c.builtin && <span className="pl-verified" title="Made by Cadence"><ShieldCheck size={12} /> Cadence</span>}</span>
          </div>
        </div>
        <p className="pl-card-desc">{c.description}</p>
        <div className="pl-card-foot">
          {c.installed.length ? <span className="pl-installed">✓ {c.installed.includes('workspace') ? 'Installed for everyone' : 'Installed for me'}</span>
            : c.status !== 'listed' ? <span className={'pl-status ' + c.status}>{STATUS[c.status]}</span> : <span className="muted">v{c.version}{c.updated && ` · ${day(c.updated)}`}</span>}
          <span className="spacer" />
          {c.tags.slice(0, 3).map(t => <span key={t} className="pl-tag">{t}</span>)}
        </div>
      </button>)}
      {data && !list.length && <div className="pl-empty">{tab === 'mine' ? 'You have not made a plugin yet. Make a plugin starts you from a working example.' : 'Nothing here yet.'}</div>}
    </div>
  </div>;
}

function download(m: Manifest) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(m, null, 2)], {type: 'application/json'}));
  a.download = `${m.id}-${m.version}.cadence-plugin.json`; a.click();
}

function PluginDetail({store, id}: {store: Store; id: string}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [space, setSpace] = useState('');
  const [note, setNote] = useState('');
  const load = () => api<Info>(`/plugins/${encodeURIComponent(id)}`).then(setInfo).catch(store.fail);
  useEffect(() => { void load(); }, [id]);
  if (!info) return <div className="pl-page muted">Loading...</div>;
  const m = info.manifest, c = m.contributes, admin = store.settings.admin;
  const inst = (s: 'me' | 'workspace') => info.installed.find(i => i.scope === s);
  const call = async (path: string, method: string, body?: unknown) => {
    try { const r = await api(`/plugins/${encodeURIComponent(id)}${path}`, {method, body}); await store.reloadPlugins(); await load(); return r; } catch (e) { store.fail(e); return null; }
  };
  const spaces = store.projects.filter(p => !p.settings.rollup);
  const addViews = async () => {
    if (!space) return;
    for (const v of c.views ?? []) await store.createView(space, v.name, v.kind as ViewKind, v.config ?? {});
    store.flash(`Added ${c.views!.length} views`);
  };
  const applySetup = async () => {
    const s = c.setup!;
    if (!confirm(`Apply "${m.name}"? It adds ${s.spaces?.length ?? 0} spaces with their views${s.appearance ? ', changes your appearance' : ''}${s.plugins?.length ? ` and installs ${s.plugins.length} plugins` : ''}. Nothing is deleted.`)) return;
    try {
      for (const sp of s.spaces ?? []) {
        const p = await api<{id: string}>('/projects', {method: 'POST', body: {name: sp.name, key: sp.key, statuses: sp.statuses, types: sp.types, noViews: !!sp.views?.length, personal: !admin}});
        for (const v of sp.views ?? []) await api('/views', {method: 'POST', body: {projectId: p.id, name: v.name, kind: v.kind, config: v.config ?? {}}});
      }
      for (const pid of s.plugins ?? []) await api(`/plugins/${encodeURIComponent(pid)}/install`, {method: 'POST', body: {scope: admin ? 'workspace' : 'me'}}).catch(() => api(`/plugins/${encodeURIComponent(pid)}/install`, {method: 'POST', body: {scope: 'me'}}));
      if (s.appearance) localStorage.setItem('appearance', JSON.stringify({...JSON.parse(localStorage.getItem('appearance') ?? '{}'), ...s.appearance}));
      location.reload();
    } catch (e) { store.fail(e); }
  };
  const maker = m.publisher ?? info.owner;
  const copyIt = () => { sessionStorage.setItem('plugin-draft', JSON.stringify({...m, id: `my.${m.id.split('.').pop()}`, version: '1.0.0', publisher: undefined, name: `${m.name} (my copy)`, changelog: undefined, screenshots: m.screenshots?.filter(x => x.startsWith('data:'))})); go('/plugins/new'); };
  const size = Math.round(JSON.stringify(m).length / 1024);
  return <div className="pl-page">
    <button className="pl-back" onClick={() => go('/plugins')}><ArrowLeft size={15} /> All plugins</button>
    <header className="pl-detail-head">
      <PluginIcon icon={m.icon} size={88} />
      <div className="pl-detail-title">
        <h1>{m.name}</h1>
        <div className="pl-maker big">by <b>{maker}</b>{info.builtin && <span className="pl-verified"><ShieldCheck size={13} /> Made by Cadence</span>}</div>
        <p className="pl-lede">{m.description}</p>
        <div className="pl-actions">
          {!inst('me') ? <button className="btn primary" onClick={() => call('/install', 'POST', {scope: 'me'})}>Install for me</button>
            : <button className="btn" onClick={() => call('/install?scope=me', 'DELETE')}>Remove for me</button>}
          {admin && info.status === 'listed' && (!inst('workspace') ? <button className="btn" onClick={() => call('/install', 'POST', {scope: 'workspace'})}>Install for everyone</button>
            : <button className="btn" onClick={() => call('/install?scope=workspace', 'DELETE')}>Remove for everyone</button>)}
        </div>
      </div>
    </header>
    {info.status === 'pending' && !info.builtin && <ReviewBox show={info.reviewer} note={note} setNote={setNote} review={approve => call('/review', 'POST', {approve, note})} />}
    <div className="pl-detail">
      <main className="pl-detail-main">
        <section className="pl-section">
          {m.screenshots?.length ? <Gallery shots={m.screenshots} /> : <><h2>Preview</h2><PluginPreview m={m} /></>}
        </section>
        {m.highlights?.length ? <section className="pl-section"><h2>What it does</h2><ul className="pl-highlights">{m.highlights.map(h => <li key={h}>{h}</li>)}</ul></section> : null}
        {m.readme && <section className="pl-section"><h2>About</h2><div className="pl-readme">{m.readme}</div></section>}
        <section className="pl-section"><h2>What it changes in Cadence</h2><ul className="pl-effects">{info.effects.map(e => <li key={e}>{e}</li>)}</ul></section>
        {m.changelog?.length ? <section className="pl-section"><h2>Changelog</h2><ol className="pl-changelog">{m.changelog.map(c => <li key={c.version}><div><b>v{c.version}</b> <span className="muted">{day(c.date)}</span></div><div>{c.notes}</div></li>)}</ol></section> : null}
        {c.views?.length ? <section className="pl-section"><h2>View presets</h2>
          <div className="pl-chips">{c.views.map(v => <span key={v.name} className="pl-tag">{v.name} · {v.kind}</span>)}</div>
          <div className="pl-actions"><select className="plain-select" value={space} onChange={e => setSpace(e.target.value)}><option value="">Pick a space</option>{spaces.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <button className="btn" disabled={!space} onClick={addViews}>Add these views</button></div>
        </section> : null}
        {c.setup && <section className="pl-section"><h2>Setup</h2>
          <p>{[c.setup.spaces?.length && `${c.setup.spaces.length} spaces (${c.setup.spaces.map(s => s.name).join(', ')})`, c.setup.appearance && 'appearance', c.setup.plugins?.length && `plugins: ${c.setup.plugins.join(', ')}`].filter(Boolean).join('; ')}</p>
          <div className="pl-actions"><button className="btn" onClick={applySetup}>Apply setup</button><span className="muted small">{admin ? 'Spaces are made as shared spaces.' : 'Spaces are made as your personal spaces.'} Uses your permissions. Nothing is deleted.</span></div>
        </section>}
      </main>
      <aside className="pl-side">
        {info.installed.length > 0 && <div className="pl-side-card"><h3>Installed</h3>
          {info.installed.map(i => <InstallRow key={i.scope} store={store} install={i} admin={admin} latest={m.version} update={() => call('/install', 'POST', {scope: i.scope})} reload={async () => { await store.reloadPlugins(); await load(); }} />)}</div>}
        <div className="pl-side-card"><h3>Details</h3>
          <dl className="pl-facts">
            <dt>Made by</dt><dd>{maker}</dd>
            <dt>Version</dt><dd>{m.version}</dd>
            {info.created && <><dt>Added</dt><dd>{day(info.created)}</dd></>}
            {info.updated && <><dt>Updated</dt><dd>{day(info.updated)}</dd></>}
            <dt>Size</dt><dd>{size} KB</dd>
            <dt>Status</dt><dd className={'pl-status ' + info.status}>{STATUS[info.status]}{info.note && ` (${info.note})`}</dd>
            <dt>Plugin id</dt><dd><code>{m.id}</code></dd>
            {m.tags?.length ? <><dt>Tags</dt><dd className="pl-chips">{m.tags.map(t => <span key={t} className="pl-tag">{t}</span>)}</dd></> : null}
          </dl>
        </div>
        <div className="pl-side-card pl-side-actions">
          <button className="btn" onClick={() => download(m)}><Download size={14} /> Download file</button>
          <button className="btn" onClick={copyIt} title="Opens the editor with a copy under your own id, to change and save as yours"><Copy size={14} /> Make my own copy</button>
          {info.mine && !info.builtin && <>
            <button className="btn" onClick={() => go(`/plugins/edit:${id}`)}>Edit</button>
            {info.status !== 'listed' && info.status !== 'pending' && <button className="btn" onClick={() => call('/submit', 'POST')}>Submit for everyone</button>}
            <button className="btn" onClick={() => { if (confirm(`Remove ${m.name} from the store? Installs keep working until someone removes them.`)) void call('', 'DELETE').then(() => go('/plugins')); }}>Delete from store</button>
          </>}
        </div>
      </aside>
    </div>
  </div>;
}

/** Screenshots: one large, the rest as thumbnails. Click the large one to open it full size. */
function Gallery({shots}: {shots: string[]}) {
  const [at, setAt] = useState(0);
  const cur = shots[Math.min(at, shots.length - 1)];
  return <div className="pl-gallery">
    <a href={cur} target="_blank" rel="noreferrer" className="pl-gallery-main"><img src={cur} alt={`Screenshot ${at + 1}`} /></a>
    {shots.length > 1 && <div className="pl-thumbs">{shots.map((s, n) => <button key={n} className={n === at ? 'on' : ''} onClick={() => setAt(n)}><img src={s} alt={`Screenshot ${n + 1}`} /></button>)}</div>}
  </div>;
}

/** A picture of what a plugin adds, drawn from its manifest, for plugins without screenshots. */
function PluginPreview({m}: {m: Manifest}) {
  const c = m.contributes;
  const frames: React.ReactNode[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const t = c.theme?.[mode];
    if (!t) continue;
    const base = mode === 'light' ? {bg: '#ffffff', bg2: '#f7f7f8', side: '#f7f7f8', line: '#e8e8ec', text: '#1b1b1f', muted: '#8b8b96', card: '#ffffff', accent: '#6d5dfc'}
      : {bg: '#16161a', bg2: '#1c1c21', side: '#131316', line: '#2c2c34', text: '#ececf1', muted: '#7c7c88', card: '#1f1f25', accent: '#6d5dfc'};
    const v = {...base, ...t} as Record<string, string>;
    frames.push(<figure key={mode} className="pl-frame"><div className="pl-mock" style={{background: v.bg, color: v.text, borderColor: v.line}}>
      <div className="pl-mock-side" style={{background: v.side, borderColor: v.line}}>{[70, 55, 62, 48].map((w, n) => <i key={n} style={{width: `${w}%`, background: n === 0 ? v.accent : v.muted, opacity: n === 0 ? 1 : .35}} />)}</div>
      <div className="pl-mock-main">
        <div className="pl-mock-bar" style={{borderColor: v.line}}><i style={{width: 90, background: v.text, opacity: .8}} /><span style={{background: v.accent}} /></div>
        {[0, 1, 2].map(n => <div key={n} className="pl-mock-card" style={{background: v.card, borderColor: v.line}}><b style={{borderColor: n === 0 ? v.accent : v.line, background: n === 0 ? v.accent : 'transparent'}} /><i style={{width: `${70 - n * 12}%`, background: v.text, opacity: .55}} /></div>)}
      </div>
    </div><figcaption>{mode === 'light' ? 'Light mode' : 'Dark mode'}</figcaption></figure>);
  }
  if (c.features?.includes('dayPlanner')) frames.push(<figure key="dp" className="pl-frame"><div className="pl-mock pl-mock-plain">
    <div className="pl-mock-day">{['9', '10', '11', '12', '1', '2'].map(h => <div key={h}><span>{h}</span><em /></div>)}
      <b style={{top: '6%', height: '28%'}}>Top 3: proposal</b><b style={{top: '40%', height: '18%', background: 'color-mix(in srgb, var(--ok) 22%, transparent)', borderColor: 'var(--ok)'}}>Calls</b><b style={{top: '66%', height: '24%'}}>Deep work</b></div>
  </div><figcaption>Time boxes for today</figcaption></figure>);
  if (c.features?.includes('whiteboards')) frames.push(<figure key="wb" className="pl-frame"><div className="pl-mock pl-mock-plain">
    <svg viewBox="0 0 300 150" className="pl-mock-svg"><defs><marker id="pa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor" /></marker></defs>
      <rect x="14" y="55" width="70" height="38" rx="8" className="n1" /><rect x="118" y="20" width="70" height="38" rx="8" className="n2" /><rect x="118" y="92" width="70" height="38" rx="8" className="n2" /><rect x="222" y="55" width="66" height="38" rx="19" className="n3" />
      <path d="M84 70 L118 40" markerEnd="url(#pa)" /><path d="M84 80 L118 110" markerEnd="url(#pa)" /><path d="M188 40 L222 68" markerEnd="url(#pa)" /><path d="M188 110 L222 82" markerEnd="url(#pa)" /></svg>
  </div><figcaption>Map and run a workflow</figcaption></figure>);
  for (const p of c.pages ?? []) frames.push(<figure key={p.id} className="pl-frame"><div className="pl-mock pl-mock-plain pl-mock-page">
    <strong>{p.title}</strong>
    {p.blocks.slice(0, 5).map((b, n) => b.type === 'text' ? <i key={n} className="pl-line" />
      : b.type === 'count' ? <div key={n} className="pl-mock-count"><b>12</b> {b.label}</div>
      : <div key={n} className="pl-mock-list"><em>{b.title ?? 'Tasks'}</em>{[0, 1, 2].map(r => <i key={r} className="pl-line" style={{width: `${85 - r * 15}%`}} />)}</div>)}
  </div><figcaption>New page: {p.title}</figcaption></figure>);
  if (c.views?.length) frames.push(<figure key="views" className="pl-frame"><div className="pl-mock pl-mock-plain pl-mock-page">
    <div className="pl-mock-tabs">{c.views.map(v => <span key={v.name}>{v.name}</span>)}</div>
    <div className="pl-mock-cols">{[0, 1, 2].map(col => <div key={col}>{[0, 1, 2 - col].filter(x => x >= 0).map(r => <i key={r} className="pl-mock-tile" />)}</div>)}</div>
  </div><figcaption>{c.views.length} views for any space</figcaption></figure>);
  if (!frames.length) return <div className="pl-empty">No preview. The maker can add screenshots.</div>;
  return <div className="pl-previews">{frames}</div>;
}

function ReviewBox({show, note, setNote, review}: {show: boolean; note: string; setNote: (s: string) => void; review: (approve: boolean) => void}) {
  if (!show) return null;
  return <div className="pl-box"><b>Review for everyone on this server</b>
    <div className="pl-actions"><input className="plain-input grow" placeholder="Note to the maker (optional)" value={note} onChange={e => setNote(e.target.value)} />
      <button className="btn primary" onClick={() => review(true)}>Approve</button><button className="btn" onClick={() => review(false)}>Reject</button></div></div>;
}

function InstallRow({store, install, admin, reload, latest, update}: {store: Store; install: Install; admin: boolean; reload: () => Promise<void>; latest?: string; update?: () => void}) {
  const can = install.scope === 'me' || admin;
  const set = async (patch: {enabled?: boolean; settings?: Record<string, unknown>}) => {
    try { await api(`/plugins/${encodeURIComponent(install.id)}/install`, {method: 'PATCH', body: {scope: install.scope, ...patch}}); await reload(); } catch (e) { store.fail(e); }
  };
  const settings = install.manifest.contributes.settings ?? [];
  return <div className="pl-box">
    <label className="pl-switch-row"><input type="checkbox" disabled={!can} checked={install.enabled} onChange={e => set({enabled: e.target.checked})} />
      <span><b>On {install.scope === 'me' ? 'for me' : 'for everyone'}</b><span className="muted small">v{install.version}. Off keeps it installed.</span></span></label>
    {latest && latest !== install.version && can && <button className="btn small" onClick={update}><RefreshCw size={12} /> Update to v{latest}</button>}
    {settings.map(s => {
      const v = install.settings[s.key] ?? s.default ?? '';
      const put = (x: unknown) => set({settings: {...install.settings, [s.key]: x}});
      return <label key={s.key} className="pop-row">{s.label}
        {s.type === 'boolean' ? <input type="checkbox" disabled={!can} checked={!!v} onChange={e => put(e.target.checked)} />
          : s.type === 'select' ? <select className="plain-select" disabled={!can} value={String(v)} onChange={e => put(e.target.value)}>{(s.options ?? []).map(o => <option key={o}>{o}</option>)}</select>
          : <input className="plain-input" disabled={!can} type={s.type === 'number' ? 'number' : 'text'} defaultValue={String(v)} onBlur={e => put(s.type === 'number' ? Number(e.target.value) : e.target.value)} />}
      </label>;
    })}
  </div>;
}

const STARTER = {id: 'my-company.my-plugin', name: 'My plugin', version: '1.0.0', publisher: 'My company', icon: '✨', tags: ['theme'],
  description: 'What it does in one line.', readme: 'Longer notes for people deciding whether to install it.',
  highlights: ['One line per thing it does, shown as a list.'], changelog: [{version: '1.0.0', date: new Date().toISOString().slice(0, 10), notes: 'First release.'}],
  contributes: {theme: {light: {accent: '#0f766e'}, dark: {accent: '#2dd4bf'}}, pages: [{id: 'home', title: 'My page', blocks: [{type: 'text', text: 'Hello. Lists below are read only.'}, {type: 'items', title: 'My open urgent work', mine: true, filter: {join: 'and', rules: [{field: 'priority', op: 'is', value: '1'}]}}]}]}};

function PluginEditor({store, editId}: {store: Store; editId?: string}) {
  const [text, setText] = useState('');
  const [check, setCheck] = useState<{ok: boolean; effects?: string[]; error?: string} | null>(null);
  useEffect(() => {
    if (editId) api<Info>(`/plugins/${encodeURIComponent(editId)}`).then(i => setText(JSON.stringify(i.manifest, null, 2))).catch(store.fail);
    else { const d = sessionStorage.getItem('plugin-draft'); sessionStorage.removeItem('plugin-draft'); setText(d ? JSON.stringify(JSON.parse(d), null, 2) : JSON.stringify(STARTER, null, 2)); }
  }, [editId]);
  // Check as you type (debounced) so mistakes show before saving.
  useEffect(() => {
    const t = setTimeout(async () => {
      let m: unknown; try { m = JSON.parse(text); } catch (e) { setCheck({ok: false, error: `Not valid JSON: ${(e as Error).message}`}); return; }
      try { const r = await api<{effects: string[]}>('/plugins/check', {method: 'POST', body: {manifest: m}}); setCheck({ok: true, effects: r.effects}); }
      catch (e) { setCheck({ok: false, error: (e as Error).message}); }
    }, 400);
    return () => clearTimeout(t);
  }, [text]);
  const edit = (f: (m: Record<string, any>) => void) => { try { const m = JSON.parse(text); f(m); setText(JSON.stringify(m, null, 2)); } catch { store.flash('Fix the JSON first'); } };
  const image = (f: (m: Record<string, any>, url: string) => void) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
    inp.onchange = () => { const file = inp.files?.[0]; if (!file) return; const r = new FileReader(); r.onload = () => edit(m => f(m, String(r.result))); r.readAsDataURL(file); };
    inp.click();
  };
  const fromMySetup = () => edit(m => {
    const views = (pid: string) => store.views.filter(v => v.projectId === pid && !v.config.privateTo).map(v => ({name: v.name, kind: v.kind, config: Object.fromEntries(Object.entries(v.config).filter(([k]) => !['locked', 'privateTo'].includes(k)))}));
    const spaces = store.projects.filter(p => !p.settings.rollup && !(p.settings as {access?: {private?: boolean}}).access?.private).map(p => ({name: p.name, key: p.key, statuses: p.statuses.map(s => ({id: s.id, name: s.name, category: s.category})), types: p.types, views: views(p.id)}));
    m.contributes = {...m.contributes, setup: {spaces, appearance: JSON.parse(localStorage.getItem('appearance') ?? '{}'), plugins: [...new Set((store.plugins ?? []).map(p => p.id))]}};
    m.tags = [...new Set([...(m.tags ?? []), 'setup'])];
  });
  const save = async (andInstall: boolean) => {
    try {
      const e = await api<{id: string}>('/plugins', {method: 'POST', body: {manifest: JSON.parse(text)}});
      if (andInstall) { await api(`/plugins/${encodeURIComponent(e.id)}/install`, {method: 'POST', body: {scope: 'me'}}); await store.reloadPlugins(); }
      go(`/plugins/${e.id}`);
    } catch (e) { store.fail(e); }
  };
  return <div className="pl-page">
    <button className="pl-back" onClick={() => go('/plugins')}><ArrowLeft size={15} /> All plugins</button>
    <h1>{editId ? 'Edit plugin' : 'Make a plugin'}</h1>
    <p className="muted">A plugin is a JSON file. Set id, name, version and description, then add what it contributes: theme, features, pages, views, setup or settings. The format is in the Plugins guide (docs/PLUGINS.md). Save it, try it on yourself, then submit it for everyone.</p>
    <div className="pl-actions">
      <button className="btn" onClick={() => image((m, u) => { m.icon = u; })}>Icon image</button>
      <button className="btn" onClick={() => image((m, u) => { m.screenshots = [...(m.screenshots ?? []), u].slice(-4); })}>Add screenshot</button>
      <button className="btn" onClick={fromMySetup} title="Adds your shared spaces, their views, your appearance and installed plugins as a setup others can apply">Add my setup</button>
    </div>
    <textarea className="pl-json" spellCheck={false} value={text} onChange={e => setText(e.target.value)} />
    <div className={'pl-check ' + (check?.ok ? 'ok' : 'bad')}>{!check ? 'Checking...' : check.ok ? <>Looks good. It will: <ul>{check.effects!.map(e => <li key={e}>{e}</li>)}</ul></> : check.error}</div>
    <div className="pl-actions">
      <button className="btn primary" disabled={!check?.ok} onClick={() => save(true)}>Save and try it on me</button>
      <button className="btn" disabled={!check?.ok} onClick={() => save(false)}>Save draft</button>
    </div>
  </div>;
}

/** A page from a plugin: text and read-only lists built from the same filters as views. */
export function PluginPageView({store, pluginId, pageId, open}: {store: Store; pluginId: string; pageId: string; open: (id: string) => void}) {
  const found = pluginPages(store).find(x => x.plugin.id === pluginId && x.page.id === pageId);
  const all = useMemo(() => [...store.items.values()], [store.items]);
  if (!found) return <div className="pl-page muted">This page comes from a plugin that is off or not installed. <button className="link" onClick={() => go('/plugins')}>Plugins</button></div>;
  const pick = (b: {filter?: Parameters<typeof matchFilter>[1]; mine?: boolean; openOnly?: boolean}) => all.filter(i => {
    const p = store.projects.find(x => x.id === i.projectId);
    if (!p || (b.openOnly !== false && i.completed) || (b.mine && !i.assignees.includes(store.me))) return false;
    return matchFilter(i, b.filter, {project: p, today: store.today, currentSprint: null});
  });
  return <div className="pl-page">
    <h1>{found.page.title}</h1>
    {found.page.blocks.map((b, n) => b.type === 'text' ? <p key={n} className="pl-readme">{b.text}</p>
      : b.type === 'count' ? <div key={n} className="pl-count"><b>{pick(b).length}</b> <span className="muted">{b.label}</span></div>
      : <div key={n} className="pl-list">{b.title && <h3>{b.title}</h3>}
          {pick(b).slice(0, b.limit ?? 50).map((i: Item) => <button key={i.id} className="pl-row" onClick={() => open(i.id)}><span className="muted small">{itemKey(i, store.projects)}</span> {i.title}{i.due && <span className="muted small"> · due {i.due}</span>}</button>)}
          {!pick(b).length && <div className="muted small">Nothing here.</div>}</div>)}
  </div>;
}
