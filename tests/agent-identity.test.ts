import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {addAgent, agentInbox, agentSettings, makeAgent, migrateAgents, saveAgentSettings} from '../server/agents.ts';
import {migrate, saveWorkspace} from '../server/auth.ts';
import {migrateAiWork} from '../server/aiwork.ts';
import {migrateEvents} from '../server/events.ts';

function setup() {
  const t = new Tasks(openDb(':memory:'), () => '2026-11-16');
  migrate(t.db); migrateAiWork(t); migrateEvents(t); migrateAgents(t);
  const david = t.createPerson({name: 'David', email: 'd@x.test'});
  t.db.prepare('update people set admin = 1 where id = ?').run(david.id);
  return {t, david};
}

test('an AI is one identity: no second agent with a team member name, and a person row can become the agent', () => {
  const {t, david} = setup();
  // An AI that accepted an invite as a person.
  const joey = t.createPerson({name: 'Joey', email: 'joey-agent@muse.ai'});
  t.db.prepare('update people set admin = 1 where id = ?').run(joey.id);
  assert.throws(() => addAgent(t, david.id, {name: 'joey'}), /already on the team as a person/);
  assert.throws(() => makeAgent(t, david.id, david.id), /yourself/);
  makeAgent(t, joey.id, david.id);
  const row = t.db.prepare('select kind, owner, admin from people where id = ?').get(joey.id) as {kind: string; owner: string; admin: number};
  assert.deepEqual({...row}, {kind: 'ai', owner: david.id, admin: 0}, 'owned, never admin');
  assert.equal(agentSettings(t, joey.id).writePolicy, 'review', 'changes wait for approval by default');
  assert.throws(() => addAgent(t, david.id, {name: 'Joey'}), /already an AI agent/);
});

test('agents get the workspace rules and their own rules every run', () => {
  const {t, david} = setup();
  const a = addAgent(t, david.id, {name: 'Helper'});
  saveWorkspace(t.db, {aiRules: 'Never email customers.'});
  saveAgentSettings(t, a.id, {instructions: 'You run Marketing. Draft only.'}, david.id);
  const inbox = agentInbox(t, a.id);
  assert.equal(inbox.rules.workspace, 'Never email customers.');
  assert.equal(inbox.rules.agent, 'You run Marketing. Draft only.');
  assert.ok(inbox.rules.builtIn.some(r => /never an admin/.test(r)), 'the built-in rules come too');
  assert.throws(() => saveAgentSettings(t, a.id, {instructions: 'x'.repeat(9000)}, david.id), /8000/);
  assert.throws(() => saveAgentSettings(t, a.id, {instructions: 'mine now'}, a.id), /cannot change agent settings/);
});

test('AI work and Approvals are one flow: asking for approval hands the work in, signing decides it', async () => {
  const {migrateApprovals} = await import('../server/approvals.ts');
  const {t, david} = setup();
  migrateApprovals(t);
  const a = addAgent(t, david.id, {name: 'Worker'});
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  const one = t.createItem({projectId: p.id, title: 'Draft the memo', fields: {worker: 'ai'}}, david.id);
  t.claimTask(one.id, a.id, 'I can do it');
  t.decideClaim(one.id, david.id, true);
  t.requestApproval(one.id, a.id, [david.id], 'approved', 'Memo is attached');
  assert.equal((t.item(one.id).fields.review as {state: string}).state, 'submitted', 'the card moves to Ready for review');
  const ap = t.listApprovals({itemId: one.id, pending: true})[0];
  t.signApproval(ap.id, david.id, 'approved', '');
  assert.equal((t.item(one.id).fields.review as {state: string}).state, 'approved', 'signing approves the AI work');

  const two = t.createItem({projectId: p.id, title: 'Second memo', fields: {worker: 'ai'}}, david.id);
  t.claimTask(two.id, a.id); t.decideClaim(two.id, david.id, true);
  t.requestApproval(two.id, a.id, [david.id], 'approved');
  t.reviewWork(two.id, david.id, 'changes', 'Shorter please');
  const settled = t.listApprovals({itemId: two.id})[0];
  assert.equal(settled.decision, 'changes', 'deciding on AI work settles the approval too');
  const {suggestFollowUps, listProposals} = await import('../server/agents.ts');
  const ups = suggestFollowUps(t, a.id, two.id, [{title: 'Fix the two broken links', reason: 'Found in review'}]);
  assert.equal(ups.length, 1);
  assert.ok(listProposals(t, {agent: a.id}).some(x => x.state === 'pending' && /Fix the two broken links/.test(x.summary)), 'follow-ups wait for the owner');
  assert.equal(listProposals(t, {itemId: two.id}).length, 1, 'kept with the task they came from, for its reviewer');
});

test('signing: password once per session, every time, or never; several at once; drag AI work between lanes', async () => {
  const {migrateApprovals} = await import('../server/approvals.ts');
  const {hashPassword} = await import('../server/auth.ts');
  const {t, david} = setup();
  migrateApprovals(t);
  t.db.prepare('update people set password = ? where id = ?').run(hashPassword('pw-123456'), david.id);
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  const ask = (title: string) => { const i = t.createItem({projectId: p.id, title}, david.id); return t.requestApproval(i.id, null, [david.id], 'approved', '')[0].id; };
  const [a1, a2, a3, a4] = [ask('One'), ask('Two'), ask('Three'), ask('Four')];
  assert.equal(t.signNeeds(david.id).mode, 'session', 'once per session by default');
  assert.equal(t.signNeeds(david.id).password, true);
  assert.throws(() => t.signApproval(a1, david.id, 'approved', ''), /needs your password/);
  assert.throws(() => t.signApproval(a1, david.id, 'approved', '', 'wrong'), /wrong/);
  const many = t.signApprovals([a1, a2], david.id, 'approved', '', 'pw-123456');
  assert.equal(many.signed.length, 2, 'one password signs several');
  assert.equal(many.signed[0].auth, 'password');
  assert.equal(many.signed[1].auth, 'session');
  assert.equal(t.signNeeds(david.id).password, false, 'no password for the rest of the session');
  assert.equal(t.signApproval(a3, david.id, 'approved', '').auth, 'session');
  saveWorkspace(t.db, {signPassword: 'every'});
  assert.throws(() => t.signApproval(a4, david.id, 'approved', ''), /needs your password/, 'every time ignores the session');
  saveWorkspace(t.db, {signPassword: 'never'});
  assert.equal(t.signApproval(a4, david.id, 'approved', '').auth, 'none');

  const a = addAgent(t, david.id, {name: 'Mover'});
  const job = t.createItem({projectId: p.id, title: 'Draft', fields: {worker: 'ai'}}, david.id);
  t.claimTask(job.id, a.id);
  assert.throws(() => t.moveWork(job.id, a.id, 'done'), /Only a person/);
  t.moveWork(job.id, david.id, 'working');
  assert.equal((t.item(job.id).fields.review as {state: string}).state, 'accepted', 'dragging a claim to working accepts it');
  t.moveWork(job.id, david.id, 'review');
  assert.equal((t.item(job.id).fields.review as {state: string}).state, 'submitted');
  t.moveWork(job.id, david.id, 'working');
  assert.equal((t.item(job.id).fields.review as {state: string}).state, 'changes', 'back to working sends it back');
  t.moveWork(job.id, david.id, 'done');
  assert.equal((t.item(job.id).fields.review as {state: string}).state, 'approved', 'done hands it in and approves');
  assert.throws(() => t.moveWork(job.id, david.id, 'review'), /cannot move/);
});

test('merge a duplicate row: an AI that joined as a person and was added again as an agent', async () => {
  const {migrateApprovals} = await import('../server/approvals.ts');
  const {t, david} = setup();
  migrateApprovals(t);
  const joeyPerson = t.createPerson({name: 'Joey', email: 'joey@muse.test'});
  const joeyAgent = addAgent(t, joeyPerson.id === david.id ? david.id : joeyPerson.id, {name: 'Joey bot'});
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  const job = t.createItem({projectId: p.id, title: 'Sweep', assignees: [david.id, joeyAgent.id, joeyPerson.id], fields: {worker: 'ai'}}, david.id);
  t.addComment(job.id, joeyAgent.id, 'Working on it');
  makeAgent(t, joeyPerson.id, david.id);
  const r = t.mergePeople(joeyAgent.id, joeyPerson.id, david.id);
  assert.equal(r.kept, joeyPerson.id);
  assert.deepEqual(t.item(job.id).assignees, [david.id, joeyPerson.id], 'assignees merged, no duplicate');
  const row = t.db.prepare('select kind, owner, active from people where id = ?').get(joeyPerson.id) as {kind: string; owner: string; active: number};
  assert.deepEqual({...row}, {kind: 'ai', owner: david.id, active: 1});
  assert.equal((t.db.prepare('select active from people where id = ?').get(joeyAgent.id) as {active: number}).active, 0, 'the merged row is deactivated, not deleted');
  assert.equal((t.db.prepare('select count(*) as n from comments where author = ?').get(joeyPerson.id) as {n: number}).n, 1, 'comments move');
  assert.throws(() => t.mergePeople(david.id, david.id, david.id), /different/);

  // Work an agent did by assignment (no claim): asking for approval hands it in; dragging works too.
  const done = t.createItem({projectId: p.id, title: 'Report', assignees: [joeyPerson.id], fields: {worker: 'ai'}}, david.id);
  t.moveWork(done.id, david.id, 'review');
  assert.equal((t.item(done.id).fields.review as {state: string}).state, 'submitted', 'an assigned agent\'s work can be moved to review');
});
