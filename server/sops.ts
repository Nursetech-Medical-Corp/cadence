// SOP links: one table that maps SOP codes (the SOP-xx.x tags on items) to their documents, so every routine
// and task tagged with an SOP opens its procedure in one click. Code "*" is the fallback, such as the SOP master list.
import type {Tasks} from './service.ts';
import {Invalid} from './errors.ts';

export type SopLink = {code: string; url: string; title: string};

export function migrateSops(tasks: Tasks) {
  tasks.db.exec('create table if not exists sop_links (code text primary key, url text not null, title text not null default \'\')');
}
export const sopCode = (tag: string) => /^sop-[0-9a-z]+\.\d+$/i.test(tag) ? tag.toUpperCase() : null;

export function listSopLinks(tasks: Tasks): SopLink[] {
  return tasks.db.prepare('select code, url, title from sop_links order by code').all() as SopLink[];
}
/** Add or replace links. An empty url removes that code. */
export function setSopLinks(tasks: Tasks, links: {code: string; url?: string | null; title?: string}[]): SopLink[] {
  if (!Array.isArray(links) || !links.length) throw new Invalid('Send links like [{code: "SOP-07.2", url: "https://..."}]');
  for (const l of links) {
    const code = l.code === '*' ? '*' : sopCode(String(l.code ?? ''));
    if (!code) throw new Invalid(`"${l.code}" is not an SOP code like SOP-07.2 (or * for the fallback)`);
    if (!l.url) { tasks.db.prepare('delete from sop_links where code = ?').run(code); continue; }
    if (!/^https:\/\//.test(l.url)) throw new Invalid(`The link for ${code} must start with https://`);
    tasks.db.prepare('insert into sop_links (code, url, title) values (?, ?, ?) on conflict(code) do update set url = excluded.url, title = excluded.title')
      .run(code, l.url, String(l.title ?? '').slice(0, 300));
  }
  tasks.emit({kind: 'sops'});
  return listSopLinks(tasks);
}
