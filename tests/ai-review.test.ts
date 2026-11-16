// AI review decisions: approve, changes, redo, discard; sessions, artifacts and cleanup.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {createMcpServer} from '../server/mcp.ts';
import {guarded} from '../server/tokens.ts';
import {migrate} from '../server/auth.ts';
import {migrateAiWork} from '../server/aiwork.ts';
import {migrateEvents} from '../server/events.ts';
import {addAgent, agentInbox, saveAgentSettings, startAgents} from '../server/agents.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]).toString('base64');

function setup() {
  const t = new Tasks(openDb(':memory:'), () => '2026-11-10');
  t.dataDir = mkdtempSync(join(tmpdir(), 'tasks-review-'));
  migrate(t.db); migrateAiWork(t); migrateEvents(t);
  startAgents(t);
  const dave = t.createPerson({name: 'David', email: 'd@x.test'});
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  const bot = addAgent(t, dave.id, {name: "David's Claude"});
  saveAgentSettings(t, bot.id, {writePolicy: 'direct'}, dave.id);
  const names: string[] = [];
  t.onEvent(e => { if (e.event.startsWith('ai.')) names.push(e.event); });
  /** A task the agent claimed and a person accepted. */
  const accepted = (title = 'Write the report') => {
    const i = t.createItem({projectId: p.id, title, body: 'Original', fields: {worker: 'ai'}}, dave.id);
    t.claimTask(i.id, bot.id, 'On it', 'https://claude.ai/chat/abc');
    t.decideClaim(i.id, dave.id, true);
    return t.item(i.id);
  };
  const state = (id: string) => (t.item(id).fields.review as {state: string}).state;
  return {t, dave, p, bot, names, accepted, state};
}
const mcp = async (t: Tasks, as: string) => {
  const server = createMcpServer(guarded(t, as), as);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'test', version: '1'});
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({name, arguments: args});
    const text = (r.content as {text: string}[])[0].text;
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  };
};

test('approve and send back still take true and false; the session is kept for the agent', () => {
  const {t, dave, bot, names, accepted, state} = setup();
  const i = accepted();
  assert.deepEqual([(i.fields.review as {session: string}).session, i.status, i.assignees.includes(bot.id)], ['https://claude.ai/chat/abc', 'doing', true]);
  t.logWork(i.id, bot.id, 'step', 'Drafted', null, {session: 'run-2'});
  t.submitWork(i.id, bot.id, 'Report v1', 'No totals');
  t.reviewWork(i.id, dave.id, false, 'Add totals');
  const f = t.workFeedback(i.id);
  assert.deepEqual([f.decision, f.comment, f.session, f.context.report, f.context.missed], ['changes', 'Add totals', 'run-2', 'Report v1', 'No totals']);
  assert.ok(f.context.steps.some(s => s.text === 'Drafted'));
  t.submitWork(i.id, bot.id, 'Report v2', '', {session: 'run-3'});
  assert.equal((t.item(i.id).fields.review as {decision?: string}).decision, undefined, 'a new submission clears the old decision');
  t.reviewWork(i.id, dave.id, true);
  assert.deepEqual([state(i.id), t.item(i.id).status, t.workFeedback(i.id).session], ['approved', 'done', 'run-3']);
  assert.deepEqual(names.filter(n => n !== 'ai.step_logged'), ['ai.claimed', 'ai.accepted', 'ai.submitted', 'ai.changes_requested', 'ai.submitted', 'ai.approved']);
  assert.throws(() => t.reviewWork(i.id, dave.id, 'maybe' as never), /Decision must be one of/);
});

test('redo sends the task back to the agent to start over: files hidden, outside artifacts listed for cleanup', () => {
  const {t, dave, bot, accepted, state} = setup();
  const i = accepted();
  const file = t.attachFile(i.id, bot.id, 'shot.png', 'image/png', PNG);
  const mine = t.attachFile(i.id, dave.id, 'brief.png', 'image/png', PNG);
  t.logWork(i.id, bot.id, 'link', 'Opened a branch', 'https://git.example.test/tree/report', {artifact: {kind: 'branch', ref: 'feat/report', url: 'https://git.example.test/tree/report', undo: 'Delete branch feat/report'}});
  const sub = t.createItem({projectId: i.projectId, parentId: i.id, title: 'Appendix'}, bot.id);
  t.submitWork(i.id, bot.id, 'Report v1', '', {artifacts: [{kind: 'commit', ref: 'abc123', undo: 'git revert abc123'}, {kind: 'doc', ref: 'Report draft', url: 'https://docs.example.test/d/1'}]});
  assert.deepEqual(t.workArtifacts(i.id).map(a => a.kind), ['file', 'branch', 'commit', 'doc', 'item']);
  assert.throws(() => t.reviewWork(i.id, dave.id, 'redo'), /needs a comment/);
  assert.throws(() => t.submitWork(i.id, bot.id, 'x', '', {artifacts: [{kind: 'spaceship' as never, ref: 'x'}]}), /another agent|Wait until|Artifact kind/);

  t.reviewWork(i.id, dave.id, 'redo', 'Wrong quarter. Start again from the Q3 numbers.');
  const it = t.item(i.id);
  assert.deepEqual([state(i.id), it.status, it.assignees.includes(bot.id), (it.fields.review as {attempt: number}).attempt], ['redo', 'doing', true, 2]);
  assert.deepEqual(t.itemFiles(i.id).map(f => f.id), [mine.id], 'the agent\'s file is hidden, the person\'s stays');
  assert.equal(t.workArtifacts(i.id).find(a => a.url === file.url)?.cleanup, 'removed');
  assert.ok(t.item(sub.id), 'subitems stay for the next try');
  const f = t.workFeedback(i.id);
  assert.deepEqual([f.decision, f.comment, f.session], ['redo', 'Wrong quarter. Start again from the Q3 numbers.', 'https://claude.ai/chat/abc']);
  assert.deepEqual(f.cleanup.map(c => [c.kind, c.ref, c.undo]), [['branch', 'feat/report', 'Delete branch feat/report'], ['commit', 'abc123', 'git revert abc123'], ['doc', 'Report draft', null]]);
  const inbox = agentInbox(t, bot.id);
  assert.deepEqual(inbox.sentBack.map(x => [x.decision, x.session]), [['redo', 'https://claude.ai/chat/abc']]);
  assert.equal(inbox.cleanup.length, 3);

  // The agent confirms each cleanup; the reviewer sees what is confirmed and what is outstanding.
  const branch = f.cleanup[0];
  assert.equal(t.confirmCleanup(i.id, bot.id, branch.id, 'Deleted').cleanup, 'confirmed');
  assert.deepEqual(t.workArtifacts(i.id).filter(a => a.kind !== 'file' && a.kind !== 'item').map(a => a.cleanup), ['confirmed', 'pending', 'pending']);
  assert.equal(t.workFeedback(i.id).cleanup.length, 2);
  assert.throws(() => t.confirmCleanup(i.id, bot.id, 'nope'), /not found/);
  // The second attempt is its own: new artifacts are not mixed with the old ones.
  t.submitWork(i.id, bot.id, 'Report v2', '', {artifacts: [{kind: 'commit', ref: 'def456'}]});
  assert.deepEqual(t.workArtifacts(i.id).filter(a => a.attempt === 2).map(a => a.ref), ['def456']);
  t.reviewWork(i.id, dave.id, 'approve');
  assert.equal(t.workArtifacts(i.id).find(a => a.ref === 'def456')?.cleanup, null);
});

test('discard closes the attempt: item back where it was, agent unassigned, its changes and subitems undone', () => {
  const {t, dave, bot, names, accepted, state} = setup();
  const i = accepted();
  t.updateItem(i.id, {body: 'Rewritten by the agent', priority: 1, tags: ['draft']}, bot.id);
  t.updateItem(i.id, {priority: 2}, dave.id); // a person changed it after: that stays
  const sub = t.createItem({projectId: i.projectId, parentId: i.id, title: 'Appendix'}, bot.id);
  const kept = t.createItem({projectId: i.projectId, parentId: i.id, title: 'From David'}, dave.id);
  t.attachFile(i.id, bot.id, 'shot.png', 'image/png', PNG);
  t.submitWork(i.id, bot.id, 'Done', '', {artifacts: [{kind: 'pr', ref: '#12', url: 'https://git.example.test/pr/12', undo: 'Close PR 12'}]});

  t.reviewWork(i.id, dave.id, 'discard', 'Not what we need');
  const it = t.item(i.id);
  assert.deepEqual([state(i.id), it.status, it.assignees.includes(bot.id), it.body, it.priority, it.tags], ['discarded', 'todo', false, 'Original', 2, []]);
  assert.throws(() => t.item(sub.id), /not found/);
  assert.ok(t.item(kept.id));
  assert.equal(t.itemFiles(i.id).length, 0);
  assert.deepEqual(t.workFeedback(i.id).cleanup.map(c => c.undo), ['Close PR 12']);
  assert.equal(names.at(-1), 'ai.discarded');
  assert.ok(!t.aiQueue(bot.id).some(x => x.review?.state === 'discarded' && x.item.assignees.includes(bot.id)));
  assert.throws(() => t.reviewWork(i.id, dave.id, 'approve'), /Nothing is waiting/);
  // The task is open again: the agent can ask for it once more, as a new attempt.
  t.claimTask(i.id, bot.id);
  assert.deepEqual([state(i.id), (t.item(i.id).fields.review as {attempt: number}).attempt], ['claimed', 2]);

  // keep: the agent stays assigned. Work in progress can be discarded too.
  const j = accepted('Second');
  t.reviewWork(j.id, dave.id, 'discard', '', {keep: true});
  assert.deepEqual([state(j.id), t.item(j.id).assignees.includes(bot.id), t.item(j.id).status], ['discarded', true, 'todo']);
});

test('agents use sessions, artifacts and cleanup over MCP; only people decide', async () => {
  const {t, dave, p, bot} = setup();
  const i = t.createItem({projectId: p.id, title: 'Draft the memo', fields: {worker: 'ai'}}, dave.id);
  const agent = await mcp(t, bot.id), person = await mcp(t, dave.id);
  await agent('claim_task', {item: 'OPS-1', session: 'chat-1'});
  await person('decide_claim', {item: 'OPS-1', accept: true});
  await agent('log_step', {item: 'OPS-1', kind: 'link', text: 'Design file', url: 'https://design.example.test/f/1', artifact: {kind: 'design', ref: 'Memo layout', url: 'https://design.example.test/f/1', undo: 'Delete the Memo layout file'}});
  await agent('submit_work', {item: 'OPS-1', report: 'Memo ready', session: 'chat-2', artifacts: [{kind: 'url', ref: 'https://example.test/memo'}]});
  await assert.rejects(agent('review_work', {item: 'OPS-1', decision: 'approve'}), /Only a person/);
  await assert.rejects(person('review_work', {item: 'OPS-1'}), /Pass decision/);
  await person('review_work', {item: 'OPS-1', decision: 'redo', comment: 'Use the new template'});
  const f = await agent('get_feedback', {item: 'OPS-1'});
  assert.deepEqual([f.decision, f.comment, f.session, f.context.report, f.cleanup.length], ['redo', 'Use the new template', 'chat-2', 'Memo ready', 2]);
  const inbox = await agent('agent_inbox', {});
  assert.deepEqual([inbox.sentBack[0].decision, inbox.cleanup.length], ['redo', 2]);
  for (const c of f.cleanup) await agent('confirm_cleanup', {item: 'OPS-1', artifact: c.id, note: 'Removed'});
  assert.equal((await agent('get_feedback', {item: 'OPS-1'})).cleanup.length, 0);
  assert.ok(t.workLog(i.id).some(e => e.kind === 'cleanup'));
  await agent('submit_work', {item: 'OPS-1', report: 'Memo, second try'});
  await person('review_work', {item: 'OPS-1', approve: true});
  assert.equal(t.item(i.id).status, 'done');
});
