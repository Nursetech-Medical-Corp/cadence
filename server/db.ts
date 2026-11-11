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
  db.exec(SCHEMA);
  // Columns added after the first release.
  const cols = db.prepare('pragma table_info(items)').all().map(r => r.name);
  if (!cols.includes('deps')) db.exec("alter table items add column deps text not null default '[]'");
  const pcols = db.prepare('pragma table_info(projects)').all().map(r => r.name);
  if (!pcols.includes('settings')) db.exec("alter table projects add column settings text not null default '{}'");
  const people = db.prepare('pragma table_info(people)').all().map(r => r.name);
  if (!people.includes('kind')) db.exec("alter table people add column kind text not null default 'human'");
  return db;
}

export type Db = DatabaseSync;
