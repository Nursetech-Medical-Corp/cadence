# Plugins

Plugins change how Cadence looks and what it shows, without code. A plugin is one JSON file (a manifest).
People find plugins on the Plugins page (sidebar, Workspace), install them for themselves or for the whole
workspace, turn them off without removing them, and make their own.

## Why plugins cannot break Cadence

- **Data only.** A manifest never runs. There is no place for script, HTML, CSS rules or links to other sites.
- **Allow lists.** The server checks every value before saving: theme values must be colors (or a size for
  `radius`), images must be PNG, JPEG, WebP or GIF data (no SVG, no web links), text is shown as text, ids and
  keys follow fixed patterns, and sizes are capped (3 MB per plugin). Unknown keys are dropped.
- **Your permissions.** Applying view presets or a setup goes through the normal API as you. A plugin cannot
  do anything you could not do by hand, and it cannot read other workspaces or other people's data.
- **Pinned versions.** An install keeps a copy of the version installed. Updating or deleting a plugin in the
  store never changes a workspace until someone installs the new version.
- **Review.** Drafts are seen only by their maker. Only plugins the server owner approved can be installed for
  a whole workspace. A new version of an approved plugin goes back to review.
- **Undo and safe mode.** Turn a plugin off (it stays installed) or remove it in one click. Safe mode turns every
  plugin off in your browser: the switch on the Plugins page, or add `?safe` to the address (for example
  `https://cadence.example.com/?safe#/plugins`) if a theme made the page hard to read.

## Format

```json
{
  "id": "acme.calm-theme",
  "name": "Calm theme",
  "version": "1.0.0",
  "description": "One line on what it does.",
  "publisher": "Acme",
  "icon": "🌿",
  "screenshots": ["data:image/png;base64,..."],
  "tags": ["theme"],
  "readme": "Longer notes, shown as plain text.",
  "contributes": { "theme": {}, "features": [], "pages": [], "views": [], "setup": {}, "settings": [] }
}
```

- `id`: lowercase letters, digits and dashes, with an optional `publisher.` prefix. `cadence.` is reserved.
- `version`: `1.2.3`. Raise it for each release.
- `icon`: an emoji, or an image as a data URL under 150 KB. Up to 4 `screenshots`, each under 650 KB.
- `contributes` needs at least one of:

| Part | What it does | Shape |
| --- | --- | --- |
| `theme` | Colors for light and dark mode | `{light: {accent: "#0f766e"}, dark: {...}}`. Names: `accent bg bg2 side hover active line line2 text text2 muted card danger ok warn radius` |
| `features` | Turns on built-in modules | `["dayPlanner", "whiteboards"]` |
| `pages` | New pages in the sidebar, made of blocks | `[{id: "home", title: "Home", blocks: [...]}]`, up to 10 pages and 30 blocks each |
| `views` | View presets to add to any space | `[{name: "Board", kind: "board", config: {groupBy: "status"}}]` (view config as in `create_view`) |
| `setup` | A whole configuration to apply | `{spaces: [{name, key, statuses, types, views}], appearance: {theme, density, accent, font}, plugins: ["id"]}` |
| `settings` | Options people set after installing | `[{key: "tone", label: "Tone", type: "select", options: ["calm", "bold"]}]` (types: text, number, boolean, select) |

Page blocks:

- `{type: "text", text: "..."}`
- `{type: "items", title, filter, mine, openOnly, limit}`: a read-only list of tasks. `filter` is a view filter
  (`{join: "and", rules: [{field: "priority", op: "is", value: "1"}]}`), `mine` limits to the person looking,
  `openOnly` (default true) hides done work. People only ever see tasks they can already see.
- `{type: "count", label, filter, mine, openOnly}`: a number.

## Make, test, share

1. Plugins page, Make a plugin. Edit the JSON; it is checked as you type and lists what it will change.
   Icon image and Add screenshot fill in images. Add my setup copies your shared spaces, their views, your
   appearance and installed plugins into a `setup`, so others can apply your configuration.
2. Save and try it on me: installs it only for you. Turn it off or remove it any time.
3. Submit for everyone: the server owner reviews it. Once approved, anyone on the server can install it, and
   admins can install it for their whole workspace.
4. Download gives the JSON file; Import file adds someone else's (as your own draft, to test first).

## Built-in plugins

Day planner and Whiteboards are plugins from Cadence, installed for every workspace to start with. An admin can
remove them for the workspace. Also built in: Midnight and Paper themes, My focus page, Sprint view set.

## Later (not built yet)

Plugins with their own code would run in a sandboxed frame with no access to the page, talking to Cadence only
through a small message API with permissions the installer approves (for example "read my tasks"). Until then
plugins stay data only.

## API and MCP

- REST: `GET /api/plugins?q=` (store and installs), `GET /api/plugins/:id`, `POST /api/plugins/check {manifest}`,
  `POST /api/plugins {manifest}` (save draft), `POST /api/plugins/:id/submit`, `POST /api/plugins/:id/review {approve, note}`
  (server owner), `DELETE /api/plugins/:id`, `POST|DELETE|PATCH /api/plugins/:id/install {scope: me|workspace, enabled?, settings?}`
  (workspace scope is for admins). `GET /api/bootstrap` includes `plugins` (your installs and the workspace's).
- MCP: `list_plugins`, `get_plugin`, `check_plugin`, `save_plugin`, `submit_plugin`, `install_plugin`, `uninstall_plugin`, `set_plugin`.
  Reviewing is done in the app by the server owner only.
