// Keyboard shortcuts (rebindable, saved in this browser), quick capture with voice dictation.
// Single keys work only when you are not typing in a field, like Linear and Gmail. Two-key sequences use "g then m".
import {fmtDay, useQuickAssist} from './QuickAssist.tsx';
import {useEffect, useRef, useState} from 'react';
import {Keyboard, Mic, MicOff, RotateCcw, X} from 'lucide-react';
import type {Item} from './types.ts';
import {type Store, wsId, realProjects, validProject} from './store.ts';
import {parseQuickAdd} from './quickadd.ts';

export type ActionId = 'palette' | 'capture' | 'filter' | 'help' | 'goMyWork' | 'goInbox' | 'goHistory' | 'down' | 'up' | 'open' | 'select' |
  'done' | 'assignMe' | 'sprintNow' | 'sprintNext' | 'backlog' | 'view1' | 'view2' | 'view3' | 'view4' | 'view5' | 'view6' | 'view7' | 'view8' | 'view9' | 'sidebar';

export const ACTIONS: {id: ActionId; label: string; group: string; def: string}[] = [
  {id: 'palette', label: 'Search everything', group: 'General', def: 'ctrl+k'},
  {id: 'capture', label: 'Quick capture (type or dictate)', group: 'General', def: 'c'},
  {id: 'filter', label: 'Focus the filter box', group: 'General', def: '/'},
  {id: 'sidebar', label: 'Show or hide the sidebar', group: 'General', def: '['},
  {id: 'help', label: 'Show shortcuts', group: 'General', def: '?'},
  {id: 'goMyWork', label: 'Go to My work', group: 'Go to', def: 'g m'},
  {id: 'goInbox', label: 'Go to Inbox', group: 'Go to', def: 'g i'},
  {id: 'goHistory', label: 'Go to History', group: 'Go to', def: 'g h'},
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map(n => ({id: `view${n}` as ActionId, label: `Switch to view tab ${n}`, group: 'Go to', def: String(n)})),
  {id: 'down', label: 'Next row', group: 'Rows', def: 'j'},
  {id: 'up', label: 'Previous row', group: 'Rows', def: 'k'},
  {id: 'open', label: 'Open row details', group: 'Rows', def: 'o'},
  {id: 'select', label: 'Select row (for bulk edit)', group: 'Rows', def: 'x'},
  {id: 'done', label: 'Mark done or reopen', group: 'Selected or focused rows', def: 'd'},
  {id: 'assignMe', label: 'Assign to me', group: 'Selected or focused rows', def: 'i'},
  {id: 'sprintNow', label: 'Move to current sprint', group: 'Selected or focused rows', def: 's'},
  {id: 'sprintNext', label: 'Move to next sprint', group: 'Selected or focused rows', def: 'shift+s'},
  {id: 'backlog', label: 'Move to backlog', group: 'Selected or focused rows', def: 'b'},
];

export function keymap(): Record<ActionId, string> {
  const saved = JSON.parse(localStorage.getItem('keymap') ?? '{}');
  return Object.fromEntries(ACTIONS.map(a => [a.id, saved[a.id] ?? a.def])) as Record<ActionId, string>;
}
export const shortcutsOn = () => localStorage.getItem('shortcuts-off') !== '1';

function keyName(e: KeyboardEvent) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  const mods = [(e.ctrlKey || e.metaKey) && 'ctrl', e.altKey && 'alt', e.shiftKey && k.length === 1 && /[a-z]/.test(k) && 'shift'].filter(Boolean);
  return [...mods, k === ' ' ? 'space' : k].join('+');
}

/** Listens for shortcuts and calls `run`. Ignores single keys while typing. */
export function useHotkeys(run: (a: ActionId) => void) {
  const pending = useRef<string | null>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const typing = !!(e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable=true]');
      const name = keyName(e);
      const map = keymap();
      const combo = pending.current ? `${pending.current} ${name}` : name;
      const hit = (Object.keys(map) as ActionId[]).find(a => map[a] === combo);
      const isMod = name.includes('ctrl+') || name.includes('alt+');
      if (typing && !isMod) return;
      if (!shortcutsOn() && !isMod) return;
      if (hit) { e.preventDefault(); pending.current = null; run(hit); return; }
      // Start of a two-key sequence?
      if (!pending.current && Object.values(map).some(v => v.startsWith(name + ' '))) { pending.current = name; setTimeout(() => { pending.current = null; }, 1200); return; }
      pending.current = null;
    };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [run]);
}

/** Row helpers for j/k/x/o and the row actions. Works on any view with [data-id] rows. */
export function rowIds() { return [...document.querySelectorAll<HTMLElement>('.content [data-id]')].map(r => r.dataset.id!).filter((v, n, a) => a.indexOf(v) === n); }
export function moveFocus(dir: 1 | -1, current: string | null) {
  const ids = rowIds();
  if (!ids.length) return null;
  const n = current ? ids.indexOf(current) : -1;
  const next = ids[Math.max(0, Math.min(ids.length - 1, n + dir))] ?? ids[0];
  document.querySelectorAll('.kb-focus').forEach(el => el.classList.remove('kb-focus'));
  const el = document.querySelector(`.content [data-id="${next}"]`);
  el?.classList.add('kb-focus');
  el?.scrollIntoView({block: 'nearest'});
  return next;
}
export function targetIds(focused: string | null) {
  const sel = [...document.querySelectorAll<HTMLElement>('.content [data-id].sel')].map(r => r.dataset.id!);
  return sel.length ? [...new Set(sel)] : focused ? [focused] : [];
}

export function ShortcutsDialog({close}: {close: () => void}) {
  const [map, setMap] = useState(keymap);
  const [on, setOn] = useState(shortcutsOn);
  const [recording, setRecording] = useState<ActionId | null>(null);
  useEffect(() => {
    if (!recording) return;
    let first: string | null = null, timer: number | undefined;
    const h = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (['shift', 'control', 'alt', 'meta'].includes(e.key.toLowerCase())) return;
      if (e.key === 'Escape') { setRecording(null); return; }
      const name = keyName(e);
      const commit = (v: string) => { const next = {...map, [recording]: v}; setMap(next); localStorage.setItem('keymap', JSON.stringify(next)); setRecording(null); };
      if (first) { clearTimeout(timer); commit(`${first} ${name}`); return; }
      first = name;
      timer = window.setTimeout(() => commit(first!), 700); // press a second key quickly for a sequence
    };
    addEventListener('keydown', h, true);
    return () => { removeEventListener('keydown', h, true); clearTimeout(timer); };
  }, [recording, map]);
  const clash = (id: ActionId) => (Object.keys(map) as ActionId[]).some(o => o !== id && map[o] === map[id]);
  const groups = [...new Set(ACTIONS.map(a => a.group))];
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette shortcuts" onMouseDown={e => e.stopPropagation()}>
        <div className="sc-head"><Keyboard size={16} /><b>Keyboard shortcuts</b><span className="spacer" />
          <label className="small"><input type="checkbox" checked={on} onChange={e => { setOn(e.target.checked); localStorage.setItem('shortcuts-off', e.target.checked ? '0' : '1'); }} /> Single-key shortcuts (j, k, x, s...)</label>
          <button className="btn ghost small" onClick={() => { localStorage.removeItem('keymap'); setMap(keymap()); }}><RotateCcw size={12} /> Defaults</button>
          <button className="icon" onClick={close}><X size={16} /></button></div>
        <div className="sc-body">
          {groups.map(g => <div key={g}><div className="pop-label">{g}</div>
            {ACTIONS.filter(a => a.group === g).map(a => (
              <div key={a.id} className="sc-row">
                <span className="grow">{a.label}</span>
                <button className={'kbd-btn' + (recording === a.id ? ' rec' : '') + (clash(a.id) ? ' clash' : '')} title="Click, then press the new key or two keys" onClick={() => setRecording(a.id)}>
                  {recording === a.id ? 'Press keys...' : map[a.id].split(' ').map((k, n) => <kbd key={n}>{k}</kbd>)}
                </button>
              </div>
            ))}</div>)}
          <div className="muted small" style={{padding: '8px 2px'}}>Click a shortcut to change it. Ctrl+Z and Ctrl+Shift+Z undo and redo. In lists, Enter adds a row, Tab nests it, arrow keys move between rows. Quick add understands @person !high #tag due:fri ~2h every:w sprint:now.</div>
        </div>
      </div>
    </div>
  );
}

/** Quick capture: one item per line, typed or dictated, into any project. */
export function QuickCapture({store, projectId, me, close}: {store: Store; projectId?: string; me: string; close: () => void}) {
  const [project, setProject] = useState(projectId ?? validProject(store, localStorage.getItem(`quick-project:${wsId()}`)) ?? realProjects(store.projects)[0]?.id ?? '');
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const rec = useRef<any>(null);
  const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const p = store.projects.find(x => x.id === project);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const qa = useQuickAssist(store, p?.types ?? [], text, setText);
  const first = store.people.find(x => x.id === me)?.name.split(' ')[0] ?? '';
  const toggleMic = () => {
    if (listening) { rec.current?.stop(); return; }
    const r = new SR();
    r.continuous = true; r.interimResults = false; r.lang = navigator.language || 'en-US';
    // Say "next" or "new line" to start another item.
    r.onresult = (e: any) => {
      let add = '';
      for (let n = e.resultIndex; n < e.results.length; n++) add += e.results[n][0].transcript;
      add = add.replace(/\b(next item|new line|next)\b/gi, '\n').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
      setText(t => (t && !t.endsWith('\n') ? t + ' ' : t) + add);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r; r.start(); setListening(true);
  };
  const create = async () => {
    if (!p || !lines.length) return;
    localStorage.setItem(`quick-project:${wsId()}`, project);
    for (const l of lines) await store.quickAdd(p.id, /(^|\s)@\S/.test(l) ? l : `${l} @${first}`);
    close();
  };
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette capture" onMouseDown={e => e.stopPropagation()}>
        <div className="sc-head">
          <b>Quick capture</b>
          <select className="plain-select" value={project} onChange={e => setProject(e.target.value)}>{realProjects(store.projects).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <span className="spacer" />
          {SR && <button className={'btn' + (listening ? ' danger' : '')} onClick={toggleMic} title="Dictate. Say next to start a new item">{listening ? <><MicOff size={14} /> Stop</> : <><Mic size={14} /> Dictate</>}</button>}
          <button className="icon" onClick={close}><X size={16} /></button>
        </div>
        <span className="qa-wrap" style={{display: 'block'}}>
        <textarea autoFocus className="capture-box" placeholder={'One item per line. Ctrl+Enter to add.\nCall vendor !high due:fri\nType @ to assign, ! for priority, due: for a date'} value={text} onChange={e => setText(e.target.value)} {...qa.props}
          onKeyDown={e => { if (qa.keyDown(e)) return; if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); create(); } if (e.key === 'Escape') close(); }} />
        {qa.ui}</span>
        {p && lines.length > 0 && <div className="capture-preview">
          {lines.slice(0, 8).map((l, n) => { const r = parseQuickAdd(l, store.people, store.today, p.types); return (
            <div key={n} className="small"><b>{r.title || '(no title)'}</b>{r.start && <span className="tag">starts {fmtDay(r.start)}</span>}{r.due && <span className="tag">due {fmtDay(r.due)}</span>}{r.priority ? <span className="tag">priority {r.priority}</span> : null}{r.sprint && <span className="tag">sprint {r.sprint}</span>}{r.assignees.length > 0 && <span className="tag">{r.assignees.map(id => store.people.find(x => x.id === id)?.name).join(', ')}</span>}{r.tags.map(t => <span key={t} className="tag">#{t}</span>)}</div>
          ); })}
        </div>}
        <div className="sc-head" style={{borderTop: '1px solid var(--line)', borderBottom: 0}}>
          <span className="muted small grow">Assigned to you unless you @mention someone. {!SR && 'Dictation needs Chrome or Edge.'}</span>
          <button className="btn primary" disabled={!lines.length} onClick={create}>Add {lines.length || ''} item{lines.length === 1 ? '' : 's'}</button>
        </div>
      </div>
    </div>
  );
}

export type RowAction = (ids: string[], items: Map<string, Item>) => void;
