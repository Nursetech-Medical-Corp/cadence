import {parseDateWord} from './dates.ts';
import type {Person, Recur} from './types.ts';

export type Parsed = {
  title: string; assignees: string[]; priority?: number; tags: string[];
  due?: string; start?: string; estimate?: number; recur?: Recur; type?: string;
  sprint?: 'current' | 'next' | 'none' | string;
};

const PRIO: Record<string, number> = {urgent: 1, u: 1, '1': 1, high: 2, h: 2, '2': 2, medium: 3, med: 3, m: 3, '3': 3, low: 4, l: 4, '4': 4};
const UNITS: Record<string, Recur['unit']> = {d: 'day', day: 'day', daily: 'day', w: 'week', week: 'week', weekly: 'week', m: 'month', month: 'month', monthly: 'month', y: 'year', year: 'year', yearly: 'year'};

// "Fix login @dave !high #bug due:fri start:mon ~3h every:2w type:Bug"
export function parseQuickAdd(text: string, people: Person[], today: string, types: string[] = []): Parsed {
  const out: Parsed = {title: '', assignees: [], tags: []};
  const words: string[] = [];
  for (const tok of text.trim().split(/\s+/)) {
    if (!tok) continue;
    if (tok.length > 1 && tok.startsWith('@')) {
      const q = tok.slice(1).toLowerCase();
      const p = people.find(p => p.name.toLowerCase() === q || p.name.toLowerCase().replace(/\s+/g, '') === q) ?? people.find(p => p.name.toLowerCase().startsWith(q));
      if (p) { if (!out.assignees.includes(p.id)) out.assignees.push(p.id); continue; }
    }
    if (tok.startsWith('!') && PRIO[tok.slice(1).toLowerCase()]) { out.priority = PRIO[tok.slice(1).toLowerCase()]; continue; }
    if (tok.length > 1 && tok.startsWith('#')) { out.tags.push(tok.slice(1)); continue; }
    const kv = /^(due|start|every|type|sprint|sp):(.+)$/i.exec(tok);
    if (kv) {
      const key = kv[1].toLowerCase(), val = kv[2];
      if (key === 'due' || key === 'start') {
        const d = parseDateWord(val, today);
        if (d) { out[key] = d; continue; }
      } else if (key === 'every') {
        if (/^weekdays?$/i.test(val)) { out.recur = {every: 1, unit: 'week', mode: 'schedule', weekdays: [1, 2, 3, 4, 5]}; continue; }
        const m = /^(\d*)([a-z]+)(!?)$/i.exec(val);
        const unit = m && UNITS[m[2].toLowerCase()];
        if (m && unit) { out.recur = {every: Number(m[1] || 1), unit, mode: m[3] ? 'completion' : 'schedule'}; continue; }
      } else if (key === 'sprint' || key === 'sp') {
        const v = val.toLowerCase();
        out.sprint = v === 'now' || v === 'current' || v === 'this' ? 'current' : v === 'next' ? 'next' : v === 'none' || v === 'backlog' ? 'none' : val;
        continue;
      } else {
        const t = types.find(t => t.toLowerCase() === val.toLowerCase());
        if (t) { out.type = t; continue; }
      }
    }
    const est = /^~(\d+(?:\.\d+)?)(h|m)?$/i.exec(tok);
    if (est) { out.estimate = est[2]?.toLowerCase() === 'm' ? Number(est[1]) / 60 : Number(est[1]); continue; }
    words.push(tok);
  }
  out.title = words.join(' ');
  return out;
}
