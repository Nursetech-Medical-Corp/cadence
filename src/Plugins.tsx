// Plugin store: browse, search, install for me or the workspace, turn off without removing, settings,
// apply view presets and setups, make your own (JSON, checked live), test it on yourself, submit for review,
// download and import plugin files. Plugin pages render here too. The format is in docs/PLUGINS.md.
import {useEffect, useMemo, useRef, useState} from 'react';
import {Download, Puzzle, Search, ShieldCheck, Upload} from 'lucide-react';
import {api, type Store} from './store.ts';
import {matchFilter} from './FilterBuilder.tsx';
import {safeMode, pluginPages} from './pluginsClient.ts';
import {itemKey} from './components.tsx';
import type {Install, Manifest} from '../server/plugins.ts';
import type {Item, ViewKind} from './types.ts';

type Card = {id: string; name: string; description: string; publisher: string; icon?: string; tags: string[]; version: string; status: string; builtin: boolean; mine: boolean; note: string; installed: ('workspace' | 'me')[]};
type Listing = {catalog: Card[]; installed: Install[]; reviewer: boolean};
type Info = {id: string; manifest: Manifest; owner: string; status: string; note: string; builtin: boolean; mine: boolean; reviewer: boolean; effects: string[]; installed: Install[]};

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
  return <div className="pl-page">
    <div className="pl-head">
      <h1><Puzzle size={20} /> Plugins</h1>
      <span className="spacer" />
      <label className="pop-row" title="Turns every plugin off in this browser until you switch it back. Adding ?safe to the address does the same.">
        <input type="checkbox" checked={safe} onChange={e => { localStorage.setItem('plugins-safe', e.target.checked ? '1' : '0'); setSafe(e.target.checked); location.reload(); }} /> <ShieldCheck size={14} /> Safe mode
      </label>
      <button className="btn" onClick={() => file.current?.click()}><Upload size={14} /> Import file</button>
      <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
      <button className="btn primary" onClick={() => go('/plugins/new')}>Make a plugin</button>
    </div>
    <p className="muted">Themes, extra pages, view sets and full setups. Plugins are data only: they run no code and cannot read or change your work by themselves. Install one for yourself to try it, turn it off any time without removing it.</p>
    <div className="pl-bar">
      <span className="search-wrap grow"><Search size={14} /><input className="search" placeholder="Search plugins" value={q} onChange={e => setQ(e.target.value)} autoFocus /></span>
      <div className="seg">{([['all', 'Store'], ['installed', 'Installed'], ['mine', 'Made by me'], ...(data?.reviewer ? [['review', 'To review']] : [])] as [typeof tab, string][]).map(([k, l]) =>
        <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'review' && data ? ` (${data.catalog.filter(c => c.status === 'pending').length})` : ''}</button>)}</div>
    </div>
    {safe && <div className="pl-safe">Safe mode is on: plugins are installed but not applied in this browser.</div>}
    <div className="pl-grid">
      {list.map(c => <button key={c.id} className="pl-card" onClick={() => go(`/plugins/${c.id}`)}>
        <PluginIcon icon={c.icon} />
        <span className="pl-card-body">
          <b>{c.name}</b>
          <span className="muted small">{c.publisher}{c.builtin ? ' (built in)' : ''} · v{c.version}</span>
          <span className="small">{c.description}</span>
          <span className="pl-tags">{c.installed.map(s => <span key={s} className="tag on">{s === 'me' ? 'Installed for me' : 'Installed for workspace'}</span>)}{c.status !== 'listed' && <span className="tag">{STATUS[c.status]}</span>}{c.tags.map(t => <span key={t} className="tag">{t}</span>)}</span>
        </span>
      </button>)}
      {data && !list.length && <div className="muted">Nothing here yet.</div>}
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
  return <div className="pl-page">
    <button className="link small" onClick={() => go('/plugins')}>All plugins</button>
    <div className="pl-detail-head">
      <PluginIcon icon={m.icon} size={64} />
      <div className="grow">
        <h1>{m.name}</h1>
        <div className="muted">{m.publisher ?? info.owner}{info.builtin ? ' (built in)' : ''} · v{m.version} · <span className={'pl-status ' + info.status}>{STATUS[info.status]}</span>{info.note && ` · ${info.note}`}</div>
        <p>{m.description}</p>
        <div className="pl-actions">
          {!inst('me') ? <button className="btn primary" onClick={() => call('/install', 'POST', {scope: 'me'})}>Install for me</button>
            : <button className="btn" onClick={() => call('/install?scope=me', 'DELETE')}>Remove for me</button>}
          {admin && info.status === 'listed' && (!inst('workspace') ? <button className="btn" onClick={() => call('/install', 'POST', {scope: 'workspace'})}>Install for everyone</button>
            : <button className="btn" onClick={() => call('/install?scope=workspace', 'DELETE')}>Remove for everyone</button>)}
          {info.mine && !info.builtin && <>
            <button className="btn" onClick={() => go(`/plugins/edit:${id}`)}>Edit</button>
            {info.status !== 'listed' && info.status !== 'pending' && <button className="btn" onClick={() => call('/submit', 'POST')}>Submit for everyone</button>}
            <button className="btn" onClick={() => { if (confirm(`Remove ${m.name} from the store? Installs keep working until someone removes them.`)) void call('', 'DELETE').then(() => go('/plugins')); }}>Delete</button>
          </>}
          <button className="btn" onClick={() => download(m)}><Download size={14} /> Download</button>
        </div>
      </div>
    </div>
    {info.status === 'pending' && !info.builtin && <ReviewBox show={info.reviewer} note={note} setNote={setNote} review={approve => call('/review', 'POST', {approve, note})} />}
    {info.installed.map(i => <InstallRow key={i.scope} store={store} install={i} admin={admin} reload={async () => { await store.reloadPlugins(); await load(); }} />)}
    <h3>What it changes</h3>
    <ul className="pl-effects">{info.effects.map(e => <li key={e}>{e}</li>)}</ul>
    {c.views?.length ? <div className="pl-box">
      <b>View presets:</b> {c.views.map(v => v.name).join(', ')}
      <div className="pl-actions"><select className="plain-select" value={space} onChange={e => setSpace(e.target.value)}><option value="">Pick a space</option>{spaces.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button className="btn" disabled={!space} onClick={addViews}>Add views to this space</button></div>
    </div> : null}
    {c.setup && <div className="pl-box"><b>Setup:</b> {[c.setup.spaces?.length && `${c.setup.spaces.length} spaces (${c.setup.spaces.map(s => s.name).join(', ')})`, c.setup.appearance && 'appearance', c.setup.plugins?.length && `plugins: ${c.setup.plugins.join(', ')}`].filter(Boolean).join('; ')}
      <div className="pl-actions"><button className="btn" onClick={applySetup}>Apply setup</button><span className="muted small">{admin ? 'Spaces are shared spaces.' : 'Spaces are made as your personal spaces.'} Uses your permissions.</span></div></div>}
    {m.screenshots?.length ? <><h3>Screenshots</h3><div className="pl-shots">{m.screenshots.map((s, n) => <img key={n} src={s} alt={`Screenshot ${n + 1}`} />)}</div></> : null}
    {m.readme && <><h3>About</h3><div className="pl-readme">{m.readme}</div></>}
  </div>;
}

function ReviewBox({show, note, setNote, review}: {show: boolean; note: string; setNote: (s: string) => void; review: (approve: boolean) => void}) {
  if (!show) return null;
  return <div className="pl-box"><b>Review for everyone on this server</b>
    <div className="pl-actions"><input className="plain-input grow" placeholder="Note to the maker (optional)" value={note} onChange={e => setNote(e.target.value)} />
      <button className="btn primary" onClick={() => review(true)}>Approve</button><button className="btn" onClick={() => review(false)}>Reject</button></div></div>;
}

function InstallRow({store, install, admin, reload}: {store: Store; install: Install; admin: boolean; reload: () => Promise<void>}) {
  const can = install.scope === 'me' || admin;
  const set = async (patch: {enabled?: boolean; settings?: Record<string, unknown>}) => {
    try { await api(`/plugins/${encodeURIComponent(install.id)}/install`, {method: 'PATCH', body: {scope: install.scope, ...patch}}); await reload(); } catch (e) { store.fail(e); }
  };
  const settings = install.manifest.contributes.settings ?? [];
  return <div className="pl-box">
    <label className="pop-row"><input type="checkbox" disabled={!can} checked={install.enabled} onChange={e => set({enabled: e.target.checked})} /> On {install.scope === 'me' ? 'for me' : 'for everyone'} <span className="muted small">(v{install.version}, off keeps it installed)</span></label>
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
  contributes: {theme: {light: {accent: '#0f766e'}, dark: {accent: '#2dd4bf'}}, pages: [{id: 'home', title: 'My page', blocks: [{type: 'text', text: 'Hello. Lists below are read only.'}, {type: 'items', title: 'My open urgent work', mine: true, filter: {join: 'and', rules: [{field: 'priority', op: 'is', value: '1'}]}}]}]}};

function PluginEditor({store, editId}: {store: Store; editId?: string}) {
  const [text, setText] = useState('');
  const [check, setCheck] = useState<{ok: boolean; effects?: string[]; error?: string} | null>(null);
  useEffect(() => {
    if (editId) api<Info>(`/plugins/${encodeURIComponent(editId)}`).then(i => setText(JSON.stringify(i.manifest, null, 2))).catch(store.fail);
    else setText(JSON.stringify(STARTER, null, 2));
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
    <button className="link small" onClick={() => go('/plugins')}>All plugins</button>
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
