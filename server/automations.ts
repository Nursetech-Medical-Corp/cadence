// Automation rules: "when <trigger> and <conditions>, do <actions>". Run by the service after item changes,
// and by a periodic check for due dates passing and sprints ending.
import type {Action, Item, Project, Rule, Trigger} from '../src/types.ts';

export type RuleHost = {
  today(): string;
  project(id: string): Project;
  item(id: string): Item;
  listItems(q: {projectId?: string; parentId?: string | null}): Item[];
  updateItem(id: string, patch: Record<string, unknown>, actor: string | null): Item;
  currentSprintId(projectId: string): string | null;
  nextSprintId(projectId: string): string | null;
  notifyPerson(person: string, itemId: string, text: string): void;
  instantiateTemplate(templateId: string, projectId: string, parentId: string | null, actor: string | null): unknown;
  addDays(day: string, n: number): string;
};

export function matches(rule: Rule, trigger: Trigger, item: Item, host: RuleHost) {
  if (!rule.enabled || rule.trigger.kind !== trigger.kind) return false;
  if (rule.trigger.kind === 'status' && trigger.kind === 'status' && rule.trigger.to !== trigger.to) return false;
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

export function apply(rule: Rule, item: Item, host: RuleHost) {
  for (const a of rule.actions) applyAction(a, item, host, rule);
}

function applyAction(a: Action, item: Item, host: RuleHost, rule: Rule) {
  const set = (patch: Record<string, unknown>) => { item = host.updateItem(item.id, patch, null); };
  switch (a.kind) {
    case 'status': return set({status: a.value});
    case 'priority': return set({priority: a.value});
    case 'tag': return item.tags.includes(a.value) ? undefined : set({tags: [...item.tags, a.value]});
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
    case 'template': host.instantiateTemplate(a.value, item.projectId, item.id, null); return;
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
