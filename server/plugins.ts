// Plugins: shareable add-ons made of data, never code. A plugin is a JSON manifest that can
//   - restyle the app (theme: color variables only),
//   - turn on built-in modules (features: day planner, whiteboards),
//   - add pages built from safe blocks (text, item lists, counts),
//   - offer view presets for any space, and a setup (spaces, views, appearance, other plugins) to apply,
//   - declare settings people fill in.
// Nothing in a manifest runs. The server checks every value against an allow list (colors must be colors,
// images must be PNG, JPEG, WebP or GIF data, text is shown as text), so a plugin cannot run script, load
// remote files, read other workspaces or change data. Applying views or a setup goes through the normal
// API with the person's own permissions.
//
// The catalog lives in the server-wide accounts database, so a plugin made in one workspace can be listed
// for every workspace on the server after the server owner approves it. Installs live in each workspace:
// for the whole workspace (admins) or just for me. An install keeps a copy of the version installed, so a
// later update or removal from the catalog never changes a workspace until it updates on purpose.
import type {Db} from './db.ts';
import {Invalid} from './errors.ts';
import type {FilterGroup, ViewConfig} from '../src/types.ts';

export const FEATURES = ['dayPlanner', 'whiteboards'] as const;
export type Feature = typeof FEATURES[number];
const VIEW_KINDS = ['list', 'table', 'board', 'gantt', 'backlog', 'sprint', 'calendar', 'workload', 'files'];
/** Theme variables a plugin may set. Anything else is refused. */
export const THEME_VARS = ['accent', 'bg', 'bg2', 'side', 'hover', 'active', 'line', 'line2', 'text', 'text2', 'muted', 'card', 'danger', 'ok', 'warn', 'radius'] as const;

export type Block =
  | {type: 'text'; text: string}
  | {type: 'items'; title?: string; filter?: FilterGroup; mine?: boolean; openOnly?: boolean; limit?: number}
  | {type: 'count'; label: string; filter?: FilterGroup; mine?: boolean; openOnly?: boolean};
export type PluginPage = {id: string; title: string; blocks: Block[]};
export type Setting = {key: string; label: string; type: 'text' | 'number' | 'boolean' | 'select'; options?: string[]; default?: string | number | boolean};
export type SetupSpace = {name: string; key?: string; statuses?: {id: string; name: string; category: 'todo' | 'doing' | 'done'}[]; types?: string[]; views?: {name: string; kind: string; config?: ViewConfig}[]};
export type Manifest = {
  id: string; name: string; version: string; description: string; publisher?: string; icon?: string; screenshots?: string[]; tags?: string[]; readme?: string;
  contributes: {
    theme?: {light?: Record<string, string>; dark?: Record<string, string>};
    features?: Feature[];
    pages?: PluginPage[];
    views?: {name: string; kind: string; config?: ViewConfig}[];
    setup?: {spaces?: SetupSpace[]; appearance?: {theme?: 'light' | 'dark' | 'system'; density?: 'compact' | 'comfortable' | 'spacious'; accent?: string; font?: 'sm' | 'md' | 'lg'}; plugins?: string[]};
    settings?: Setting[];
  };
};
export type CatalogEntry = {id: string; manifest: Manifest; owner: string; status: 'draft' | 'pending' | 'listed' | 'rejected'; note: string; updated: string; builtin: boolean; installs: number};
export type Install = {id: string; scope: 'workspace' | 'me'; version: string; manifest: Manifest; enabled: boolean; settings: Record<string, unknown>; at: string};

// ---- Checks ----
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/+-]{1,60}\))$/i;
const LENGTH = /^\d{1,2}(\.\d)?px$/;
const IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const ID = /^[a-z0-9][a-z0-9-]{1,40}(\.[a-z0-9][a-z0-9-]{1,40})?$/;
const str = (v: unknown, max: number, what: string, need = false) => {
  if (v === undefined && !need) return;
  if (typeof v !== 'string' || (need && !v.trim())) throw new Invalid(`${what} is required as text`);
  if (v.length > max) throw new Invalid(`${what} is over ${max} characters`);
};
const list = (v: unknown, max: number, what: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Invalid(`${what} must be a list`);
  if (v.length > max) throw new Invalid(`${what}: at most ${max}`);
  return v;
};
const plain = (v: unknown, what: string) => { if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) throw new Invalid(`${what} must be an object`); };

function checkFilter(g: unknown, depth = 0) {
  if (g === undefined) return;
  const x = g as FilterGroup;
  plain(x, 'A filter');
  if (!['and', 'or'].includes(x.join) || !Array.isArray(x.rules) || x.rules.length > 30 || depth > 2) throw new Invalid('A filter needs join (and or or) and up to 30 rules');
  for (const r of x.rules) {
    if ('rules' in (r as object)) checkFilter(r, depth + 1);
    else { const f = r as {field?: unknown; op?: unknown; value?: unknown}; str(f.field, 60, 'A filter field', true); str(f.op, 20, 'A filter op', true); str(f.value, 200, 'A filter value'); }
  }
}

/** Throws with a plain message when anything is out of bounds; returns a clean copy (unknown keys dropped). */
export function checkManifest(m: unknown): Manifest {
  const x = m as Manifest;
  plain(x, 'A plugin');
  if (!x) throw new Invalid('A plugin must be an object');
  if (JSON.stringify(x).length > 3_000_000) throw new Invalid('A plugin is limited to 3 MB, screenshots included');
  if (typeof x.id !== 'string' || !ID.test(x.id)) throw new Invalid('id: lowercase letters, digits and dashes, like my-theme or publisher.my-theme');
  str(x.name, 60, 'name', true); str(x.description, 300, 'description', true); str(x.publisher, 60, 'publisher'); str(x.readme, 20000, 'readme');
  if (typeof x.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(x.version)) throw new Invalid('version must look like 1.0.0');
  if (x.icon !== undefined && !(typeof x.icon === 'string' && (IMAGE.test(x.icon) && x.icon.length < 200_000 || [...x.icon].length <= 2 && x.icon.length <= 8))) throw new Invalid('icon must be an emoji or a PNG, JPEG, WebP or GIF image (as a data URL) under 150 KB');
  for (const s of list(x.screenshots, 4, 'screenshots')) if (typeof s !== 'string' || !IMAGE.test(s) || s.length > 900_000) throw new Invalid('Each screenshot must be a PNG, JPEG, WebP or GIF image (as a data URL) under 650 KB');
  for (const t of list(x.tags, 8, 'tags')) str(t, 30, 'A tag', true);
  plain(x.contributes, 'contributes');
  const c = x.contributes ?? {};
  const out: Manifest['contributes'] = {};
  if (c.theme !== undefined) {
    plain(c.theme, 'theme');
    out.theme = {};
    for (const mode of ['light', 'dark'] as const) {
      const vars = c.theme[mode];
      if (vars === undefined) continue;
      plain(vars, `theme.${mode}`);
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) {
        if (!(THEME_VARS as readonly string[]).includes(k)) throw new Invalid(`theme.${mode}.${k}: plugins may set only ${THEME_VARS.join(', ')}`);
        if (typeof v !== 'string' || !(k === 'radius' ? LENGTH.test(v) : COLOR.test(v.trim()))) throw new Invalid(`theme.${mode}.${k}: ${k === 'radius' ? 'use a size like 8px' : 'use a color like #1f2937 or rgb(31 41 55)'}`);
        clean[k] = v.trim();
      }
      out.theme[mode] = clean;
    }
  }
  if (c.features !== undefined) {
    for (const f of list(c.features, FEATURES.length, 'features')) if (!(FEATURES as readonly string[]).includes(f as string)) throw new Invalid(`features: one of ${FEATURES.join(', ')}`);
    out.features = [...new Set(c.features)];
  }
  if (c.pages !== undefined) {
    const ids = new Set<string>();
    for (const p of list(c.pages, 10, 'pages') as PluginPage[]) {
      plain(p, 'A page');
      if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.id) || ids.has(p.id)) throw new Invalid('Each page needs a unique id of lowercase letters, digits and dashes');
      ids.add(p.id);
      str(p.title, 60, 'A page title', true);
      for (const b of list(p.blocks, 30, `Blocks of page ${p.id}`) as Block[]) {
        plain(b, 'A block');
        if (b.type === 'text') str(b.text, 5000, 'A text block', true);
        else if (b.type === 'items' || b.type === 'count') {
          if (b.type === 'items') { str(b.title, 80, 'A list title'); if (b.limit !== undefined && !(Number.isInteger(b.limit) && b.limit > 0 && b.limit <= 200)) throw new Invalid('limit must be 1 to 200'); }
          else str(b.label, 80, 'A count label', true);
          checkFilter(b.filter);
        } else throw new Invalid('Block type must be text, items or count');
      }
    }
    out.pages = c.pages.map(p => ({id: p.id, title: p.title, blocks: p.blocks.map(b => b.type === 'text' ? {type: 'text', text: b.text}
      : b.type === 'items' ? {type: 'items', title: b.title, filter: b.filter, mine: !!b.mine, openOnly: b.openOnly !== false, limit: b.limit ?? 50}
      : {type: 'count', label: b.label, filter: b.filter, mine: !!b.mine, openOnly: b.openOnly !== false})}));
  }
  const checkViews = (vs: unknown, what: string) => {
    for (const v of list(vs, 20, what) as {name: string; kind: string; config?: ViewConfig}[]) {
      plain(v, 'A view'); str(v.name, 60, 'A view name', true);
      if (!VIEW_KINDS.includes(v.kind)) throw new Invalid(`A view kind must be one of: ${VIEW_KINDS.join(', ')}`);
      plain(v.config, 'View settings');
      if (v.config && JSON.stringify(v.config).length > 50_000) throw new Invalid('View settings are limited to 50 KB');
      checkFilter(v.config?.filter);
    }
  };
  if (c.views !== undefined) { checkViews(c.views, 'views'); out.views = c.views.map(v => ({name: v.name, kind: v.kind, config: v.config ?? {}})); }
  if (c.setup !== undefined) {
    plain(c.setup, 'setup');
    for (const s of list(c.setup.spaces, 20, 'setup.spaces') as SetupSpace[]) {
      plain(s, 'A space'); str(s.name, 60, 'A space name', true);
      if (s.key !== undefined && !/^[A-Z][A-Z0-9]{1,5}$/.test(s.key)) throw new Invalid('A space key is 2 to 6 capital letters or digits, like OPS');
      for (const st of list(s.statuses, 20, 'statuses') as SetupSpace['statuses'] & object[]) { plain(st, 'A status'); str(st.id, 30, 'A status id', true); str(st.name, 40, 'A status name', true); if (!['todo', 'doing', 'done'].includes(st.category)) throw new Invalid('A status category is todo, doing or done'); }
      if (s.statuses?.length && !s.statuses.some(st => st.category === 'done')) throw new Invalid(`Space ${s.name} needs a done status`);
      for (const t of list(s.types, 10, 'types')) str(t, 30, 'A level name', true);
      checkViews(s.views, 'space views');
    }
    const a = c.setup.appearance;
    if (a !== undefined) {
      plain(a, 'appearance');
      if (a.theme !== undefined && !['light', 'dark', 'system'].includes(a.theme)) throw new Invalid('appearance.theme is light, dark or system');
      if (a.density !== undefined && !['compact', 'comfortable', 'spacious'].includes(a.density)) throw new Invalid('appearance.density is compact, comfortable or spacious');
      if (a.font !== undefined && !['sm', 'md', 'lg'].includes(a.font)) throw new Invalid('appearance.font is sm, md or lg');
      if (a.accent !== undefined && !(typeof a.accent === 'string' && /^#[0-9a-f]{6}$/i.test(a.accent))) throw new Invalid('appearance.accent is a color like #6d5dfc');
    }
    for (const p of list(c.setup.plugins, 20, 'setup.plugins')) if (typeof p !== 'string' || !ID.test(p)) throw new Invalid('setup.plugins lists plugin ids');
    out.setup = {spaces: c.setup.spaces, appearance: a, plugins: c.setup.plugins};
  }
  if (c.settings !== undefined) {
    for (const s of list(c.settings, 20, 'settings') as Setting[]) {
      plain(s, 'A setting');
      if (typeof s.key !== 'string' || !/^[a-zA-Z][\w-]{0,30}$/.test(s.key)) throw new Invalid('A setting key is a short word');
      str(s.label, 80, 'A setting label', true);
      if (!['text', 'number', 'boolean', 'select'].includes(s.type)) throw new Invalid('A setting type is text, number, boolean or select');
      if (s.type === 'select') for (const o of list(s.options, 30, 'options')) str(o, 60, 'An option', true);
    }
    out.settings = c.settings.map(s => ({key: s.key, label: s.label, type: s.type, options: s.options, default: s.default}));
  }
  if (!Object.keys(out).length) throw new Invalid('A plugin must contribute something: theme, features, pages, views, setup or settings');
  return {id: x.id, name: x.name.trim(), version: x.version, description: x.description.trim(), publisher: x.publisher, icon: x.icon, screenshots: x.screenshots, tags: x.tags, readme: x.readme, contributes: out};
}

/** Plain-language list of what a plugin changes, shown before anyone installs it. */
export function pluginEffects(m: Manifest): string[] {
  const c = m.contributes, out: string[] = [];
  if (c.theme) out.push('Changes colors (light and dark themes)');
  if (c.features?.length) out.push(`Turns on: ${c.features.map(f => f === 'dayPlanner' ? 'Day planner' : 'Whiteboards').join(', ')}`);
  if (c.pages?.length) out.push(`Adds pages: ${c.pages.map(p => p.title).join(', ')} (read only lists and text)`);
  if (c.views?.length) out.push(`Offers ${c.views.length} view preset${c.views.length > 1 ? 's' : ''} you can add to a space`);
  if (c.setup) out.push('Has a setup you can apply: spaces, views, appearance and plugins, with your own permissions');
  if (c.settings?.length) out.push(`Has ${c.settings.length} setting${c.settings.length > 1 ? 's' : ''}`);
  out.push('Runs no code and cannot read or change your data by itself');
  return out;
}

// ---- Built-in plugins from Cadence ----
const PUB = 'Cadence';
export const BUILTIN: Manifest[] = [
  {id: 'cadence.day-planner', name: 'Day planner', version: '1.0.0', publisher: PUB, icon: '🗓️', tags: ['planning', 'focus'],
    description: 'Top 3, brain dump and time boxes for today, with focus, three column and timeline layouts.',
    readme: 'Adds the Day planner page to the sidebar. Plan today in time boxes, drag tasks in, and fit the day to the time you have.',
    contributes: {features: ['dayPlanner']}},
  {id: 'cadence.whiteboards', name: 'Whiteboards', version: '1.0.0', publisher: PUB, icon: '🧭', tags: ['diagrams', 'workflows'],
    description: 'Map, design and run workflows on a canvas: flowcharts, sticky notes, tables, one board per SOP.',
    readme: 'Adds the Whiteboards page to the sidebar. Boards in a space follow that space\'s permissions.',
    contributes: {features: ['whiteboards']}},
  {id: 'cadence.midnight', name: 'Midnight theme', version: '1.0.0', publisher: PUB, icon: '🌙', tags: ['theme'],
    description: 'A deep blue dark theme with a teal accent. Light mode stays as is.',
    contributes: {theme: {dark: {bg: '#0f172a', bg2: '#131c33', side: '#0b1222', hover: '#1b2540', active: '#223056', line: '#24304d', line2: '#18213a', card: '#151f38', text: '#e2e8f0', text2: '#b6c2d6', muted: '#7d8aa5', accent: '#14b8a6'}}}},
  {id: 'cadence.paper', name: 'Paper theme', version: '1.0.0', publisher: PUB, icon: '📄', tags: ['theme'],
    description: 'Warm off-white backgrounds and softer lines for long reading sessions.',
    contributes: {theme: {light: {bg: '#fbfaf7', bg2: '#f4f1ea', side: '#f4f1ea', hover: '#ece8de', active: '#e4dfd2', line: '#e3ded2', line2: '#eeeae1', card: '#fffefb', accent: '#b4532a'}}}},
  {id: 'cadence.focus-board', name: 'My focus page', version: '1.0.0', publisher: PUB, icon: '🎯', tags: ['page', 'focus'],
    description: 'A page with your urgent and high priority work, what is due soon and how much is open.',
    contributes: {pages: [{id: 'focus', title: 'My focus', blocks: [
      {type: 'text', text: 'Work the top list first. Everything here is assigned to you and still open.'},
      {type: 'count', label: 'Open and assigned to me', mine: true, openOnly: true},
      {type: 'items', title: 'Urgent and high', mine: true, openOnly: true, limit: 30, filter: {join: 'or', rules: [{field: 'priority', op: 'is', value: '1'}, {field: 'priority', op: 'is', value: '2'}]}},
      {type: 'items', title: 'Due in the next 7 days', mine: true, openOnly: true, limit: 30, filter: {join: 'and', rules: [{field: 'due', op: 'before', value: '+8'}]}},
    ]}]}},
  {id: 'cadence.sprint-views', name: 'Sprint view set', version: '1.0.0', publisher: PUB, icon: '🏃', tags: ['views'],
    description: 'Board by status, open work and a this-week list. Add them to any space in one click.',
    contributes: {views: [
      {name: 'Board', kind: 'board', config: {groupBy: 'status'}},
      {name: 'Open work', kind: 'list', config: {hideDone: true}},
      {name: 'Due this week', kind: 'list', config: {hideDone: true, filter: {join: 'and', rules: [{field: 'due', op: 'before', value: '+7'}]}}},
    ]}},
];
for (const b of BUILTIN) checkManifest(b);
export const builtinFeatures = BUILTIN.filter(b => b.contributes.features?.length).map(b => b.id);

// ---- Catalog (server-wide) ----
export class PluginCatalog {
  constructor(readonly db: Db) {
    db.exec(`create table if not exists plugins (id text primary key, owner text not null, status text not null, note text not null default '', manifest text not null, updated text not null);
      create table if not exists plugin_versions (id text not null, version text not null, manifest text not null, created text not null, primary key (id, version));`);
  }
  private row(r: Record<string, unknown>): CatalogEntry {
    return {id: r.id as string, manifest: JSON.parse(r.manifest as string), owner: r.owner as string, status: r.status as CatalogEntry['status'], note: r.note as string, updated: r.updated as string, builtin: false, installs: 0};
  }
  /** What one account can see: built-ins, listed plugins, and its own in any state. reviewer sees pending ones too. */
  list(owner: string | null, q = '', reviewer = false): CatalogEntry[] {
    const rows = (this.db.prepare('select * from plugins order by updated desc').all() as Record<string, unknown>[]).map(r => this.row(r))
      .filter(e => e.status === 'listed' || e.owner === owner || (reviewer && e.status === 'pending'));
    const all = [...BUILTIN.map(m => ({id: m.id, manifest: m, owner: PUB, status: 'listed' as const, note: '', updated: '', builtin: true, installs: 0})), ...rows];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter(e => words.every(w => [e.manifest.name, e.manifest.description, e.manifest.publisher ?? '', ...(e.manifest.tags ?? [])].join(' ').toLowerCase().includes(w)));
  }
  get(id: string, owner: string | null, reviewer = false): CatalogEntry {
    const e = this.list(owner, '', reviewer).find(x => x.id === id);
    if (!e) throw new Invalid('No such plugin');
    return e;
  }
  /** Create or update a plugin you own. A new version of a listed plugin goes back to review; the listed one stays until then. */
  save(m: unknown, owner: string) {
    const man = checkManifest(m);
    if (man.id.startsWith('cadence.')) throw new Invalid('Ids starting with cadence. are for built-in plugins. Use your own prefix, like acme.my-theme');
    const cur = this.db.prepare('select owner, status, manifest from plugins where id = ?').get(man.id) as {owner: string; status: string; manifest: string} | undefined;
    if (cur && cur.owner !== owner) throw new Invalid('That plugin id belongs to someone else. Pick another id.');
    const now = new Date().toISOString();
    if (this.db.prepare('select 1 from plugin_versions where id = ? and version = ?').get(man.id, man.version) && cur && JSON.parse(cur.manifest).version !== man.version)
      throw new Invalid(`Version ${man.version} was already published. Raise the version.`);
    this.db.prepare('insert or replace into plugin_versions (id, version, manifest, created) values (?,?,?,?)').run(man.id, man.version, JSON.stringify(man), now);
    // Editing a listed plugin keeps it listed only when it is the same version (small fixes go to review again).
    const status = cur?.status === 'listed' ? 'pending' : cur?.status === 'pending' ? 'pending' : 'draft';
    this.db.prepare('insert or replace into plugins (id, owner, status, note, manifest, updated) values (?,?,?,?,?,?)').run(man.id, owner, status, '', JSON.stringify(man), now);
    return this.get(man.id, owner);
  }
  submit(id: string, owner: string) {
    const r = this.db.prepare('select owner from plugins where id = ?').get(id) as {owner: string} | undefined;
    if (!r || r.owner !== owner) throw new Invalid('You can only submit your own plugins');
    this.db.prepare("update plugins set status = 'pending', note = '', updated = ? where id = ?").run(new Date().toISOString(), id);
    return this.get(id, owner);
  }
  review(id: string, approve: boolean, note = '') {
    const r = this.db.prepare('select status from plugins where id = ?').get(id) as {status: string} | undefined;
    if (!r) throw new Invalid('No such plugin');
    this.db.prepare('update plugins set status = ?, note = ?, updated = ? where id = ?').run(approve ? 'listed' : 'rejected', String(note).slice(0, 500), new Date().toISOString(), id);
  }
  remove(id: string, owner: string, reviewer = false) {
    const r = this.db.prepare('select owner from plugins where id = ?').get(id) as {owner: string} | undefined;
    if (!r || (r.owner !== owner && !reviewer)) throw new Invalid('You can only remove your own plugins');
    this.db.prepare('delete from plugins where id = ?').run(id);
  }
}

// ---- Installs (per workspace) ----
export function migratePluginInstalls(db: Db) {
  const fresh = !db.prepare("select 1 from sqlite_master where type = 'table' and name = 'plugin_installs'").get();
  db.exec("create table if not exists plugin_installs (id text not null, person text not null default '', version text not null, manifest text not null, enabled integer not null default 1, settings text not null default '{}', at text not null, primary key (id, person))");
  // The day planner and whiteboards start installed for the whole workspace (they were built in before); admins can remove them.
  if (fresh)
    for (const id of builtinFeatures) { const m = BUILTIN.find(b => b.id === id)!; db.prepare("insert or ignore into plugin_installs (id, person, version, manifest, at) values (?, '', ?, ?, ?)").run(id, m.version, JSON.stringify(m), new Date().toISOString()); }
}
const toInstall = (r: Record<string, unknown>): Install => ({id: r.id as string, scope: r.person ? 'me' : 'workspace', version: r.version as string, manifest: JSON.parse(r.manifest as string), enabled: !!r.enabled, settings: JSON.parse(r.settings as string), at: r.at as string});
export function listInstalls(db: Db, person: string | null): Install[] {
  return (db.prepare("select * from plugin_installs where person = '' or person = ? order by at").all(person ?? '\u0000') as Record<string, unknown>[]).map(toInstall);
}
export function install(db: Db, m: Manifest, scope: 'workspace' | 'me', person: string | null) {
  if (scope === 'me' && !person) throw new Invalid('Sign in to install a plugin for yourself');
  const who = scope === 'me' ? person! : '';
  const cur = db.prepare('select settings from plugin_installs where id = ? and person = ?').get(m.id, who) as {settings: string} | undefined;
  db.prepare('insert or replace into plugin_installs (id, person, version, manifest, enabled, settings, at) values (?,?,?,?,1,?,?)').run(m.id, who, m.version, JSON.stringify(m), cur?.settings ?? '{}', new Date().toISOString());
}
export function uninstall(db: Db, id: string, scope: 'workspace' | 'me', person: string | null) {
  db.prepare('delete from plugin_installs where id = ? and person = ?').run(id, scope === 'me' ? person ?? '\u0000' : '');
}
export function setInstall(db: Db, id: string, scope: 'workspace' | 'me', person: string | null, patch: {enabled?: boolean; settings?: Record<string, unknown>}) {
  const who = scope === 'me' ? person ?? '\u0000' : '';
  const r = db.prepare('select * from plugin_installs where id = ? and person = ?').get(id, who) as Record<string, unknown> | undefined;
  if (!r) throw new Invalid('That plugin is not installed there');
  const cur = toInstall(r);
  if (patch.settings !== undefined) {
    if (typeof patch.settings !== 'object' || patch.settings === null || JSON.stringify(patch.settings).length > 20_000) throw new Invalid('Settings must be an object under 20 KB');
    const keys = new Set((cur.manifest.contributes.settings ?? []).map(s => s.key));
    for (const k of Object.keys(patch.settings)) if (!keys.has(k)) throw new Invalid(`This plugin has no setting called ${k}`);
  }
  db.prepare('update plugin_installs set enabled = ?, settings = ? where id = ? and person = ?').run((patch.enabled ?? cur.enabled) ? 1 : 0, JSON.stringify(patch.settings ?? cur.settings), id, who);
}
