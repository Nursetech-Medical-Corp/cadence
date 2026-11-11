// Settings cards: field inheritance, automations, templates, integrations (calendar feed, webhooks, AI).
import {useEffect, useState} from 'react';
import {Copy, Plus, Trash2, Zap} from 'lucide-react';
import type {Action, Condition, InheritKey, Project, Rule, Template, Trigger} from './types.ts';
import {PRIORITIES} from './types.ts';
import {api, type Store, wsId} from './store.ts';

const save = (store: Store, p: Project, patch: Partial<Project['settings']>) => store.updateProject(p.id, {settings: {...p.settings, ...patch}});

export function InheritCard({store, project}: {store: Store; project: Project}) {
  const keys: [InheritKey, string][] = [['assignees', 'Assignees'], ['sprint', 'Sprint'], ['priority', 'Priority'], ['tags', 'Tags'], ['start', 'Start date'], ['due', 'Due date'],
    ...project.fields.map(f => [`f:${f.id}` as InheritKey, f.name] as [InheritKey, string])];
  const on = new Set(project.settings.inherit);
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Subitems inherit</h3><span className="muted small">New subitems copy these from their parent unless you set them. Open a parent and use Apply to subitems to push later changes down.</span></div>
      <div className="chips" style={{padding: '6px 0'}}>
        {keys.map(([k, label]) => (
          <label key={k} className={'chip-toggle' + (on.has(k) ? ' on' : '')}>
            <input type="checkbox" checked={on.has(k)} onChange={() => save(store, project, {inherit: on.has(k) ? project.settings.inherit.filter(x => x !== k) : [...project.settings.inherit, k]})} /> {label}
          </label>
        ))}
      </div>
    </section>
  );
}

const TRIGGERS: {kind: Trigger['kind']; label: string}[] = [
  {kind: 'created', label: 'An item is created'}, {kind: 'status', label: 'Status changes to'}, {kind: 'completed', label: 'An item is completed'},
  {kind: 'assigned', label: 'Someone is assigned'}, {kind: 'due-passed', label: 'The due date passes'},
];
const ACTIONS: {kind: Action['kind']; label: string}[] = [
  {kind: 'status', label: 'Set status'}, {kind: 'assign', label: 'Assign to'}, {kind: 'priority', label: 'Set priority'}, {kind: 'tag', label: 'Add tag'},
  {kind: 'sprint', label: 'Move to sprint'}, {kind: 'due', label: 'Set due in N days'}, {kind: 'notify', label: 'Notify'},
  {kind: 'template', label: 'Add subitems from template'}, {kind: 'parent-status', label: 'When all siblings are done, set parent status'},
];
const RECIPES: {name: string; make: (p: Project) => Omit<Rule, 'id'>}[] = [
  {name: 'Close the parent when all its subitems are done', make: p => ({name: 'Close parent when children are done', enabled: true, trigger: {kind: 'completed'}, conditions: [], actions: [{kind: 'parent-status', value: p.statuses.find(s => s.category === 'done')?.id ?? ''}]})},
  {name: 'New bugs are urgent and go into the current sprint', make: () => ({name: 'Triage new bugs', enabled: true, trigger: {kind: 'created'}, conditions: [{field: 'type', value: 'Bug'}], actions: [{kind: 'priority', value: 1}, {kind: 'sprint', value: 'current'}]})},
  {name: 'Tag overdue work and notify the assignees', make: () => ({name: 'Flag overdue', enabled: true, trigger: {kind: 'due-passed'}, conditions: [], actions: [{kind: 'tag', value: 'overdue'}, {kind: 'notify', value: 'assignees'}]})},
  {name: 'When work starts, put it in the current sprint', make: p => ({name: 'Started work joins the sprint', enabled: true, trigger: {kind: 'status', to: p.statuses.find(s => s.category === 'doing')?.id ?? ''}, conditions: [], actions: [{kind: 'sprint', value: 'current'}]})},
  {name: 'Assign new items to whoever created them', make: () => ({name: 'Creator owns new items', enabled: true, trigger: {kind: 'created'}, conditions: [], actions: [{kind: 'assign', value: 'creator'}]})},
];

export function AutomationsCard({store, project, templates}: {store: Store; project: Project; templates: Template[]}) {
  const rules = project.settings.automations;
  const set = (list: Rule[]) => save(store, project, {automations: list});
  const upd = (id: string, patch: Partial<Rule>) => set(rules.map(r => r.id === id ? {...r, ...patch} : r));
  const add = (r: Omit<Rule, 'id'>) => set([...rules, {...r, id: Math.random().toString(36).slice(2, 10)}]);
  const [recipes, setRecipes] = useState(false);
  return (
    <section className="set-card">
      <div className="set-card-head"><h3><Zap size={15} /> Automations</h3><span className="muted small">When something happens, do something. Runs for everyone, including AI agents and API changes.</span></div>
      <label className="set-item" style={{gap: 8}}>
        <input type="checkbox" checked={project.settings.autoRollover} onChange={e => save(store, project, {autoRollover: e.target.checked})} />
        <span className="grow">When a sprint ends, move its unfinished work to the next sprint automatically</span>
      </label>
      <label className="set-item" style={{gap: 8}}>
        <input type="checkbox" checked={!!project.settings.aiMayComplete} onChange={e => save(store, project, {aiMayComplete: e.target.checked})} />
        <span className="grow">Let AI agents mark work done without human approval <span className="muted small">(off: AI submits for review and a person approves)</span></span>
      </label>
      {rules.map(r => (
        <div key={r.id} className={'rule' + (r.enabled ? '' : ' off')}>
          <div className="rule-head">
            <input type="checkbox" checked={r.enabled} title="Enabled" onChange={e => upd(r.id, {enabled: e.target.checked})} />
            <input className="inline" value={r.name} onChange={e => upd(r.id, {name: e.target.value})} />
            <button className="icon" title="Delete rule" onClick={() => set(rules.filter(x => x.id !== r.id))}><Trash2 size={14} /></button>
          </div>
          <div className="rule-line"><b>When</b>
            <select className="plain-select" value={r.trigger.kind} onChange={e => upd(r.id, {trigger: e.target.value === 'status' ? {kind: 'status', to: project.statuses[0].id} : {kind: e.target.value} as Trigger})}>
              {TRIGGERS.map(t => <option key={t.kind} value={t.kind}>{t.label}</option>)}
            </select>
            {r.trigger.kind === 'status' && <select className="plain-select" value={r.trigger.to} onChange={e => upd(r.id, {trigger: {kind: 'status', to: e.target.value}})}>{project.statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          </div>
          {r.conditions.map((c, k) => (
            <div key={k} className="rule-line"><b>{k === 0 ? 'If' : 'and'}</b>
              <select className="plain-select" value={c.field} onChange={e => upd(r.id, {conditions: r.conditions.map((x, n) => n === k ? {field: e.target.value as Condition['field'], value: ''} : x)})}>
                <option value="type">type is</option><option value="parent-type">parent type is</option><option value="priority">priority is</option><option value="tag">has tag</option><option value="assignee">assignee is</option>
              </select>
              <ConditionValue c={c} project={project} store={store} onChange={value => upd(r.id, {conditions: r.conditions.map((x, n) => n === k ? {...x, value} : x)})} />
              <button className="icon" onClick={() => upd(r.id, {conditions: r.conditions.filter((_, n) => n !== k)})}><Trash2 size={12} /></button>
            </div>
          ))}
          {r.actions.map((a, k) => (
            <div key={k} className="rule-line"><b>{k === 0 ? 'Then' : 'and'}</b>
              <select className="plain-select" value={a.kind} onChange={e => upd(r.id, {actions: r.actions.map((x, n) => n === k ? defaultAction(e.target.value as Action['kind'], project) : x)})}>
                {ACTIONS.map(x => <option key={x.kind} value={x.kind}>{x.label}</option>)}
              </select>
              <ActionValue a={a} project={project} store={store} templates={templates} onChange={value => upd(r.id, {actions: r.actions.map((x, n) => n === k ? {...x, value} as Action : x)})} />
              <button className="icon" onClick={() => upd(r.id, {actions: r.actions.filter((_, n) => n !== k)})}><Trash2 size={12} /></button>
            </div>
          ))}
          <div className="rule-line">
            <button className="btn ghost small" onClick={() => upd(r.id, {conditions: [...r.conditions, {field: 'type', value: project.types[0]}]})}><Plus size={12} /> Condition</button>
            <button className="btn ghost small" onClick={() => upd(r.id, {actions: [...r.actions, defaultAction('status', project)]})}><Plus size={12} /> Action</button>
          </div>
        </div>
      ))}
      <div className="set-add" style={{gap: 6}}>
        <button className="btn" onClick={() => add({name: 'New rule', enabled: true, trigger: {kind: 'created'}, conditions: [], actions: [defaultAction('status', project)]})}><Plus size={14} /> New rule</button>
        <span className="picker">
          <button className="btn ghost" onClick={() => setRecipes(o => !o)}>Start from a recipe</button>
          {recipes && <div className="recipes">{RECIPES.map(x => <button key={x.name} className="pop-row" onClick={() => { add(x.make(project)); setRecipes(false); }}>{x.name}</button>)}</div>}
        </span>
      </div>
    </section>
  );
}

function defaultAction(kind: Action['kind'], p: Project): Action {
  if (kind === 'priority') return {kind, value: 2};
  if (kind === 'due') return {kind, value: 3};
  if (kind === 'sprint') return {kind, value: 'current'};
  if (kind === 'notify') return {kind, value: 'assignees'};
  if (kind === 'assign') return {kind, value: 'creator'};
  if (kind === 'tag' || kind === 'template') return {kind, value: ''};
  return {kind, value: kind === 'parent-status' ? p.statuses.find(s => s.category === 'done')?.id ?? '' : p.statuses[0].id} as Action;
}

function ConditionValue({c, project, store, onChange}: {c: Condition; project: Project; store: Store; onChange: (v: string) => void}) {
  if (c.field === 'type' || c.field === 'parent-type') return <select className="plain-select" value={c.value} onChange={e => onChange(e.target.value)}>{project.types.map(t => <option key={t}>{t}</option>)}</select>;
  if (c.field === 'priority') return <select className="plain-select" value={c.value} onChange={e => onChange(e.target.value)}>{[1, 2, 3, 4, 0].map(p => <option key={p} value={p}>{PRIORITIES[p]}</option>)}</select>;
  if (c.field === 'assignee') return <select className="plain-select" value={c.value} onChange={e => onChange(e.target.value)}>{store.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>;
  return <input className="plain-select" placeholder="tag" value={c.value} onChange={e => onChange(e.target.value)} />;
}

function ActionValue({a, project, store, templates, onChange}: {a: Action; project: Project; store: Store; templates: Template[]; onChange: (v: unknown) => void}) {
  const people = <>{store.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</>;
  switch (a.kind) {
    case 'status': case 'parent-status': return <select className="plain-select" value={a.value} onChange={e => onChange(e.target.value)}>{project.statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>;
    case 'priority': return <select className="plain-select" value={a.value} onChange={e => onChange(Number(e.target.value))}>{[1, 2, 3, 4, 0].map(p => <option key={p} value={p}>{PRIORITIES[p]}</option>)}</select>;
    case 'assign': return <select className="plain-select" value={a.value} onChange={e => onChange(e.target.value)}><option value="creator">Whoever created it</option>{people}</select>;
    case 'notify': return <select className="plain-select" value={a.value} onChange={e => onChange(e.target.value)}><option value="assignees">Its assignees</option><option value="creator">Whoever created it</option>{people}</select>;
    case 'sprint': return <select className="plain-select" value={a.value} onChange={e => onChange(e.target.value)}><option value="current">Current sprint</option><option value="next">Next sprint</option><option value="none">Backlog</option></select>;
    case 'due': return <input className="plain-select" type="number" style={{width: 70}} value={a.value} onChange={e => onChange(Number(e.target.value))} />;
    case 'template': return <select className="plain-select" value={a.value} onChange={e => onChange(e.target.value)}><option value="">Pick a template</option>{templates.filter(t => t.kind === 'item').map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>;
    default: return <input className="plain-select" placeholder="tag" value={a.value} onChange={e => onChange(e.target.value)} />;
  }
}

export function TemplatesCard({store, project, templates, reload}: {store: Store; project: Project; templates: Template[]; reload: () => void}) {
  const [name, setName] = useState(project.name + ' setup');
  const [withItems, setWithItems] = useState(false);
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Templates</h3><span className="muted small">Item templates come from any item: open it and press Save as template. Use them from + New in the toolbar.</span></div>
      {templates.map(t => (
        <div key={t.id} className="set-item">
          <span className="tag">{t.kind === 'project' ? 'Project' : 'Item'}</span>
          <span className="grow">{t.name}</span>
          <button className="icon" title="Delete template" onClick={async () => { if (confirm(`Delete template "${t.name}"?`)) { await api(`/templates/${t.id}`, {method: 'DELETE'}); reload(); } }}><Trash2 size={14} /></button>
        </div>
      ))}
      {!templates.length && <div className="muted small" style={{padding: '6px 2px'}}>No templates yet.</div>}
      <div className="set-add" style={{flexWrap: 'wrap'}}>
        <input className="plain-select" style={{flex: 1, minWidth: 180}} value={name} onChange={e => setName(e.target.value)} />
        <label className="small"><input type="checkbox" checked={withItems} onChange={e => setWithItems(e.target.checked)} /> include items</label>
        <button className="btn" onClick={async () => { await api('/templates', {method: 'POST', body: {kind: 'project', projectId: project.id, name, includeItems: withItems}}).catch(store.fail); reload(); }}><Copy size={14} /> Save this space as a template</button>
      </div>
    </section>
  );
}

export function IntegrationsCard({store, project}: {store: Store; project: Project}) {
  const [url, setUrl] = useState('');
  const base = location.origin;
  const feeds = [
    {label: 'This space', href: `${base}/api/calendar.ics?project=${project.id}&ws=${wsId()}`},
    ...store.people.map(p => ({label: `${p.name}'s work, all spaces`, href: `${base}/api/calendar.ics?person=${p.id}&ws=${wsId()}`})),
  ];
  const hooks = project.settings.webhooks;
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Integrations</h3><span className="muted small">Calendars, other apps, and AI assistants.</span></div>
      <div className="int-block">
        <b>Calendar feed</b>
        <div className="muted small">Items with dates as all-day events. In Google Calendar: Other calendars, From URL, paste the link. Google needs the app on a public address to fetch it; on this computer, download the file and use Import instead. Outlook and Apple Calendar can subscribe the same way.</div>
        {feeds.map(f => (
          <div key={f.href} className="set-item">
            <span className="grow small">{f.label}</span>
            <button className="btn ghost small" onClick={() => navigator.clipboard.writeText(f.href)}><Copy size={12} /> Copy link</button>
            <a className="btn ghost small" href={f.href} download="tasks.ics">Download .ics</a>
          </div>
        ))}
      </div>
      <div className="int-block">
        <b>Webhooks</b>
        <div className="muted small">POSTs JSON to a URL when items are created, updated, completed, deleted or restored. Works with Zapier, Make, n8n and Slack workflows, so you can send Gmail messages or Slack posts from those tools.</div>
        {hooks.map(h => (
          <div key={h.id} className="set-item"><span className="grow small" style={{wordBreak: 'break-all'}}>{h.url}</span>
            <button className="icon" onClick={() => save(store, project, {webhooks: hooks.filter(x => x.id !== h.id)})}><Trash2 size={14} /></button></div>
        ))}
        <div className="set-add"><input className="plain-select" style={{flex: 1}} placeholder="https://hooks.zapier.com/..." value={url} onChange={e => setUrl(e.target.value)} />
          <button className="btn" disabled={!/^https?:\/\//.test(url)} onClick={() => { save(store, project, {webhooks: [...hooks, {id: Math.random().toString(36).slice(2, 10), url, events: []}]}); setUrl(''); }}><Plus size={14} /> Add</button></div>
      </div>
      <div className="int-block">
        <b>Email to task</b>
        <div className="muted small">Forward emails into this project: a Gmail filter with Zapier or Make, or any mail service that can call a URL, sends a POST to <code>{base}/api/inbound/email</code> with header <code>Authorization: Bearer &lt;token&gt;</code> and JSON <code>{'{'}"projectId": "{project.id}", "subject", "body", "from"{'}'}</code>. The subject becomes the title and understands quick add (for example <code>Renew COI @sam due:fri</code>); tasks get the #email tag.</div>
      </div>
      <div className="int-block">
        <b>AI assistants (Claude and others)</b>
        <div className="muted small">The MCP server gives AI apps the same powers as this screen: search, create, update, sprints, templates, automations, history and revert. Add to Claude Desktop or Claude Code:</div>
        <pre className="code">{`{"mcpServers": {"tasks": {"command": "pnpm", "args": ["--dir", "<path to this folder>", "mcp", "--", "--as", "${store.people[0]?.name ?? 'David'}"]}}}`}</pre>
        <div className="muted small">Gmail and Google Calendar sign-in (sending email, writing events) needs a Google Cloud OAuth client. Not connected yet; see docs/FEATURES.md.</div>
      </div>
    </section>
  );
}

export function useTemplates(store: Store) {
  const [list, setList] = useState<Template[]>([]);
  const reload = () => api<Template[]>('/templates').then(setList).catch(() => {});
  useEffect(() => { reload(); }, [store.tick]);
  return [list, reload] as const;
}

/** Every tag used in this project: rename (merges if the new name exists) or remove from all items. */
export function TagsCard({store, project}: {store: Store; project: Project}) {
  const items = [...store.items.values()].filter(i => i.projectId === project.id);
  const counts = new Map<string, number>();
  for (const i of items) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const rename = (from: string, to: string) => {
    const v = to.trim().replace(/^#/, '');
    if (!v || v === from) return;
    for (const i of items.filter(i => i.tags.includes(from))) store.updateItem(i.id, {tags: [...new Set(i.tags.map(t => t === from ? v : t))]});
  };
  return (
    <section className="set-card">
      <div className="set-card-head"><h3>Tags</h3><span className="muted small">Rename a tag everywhere in this project; renaming to an existing tag merges them.</span></div>
      {tags.map(([t, n]) => (
        <div key={t} className="set-item">
          <span className="tag">#</span>
          <input className="inline" defaultValue={t} key={t} onBlur={e => rename(t, e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <span className="count">{n}</span>
          <button className="icon" title="Remove from all items" onClick={() => { if (confirm(`Remove #${t} from ${n} items?`)) for (const i of items.filter(i => i.tags.includes(t))) store.updateItem(i.id, {tags: i.tags.filter(x => x !== t)}); }}><Trash2 size={14} /></button>
        </div>
      ))}
      {!tags.length && <div className="muted small" style={{padding: '6px 2px'}}>No tags yet. Add them with #tag in quick add or on any item.</div>}
    </section>
  );
}
