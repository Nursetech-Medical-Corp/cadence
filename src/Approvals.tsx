// Approvals in the UI: the item panel section (request, sign), the Approvals page (what waits for you),
// and the Workflow rules card in project Settings.
import {useEffect, useState} from 'react';
import {FileSignature, ShieldCheck, Workflow} from 'lucide-react';
import type {Item, Project, TypeRule} from './types.ts';
import {api, type Store} from './store.ts';
import {Avatar, Empty, Popover, itemKey} from './components.tsx';

type Approval = {id: string; itemId: string; requestedBy: string | null; approver: string; meaning: string; note: string; decision: 'pending' | 'approved' | 'changes' | 'rejected'; comment: string; signedAt: string | null; signerName: string | null; fingerprint: string | null; passwordChecked: boolean; created: string};
const MEANINGS = [['approved', 'Approve'], ['reviewed', 'Review'], ['verified', 'Verify'], ['authored', 'Sign as author']] as const;
const DECIDED: Record<string, string> = {approved: 'Signed', changes: 'Changes requested', rejected: 'Rejected', pending: 'Waiting'};

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
            <div className="small"><b>{person(a.approver)?.name}</b> <span className="muted">to {a.meaning === 'authored' ? 'sign as author' : a.meaning.replace(/ed$/, '')}</span> <span className={'tag'}>{DECIDED[a.decision]}</span></div>
            {a.note && <div className="small muted">Request: {a.note}</div>}
            {a.signedAt && <div className="small muted">{a.signerName}, {new Date(a.signedAt).toLocaleString()}{a.passwordChecked ? ', identity confirmed by password' : ', no password on file'}{a.comment ? `. "${a.comment}"` : ''}</div>}
            {a.decision === 'pending' && a.approver === me && <SignBox approval={a} store={store} onDone={load} />}
          </div>
        </div>
      ))}
    </>
  );
}

function SignBox({approval, store, onDone}: {approval: Approval; store: Store; onDone: () => void}) {
  const [comment, setComment] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (decision: string) => {
    setBusy(true);
    try { await api(`/approvals/${approval.id}/sign`, {method: 'POST', body: {decision, comment, password}}); setPassword(''); onDone(); } catch (e) { store.fail(e); }
    setBusy(false);
  };
  return (
    <div className="sign-box">
      <textarea className="comment-box" style={{minHeight: 44}} placeholder="Comment (needed to request changes or reject)" value={comment} onChange={e => setComment(e.target.value)} />
      <div className="review-actions">
        <input className="plain-select" type="password" placeholder="Your password to sign" value={password} onChange={e => setPassword(e.target.value)} style={{width: 170}} />
        <button className="btn primary small" disabled={busy} onClick={() => go('approved')}><ShieldCheck size={12} /> Sign</button>
        <button className="btn small" disabled={busy || !comment.trim()} onClick={() => go('changes')}>Request changes</button>
        <button className="btn small danger" disabled={busy || !comment.trim()} onClick={() => go('rejected')}>Reject</button>
      </div>
      <div className="muted small">By signing you confirm the meaning shown above for this version of the item. Leave the password empty only if you have none set.</div>
    </div>
  );
}

/** Everything waiting for your signature, and what you asked others to sign. */
export function ApprovalsPage({store, me, open}: {store: Store; me: string; open: (id: string) => void}) {
  const [mine, setMine] = useState<Approval[]>([]);
  const [all, setAll] = useState<Approval[]>([]);
  useEffect(() => {
    api<Approval[]>('/approvals?mine=1&pending=true').then(setMine).catch(() => {});
    api<Approval[]>('/approvals').then(setAll).catch(() => {});
  }, [store.tick, me]);
  const row = (a: Approval) => {
    const it = store.items.get(a.itemId);
    if (!it) return null;
    return <div key={a.id} className="row" style={{cursor: 'pointer'}} onClick={() => open(it.id)}>
      <FileSignature size={14} className="muted" />
      <span className="muted small">{itemKey(it, store.projects)}</span>
      <span className="grow">{it.title}</span>
      <span className="tag">{a.meaning}</span>
      <Avatar person={store.people.find(p => p.id === a.approver)} size={18} />
      <span className={'small ' + (a.decision === 'approved' ? 'good' : a.decision === 'pending' ? 'muted' : 'overdue')}>{DECIDED[a.decision]}</span>
    </div>;
  };
  return (
    <div className="page">
      <h1><FileSignature size={20} /> Approvals</h1>
      <p className="muted">Signatures record who, what it means, when, and a fingerprint of the item at that moment. Open an item to sign.</p>
      <h3>Waiting for you <span className="count">{mine.length}</span></h3>
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
