// In-app dialogs in place of the browser's alert, confirm and prompt: same look as the app, Esc or X closes,
// Enter confirms. Call uiConfirm, uiPrompt or uiAlert anywhere; DialogHost (mounted once in App) shows them.
import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';

type Ask = {kind: 'alert' | 'confirm' | 'prompt' | 'choose'; choices?: [string, string][]; message: string; value?: string; ok?: string; cancel?: string; danger?: boolean; password?: boolean; multiline?: boolean;
  resolve: (v: string | boolean | null) => void};
let push: ((a: Ask) => void) | null = null;
const queue: Ask[] = [];
const open = (a: Omit<Ask, 'resolve'>) => new Promise<string | boolean | null>(resolve => { const x = {...a, resolve}; if (push) push(x); else queue.push(x); });

export type DialogOpts = {ok?: string; cancel?: string; danger?: boolean};
/** Yes or no. Resolves true for OK. */
export const uiConfirm = (message: string, o: DialogOpts = {}) => open({kind: 'confirm', message, danger: /^(Delete|Remove|Discard|Revoke|Disconnect|Replace|Cancel every|Cancel this|Unlink)/.test(message), ...o}).then(Boolean);
/** A line of text (or several with multiline). Resolves null when cancelled. */
export const uiPrompt = (message: string, value = '', o: DialogOpts & {password?: boolean; multiline?: boolean} = {}) => open({kind: 'prompt', message, value, ...o}) as Promise<string | null>;
/** Pick one of several answers (value, label); the last is the main button. Esc or X resolves null: do nothing. */
export const uiChoose = <T extends string>(message: string, choices: [T, string][]) => open({kind: 'choose', message, choices}) as Promise<T | null>;
/** A message with one button. */
export const uiAlert = (message: string) => open({kind: 'alert', message}).then(() => undefined);

export function DialogHost() {
  const [list, setList] = useState<Ask[]>([]);
  useEffect(() => { push = a => setList(l => [...l, a]); if (queue.length) setList(l => [...l, ...queue.splice(0)]); return () => { push = null; }; }, []);
  const cur = list[0];
  if (!cur) return null;
  const done = (v: string | boolean | null) => { cur.resolve(v); setList(l => l.slice(1)); };
  return createPortal(<Dialog key={list.length + cur.message} a={cur} done={done} />, document.body);
}

function Dialog({a, done}: {a: Ask; done: (v: string | boolean | null) => void}) {
  const [v, setV] = useState(a.value ?? '');
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  const cancel = () => done(a.kind === 'prompt' || a.kind === 'choose' ? null : a.kind === 'alert' ? true : false);
  const ok = () => a.kind === 'choose' ? done(a.choices![a.choices!.length - 1][0]) : done(a.kind === 'prompt' ? v : true);
  useEffect(() => { (input.current ?? okBtn.current)?.focus(); input.current?.select?.(); }, []);
  return <div className="overlay dlg-back" onMouseDown={e => { if (e.target === e.currentTarget) cancel(); }}
    onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } if (e.key === 'Enter' && !(a.multiline && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); ok(); } }}>
    <div className="dlg" role="dialog" aria-modal="true">
      <button className="icon dlg-x" title="Close (Esc)" onClick={cancel}><X size={16} /></button>
      <div className="dlg-msg">{a.message}</div>
      {a.kind === 'prompt' && (a.multiline
        ? <textarea ref={input} className="plain-input" rows={4} value={v} onChange={e => setV(e.target.value)} />
        : <input ref={input} className="plain-input" type={a.password ? 'password' : 'text'} value={v} onChange={e => setV(e.target.value)} />)}
      {a.kind === 'choose' ? <div className="dlg-actions">
        <button className="btn ghost" onClick={cancel}>Cancel</button>
        {a.choices!.map(([v, l], i) => <button key={v} ref={i === a.choices!.length - 1 ? okBtn : undefined} className={'btn' + (i === a.choices!.length - 1 ? ' primary' : '')} onClick={() => done(v)}>{l}</button>)}
      </div> : <div className="dlg-actions">
        {a.kind !== 'alert' && <button className="btn" onClick={cancel}>{a.cancel ?? 'Cancel'}</button>}
        <button ref={okBtn} className={'btn ' + (a.danger ? 'danger-solid' : 'primary')} onClick={ok}>{a.ok ?? 'OK'}</button>
      </div>}
    </div>
  </div>;
}
