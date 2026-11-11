// Inbox settings: notifications on this device (phone or desktop), which kinds, quiet hours, and pause.
import {useEffect, useState} from 'react';
import {BellOff, BellRing, Download, Moon} from 'lucide-react';
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
