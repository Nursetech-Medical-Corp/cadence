// Connect Claude (or another AI app) by pasting one address and signing in, and the apps connected that way.
// The server side is server/oauth.ts.
import {useEffect, useState} from 'react';
import {Copy, Plug, Unplug} from 'lucide-react';
import {api} from './store.ts';

const NEXT = 'cadence_next';
/** The consent page someone was on before signing in, if any (only that page, never another address). */
export function pendingConnect(): string | null {
  const raw = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(NEXT + '='))?.slice(NEXT.length + 1);
  if (!raw) return null;
  let next = '';
  try { next = decodeURIComponent(raw); } catch { return null; }
  return next.startsWith('/oauth/authorize?') ? next : null;
}
/** After signing in: back to the consent page. True when the browser is on its way there. */
export function resumeConnect() {
  const next = pendingConnect();
  document.cookie = `${NEXT}=; Path=/; Max-Age=0; SameSite=Lax`;
  if (!next) return false;
  location.replace(next);
  return true;
}

type App = {clientId: string; name: string; workspace: string; workspaceName: string; email: string; connected: string; lastUsed: string | null};

export function ConnectedAppsCard() {
  const [data, setData] = useState<{mcpUrl: string | null; workspaceUrl: string | null; apps: App[]} | null>(null);
  const load = () => api<NonNullable<typeof data>>('/auth/apps').then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!data) return null;
  const url = data.workspaceUrl ?? data.mcpUrl;
  return (
    <section className="set-card">
      <div className="set-card-head"><h3><Plug size={15} /> Connect Claude</h3><span className="muted small">Let Claude work in Cadence as you, with your permissions. All it takes is one address.</span></div>
      {url ? <>
        <ol className="small" style={{margin: '4px 0 8px', paddingLeft: 20, lineHeight: 1.7}}>
          <li>In Claude, open <b>Settings</b>, <b>Connectors</b>, <b>Add custom connector</b>.</li>
          <li>Name it Cadence and paste this address:
            <div className="set-item" style={{gap: 6}}><code style={{flex: 1, overflowWrap: 'anywhere'}}>{url}</code>
              <button className="btn small" onClick={() => navigator.clipboard.writeText(url)}><Copy size={12} /> Copy</button></div></li>
          <li>Click <b>Connect</b>, sign in to Cadence if asked, and click <b>Allow</b>.</li>
        </ol>
        <div className="muted small">If you belong to several workspaces you choose one when you allow. Disconnect below any time.</div>
      </> : <div className="muted small">An admin needs to set PUBLIC_URL on the server (the address people use) before apps can connect by signing in. Until then, use a token below.</div>}
      <div className="pop-label">Connected apps</div>
      {!data.apps.length && <div className="muted small">None yet.</div>}
      {data.apps.map(a => (
        <div key={`${a.clientId}|${a.workspace}|${a.email}`} className="set-item">
          <span className="grow small"><b>{a.name}</b> in {a.workspaceName}{a.email ? ` (${a.email})` : ''}</span>
          <span className="muted small">{a.lastUsed ? `used ${new Date(a.lastUsed).toLocaleString()}` : `connected ${new Date(a.connected).toLocaleDateString()}`}</span>
          <button className="btn ghost small" onClick={async () => { if (confirm(`Disconnect ${a.name}? It stops working until you connect it again.`)) { await api(`/auth/apps/${encodeURIComponent(a.clientId)}?workspace=${encodeURIComponent(a.workspace)}`, {method: 'DELETE'}); load(); } }}><Unplug size={12} /> Disconnect</button>
        </div>
      ))}
    </section>
  );
}
