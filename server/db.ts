import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const SCHEMA = `
create table if not exists people (
  id text primary key, name text not null, email text, color text not null
);
create table if not exists projects (
  id text primary key, name text not null, key text not null,
  statuses text not null, types text not null, fields text not null,
  sort real not null, created text not null
);
create table if not exists items (
  id text primary key, project_id text not null references projects(id) on delete cascade,
  parent_id text, number integer not null, type text not null, title text not null, body text not null default '',
  status text not null, priority integer not null default 0, assignees text not null default '[]',
  start text, due text, estimate real, tags text not null default '[]', sprint text,
  sort real not null, recur text, fields text not null default '{}',
  created_by text, created text not null, updated text not null, completed text
);
create index if not exists items_project on items(project_id);
create index if not exists items_parent on items(parent_id);
create table if not exists comments (
  id text primary key, item_id text not null references items(id) on delete cascade,
  author text not null, body text not null, created text not null
);
create table if not exists time_entries (
  id text primary key, item_id text not null references items(id) on delete cascade,
  person text not null, start text not null, end text, minutes real, note text
);
create table if not exists notifications (
  id text primary key, person text not null, item_id text, kind text not null,
  text text not null, actor text, created text not null, read integer not null default 0
);
create index if not exists notifications_person on notifications(person, read);
create index if not exists time_person_start on time_entries(person, start);
create index if not exists time_item on time_entries(item_id);
-- Personal layout per person: their own view settings, tab order and project order.
create table if not exists prefs (person text not null, key text not null, value text not null, primary key (person, key));
create index if not exists time_running on time_entries(person) where end is null;
create table if not exists sprints (
  id text primary key, project_id text not null references projects(id) on delete cascade,
  name text not null, start text not null, end text not null, goal text not null default '',
  capacity text not null default '{}', created text not null
);
create table if not exists activity (
  id integer primary key autoincrement, at text not null, actor text, kind text not null,
  item_id text not null, project_id text not null, title text not null, before text, after text
);
create index if not exists activity_item on activity(item_id);
create index if not exists activity_project on activity(project_id, id);
create table if not exists rule_runs (rule_id text not null, item_id text not null, primary key (rule_id, item_id));
-- Date rules run once per rule, item and date value, so they run again when the date changes.
create table if not exists rule_fires (rule_id text not null, item_id text not null, stamp text not null, primary key (rule_id, item_id, stamp));
-- Date events (due soon, overdue, sprint started) sent once each.
create table if not exists event_runs (key text primary key, at text not null);
-- Outbound webhooks: every delivery with its status, and the signing secrets (kept out of settings so they are never sent to browsers).
create table if not exists hook_deliveries (
  id text primary key, hook text not null, scope text not null, url text not null, secret_key text, event text not null, body text not null,
  status text not null, attempts integer not null default 0, next_at text, code integer, error text, created text not null, updated text
);
create index if not exists hook_deliveries_due on hook_deliveries(status, next_at);
create index if not exists hook_deliveries_scope on hook_deliveries(scope, created);
create table if not exists hook_secrets (key text primary key, secret text not null);
create table if not exists workspace (key text primary key, value text not null);
create table if not exists templates (
  id text primary key, kind text not null, name text not null, project_id text, data text not null, created text not null
);
create table if not exists views (
  id text primary key, project_id text not null references projects(id) on delete cascade,
  name text not null, kind text not null, config text not null default '{}', sort real not null
);
`;

export function openDb(path = process.env.TASKS_DB ?? 'data/tasks.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 3000;');
  const fresh = !db.prepare("select 1 from sqlite_master where type = 'table' and name = 'event_runs'").get() && !!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'items'").get();
  db.exec(SCHEMA);
  if (fresh) {
    // Upgrading a workspace: due-date rules that already ran keep their mark for the current due date,
    // and date events for dates already reached are not sent for old work (see Tasks.periodic).
    db.exec("insert or ignore into rule_fires select r.rule_id, r.item_id, i.due from rule_runs r join items i on i.id = r.item_id where i.due is not null");
    db.prepare("insert or ignore into event_runs (key, at) values ('baseline-pending', ?)").run(new Date().toISOString());
  }
  // Columns added after the first release.
  const cols = db.prepare('pragma table_info(items)').all().map(r => r.name);
  if (!cols.includes('deps')) db.exec("alter table items add column deps text not null default '[]'");
  const pcols = db.prepare('pragma table_info(projects)').all().map(r => r.name);
  if (!pcols.includes('settings')) db.exec("alter table projects add column settings text not null default '{}'");
  const people = db.prepare('pragma table_info(people)').all().map(r => r.name);
  if (!people.includes('kind')) db.exec("alter table people add column kind text not null default 'human'");
  if (!people.includes('sort')) db.exec('alter table people add column sort real');
  // AI agents belong to a person (owner) and carry their own settings (server/agents.ts).
  if (!people.includes('owner')) db.exec('alter table people add column owner text');
  if (!people.includes('agent')) db.exec('alter table people add column agent text');
  // Assigned comments: a comment can be a to-do for one person until resolved.
  const ccols = db.prepare('pragma table_info(comments)').all().map(r => r.name);
  if (!ccols.includes('assignee')) db.exec('alter table comments add column assignee text; alter table comments add column resolved text');
  db.exec('create index if not exists comments_assignee on comments(assignee) where resolved is null');
  // Time entries: work, or reviewing someone's (often an AI's) work.
  if (!db.prepare('pragma table_info(time_entries)').all().some(r => r.name === 'kind')) db.exec("alter table time_entries add column kind text not null default 'work'");
  return db;
}

export type Db = DatabaseSync;
