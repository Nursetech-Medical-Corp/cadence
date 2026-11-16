// Skipping a routine this time (not done): shared by the status menus, the task panel and the right-click menu.
import type {Item} from './types.ts';
import type {Store} from './store.ts';

/** Live copy of a routine (not paused, not waiting, not finished): the ones that can be skipped. */
export const skippable = (item: Item) => !!item.recur && !item.recur.spawned && !item.completed && !item.recur.paused && !item.recur.waiting;
/** Not done this time: keeps a closed "Skipped" record of this cycle and moves the routine to its next date. */
export async function skipRoutine(store: Store, item: Item) {
  try {
    // Loaded here, not at the top: components.tsx imports this file and also runs outside the browser in tests.
    const {api} = await import('./store.ts');
    const res = await api<{errors?: string[]} | Item[]>('/routines/act', {method: 'POST', body: {ids: [item.id], action: 'skip'}});
    const errs = (res as {errors?: string[]}).errors;
    if (errs?.length) { store.fail(new Error(errs.join(' '))); return; }
    store.flash(`Skipped "${item.title.slice(0, 40)}". A Skipped record is kept for this time.`);
  } catch (e) { store.fail(e); }
}

