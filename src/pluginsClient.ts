// What installed plugins change in this browser: theme colors, built-in modules, extra pages.
// Safe mode (add ?safe to the address, or the switch on the Plugins page) turns every plugin off here,
// so a plugin that makes the app hard to use can always be removed.
import {useEffect} from 'react';
import type {Install, Feature, PluginPage} from '../server/plugins.ts';
import type {Store} from './store.ts';

export const safeMode = () => /[?&]safe\b/.test(location.search) || /[?&]safe\b/.test(location.hash) || localStorage.getItem('plugins-safe') === '1';

/** Enabled installs, workspace ones first so your own install of the same plugin wins. */
export function activePlugins(store: Pick<Store, 'plugins'>): Install[] {
  if (safeMode()) return [];
  const on = (store.plugins ?? []).filter(p => p.enabled);
  const mine = new Set(on.filter(p => p.scope === 'me').map(p => p.id));
  return [...on.filter(p => p.scope === 'workspace' && !mine.has(p.id)), ...on.filter(p => p.scope === 'me')];
}
export const hasFeature = (store: Pick<Store, 'plugins'>, f: Feature) => store.plugins === null || activePlugins(store).some(p => p.manifest.contributes.features?.includes(f));
export const pluginPages = (store: Pick<Store, 'plugins'>): {plugin: Install; page: PluginPage}[] =>
  activePlugins(store).flatMap(p => (p.manifest.contributes.pages ?? []).map(page => ({plugin: p, page})));

/** Applies theme variables from active plugins on top of the base theme. Values were checked on the server. */
export function usePluginTheme(store: Pick<Store, 'plugins'>) {
  const key = JSON.stringify(activePlugins(store).map(p => p.manifest.contributes.theme ?? null));
  useEffect(() => {
    const themes = JSON.parse(key) as ({light?: Record<string, string>; dark?: Record<string, string>} | null)[];
    const css = (['light', 'dark'] as const).map(mode => {
      const vars = Object.assign({}, ...themes.map(t => t?.[mode] ?? {})) as Record<string, string>;
      // Only names and values that passed the server's allow list get here; strip anything that could end the rule anyway.
      const body = Object.entries(vars).filter(([k, v]) => /^[a-z0-9]+$/.test(k) && !/[;{}<>\\]/.test(v)).map(([k, v]) => `--${k}: ${v} !important;`).join(' ');
      return body ? `${mode === 'light' ? ':root[data-theme=light]' : ':root[data-theme=dark]'} { ${body} }` : '';
    }).join('\n');
    let el = document.getElementById('plugin-theme') as HTMLStyleElement | null;
    if (!el) { el = document.createElement('style'); el.id = 'plugin-theme'; document.head.appendChild(el); }
    el.textContent = css;
  }, [key]);
}
