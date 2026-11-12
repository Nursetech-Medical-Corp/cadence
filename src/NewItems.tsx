// New items you just made: tint them for a few minutes and scroll to the newest so it never gets lost when a
// sort or filter puts it somewhere else. Settings live in your own preferences (New items menu in a view's toolbar).
import {useEffect, useState} from 'react';
import {Sparkles} from 'lucide-react';
import type {Store} from './store.ts';
import {Popover} from './components.tsx';
import {newDefaults, defaultTokens, type NewDefaults} from './QuickAssist.tsx';

type NewPrefs = {jump: boolean; tintMins: number};
export const newPrefs = (store: Pick<Store, 'prefs'>): NewPrefs => ({jump: true, tintMins: 10, ...(store.prefs.newItems as Partial<NewPrefs> | undefined)});

/** Marks rows and cards ([data-id]) of items you created in the last few minutes; scrolls to the newest one. */
export function NewItemSpotlight({store}: {store: Store}) {
  const cfg = newPrefs(store);
  useEffect(() => {
    let raf = 0;
    const apply = () => {
      raf = 0;
      const cutoff = Date.now() - cfg.tintMins * 60000;
      document.querySelectorAll<HTMLElement>('[data-id]').forEach(el => {
        const it = store.items.get(el.dataset.id!);
        const recent = cfg.tintMins > 0 && !!it && it.createdBy === store.me && Date.parse(it.created) > cutoff;
        if (recent !== el.hasAttribute('data-recent')) { if (recent) el.setAttribute('data-recent', ''); else el.removeAttribute('data-recent'); }
      });
    };
    apply();
    const obs = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(apply); });
    obs.observe(document.body, {childList: true, subtree: true});
    const t = setInterval(apply, 30000);
    return () => { obs.disconnect(); clearInterval(t); if (raf) cancelAnimationFrame(raf); };
  }, [store.items, store.me, cfg.tintMins]);
  useEffect(() => {
    if (!store.lastNew || !cfg.jump) return;
    let tries = 0, alive = true;
    const find = () => {
      if (!alive) return;
      const el = document.querySelector<HTMLElement>(`[data-id="${store.lastNew!.id}"]`);
      if (el) { el.scrollIntoView({block: 'center', behavior: 'smooth'}); el.setAttribute('data-flash', ''); setTimeout(() => el.removeAttribute('data-flash'), 2500); }
      else if (tries++ < 12) setTimeout(find, 150);
    };
    setTimeout(find, 80);
    return () => { alive = false; };
  }, [store.lastNew?.at]);
  return null;
}

/** Toolbar menu: jump to new items, how long to tint them, and the defaults added to new lines. */
export function NewItemsButton({store}: {store: Store}) {
  const [open, setOpen] = useState(false);
  const cfg = newPrefs(store), d = newDefaults(store);
  const setCfg = (p: Partial<NewPrefs>) => store.setPref('newItems', {...cfg, ...p});
  const setD = (p: Partial<NewDefaults>) => store.setPref('newDefaults', {...d, ...p});
  return <span className="picker">
    <button className={'btn' + (cfg.jump || cfg.tintMins ? ' on' : '')} title="New items: jump to them, tint them, and your default shortcuts" onClick={() => setOpen(o => !o)}><Sparkles size={14} /> New</button>
    <Popover open={open} onClose={() => setOpen(false)} className="wide">
      <div className="pop-label">When you add an item</div>
      <label className="pop-row"><input type="checkbox" checked={cfg.jump} onChange={e => setCfg({jump: e.target.checked})} /> Scroll to it and flash it</label>
      <label className="pop-row">Tint my new items for
        <select className="plain-select" value={cfg.tintMins} onChange={e => setCfg({tintMins: Number(e.target.value)})}>
          {[0, 5, 10, 30, 60, 240].map(m => <option key={m} value={m}>{m ? `${m} min` : 'off'}</option>)}
        </select></label>
      <div className="pop-sep" />
      <div className="pop-label">My defaults (Ctrl+Space in any add box)</div>
      <label className="pop-row"><input type="checkbox" checked={d.me} onChange={e => setD({me: e.target.checked})} /> Assign to me</label>
      <label className="pop-row">Due
        <select className="plain-select" value={d.due} onChange={e => setD({due: e.target.value as NewDefaults['due']})}><option value="">none</option><option value="today">today</option><option value="tomorrow">tomorrow</option><option value="+1w">in a week</option></select></label>
      <label className="pop-row">Priority
        <select className="plain-select" value={d.priority} onChange={e => setD({priority: e.target.value as NewDefaults['priority']})}><option value="">none</option><option value="urgent">urgent</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option></select></label>
      <label className="pop-row"><input type="checkbox" checked={d.auto} onChange={e => setD({auto: e.target.checked})} /> Always add them to new lines that do not set them</label>
      <div className="muted small" style={{padding: '4px 8px'}}>Adds: <code>{defaultTokens(store, '') || 'nothing'}</code>. For a color rule instead, use Colors with "Created (minutes ago) at most 10".</div>
    </Popover>
  </span>;
}
