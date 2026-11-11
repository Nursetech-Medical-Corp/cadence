// "My data": a person's own export and restore.
// Export holds only what that person can see (spaces, items, comments, sprints), their own time, their private
// views and their layout preferences, so it is safe to hand to that person or take to another server.
// Import merges: preferences are mapped onto spaces and views here by name, and the person's personal spaces are
// recreated (or topped up, only when nobody else has access) as personal spaces. A personal import never changes
// shared spaces, other people's views or anyone else's preferences; the workspace backup covers those.
import type {Item, Project, View} from '../src/types.ts';
import {PRIORITIES} from '../src/types.ts';
import {personalAccess} from './auth.ts';
import {Invalid} from './errors.ts';
import type {Tasks} from './service.ts';

export type MyExport = {
  app: 'cadence-personal'; version: 1; exported: string;
  person: {id: string; name: string; email: string | null};
  prefs: Record<string, unknown>;
  spaces: {project: Project; personal: boolean; views: View[]; items: Item[]; comments: {itemId: string; author: string; body: string; created: string}[]; sprints: unknown[]}[];
  time: unknown[];
};

export function exportMine(tasks: Tasks, actor: string, canSee: (projectId: string) => boolean): MyExport {
  const me = tasks.listPeople().find(p => p.id === actor);
  if (!me) throw new Invalid('Unknown person');
  const spaces = tasks.listProjects().filter(p => canSee(p.id)).map(project => {
    const items = tasks.listItems({projectId: project.id});
    return {
      project, personal: !!project.settings.access?.private,
      views: tasks.listViews(project.id, actor),
      items,
      comments: items.flatMap(i => tasks.listComments(i.id).map(c => ({itemId: c.itemId, author: c.author, body: c.body, created: c.created}))),
      sprints: tasks.listSprints(project.id),
    };
  });
  return {
    app: 'cadence-personal', version: 1, exported: new Date().toISOString(),
    person: {id: me.id, name: me.name, email: (me as {email?: string | null}).email ?? null},
    prefs: tasks.prefs(actor), spaces, time: tasks.listTime({person: actor}),
  };
}

/** Merge a personal export into this workspace for this person. what: 'prefs' (layouts only) or 'all'. */
export function importMine(tasks: Tasks, actor: string, dump: MyExport, what: 'prefs' | 'all' = 'all') {
  if (dump?.app !== 'cadence-personal' || !Array.isArray(dump.spaces)) throw new Invalid('Not a Cadence "My data" export');
  const report = {prefs: 0, prefsSkipped: 0, spacesCreated: 0, itemsAdded: 0, viewsAdded: 0};
  const here = tasks.listProjects();
  const projMap = new Map<string, Project>(); // old project id -> project here
  const viewMap = new Map<string, string>();  // old view id -> view id here

  // Personal spaces: recreate missing ones, add items that are not there yet (matched by title and parent title).
  if (what === 'all') for (const s of dump.spaces.filter(x => x.personal && x.project.settings.access?.members?.[dump.person.id])) {
    // Only top up a space that is yours alone (private, you are the only member, nobody else invited). Anything
    // others can see is left untouched, and the restore goes into a new personal space instead.
    const solelyMine = (x: Project) => !!x.settings.access?.private && x.settings.access.default === 'none'
      && Object.keys(x.settings.access.members).length === 1 && x.settings.access.members[actor] === 'admin';
    let p = here.find(x => x.name === s.project.name && solelyMine(x));
    if (!p) {
      const taken = here.some(x => x.name === s.project.name);
      p = tasks.createProject({name: taken ? `${s.project.name} (restored)` : s.project.name, statuses: s.project.statuses, types: s.project.types, fields: s.project.fields,
        settings: {...s.project.settings, access: personalAccess(actor), rollup: undefined}, noViews: true});
      report.spacesCreated++;
    }
    projMap.set(s.project.id, p);
    const status = (old: string) => { const n = s.project.statuses.find(x => x.id === old)?.name; return p!.statuses.find(x => x.id === old || x.name === n)?.id; };
    const people = new Set(tasks.listPeople().map(x => x.id));
    const existing = tasks.listItems({projectId: p.id});
    const titleOf = new Map(existing.map(i => [i.id, i.title]));
    const has = new Set(existing.map(i => `${i.parentId ? titleOf.get(i.parentId) : ''}\u0000${i.title}`));
    const made = new Map<string, string>(); // old item id -> new id
    const oldTitle = new Map(s.items.map(i => [i.id, i.title]));
    // Parents first, so children can point at them.
    const depth = (i: Item): number => i.parentId ? 1 + depth(s.items.find(x => x.id === i.parentId) ?? ({} as Item)) : 0;
    for (const i of [...s.items].sort((a, b) => depth(a) - depth(b))) {
      const sig = `${i.parentId ? oldTitle.get(i.parentId) ?? '' : ''}\u0000${i.title}`;
      if (has.has(sig)) { const e = existing.find(x => x.title === i.title); if (e) made.set(i.id, e.id); continue; }
      const it = tasks.createItem({
        projectId: p.id, title: i.title, body: i.body, type: p.types.includes(i.type) ? i.type : undefined, status: status(i.status),
        priority: PRIORITIES[i.priority] ? i.priority : 0, assignees: i.assignees.filter(a => people.has(a)),
        start: i.start, due: i.due, estimate: i.estimate, tags: i.tags, recur: i.recur, fields: i.fields,
        parentId: i.parentId ? made.get(i.parentId) ?? null : null,
      } as Parameters<Tasks['createItem']>[0], actor);
      made.set(i.id, it.id); has.add(sig); report.itemsAdded++;
    }
    for (const v of s.views) {
      const same = tasks.listViews(p.id, actor).find(x => x.name === v.name && x.kind === v.kind);
      if (same) { viewMap.set(v.id, same.id); continue; }
      const nv = tasks.createView({projectId: p.id, name: v.name, kind: v.kind, config: {...v.config, ...(v.config.privateTo ? {privateTo: actor} : {})}, sort: v.sort});
      viewMap.set(v.id, nv.id); report.viewsAdded++;
    }
  }
  // From here on only this person's own preferences change: nothing in shared spaces, views or items.

  // Shared spaces: match by name only, to carry layout preferences over.
  for (const s of dump.spaces) {
    const p = projMap.get(s.project.id) ?? here.find(x => x.id === s.project.id) ?? here.find(x => x.name === s.project.name);
    if (!p) continue;
    projMap.set(s.project.id, p);
    const views = tasks.listViews(p.id, actor);
    for (const v of s.views) { const hit = views.find(x => x.id === v.id) ?? views.find(x => x.name === v.name && x.kind === v.kind); if (hit && !viewMap.has(v.id)) viewMap.set(v.id, hit.id); }
  }

  // Preferences: remap ids in the keys and values, skip ones that point at nothing here.
  const mapIds = (v: unknown): unknown => Array.isArray(v) ? v.map(x => typeof x === 'string' ? viewMap.get(x) ?? projMap.get(x)?.id ?? x : x) : v;
  for (const [key, value] of Object.entries(dump.prefs ?? {})) {
    const [kind, ref] = key.split(':');
    let k = key;
    if (kind === 'view') { const id = viewMap.get(ref); if (!id) { report.prefsSkipped++; continue; } k = `view:${id}`; }
    if (kind === 'views') { const p = projMap.get(ref); if (!p) { report.prefsSkipped++; continue; } k = `views:${p.id}`; }
    try { tasks.setPref(actor, k, kind === 'views' || kind === 'projects' ? mapIds(value) : value); report.prefs++; } catch { report.prefsSkipped++; }
  }
  tasks.emit({kind: 'refresh'});
  return report;
}
