// Human and AI work: the review dashboard, and the panel section for one item (who does it, review actions,
// work log with links, screenshots and files).
import {useEffect, useRef, useState} from 'react';
import {Bot, Check as CheckIcon, FileText, Link2, Paperclip, RotateCcw, ThumbsDown, ThumbsUp, User, X, Eye} from 'lucide-react';
import type {Item} from './types.ts';
import {api, type Store} from './store.ts';
import {Elapsed} from './TimeTracker.tsx';
import {Avatar, Empty, itemKey} from './components.tsx';
import {MarkdownView} from './BlockEditor.tsx';
import {canQuickView, quickView} from './QuickView.tsx';

type Review = {state: 'claimed' | 'accepted' | 'submitted' | 'changes' | 'approved' | 'declined'; by: string | null; at: string; note?: string; agent?: string};
type LogEntry = {id: string; itemId: string; actor: string | null; at: string; kind: string; text: string; url: string | null};
type FileRef = {id: string; name: string; mime: string; size: number; url: string};

export const reviewOf = (i: Item) => (i.fields.review ?? null) as Review | null;
const WORKER = [{v: 'human', label: 'Human', icon: User}, {v: 'either', label: 'Either', icon: null}, {v: 'ai', label: 'AI', icon: Bot}] as const;

export function WorkerToggle({item, store}: {item: Item; store: Store}) {
  const w = (item.fields.worker as string) ?? 'either';
  return <div className="seg">{WORKER.map(o => <button key={o.v} className={w === o.v ? 'on' : ''} onClick={() => store.updateItem(item.id, {fields: {...item.fields, worker: o.v}})}>{o.icon && <o.icon size={12} />} {o.label}</button>)}</div>;
}

const STATE_LABEL: Record<Review['state'], string> = {claimed: 'AI asked to take this', accepted: 'AI is working on it', submitted: 'Ready for your review', changes: 'Sent back to AI', approved: 'Approved', declined: 'Claim declined'};

/** Review actions, shared by the dashboard cards and the item panel. */
export function ReviewActions({item, store, compact}: {item: Item; store: Store; compact?: boolean}) {
  const r = reviewOf(item);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  if (!r) return null;
  const go = async (path: string, body: object) => { setBusy(true); try { await api(path, {method: 'POST', body: {itemId: item.id, ...body}}); setComment(''); } catch (e) { store.fail(e); } setBusy(false); };
  return (
    <div className={'review-box state-' + r.state + (compact ? ' compact' : '')} onClick={e => e.stopPropagation()}>
      <div className="review-head"><Bot size={14} /> <b>{STATE_LABEL[r.state]}</b>{r.agent && <span className="muted small">by {store.people.find(p => p.id === r.agent)?.name}</span>}</div>
      {r.state === 'claimed' && <div className="review-actions">
        <button className="btn primary small" disabled={busy} onClick={() => go('/ai/decide', {accept: true})}><CheckIcon size={12} /> Accept and assign</button>
        <button className="btn small" disabled={busy} onClick={() => go('/ai/decide', {accept: false})}><X size={12} /> Decline</button>
      </div>}
      {r.state === 'submitted' && <>
        <textarea className="comment-box" style={{minHeight: compact ? 40 : 56}} placeholder="Comment for the agent (optional to approve, needed to send back)" value={comment} onChange={e => setComment(e.target.value)}
          onFocus={() => { if (!store.running) store.startTimer(item.id, 'review'); }} />
        {store.running?.itemId === item.id && store.running.kind === 'review' && <div className="muted small">Reviewing for <Elapsed start={store.running.start} /></div>}
        <div className="review-actions">
          <button className="btn primary small" disabled={busy} onClick={() => go('/ai/review', {approve: true, comment})}><ThumbsUp size={12} /> Approve</button>
          <button className="btn small" disabled={busy || !comment.trim()} title={comment.trim() ? '' : 'Write what to change first'} onClick={() => go('/ai/review', {approve: false, comment})}><ThumbsDown size={12} /> Send back</button>
        </div>
      </>}
    </div>
  );
}

/** Item panel section: who does it, review, files and the work log. */
export function WorkSection({item, store}: {item: Item; store: Store}) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [files, setFiles] = useState<FileRef[]>([]);
  const [link, setLink] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api<LogEntry[]>(`/items/${item.id}/log`).then(setLog).catch(() => {});
    api<FileRef[]>(`/items/${item.id}/files`).then(setFiles).catch(() => {});
  }, [item.id, store.tick]);
  const upload = async (f: File) => {
    const data = await new Promise<string>(ok => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(f); });
    try { await api(`/items/${item.id}/files`, {method: 'POST', body: {name: f.name, mime: f.type, data}}); } catch (e) { store.fail(e); }
  };
  const person = (id: string | null) => store.people.find(p => p.id === id);
  return (
    <div onPaste={e => { const f = [...e.clipboardData.files][0]; if (f) { e.preventDefault(); upload(f); } }}
      onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); for (const f of e.dataTransfer.files) upload(f); }}>
      <h4><Bot size={13} /> Who does it <span style={{marginLeft: 'auto', textTransform: 'none', letterSpacing: 0}}><WorkerToggle item={item} store={store} /></span></h4>
      <ReviewActions item={item} store={store} />
      <h4><Paperclip size={13} /> Files and links <span className="count">{files.length}</span></h4>
      <div className="files">
        {files.map(f => f.mime.startsWith('image/')
          ? <a key={f.id} href={f.url} onClick={e => { e.preventDefault(); quickView({url: f.url, name: f.name, mime: f.mime}); }} className="file-thumb" title={`${f.name}. Click for quick view`}><img src={f.url} alt={f.name} /></a>
          : <a key={f.id} href={f.url} onClick={e => { if (/pdf|text/.test(f.mime)) { e.preventDefault(); quickView({url: f.url, name: f.name, mime: f.mime}); } }} target="_blank" rel="noreferrer" className="file-chip" title="Click for quick view"><FileText size={13} /> {f.name}</a>)}
        <button className="file-add" onClick={() => input.current?.click()} title="Add files. You can also paste a screenshot or drop files here">+ Add</button>
        <input ref={input} type="file" hidden multiple accept="image/*,application/pdf,text/plain,text/csv,text/markdown,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp" onChange={e => { for (const f of e.target.files ?? []) upload(f); e.target.value = ''; }} />
      </div>
      <div className="time-row" style={{marginTop: 6}}>
        <input className="inline" placeholder="Paste a link to add it to the log" value={link} onChange={e => setLink(e.target.value)}
          onKeyDown={async e => { if (e.key === 'Enter' && /^https?:\/\//.test(link)) { try { await api('/ai/log', {method: 'POST', body: {itemId: item.id, kind: 'link', text: link, url: link}}); setLink(''); } catch (er) { store.fail(er); } } }} />
      </div>
      {log.length > 0 && <>
        <h4>Work log <span className="count">{log.length}</span></h4>
        <div className="worklog">
          {log.map(e => (
            <div key={e.id} className={'wl-entry k-' + e.kind}>
              <Avatar person={person(e.actor)} size={18} />
              <div className="grow">
                <div className="small"><b>{person(e.actor)?.name ?? 'System'}</b> <span className="muted">{e.kind === 'result' ? 'submitted' : e.kind === 'missed' ? 'could not do' : e.kind} {new Date(e.at).toLocaleString()}</span></div>
                {e.kind === 'file' && e.url && /\.(png|jpe?g|gif|webp)$/i.test(e.text) ? <a href={e.url} onClick={ev => { ev.preventDefault(); quickView({url: e.url!, name: e.text}); }}><img className="wl-img" src={e.url} alt={e.text} /></a>
                  : e.kind === 'result' ? <div className="wl-text"><MarkdownView text={e.text} /></div> : <div className="wl-text">{e.text}</div>}
                {e.url && e.kind !== 'file' && <a className="link small" href={e.url} target="_blank" rel="noreferrer"><Link2 size={11} /> {e.url.replace(/^https?:\/\//, '').slice(0, 60)}</a>}
                {e.url && e.kind !== 'file' && canQuickView(e.url) && <button className="btn ghost small" onClick={() => quickView({url: e.url!})}><Eye size={11} /> Quick view</button>}
              </div>
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}

/** Dashboard: everything moving between people and AI workers. */
type Proposal = {id: string; agent: string; owner: string | null; op: string; args: unknown[]; summary: string; reason: string; itemId: string | null; created: string; state: string; note: string | null};

/** Changes your agents want to make, held until you approve them. */
function Proposals({store, open, all}: {store: Store; open: (id: string) => void; all: boolean}) {
  const [list, setList] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<Record<string, string>>({});
  const load = () => api<Proposal[]>(`/proposals?state=pending${all ? '&all=1' : ''}`).then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, [store.tick, all]);
  if (!list.length) return null;
  const decide = async (p: Proposal, approve: boolean) => {
    setBusy(p.id);
    try { const r = await api<Proposal>(`/proposals/${p.id}/decide`, {method: 'POST', body: {approve, note: note[p.id]}}); if (r.state === 'failed') alert(`Could not apply: ${r.note}`); }
    catch (e) { store.fail(e); }
    setBusy(''); load();
  };
  return (
    <div className="proposals">
      <h3>Changes to approve <span className="muted">{list.length}</span></h3>
      <p className="muted small">Your agents asked to make these changes. Nothing happens until you approve. Approving makes the change now, in your name, and tells the agent.</p>
      {list.map(p => {
        const agent = store.people.find(x => x.id === p.agent);
        return (
          <div key={p.id} className="proposal">
            <div className="proposal-head">{agent && <Avatar person={agent} size={18} />}<b>{agent?.name ?? 'Agent'}</b><span className="grow">{p.summary}</span>
              {p.itemId && store.items.has(p.itemId) && <button className="btn ghost small" onClick={() => open(p.itemId!)}>Open</button>}</div>
            {p.reason && <div className="small muted">{p.reason}</div>}
            <details className="small"><summary>Details</summary><pre className="proposal-args">{JSON.stringify(p.args[1] ?? p.args[0], null, 1).slice(0, 2000)}</pre></details>
            <div className="review-actions">
              <input className="plain-select" style={{flex: 1}} placeholder="Note for the agent (optional)" value={note[p.id] ?? ''} onChange={e => setNote({...note, [p.id]: e.target.value})} />
              <button className="btn primary small" disabled={busy === p.id} onClick={() => decide(p, true)}><ThumbsUp size={12} /> Approve</button>
              <button className="btn small" disabled={busy === p.id} onClick={() => decide(p, false)}><ThumbsDown size={12} /> Reject</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AIWorkPage({store, open}: {store: Store; open: (id: string) => void}) {
  const [project, setProject] = useState('');
  const [whose, setWhose] = useState<'mine' | 'all' | string>('mine');
  const [lastLog, setLastLog] = useState<Record<string, LogEntry | undefined>>({});
  const admin = store.settings.admin;
  const myAgents = new Set(store.people.filter(p => p.kind === 'ai' && p.owner === store.me).map(p => p.id));
  // Your agents' work by default; admins can look at every agent or one agent.
  const shown = whose === 'mine' ? myAgents : whose === 'all' ? null : new Set([whose]);
  const ownedBy = (i: Item) => !shown || (!!reviewOf(i)?.agent && shown.has(reviewOf(i)!.agent!)) || i.assignees.some(a => shown.has(a))
    || (whose === 'mine' && !reviewOf(i) && i.fields.worker === 'ai' && i.assignees.includes(store.me));
  const items = [...store.items.values()].filter(i => (!project || i.projectId === project) && ownedBy(i));
  const ais = new Set(store.people.filter(p => p.kind === 'ai').map(p => p.id));
  const r = (i: Item) => reviewOf(i);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const cols: {id: string; title: string; hint: string; list: Item[]}[] = [
    {id: 'open', title: 'Ready for AI', hint: 'Marked for AI, nobody on it yet', list: items.filter(i => !i.completed && i.fields.worker === 'ai' && (!r(i) || r(i)!.state === 'declined') && !i.assignees.some(a => ais.has(a)))},
    {id: 'claimed', title: 'Claims to approve', hint: 'An agent asked to take these', list: items.filter(i => r(i)?.state === 'claimed')},
    {id: 'working', title: 'AI working', hint: 'Accepted, or sent back with changes', list: items.filter(i => !i.completed && (['accepted', 'changes'].includes(r(i)?.state ?? '') || (!r(i) && i.assignees.some(a => ais.has(a)))))},
    {id: 'review', title: 'Ready for review', hint: 'Check the report, approve or send back', list: items.filter(i => r(i)?.state === 'submitted')},
    {id: 'done', title: 'Approved this week', hint: '', list: items.filter(i => r(i)?.state === 'approved' && r(i)!.at > weekAgo)},
  ];
  useEffect(() => {
    const ids = [...cols[3].list, ...cols[2].list].map(i => i.id).slice(0, 40);
    Promise.all(ids.map(id => api<LogEntry[]>(`/items/${id}/log`).then(l => [id, l.filter(e => e.kind !== 'review').at(-1)] as const).catch(() => [id, undefined] as const)))
      .then(rows => setLastLog(Object.fromEntries(rows)));
  }, [store.tick, project]);
  return (
    <div className="page" style={{maxWidth: 'none'}}>
      <h1><Bot size={20} /> AI work</h1>
      <p className="muted">Tasks marked for AI flow left to right. Agents claim work, you accept, they log every step and submit a report with links and screenshots, you approve or send it back with a comment. Mark tasks Human, AI or Either in any item.</p>
      <div className="toolbar" style={{padding: '0 0 10px', border: 0}}>
        <select className="plain-select" value={whose} onChange={e => setWhose(e.target.value)}>
          <option value="mine">My agents ({myAgents.size})</option>
          {admin && <option value="all">All agents</option>}
          {store.people.filter(p => p.kind === 'ai' && (admin || p.owner === store.me)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="plain-select" value={project} onChange={e => setProject(e.target.value)}><option value="">All spaces</option>{store.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <span className="muted small">{myAgents.size ? '' : 'You have no AI agents yet. '}Add yours on the Team page (My AI agents) and connect it with its key.</span>
      </div>
      <Proposals store={store} open={open} all={whose === 'all'} />
      <div className="board" style={{padding: 0}}>
        {cols.map(c => (
          <div key={c.id} className="column ai-col">
            <div className="col-head">{c.title}<span className="muted">{c.list.length}</span></div>
            {c.hint && <div className="muted small" style={{padding: '0 6px 8px'}}>{c.hint}</div>}
            {c.list.map(i => {
              const rv = r(i), agent = store.people.find(p => p.id === (rv?.agent ?? i.assignees.find(a => ais.has(a))));
              const last = lastLog[i.id];
              return (
                <div key={i.id} className="card" onClick={() => open(i.id)}>
                  <div className="card-top"><span className="muted small">{itemKey(i, store.projects)}</span><span className="spacer" />{agent && <><Avatar person={agent} size={18} /><span className="small muted">{agent.name}</span></>}</div>
                  <div className="card-title">{i.title}</div>
                  {last && <div className="small muted ai-last">{last.kind === 'result' ? 'Report: ' : ''}{last.text.slice(0, 140)}</div>}
                  {(c.id === 'claimed' || c.id === 'review') && <ReviewActions item={i} store={store} compact />}
                  {rv?.state === 'changes' && <div className="small" style={{color: 'var(--danger)'}}><RotateCcw size={11} /> {rv.note}</div>}
                </div>
              );
            })}
            {!c.list.length && <div className="muted small" style={{padding: 8}}>Nothing here.</div>}
          </div>
        ))}
      </div>
      {!items.some(i => i.fields.worker === 'ai' || r(i)) && <Empty title="No AI work yet">Open a task and set Who does it to AI, or use a template pack with AI steps.</Empty>}
    </div>
  );
}

