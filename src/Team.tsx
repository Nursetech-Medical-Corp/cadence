// Sign-in page, Team page (people, roles and their permissions, sign-in and Google), and per-project access.
import {AREAS, POLICIES} from './customize.ts';
import {useEffect, useState} from 'react';
import {Check as CheckIcon, CircleUser, Copy, KeyRound, LogIn, Mail, Plus, Shield, Trash2} from 'lucide-react';
import {FEATURE_LABELS, type Customization, type Features, type Project} from './types.ts';
import {api, type Store, switchWorkspace, wsId} from './store.ts';
import {Avatar} from './components.tsx';

type Cap = string;
type Role = {id: string; name: string; caps: Cap[]};
type Member = {id: string; name: string; email: string; color: string; role: string; admin: boolean; active: boolean; notifyEmail: boolean; hasPassword: boolean; kind: 'human' | 'ai'};
export type Me = {required: boolean; forced?: boolean; account?: string | null; linked?: string[]; signup?: 'open' | 'invite'; owner?: boolean; setup?: boolean; memberOf?: {id: string; name: string}[];
  person: {id: string; name: string} | null; admin: boolean; googleReady: boolean; signInGoogle?: boolean; signInLink?: boolean; caps: Record<string, string[]>};

/** First run of a hosted server: create the owner account. It becomes admin of every workspace. */
/** The card every sign-in screen sits in: the brand, then the form. */
function AuthCard({children}: {children: React.ReactNode}) {
  return <div className="signin"><div className="signin-card"><div className="brand" style={{fontSize: '1.2em'}}><span className="brand-mark" /> Cadence</div>{children}</div></div>;
}

export function SetupServer() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    if (pw !== pw2) return setErr('The two passwords do not match');
    try { await api('/auth/setup', {method: 'POST', body: {name, email, password: pw}}); location.hash = '/mywork'; location.reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <AuthCard>
        <h1 style={{margin: '8px 0 4px'}}>Set up this server</h1>
        <div className="muted small">Create the owner account. It becomes admin of every workspace here. Invite everyone else from the Team page.</div>
        <input className="search" placeholder="Your name" autoFocus value={name} onChange={e => setName(e.target.value)} />
        <input className="search" placeholder="Email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
        <input className="search" type="password" placeholder="Password (8 or more characters)" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} />
        <input className="search" type="password" placeholder="Type it again" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
        {err && <div className="small" style={{color: 'var(--danger)'}}>{err}</div>}
        <button className="btn primary" style={{width: '100%', justifyContent: 'center', padding: 8}} disabled={!email.trim() || pw.length < 8} onClick={go}><LogIn size={14} /> Create account</button>
    </AuthCard>
  );
}

/** Signed in, but not a member of this workspace: go to one you belong to, or sign out. */
export function NoAccess({me}: {me: Me}) {
  const list = me.memberOf ?? [];
  useEffect(() => { if (list.length === 1) switchWorkspace(list[0].id); }, [list]);
  return (
    <AuthCard>
        <h1 style={{margin: '8px 0 4px'}}>{list.length ? 'Pick a workspace' : 'No workspace yet'}</h1>
        <div className="muted small">Signed in as <b>{me.account}</b>. {list.length ? 'You are not a member of this one.' : 'Ask an admin to invite this email.'}</div>
        {list.map(w => <button key={w.id} className="btn" style={{width: '100%', justifyContent: 'center'}} onClick={() => switchWorkspace(w.id)}>{w.name}</button>)}
        <button className="btn ghost" style={{width: '100%', justifyContent: 'center'}} onClick={async () => { await api('/auth/logout', {method: 'POST'}); location.reload(); }}>Sign out</button>
    </AuthCard>
  );
}

/** Sign in: Continue with Google and Email me a sign-in link when the server has them; a password as the fallback. */
export function SignIn({google, emailLink, signup}: {google: boolean; emailLink: boolean; signup?: 'open' | 'invite'}) {
  const [mode, setMode] = useState<'in' | 'new'>('in');
  const [usePassword, setUsePassword] = useState(!google && !emailLink);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(new URLSearchParams(location.hash.split('?')[1] ?? '').get('error') ?? '');
  const [note, setNote] = useState('');
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const submit = async () => {
    setError(''); setNote('');
    try {
      if (mode === 'new') { const r = await api<{workspace: string}>('/auth/signup', {method: 'POST', body: {name, email, password}}); switchWorkspace(r.workspace); }
      else if (usePassword) { await api('/auth/login', {method: 'POST', body: {email, password}}); location.hash = '/mywork'; location.reload(); }
      else { const r = await api<{message: string}>('/auth/email-link', {method: 'POST', body: {email}}); setNote(r.message); }
    } catch (e) { fail(e); }
  };
  const go = (m: typeof mode) => { setMode(m); setError(''); setNote(''); };
  const withPassword = mode === 'new' || usePassword;
  return (
    <AuthCard>
      <h1 style={{margin: '8px 0 4px'}}>{mode === 'in' ? 'Sign in' : 'Create your account'}</h1>
      <div className="seg auth-tabs"><button className={mode === 'in' ? 'on' : ''} onClick={() => go('in')}>Sign in</button><button className={mode === 'new' ? 'on' : ''} onClick={() => go('new')}>Create account</button></div>
      {mode === 'new' && signup !== 'open' ? <div className="muted small">Accounts here are by invitation. Ask a workspace admin to invite your email.</div> : <>
        {google && mode === 'in' && <><a className="btn google-btn" href="/auth/google/start"><GoogleMark /> Continue with Google</a>{(emailLink || usePassword) && <div className="or"><span>or</span></div>}</>}
        {mode === 'new' && <input className="search" placeholder="Your name" autoComplete="name" value={name} onChange={e => setName(e.target.value)} />}
        {(withPassword || emailLink) && <input className="search" placeholder="Email" type="email" autoComplete="username" autoFocus value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => !withPassword && e.key === 'Enter' && email.trim() && submit()} />}
        {withPassword && <input className="search" type="password" placeholder={mode === 'new' ? 'Password (8 or more characters)' : 'Password'} autoComplete={mode === 'new' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />}
        {error && <div className="small" style={{color: 'var(--danger)'}}>{error}</div>}
        {note && <div className="small" style={{color: 'var(--ok)'}}>{note}</div>}
        {(withPassword || emailLink) && <button className="btn primary" style={{padding: 8}} disabled={!email.trim() || (withPassword && !password)} onClick={submit}>
          {withPassword ? <><LogIn size={14} /> {mode === 'in' ? 'Sign in' : 'Create account'}</> : <><Mail size={14} /> Email me a sign-in link</>}</button>}
        {mode === 'in' && !usePassword && <button className="link small" onClick={() => { setUsePassword(true); setError(''); setNote(''); }}>Use a password instead</button>}
        {mode === 'in' && usePassword && (google || emailLink) && <button className="link small" onClick={() => { setUsePassword(false); setError(''); setNote(''); }}>{emailLink ? 'Email me a sign-in link instead' : 'Back'}</button>}
        {mode === 'new' && <div className="muted small">You get your own workspace to start in. Others can invite you into theirs.</div>}
      </>}
    </AuthCard>
  );
}

/** The page a sign-in link opens. Only the button uses the link, so mail scanners that open it do not. */
export function EmailLinkSignIn({token}: {token: string}) {
  const [err, setErr] = useState('');
  const go = async () => {
    try { await api('/auth/email-link/use', {method: 'POST', body: {token}}); location.hash = '/mywork'; location.reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <AuthCard>
      <h1 style={{margin: '8px 0 4px'}}>Sign in to Cadence</h1>
      <div className="muted small">The link works once, for 15 minutes.</div>
      {err && <div className="small" style={{color: 'var(--danger)'}}>{err}</div>}
      <button className="btn primary" style={{padding: 8}} autoFocus onClick={go}><LogIn size={14} /> Sign in</button>
      {err && <a className="link small" href="#/signin">Back to sign in</a>}
    </AuthCard>
  );
}

const GoogleMark = () => <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.8 6.1C12.4 13.6 17.7 9.5 24 9.5z" /><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" /><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.8-6.1z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.8-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.4 2.2-6.3 0-11.6-4.1-13.5-9.8l-7.8 6.1C6.6 42.6 14.6 48 24 48z" /></svg>;

export function TeamPage({store, me}: {store: Store; me: Me}) {
  const [people, setPeople] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [caps, setCaps] = useState<{id: string; label: string}[]>([]);
  const [ws, setWs] = useState<{requireLogin: boolean; forced?: boolean; custom: Customization; features: Features; google: {clientId: string; hasSecret: boolean; senderEmail: string | null; connected: boolean}} | null>(null);
  const [msg, setMsg] = useState(new URLSearchParams(location.hash.split('?')[1] ?? '').get('error') ?? (location.hash.includes('connected=1') ? 'Gmail sender connected.' : location.hash.includes('linked=') ? `Google account connected: ${decodeURIComponent(location.hash.split('linked=')[1] ?? '')}` : ''));
  const [newName, setNewName] = useState('');
  const [secret, setSecret] = useState('');
  const [clientId, setClientId] = useState('');
  const load = async () => {
    const t = await api<{people: Member[]; roles: Role[]; caps: {id: string; label: string}[]}>('/team');
    setPeople(t.people); setRoles(t.roles); setCaps(t.caps);
    if (!me.admin) return;
    const w = await api<typeof ws>('/workspace'); setWs(w); setClientId(w!.google.clientId);
  };
  useEffect(() => { load().catch(store.fail); }, [store.tick]);
  const patch = async (id: string, body: Record<string, unknown>) => { try { await api(`/team/${id}`, {method: 'PATCH', body}); await load(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } };
  const saveRoles = async (r: Role[]) => { setRoles(r); try { await api('/workspace', {method: 'PUT', body: {roles: r}}); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); load(); } };
  const isAdmin = me.admin;
  const putWs = async (body: object) => { try { await api('/workspace', {method: 'PUT', body}); location.reload(); } catch (err) { setMsg(String(err instanceof Error ? err.message : err)); } };
  const redirect = `${location.origin}/api/auth/google/callback`;

  // Non-admins see only their own account; the team and its permissions are for admins.
  if (!isAdmin) {
    const self = people.find(p => p.id === me.person?.id);
    return (
      <div className="page settings">
        <h1><CircleUser size={20} /> My account</h1>
        {msg && <p className="small" style={{color: /connected/.test(msg) ? 'var(--ok)' : 'var(--danger)'}}>{msg}</p>}
        {me.account && <AccountCard me={me} />}
        {self && <section className="set-card">
          <div className="set-card-head"><h3>Password and notifications</h3></div>
          <div className="set-item">
            <span className="grow">Email me notifications</span>
            <input type="checkbox" checked={self.notifyEmail} onChange={e => patch(self.id, {notifyEmail: e.target.checked})} />
          </div>
          <div className="set-item">
            <span className="grow">Password</span>
            <SetPassword has={self.hasPassword} self={me.required} disabled={false} onSet={(pw, cur) => patch(self.id, {password: pw, currentPassword: cur})} />
          </div>
        </section>}
        {me.person && <GoogleCard me={me.person.id} ready={me.googleReady} />}
        {self && <TokensCard people={[self]} admin={false} me={self.id} />}
      </div>
    );
  }

  return (
    <div className="page settings">
      <h1><Shield size={20} /> Team and permissions</h1>
      {msg && <p className="small" style={{color: /connected/.test(msg) ? 'var(--ok)' : 'var(--danger)'}}>{msg}</p>}

      {me.account && <AccountCard me={me} />}
      {me.owner && <section className="set-card">
        <div className="set-card-head"><h3>Server</h3><span className="muted small">You set this server up, so you decide who can create an account.</span></div>
        <div className="set-item"><span className="grow">Who can create an account</span>
          <select className="plain-select" defaultValue={me.signup ?? 'invite'} onChange={async e => { try { await api('/auth/server', {method: 'PUT', body: {signup: e.target.value}}); setMsg('Saved.'); } catch (err) { setMsg(String(err instanceof Error ? err.message : err)); } }}>
            <option value="invite">Only people invited to a workspace</option>
            <option value="open">Anyone (they get their own workspace)</option>
          </select></div>
        <div className="muted small">Sign-in links and invites are emailed over SMTP when the server has it (SMTP_HOST), else through the Gmail sender connected below. Without either, sign-in links are printed in the server log.</div>
      </section>}

      {isAdmin && <InvitesCard roles={roles} signInOn={!!ws?.requireLogin} />}
      <section className="set-card">
        <div className="set-card-head"><h3>People</h3><span className="muted small">Default role applies in every space unless the space sets its own. Admins can do everything.</span></div>
        {people.map(p => (
          <div key={p.id} className={'set-item team-row' + (p.active ? '' : ' off')}>
            <Avatar person={{id: p.id, name: p.name, email: p.email, color: p.color}} size={26} />
            <div className="grow" style={{minWidth: 140}}>
              <input className="inline" defaultValue={p.name} disabled={!isAdmin} onBlur={e => e.target.value !== p.name && patch(p.id, {name: e.target.value})} />
              <input className="inline small" placeholder="email for sign-in" defaultValue={p.email} disabled={!isAdmin && p.id !== me.person?.id} onBlur={e => e.target.value !== p.email && patch(p.id, {email: e.target.value})} />
            </div>
            <select className="plain-select" value={p.kind} disabled={!isAdmin} onChange={e => patch(p.id, {kind: e.target.value})} title="Human or AI worker"><option value="human">Human</option><option value="ai">AI agent</option></select>
            <select className="plain-select" value={p.role} disabled={!isAdmin} onChange={e => patch(p.id, {role: e.target.value})} title="Default role">
              {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <label className="small" title="Workspace admin"><input type="checkbox" checked={p.admin} disabled={!isAdmin} onChange={e => patch(p.id, {admin: e.target.checked})} /> Admin</label>
            <label className="small" title="Email me notifications"><input type="checkbox" checked={p.notifyEmail} disabled={!isAdmin && p.id !== me.person?.id} onChange={e => patch(p.id, {notifyEmail: e.target.checked})} /> Email</label>
            <SetPassword has={p.hasPassword} self={p.id === me.person?.id && me.required} disabled={!isAdmin && p.id !== me.person?.id} onSet={(pw, cur) => patch(p.id, {password: pw, currentPassword: cur})} />
            <label className="small" title="Inactive people cannot sign in"><input type="checkbox" checked={p.active} disabled={!isAdmin || p.id === me.person?.id} onChange={e => patch(p.id, {active: e.target.checked})} /> Active</label>
          </div>
        ))}
        {isAdmin && <div className="set-add"><Plus size={14} className="muted" /><input className="inline" placeholder="Add a person, Enter" value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={async e => { if (e.key === 'Enter' && newName.trim()) { await store.createPerson(newName); setNewName(''); load(); } }} /></div>}
      </section>

      <section className="set-card">
        <div className="set-card-head"><h3>Roles and what they can do</h3><span className="muted small">Tick what each role may do. Spaces can give a person a different role there.</span></div>
        <div className="role-grid" style={{gridTemplateColumns: `200px repeat(${roles.length}, minmax(90px, 1fr)) 30px`}}>
          <div />
          {roles.map(r => <div key={r.id} className="role-head">
            <input className="inline" value={r.name} disabled={!isAdmin || r.id === 'admin'} onChange={e => setRoles(roles.map(x => x.id === r.id ? {...x, name: e.target.value} : x))} onBlur={() => saveRoles(roles)} />
            {isAdmin && !['admin', 'editor', 'viewer'].includes(r.id) && <button className="icon" title="Delete role" onClick={() => saveRoles(roles.filter(x => x.id !== r.id))}><Trash2 size={12} /></button>}
          </div>)}
          <div />
          {caps.map(c => <RoleRow key={c.id} cap={c} roles={roles} disabled={!isAdmin} onToggle={(rid, on) => saveRoles(roles.map(r => r.id === rid ? {...r, caps: on ? [...r.caps, c.id] : r.caps.filter(x => x !== c.id)} : r))} />)}
        </div>
        {isAdmin && <button className="btn" style={{marginTop: 8}} onClick={() => saveRoles([...roles, {id: 'role-' + Math.random().toString(36).slice(2, 7), name: 'New role', caps: ['view', 'comment']}])}><Plus size={14} /> New role</button>}
      </section>

      {ws && <section className="set-card">
        <div className="set-card-head"><h3>Customization</h3><span className="muted small">The team setup is what everyone starts from. Choose who changes each part, and which features are on.</span></div>
        {AREAS.map(([k, label, hint]) => (
          <div key={k} className="set-item">
            <span className="grow"><b>{label}</b> <span className="muted small">{hint}</span></span>
            <select className="plain-select" value={ws.custom[k]} disabled={!isAdmin} onChange={e => putWs({custom: {...ws.custom, [k]: e.target.value}})}>
              {POLICIES.map(([p, l]) => <option key={p} value={p}>{l}</option>)}
            </select>
          </div>
        ))}
        <div className="muted small">Each person: everyone can arrange things their own way (saved for them); a bar on the view lets them save it for everyone or go back to the team view.</div>
        <div className="feature-grid">
          {(Object.keys(FEATURE_LABELS) as (keyof Features)[]).map(k => (
            <label key={k} className="small"><input type="checkbox" checked={ws.features[k]} disabled={!isAdmin}
              onChange={e => putWs({features: {...ws.features, [k]: e.target.checked}})} /> {FEATURE_LABELS[k]}</label>
          ))}
        </div>
      </section>}

      {me.person && <GoogleCard me={me.person.id} ready={!!ws?.google.clientId && !!ws?.google.hasSecret} />}
      <TokensCard people={people} admin={isAdmin} me={me.person?.id ?? null} />

      {ws && <section className="set-card">
        <div className="set-card-head"><h3><KeyRound size={15} /> Sign in</h3><span className="muted small">Off: anyone on this computer picks who they are (fine while it runs only on your machine). On: everyone signs in and permissions are enforced.</span></div>
        <label className="set-item" style={{gap: 8}}>
          <input type="checkbox" checked={ws.requireLogin} disabled={!isAdmin || ws.forced} title={ws.forced ? 'This server requires sign-in for every workspace' : undefined} onChange={async e => {
            try { await api('/workspace', {method: 'PUT', body: {requireLogin: e.target.checked}}); location.reload(); } catch (err) { setMsg(err instanceof Error ? err.message : String(err)); }
          }} />
          <span className="grow">Require sign in</span>
          {!ws.requireLogin && <span className="muted small">Set your own email and password above first.</span>}
        </label>
        {ws.requireLogin && <button className="btn" onClick={async () => { await api('/auth/logout', {method: 'POST'}); location.reload(); }}>Sign out</button>}
      </section>}

      {ws && isAdmin && <section className="set-card google-card">
        <div className="set-card-head"><h3><GoogleMark /> Google and Gmail</h3><span className="muted small">Sends notification emails through one connected Gmail account and lets people connect their own calendars and Gmail. Signing in with Google is set up on the server (GOOGLE_CLIENT_ID).</span></div>
        <ol className="small steps">
          <li>In Google Cloud console, create an OAuth client of type Web application.</li>
          <li>Add this authorized redirect URI: <code>{redirect}</code> <button className="icon" onClick={() => navigator.clipboard.writeText(redirect)}><Copy size={12} /></button></li>
          <li>Enable the Gmail API for that space if you want email notifications.</li>
          <li>Paste the client ID and secret here.</li>
        </ol>
        <div className="set-add" style={{flexWrap: 'wrap'}}>
          <input className="plain-select" style={{flex: 2, minWidth: 220}} placeholder="Client ID" value={clientId} onChange={e => setClientId(e.target.value)} />
          <input className="plain-select" style={{flex: 1, minWidth: 160}} type="password" placeholder={ws.google.hasSecret ? 'Secret saved (enter to replace)' : 'Client secret'} value={secret} onChange={e => setSecret(e.target.value)} />
          <button className="btn primary" onClick={async () => { try { await api('/workspace', {method: 'PUT', body: {google: {clientId, ...(secret ? {clientSecret: secret} : {})}}}); setSecret(''); setMsg('Saved.'); load(); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } }}>Save</button>
        </div>
        <div className="set-item">
          <span className="grow small">{ws.google.connected ? <><CheckIcon size={13} /> Emails send from {ws.google.senderEmail}</> : 'No Gmail sender connected. Notifications show in the Inbox only.'}</span>
          <a className={'btn' + (ws.google.clientId && ws.google.hasSecret ? '' : ' disabled')} href="/api/auth/google/start?mode=connect">{ws.google.connected ? 'Reconnect' : 'Connect Gmail sender'}</a>
        </div>
        <div className="muted small">People tick Email above to get notifications by email.</div>
      </section>}
    </div>
  );
}

function RoleRow({cap, roles, disabled, onToggle}: {cap: {id: string; label: string}; roles: Role[]; disabled: boolean; onToggle: (role: string, on: boolean) => void}) {
  return <>
    <div className="role-cap small">{cap.label}</div>
    {roles.map(r => <div key={r.id} className="role-cell"><input type="checkbox" checked={r.caps.includes(cap.id)} disabled={disabled || r.id === 'admin'} onChange={e => onToggle(r.id, e.target.checked)} /></div>)}
    <div />
  </>;
}

function SetPassword({has, self, disabled, onSet}: {has: boolean; self: boolean; disabled: boolean; onSet: (pw: string, current?: string) => void}) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [cur, setCur] = useState('');
  const needCur = self && has;
  if (!open) return <button className="btn ghost small" disabled={disabled} onClick={() => setOpen(true)}><KeyRound size={12} /> {has ? 'Change password' : 'Set password'}</button>;
  return <span style={{display: 'inline-flex', gap: 4}}>
    {needCur && <input className="plain-select" type="password" placeholder="current" style={{width: 100}} value={cur} onChange={e => setCur(e.target.value)} />}
    <input autoFocus className="plain-select" type="password" placeholder="8+ characters" style={{width: 120}} value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && pw.length >= 8) { onSet(pw, cur || undefined); setPw(''); setCur(''); setOpen(false); } if (e.key === 'Escape') setOpen(false); }} />
    <button className="btn small" disabled={pw.length < 8} onClick={() => { onSet(pw, cur || undefined); setPw(''); setCur(''); setOpen(false); }}>Save</button>
  </span>;
}

/** Project settings card: who can do what in this project. */
export function AccessCard({store, project}: {store: Store; project: Project}) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [admin, setAdmin] = useState(false);
  useEffect(() => { api<{roles: Role[]}>('/team').then(t => setRoles(t.roles)).catch(() => {}); api<Me>('/auth/me').then(m => setAdmin(m.admin)).catch(() => {}); }, []);
  const access = project.settings.access ?? {default: 'inherit', members: {}};
  const save = (a: typeof access) => store.updateProject(project.id, {settings: {...project.settings, access: a}});
  const options = <>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}<option value="none">No access</option></>;
  return (
    <section className="set-card">
      <div className="set-card-head"><h3><Shield size={15} /> Access</h3><span className="muted small">Who can see and change this project. Enforced once sign-in is required (Team page). Only admins can change this.</span></div>
      <div className="set-item">
        <span className="grow">Everyone else</span>
        <select className="plain-select" value={access.default} disabled={!admin} onChange={e => save({...access, default: e.target.value})}>
          <option value="inherit">Their default role</option>{options}
        </select>
      </div>
      {store.people.map(p => (
        <div key={p.id} className="set-item">
          <Avatar person={p} size={22} /><span className="grow">{p.name}</span>
          <select className="plain-select" value={access.members[p.id] ?? ''} disabled={!admin} onChange={e => { const m = {...access.members}; if (e.target.value) m[p.id] = e.target.value; else delete m[p.id]; save({...access, members: m}); }}>
            <option value="">Same as everyone else</option>{options}
          </select>
        </div>
      ))}
    </section>
  );
}

/** API tokens: how AI agents and other systems sign in. Each acts as one person with that person's role. */
function TokensCard({people, admin, me}: {people: Member[]; admin: boolean; me: string | null}) {
  const [tokens, setTokens] = useState<{id: string; person: string; name: string; created: string; lastUsed: string | null}[]>([]);
  const [who, setWho] = useState(people.find(p => p.kind === 'ai')?.id ?? me ?? '');
  const [name, setName] = useState('Claude');
  const [fresh, setFresh] = useState<string | null>(null);
  const load = () => api<typeof tokens>('/tokens').then(setTokens).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!who && people.length) setWho(people.find(p => p.kind === 'ai')?.id ?? people[0].id); }, [people]);
  const mcpUrl = `${location.origin}/mcp?ws=${wsId()}`;
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>AI agents and tokens</h3><span className="muted small">An AI agent is a person marked AI agent above, with the role you choose. Give it a token; it can then use the API or MCP and do only what its role allows.</span></div>
      <div className="set-add" style={{flexWrap: 'wrap'}}>
        <select className="plain-select" value={who} onChange={e => setWho(e.target.value)}>{people.filter(p => admin || p.id === me).map(p => <option key={p.id} value={p.id}>{p.name}{p.kind === 'ai' ? ' (AI)' : ''}</option>)}</select>
        <input className="plain-select" style={{flex: 1, minWidth: 140}} placeholder="Token name, e.g. Claude Desktop" value={name} onChange={e => setName(e.target.value)} />
        <button className="btn primary" disabled={!who} onClick={async () => { const r = await api<{token: string}>('/tokens', {method: 'POST', body: {person: who, name}}); setFresh(r.token); load(); }}>Create token</button>
      </div>
      {fresh && <div className="token-once">
        <b>Copy this token now. It will not be shown again.</b>
        <pre className="code">{fresh}</pre>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(fresh)}><Copy size={12} /> Copy</button>
        <div className="small muted" style={{marginTop: 8}}>Connect an AI app with MCP over HTTP: URL <code>{mcpUrl}</code>, header <code>Authorization: Bearer {fresh.slice(0, 8)}...</code>. Or call the REST API with the same header. The agent should start with the get_guide tool.</div>
      </div>}
      {tokens.map(t => (
        <div key={t.id} className="set-item">
          <span className="grow small"><b>{t.name}</b> for {people.find(p => p.id === t.person)?.name ?? 'unknown'}</span>
          <span className="muted small">{t.lastUsed ? `used ${new Date(t.lastUsed).toLocaleString()}` : 'never used'}</span>
          <button className="btn ghost small" onClick={async () => { if (confirm(`Revoke "${t.name}"? Anything using it stops working.`)) { await api(`/tokens/${t.id}`, {method: 'DELETE'}); load(); } }}><Trash2 size={12} /> Revoke</button>
        </div>
      ))}
    </section>
  );
}

type Invite = {id: string; email: string; role: string; created: string; expires: string; link?: string; emailed?: boolean};
/** Invite people by email into this workspace. The link works once and for 7 days. */
function InvitesCard({roles, signInOn}: {roles: Role[]; signInOn: boolean}) {
  const [list, setList] = useState<Invite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [last, setLast] = useState<Invite | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Invite[]>('/invites').then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const send = async () => {
    setErr('');
    try { const inv = await api<Invite>('/invites', {method: 'POST', body: {email, role}}); setLast(inv); setEmail(''); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Invite people</h3><span className="muted small">They get a one-time link (7 days) to join with their name, then land in this workspace with the role you pick. The link is emailed when the server can send mail; you can always copy it and send it yourself.
        {!signInOn && ' Sign-in is off right now, so passwords take effect once you turn it on.'}</span></div>
      <div className="time-row">
        <input className="inline" style={{flex: 1}} placeholder="name@company.com" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && email.trim() && send()} />
        <select className="plain-select" value={role} onChange={e => setRole(e.target.value)}>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <button className="btn primary" disabled={!email.trim()} onClick={send}><Plus size={14} /> Invite</button>
      </div>
      {err && <div className="small" style={{color: 'var(--danger)'}}>{err}</div>}
      {last?.link && <div className="invite-link">
        <span className="small">{last.emailed ? `Emailed to ${last.email}. ` : ''}Link for {last.email}:</span>
        <code>{last.link}</code>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(last.link!)}>Copy</button>
      </div>}
      {list.length > 0 && <><div className="pop-label">Waiting to join</div>
        {list.map(i => <div key={i.id} className="set-item"><span className="grow">{i.email}</span><span className="muted small">{roles.find(r => r.id === i.role)?.name ?? i.role}, expires {new Date(i.expires).toLocaleDateString()}</span>
          <button className="btn ghost small" onClick={async () => { await api(`/invites/${i.id}`, {method: 'DELETE'}); load(); }}>Revoke</button></div>)}</>}
    </section>
  );
}

/** The page an invite link opens: shows where you are joining, then name and password (or Google). */
export function AcceptInvite({secret}: {secret: string}) {
  const [info, setInfo] = useState<{email: string; name: string | null; role: string; workspace: string; invitedBy: string | null; hasAccount: boolean; hasPassword: boolean; signedIn: boolean; staff: boolean; passwordless: boolean} | null>(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [addPw, setAddPw] = useState(false);
  useEffect(() => { api<NonNullable<typeof info>>(`/invites/${secret}`).then(i => { setInfo(i); setName(i.name ?? ''); setAddPw(!i.passwordless); }).catch(e => setErr(e instanceof Error ? e.message : String(e))); }, [secret]);
  const join = async () => {
    if (!info?.hasAccount && addPw && pw !== pw2) return setErr('The two passwords do not match');
    try {
      const r = await api<{google?: boolean}>(`/invites/${secret}/accept`, {method: 'POST', body: {name, password: pw}});
      if (r.google) { location.href = '/auth/google/start'; return; }
      location.hash = '/mywork'; location.reload();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  // An existing account joins signed in as itself, or with its password; staff accounts sign in with Google first.
  const needSignIn = !!info?.hasAccount && !info.signedIn && (!info.hasPassword || info.staff);
  const needPw = !!info?.hasAccount && !info.signedIn && !needSignIn;
  const ready = !!name.trim() && !needSignIn && (needPw ? pw.length >= 8 : !addPw || pw.length >= 8);
  return (
    <AuthCard>
        {info ? <>
          <h1 style={{margin: '8px 0 4px'}}>Join {info.workspace}</h1>
          <div className="muted small">{info.invitedBy ? `${info.invitedBy} invited ` : 'You were invited as '}<b>{info.email}</b> as {info.role}.</div>
          <input className="search" placeholder="Your name" autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && ready && join()} />
          {needSignIn && <div className="muted small">You already have a Cadence account on this server. <a className="link" href="#/signin">Sign in</a> first, then open this link again.</div>}
          {needPw && <>
            <div className="muted small">You already have a Cadence account on this server. Enter its password to join, or sign in first and open this link again.</div>
            <input className="search" type="password" placeholder="Your password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && ready && join()} />
          </>}
          {!info.hasAccount && info.staff && <div className="muted small">Next you sign in with your Google account.</div>}
          {!info.hasAccount && !info.staff && (addPw ? <>
            <input className="search" type="password" placeholder={info.passwordless ? 'Password (optional, 8 or more characters)' : 'Choose a password (8 or more characters)'} autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} />
            <input className="search" type="password" placeholder="Type it again" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} onKeyDown={e => e.key === 'Enter' && ready && join()} />
          </> : <div className="muted small">No password needed: you sign in with an emailed link or Google. <button className="link small" onClick={() => setAddPw(true)}>Add a password (optional)</button></div>)}
          {err && <div className="small" style={{color: 'var(--danger)'}}>{err}</div>}
          <button className="btn primary" style={{width: '100%', justifyContent: 'center', padding: 8}} disabled={!ready} onClick={join}><LogIn size={14} /> Join workspace</button>
        </> : <>
          <h1 style={{margin: '8px 0 4px'}}>Invite</h1>
          <div className="small" style={{color: err ? 'var(--danger)' : undefined}}>{err || 'Checking your invite...'}</div>
        </>}
    </AuthCard>
  );
}

type GLink = {id: string; email: string; scopes: string; created: string};
/** Your own Google accounts: calendars (read and add events) and, if you allow it, Gmail (read). With test buttons. */
function GoogleCard({me, ready}: {me: string; ready: boolean}) {
  const [links, setLinks] = useState<GLink[]>([]);
  const [out, setOut] = useState<{title: string; rows: string[]} | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<GLink[]>('/google/links').then(setLinks).catch(() => {});
  useEffect(() => { load(); }, []);
  const start = (want: string) => `/api/auth/google/start?mode=link&want=${want}&as=${encodeURIComponent(me)}`;
  const run = async (title: string, f: () => Promise<string[]>) => {
    setBusy(true);
    try { const rows = await f(); setOut({title, rows: rows.length ? rows : ['Nothing found.']}); } catch (e) { setOut({title, rows: [`Failed: ${e instanceof Error ? e.message : e}`]}); }
    setBusy(false);
  };
  const today = new Date().toISOString().slice(0, 10), week = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>My Google accounts</h3><span className="muted small">Connect one or more Google accounts to see your calendars next to your tasks, add due dates to a calendar, and (if you allow it) let you and your AI agents search your Gmail. Only you see your own connections.</span></div>
      {!ready && <p className="small">An admin needs to add the Google OAuth client first (Google and Gmail section on this page). In Google Cloud, enable the Google Calendar API and Gmail API for that client and add this redirect URI: <code>{location.origin}/api/auth/google/callback</code></p>}
      <div className="time-row">
        <a className={'btn primary' + (ready ? '' : ' disabled')} href={ready ? start('calendar') : undefined}>Connect Google Calendar</a>
        <a className={'btn' + (ready ? '' : ' disabled')} href={ready ? start('calendar,gmail') : undefined}>Connect Calendar and Gmail</a>
      </div>
      {links.map(l => (
        <div key={l.id} className="set-item">
          <span className="grow"><b>{l.email}</b> {l.scopes.includes('calendar') && <span className="tag">Calendar</span>} {l.scopes.includes('gmail') && <span className="tag">Gmail</span>}</span>
          {l.scopes.includes('calendar') && <button className="btn small" disabled={busy} onClick={() => run(`Calendars in ${l.email}`, async () => (await api<{name: string; primary: boolean; canWrite: boolean}[]>(`/google/calendars?link=${l.id}`)).map(c => `${c.name}${c.primary ? ' (primary)' : ''}${c.canWrite ? '' : ', read only'}`))}>Test: list calendars</button>}
          {l.scopes.includes('gmail') && <button className="btn small" disabled={busy} onClick={() => run(`Newest mail in ${l.email}`, async () => (await api<{subject: string; from: string; date: string}[]>(`/google/gmail?link=${l.id}&q=in:inbox&max=5`)).map(m => `${m.subject || '(no subject)'}, from ${m.from}`))}>Test: read 5 emails</button>}
          <button className="btn ghost small" onClick={async () => { await api(`/google/links/${l.id}`, {method: 'DELETE'}); load(); }}>Disconnect</button>
        </div>
      ))}
      {links.some(l => l.scopes.includes('calendar')) && <button className="btn small" disabled={busy} onClick={() => run('Your events in the next 7 days', async () => (await api<{title: string; start: string; account: string}[]>(`/google/events?from=${today}&to=${week}`)).map(e => `${e.start.replace('T', ' ').slice(0, 16)}  ${e.title}  (${e.account})`))}>Test: events in the next 7 days</button>}
      {out && <div className="g-out"><b className="small">{out.title}</b>{out.rows.slice(0, 20).map((r, n) => <div key={n} className="small">{r}</div>)}</div>}
    </section>
  );
}

/** Your sign-in, and other accounts of yours (say work and personal) linked so one sign-in shows all their workspaces. */
function AccountCard({me}: {me: Me}) {
  const [linked, setLinked] = useState(me.linked ?? []);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  const link = async () => {
    try { const r = await api<{linked: string[]}>('/auth/link', {method: 'POST', body: {email, password: pw}}); setLinked(r.linked); setEmail(''); setPw(''); setMsg('Linked. Its workspaces are in the switcher and on Everything.'); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  const unlink = async (e: string) => { if (!confirm(`Unlink ${e}? Its workspaces leave this sign-in; the account itself stays.`)) return; const r = await api<{linked: string[]}>(`/auth/link/${encodeURIComponent(e)}`, {method: 'DELETE'}); setLinked(r.linked); };
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Your account</h3><span className="muted small">Signed in as <b>{me.account}</b>. Link your other accounts (for example a personal email) to see all their workspaces with one sign-in.</span></div>
      {linked.map(e => <div key={e} className="set-item"><span className="grow">{e}</span><button className="btn ghost small" onClick={() => unlink(e)}>Unlink</button></div>)}
      <div className="set-item" style={{gap: 6, flexWrap: 'wrap'}}>
        <input className="search" style={{flex: '1 1 200px'}} placeholder="Other account's email" value={email} onChange={e => setEmail(e.target.value)} />
        <input className="search" style={{flex: '1 1 160px'}} type="password" placeholder="Its password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && link()} />
        <button className="btn" disabled={!email.trim() || !pw} onClick={link}>Link account</button>
      </div>
      {msg && <div className="small muted">{msg}</div>}
    </section>
  );
}
