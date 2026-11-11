import {useEffect, useState} from 'react';
import {Palette} from 'lucide-react';
import {Popover} from './components.tsx';

export type Appearance = {theme: 'light' | 'dark' | 'system'; density: 'compact' | 'comfortable' | 'spacious'; accent: string; font: 'sm' | 'md' | 'lg'};
const DEFAULT: Appearance = {theme: 'system', density: 'comfortable', accent: '#6d5dfc', font: 'md'};
export const ACCENTS = ['#6d5dfc', '#2f80ed', '#0f9d7a', '#e8590c', '#d6336c', '#7048e8', '#1c7ed6', '#495057'];

function apply(a: Appearance) {
  const root = document.documentElement;
  const dark = a.theme === 'dark' || (a.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = a.density;
  root.dataset.font = a.font;
  root.style.setProperty('--accent', a.accent);
}

export function useAppearance() {
  const [a, set] = useState<Appearance>(() => ({...DEFAULT, ...JSON.parse(localStorage.getItem('appearance') ?? '{}')}));
  useEffect(() => {
    apply(a);
    localStorage.setItem('appearance', JSON.stringify(a));
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const f = () => apply(a);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [a]);
  return [a, (patch: Partial<Appearance>) => set(prev => ({...prev, ...patch}))] as const;
}

export function AppearanceButton() {
  const [a, set] = useAppearance();
  const [open, setOpen] = useState(false);
  const seg = <K extends keyof Appearance>(key: K, opts: [Appearance[K], string][]) => (
    <div className="seg">{opts.map(([v, label]) => <button key={String(v)} className={a[key] === v ? 'on' : ''} onClick={() => set({[key]: v} as Partial<Appearance>)}>{label}</button>)}</div>
  );
  return (
    <span className="picker">
      <button className="nav-btn" onClick={() => setOpen(o => !o)}><Palette size={15} /> Appearance</button>
      <Popover open={open} onClose={() => setOpen(false)} className="up wide">
        <div className="pop-label">Theme</div>
        {seg('theme', [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']])}
        <div className="pop-label">Density</div>
        {seg('density', [['compact', 'Compact'], ['comfortable', 'Comfy'], ['spacious', 'Roomy']])}
        <div className="pop-label">Text size</div>
        {seg('font', [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']])}
        <div className="pop-label">Accent</div>
        <div className="swatches">{ACCENTS.map(c => <button key={c} className={'swatch' + (a.accent === c ? ' on' : '')} style={{background: c}} onClick={() => set({accent: c})} aria-label={c} />)}</div>
      </Popover>
    </span>
  );
}
