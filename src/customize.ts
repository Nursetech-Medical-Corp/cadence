// Team setup and personal changes. The team setup (shared views, tab order, project order) is what everyone
// starts from; admins keep it. Each area has a rule, set on the Team page:
//   personal  your changes are yours (kept on the server, so they follow you); you can save them for everyone
//   shared    changes apply to everyone at once (small teams)
//   locked    only admins change it; everyone else sees the team setup
import type {Area, Policy, Project, View, ViewConfig} from './types.ts';
import type {Store} from './store.ts';

export const AREAS: [Area, string, string][] = [
  ['viewSettings', 'View settings', 'Filters, sort, grouping, columns, colors and row layout'],
  ['viewOrder', 'Order of view tabs', 'Which tab comes first in a space'],
  ['projectOrder', 'Order of spaces', 'The space list in the sidebar'],
];
export const POLICIES: [Policy, string][] = [['personal', 'Each person, saved for them'], ['shared', 'Changes apply to everyone'], ['locked', 'Admins only']];

/** How a change in this area is saved for the person using the app now. Locked areas: admins change the team
 *  setup; everyone else still arranges and filters for themselves. */
export function saveMode(store: Store, area: Area): 'mine' | 'team' {
  const p = store.settings.custom[area];
  if (p === 'shared' || (p === 'locked' && store.settings.admin)) return 'team';
  return store.me ? 'mine' : 'team';
}
/** Whether this person may make their changes the team setup ("Save for everyone"). */
export const canShare = (store: Store, area: Area) => store.settings.custom[area] !== 'locked' || store.settings.admin;

/** A list in your own order when you have one (new entries keep the team order, after yours). */
function inOrder<T extends {id: string; sort: number}>(list: T[], mine: unknown): T[] {
  const order = Array.isArray(mine) ? mine as string[] : [];
  const at = (x: T) => { const n = order.indexOf(x.id); return n < 0 ? order.length + x.sort : n; };
  return [...list].sort((a, b) => at(a) - at(b));
}

export type ShownView = View & {mine?: Partial<ViewConfig>};
/** A project's views as this person sees them: their tab order, and their own settings on top of the team's. */
export function viewsFor(store: Store, projectId: string): ShownView[] {
  const personal = (a: Area) => store.settings.custom[a] !== 'shared';
  const list = store.views.filter(v => v.projectId === projectId);
  return inOrder(list, personal('viewOrder') ? store.prefs[`views:${projectId}`] : undefined).map(v => {
    const mine = personal('viewSettings') && !v.config.locked ? store.prefs[`view:${v.id}`] as Partial<ViewConfig> | undefined : undefined;
    return mine && Object.keys(mine).length ? {...v, config: {...v.config, ...mine}, mine} : v;
  });
}
export const projectsFor = (store: Store): Project[] =>
  inOrder(store.projects, store.settings.custom.projectOrder !== 'shared' ? store.prefs.projects : undefined);
