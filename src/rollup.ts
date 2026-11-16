// Adding items while looking at a rollup (like All spaces). A rollup holds no items, so each new item needs a real space.
import type {Project} from './types.ts';

/** The real spaces a rollup shows, in sidebar order. */
export function rollupSpaces(ps: Project[], rollup: Project): Project[] {
  const inc = rollup.settings.rollup?.include;
  return ps.filter(p => !p.settings.rollup && (!inc || inc.includes(p.id))).sort((a, b) => a.sort - b.sort);
}

/** Where new items go when added in rollup pid: your pick for it (prefs.rollupAdd), else its first space. Undefined for a normal space. */
export function rollupTarget(ps: Project[], prefs: Record<string, unknown>, pid: string): Project | undefined {
  const p = ps.find(x => x.id === pid);
  if (!p?.settings.rollup) return undefined;
  const spaces = rollupSpaces(ps, p);
  const pick = (prefs.rollupAdd as Record<string, string> | undefined)?.[pid];
  return spaces.find(x => x.id === pick) ?? spaces[0];
}

/** Spaces a rollup shows. "All spaces" leaves out list spaces (records, not tasks) unless it is a built-in one (Routines). */
export const includedIn = (rollup: Project, all: Project[]) =>
  all.filter(p => p.id !== rollup.id && !p.settings.rollup && (rollup.settings.rollup!.include ? rollup.settings.rollup!.include.includes(p.id) : (!p.settings.records || !!rollup.settings.rollup!.scope)));
