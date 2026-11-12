// Sign-in page, Team page (people, roles and their permissions, sign-in and Google), and per-project access.
import {AREAS, POLICIES} from './customize.ts';
import {useEffect, useState} from 'react';
import {Check as CheckIcon, CircleUser, Copy, KeyRound, Mail, Plus, Shield, Trash2} from 'lucide-react';
import {FEATURE_LABELS, type Customization, type Features, type Project} from './types.ts';
import {api, type Store, switchWorkspace, wsId} from './store.ts';
import {Avatar} from './components.tsx';
import {ConnectedAppsCard, pendingConnect} from './ConnectedApps.tsx';
import {DomainJoinCard, JobRolePicker, JobRolesCard, jobRoleNames, type DomainJoin, type JobRole} from './JobRoles.tsx';

type Cap = string;
type Role = {id: string; name: string; caps: Cap[]};
type Member = {id: string; name: string; email: string; color: string; role: string; admin: boolean; active: boolean; notifyEmail: boolean; hasPassword: boolean; kind: 'human' | 'ai'; jobRoles: string[]};
export type Me = {required: boolean; forced?: boolean; account?: string | null; linked?: string[]; signup?: 'open' | 'invite'; memberWorkspaces?: 'on' | 'off'; owner?: boolean; setup?: boolean; memberOf?: {id: string; name: string}[];
  person: {id: string; name: string} | null; admin: boolean; googleReady: boolean; signInGoogle?: boolean; signInLink?: boolean; caps: Record<string, string[]>};

/** The card every sign-in screen sits in: the Nursetech logo, the form, and a short footer. */
function AuthCard({children, help = true}: {children: React.ReactNode; help?: boolean}) {
  return (
    <div className="signin">
      <main className="signin-card">
        <img className="signin-logo" src="/nursetech-logo.png" alt="Nursetech Medical" height={44} />
        {children}
      </main>
      <footer className="signin-foot">{help && <span>Need access? Ask an admin for an invite.</span>}<span>Nursetech Medical</span></footer>
    </div>
  );
}
type InputProps = React.InputHTMLAttributes<HTMLInputElement>;
/** A labeled input on the sign-in screens. */
const Field = ({label, ...p}: {label: string} & InputProps) => <label className="signin-field"><span>{label}</span><input {...p} /></label>;
const AuthError = ({msg}: {msg: string}) => msg ? <div className="signin-error" role="alert">{msg}</div> : null;
/** A full-width button that shows a spinner and is disabled while its request runs. */
function AuthButton({busy, busyText, ghost, children, ...p}: {busy?: boolean; busyText?: string; ghost?: boolean} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...p} className={'signin-btn' + (ghost ? ' ghost' : '')} disabled={p.disabled || busy} aria-busy={busy || undefined}>
    {busy ? <><span className="signin-spin" aria-hidden="true" />{busyText ?? children}</> : children}</button>;
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** First run of a hosted server: create the owner account. It becomes admin of every workspace. */
export function SetupServer() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setErr('The two passwords do not match');
    setErr(''); setBusy(true);
    try { await api('/auth/setup', {method: 'POST', body: {name, email, password: pw}}); location.hash = '/mywork'; location.reload(); }
    catch (e) { setErr(message(e)); setBusy(false); }
  };
  return (
    <AuthCard help={false}>
      <h1>Set up this server</h1>
      <p className="signin-sub">Create the owner account. It becomes admin of every workspace here. Invite everyone else from the Team page.</p>
      <form className="signin-form" onSubmit={go}>
        <Field label="Your name" autoFocus autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
        <Field label="Email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
        <Field label="Password (8 or more characters)" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} />
        <Field label="Type it again" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} />
        <AuthError msg={err} />
        <AuthButton type="submit" busy={busy} busyText="Creating account..." disabled={!email.trim() || pw.length < 8}>Create account</AuthButton>
      </form>
    </AuthCard>
  );
}

/** Signed in, but not a member of this workspace: go to one you belong to, or sign out. */
export function NoAccess({me}: {me: Me}) {
  const list = me.memberOf ?? [];
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (list.length === 1) switchWorkspace(list[0].id); }, [list]);
  return (
    <AuthCard>
      <h1>{list.length ? 'Pick a workspace' : 'No workspace yet'}</h1>
      <p className="signin-sub">Signed in as <b>{me.account}</b>. {list.length ? 'You are not a member of this one.' : 'Ask an admin to invite this email.'}</p>
      <div className="signin-form">
        {list.map(w => <AuthButton key={w.id} onClick={() => switchWorkspace(w.id)}>{w.name}</AuthButton>)}
        <AuthButton ghost busy={busy} busyText="Signing out..." onClick={async () => { setBusy(true); await api('/auth/logout', {method: 'POST'}); location.reload(); }}>Sign out</AuthButton>
      </div>
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
  const [busy, setBusy] = useState(false);
  const [toGoogle, setToGoogle] = useState(false);
  const [sent, setSent] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(''); setBusy(true);
    try {
      if (mode === 'new') { const r = await api<{workspace: string}>('/auth/signup', {method: 'POST', body: {name, email, password}}); switchWorkspace(r.workspace); return; }
      if (usePassword) { await api('/auth/login', {method: 'POST', body: {email, password}}); location.hash = '/mywork'; location.reload(); return; }
      await api('/auth/email-link', {method: 'POST', body: {email}});
      setSent(email.trim());
    } catch (e) { setError(message(e)); }
    setBusy(false);
  };
  const switchTo = (m: typeof mode, pw = usePassword) => { setMode(m); setUsePassword(pw); setError(''); };
  const sub = google && emailLink ? 'Use your Nursetech Google account, or get a sign-in link by email.'
    : google ? 'Use your Nursetech Google account.' : emailLink ? 'Get a sign-in link by email.' : 'Sign in with your email and password.';
  const form = usePassword || emailLink;

  if (sent) return (
    <AuthCard>
      <div className="signin-sent-icon"><Mail size={24} /></div>
      <h1>Check your email</h1>
      <p className="signin-sub">If there is an account for <b>{sent}</b>, a sign-in link is on its way.</p>
      <p className="signin-sub">The link works once, for 15 minutes.</p>
      <button type="button" className="signin-link" onClick={() => setSent('')}>Use a different email</button>
    </AuthCard>
  );
  if (mode === 'new') return (
    <AuthCard>
      <h1>Create your account</h1>
      <p className="signin-sub">You get your own workspace to start in. Others can invite you into theirs.</p>
      <form className="signin-form" onSubmit={submit}>
        <Field label="Your name" autoFocus autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
        <Field label="Email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
        <Field label="Password (8 or more characters)" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
        <AuthError msg={error} />
        <AuthButton type="submit" busy={busy} busyText="Creating account..." disabled={!email.trim() || password.length < 8}>Create account</AuthButton>
      </form>
      <button type="button" className="signin-link" onClick={() => switchTo('in')}>Back to sign in</button>
    </AuthCard>
  );
  return (
    <AuthCard>
      <h1>Sign in to Cadence</h1>
      <p className="signin-sub">{sub}</p>
      {pendingConnect() && <p className="signin-note">Sign in to finish connecting your AI app to Cadence.</p>}
      {!form && <AuthError msg={error} />}
      {google && <a className={'signin-google' + (toGoogle ? ' busy' : '')} href="/auth/google/start" aria-busy={toGoogle || undefined} onClick={() => setToGoogle(true)}>
        {toGoogle ? <span className="signin-spin dark" aria-hidden="true" /> : <GoogleMark size={18} />} {toGoogle ? 'Opening Google...' : 'Continue with Google'}</a>}
      {google && form && <div className="signin-or"><span>or</span></div>}
      {form && <form className="signin-form" onSubmit={submit}>
        <Field label="Email" type="email" autoComplete="username" autoFocus={!google} value={email} onChange={e => setEmail(e.target.value)} />
        {usePassword && <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />}
        <AuthError msg={error} />
        <AuthButton type="submit" busy={busy} busyText={usePassword ? 'Signing in...' : 'Sending link...'} disabled={!email.trim() || (usePassword && !password)}>
          {usePassword ? 'Sign in' : 'Email me a sign-in link'}</AuthButton>
      </form>}
      {(google || emailLink) && <button type="button" className="signin-link" onClick={() => switchTo('in', !usePassword)}>
        {!usePassword ? 'Use a password instead' : emailLink ? 'Email me a sign-in link instead' : 'Hide password sign-in'}</button>}
      {signup === 'open' && <button type="button" className="signin-link" onClick={() => switchTo('new')}>Create an account</button>}
    </AuthCard>
  );
}

/** The page a sign-in link opens. Only the button uses the link, so mail scanners that open it do not. */
export function EmailLinkSignIn({token}: {token: string}) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setErr(''); setBusy(true);
    try { await api('/auth/email-link/use', {method: 'POST', body: {token}}); location.hash = '/mywork'; location.reload(); }
    catch (e) { setErr(message(e)); setBusy(false); }
  };
  return (
    <AuthCard>
      <h1>Sign in to Cadence</h1>
      <p className="signin-sub">Press the button to finish signing in. The link works once, for 15 minutes.</p>
      <div className="signin-form">
        <AuthError msg={err} />
        <AuthButton autoFocus busy={busy} busyText="Signing in..." onClick={go}>Sign in</AuthButton>
      </div>
      {err && <a className="signin-link" href="#/signin">Back to sign in</a>}
    </AuthCard>
  );
}

const GoogleMark = ({size = 16}: {size?: number}) => <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.8 6.1C12.4 13.6 17.7 9.5 24 9.5z" /><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" /><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.8-6.1z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.8-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.4 2.2-6.3 0-11.6-4.1-13.5-9.8l-7.8 6.1C6.6 42.6 14.6 48 24 48z" /></svg>;

export function TeamPage({store, me}: {store: Store; me: Me}) {
  const [people, setPeople] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [caps, setCaps] = useState<{id: string; label: string}[]>([]);
  const [jobRoles, setJobRoles] = useState<JobRole[] | null>(null);
  const [domainJoin, setDomainJoin] = useState<DomainJoin | null>(null);
  const [ws, setWs] = useState<{requireLogin: boolean; forced?: boolean; custom: Customization; features: Features; google: {clientId: string; hasSecret: boolean; senderEmail: string | null; connected: boolean}} | null>(null);
  const [msg, setMsg] = useState(new URLSearchParams(location.hash.split('?')[1] ?? '').get('error') ?? (location.hash.includes('connected=1') ? 'Gmail sender connected.' : location.hash.includes('linked=') ? `Google account connected: ${decodeURIComponent(location.hash.split('linked=')[1] ?? '')}` : ''));
  const [newName, setNewName] = useState('');
  const [secret, setSecret] = useState('');
  const [clientId, setClientId] = useState('');
  const load = async () => {
    const t = await api<{people: Member[]; roles: Role[]; caps: {id: string; label: string}[]; jobRoles?: JobRole[]; domainJoin?: DomainJoin}>('/team');
    setPeople(t.people); setRoles(t.roles); setCaps(t.caps); setJobRoles(t.jobRoles ?? []); if (t.domainJoin) setDomainJoin(t.domainJoin);
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
      {me.person && <MyDataCard />}
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
        {me.person && <AgentsCard />}
        {me.account && <ConnectedAppsCard />}
        {self && <TokensCard people={[self]} admin={false} me={self.id} />}
        {me.person && <MyDataCard />}
      </div>
    );
  }

  return (
    <div className="page settings">
      <h1><Shield size={20} /> Team and permissions</h1>
      {msg && <p className="small" style={{color: /connected/.test(msg) ? 'var(--ok)' : 'var(--danger)'}}>{msg}</p>}

      {me.account && <AccountCard me={me} />}
      {me.person && <MyDataCard />}
      {me.owner && <section className="set-card">
        <div className="set-card-head"><h3>Server</h3><span className="muted small">You set this server up, so you decide who can create an account.</span></div>
        <div className="set-item"><span className="grow">Who can create an account</span>
          <select className="plain-select" defaultValue={me.signup ?? 'invite'} onChange={async e => { try { await api('/auth/server', {method: 'PUT', body: {signup: e.target.value}}); setMsg('Saved.'); } catch (err) { setMsg(String(err instanceof Error ? err.message : err)); } }}>
            <option value="invite">Only people invited to a workspace</option>
            <option value="open">Anyone (they get their own workspace)</option>
          </select></div>
        <div className="set-item"><span className="grow">Members can add their own workspaces <span className="muted small">Only they are in it until they invite people. Admins of other workspaces cannot see into it.</span></span>
          <select className="plain-select" defaultValue={me.memberWorkspaces ?? 'on'} onChange={async e => { try { await api('/auth/server', {method: 'PUT', body: {memberWorkspaces: e.target.value}}); setMsg('Saved.'); } catch (err) { setMsg(String(err instanceof Error ? err.message : err)); } }}>
            <option value="on">Yes</option><option value="off">No, admins only</option>
          </select></div>
        <div className="muted small">Sign-in links and invites are emailed over SMTP when the server has it (SMTP_HOST), else through the Gmail sender connected below. Without either, sign-in links are printed in the server log.</div>
      </section>}

      {isAdmin && <InvitesCard roles={roles} jobRoles={jobRoles ?? []} signInOn={!!ws?.requireLogin} />}
      <section className="set-card">
        <div className="set-card-head"><h3>People</h3><span className="muted small">Job roles decide which spaces each person sees (Job roles, below). The default level applies where no job role or space setting says otherwise. Admins can do everything in shared spaces.</span></div>
        {people.map(p => (
          <div key={p.id} className={'set-item team-row' + (p.active ? '' : ' off')}>
            <Avatar person={{id: p.id, name: p.name, email: p.email, color: p.color}} size={26} />
            <div className="grow" style={{minWidth: 140}}>
              <input className="inline" defaultValue={p.name} disabled={!isAdmin} onBlur={e => e.target.value !== p.name && patch(p.id, {name: e.target.value})} />
              <input className="inline small" placeholder="email for sign-in" defaultValue={p.email} disabled={!isAdmin && p.id !== me.person?.id} onBlur={e => e.target.value !== p.email && patch(p.id, {email: e.target.value})} />
              <div className="jr-names small">{jobRoleNames(jobRoles ?? [], p.jobRoles).join(', ') || <span className="muted">No job role</span>}</div>
            </div>
            <select className="plain-select" value={p.kind} disabled={!isAdmin} onChange={e => patch(p.id, {kind: e.target.value})} title="Human or AI worker"><option value="human">Human</option><option value="ai">AI agent</option></select>
            <JobRolePicker all={jobRoles ?? []} value={p.jobRoles ?? []} disabled={!isAdmin} onChange={ids => patch(p.id, {jobRoles: ids})} />
            <select className="plain-select" value={p.role} disabled={!isAdmin} onChange={e => patch(p.id, {role: e.target.value})} title="Default permission level">
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

      {jobRoles && <JobRolesCard jobRoles={jobRoles} levels={roles} projects={store.projects} counts={Object.fromEntries(jobRoles.map(j => [j.id, people.filter(p => p.jobRoles?.includes(j.id)).length]))}
        onSave={async j => { try { await api('/workspace', {method: 'PUT', body: {jobRoles: j}}); const t = await api<{jobRoles: JobRole[]}>('/team'); setJobRoles(t.jobRoles); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } }} />}
      {domainJoin && jobRoles && <DomainJoinCard value={domainJoin} levels={roles} jobRoles={jobRoles} googleOn={!!me.signInGoogle} onSaved={setMsg} />}

      <section className="set-card">
        <div className="set-card-head"><h3>Permission levels and what they can do</h3><span className="muted small">Tick what each level may do. Job roles and spaces pick a level per space.</span></div>
        <div className="role-grid" style={{gridTemplateColumns: `200px repeat(${roles.length}, minmax(90px, 1fr)) 30px`}}>
          <div />
          {roles.map(r => <div key={r.id} className="role-head">
            <input className="inline" value={r.name} disabled={!isAdmin || r.id === 'admin'} onChange={e => setRoles(roles.map(x => x.id === r.id ? {...x, name: e.target.value} : x))} onBlur={() => saveRoles(roles)} />
            {isAdmin && !['admin', 'editor', 'viewer'].includes(r.id) && <button className="icon" title="Delete role" onClick={() => saveRoles(roles.filter(x => x.id !== r.id))}><Trash2 size={12} /></button>}
          </div>)}
          <div />
          {caps.map(c => <RoleRow key={c.id} cap={c} roles={roles} disabled={!isAdmin} onToggle={(rid, on) => saveRoles(roles.map(r => r.id === rid ? {...r, caps: on ? [...r.caps, c.id] : r.caps.filter(x => x !== c.id)} : r))} />)}
        </div>
        {isAdmin && <button className="btn" style={{marginTop: 8}} onClick={() => saveRoles([...roles, {id: 'role-' + Math.random().toString(36).slice(2, 7), name: 'New level', caps: ['view', 'comment']}])}><Plus size={14} /> New level</button>}
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
      {me.person && <AgentsCard />}
      {me.account && <ConnectedAppsCard />}
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
  const [mine, setMine] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [jobRoles, setJobRoles] = useState<JobRole[]>([]);
  const [held, setHeld] = useState<Record<string, string[]>>({});
  useEffect(() => { api<{roles: Role[]; jobRoles?: JobRole[]; people?: Member[]}>('/team').then(t => { setRoles(t.roles); setJobRoles(t.jobRoles ?? []); setHeld(Object.fromEntries((t.people ?? []).map(p => [p.id, p.jobRoles ?? []]))); }).catch(() => {}); api<Me>('/auth/me').then(m => { setAdmin(m.admin); setMe(m.person?.id ?? null); setMine(!!m.caps?.[project.id]?.includes('settings')); }).catch(() => {}); }, [project.id]);
  const access = project.settings.access ?? {default: 'inherit', members: {}};
  const personal = !!access.private;
  const canEdit = personal ? mine || (admin && !!me && !!access.members[me]) : admin;
  const save = (a: typeof access) => store.updateProject(project.id, {settings: {...project.settings, access: a}});
  const options = <>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}<option value="none">No access</option></>;
  return (
    <section className="set-card">
      <div className="set-card-head"><h3><Shield size={15} /> {personal ? 'Sharing' : 'Access'}</h3><span className="muted small">{personal
        ? 'Personal space: only the people given a role here can see it. Workspace admins do not see it unless added.'
        : 'Shared space: people see it as their job roles say (Team page), else as set below, else with their default level. Inviting someone never gives them anyone\'s personal spaces.'}</span></div>
      {!personal && canEdit && me && <div className="set-item"><span className="grow muted small">Keep this space to yourself and the people you pick, like a private Google Doc.</span>
        <button className="btn small" onClick={() => { if (confirm('Make this space private? Only you and people you give a role below will see it.')) save({default: 'none', members: {...access.members, [me]: 'admin'}, private: true}); }}>Make private</button></div>}
      {!personal && jobRoles.some(j => j.spaces && (j.spaces[project.id] ?? j.others ?? 'inherit') !== 'inherit') && <div className="set-item"><span className="grow small"><b>Job roles here:</b> {jobRoles.filter(j => j.spaces && (j.spaces[project.id] ?? j.others ?? 'inherit') !== 'inherit').map(j => { const l = j.spaces[project.id] ?? j.others; return `${j.name} ${l === 'none' ? 'no access' : roles.find(r => r.id === l)?.name ?? l}`; }).join(', ')}. <span className="muted">Change on the Team page. A person set below overrides their job role.</span></span></div>}
      <div className="set-item">
        <span className="grow">Everyone else in the workspace</span>
        <select className="plain-select" value={access.default} disabled={!canEdit} onChange={e => save({...access, default: e.target.value})}>
          {!personal && <option value="inherit">Their default role</option>}{options}
        </select>
      </div>
      {store.people.map(p => (
        <div key={p.id} className="set-item">
          <Avatar person={p} size={22} /><span className="grow">{p.name}{jobRoleNames(jobRoles, held[p.id]).length > 0 && <span className="muted small"> · {jobRoleNames(jobRoles, held[p.id]).join(', ')}</span>}</span>
          <select className="plain-select" value={access.members[p.id] ?? ''} disabled={!canEdit || (personal && p.id === me && !admin)} onChange={e => { const m = {...access.members}; if (e.target.value) m[p.id] = e.target.value; else delete m[p.id]; save({...access, members: m}); }}>
            <option value="">Same as everyone else</option>{options}
          </select>
        </div>
      ))}
      {personal && canEdit && <div className="set-item"><span className="grow muted small">Make it a regular workspace space (admins can then see and manage it).</span>
        <button className="btn small" onClick={() => { if (confirm('Turn this into a regular workspace space? Admins will see it.')) save({default: access.default === 'none' ? 'inherit' : access.default, members: access.members}); }}>Make shared space</button></div>}
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
      <div className="set-card-head"><h3>AI agents and tokens (advanced)</h3><span className="muted small">For Claude, Connect Claude above is simpler. An AI agent is a person marked AI agent above, with the role you choose. Give it a token; it can then use the API or MCP and do only what its role allows.</span></div>
      <div className="set-add" style={{flexWrap: 'wrap'}}>
        <select className="plain-select" value={who} onChange={e => setWho(e.target.value)}>{people.filter(p => admin || p.id === me).map(p => <option key={p.id} value={p.id}>{p.name}{p.kind === 'ai' ? ' (AI)' : ''}</option>)}</select>
        <input className="plain-select" style={{flex: 1, minWidth: 140}} placeholder="Token name, e.g. Claude Desktop" value={name} onChange={e => setName(e.target.value)} />
        <button className="btn primary" disabled={!who} onClick={async () => { const r = await api<{token: string}>('/tokens', {method: 'POST', body: {person: who, name}}); setFresh(r.token); load(); }}>Create token</button>
      </div>
      {fresh && <div className="token-once">
        <b>Copy this token now. It will not be shown again.</b>
        <pre className="code">{fresh}</pre>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(fresh)}><Copy size={12} /> Copy</button>
        <div className="small muted" style={{marginTop: 8}}>Connect an AI app with MCP over HTTP: URL <code>{mcpUrl}</code>, header <code>Authorization: Bearer {fresh.slice(0, 8)}...</code>. For Claude or Cowork custom connectors (no headers), use <code>{mcpUrl}&amp;key={fresh}</code> and keep it private like a password. Or call the REST API with the same header. The agent should start with the get_guide tool.</div>
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

type Invite = {id: string; email: string; role: string; jobRoles?: string[]; created: string; expires: string; link?: string; emailed?: boolean};
/** Invite people by email into this workspace. The link works once and for 7 days. */
function InvitesCard({roles, jobRoles, signInOn}: {roles: Role[]; jobRoles: JobRole[]; signInOn: boolean}) {
  const [list, setList] = useState<Invite[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [jr, setJr] = useState<string[]>([]);
  const [last, setLast] = useState<Invite | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Invite[]>('/invites').then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const send = async () => {
    setErr('');
    try { const inv = await api<Invite>('/invites', {method: 'POST', body: {email, role, jobRoles: jr}}); setLast(inv); setEmail(''); setJr([]); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Invite people</h3><span className="muted small">They get a one-time link (7 days) to join with their name, then land in this workspace with the role you pick. The link is emailed when the server can send mail; you can always copy it and send it yourself.
        {!signInOn && ' Sign-in is off right now, so passwords take effect once you turn it on.'}</span></div>
      <div className="time-row">
        <input className="inline" style={{flex: 1}} placeholder="name@company.com" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && email.trim() && send()} />
        <JobRolePicker all={jobRoles} value={jr} onChange={setJr} />
        <select className="plain-select" value={role} onChange={e => setRole(e.target.value)} title="Default permission level">{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <button className="btn primary" disabled={!email.trim()} onClick={send}><Plus size={14} /> Invite</button>
      </div>
      {err && <div className="small" style={{color: 'var(--danger)'}}>{err}</div>}
      {last?.link && <div className="invite-link">
        <span className="small">{last.emailed ? `Emailed to ${last.email}. ` : ''}Link for {last.email}:</span>
        <code>{last.link}</code>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(last.link!)}>Copy</button>
      </div>}
      {list.length > 0 && <><div className="pop-label">Waiting to join</div>
        {list.map(i => <div key={i.id} className="set-item"><span className="grow">{i.email}</span><span className="muted small">{[...(i.jobRoles ?? []).map(id => jobRoles.find(j => j.id === id)?.name ?? id), roles.find(r => r.id === i.role)?.name ?? i.role].join(', ')}, expires {new Date(i.expires).toLocaleDateString()}</span>
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
  const [busy, setBusy] = useState(false);
  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    if (!info?.hasAccount && addPw && pw !== pw2) return setErr('The two passwords do not match');
    setErr(''); setBusy(true);
    try {
      const r = await api<{google?: boolean}>(`/invites/${secret}/accept`, {method: 'POST', body: {name, password: pw}});
      if (r.google) { location.href = '/auth/google/start'; return; }
      location.hash = '/mywork'; location.reload();
    } catch (e) { setErr(message(e)); setBusy(false); }
  };
  // An existing account joins signed in as itself, or with its password; staff accounts sign in with Google first.
  const needSignIn = !!info?.hasAccount && !info.signedIn && (!info.hasPassword || info.staff);
  const needPw = !!info?.hasAccount && !info.signedIn && !needSignIn;
  const ready = !!name.trim() && !needSignIn && (needPw ? pw.length >= 8 : !addPw || pw.length >= 8);
  return (
    <AuthCard help={false}>
      {info ? <>
        <h1>Join {info.workspace}</h1>
        <p className="signin-sub">{info.invitedBy ? `${info.invitedBy} invited ` : 'You were invited as '}<b>{info.email}</b> as {info.role}.</p>
        <form className="signin-form" onSubmit={join}>
          <Field label="Your name" autoFocus autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
          {needSignIn && <p className="signin-note">You already have a Cadence account on this server. <a href="#/signin">Sign in</a> first, then open this link again.</p>}
          {needPw && <>
            <p className="signin-note">You already have a Cadence account on this server. Enter its password to join, or sign in first and open this link again.</p>
            <Field label="Your password" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />
          </>}
          {!info.hasAccount && info.staff && <p className="signin-note">Next you sign in with your Nursetech Google account.</p>}
          {!info.hasAccount && !info.staff && (addPw ? <>
            <Field label={info.passwordless ? 'Password (optional, 8 or more characters)' : 'Choose a password (8 or more characters)'} type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} />
            <Field label="Type it again" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} />
          </> : <p className="signin-note">No password needed: you sign in with an emailed link or Google.</p>)}
          <AuthError msg={err} />
          <AuthButton type="submit" busy={busy} busyText="Joining..." disabled={!ready}>Join workspace</AuthButton>
        </form>
        {!info.hasAccount && !info.staff && info.passwordless && !addPw && <button type="button" className="signin-link" onClick={() => setAddPw(true)}>Add a password (optional)</button>}
      </> : <>
        <h1>Invite</h1>
        {err ? <AuthError msg={err} /> : <p className="signin-sub">Checking your invite...</p>}
        {err && <a className="signin-link" href="#/signin">Go to sign in</a>}
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
      {links.some(l => l.scopes.includes('calendar')) && <CalendarSync links={links.filter(l => l.scopes.includes('calendar'))} reconnect={start('calendar-full')} />}
    </section>
  );
}

type CalSettings = {linkId: string | null; calendarId: string; pushTasks: 'none' | 'due'; tasksCalendarId: string | null; doneRule: 'mark' | 'delete'; syncCalendars: string[];
  workStart: string; workEnd: string; tz: string; sync?: {calendar_id: string; last_sync: string | null; error: string | null; channel_expires: string | null}[]};
/** Two-way Google Calendar sync: where meetings go, which calendars come in, task due dates, work hours. */
function CalendarSync({links, reconnect}: {links: GLink[]; reconnect: string}) {
  const [s, setS] = useState<CalSettings | null>(null);
  const [cals, setCals] = useState<{id: string; name: string; primary: boolean; canWrite: boolean}[]>([]);
  const [msg, setMsg] = useState('');
  const load = () => api<CalSettings>('/calendar/settings').then(setS).catch(e => setMsg(String(e instanceof Error ? e.message : e)));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (s?.linkId) api<typeof cals>(`/google/calendars?link=${s.linkId}`).then(setCals).catch(e => setMsg(String(e instanceof Error ? e.message : e))); }, [s?.linkId]);
  if (!s) return null;
  const save = async (patch: Partial<CalSettings>) => { try { setS(await api<CalSettings>('/calendar/settings', {method: 'PUT', body: patch})); setMsg('Saved.'); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } };
  const calId = (c: {id: string; primary: boolean}) => c.primary ? 'primary' : c.id;
  const full = !!links.find(l => l.id === s.linkId)?.scopes.split(/\s+/).includes('https://www.googleapis.com/auth/calendar');
  return (
    <div className="cal-sync">
      <h4>Calendar sync (two-way)</h4>
      <p className="small muted">Meetings you schedule in Cadence go to your Google calendar with invitations and a Meet link. Events in the calendars you pick below come into Cadence every few minutes (instantly when the server has a public https address). Events other people organize show read-only.</p>
      <div className="time-row"><span className="small">Account</span>
        <select className="plain-select" value={s.linkId ?? ''} onChange={e => save({linkId: e.target.value || null, calendarId: 'primary', syncCalendars: ['primary']})}>{links.map(l => <option key={l.id} value={l.id}>{l.email}</option>)}</select></div>
      <div className="time-row"><span className="small">Meetings go to</span>
        <select className="plain-select" value={s.calendarId} onChange={e => save({calendarId: e.target.value})}>{cals.filter(c => c.canWrite).map(c => <option key={c.id} value={calId(c)}>{c.name}{c.primary ? ' (primary)' : ''}</option>)}</select></div>
      <div className="small">Bring these calendars into Cadence:</div>
      <div className="cal-sync-list">{cals.map(c => <label key={c.id} className="small"><input type="checkbox" checked={s.syncCalendars.includes(calId(c))}
        onChange={e => save({syncCalendars: e.target.checked ? [...s.syncCalendars, calId(c)] : s.syncCalendars.filter(x => x !== calId(c))})} /> {c.name}</label>)}</div>
      <div className="time-row"><span className="small">Task due dates</span>
        <select className="plain-select" value={s.pushTasks} onChange={e => save({pushTasks: e.target.value as CalSettings['pushTasks']})}><option value="none">Not on my calendar</option><option value="due">All-day event for each task assigned to me</option></select>
        {s.pushTasks === 'due' && <>
          <select className="plain-select" value={s.tasksCalendarId ?? s.calendarId} onChange={e => save({tasksCalendarId: e.target.value})}>{cals.filter(c => c.canWrite).map(c => <option key={c.id} value={calId(c)}>{c.name}</option>)}</select>
          {full ? <button className="btn small" onClick={async () => { try { setS(await api<CalSettings>('/calendar/cadence-calendar', {method: 'POST'})); setMsg('Made a "Cadence" calendar for due dates.'); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } }}>Make a "Cadence" calendar</button>
            : <a className="btn small ghost" href={reconnect} title="Reconnect with full Calendar permission so Cadence can make its own calendar">Allow making a Cadence calendar</a>}
          <select className="plain-select" value={s.doneRule} onChange={e => save({doneRule: e.target.value as CalSettings['doneRule']})}><option value="mark">When done: mark [Done]</option><option value="delete">When done: remove</option></select>
        </>}
      </div>
      <div className="time-row"><span className="small">Work hours (for Find a time)</span>
        <input className="plain-input" type="time" value={s.workStart} onChange={e => save({workStart: e.target.value})} /> to <input className="plain-input" type="time" value={s.workEnd} onChange={e => save({workEnd: e.target.value})} />
        <input className="plain-input" style={{width: 160}} value={s.tz} title="Time zone" onChange={e => setS({...s, tz: e.target.value})} onBlur={e => save({tz: e.target.value})} /></div>
      <div className="time-row">
        <button className="btn small" onClick={async () => { setMsg('Syncing...'); try { const r = await api<{calendar: string; changes: number}[]>('/calendar/sync', {method: 'POST'}); setMsg(`Synced: ${r.map(x => `${x.changes} changes from ${x.calendar}`).join(', ')}`); load(); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } }}>Sync now</button>
        {s.sync?.map(x => <span key={x.calendar_id} className={'small ' + (x.error ? 'danger-text' : 'muted')}>{x.calendar_id}: {x.error ? x.error : x.last_sync ? `synced ${new Date(x.last_sync).toLocaleString()}` : 'not synced yet'}{x.channel_expires ? ', live' : ''}</span>)}
      </div>
      {msg && <div className="small">{msg}</div>}
    </div>
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

/** My data: download what you can see plus your layouts, or merge a download back in (personal spaces and layouts). */
function MyDataCard() {
  const [msg, setMsg] = useState('');
  const download = async () => {
    try {
      const data = await api<unknown>('/me/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], {type: 'application/json'}));
      const a = document.createElement('a'); a.href = url; a.download = `cadence-my-data-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  const restore = async (file: File | undefined, what: 'all' | 'prefs') => {
    if (!file) return;
    try {
      const r = await api<{prefs: number; prefsSkipped: number; spacesCreated: number; itemsAdded: number; viewsAdded: number}>('/me/import', {method: 'POST', body: {data: JSON.parse(await file.text()), what}});
      setMsg(`Restored: ${r.prefs} layout settings, ${r.spacesCreated} personal spaces, ${r.itemsAdded} items, ${r.viewsAdded} views${r.prefsSkipped ? ` (${r.prefsSkipped} settings had nothing to match here)` : ''}.`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>My data</h3><span className="muted small">Download everything you can see (spaces, items, comments, sprints), your time, your private views and your layouts. Restoring merges: your personal spaces come back and your layouts apply; shared spaces are never overwritten.</span></div>
      <div className="set-item"><span className="grow">Download my data (JSON)</span><button className="btn small" onClick={download}>Download</button></div>
      <div className="set-item"><span className="grow">Restore personal spaces and layouts</span><label className="btn small">Choose file<input type="file" accept="application/json,.json" hidden onChange={e => { restore(e.target.files?.[0], 'all'); e.target.value = ''; }} /></label></div>
      <div className="set-item"><span className="grow">Restore layouts only</span><label className="btn small">Choose file<input type="file" accept="application/json,.json" hidden onChange={e => { restore(e.target.files?.[0], 'prefs'); e.target.value = ''; }} /></label></div>
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}

type AgentSettings = {provider: string; spaces: string[] | null; workTypes: 'ai' | 'ai+either'; watchAssignments: boolean; checkFrequency: string; maxClaims: number;
  writePolicy: 'review' | 'direct'; autoApprove: string[]; canCreate: boolean; canInviteOutside: boolean; webhook: string | null};
type AgentRow = {id: string; name: string; owner: string | null; settings: AgentSettings};
const RUN_PROMPT = (name: string) => `You are ${name}, an AI agent in Cadence (the team's project manager). Each run:
1. Call agent_inbox (pass the "now" from your last run as since).
2. For each new task for your owner and each available task: decide if you can do it well with your tools. If yes, claim_task (existing work) or suggest_work (new work) with a short plan. If not, skip it.
3. For work you are accepted on or that was sent back: do it, log_step as you go (links, screenshots), then submit_work with a report and what you missed.
4. Never mark work done and never invite people outside the workspace. Your changes wait for your owner unless they follow an approved AI SOP.`;

/** Where to paste the key, per AI app. Kept short; the Learn page has the full walk-through. */
function ConnectSteps({provider, url, prompt}: {provider: string; url: string; prompt: string}) {
  const bare = url.replace(/[&?]key=[^&]+/, ''), key = /[?&]key=([^&]+)/.exec(url)?.[1] ?? '';
  const copy = (t: string) => <button className="btn ghost small" onClick={() => navigator.clipboard.writeText(t)}><Copy size={11} /> Copy</button>;
  const promptBox = <><pre className="proposal-args">{prompt}</pre>{copy(prompt)}</>;
  if (provider === 'meta') return <div className="small">
    <div><b>Muse (Meta AI)</b> has no box for a connector address. You ask Muse to build one, and the key goes in its Secure Credentials Store, never in the chat.</div>
    <ol>
      <li>In Muse, send: <code className="agent-key">Create a custom connector named Cadence for the MCP server at {bare} (streamable HTTP). It needs the header Authorization: Bearer KEY. Ask me for KEY through the secure credential flow, then list its tools to test it and save it as a skill.</code> {copy(`Create a custom connector named Cadence for the MCP server at ${bare} (streamable HTTP). It needs the header Authorization: Bearer KEY. Ask me for KEY through the secure credential flow, then list its tools to test it and save it as a skill.`)}</li>
      <li>When Muse opens the credential prompt, paste this key there: <code className="agent-key">{key}</code> {copy(key)}</li>
      <li>Ask Muse to run this on a schedule (Muse calls these scheduled tasks):</li>
    </ol>{promptBox}</div>;
  if (provider === 'chatgpt') return <div className="small">
    <ol>
      <li>ChatGPT on the web: Settings, Apps, Advanced settings, turn on Developer mode. On Business or Enterprise an admin turns it on first.</li>
      <li>Create app. Name: Cadence. MCP server URL: <code className="agent-key">{url}</code> {copy(url)} Authentication: none (the key is in the address).</li>
      <li>ChatGPT asks you to confirm each change it makes. Open Scheduled in the sidebar and add a task with this prompt:</li>
    </ol>{promptBox}</div>;
  return <div className="small">
    <ol>
      <li>Claude: Settings (or Customize), Connectors, +, Add custom connector. Name: Cadence agent. URL: <code className="agent-key">{url}</code> {copy(url)} Leave the OAuth fields empty. On a Team plan an Owner adds it first.</li>
      <li>Make a scheduled task in Claude with this prompt, and turn on only the Cadence agent connector for it:</li>
    </ol>{promptBox}</div>;
}

/** Your own AI agents: add one, connect it with its key, and set what it may do. */
function AgentsCard() {
  const [list, setList] = useState<AgentRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('claude');
  const [key, setKey] = useState<{agent: string; url: string; token: string} | null>(null);
  const [msg, setMsg] = useState('');
  const load = () => api<AgentRow[]>('/agents').then(setList).catch(e => setMsg(String(e instanceof Error ? e.message : e)));
  useEffect(() => { load(); api<Project[]>('/projects').then(ps => setProjects(ps.filter(p => !p.settings.rollup))).catch(() => {}); }, []);
  const save = async (a: AgentRow, patch: Partial<AgentSettings>) => {
    try { const r = await api<{settings: AgentSettings}>(`/agents/${a.id}`, {method: 'PATCH', body: patch}); setList(list.map(x => x.id === a.id ? {...x, settings: r.settings} : x)); setMsg('Saved.'); }
    catch (e) { setMsg(String(e instanceof Error ? e.message : e)); }
  };
  return (
    <section className="set-card agents-card">
      <div className="set-card-head"><h3>My AI agents</h3><span className="muted small">
        Optional. The Cadence connector you already use in Claude works <b>as you</b>: what it does is logged as you and applies right away. Add an agent here only when you want an AI to work <b>on its own</b> (on a schedule, while you are away) under its own name, with its changes held for your approval. Its key is its login: whoever has the key acts as the agent, so keep it private. Step-by-step guides for Claude, ChatGPT and Muse (Meta AI) are on the Learn page.</span></div>
      <div className="time-row">
        <input className="plain-select" placeholder="Agent name, like David's Claude" value={name} onChange={e => setName(e.target.value)} />
        <select className="plain-select" value={provider} onChange={e => setProvider(e.target.value)}><option value="claude">Claude</option><option value="chatgpt">ChatGPT</option><option value="meta">Muse (Meta AI)</option><option value="other">Other</option></select>
        <button className="btn primary" disabled={!name.trim()} onClick={async () => { try { await api('/agents', {method: 'POST', body: {name, provider}}); setName(''); load(); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } }}><Plus size={13} /> Add agent</button>
      </div>
      {list.map(a => (
        <div key={a.id} className="agent-card">
          <div className="time-row"><b className="grow">{a.name}</b><span className="tag">{a.settings.provider}</span>
            <button className="btn small" onClick={async () => { try { const r = await api<{token: string; mcpUrl: string}>(`/agents/${a.id}/token`, {method: 'POST', body: {name: 'Connector'}}); setKey({agent: a.id, url: r.mcpUrl, token: r.token}); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } }}><KeyRound size={12} /> Get connection key</button>
          </div>
          {key?.agent === a.id && <div className="g-out small">
            <b>Shown once. Keep it private. It is this agent's login; anyone with it acts as {a.name}.</b>
            <ConnectSteps provider={a.settings.provider} url={key.url} prompt={RUN_PROMPT(a.name)} />
            <div className="muted">Run it {a.settings.checkFrequency}. Lost the key? Get a new one; revoke old ones under Tokens.</div>
          </div>}
          <div className="agent-grid small">
            <label>Changes it makes <select className="plain-select" value={a.settings.writePolicy} onChange={e => save(a, {writePolicy: e.target.value as AgentSettings['writePolicy']})}><option value="review">Wait for my approval</option><option value="direct">Apply right away</option></select></label>
            <label>Work it may take <select className="plain-select" value={a.settings.workTypes} onChange={e => save(a, {workTypes: e.target.value as AgentSettings['workTypes']})}><option value="ai+either">Marked AI or Either</option><option value="ai">Marked AI only</option></select></label>
            <label><input type="checkbox" checked={a.settings.watchAssignments} onChange={e => save(a, {watchAssignments: e.target.checked})} /> Tell it when I get new tasks</label>
            <label>Most open claims <input className="plain-input" type="number" min={0} max={100} style={{width: 60}} value={a.settings.maxClaims} onChange={e => save(a, {maxClaims: Number(e.target.value)})} /></label>
            <label>Checks for work <input className="plain-input" value={a.settings.checkFrequency} onChange={e => setList(list.map(x => x.id === a.id ? {...x, settings: {...x.settings, checkFrequency: e.target.value}} : x))} onBlur={e => save(a, {checkFrequency: e.target.value})} /></label>
            <label>Approved AI SOPs (no approval needed) <input className="plain-input" placeholder="SOP-07.26, SOP-FIN.1" defaultValue={a.settings.autoApprove.join(', ')} onBlur={e => save(a, {autoApprove: e.target.value.split(/[,\s]+/).filter(Boolean)})} /></label>
            <label>Webhook when I get new tasks <input className="plain-input" placeholder="https://... (Zapier, n8n, a Claude trigger)" defaultValue={a.settings.webhook ?? ''} onBlur={e => save(a, {webhook: e.target.value.trim() || null})} /></label>
            <div>Spaces it works in: <label><input type="checkbox" checked={!a.settings.spaces} onChange={e => save(a, {spaces: e.target.checked ? null : []})} /> All</label>
              {a.settings.spaces && projects.map(p => <label key={p.id}><input type="checkbox" checked={a.settings.spaces!.includes(p.id)} onChange={e => save(a, {spaces: e.target.checked ? [...a.settings.spaces!, p.id] : a.settings.spaces!.filter(x => x !== p.id)})} /> {p.name}</label>)}</div>
          </div>
        </div>
      ))}
      {msg && <div className="small">{msg}</div>}
    </section>
  );
}
