// Quick add helper for any text box that understands quick add. Typing @, !, #, ~, due:, start:, every:, type:
// or sprint: opens a short list to pick from (arrows and Enter or Tab, or click). A small bar under the box has
// a button for each shortcut and shows what the text will set, with real dates.
import {useRef, useState, type ReactNode} from 'react';
import {Popover} from './components.tsx';
import {parseDay, parseDateWord, addDays} from './dates.ts';
import {parseQuickAdd} from './quickadd.ts';
import {describeRecur} from './recur.ts';
import type {Store} from './store.ts';

type Opt = {label: string; hint?: string; insert: string; on?: boolean};
const PRIOS: [string, string][] = [['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
const PRIO_NAME = ['', 'Urgent', 'High', 'Medium', 'Low'];
const EVERY: [string, string][] = [['d', 'Daily'], ['weekdays', 'Weekdays'], ['w', 'Weekly'], ['2w', 'Every 2 weeks'], ['m', 'Monthly'], ['3m', 'Quarterly'], ['6m', 'Twice a year'], ['y', 'Yearly'], ['2y', 'Every 2 years'], ['3y', 'Every 3 years']];
const EST: [string, string][] = [['15m', '15 minutes'], ['30m', '30 minutes'], ['1h', '1 hour'], ['2h', '2 hours'], ['4h', 'Half a day'], ['8h', 'A day']];
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const fmtDay = (iso: string) => parseDay(iso).toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});

/** The person's shortest handle the parser resolves to exactly them. */
const handle = (name: string, all: string[]) => {
  const first = name.split(' ')[0].toLowerCase();
  return all.filter(n => n.toLowerCase().startsWith(first)).length === 1 ? first : name.toLowerCase().replace(/\s+/g, '');
};

function tokenAt(text: string, caret: number) {
  let s = caret; while (s > 0 && !/\s/.test(text[s - 1])) s--;
  let e = caret; while (e < text.length && !/\s/.test(text[e])) e++;
  const t = text.slice(s, caret);
  return t ? {start: s, end: e, text: t} : null;
}

export function useQuickAssist(store: Store, types: string[], text: string, setText: (t: string) => void) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [, setTick] = useState(0);
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(0);
  const [closed, setClosed] = useState('');
  const caret = ref.current?.selectionStart ?? text.length;
  const tok = tokenAt(text, caret);
  const parsed = parseQuickAdd(text, store.people, store.today, types);

  const options = (): Opt[] => {
    if (!tok) return [];
    const t = tok.text, low = t.toLowerCase();
    if (t.startsWith('@')) {
      const q = low.slice(1), names = store.people.map(p => p.name);
      // Who is already in the text, not counting the name being typed.
      const others = parseQuickAdd(text.slice(0, tok.start) + text.slice(tok.end), store.people, store.today, types).assignees;
      return store.people.filter(p => p.name.toLowerCase().includes(q)).slice(0, 8)
        .map(p => ({label: p.name, hint: p.kind === 'ai' ? 'AI' : undefined, insert: '@' + handle(p.name, names), on: others.includes(p.id)}));
    }
    if (t.startsWith('!')) return PRIOS.filter(([k]) => k.startsWith(low.slice(1))).map(([k, l]) => ({label: l, insert: '!' + k}));
    if (t.startsWith('~')) return EST.filter(([k]) => k.startsWith(low.slice(1))).map(([k, l]) => ({label: l, insert: '~' + k}));
    if (t.startsWith('#')) {
      const q = low.slice(1), tags = new Set<string>();
      for (const i of store.items.values()) for (const g of i.tags) tags.add(g);
      const list = [...tags].filter(g => g.toLowerCase().includes(q)).sort().slice(0, 8).map(g => ({label: '#' + g, insert: '#' + g}));
      return q && !tags.has(q) ? [...list, {label: `#${t.slice(1)}`, hint: 'new tag', insert: t}] : list;
    }
    const kv = /^(due|start|every|type|sprint|sp):(.*)$/i.exec(t);
    if (!kv) return [];
    const key = kv[1].toLowerCase(), q = kv[2].toLowerCase();
    if (key === 'due' || key === 'start') {
      const words = ['today', 'tomorrow', ...Array.from({length: 7}, (_, n) => WD[parseDay(addDays(store.today, n + 2)).getDay()]), '+1w', '+2w', '+1m'];
      const list = words.filter(w => w.startsWith(q)).map(w => ({label: fmtDay(parseDateWord(w, store.today)!), hint: w, insert: `${key}:${w}`}));
      const typed = q && !words.includes(q) ? parseDateWord(q, store.today) : null;
      return typed ? [{label: fmtDay(typed), hint: q, insert: `${key}:${q}`}, ...list] : list;
    }
    if (key === 'every') return EVERY.filter(([k, l]) => k.startsWith(q) || l.toLowerCase().includes(q)).map(([k, l]) => ({label: l, insert: 'every:' + k}));
    if (key === 'type') return types.filter(x => x.toLowerCase().startsWith(q)).map(x => ({label: x, insert: 'type:' + x}));
    return [['now', 'Current sprint'], ['next', 'Next sprint'], ['backlog', 'Backlog']].filter(([k]) => k.startsWith(q)).map(([k, l]) => ({label: l, insert: `${key}:${k}`}));
  };
  const opts = options();
  const key = tok ? `${tok.start}:${tok.text}` : '';
  const open = focus && opts.length > 0 && closed !== key;
  const at = Math.min(sel, Math.max(0, opts.length - 1));

  const place = (next: string, pos: number) => {
    setText(next);
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(pos, pos); setTick(n => n + 1); });
  };
  const pick = (o: Opt) => {
    if (!tok) return;
    const before = text.slice(0, tok.start), after = text.slice(tok.end);
    const ins = o.insert + (after.startsWith(' ') ? '' : ' ');
    place(before + ins + after, before.length + ins.length);
    setSel(0);
  };
  /** Starts a shortcut at the caret, from the bar. */
  const start = (prefix: string) => {
    const c = ref.current?.selectionStart ?? text.length, pre = text.slice(0, c);
    const sp = pre && !/\s$/.test(pre) ? ' ' : '';
    place(pre + sp + prefix + text.slice(c), c + sp.length + prefix.length);
  };
  /** Call first in the box's onKeyDown. True means the key was used to pick, so skip your own handling. */
  const keyDown = (e: React.KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSel(s => (Math.min(s, opts.length - 1) + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length); return true; }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); pick(opts[at]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setClosed(key); return true; }
    return false;
  };
  const props = {
    ref, onSelect: () => setTick(n => n + 1),
    onFocus: () => setFocus(true), onBlur: () => setFocus(false),
  };

  const chips: ReactNode[] = [];
  const who = parsed.assignees.map(id => store.people.find(p => p.id === id)?.name).filter(Boolean);
  if (who.length) chips.push(<span key="a" className="qa-set">{who.join(', ')}</span>);
  if (parsed.priority) chips.push(<span key="p" className="qa-set">{PRIO_NAME[parsed.priority]}</span>);
  if (parsed.start) chips.push(<span key="s" className="qa-set">Starts {fmtDay(parsed.start)}</span>);
  if (parsed.due) chips.push(<span key="d" className="qa-set">Due {fmtDay(parsed.due)}</span>);
  if (parsed.estimate) chips.push(<span key="e" className="qa-set">{+parsed.estimate.toFixed(2)}h</span>);
  if (parsed.recur) chips.push(<span key="r" className="qa-set">{describeRecur(parsed.recur, parsed.due ?? null)}</span>);
  if (parsed.type) chips.push(<span key="t" className="qa-set">{parsed.type}</span>);
  if (parsed.sprint) chips.push(<span key="sp" className="qa-set">sprint {parsed.sprint}</span>);
  for (const g of parsed.tags) chips.push(<span key={'#' + g} className="qa-set">#{g}</span>);

  const keep = (e: React.MouseEvent) => e.preventDefault(); // clicks here keep focus in the box
  const ui = <>
    <Popover open={open} onClose={() => setClosed(key)}>
      <div className="qa-list" onMouseDown={keep}>
        {opts.map((o, n) => (
          <button key={o.insert + n} className={'pop-row' + (n === at ? ' active' : '')} onMouseEnter={() => setSel(n)} onClick={() => pick(o)}>
            <span className="grow">{o.label}</span>{o.on && <span className="muted small">added</span>}{o.hint && <span className="muted small">{o.hint}</span>}
          </button>
        ))}
        <div className="qa-keys muted">Up and down to move, Enter or Tab to pick, Esc to close</div>
      </div>
    </Popover>
    {(focus || chips.length > 0) && <div className="qa-bar" onMouseDown={keep}>
      {focus && [['@', 'person'], ['!', 'priority'], ['#', 'tag'], ['due:', 'due'], ['start:', 'start'], ['~', 'estimate'], ['every:', 'repeat'], ['type:', 'type'], ['sprint:', 'sprint']].map(([p, l]) =>
        <button key={p} className="qa-chip" title={`Insert ${p}`} onClick={() => start(p)}><b>{p}</b> {l}</button>)}
      {chips.length > 0 && <span className="qa-preview">{chips}</span>}
    </div>}
  </>;
  return {props, keyDown, ui};
}
