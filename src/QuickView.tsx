// Quick view: look at an attached image, PDF or text file, or a Google Drive, Docs, Sheets or Slides link,
// without leaving the task. Anything can open it with quickView({url, name}). Esc or a click outside closes it.
import {useEffect, useState} from 'react';
import {Download, ExternalLink, X} from 'lucide-react';

type Target = {url: string; name?: string; mime?: string};
export const quickView = (t: Target) => dispatchEvent(new CustomEvent('quick-view', {detail: t}));

/** Google files open in their preview mode, which works inside a frame for anyone who can see the file. */
export function previewUrl(url: string): string | null {
  const drive = /^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/.exec(url);
  if (drive) return `https://drive.google.com/file/d/${drive[1]}/preview`;
  const doc = /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/.exec(url);
  if (doc) return `https://docs.google.com/${doc[1]}/d/${doc[2]}/preview`;
  if (url.startsWith('/api/files/')) return url;
  return null;
}
export const canQuickView = (url: string) => !!previewUrl(url) || /\.(png|jpe?g|gif|webp|pdf)(\?|$)/i.test(url);

export function QuickViewHost() {
  const [t, setT] = useState<Target | null>(null);
  useEffect(() => {
    const f = (e: Event) => setT((e as CustomEvent<Target>).detail);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setT(null); };
    addEventListener('quick-view', f); addEventListener('keydown', k);
    return () => { removeEventListener('quick-view', f); removeEventListener('keydown', k); };
  }, []);
  if (!t) return null;
  const isImage = (t.mime ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(t.name ?? t.url);
  const src = previewUrl(t.url) ?? t.url;
  return (
    <div className="overlay qv" onMouseDown={() => setT(null)}>
      <div className="qv-box" onMouseDown={e => e.stopPropagation()}>
        <div className="qv-head">
          <b className="grow">{t.name ?? t.url.replace(/^https?:\/\//, '').slice(0, 80)}</b>
          {t.url.startsWith('/api/files/') && <a className="btn small" href={t.url} download={t.name}><Download size={13} /> Download</a>}
          <a className="btn small" href={t.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open</a>
          <button className="icon" onClick={() => setT(null)} title="Close (Esc)"><X size={16} /></button>
        </div>
        <div className="qv-body">{isImage ? <img src={src} alt={t.name ?? ''} />
          : src.startsWith('/api/files/') ? <iframe src={src} title={t.name ?? 'Preview'} /> // our own files: no sandbox, so Chrome's PDF viewer works
          : <iframe src={src} title={t.name ?? 'Preview'} sandbox="allow-scripts allow-same-origin allow-popups" />}</div>
      </div>
    </div>
  );
}
