// Notion-style block editor. Stored as Markdown, so the API, MCP tools and exports read it as plain text.
// Type "/" on an empty line for the block menu, or use Markdown shortcuts: "# ", "- ", "1. ", "[] ", "> ", "```", "---".
// Enter adds a block, Backspace at the start merges up, Tab indents lists, Ctrl+B/I for bold/italic, paste a URL on a selection to link it.
import {canQuickView, quickView} from './QuickView.tsx';
import {Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {StoreContext, itemKey} from './components.tsx';
import {CheckSquare, Code, Heading1, Heading2, Heading3, List, ListOrdered, Minus, Quote, Text, Eye} from 'lucide-react';

type Kind = 'p' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'todo' | 'quote' | 'code' | 'divider';
type Block = {id: string; kind: Kind; text: string; checked?: boolean; indent: number};
const uid = () => Math.random().toString(36).slice(2, 9);

const MENU: {kind: Kind; label: string; hint: string; icon: typeof Text}[] = [
  {kind: 'p', label: 'Text', hint: 'Plain paragraph', icon: Text},
  {kind: 'h1', label: 'Heading 1', hint: '#', icon: Heading1}, {kind: 'h2', label: 'Heading 2', hint: '##', icon: Heading2}, {kind: 'h3', label: 'Heading 3', hint: '###', icon: Heading3},
  {kind: 'bullet', label: 'Bulleted list', hint: '-', icon: List}, {kind: 'number', label: 'Numbered list', hint: '1.', icon: ListOrdered},
  {kind: 'todo', label: 'To-do', hint: '[]', icon: CheckSquare}, {kind: 'quote', label: 'Quote', hint: '>', icon: Quote},
  {kind: 'code', label: 'Code', hint: '```', icon: Code}, {kind: 'divider', label: 'Divider', hint: '---', icon: Minus},
];

export function parseMarkdown(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    if (raw.startsWith('```')) {
      const body: string[] = [];
      while (++n < lines.length && !lines[n].startsWith('```')) body.push(lines[n]);
      out.push({id: uid(), kind: 'code', text: body.join('\n'), indent: 0});
      continue;
    }
    const indent = Math.min(4, Math.floor((/^ */.exec(raw)![0].length) / 2));
    const l = raw.trimStart();
    let m;
    if (/^---+$/.test(l)) out.push({id: uid(), kind: 'divider', text: '', indent: 0});
    else if ((m = /^(#{1,3}) (.*)$/.exec(l))) out.push({id: uid(), kind: (['h1', 'h2', 'h3'] as const)[m[1].length - 1], text: m[2], indent: 0});
    else if ((m = /^[-*] \[( |x|X)\] ?(.*)$/.exec(l))) out.push({id: uid(), kind: 'todo', text: m[2], checked: m[1] !== ' ', indent});
    else if ((m = /^[-*] (.*)$/.exec(l))) out.push({id: uid(), kind: 'bullet', text: m[1], indent});
    else if ((m = /^\d+[.)] (.*)$/.exec(l))) out.push({id: uid(), kind: 'number', text: m[1], indent});
    else if ((m = /^> ?(.*)$/.exec(l))) out.push({id: uid(), kind: 'quote', text: m[1], indent: 0});
    else out.push({id: uid(), kind: 'p', text: l, indent: 0});
  }
  // Collapse runs of empty paragraphs that Markdown uses as spacing.
  const cleaned = out.filter((b, k) => !(b.kind === 'p' && !b.text && (k === 0 || (out[k - 1].kind === 'p' && !out[k - 1].text) || ['h1', 'h2', 'h3', 'divider'].includes(out[k - 1].kind))));
  return cleaned.length ? cleaned : [{id: uid(), kind: 'p', text: '', indent: 0}];
}

export function toMarkdown(blocks: Block[]): string {
  const counters: number[] = [];
  return blocks.map(b => {
    const pad = '  '.repeat(b.indent);
    if (b.kind !== 'number') counters.length = 0; else { counters[b.indent] = (counters[b.indent] ?? 0) + 1; counters.length = b.indent + 1; }
    switch (b.kind) {
      case 'h1': return `# ${b.text}`; case 'h2': return `## ${b.text}`; case 'h3': return `### ${b.text}`;
      case 'bullet': return `${pad}- ${b.text}`; case 'todo': return `${pad}- [${b.checked ? 'x' : ' '}] ${b.text}`;
      case 'number': return `${pad}${counters[b.indent]}. ${b.text}`;
      case 'quote': return `> ${b.text}`; case 'code': return '```\n' + b.text + '\n```'; case 'divider': return '---';
      default: return b.text;
    }
  }).join('\n').replace(/\n+$/, '');
}

/** Inline Markdown for display: **bold**, *italic*, `code`, [text](url), bare links. */
function Inline({text}: {text: string}) {
  const parts: React.ReactNode[] = [];
  const re = /(\[\[[A-Za-z0-9]+-\d+\]\]|!\[[^\]]*\]\((?:https?:\/\/|\/api\/files\/)[^)\s]+\)|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('[[')) { parts.push(<ItemChip key={k++} keyText={t.slice(2, -2)} />); }
    else if (t.startsWith('![')) { const mm = /^!\[([^\]]*)\]\((.+)\)$/.exec(t)!; parts.push(/^\/api\/files\//.test(mm[2]) ? <a key={k++} href={mm[2]} onClick={e => { e.stopPropagation(); e.preventDefault(); quickView({url: mm[2], name: mm[1]}); }} title="Click for quick view"><img className="blk-img" src={mm[2]} alt={mm[1]} /></a>
      : <ExternalImage key={k++} url={mm[2]} alt={mm[1]} />); }
    else if (t.startsWith('**')) parts.push(<b key={k++}>{t.slice(2, -2)}</b>);
    else if (t.startsWith('`')) parts.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) { const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(t)!; parts.push(<span key={k++}><a href={mm[2]} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{mm[1]}</a>{canQuickView(mm[2]) && <QvButton url={mm[2]} name={mm[1]} />}</span>); }
    else if (t.startsWith('http')) parts.push(<span key={k++}><a href={t} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{t.replace(/^https?:\/\//, '').slice(0, 48)}</a>{canQuickView(t) && <QvButton url={t} />}</span>);
    else parts.push(<i key={k++}>{t.slice(1, -1)}</i>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Read-only Markdown, for AI reports and other text that should look formatted. */
export function MarkdownView({text}: {text: string}) {
  const blocks = parseMarkdown(text);
  let n = 0;
  return <div className="md-view">{blocks.map((b, k) => {
    n = b.kind === 'number' ? (blocks[k - 1]?.kind === 'number' ? n + 1 : 1) : 0;
    if (b.kind === 'divider') return <hr key={b.id} />;
    return <div key={b.id} className={`blk blk-${b.kind}`} style={{paddingLeft: b.indent * 22}}>
      {b.kind === 'bullet' && <span className="blk-mark">{'\u2022'}</span>}
      {b.kind === 'number' && <span className="blk-mark num">{n}.</span>}
      {b.kind === 'todo' && <input type="checkbox" className="blk-check" checked={!!b.checked} readOnly />}
      <div className="blk-view">{b.kind === 'code' ? <pre>{b.text}</pre> : <Inline text={b.text} />}</div>
    </div>;
  })}</div>;
}

export function BlockEditor({value, onSave, placeholder = 'Type / for blocks, or just start writing', onUploadImage}: {value: string; onSave: (md: string) => void; placeholder?: string; onUploadImage?: (f: File) => Promise<string | null>}) {
  const [blocks, setBlocks] = useState<Block[]>(() => parseMarkdown(value));
  const [focus, setFocus] = useState<{id: string; at?: number} | null>(null);
  const [menu, setMenu] = useState<{id: string; q: string; sel: number} | null>(null);
  const [linking, setLinking] = useState<{id: string; q: string; sel: number} | null>(null);
  const store = useContext(StoreContext);
  const linkOptions = useMemo(() => {
    if (!linking || !store) return [];
    const q = linking.q.toLowerCase();
    return [...store.items.values()].filter(i => !q || i.title.toLowerCase().includes(q) || itemKey(i, store.projects).toLowerCase().startsWith(q)).slice(0, 8);
  }, [linking, store]);
  const insertLink = (bid: string, key: string) => {
    const blk = blocks.find(x => x.id === bid);
    if (!blk) return;
    const text = blk.text.replace(/\[\[[^\]]*$/, `[[${key}]] `);
    update(bid, {text}); setLinking(null); setFocus({id: bid, at: text.length});
  };
  const saved = useRef(value);
  const refs = useRef(new Map<string, HTMLTextAreaElement>());

  // Take outside changes (another person, an AI agent) unless we're mid-edit.
  useEffect(() => { if (value !== saved.current && !focus) { saved.current = value; setBlocks(parseMarkdown(value)); } }, [value]);
  useEffect(() => {
    const md = toMarkdown(blocks);
    if (md === saved.current) return;
    const t = setTimeout(() => { saved.current = md; onSave(md); }, 600);
    return () => clearTimeout(t);
  }, [blocks]);
  useLayoutEffect(() => {
    if (!focus) return;
    const el = refs.current.get(focus.id);
    if (el && document.activeElement !== el) { el.focus(); const at = focus.at ?? el.value.length; el.setSelectionRange(at, at); }
    refs.current.forEach(autosize);
  });

  const update = (id: string, patch: Partial<Block>) => setBlocks(bs => bs.map(b => b.id === id ? {...b, ...patch} : b));
  const insertAfter = (id: string, b: Block) => setBlocks(bs => { const n = bs.findIndex(x => x.id === id); const c = [...bs]; c.splice(n + 1, 0, b); return c; });
  const idx = (id: string) => blocks.findIndex(b => b.id === id);
  const options = useMemo(() => menu ? MENU.filter(m => m.label.toLowerCase().includes(menu.q.toLowerCase())) : [], [menu]);
  const choose = (id: string, kind: Kind) => {
    setMenu(null);
    if (kind === 'divider') { update(id, {kind: 'divider', text: ''}); const nb = {id: uid(), kind: 'p' as Kind, text: '', indent: 0}; insertAfter(id, nb); setFocus({id: nb.id}); return; }
    update(id, {kind, text: ''});
    setFocus({id, at: 0});
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, b: Block) => {
    const el = e.currentTarget, atStart = el.selectionStart === 0 && el.selectionEnd === 0, n = idx(b.id);
    if (linking?.id === b.id && linkOptions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setLinking({...linking, sel: Math.min(linking.sel + 1, linkOptions.length - 1)}); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setLinking({...linking, sel: Math.max(linking.sel - 1, 0)}); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertLink(b.id, itemKey(linkOptions[linking.sel], store!.projects)); return; }
      if (e.key === 'Escape') { e.preventDefault(); setLinking(null); return; }
    }
    if (menu?.id === b.id) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenu({...menu, sel: Math.min(menu.sel + 1, options.length - 1)}); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenu({...menu, sel: Math.max(menu.sel - 1, 0)}); return; }
      if (e.key === 'Enter') { e.preventDefault(); if (options[menu.sel]) choose(b.id, options[menu.sel].kind); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'i')) {
      e.preventDefault();
      const mark = e.key === 'b' ? '**' : '*', s = el.selectionStart, t = el.selectionEnd;
      update(b.id, {text: b.text.slice(0, s) + mark + b.text.slice(s, t) + mark + b.text.slice(t)});
      setFocus({id: b.id, at: t + mark.length * 2});
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && b.kind !== 'code') {
      e.preventDefault();
      const listy = ['bullet', 'number', 'todo'].includes(b.kind);
      if (listy && !b.text) { update(b.id, b.indent ? {indent: b.indent - 1} : {kind: 'p'}); return; } // empty list item ends the list
      const s = el.selectionStart;
      const rest = b.text.slice(s);
      update(b.id, {text: b.text.slice(0, s)});
      const nb: Block = {id: uid(), kind: listy ? b.kind : 'p', text: rest, indent: listy ? b.indent : 0, checked: false};
      insertAfter(b.id, nb);
      setFocus({id: nb.id, at: 0});
      return;
    }
    if (e.key === 'Backspace' && atStart) {
      if (b.kind !== 'p') { e.preventDefault(); update(b.id, b.indent ? {indent: b.indent - 1} : {kind: 'p'}); return; }
      if (n > 0) {
        e.preventDefault();
        const prev = blocks[n - 1];
        if (prev.kind === 'divider') { setBlocks(bs => bs.filter(x => x.id !== prev.id)); return; }
        const at = prev.text.length;
        setBlocks(bs => bs.filter(x => x.id !== b.id).map(x => x.id === prev.id ? {...x, text: x.text + b.text} : x));
        setFocus({id: prev.id, at});
      }
      return;
    }
    if (e.key === 'Tab' && ['bullet', 'number', 'todo'].includes(b.kind)) { e.preventDefault(); update(b.id, {indent: Math.max(0, Math.min(4, b.indent + (e.shiftKey ? -1 : 1)))}); return; }
    if (e.key === 'ArrowUp' && el.selectionStart === 0 && n > 0) { e.preventDefault(); setFocus({id: blocks[n - 1].id}); return; }
    if (e.key === 'ArrowDown' && el.selectionEnd === el.value.length && n < blocks.length - 1) { e.preventDefault(); setFocus({id: blocks[n + 1].id, at: 0}); return; }
  };

  const onChange = (b: Block, text: string) => {
    // Markdown shortcuts at the start of a paragraph.
    if (b.kind === 'p') {
      const map: [RegExp, Partial<Block>][] = [[/^# $/, {kind: 'h1'}], [/^## $/, {kind: 'h2'}], [/^### $/, {kind: 'h3'}], [/^[-*] $/, {kind: 'bullet'}],
        [/^1[.)] $/, {kind: 'number'}], [/^\[ ?\] $/, {kind: 'todo', checked: false}], [/^> $/, {kind: 'quote'}], [/^```$/, {kind: 'code'}]];
      for (const [re, patch] of map) if (re.test(text)) { update(b.id, {...patch, text: ''}); return; }
      if (text === '---') { choose(b.id, 'divider'); return; }
    }
    update(b.id, {text});
    if (text.startsWith('/') && !text.includes(' ')) setMenu({id: b.id, q: text.slice(1), sel: 0}); else if (menu?.id === b.id) setMenu(null);
    // "[[" starts an item link: show matching items, Enter or click inserts [[KEY-12]].
    const m = /\[\[([^\]]*)$/.exec(text);
    setLinking(m ? {id: b.id, q: m[1], sel: 0} : null);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>, b: Block) => {
    const file = [...e.clipboardData.files].find(f => f.type.startsWith('image/'));
    if (file && onUploadImage) {
      // Pasted screenshots upload to the item and land as an image line.
      e.preventDefault();
      onUploadImage(file).then(url => { if (url) { const nb = {id: uid(), kind: 'p' as Kind, text: `![${file.name || 'screenshot'}](${url})`, indent: 0}; insertAfter(b.id, nb); } });
      return;
    }
    const pasted = e.clipboardData.getData('text');
    const el = e.currentTarget, s = el.selectionStart, t = el.selectionEnd;
    if (/^https?:\/\/\S+$/.test(pasted) && t > s) { e.preventDefault(); update(b.id, {text: b.text.slice(0, s) + `[${b.text.slice(s, t)}](${pasted})` + b.text.slice(t)}); return; }
    if (pasted.includes('\n') && b.kind !== 'code') {
      e.preventDefault();
      const extra = parseMarkdown(pasted);
      const first = extra.shift()!;
      update(b.id, {text: b.text.slice(0, s) + first.text + b.text.slice(t), ...(b.kind === 'p' && first.kind !== 'p' ? {kind: first.kind, checked: first.checked} : {})});
      setBlocks(bs => { const n = bs.findIndex(x => x.id === b.id); const c = [...bs]; c.splice(n + 1, 0, ...extra); return c; });
      if (extra.length) setFocus({id: extra[extra.length - 1].id});
    }
  };

  let number = 0;
  return (
    <div className="blocks" onClick={e => { if (e.target === e.currentTarget) { const last = blocks[blocks.length - 1]; if (last.kind === 'p' && !last.text) setFocus({id: last.id}); else { const nb = {id: uid(), kind: 'p' as Kind, text: '', indent: 0}; setBlocks(bs => [...bs, nb]); setFocus({id: nb.id}); } } }}>
      {blocks.map((b, k) => {
        number = b.kind === 'number' ? (blocks[k - 1]?.kind === 'number' ? number + 1 : 1) : 0;
        const editing = focus?.id === b.id;
        if (b.kind === 'divider') return <div key={b.id} className="blk-divider" tabIndex={0} onClick={() => setFocus({id: b.id})} onKeyDown={e => { if (e.key === 'Backspace' || e.key === 'Delete') setBlocks(bs => bs.length > 1 ? bs.filter(x => x.id !== b.id) : bs); }}><hr /></div>;
        return (
          <Fragment key={b.id}>
            <div className={`blk blk-${b.kind}`} style={{paddingLeft: b.indent * 22}}>
              {b.kind === 'bullet' && <span className="blk-mark">{'•'}</span>}
              {b.kind === 'number' && <span className="blk-mark num">{number}.</span>}
              {b.kind === 'todo' && <input type="checkbox" className="blk-check" checked={!!b.checked} onChange={e => update(b.id, {checked: e.target.checked})} />}
              {editing || !b.text
                ? <textarea ref={el => { if (el) refs.current.set(b.id, el); else refs.current.delete(b.id); }} rows={1} value={b.text}
                    className={'blk-input' + (b.kind === 'todo' && b.checked ? ' done' : '')}
                    placeholder={k === 0 && blocks.length === 1 ? placeholder : editing ? "Type '/' for commands" : ''}
                    onFocus={() => setFocus({id: b.id, at: undefined})} onBlur={() => { setTimeout(() => setFocus(f => f?.id === b.id ? null : f), 120); }}
                    onChange={e => onChange(b, e.target.value)} onKeyDown={e => onKey(e, b)} onPaste={e => onPaste(e, b)} spellCheck />
                : <div className={'blk-view' + (b.kind === 'todo' && b.checked ? ' done' : '')} onClick={() => setFocus({id: b.id})}>
                    {b.kind === 'code' ? <pre>{b.text}</pre> : <Inline text={b.text} />}
                  </div>}
            </div>
            {linking?.id === b.id && linkOptions.length > 0 && store && (
              <div className="blk-menu">
                <div className="pop-label">Link an item</div>
                {linkOptions.map((i, n) => (
                  <button key={i.id} className={'pop-row' + (n === linking.sel ? ' on' : '')} onMouseDown={e => { e.preventDefault(); insertLink(b.id, itemKey(i, store.projects)); }}>
                    <span className="muted small">{itemKey(i, store.projects)}</span><span className="grow">{i.title.slice(0, 60)}</span>
                  </button>
                ))}
              </div>
            )}
            {menu?.id === b.id && options.length > 0 && (
              <div className="blk-menu">
                {options.map((o, n) => (
                  <button key={o.kind} className={'pop-row' + (n === menu.sel ? ' on' : '')} onMouseDown={e => { e.preventDefault(); choose(b.id, o.kind); }}>
                    <o.icon size={15} /><span className="grow">{o.label}</span><span className="muted small">{o.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function autosize(el: HTMLTextAreaElement) { el.style.height = '0'; el.style.height = el.scrollHeight + 'px'; }

/** [[KEY-12]] renders as a chip with the item's title; clicking opens it. */
function ItemChip({keyText}: {keyText: string}) {
  const store = useContext(StoreContext);
  const item = store ? [...store.items.values()].find(i => itemKey(i, store.projects).toLowerCase() === keyText.toLowerCase()) : undefined;
  return <button className={'item-chip' + (item?.completed ? ' done' : '') + (item ? '' : ' missing')} title={item ? 'Open item' : 'No item with this key'}
    onClick={e => { e.stopPropagation(); if (item) dispatchEvent(new CustomEvent('open-item', {detail: item.id})); }}>
    {keyText}{item && <span>{item.title.slice(0, 40)}</span>}
  </button>;
}

/** Small eye button after a link that can be previewed (Google Drive and Docs, images, PDFs, attachments). */
function QvButton({url, name}: {url: string; name?: string}) {
  return <button className="qv-btn" title="Quick view" onClick={e => { e.stopPropagation(); e.preventDefault(); quickView({url, name}); }}><Eye size={12} /></button>;
}

/** Images from other sites wait for a click, so opening a task does not tell that site you looked. */
function ExternalImage({url, alt}: {url: string; alt: string}) {
  const [show, setShow] = useState(false);
  return show ? <img className="blk-img" src={url} alt={alt} referrerPolicy="no-referrer" onClick={e => { e.stopPropagation(); quickView({url, name: alt}); }} />
    : <button className="btn small ext-img" onClick={e => { e.stopPropagation(); setShow(true); }} title={url}>Show image from {url.replace(/^https?:\/\//, '').split('/')[0]}</button>;
}
