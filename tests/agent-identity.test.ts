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
  assert.deepEqual(inbox.rules, {workspace: 'Never email customers.', agent: 'You run Marketing. Draft only.'});
  assert.throws(() => saveAgentSettings(t, a.id, {instructions: 'x'.repeat(9000)}, david.id), /8000/);
  assert.throws(() => saveAgentSettings(t, a.id, {instructions: 'mine now'}, a.id), /cannot change agent settings/);
});
