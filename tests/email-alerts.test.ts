import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {migrate} from '../server/auth.ts';
import {emailGroup} from '../server/alerts.ts';
import {sendNotificationEmail} from '../server/google.ts';

test('email alerts: groups, per-person choice, link to the task, SMTP first', async () => {
  const t = new Tasks(openDb(':memory:'), () => '2026-11-16');
  migrate(t.db);
  const ann = t.createPerson({name: 'Ann', email: 'ann@x.test'}), bob = t.createPerson({name: 'Bob', email: 'bob@x.test'});
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  const item = t.createItem({projectId: p.id, title: 'Ship it'}, bob.id);
  assert.equal(emailGroup('assigned'), 'assigned');
  assert.equal(emailGroup('mention'), 'comments');
  assert.equal(emailGroup('approved'), 'approvals');
  assert.equal(emailGroup('whatever'), 'other');

  const sent: {to: string; subject: string; text: string}[] = [];
  const smtp = async (to: string, subject: string, text: string) => { sent.push({to, subject, text}); return true; };
  const n = (kind: string) => ({person: ann.id, actor: bob.id, itemId: item.id, kind, text: 'assigned you a task'});
  assert.equal(await sendNotificationEmail(t.db, n('assigned'), {smtp, base: 'https://pm.test'}), false, 'off by default');
  t.setEmailAlerts(ann.id, {on: true, kinds: ['assigned']});
  assert.deepEqual(t.emailAlerts(ann.id), {on: true, kinds: ['assigned'], email: 'ann@x.test'});
  assert.equal(await sendNotificationEmail(t.db, n('assigned'), {smtp, base: 'https://pm.test'}), true);
  assert.equal(sent[0].to, 'ann@x.test');
  assert.match(sent[0].subject, /^Bob assigned you a task/);
  assert.match(sent[0].text, /OPS-\d+ Ship it/);
  assert.match(sent[0].text, new RegExp(`https://pm.test/#/open/${item.id}`));
  assert.equal(await sendNotificationEmail(t.db, n('comment'), {smtp}), false, 'groups not picked are not emailed');
  t.setEmailAlerts(ann.id, {kinds: null});
  assert.equal(await sendNotificationEmail(t.db, n('comment'), {smtp}), true, 'null means every group');
  assert.throws(() => t.setEmailAlerts(ann.id, {kinds: ['bogus']}), /kinds is a list/);
});
