// Shared by server, MCP and UI.

export type StatusCategory = 'todo' | 'doing' | 'done';
export type Status = {id: string; name: string; category: StatusCategory; color: string; wip?: number | null};
export type FieldKind = 'text' | 'number' | 'select' | 'multi' | 'date' | 'checkbox' | 'person' | 'url' | 'phone' | 'email' | 'relation' | 'rollup' | 'formula' | 'created' | 'updated' | 'creator' | 'files' | 'rating' | 'money' | 'time';
export type FieldDef = {id: string; name: string; kind: FieldKind; options?: string[];
  /** Formula columns: an expression over other columns, like {Cost} * {Quantity}. */
  formula?: string;
  /** Rollup columns: a calculation over subitems (via 'children') or a relation column's items. */
  rollup?: {via: string; prop: string; fn: string};
  /** Money columns: ISO currency code, like USD. */
  currency?: string};
export type Recur = {
  every: number; unit: 'day' | 'week' | 'month' | 'year';
  /** schedule: next date counts from the due date. completion: counts from the day it was finished. */
  mode: 'schedule' | 'completion';
  weekdays?: number[];          // weekly: 0 Sun .. 6 Sat
  monthBy?: 'day' | 'nth';      // monthly: same day number, or same weekday position (2nd Tue, last Fri)
  skipWeekends?: boolean;       // push Saturday or Sunday to Monday
  until?: string | null;        // stop after this date
  count?: number | null;        // occurrences left, null means forever
  reopen?: boolean;             // reopen this same item instead of creating a new one
  copySubitems?: boolean;       // copy open-or-closed subitems into the new occurrence, reset to To do
  spawned?: string;
};

export type Person = {id: string; name: string; email: string | null; color: string; kind?: 'human' | 'ai'};

export type Project = {
  id: string; name: string; key: string;
  statuses: Status[]; types: string[]; fields: FieldDef[];
  sort: number; created: string;
  settings: ProjectSettings;
};

/** Fields a new subitem copies from its parent. Keys are item fields, or "f:<fieldId>" for custom fields. */
export type InheritKey = 'assignees' | 'sprint' | 'priority' | 'tags' | 'due' | 'start' | `f:${string}`;

export type ProjectSettings = {
  inherit: InheritKey[];
  automations: Rule[];
  webhooks: {id: string; url: string; events: string[]}[];
  autoRollover: boolean;           // move unfinished work when a sprint ends
  /** Who can do what here: a default role for everyone (or 'inherit' their workspace role, or 'none'), plus per-person roles. */
  access?: {default: string; members: Record<string, string>};
  /** When false (default), AI agents cannot move work to a Done status themselves; a person approves it. */
  aiMayComplete?: boolean;
  /** Rules per item type: allowed status moves, fields required before Done, approval required, humans only. */
  workflow?: Record<string, TypeRule>;
  /** Sidebar look: a lucide icon ("lucide:Rocket") or an emoji, and a color. */
  icon?: string; color?: string;
  /** When dates move: skip weekends, and whether steps that follow another move always (gap) or only when they would overlap. */
  dates?: {skipWeekends?: boolean; shift?: 'gap' | 'overlap'};
  /** A rollup shows work from other projects together. include null means every project. */
  rollup?: {include: string[] | null};
};

export type TypeRule = {
  transitions?: Record<string, string[]>;   // from status id -> allowed next status ids (missing = any)
  required?: string[];                       // estimate, assignees, due, start, body, or f:<fieldId>, needed before Done
  requireApproval?: boolean;                 // every requested approval signed, and the item unchanged since
  humansOnly?: boolean;                      // only people (not AI agents) may move it to Done
};

// Automations: when <trigger> and <conditions>, do <actions>.
export type Trigger =
  | {kind: 'created'}
  | {kind: 'status'; to: string}            // status changes to
  | {kind: 'assigned'}                      // someone is added as assignee
  | {kind: 'completed'}
  | {kind: 'due-passed'};                   // checked hourly
export type Condition = {field: 'type' | 'priority' | 'tag' | 'assignee' | 'parent-type'; value: string};
export type Action =
  | {kind: 'status'; value: string}
  | {kind: 'assign'; value: string}         // person id, or "creator"
  | {kind: 'priority'; value: number}
  | {kind: 'tag'; value: string}
  | {kind: 'sprint'; value: 'current' | 'next' | 'none'}
  | {kind: 'due'; value: number}            // days from today
  | {kind: 'notify'; value: string}         // person id, or "assignees" / "creator"
  | {kind: 'template'; value: string}       // add subitems from an item template
  | {kind: 'parent-status'; value: string}; // set the parent's status (e.g. close story when all tasks close)
export type Rule = {id: string; name: string; enabled: boolean; trigger: Trigger; conditions: Condition[]; actions: Action[]; allChildrenDone?: boolean};

export type Template = {id: string; kind: 'item' | 'project' | 'view'; name: string; projectId: string | null; data: unknown; created: string};

export type Item = {
  id: string; projectId: string; parentId: string | null; number: number;
  type: string; title: string; body: string; status: string; priority: number;
  assignees: string[]; start: string | null; due: string | null; estimate: number | null;
  tags: string[]; sprint: string | null; sort: number; recur: Recur | null;
  fields: Record<string, unknown>; createdBy: string | null;
  created: string; updated: string; completed: string | null;
  deps: string[]; // ids of items that block this one (finish-to-start)
};

export type Comment = {id: string; itemId: string; author: string; body: string; created: string; assignee?: string | null; resolved?: string | null};
/** minutes can be fractional: timers record to the second. kind 'review' is time spent reviewing the task's work. */
export type TimeEntry = {id: string; itemId: string; person: string; start: string; end: string | null; minutes: number | null; note: string | null; kind: 'work' | 'review'};
export type Notification = {id: string; person: string; itemId: string | null; kind: string; text: string; actor: string | null; created: string; read: boolean};

// 0 none, 1 urgent, 2 high, 3 medium, 4 low (sorted ascending with none last).
export const PRIORITIES = ['None', 'Urgent', 'High', 'Medium', 'Low'] as const;

export type ItemPatch = Partial<Pick<Item,
  'parentId' | 'type' | 'title' | 'body' | 'status' | 'priority' | 'assignees' | 'start' | 'due' |
  'estimate' | 'tags' | 'sprint' | 'sort' | 'recur' | 'fields' | 'projectId' | 'deps'>>;

export type ChangeEvent =
  | {kind: 'item'; item: Item}
  | {kind: 'item-deleted'; id: string; projectId: string}
  | {kind: 'project'; project: Project}
  | {kind: 'project-deleted'; id: string}
  | {kind: 'people'}
  | {kind: 'notification'; person: string}
  | {kind: 'comment'; itemId: string}
  | {kind: 'time'; itemId: string}
  | {kind: 'sprint'; projectId: string}
  | {kind: 'view'; projectId: string}
  | {kind: 'template'}
  | {kind: 'refresh'};

export type Sprint = {
  id: string; projectId: string; name: string; start: string; end: string; goal: string;
  capacity: Record<string, number>; // hours per person for the sprint
  created: string;
};

export type ViewKind = 'list' | 'table' | 'board' | 'gantt' | 'backlog' | 'sprint' | 'calendar' | 'workload' | 'files';
export type ViewConfig = {
  text?: string; assignee?: string; hideDone?: boolean; types?: string[]; sprint?: string;
  groupBy?: 'status' | 'priority' | 'assignee' | 'type' | 'sprint';
  columns?: {id: string; width: number}[]; hidden?: string[];
  /** Table footer calculation per column id: sum, avg, count and so on. */
  calcs?: Record<string, string>;
  filter?: FilterGroup; dueOnly?: boolean; dailyHours?: number; swimlane?: 'none' | 'assignee' | 'priority' | 'type' | 'parent' | 'worker';
  /** Timeline: highlight the critical path; saved baselines (dates at a moment) and which one to show. */
  /** Board: show the first image attachment on each card. */
  covers?: boolean;
  /** Locked views keep their filters, sort and columns until unlocked. Private views show only for privateTo. */
  locked?: boolean; privateTo?: string;
  /** Conditional colors: the first matching rule tints the row or card. */
  colors?: {rule: FilterRule; color: string}[];
  critical?: boolean; baselines?: {name: string; at: string; dates: Record<string, [string | null, string | null]>}[]; baseline?: number | null;
  zoom?: 'day' | 'week' | 'month'; colorBy?: 'type' | 'assignee' | 'status' | 'priority'; level?: string; sort?: {col: string; dir: 1 | -1} | null; sorts?: {col: string; dir: 1 | -1}[];
};
/** Filters: a group of rules joined by AND or OR; a rule can itself be a group (one level of nesting in the UI). */
export type FilterRule = {field: string; op: 'is' | 'is-not' | 'contains' | 'empty' | 'not-empty' | 'before' | 'after' | 'gte' | 'lte'; value?: string};
export type FilterGroup = {join: 'and' | 'or'; rules: (FilterRule | FilterGroup)[]};

export type View = {id: string; projectId: string; name: string; kind: ViewKind; config: ViewConfig; sort: number};

/** One saved change. before/after hold only the changed fields (or the whole item for create and delete). */
export type Activity = {id: number; at: string; actor: string | null; kind: 'create' | 'update' | 'delete' | 'revert'; itemId: string; projectId: string; title: string; before: unknown; after: unknown};

export type BurnPoint = {date: string; remaining: number; remainingHours: number; ideal: number; idealHours: number; done: number};
