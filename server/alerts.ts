// Email alerts: which notifications a person also gets by email. Stored on people (notify_email, notify_kinds).
import type {Db} from './db.ts';
import {Invalid} from './errors.ts';

/** Groups of notification kinds a person can pick for email. Unknown kinds count as "other". */
export const EMAIL_GROUPS = ['assigned', 'comments', 'approvals', 'completed', 'reminders', 'automations', 'other'] as const;
export type EmailGroup = typeof EMAIL_GROUPS[number];
export function emailGroup(kind: string): EmailGroup {
  if (kind.startsWith('assign')) return 'assigned';
  if (kind === 'comment' || kind === 'mention') return 'comments';
  if (/^(approv|reject|review|verif|redo|ai$|sign)/.test(kind)) return 'approvals';
  if (kind === 'completed') return 'completed';
  if (kind === 'reminder' || kind === 'timer' || kind === 'meeting') return 'reminders';
  if (kind === 'automation' || kind === 'notify') return 'automations';
  return 'other';
}

export type EmailAlerts = {on: boolean; kinds: EmailGroup[] | null; email: string | null};

export function getEmailAlerts(db: Db, person: string): EmailAlerts {
  const r = db.prepare('select email, notify_email, notify_kinds from people where id = ?').get(person) as {email: string | null; notify_email: number; notify_kinds: string | null} | undefined;
  if (!r) throw new Invalid('No such person');
  let kinds: EmailGroup[] | null = null;
  try { kinds = r.notify_kinds ? JSON.parse(r.notify_kinds) : null; } catch { kinds = null; }
  return {on: !!r.notify_email, kinds, email: r.email};
}

/** on: email notifications at all. kinds: which groups (null means all). */
export function setEmailAlerts(db: Db, person: string, patch: {on?: boolean; kinds?: unknown}): EmailAlerts {
  getEmailAlerts(db, person);
  if (patch.on !== undefined) db.prepare('update people set notify_email = ? where id = ?').run(patch.on ? 1 : 0, person);
  if (patch.kinds !== undefined) {
    const ks = patch.kinds === null ? null : Array.isArray(patch.kinds) ? [...new Set(patch.kinds.map(String))] : undefined;
    if (ks === undefined || ks?.some(k => !(EMAIL_GROUPS as readonly string[]).includes(k))) throw new Invalid(`kinds is a list of: ${EMAIL_GROUPS.join(', ')} (or null for all)`);
    db.prepare('update people set notify_kinds = ? where id = ?').run(ks ? JSON.stringify(ks) : null, person);
  }
  return getEmailAlerts(db, person);
}
