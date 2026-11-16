// Approvals in the UI: the item panel section (request, sign), the Approvals page (what waits for you),
// and the Workflow rules card in project Settings.
import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {FileSignature, ShieldCheck, Workflow, X} from 'lucide-react';
import type {Item, Project, TypeRule} from './types.ts';
import {api, type Store} from './store.ts';
import {Avatar, Empty, Popover, itemKey} from './components.tsx';

type Approval = {id: string; itemId: string; requestedBy: string | null; approver: string; meaning: string; note: string; decision: 'pending' | 'approved' | 'changes' | 'rejected'; comment: string; signedAt: string | null; signerName: string | null; fingerprint: string | null; passwordChecked: boolean; auth?: string; created: string};
const MEANINGS = [['approved', 'Approve'], ['reviewed', 'Review'], ['verified', 'Verify'], ['authored', 'Sign as author']] as const;
const DECIDED: Record<string, string> = {approved: 'Signed', changes: 'Changes requested', rejected: 'Rejected', pending: 'Waiting'};

/** The kind of signature asked for, as a noun, so it never reads like a decision already made. */
const MEANING_LABEL: Record<string, string> = {approved: 'Approval', reviewed: 'Review', verified: 'Verification', authored: 'Author signature'};
const MEANING_VERB: Record<string, string> = {approved: 'to approve', reviewed: 'to review', verified: 'to verify', authored: 'to sign as author'};

type Needs = {mode: 'every' | 'session' | 'never'; password: boolean; until: string | null};

/** Sign one or many approvals in one in-app dialog: comment when sending back, password only when the workspace asks for it. */
function SignDialog({store, list, decision, close, done}: {store: Store; list: Approval[]; decision: 'approved' | 'changes'; close: () => void; done: () => void}) {
  const [needs, setNeeds] = useState<Needs | null>(null);
  const [comment, setComment] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api<Needs>('/approvals/needs').then(setNeeds).catch(() => setNeeds({mode: 'every', password: true, until: null})); }, []);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<{signed: Approval[]; failed: {id: string; error: string}[]}>('/approvals/sign-many', {method: 'POST', body: {ids: list.map(a => a.id), decision, comment, password: password || undefined}});
      store.flash(`${decision === 'approved' ? 'Signed' : 'Sent back'} ${r.signed.length}${r.failed.length ? `; ${r.failed.length} not: ${r.failed[0].error}` : ''}`);
      done(); close();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const back = decision === 'changes';
  const n = list.length;
  return createPortal(<div className="overlay dlg-back" onMouseDown={e => { if (e.target === e.currentTarget) close(); }} onKeyDown={e => { if (e.key === 'Escape') close(); }}>
    <div className="dlg" role="dialog" aria-modal="true">
      <button className="icon dlg-x" title="Close (Esc)" onClick={close}><X size={16} /></button>
      <b>{back ? 'Request changes' : 'Sign'}{n > 1 ? ` ${n} approvals` : ''}</b>
      <div className="small muted sign-list">{list.slice(0, 8).map(a => { const it = store.items.get(a.itemId); return <div key={a.id}>{it ? `${itemKey(it, store.projects)} ${it.title}` : a.itemId} <span className="tag">{MEANING_LABEL[a.meaning] ?? a.meaning}</span></div>; })}{n > 8 && <div>and {n - 8} more</div>}</div>
      <textarea className="plain-input" rows={3} autoFocus placeholder={back ? 'What needs to change (needed)' : 'Comment (optional)'} value={comment} onChange={e => setComment(e.target.value)} />
      {needs?.password && <input className="plain-input" type="password" placeholder={needs.mode === 'session' ? 'Your password (then no more for 8 hours)' : 'Your password'} value={password} onChange={e => setPassword(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') go(); }} />}
      {needs && !needs.password && needs.until && <div className="small muted">Signed in for signing until {new Date(needs.until).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}. No password needed.</div>}
      {err && <div className="small" style={{color: 'var(--danger)'}}>{err}</div>}
      <div className="small muted">{back ? 'The comment goes to whoever asked.' : 'Signing records you, the meaning, the time and a fingerprint of each item as it is now.'}</div>
      <div className="dlg-actions">
        <button className="btn" onClick={close}>Cancel</button>
        <button className={'btn ' + (back ? '' : 'primary')} disabled={busy || !needs || (back && !comment.trim()) || (!!needs?.password && !password)} onClick={go}>{back ? <>Send back</> : <><ShieldCheck size={13} /> Sign{n > 1 ? ` ${n}` : ''}</>}</button>
      </div>
    </div>
  </div>, document.body);
}

export function ApprovalsSection({item, store, me}: {item: Item; store: Store; me: string}) {
  const [list, setList] = useState<Approval[]>([]);
  const [state, setState] = useState<{pending: number; complete: boolean; changedSinceSigning: boolean} | null>(null);
  const [asking, setAsking] = useState(false);
  const [who, setWho] = useState<string[]>([]);
  const [meaning, setMeaning] = useState('approved');
  const [note, setNote] = useState('');
  const load = () => {
    api<Approval[]>(`/approvals?itemId=${item.id}`).then(setList).catch(() => {});
    api<typeof state>(`/items/${item.id}/approval-state`).then(setState).catch(() => {});
  };
  useEffect(load, [item.id, store.tick, item.updated]);
  const person = (id: string | null) => store.people.find(p => p.id === id);
  const humans = store.people.filter(p => p.kind !== 'ai');
  return (
    <>
      <h4><FileSignature size={13} /> Approvals {state && <span className={'count'}>{state.complete ? (state.changedSinceSigning ? 'changed since signing' : 'all signed') : `${state.pending} waiting`}</span>}
        <span className="picker" style={{marginLeft: 'auto', textTransform: 'none', letterSpacing: 0}}>
          <button className="btn ghost small" onClick={() => setAsking(o => !o)}>Request approval</button>
          <Popover open={asking} onClose={() => setAsking(false)} className="wide">
            <div className="pop-label">Who signs</div>
            {humans.map(p => <button key={p.id} className={'pop-row' + (who.includes(p.id) ? ' on' : '')} onClick={() => setWho(w => w.includes(p.id) ? w.filter(x => x !== p.id) : [...w, p.id])}><input type="checkbox" readOnly checked={who.includes(p.id)} /><Avatar person={p} size={18} /> {p.name}</button>)}
            <div className="pop-label">Meaning of the signature</div>
            <div className="seg">{MEANINGS.map(([v, l]) => <button key={v} className={meaning === v ? 'on' : ''} onClick={() => setMeaning(v)}>{l}</button>)}</div>
            <textarea className="comment-box" placeholder="Note for approvers (optional)" value={note} onChange={e => setNote(e.target.value)} />
            <button className="btn primary" style={{marginTop: 6}} disabled={!who.length} onClick={async () => {
              try { await api('/approvals', {method: 'POST', body: {itemId: item.id, approvers: who, meaning, note}}); setAsking(false); setWho([]); setNote(''); load(); } catch (e) { store.fail(e); }
            }}>Send request</button>
          </Popover>
        </span>
      </h4>
      {state?.changedSinceSigning && <div className="small" style={{color: 'var(--danger)', marginBottom: 6}}>This item changed after it was signed. Signatures apply to the earlier version; request them again.</div>}
      {list.map(a => (
        <div key={a.id} className={'approval a-' + a.decision}>
          <Avatar person={person(a.approver)} size={22} />
          <div className="grow">
            <div className="small"><b>{person(a.approver)?.name}</b> <span className="muted">{MEANING_VERB[a.meaning] ?? a.meaning}</span> <span className={'tag'}>{DECIDED[a.decision]}</span></div>
            {a.note && <div className="small muted">Request: {a.note}</div>}
            {a.signedAt && <div className="small muted">{a.signerName}, {new Date(a.signedAt).toLocaleString()}{a.auth === 'password' ? ', password entered' : a.auth === 'session' ? ', password entered earlier this session' : ', no password asked'}{a.comment ? `. "${a.comment}"` : ''}</div>}
            {a.decision === 'pending' && a.approver === me && <><HandedIn approval={a} store={store} /><SignBox approval={a} store={store} onDone={load} /></>}
          </div>
        </div>
      ))}
    </>
  );
}

/** What the person asking handed in (their latest report or step), right above the sign buttons. */
function HandedIn({approval, store}: {approval: Approval; store: Store}) {
  const [last, setLast] = useState<{text: string; at: string; kind: string} | null>(null);
  useEffect(() => {
    api<{actor: string | null; text: string; at: string; kind: string}[]>(`/items/${approval.itemId}/log`)
      .then(l => setLast([...l].reverse().find(e => e.actor === approval.requestedBy && ['result', 'step', 'note'].includes(e.kind)) ?? null)).catch(() => {});
  }, [approval.id, store.tick]);
  if (!last) return null;
  const who = store.people.find(p => p.id === approval.requestedBy)?.name ?? 'They';
  return <div className="handed-in small"><b>{who}{last.kind === 'result' ? ' handed in' : ' last wrote'}</b> <span className="muted">{new Date(last.at).toLocaleString()}</span><div className="handed-text">{last.text.slice(0, 1200)}</div></div>;
}

function SignBox({approval, store, onDone}: {approval: Approval; store: Store; onDone: () => void}) {
  const [comment, setComment] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [needs, setNeeds] = useState<Needs | null>(null);
  useEffect(() => { api<Needs>('/approvals/needs').then(setNeeds).catch(() => {}); }, [approval.id]);
  const go = async (decision: string) => {
    setBusy(true);
    try { await api(`/approvals/${approval.id}/sign`, {method: 'POST', body: {decision, comment, password}}); setPassword(''); onDone(); } catch (e) { store.fail(e); }
    setBusy(false);
  };
  return (
    <div className="sign-box">
      <textarea className="comment-box" style={{minHeight: 44}} placeholder="Comment (needed to request changes or reject)" value={comment} onChange={e => setComment(e.target.value)} />
      <div className="review-actions">
        {needs?.password && <input className="plain-select" type="password" placeholder="Your password to sign" value={password} onChange={e => setPassword(e.target.value)} style={{width: 170}} />}
        <button className="btn primary small" disabled={busy} onClick={() => go('approved')}><ShieldCheck size={12} /> Sign</button>
        <button className="btn small" disabled={busy || !comment.trim()} onClick={() => go('changes')}>Request changes</button>
        <button className="btn small danger" disabled={busy || !comment.trim()} onClick={() => go('rejected')}>Reject</button>
      </div>
      <div className="muted small">By signing you confirm the meaning shown above for this version of the item.{needs?.mode === 'session' && needs.password ? ' Your password is asked once, then not again for 8 hours.' : ''}</div>
    </div>
  );
}

/** Everything waiting for your signature, and what you asked others to sign. */
export function ApprovalsPage({store, me, open}: {store: Store; me: string; open: (id: string) => void}) {
  const [mine, setMine] = useState<Approval[]>([]);
  const [all, setAll] = useState<Approval[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [signing, setSigning] = useState<{list: Approval[]; decision: 'approved' | 'changes'} | null>(null);
  const reload = () => {
    api<Approval[]>('/approvals?mine=1&pending=true').then(setMine).catch(() => {});
    api<Approval[]>('/approvals').then(setAll).catch(() => {});
  };
  useEffect(reload, [store.tick, me]);
  const row = (a: Approval) => {
    const it = store.items.get(a.itemId);
    if (!it) return null;
    const mineNow = a.decision === 'pending' && a.approver === me;
    return <div key={a.id} className={'row appr-row' + (sel.has(a.id) ? ' sel' : '')} style={{cursor: 'pointer'}} onClick={() => open(it.id)}>
      {mineNow ? <input type="checkbox" checked={sel.has(a.id)} onClick={e => e.stopPropagation()} onChange={() => setSel(p => { const n = new Set(p); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} title="Select to sign several at once" />
        : <FileSignature size={14} className="muted" />}
      <span className="muted small">{itemKey(it, store.projects)}</span>
      <span className="grow">{it.title}</span>
      <span className="tag" title="What signing means">{MEANING_LABEL[a.meaning] ?? a.meaning}</span>
      {a.requestedBy && <span className="muted small" title="Who asked">from {store.people.find(p => p.id === a.requestedBy)?.name ?? 'someone'}{store.people.find(p => p.id === a.requestedBy)?.kind === 'ai' ? ' (AI)' : ''}</span>}
      <Avatar person={store.people.find(p => p.id === a.approver)} size={18} />
      {a.decision === 'pending' && a.approver === me
        ? <span className="row-actions" onClick={e => e.stopPropagation()}>
            <button className="btn primary small" title="Sign it now" onClick={() => setSigning({list: [a], decision: 'approved'})}><ShieldCheck size={12} /> Sign</button>
            <button className="btn small" title="Send it back with a comment" onClick={() => setSigning({list: [a], decision: 'changes'})}>Changes</button>
          </span>
        : <span className={'small ' + (a.decision === 'approved' ? 'good' : a.decision === 'pending' ? 'muted' : 'overdue')}>{DECIDED[a.decision]}</span>}
    </div>;
  };
  return (
    <div className="page">
      <h1><FileSignature size={20} /> Approvals</h1>
      <p className="muted">Signatures record who, what it means, when, and a fingerprint of the item at that moment. Sign right here, or open the item to read it first. Work an AI agent hands in is decided by your signature too.</p>
      {store.settings.admin && <SignSetting store={store} />}
      {signing && <SignDialog store={store} list={signing.list} decision={signing.decision} close={() => setSigning(null)} done={() => { setSel(new Set()); reload(); }} />}
      <h3>Waiting for you <span className="count">{mine.length}</span>
        {mine.length > 1 && <span className="appr-bulk">
          <button className="btn ghost small" onClick={() => setSel(sel.size === mine.length ? new Set() : new Set(mine.map(a => a.id)))}>{sel.size === mine.length ? 'Clear' : 'Select all'}</button>
          {sel.size > 0 && <><button className="btn primary small" onClick={() => setSigning({list: mine.filter(a => sel.has(a.id)), decision: 'approved'})}><ShieldCheck size={12} /> Sign {sel.size}</button>
            <button className="btn small" onClick={() => setSigning({list: mine.filter(a => sel.has(a.id)), decision: 'changes'})}>Request changes on {sel.size}</button></>}
        </span>}</h3>
      {mine.map(row)}
      {!mine.length && <p className="muted small">Nothing waiting for your signature.</p>}
      <h3>You asked others</h3>
      {all.filter(a => a.requestedBy === me && a.decision === 'pending').map(row)}
      <h3>Recently decided</h3>
      {all.filter(a => a.decision !== 'pending').sort((a, b) => (b.signedAt ?? '').localeCompare(a.signedAt ?? '')).slice(0, 30).map(row)}
      {!all.length && <Empty title="No approvals yet">Open any item and press Request approval.</Empty>}
    </div>
  );
}

/** Admins: how often signing asks for a password. */
function SignSetting({store}: {store: Store}) {
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => { api<Needs>('/approvals/needs').then(n => setMode(n.mode)).catch(() => {}); }, []);
  if (!mode) return null;
  const save = async (v: string) => { try { await api('/workspace', {method: 'PUT', body: {signPassword: v}}); setMode(v); store.flash('Saved'); } catch (e) { store.fail(e); } };
  return <div className="set-item appr-setting">
    <span className="grow small">Signing asks for your password <span className="muted">(admins set this for the workspace; AI agents and tokens can never sign)</span></span>
    <select className="plain-select" value={mode} onChange={e => save(e.target.value)}>
      <option value="session">Once, then not for 8 hours</option>
      <option value="every">Every signature</option>
      <option value="never">Never (sign with one click)</option>
    </select>
  </div>;
}

/** Settings card: rules per item type. */
export function WorkflowCard({store, project}: {store: Store; project: Project}) {
  const wf = project.settings.workflow ?? {};
  const [type, setType] = useState(project.types[0]);
  const rule: TypeRule = wf[type] ?? {};
  const save = (r: TypeRule) => store.updateProject(project.id, {settings: {...project.settings, workflow: {...wf, [type]: r}}});
  const reqs: [string, string][] = [['assignees', 'Owner'], ['estimate', 'Estimate'], ['due', 'Due date'], ['start', 'Start date'], ['body', 'Description'], ...project.fields.map(f => [`f:${f.id}`, f.name] as [string, string])];
  const tr = rule.transitions;
  return (
    <section className="set-card">
      <div className="set-card-head"><h3><Workflow size={15} /> Workflow rules</h3><span className="muted small">Per item type: which status moves are allowed, what must be filled in before Done, and whether signed approval is required. Enforced for people, the API and AI.</span></div>
      <div className="chips" style={{padding: '6px 0'}}>{project.types.map(t => <button key={t} className={'chip-toggle' + (t === type ? ' on' : '')} onClick={() => setType(t)}>{t}{wf[t] && Object.keys(wf[t]).length ? ' *' : ''}</button>)}</div>
      <div className="pop-label">Required before Done</div>
      <div className="chips">{reqs.map(([k, l]) => <label key={k} className={'chip-toggle' + (rule.required?.includes(k) ? ' on' : '')}><input type="checkbox" checked={!!rule.required?.includes(k)} onChange={() => save({...rule, required: rule.required?.includes(k) ? rule.required.filter(x => x !== k) : [...(rule.required ?? []), k]})} />{l}</label>)}</div>
      <label className="set-item" style={{gap: 8}}><input type="checkbox" checked={!!rule.requireApproval} onChange={e => save({...rule, requireApproval: e.target.checked})} /><span className="grow">Every requested approval must be signed (and the item unchanged since) before Done</span></label>
      <label className="set-item" style={{gap: 8}}><input type="checkbox" checked={!!rule.humansOnly} onChange={e => save({...rule, humansOnly: e.target.checked})} /><span className="grow">Only people can close it (not AI agents)</span></label>
      <label className="set-item" style={{gap: 8}}><input type="checkbox" checked={!!tr} onChange={e => save({...rule, transitions: e.target.checked ? Object.fromEntries(project.statuses.map(s => [s.id, project.statuses.map(x => x.id).filter(x => x !== s.id)])) : undefined})} /><span className="grow">Limit which status moves are allowed</span></label>
      {tr && <div style={{overflowX: 'auto'}}><table className="ins-table">
        <thead><tr><th>From (row) to (column)</th>{project.statuses.map(s => <th key={s.id}>{s.name}</th>)}</tr></thead>
        <tbody>{project.statuses.map(from => <tr key={from.id}><td><b>{from.name}</b></td>{project.statuses.map(to => <td key={to.id} style={{textAlign: 'center'}}>
          {from.id === to.id ? '-' : <input type="checkbox" checked={!!tr[from.id]?.includes(to.id)} onChange={() => { const cur = tr[from.id] ?? []; save({...rule, transitions: {...tr, [from.id]: cur.includes(to.id) ? cur.filter(x => x !== to.id) : [...cur, to.id]}}); }} />}
        </td>)}</tr>)}</tbody>
      </table></div>}
      {Object.keys(rule).length > 0 && <button className="btn ghost small" onClick={() => { const n = {...wf}; delete n[type]; store.updateProject(project.id, {settings: {...project.settings, workflow: n}}); }}>Remove rules for {type}</button>}
    </section>
  );
}
