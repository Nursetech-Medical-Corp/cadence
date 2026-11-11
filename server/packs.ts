// Template packs: portable bundles of item templates (with subitems, who does each step, repeat rules)
// and optional automation rules. Export your own as JSON, import someone else's, or start from the gallery.
import {Invalid} from './errors.ts';
import {checkRecur} from './service.ts';
import type {Recur, Rule} from '../src/types.ts';

/**
 * One step of a template. Timing is relative, so a template works for any start date:
 * - days: how long the step runs (start to due). Leave out for a single due date.
 * - anchor 'start' (default when offset is set): starts `offset` days after the parent starts. Moves with the parent.
 * - anchor 'after': starts the day after the step above it is due, plus `offset` days of gap. Follows that step.
 * - anchor 'none': no date; set it by hand.
 */
export type Node = {
  type: string; title: string; body?: string; priority?: number; tags?: string[]; estimate?: number | null;
  recur?: Recur | null; worker?: 'human' | 'ai' | 'either'; days?: number | null; offset?: number; anchor?: 'start' | 'after' | 'none';
  assignees?: string[]; fields?: Record<string, unknown>; children?: Node[];
};
export type Pack = {
  app: 'cadence' | 'tasks'; kind: 'pack'; version: 1; name: string; description: string;
  templates: {name: string; description?: string; tree: Node}[];
  automations?: Omit<Rule, 'id'>[];
};

const t = (title: string, worker: Node['worker'], estimate: number, offset = 0, extra: Partial<Node> = {}): Node =>
  ({type: 'Task', title, worker, estimate, offset, ...extra});
const every = (n: number, unit: Recur['unit'], mode: Recur['mode'] = 'schedule', more: Partial<Recur> = {}): Recur => ({every: n, unit, mode, ...more});
const routine = (title: string, recur: Recur, worker: Node['worker'], estimate: number, body: string, tags: string[]): Node =>
  ({type: 'Task', title, recur, worker, estimate, body, tags: ['routine', ...tags]});

export const GALLERY: Pack[] = [
  {
    app: 'cadence', kind: 'pack', version: 1, name: 'Learn Cadence: training checklist',
    description: 'A step-by-step checklist that walks a new person through every guided tour and the main features. Use it once per person, assign it to them, and each step follows the one before.',
    templates: [{name: 'Learn Cadence: training checklist', tree: {type: 'Phase', title: 'Learn Cadence: {name}', worker: 'human', days: 21, tags: ['training'], body: 'Work top to bottom. Each step starts after the one above, so dates slide if a step runs late. Open Help in the sidebar for the guided tours.', children: [
        {type: 'Task', title: 'Take the tour: Add tasks fast', body: 'Help, Add tasks fast. Then add three tasks in any List using @person, !high and due:fri. Type @ or ! to pick from a list.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Complete tasks and find them later', body: 'Help, Complete tasks. Check off a task, find it under Show done, and undo with Ctrl+Z.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Spaces, views and settings', body: 'Help, Spaces, views and settings. Create a practice space, add a Board and a Timeline view, rename a status in Settings.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Assign work and keep track of people', body: 'Help, Assign work. Assign two tasks, open the Workload view, then Team insights.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Timeline (Gantt)', body: 'Help, Timeline. Drag a bar to move it, drag its edge to change length, drag from one bar to another to link a dependency.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Sprints', body: 'Help, Sprints. Create a sprint, drag tasks into it from the Backlog, look at the burndown.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Repeating work and routines', body: 'Help, Repeating work. Make a task repeat monthly, then find it on the Routines page.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Templates and packs', body: 'Help, Templates. Then on Templates press New task template, add three steps with After the step above timing, save, and Use it with a start date.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Working with AI agents', body: 'Help, Working with AI. Mark a task AI, open AI work, and read how claims, reports and reviews flow.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Calendar, email and notifications', body: 'Help, Calendar and email. Copy your calendar feed link into Google Calendar and check notification settings.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Take the tour: Keyboard shortcuts', body: 'Help, Keyboard shortcuts. Try Ctrl+K search, Q for quick capture, and arrow keys in a List.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Request and sign an approval', body: 'Open a task, Approvals, request an approval from a teammate (or yourself), then sign it on the Approvals page.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Check data, backups and history', body: 'Data and backups: take a manual snapshot and download an export. History: revert one change.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Review team roles and permissions', body: "Team and permissions: see each role's rights and a space's access settings. Admins only.", worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Plan and forecast', body: 'Plan and forecast: set your weekly hours, run Replan on one space, and read the hiring forecast. Approve nothing yet.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Connect an AI agent (optional)', body: 'Team page, Tokens: create a token for an AI worker. Point Claude or another MCP client at /mcp with it, and ask it to list your tasks.', worker: 'either', estimate: 0.5, anchor: 'after', offset: 0, days: 0},
        {type: 'Task', title: 'Done: tell your admin what was confusing', body: 'Comment on this task with anything unclear. It helps improve the guides.', worker: 'human', estimate: 0.25, anchor: 'after', offset: 0, days: 0},
    ]}}],
  },
  {
    app: 'cadence', kind: 'pack', version: 1, name: 'Vendor onboarding',
    description: 'Everything to set up a new supplier, from paperwork to the first reorder reminder. AI drafts and checks, people approve and sign.',
    templates: [{name: 'New vendor onboarding', tree: {type: 'Phase', title: 'Onboard vendor: {name}', worker: 'either', days: 14, children: [
      t('Request W-9, COI and banking details', 'ai', 0.5, 0, {body: 'Draft the request email with the document checklist. A person sends it if the agent cannot.'}),
      t('Run vendor due diligence (registration, sanctions, reviews)', 'ai', 1, 1),
      t('Supplier qualification questionnaire and quality agreement', 'human', 2, 2, {tags: ['quality']}),
      t('Approve vendor in the approved supplier list', 'human', 0.5, 7, {tags: ['quality']}),
      t('Add vendor to accounting and payment system', 'human', 0.5, 8),
      t('Set pricing, lead times and reorder points', 'either', 1, 9),
      t('Create the monthly reorder check routine', 'ai', 0.25, 10),
      t('Kickoff call and contacts saved to CRM', 'human', 1, 12, {tags: ['crm']}),
    ]}}],
  },
  {
    app: 'cadence', kind: 'pack', version: 1, name: 'Business and compliance routines',
    description: 'Recurring filings, reviews and payments for a small regulated company (for example medical devices). Adjust dates and owners after adding.',
    templates: [
      {name: 'FDA establishment registration renewal', tree: routine('FDA establishment registration and device listing renewal', every(1, 'year'), 'human', 2, 'Annual renewal window is October 1 to December 31. Pay the user fee, confirm the listing, save the confirmation.', ['fda', 'regulatory'])},
      {name: 'Quarterly payroll tax filing (941)', tree: routine('File quarterly payroll taxes (Form 941)', every(3, 'month'), 'human', 1, 'Due the last day of the month after the quarter ends. Confirm with the payroll provider.', ['tax'])},
      {name: 'Sales tax filing', tree: routine('File sales tax returns', every(1, 'month'), 'either', 1, 'Check each state where you have nexus. AI can prepare the totals; a person files.', ['tax'])},
      {name: 'State annual report', tree: routine('State annual report and registered agent check', every(1, 'year'), 'human', 0.5, '', ['legal'])},
      {name: 'Biennial license renewals', tree: routine('Renew professional and business licenses', every(2, 'year'), 'human', 2, 'Many state nursing and business licenses renew every 2 years. List each license, its expiry and the CE hours needed, and start 90 days early.', ['legal', 'hr'])},
      {name: 'ISO 13485 recertification audit', tree: routine('ISO 13485 recertification audit', every(3, 'year'), 'human', 16, 'Certificates run 3 years with yearly surveillance audits in between. Book the registrar 6 months ahead and run a full internal audit and management review first.', ['quality', 'regulatory'])},
      {name: 'Trademark maintenance filing', tree: routine('Trademark maintenance filing (Section 8 and 9)', every(10, 'year'), 'human', 1, 'US marks need a Section 8 declaration between years 5 and 6, then a renewal every 10 years. Set the first due date from the registration date.', ['legal'])},
      {name: 'Twice-yearly emergency and safety drill', tree: routine('Emergency and safety drill', every(6, 'month'), 'either', 2, 'Fire, evacuation and data-recovery drill. Record attendance and fixes.', ['hr', 'safety'])},
      {name: 'SOP periodic review', tree: routine('Review SOPs due for periodic review', every(1, 'year'), 'either', 4, 'Pull the SOP list, flag those past review date, route for approval.', ['quality', 'docs'])},
      {name: 'Management review', tree: routine('Quality management review meeting', every(6, 'month'), 'human', 3, 'Inputs: complaints, CAPAs, audits, supplier performance, KPIs.', ['quality'])},
      {name: 'HR document audit', tree: routine('Audit HR files (I-9, training records, signed policies)', every(3, 'month'), 'either', 2, '', ['hr'])},
      {name: 'Insurance renewal', tree: routine('Insurance renewals (liability, product, D&O)', every(1, 'year'), 'human', 2, '', ['legal', 'finance'])},
      {name: 'Monthly budget update', tree: routine('Update budget vs actuals', every(1, 'month'), 'either', 2, 'AI pulls actuals and drafts variances; a person reviews.', ['finance'])},
      {name: 'Vendor reorder check', tree: routine('Check stock and send reorders to vendors', every(1, 'month'), 'ai', 1, 'Compare stock to reorder points; draft purchase orders for approval.', ['ops'])},
      {name: 'Bills and payments run', tree: routine('Pay bills and reconcile accounts', every(2, 'week'), 'human', 1, '', ['finance'])},
      {name: 'Follow up with open leads', tree: routine('Follow up with leads and customers waiting on us', every(1, 'week'), 'ai', 1, 'List contacts with no reply in 7 days; draft follow-ups for review.', ['crm'])},
    ],
  },
  {
    app: 'cadence', kind: 'pack', version: 1, name: 'New hire onboarding',
    description: 'From signed offer to first-month check-in.',
    templates: [{name: 'Onboard new hire', tree: {type: 'Phase', title: 'Onboard {name}', worker: 'either', days: 30, children: [
      t('Send offer paperwork and collect I-9 documents', 'either', 1, 0, {tags: ['hr']}),
      t('Set up accounts, email and devices', 'either', 2, 2),
      t('Assign required training and SOP reads', 'ai', 0.5, 3, {tags: ['quality']}),
      t('First-week plan and buddy', 'human', 1, 4),
      t('30-day check-in', 'human', 1, 30),
    ]}}],
  },
  {
    app: 'cadence', kind: 'pack', version: 1, name: 'AI agency client work',
    description: 'A delivery flow where AI agents research and draft, people review and deliver, with a weekly AI status report.',
    templates: [
      {name: 'Client deliverable', tree: {type: 'Phase', title: 'Deliverable: {name}', worker: 'either', days: 10, children: [
        t('Intake: goals, audience, constraints', 'human', 1, 0),
        t('Research and source list', 'ai', 2, 1),
        t('First draft', 'ai', 3, 3),
        t('Human review and edits', 'human', 2, 6),
        t('Final QA against the brief', 'ai', 1, 8),
        t('Deliver and log feedback', 'human', 0.5, 10),
      ]}},
      {name: 'Weekly client status report', tree: routine('Weekly status report to client', every(1, 'week'), 'ai', 0.5, 'Summarize done, in progress and blocked from the work log; a person approves before sending.', ['client'])},
    ],
    automations: [
      {name: 'Approved AI work closes its parent when everything is done', enabled: true, trigger: {kind: 'completed'}, conditions: [], actions: [{kind: 'parent-status', value: 'done'}]},
    ],
  },
];

/** Shape check for imported packs: keeps unknown or oversized data out. */
export function validatePack(p: unknown): Pack {
  const x = p as Pack;
  if (!x || !['cadence', 'tasks'].includes(x.app) || x.kind !== 'pack' || !Array.isArray(x.templates)) throw new Invalid('Not a Cadence template pack');
  if (x.templates.length > 200) throw new Invalid('Packs are limited to 200 templates');
  if (x.templates.reduce((a, tpl) => a + checkTree(tpl.tree), 0) > 5000) throw new Invalid('This pack has too many items');
  return x;
}

const num = (v: unknown, lo: number, hi: number) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
/** Checks one template tree and returns how many steps it has. */
export function checkTree(n: Node, depth = 0): number {
  const at = n && typeof n.title === 'string' ? `"${n.title.slice(0, 40)}"` : 'a step';
  if (!n || typeof n !== 'object' || typeof n.title !== 'string' || !n.title.trim()) throw new Invalid(depth ? `A substep at level ${depth + 1} has no title` : 'The top step needs a title');
  if (depth > 8) throw new Invalid('Templates can nest 8 levels deep');
  if (n.title.length > 500) throw new Invalid(`Title of ${at} is over 500 characters`);
  if (n.type !== undefined && typeof n.type !== 'string') throw new Invalid(`Type of ${at} must be text`);
  if (n.anchor !== undefined && !['start', 'after', 'none'].includes(n.anchor)) throw new Invalid(`Timing of ${at} must be start, after or none`);
  if (!num(n.offset, -3650, 3650) || !num(n.days, 0, 3650)) throw new Invalid(`Days in ${at} must be whole numbers within 10 years`);
  if (!num(n.estimate, 0, 10000)) throw new Invalid(`Estimate of ${at} must be 0 to 10000 hours`);
  if (n.worker !== undefined && !['human', 'ai', 'either'].includes(n.worker)) throw new Invalid(`Who does ${at} must be human, ai or either`);
  if (n.priority !== undefined && !(Number.isInteger(n.priority) && n.priority >= 0 && n.priority <= 4)) throw new Invalid(`Priority of ${at} must be 0 to 4`);
  if (n.tags !== undefined && (!Array.isArray(n.tags) || n.tags.some(t => typeof t !== 'string'))) throw new Invalid(`Tags of ${at} must be a list of words`);
  if (n.recur !== undefined && n.recur !== null) { try { checkRecur(n.recur); } catch (e) { throw new Invalid(`${at}: ${(e as Error).message}`); } }
  if (n.children !== undefined && !Array.isArray(n.children)) throw new Invalid(`Substeps of ${at} must be a list`);
  return 1 + (n.children ?? []).reduce((a, c) => a + checkTree(c, depth + 1), 0);
}

const VIEW_KINDS = ['list', 'table', 'board', 'gantt', 'backlog', 'sprint', 'calendar', 'workload', 'files'];
/** Validates template data before it is saved, from the editor, the API or an agent. */
export function checkTemplateData(kind: 'item' | 'project' | 'view', d: unknown) {
  if (kind === 'item') { if (checkTree(d as Node) > 2000) throw new Invalid('Templates are limited to 2000 steps'); return; }
  if (kind === 'view') {
    const v = d as {name?: unknown; kind?: unknown; config?: unknown};
    if (!v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 100) throw new Invalid('A view template needs a name');
    if (!VIEW_KINDS.includes(String(v.kind))) throw new Invalid(`View kind must be one of: ${VIEW_KINDS.join(', ')}`);
    if (v.config !== undefined && (typeof v.config !== 'object' || v.config === null || Array.isArray(v.config))) throw new Invalid('View settings must be an object');
    return;
  }
  const x = d as {statuses?: {id?: string; name?: string; category?: string}[]; types?: unknown[]; views?: {name?: string; kind?: string}[]; items?: Node[]};
  if (!x || typeof x !== 'object') throw new Invalid('Space template data must be an object');
  if (!Array.isArray(x.statuses) || !x.statuses.length || x.statuses.some(s => !s?.id || !s?.name || !['todo', 'doing', 'done'].includes(s.category ?? '')))
    throw new Invalid('Each status needs an id, a name and a category: todo, doing or done');
  if (new Set(x.statuses.map(s => s.id)).size !== x.statuses.length) throw new Invalid('Status ids must be unique');
  if (!x.statuses.some(s => s.category === 'done')) throw new Invalid('Add at least one status in the done category');
  if (!Array.isArray(x.types) || !x.types.length || x.types.some(t => typeof t !== 'string' || !t.trim())) throw new Invalid('Add at least one level, like Task');
  if (!Array.isArray(x.views) || x.views.some(v => !v?.name || !VIEW_KINDS.includes(v.kind ?? ''))) throw new Invalid(`Each view needs a name and a kind: ${VIEW_KINDS.join(', ')}`);
  if (x.items !== undefined && !Array.isArray(x.items)) throw new Invalid('Starting items must be a list');
  if ((x.items ?? []).reduce((a, n) => a + checkTree(n), 0) > 5000) throw new Invalid('Space templates are limited to 5000 starting items');
}
