// Inbox settings: notifications on this device (phone or desktop), which kinds, quiet hours, and pause.
import {useEffect, useState} from 'react';
import {BellOff, BellRing, Download, Moon, X} from 'lucide-react';
import {api} from './store.ts';
import {NOTIFY_KINDS} from './types.ts';
import {canInstall, deviceOn, disableDevice, enableDevice, install, installed, isIos, pushSupported} from './device.ts';

type Prefs = {off: string[]; quiet: {from: string; to: string} | null; pausedUntil: string | null; tz: string};
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function NotifySettings() {
  const [info, setInfo] = useState<{key: string; prefs: Prefs; devices: number} | null>(null);
  const [err, setErr] = useState('');
  const [on, setOn] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { api<typeof info>('/push').then(setInfo).catch(e => setErr(e.message)); deviceOn().then(setOn).catch(() => {}); }, []);
  if (err) return <div className="notify-set muted small">{err}</div>;
  if (!info) return null;
  const save = (p: Partial<Prefs>) => api<Prefs>('/push/prefs', {method: 'PUT', body: {...info.prefs, ...p, tz}}).then(prefs => setInfo({...info, prefs}));
  const paused = !!info.prefs.pausedUntil && info.prefs.pausedUntil > new Date().toISOString();
  const pauseFor = (h: number) => save({pausedUntil: new Date(Date.now() + h * 3600_000).toISOString()});
  const toggleDevice = async () => {
    setMsg('');
    try {
      if (on) { await disableDevice(); setOn(false); setMsg('Off on this device.'); }
      else { await enableDevice(info.key); setOn(true); setMsg('On. Sending a test...'); const r = await api<{sent: number}>('/push/test', {method: 'POST', body: {}}); setMsg(r.sent ? 'On. A test notification is on its way.' : 'On, but the test did not go out. Try again in a minute.'); }
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="notify-set">
      <div className="notify-row">
        <BellRing size={16} />
        <span className="grow"><b>This device</b><span className="muted small"> Pop-ups on this computer or phone, even with Cadence closed.</span></span>
        {pushSupported() && <button className={'btn' + (on ? '' : ' primary')} onClick={toggleDevice}>{on ? 'Turn off' : 'Turn on'}</button>}
      </div>
      {!pushSupported() && isIos() && !installed() && <div className="notify-hint">On iPhone and iPad, notifications need Cadence on your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>, then open Cadence from there and turn them on.</div>}
      {!pushSupported() && !isIos() && <div className="notify-hint">This browser cannot show notifications from Cadence.</div>}
      {canInstall() && !installed() && <div className="notify-row"><Download size={16} /><span className="grow muted small">Install Cadence as an app for its own window and icon.</span><button className="btn" onClick={() => install()}>Install</button></div>}
      {msg && <div className="small muted">{msg}</div>}

      <div className="notify-row">
        <Moon size={16} />
        <span className="grow"><b>Quiet hours</b><span className="muted small"> Hold pop-ups overnight. The Inbox still gets everything.</span></span>
        <button className={'switch' + (info.prefs.quiet ? ' on' : '')} aria-pressed={!!info.prefs.quiet} title="Quiet hours" onClick={() => save({quiet: info.prefs.quiet ? null : {from: '21:00', to: '08:00'}})} />
      </div>
      {info.prefs.quiet && <div className="notify-row indent">
        From <input type="time" value={info.prefs.quiet.from} onChange={e => e.target.value && save({quiet: {...info.prefs.quiet!, from: e.target.value}})} />
        to <input type="time" value={info.prefs.quiet.to} onChange={e => e.target.value && save({quiet: {...info.prefs.quiet!, to: e.target.value}})} />
        <span className="muted small">{tz}</span>
      </div>}
      <div className="notify-row">
        <BellOff size={16} />
        <span className="grow"><b>Pause</b>{paused && <span className="muted small"> until {new Date(info.prefs.pausedUntil!).toLocaleString(undefined, {weekday: 'short', hour: 'numeric', minute: '2-digit'})}</span>}</span>
        {paused ? <button className="btn" onClick={() => save({pausedUntil: null})}>Resume</button> : <>
          <button className="btn" onClick={() => pauseFor(1)}>1 hour</button>
          <button className="btn" onClick={() => { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(8, 0, 0, 0); save({pausedUntil: t.toISOString()}); }}>Until tomorrow</button>
        </>}
      </div>

      <div className="pop-label">Send to my devices</div>
      <div className="notify-kinds">
        {NOTIFY_KINDS.map(k => (
          <label key={k.kind}><input type="checkbox" checked={!info.prefs.off.includes(k.kind)} onChange={e => save({off: e.target.checked ? info.prefs.off.filter(x => x !== k.kind) : [...info.prefs.off, k.kind]})} /> {k.label}</label>
        ))}
      </div>
      <div className="muted small">{info.devices ? `${info.devices} device${info.devices > 1 ? 's' : ''} signed up.` : 'No devices signed up yet.'} Email notifications are on the Team page.</div>
    </div>
  );
}

const LATER = 'notify-ask-later';
/**
 * The bar across the top that asks for alerts on this computer or phone, like Slack does, until they are on.
 * Turn on asks the browser for permission (it must come from a click) and signs this device up for pop-ups that
 * show even with Cadence closed. Not now hides it for a week. Blocked in the browser: says how to allow it.
 */
export function NotifyPrompt() {
  const [state, setState] = useState<'hidden' | 'ask' | 'blocked' | 'busy' | 'done'>('hidden');
  const [msg, setMsg] = useState('');
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!pushSupported() || !isSecureContext || Number(localStorage.getItem(LATER) ?? 0) > Date.now()) return;
    // Only when this person can get pushes here (the server knows their email) and this device is not signed up yet.
    Promise.all([api<{key: string}>('/push'), deviceOn()]).then(([, on]) => { if (!on) setState(Notification.permission === 'denied' ? 'blocked' : 'ask'); }).catch(() => {});
    const f = () => rerender(n => n + 1);
    addEventListener('beforeinstallprompt', f);
    return () => removeEventListener('beforeinstallprompt', f);
  }, []);
  if (state === 'hidden') return null;
  const later = () => { localStorage.setItem(LATER, String(Date.now() + 7 * 86400_000)); setState('hidden'); };
  const turnOn = async () => {
    setState('busy'); setMsg('');
    try {
      const {key} = await api<{key: string}>('/push');
      await enableDevice(key);
      localStorage.removeItem(LATER);
      const r = await api<{sent: number}>('/push/test', {method: 'POST', body: {}}).catch(() => ({sent: 0}));
      setMsg(r.sent ? 'Alerts are on. A test alert is on its way.' : 'Alerts are on for this device.');
      setState('done'); setTimeout(() => setState('hidden'), 6000);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setState(Notification.permission === 'denied' ? 'blocked' : 'ask');
    }
  };
  return <div className={'notify-prompt' + (state === 'blocked' ? ' blocked' : '')} role="region" aria-label="Alerts on this device">
    <BellRing size={16} />
    <span className="grow">
      {state === 'done' ? msg
        : state === 'blocked' ? <>Alerts are blocked for Cadence in this browser. Click the lock (or tune) icon left of the address, set <b>Notifications</b> to Allow, then reload.</>
        : <><b>Turn on alerts for this computer.</b> Get a pop-up when a task is assigned to you, someone mentions you, an AI agent asks for you, a reminder starts, and more, even with Cadence closed. You pick which kinds in Inbox, Settings.</>}
      {state !== 'done' && msg && <span className="muted small"> {msg}</span>}
    </span>
    {(state === 'ask' || state === 'busy') && <button className="btn primary" disabled={state === 'busy'} onClick={turnOn}>{state === 'busy' ? 'Asking...' : 'Turn on alerts'}</button>}
    {canInstall() && !installed() && state !== 'done' && <button className="btn" onClick={() => install().then(() => rerender(n => n + 1))} title="Its own window and icon, like a desktop app"><Download size={13} /> Install app</button>}
    {state !== 'done' && <button className="btn ghost" onClick={later}>Not now</button>}
    <button className="icon" title="Close" onClick={later}><X size={14} /></button>
  </div>;
}
