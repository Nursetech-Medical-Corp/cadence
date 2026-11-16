// Webhook endpoints for one space (scope = its id) or for the whole workspace (scope = "workspace"):
// name, URL, secret, which events, on or off, a test event, and the recent deliveries.
import {useEffect, useState} from 'react';
import {Plus, Send, Trash2} from 'lucide-react';
import {HOOK_EVENTS, HOOK_GROUPS, type Hook, type HookDelivery} from './hooks.ts';
import {api, type Store} from './store.ts';

type Loaded = {webhooks: Hook[]; dueSoonDays?: number[]; deliveries: HookDelivery[]};

export function WebhooksEditor({scope, store}: {scope: string; store: Store}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [url, setUrl] = useState('');
  const load = () => api<Loaded>(`/hooks?scope=${scope}`).then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, [scope]);
  if (!data) return null;
  const hooks = data.webhooks;
  const put = async (body: object) => { try { await api('/hooks', {method: 'PUT', body: {scope, ...body}}); } catch (e) { store.fail(e); } load(); };
  const upd = (id: string, patch: Partial<Hook>) => put({webhooks: hooks.map(h => h.id === id ? {...h, ...patch} : h)});
  const test = async (id: string) => { try { await api('/hooks/test', {method: 'POST', body: {scope, id}}); } catch (e) { store.fail(e); } setTimeout(load, 1500); };
  const name = (id: string) => id.startsWith('rule:') ? 'Automation' : hooks.find(h => h.id === id)?.name || hooks.find(h => h.id === id)?.url || 'Removed endpoint';
  return (
    <>
      {hooks.map(h => (
        <div key={h.id} className={'rule' + (h.active ? '' : ' off')}>
          <div className="rule-head">
            <input type="checkbox" checked={h.active} title={h.active ? 'On' : 'Off'} onChange={e => upd(h.id, {active: e.target.checked})} />
            <input className="inline" placeholder="Name" defaultValue={h.name} key={h.name} onBlur={e => e.target.value !== h.name && upd(h.id, {name: e.target.value})} />
            <button className="btn ghost small" title="Send a test event now" onClick={() => test(h.id)}><Send size={12} /> Send test event</button>
            <button className="icon" title="Delete webhook" onClick={() => { if (confirm('Delete this webhook?')) put({webhooks: hooks.filter(x => x.id !== h.id)}); }}><Trash2 size={14} /></button>
          </div>
          <div className="rule-line"><b>URL</b>
            <input className="plain-select" style={{flex: 1, minWidth: 220}} defaultValue={h.url} key={h.url} onBlur={e => e.target.value !== h.url && upd(h.id, {url: e.target.value.trim()})} />
          </div>
          <div className="rule-line"><b>Secret</b>
            <input className="plain-select" style={{flex: 1, minWidth: 220}} type="password" autoComplete="new-password" placeholder={h.hasSecret ? 'Saved. Type a new one to replace it' : 'Optional: signs each delivery (X-Cadence-Signature)'}
              onBlur={e => { if (e.target.value) { upd(h.id, {secret: e.target.value}); e.target.value = ''; } }} />
            {h.hasSecret && <button className="btn ghost small" onClick={() => upd(h.id, {secret: ''})}>Remove secret</button>}
          </div>
          <details className="hook-events">
            <summary className="small">Events: {h.events.length ? `${h.events.length} chosen` : 'all'}</summary>
            <label className="small"><input type="checkbox" checked={!h.events.length} onChange={e => upd(h.id, {events: e.target.checked ? [] : ['item.created']})} /> Every event</label>
            {HOOK_GROUPS.map(g => (
              <div key={g} className="hook-group">
                <b className="small">{g}</b>
                <div className="chips">
                  {HOOK_EVENTS.filter(e => e.group === g).map(e => {
                    const on = h.events.includes(e.key);
                    return <label key={e.key} className={'chip-toggle' + (on ? ' on' : '')} title={e.key}>
                      <input type="checkbox" checked={on} onChange={() => upd(h.id, {events: on ? h.events.filter(x => x !== e.key) : [...h.events, e.key]})} /> {e.label}
                    </label>;
                  })}
                </div>
              </div>
            ))}
          </details>
        </div>
      ))}
      <div className="set-add"><input className="plain-select" style={{flex: 1}} placeholder="https://hooks.zapier.com/..." value={url} onChange={e => setUrl(e.target.value)} />
        <button className="btn" disabled={!/^https?:\/\//.test(url)} onClick={() => { put({webhooks: [...hooks, {name: '', url: url.trim(), events: [], active: true}]}); setUrl(''); }}><Plus size={14} /> Add</button></div>
      {data.dueSoonDays && <div className="set-item"><span className="grow small">Send "due soon" this many days before the due date</span>
        <input className="plain-select" style={{width: 110}} defaultValue={data.dueSoonDays.join(', ')} key={data.dueSoonDays.join()} title="Whole numbers, separated by commas"
          onBlur={e => { const d = e.target.value.split(/[,\s]+/).filter(Boolean).map(Number); if (d.join() !== data.dueSoonDays!.join()) put({dueSoonDays: d}); }} /></div>}
      <details className="hook-events" onToggle={e => (e.target as HTMLDetailsElement).open && load()}>
        <summary className="small">Recent deliveries ({data.deliveries.length})</summary>
        {!data.deliveries.length && <div className="muted small">Nothing sent yet.</div>}
        {data.deliveries.map(d => (
          <div key={d.id} className="set-item small" title={d.url}>
            <span className={'tag hook-' + d.status}>{d.status}</span>
            <span className="grow">{d.event} <span className="muted">to {name(d.hook)}</span></span>
            <span className="muted">{d.error ?? (d.code ? `HTTP ${d.code}` : '')}{d.attempts > 1 ? `, ${d.attempts} tries` : ''}{d.status === 'pending' && d.nextAt && d.attempts ? `, next ${new Date(d.nextAt).toLocaleTimeString()}` : ''}</span>
            <span className="muted">{new Date(d.created).toLocaleString()}</span>
          </div>
        ))}
      </details>
    </>
  );
}
