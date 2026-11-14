// Automation rules: "when <trigger> and <conditions>, do <actions>". Run by the service after item changes,
// and by a periodic check for due dates passing and sprints ending.
import {Invalid} from './errors.ts';
import type {Action, Item, Project, Rule, Trigger} from '../src/types.ts';

export type RuleHost = {
  today(): string;
  project(id: string): Project;
  item(id: string): Item;
  listItems(q: {projectId?: string; parentId?: string | null}): Item[];
  updateItem(id: string, patch: Record<string, unknown>, actor: string | null): Item;
  currentSprintId(projectId: string): string | null;
  nextSprintId(projectId: string): string | null;
  notifyPerson(person: string, itemId: string | null, text: string): void;
  instantiateTemplate(templateId: string, projectId: string, parentId: string | null, actor: string | null): unknown;
  addDays(day: string, n: number): string;
  /** Queues a POST to the URL with the rule, the trigger and the item (fire and forget, with retries). */
  sendWebhook(rule: Rule, action: Extract<Action, {kind: 'webhook'}>, item: Item | null, ctx: RuleContext): void;
  resumeRoutine(itemId: string): void;
};
/** What set the rule off: the trigger, the space, and for webhook-received the JSON body that came in. */
export type RuleContext = {trigger: Trigger; projectId: string; data?: unknown};

/** Triggers checked by the hourly job against a date on the item. */
export const DATE_TRIGGERS = ['due-passed', 'due-soon', 'due-today', 'overdue-by', 'start-reached'];
export const REVIEW_STATES = ['claimed', 'accepted', 'submitted', 'changes', 'redo', 'approved', 'declined', 'discarded'];
const TRIGGERS = ['created', 'status', 'assigned', 'unassigned', 'completed', 'comment-added', 'review', 'routine-resumed', 'webhook-received', ...DATE_TRIGGERS];
const CONDITIONS = ['type', 'priority', 'tag', 'assignee', 'parent-type'];
const ACTIONS = ['status', 'assign', 'priority', 'tag', 'sprint', 'due', 'notify', 'template', 'parent-status', 'webhook', 'routine-resume'];

/** Server-side checks for rules saved from the UI, the API or set_automations. */
export function validateRules(rules: unknown, p: Project, people: Set<string>) {
  if (!Array.isArray(rules) || rules.length > 200) throw new Invalid('Automations must be a list of up to 200 rules');
  const text = (v: unknown, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const status = (v: unknown, where: string) => { if (!p.statuses.some(s => s.id === v)) throw new Invalid(`${where}: status "${String(v)}" is not in this space. Valid: ${p.statuses.map(s => s.id).join(', ')}`); };
  const days = (v: unknown, where: string) => { if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 365) throw new Invalid(`${where}: days must be a whole number from 1 to 365`); };
  for (const r of rules as Rule[]) {
    const where = `Rule "${typeof r?.name === 'string' ? r.name : '?'}"`;
    if (!r || typeof r !== 'object' || !text(r.id, 60) || typeof r.name !== 'string' || r.name.length > 200 || typeof r.enabled !== 'boolean') throw new Invalid('Each rule needs id, name and enabled (true or false)');
    const t = r.trigger;
    if (!t || !TRIGGERS.includes(t.kind)) throw new Invalid(`${where}: unknown trigger "${String(t?.kind)}". Valid: ${TRIGGERS.join(', ')}`);
    if (t.kind === 'status') status(t.to, `${where} trigger`);
    if (t.kind === 'review' && !REVIEW_STATES.includes(t.to)) throw new Invalid(`${where}: review state must be one of ${REVIEW_STATES.join(', ')}`);
    if (t.kind === 'due-soon' || t.kind === 'overdue-by') days(t.days, `${where} trigger`);
    if (t.kind === 'webhook-received' && !(typeof t.key === 'string' && /^[\w.-]{0,60}$/.test(t.key))) throw new Invalid(`${where}: the webhook key is up to 60 letters, digits, dots, dashes or underscores`);
    if (!Array.isArray(r.conditions) || !Array.isArray(r.actions) || !r.actions.length) throw new Invalid(`${where}: needs conditions (a list) and at least one action`);
    for (const c of r.conditions) if (!c || !CONDITIONS.includes(c.field) || typeof c.value !== 'string') throw new Invalid(`${where}: unknown condition "${String(c?.field)}". Valid: ${CONDITIONS.join(', ')}`);
    for (const a of r.actions) {
      if (!a || !ACTIONS.includes(a.kind)) throw new Invalid(`${where}: unknown action "${String(a?.kind)}". Valid: ${ACTIONS.join(', ')}`);
      if (a.kind === 'status' || a.kind === 'parent-status') status(a.value, `${where} action`);
      if (a.kind === 'priority' && !(Number.isInteger(a.value) && a.value >= 0 && a.value <= 4)) throw new Invalid(`${where}: priority must be 0 to 4`);
      // Empty values are allowed while a rule is being written in the editor; they do nothing when the rule runs.
      if (a.kind === 'tag' && !(typeof a.value === 'string' && a.value.length <= 60)) throw new Invalid(`${where}: tag must be a short word`);
      if (a.kind === 'sprint' && !['current', 'next', 'none'].includes(a.value)) throw new Invalid(`${where}: sprint must be current, next or none`);
      if (a.kind === 'due' && !(Number.isInteger(a.value) && a.value >= 0 && a.value <= 3650)) throw new Invalid(`${where}: due must be a whole number of days from today`);
      if (a.kind === 'assign' && a.value !== 'creator' && !people.has(a.value)) throw new Invalid(`${where}: assign needs a person id or "creator"`);
      if (a.kind === 'notify' && !['assignees', 'creator'].includes(a.value) && !people.has(a.value)) throw new Invalid(`${where}: notify needs a person id, "assignees" or "creator"`);
      if (a.kind === 'template' && !(typeof a.value === 'string' && a.value.length <= 60)) throw new Invalid(`${where}: template needs a template id`);
      if (a.kind === 'webhook') {
        if (!(typeof a.value === 'string' && a.value.length <= 2000 && (a.value === '' || /^https?:\/\/[^\s]+$/i.test(a.value)))) throw new Invalid(`${where}: webhook needs a URL starting with http:// or https://`);
        if (a.secret !== undefined && (typeof a.secret !== 'string' || a.secret.length > 200)) throw new Invalid(`${where}: the webhook secret must be text under 200 characters`);
      }
    }
  }
}

export function matches(rule: Rule, trigger: Trigger, item: Item | null, host: RuleHost) {
  if (!rule.enabled || rule.trigger.kind !== trigger.kind) return false;
  // Triggers with a value (status to, review to, webhook key, days) must match it.
  const a = rule.trigger as Record<string, unknown>, b = trigger as Record<string, unknown>;
  for (const k of ['to', 'key', 'days']) if (a[k] !== undefined && a[k] !== b[k]) return false;
  if (!item) return !rule.conditions.length;
  for (const c of rule.conditions) {
    if (c.field === 'type' && item.type !== c.value) return false;
    if (c.field === 'priority' && String(item.priority) !== c.value) return false;
    if (c.field === 'tag' && !item.tags.includes(c.value)) return false;
    if (c.field === 'assignee' && !item.assignees.includes(c.value)) return false;
    if (c.field === 'parent-type') {
      const parent = item.parentId ? safe(() => host.item(item.parentId!)) : null;
      if (parent?.type !== c.value) return false;
    }
  }
  return true;
}

const safe = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };

/** item is null only for webhook-received without an item: then only webhook, template and notify-a-person actions run. */
export function apply(rule: Rule, item: Item | null, host: RuleHost, ctx: RuleContext) {
  for (const a of rule.actions) applyAction(a, item, host, rule, ctx);
}

function applyAction(a: Action, item: Item | null, host: RuleHost, rule: Rule, ctx: RuleContext) {
  if (a.kind === 'webhook') { if (!a.value) return; const id = item?.id; return host.sendWebhook(rule, a, id ? safe(() => host.item(id)) ?? item : null, ctx); }
  if (!item) {
    if (a.kind === 'template' && a.value) host.instantiateTemplate(a.value, ctx.projectId, null, null);
    if (a.kind === 'notify' && !['assignees', 'creator'].includes(a.value)) host.notifyPerson(a.value, null, `Automation "${rule.name}"`);
    return;
  }
  const set = (patch: Record<string, unknown>) => { item = host.updateItem(item!.id, patch, null); };
  switch (a.kind) {
    case 'status': return set({status: a.value});
    case 'priority': return set({priority: a.value});
    case 'tag': return !a.value || item.tags.includes(a.value) ? undefined : set({tags: [...item.tags, a.value]});
    case 'assign': {
      const who = a.value === 'creator' ? item.createdBy : a.value;
      return who && !item.assignees.includes(who) ? set({assignees: [...item.assignees, who]}) : undefined;
    }
    case 'sprint': return set({sprint: a.value === 'none' ? null : a.value === 'current' ? host.currentSprintId(item.projectId) : host.nextSprintId(item.projectId)});
    case 'due': return set({due: host.addDays(host.today(), a.value)});
    case 'notify': {
      const who = a.value === 'assignees' ? item.assignees : a.value === 'creator' ? (item.createdBy ? [item.createdBy] : []) : [a.value];
      for (const p of who) host.notifyPerson(p, item.id, `Automation "${rule.name}": ${item.title}`);
      return;
    }
    case 'template': if (a.value) host.instantiateTemplate(a.value, item.projectId, item.id, null); return;
    case 'routine-resume': host.resumeRoutine(item.id); return;
    case 'parent-status': {
      if (!item.parentId) return;
      // Only when every sibling is done, so "close the story when all its tasks close" works.
      const siblings = host.listItems({parentId: item.parentId});
      if (rule.allChildrenDone !== false && siblings.some(s => !s.completed)) return;
      host.updateItem(item.parentId, {status: a.value}, null);
      return;
    }
  }
}
