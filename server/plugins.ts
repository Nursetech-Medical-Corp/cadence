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
  /** What it does, one line each (shown as a list). */
  highlights?: string[];
  /** Releases, newest first. */
  changelog?: {version: string; date: string; notes: string}[];
  contributes: {
    theme?: {light?: Record<string, string>; dark?: Record<string, string>};
    features?: Feature[];
    pages?: PluginPage[];
    views?: {name: string; kind: string; config?: ViewConfig}[];
    setup?: {spaces?: SetupSpace[]; appearance?: {theme?: 'light' | 'dark' | 'system'; density?: 'compact' | 'comfortable' | 'spacious'; accent?: string; font?: 'sm' | 'md' | 'lg'}; plugins?: string[]};
    settings?: Setting[];
  };
};
export type CatalogEntry = {id: string; manifest: Manifest; owner: string; status: 'draft' | 'pending' | 'listed' | 'rejected'; note: string; created: string; updated: string; builtin: boolean; installs: number};
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

// Readability: a theme cannot make text hard to read. Checked against the app's own colors for anything it leaves out.
const BASE_THEME = {
  light: {bg: '#ffffff', bg2: '#f7f7f8', card: '#ffffff', side: '#f7f7f8', text: '#1b1b1f', text2: '#4a4a55', muted: '#8b8b96', accent: '#6d5dfc'},
  dark: {bg: '#16161a', bg2: '#1c1c21', card: '#1f1f25', side: '#131316', text: '#ececf1', text2: '#b4b4bf', muted: '#7c7c88', accent: '#6d5dfc'},
};
function luminance(c: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null; // rgb() and hsl() values are not measured
  const h = m[1].length === 3 ? [...m[1]].map(x => x + x).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map(i => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number | null {
  const x = luminance(a), y = luminance(b);
  if (x === null || y === null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function checkReadable(mode: 'light' | 'dark', vars: Record<string, string>) {
  const v = {...BASE_THEME[mode], ...vars} as Record<string, string>;
  // WCAG AA: body text 4.5:1; secondary text 3:1; white button text on the accent 3:1.
  const pairs: [string, string, number, string][] = [['text', 'bg', 4.5, 'text on the background'], ['text', 'card', 4.5, 'text on cards'], ['text', 'side', 4.5, 'text in the sidebar'],
    ['text2', 'bg', 3, 'secondary text on the background'], ['muted', 'bg', 2.2, 'faint text on the background'], ['#ffffff', 'accent', 3, 'button text on the accent']];
  for (const [f, g, min, what] of pairs) {
    const r = contrast(f.startsWith('#') ? f : v[f], v[g]);
    if (r !== null && r < min) throw new Invalid(`theme.${mode}: ${what} is too hard to read (contrast ${r.toFixed(1)}:1, needs ${min}:1). Change ${f.startsWith('#') ? g : `${f} or ${g}`}.`);
  }
}

/** Throws with a plain message when anything is out of bounds; returns a clean copy (unknown keys dropped). */
export function checkManifest(m: unknown, opts: {builtin?: boolean} = {}): Manifest {
  const x = m as Manifest;
  plain(x, 'A plugin');
  if (!x) throw new Invalid('A plugin must be an object');
  if (JSON.stringify(x).length > 3_000_000) throw new Invalid('A plugin is limited to 3 MB, screenshots included');
  if (typeof x.id !== 'string' || !ID.test(x.id)) throw new Invalid('id: lowercase letters, digits and dashes, like my-theme or publisher.my-theme');
  str(x.name, 60, 'name', true); str(x.description, 300, 'description', true); str(x.publisher, 60, 'publisher'); str(x.readme, 20000, 'readme');
  if (typeof x.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(x.version)) throw new Invalid('version must look like 1.0.0');
  if (x.icon !== undefined && !(typeof x.icon === 'string' && (IMAGE.test(x.icon) && x.icon.length < 200_000 || [...x.icon].length <= 2 && x.icon.length <= 8))) throw new Invalid('icon must be an emoji or a PNG, JPEG, WebP or GIF image (as a data URL) under 150 KB');
  // Built-in plugins point at screenshots shipped with the app; everyone else sends the image itself.
  for (const s of list(x.screenshots, 6, 'screenshots')) if (typeof s !== 'string' || !(opts.builtin ? /^\/plugin-shots\/[a-z0-9-]+\.(jpg|png|webp)$/.test(s) : IMAGE.test(s) && s.length < 900_000)) throw new Invalid('Each screenshot must be a PNG, JPEG, WebP or GIF image (as a data URL) under 650 KB');
  for (const h of list(x.highlights, 15, 'highlights')) str(h, 240, 'A highlight', true);
  for (const c of list(x.changelog, 30, 'changelog') as {version?: unknown; date?: unknown; notes?: unknown}[]) {
    plain(c, 'A changelog entry');
    if (typeof c.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(c.version)) throw new Invalid('Each changelog entry needs a version like 1.0.0');
    if (typeof c.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) throw new Invalid('Each changelog entry needs a date like 2026-11-16');
    str(c.notes, 600, 'Changelog notes', true);
  }
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
      checkReadable(mode, clean);
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
  return {id: x.id, name: x.name.trim(), version: x.version, description: x.description.trim(), publisher: x.publisher, icon: x.icon, screenshots: x.screenshots, tags: x.tags, readme: x.readme,
    highlights: x.highlights, changelog: x.changelog?.map(c => ({version: c.version, date: c.date, notes: c.notes})), contributes: out};
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
  {id: 'cadence.day-planner', name: 'Day planner', version: '1.3.0', publisher: PUB, icon: '🗓️', tags: ['planning', 'focus', 'calendar'],
    description: 'Plan today in time boxes: your top 3, a brain dump, and the hours of the day, next to your calendar.',
    screenshots: ['/plugin-shots/day-planner.jpg'],
    highlights: [
      'Top 3 for the day and a brain dump: Enter adds a line, pasting many lines adds them all.',
      'Match brain dump lines to existing tasks, or turn them into new tasks in the space you pick.',
      'The day as time boxes: drag a line or a task onto an hour, drag down or up on empty time to make a box.',
      'Drag a box to move it, its edges to change start or length. Each box has a play button that times it.',
      'Plan my day from now fills the day from your top 3, then due and overdue work, by estimate.',
      'Fit to my time moves boxes to when you actually worked, from your timers.',
      'Calendar events show on the day (Google too, once connected); Add to calendar makes a box an event with guests and Meet.',
      'Box colors match Google Calendar colors. Reminders reach your phone and desktop.',
      'Three layouts with the same features: Focus, Three columns, Timeline across. A week strip shows planned time per day.',
      'Your plan is yours only. Agents use get_day_plan, update_day_plan, schedule_day and fit_day_to_time.',
    ],
    changelog: [
      {version: '1.3.0', date: '2026-11-16', notes: 'Became a plugin, installed by default. Box colors; drag up or down to make a box.'},
      {version: '1.2.0', date: '2026-11-14', notes: 'Three layouts with the same features; week strip, day timesheet, time zones, Fit to my time.'},
      {version: '1.0.0', date: '2026-11-14', notes: 'Top 3, brain dump, today and overdue, and the day as time boxes.'},
    ],
    readme: 'Opens from the sidebar (Day planner). Removing the plugin hides the page; plans are kept and come back if it is installed again.',
    contributes: {features: ['dayPlanner']}},
  {id: 'cadence.whiteboards', name: 'Whiteboards', version: '1.2.0', publisher: PUB, icon: '🧭', tags: ['diagrams', 'workflows', 'SOP'],
    description: 'Map, design and run workflows on a canvas: flowcharts, sticky notes, tables, and one board per SOP.',
    screenshots: ['/plugin-shots/whiteboards.jpg'],
    highlights: [
      'Flow tools: start and stop, task, decision, trigger, webhook, end. Note tools: title, text, sticky, info, table, shape, frame, link.',
      'Drag from a card\'s dot toward another card: the arrow snaps to it. Decision arrows are labeled Yes, then No.',
      'Arrows route in right angles or straight, dashed or colored, with labels.',
      'Create tasks turns cards into real tasks; arrows become dependencies. Running it again makes nothing new.',
      'Run a board: tasks in order, webhooks after the steps before them, retry and skip, with a run log. Start by hand, webhook, schedule or a finished tag.',
      'One board per SOP; the Routines page links each SOP to its board.',
      'Import a Claude Whiteboards board by pasting its elements.',
      'Boards in a space follow that space\'s permissions. Agents use list_boards, create_board, update_board, run_board and more.',
    ],
    changelog: [
      {version: '1.2.0', date: '2026-11-16', notes: 'Became a plugin, installed by default.'},
      {version: '1.1.0', date: '2026-11-14', notes: 'Claude Whiteboards parity and import; tables, titles, snapping arrows.'},
      {version: '1.0.0', date: '2026-11-14', notes: 'Map, design and run workflows on a canvas.'},
    ],
    readme: 'Opens from the sidebar (Whiteboards). Removing the plugin hides the page; boards are kept.',
    contributes: {features: ['whiteboards']}},
  {id: 'cadence.midnight', name: 'Midnight theme', version: '1.0.0', publisher: PUB, icon: '🌙', tags: ['theme', 'dark'],
    description: 'A deep blue dark theme with a teal accent. Light mode stays as it is.',
    screenshots: ['/plugin-shots/midnight.jpg'],
    highlights: ['Deep navy backgrounds and panels in dark mode.', 'Teal accent for buttons, links and the timer.', 'Text colors checked for contrast against every background.', 'Light mode is not changed.'],
    changelog: [{version: '1.0.0', date: '2026-11-16', notes: 'First release.'}],
    contributes: {theme: {dark: {bg: '#0f172a', bg2: '#131c33', side: '#0b1222', hover: '#1b2540', active: '#223056', line: '#24304d', line2: '#18213a', card: '#151f38', text: '#e2e8f0', text2: '#b6c2d6', muted: '#7d8aa5', accent: '#0d9488'}}}},
  {id: 'cadence.paper', name: 'Paper theme', version: '1.0.0', publisher: PUB, icon: '📄', tags: ['theme', 'light'],
    description: 'Warm off-white backgrounds and softer lines for long reading sessions. Dark mode stays as it is.',
    screenshots: ['/plugin-shots/paper.jpg'],
    highlights: ['Warm paper backgrounds and softer lines in light mode.', 'Rust accent for buttons and links.', 'Text colors checked for contrast.', 'Dark mode is not changed.'],
    changelog: [{version: '1.0.0', date: '2026-11-16', notes: 'First release.'}],
    contributes: {theme: {light: {bg: '#fbfaf7', bg2: '#f4f1ea', side: '#f4f1ea', hover: '#ece8de', active: '#e4dfd2', line: '#e3ded2', line2: '#eeeae1', card: '#fffefb', accent: '#b4532a'}}}},
  {id: 'cadence.focus-board', name: 'My focus page', version: '1.0.0', publisher: PUB, icon: '🎯', tags: ['page', 'focus'],
    description: 'A page with your urgent and high priority work, what is due in the next 7 days, and how much is open.',
    screenshots: ['/plugin-shots/focus-page.jpg'],
    highlights: ['Adds "My focus" to the sidebar.', 'Counts the open work assigned to you.', 'Lists your urgent and high priority tasks, then what is due in the next 7 days.', 'Click any task to open it. Shows only tasks you can already see.'],
    changelog: [{version: '1.0.0', date: '2026-11-16', notes: 'First release.'}],
    contributes: {pages: [{id: 'focus', title: 'My focus', blocks: [
      {type: 'text', text: 'Work the top list first. Everything here is assigned to you and still open.'},
      {type: 'count', label: 'Open and assigned to me', mine: true, openOnly: true},
      {type: 'items', title: 'Urgent and high', mine: true, openOnly: true, limit: 30, filter: {join: 'or', rules: [{field: 'priority', op: 'is', value: '1'}, {field: 'priority', op: 'is', value: '2'}]}},
      {type: 'items', title: 'Due in the next 7 days', mine: true, openOnly: true, limit: 30, filter: {join: 'and', rules: [{field: 'due', op: 'before', value: '+8'}]}},
    ]}]}},
  {id: 'cadence.sprint-views', name: 'Sprint view set', version: '1.0.0', publisher: PUB, icon: '🏃', tags: ['views', 'sprints'],
    description: 'A board by status, an open work list and a due this week list. Add them to any space in one click.',
    screenshots: ['/plugin-shots/sprint-views.jpg'],
    highlights: ['Board grouped by status.', 'Open work: a list with done work hidden.', 'Due this week: open work due in the next 7 days.', 'Added with your permissions; if you cannot add shared views in a space, they are added as your own.'],
    changelog: [{version: '1.0.0', date: '2026-11-16', notes: 'First release.'}],
    contributes: {views: [
      {name: 'Board', kind: 'board', config: {groupBy: 'status'}},
      {name: 'Open work', kind: 'list', config: {hideDone: true}},
      {name: 'Due this week', kind: 'list', config: {hideDone: true, filter: {join: 'and', rules: [{field: 'due', op: 'before', value: '+7'}]}}},
    ]}},
];
for (const b of BUILTIN) checkManifest(b, {builtin: true});
export const builtinFeatures = BUILTIN.filter(b => b.contributes.features?.length).map(b => b.id);

// ---- Catalog (server-wide) ----
export class PluginCatalog {
  constructor(readonly db: Db) {
    db.exec(`create table if not exists plugins (id text primary key, owner text not null, status text not null, note text not null default '', manifest text not null, updated text not null);
      create table if not exists plugin_versions (id text not null, version text not null, manifest text not null, created text not null, primary key (id, version));`);
  }
  private row(r: Record<string, unknown>): CatalogEntry {
    return {id: r.id as string, manifest: JSON.parse(r.manifest as string), owner: r.owner as string, status: r.status as CatalogEntry['status'], note: r.note as string, created: (r.created as string) ?? (r.updated as string), updated: r.updated as string, builtin: false, installs: 0};
  }
  /** What one account can see: built-ins, listed plugins, and its own in any state. reviewer sees pending ones too. */
  list(owner: string | null, q = '', reviewer = false): CatalogEntry[] {
    const rows = (this.db.prepare('select p.*, (select min(created) from plugin_versions v where v.id = p.id) created from plugins p order by p.updated desc').all() as Record<string, unknown>[]).map(r => this.row(r))
      .filter(e => e.status === 'listed' || e.owner === owner || (reviewer && e.status === 'pending'));
    const all = [...BUILTIN.map(m => ({id: m.id, manifest: m, owner: PUB, status: 'listed' as const, note: '', created: m.changelog?.at(-1)?.date ?? '', updated: m.changelog?.[0]?.date ?? '', builtin: true, installs: 0})), ...rows];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter(e => words.every(w => [e.manifest.name, e.manifest.description, e.manifest.publisher ?? '', ...(e.manifest.tags ?? []), ...(e.manifest.highlights ?? [])].join(' ').toLowerCase().includes(w)));
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
