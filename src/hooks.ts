// Webhook endpoints and the catalog of events they can receive. Shared by the server, the settings UI and the docs.

/** One endpoint. events empty means every event. The secret is write-only: once saved, only hasSecret comes back. */
export type Hook = {id: string; name: string; url: string; events: string[]; active: boolean; secret?: string; hasSecret?: boolean};
export type HookDelivery = {id: string; hook: string; scope: string; url: string; event: string; status: 'pending' | 'ok' | 'failed'; attempts: number; code: number | null; error: string | null; created: string; updated: string | null; nextAt: string | null};

export const HOOK_GROUPS = ['Items', 'Dates', 'Collaboration', 'AI work', 'Routines', 'Other'] as const;
export type HookGroup = typeof HOOK_GROUPS[number];

export const HOOK_EVENTS: {key: string; group: HookGroup; label: string}[] = [
  {key: 'item.created', group: 'Items', label: 'Item created'},
  {key: 'item.updated', group: 'Items', label: 'Item changed (any field)'},
  {key: 'item.completed', group: 'Items', label: 'Item completed'},
  {key: 'item.reopened', group: 'Items', label: 'Item reopened'},
  {key: 'item.deleted', group: 'Items', label: 'Item deleted'},
  {key: 'item.restored', group: 'Items', label: 'Deleted item restored'},
  {key: 'item.status_changed', group: 'Items', label: 'Status changed'},
  {key: 'item.assigned', group: 'Items', label: 'Someone assigned'},
  {key: 'item.unassigned', group: 'Items', label: 'Someone unassigned'},
  {key: 'item.due_changed', group: 'Items', label: 'Due date changed'},
  {key: 'item.priority_changed', group: 'Items', label: 'Priority changed'},
  {key: 'item.moved', group: 'Items', label: 'Moved to another space or parent'},
  {key: 'item.archived', group: 'Items', label: 'Archived'},
  {key: 'item.unarchived', group: 'Items', label: 'Brought back from the archive'},
  {key: 'item.due_soon', group: 'Dates', label: 'Due soon (1 and 3 days before by default)'},
  {key: 'item.due_today', group: 'Dates', label: 'Due today'},
  {key: 'item.overdue', group: 'Dates', label: 'Became overdue'},
  {key: 'item.start_reached', group: 'Dates', label: 'Start date reached'},
  {key: 'sprint.started', group: 'Dates', label: 'Sprint started'},
  {key: 'sprint.ending_soon', group: 'Dates', label: 'Sprint ends within 2 days'},
  {key: 'sprint.ended', group: 'Dates', label: 'Sprint ended'},
  {key: 'sprint.rolled_over', group: 'Dates', label: 'Sprint rolled over'},
  {key: 'comment.created', group: 'Collaboration', label: 'Comment added'},
  {key: 'comment.resolved', group: 'Collaboration', label: 'Comment resolved'},
  {key: 'mention.created', group: 'Collaboration', label: 'Someone mentioned'},
  {key: 'time.logged', group: 'Collaboration', label: 'Time logged'},
  {key: 'timer.started', group: 'Collaboration', label: 'Timer started'},
  {key: 'timer.stopped', group: 'Collaboration', label: 'Timer stopped'},
  {key: 'approval.requested', group: 'Collaboration', label: 'Approval requested'},
  {key: 'approval.signed', group: 'Collaboration', label: 'Approval signed (approved, changes, rejected)'},
  {key: 'ai.claimed', group: 'AI work', label: 'Agent asked to take a task'},
  {key: 'ai.accepted', group: 'AI work', label: 'Claim accepted'},
  {key: 'ai.declined', group: 'AI work', label: 'Claim declined'},
  {key: 'ai.submitted', group: 'AI work', label: 'Work submitted for review'},
  {key: 'ai.approved', group: 'AI work', label: 'Work approved'},
  {key: 'ai.changes_requested', group: 'AI work', label: 'Work sent back'},
  {key: 'ai.redo_requested', group: 'AI work', label: 'Redo requested'},
  {key: 'ai.discarded', group: 'AI work', label: 'Work discarded'},
  {key: 'ai.step_logged', group: 'AI work', label: 'Step written to the work log'},
  {key: 'routine.spawned', group: 'Routines', label: 'Next occurrence created or reopened'},
  {key: 'routine.waiting', group: 'Routines', label: 'Routine set to wait'},
  {key: 'routine.resumed', group: 'Routines', label: 'Routine resumed (wait over, or switched back on)'},
  {key: 'routine.skipped', group: 'Routines', label: 'Occurrence skipped'},
  {key: 'routine.ended', group: 'Routines', label: 'Routine ended'},
  {key: 'notification.created', group: 'Other', label: 'Notification created'},
  {key: 'automation.ran', group: 'Other', label: 'Automation rule ran'},
  {key: 'project.created', group: 'Other', label: 'Space created'},
  {key: 'project.updated', group: 'Other', label: 'Space settings changed'},
  {key: 'project.deleted', group: 'Other', label: 'Space deleted'},
  {key: 'person.added', group: 'Other', label: 'Person added'},
  {key: 'person.updated', group: 'Other', label: 'Person changed'},
  {key: 'webhook.test', group: 'Other', label: 'Test event'},
];

/** What endpoints saved before the event catalog received when they listed no events. */
export const LEGACY_EVENTS = ['item.created', 'item.updated', 'item.completed', 'item.deleted', 'item.restored'];

/** Reads both the current shape and the old {id, url, events} one. */
export function normalizeHook(h: Partial<Hook> & {id: string; url: string}): Hook {
  const old = h.active === undefined && h.name === undefined;
  const events = Array.isArray(h.events) ? h.events : [];
  return {id: h.id, name: h.name ?? '', url: h.url, events: old && !events.length ? LEGACY_EVENTS : events, active: h.active !== false,
    ...(h.hasSecret ? {hasSecret: true} : {}), ...(typeof h.secret === 'string' ? {secret: h.secret} : {})};
}
