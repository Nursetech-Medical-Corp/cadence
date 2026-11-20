// A tab left open keeps running the version it loaded. When a newer version is live, a bar asks to reload, so
// people do not use old code after a release. Checked every 2 minutes and whenever the tab comes back into view.
import {useEffect, useState} from 'react';
import {RefreshCw} from 'lucide-react';

/** The app's main script in a page of HTML, like /assets/index-AbC123.js. */
export const mainScript = (html: string) => /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? null;

export function UpdateBar() {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    const mine = [...document.scripts].map(s => s.src && new URL(s.src).pathname).find(p => p && mainScript(p)) ?? null;
    if (!mine) return; // the dev server has no built files
    const check = async () => {
      if (document.hidden) return;
      try {
        const live = mainScript(await (await fetch('/', {cache: 'no-store'})).text());
        if (live && live !== mine) setNewer(true);
      } catch { /* offline: try again later */ }
    };
    const t = setInterval(check, 120_000);
    addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    void check();
    return () => { clearInterval(t); removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, []);
  if (!newer) return null;
  return <div className="notify-prompt update-bar" role="status">
    <RefreshCw size={16} />
    <span className="grow"><b>Cadence was updated.</b> Reload to get the latest version.</span>
    <button className="btn primary" onClick={() => location.reload()}>Reload</button>
  </div>;
}
