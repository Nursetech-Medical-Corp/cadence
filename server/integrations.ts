// Outside connections that need no accounts:
// - Calendar feed (iCalendar .ics): subscribe from Google Calendar, Outlook or Apple Calendar.
// - Webhooks (server/webhooks.ts): POST a JSON payload to any URL (Zapier, Make, n8n, Slack workflows) when things change.
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import type {Tasks} from './service.ts';

/** Webhooks may only reach public addresses, so a project setting cannot be used to probe this machine or network. */
export async function safeTarget(url: string) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [host] : (await lookup(host, {all: true})).map(a => a.address);
    return addrs.every(a => !/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(127|10|192\.168)\.)/i.test(a));
  } catch { return false; }
}
import {addUnit} from '../src/dates.ts';

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n|\r/g, '\\n').replace(/[,;]/g, m => '\\' + m).replace(/[\u0000-\u001f]/g, ' ');
const day = (d: string) => d.replace(/-/g, '');

/** Items with dates as all-day events. Filter by person and/or project. */
export function calendarFeed(tasks: Tasks, q: {person?: string; project?: string; baseUrl: string; canSee?: (projectId: string) => boolean}) {
  const projects = new Map(tasks.listProjects().map(p => [p.id, p]));
  const items = tasks.listItems({projectId: q.project, assignee: q.person}).filter(i => (i.due || i.start) && (!q.canSee || q.canSee(i.projectId)));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cadence//Cadence//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc('Cadence')}${q.person ? ' for ' + (tasks.listPeople().find(p => p.id === q.person)?.name ?? '') : ''}${q.project ? ' - ' + (projects.get(q.project)?.name ?? '') : ''}`];
  for (const i of items) {
    const p = projects.get(i.projectId)!;
    const start = i.start ?? i.due!, end = addUnit(i.due ?? i.start!, 1, 'day');
    const status = p.statuses.find(s => s.id === i.status)?.name ?? i.status;
    lines.push('BEGIN:VEVENT', `UID:${i.id}@cadence`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(start)}`, `DTEND;VALUE=DATE:${day(end)}`,
      `SUMMARY:${i.completed ? '[Done] ' : ''}${esc(`${p.key}-${i.number} ${i.title}`)}`,
      `DESCRIPTION:${esc(`${status}${i.body ? '\n\n' + i.body : ''}`)}`,
      `URL:${q.baseUrl}/#/p/${p.id}/`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // Lines over 75 octets must be folded.
  return lines.map(l => l.length <= 74 ? l : l.match(/.{1,73}/g)!.join('\r\n ')).join('\r\n') + '\r\n';
}
