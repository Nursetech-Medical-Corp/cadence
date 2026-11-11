import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {createMcpServer} from '../server/mcp.ts';
import {guarded, createToken} from '../server/tokens.ts';
import {addAgent, agentInbox, decideProposal, listProposals, saveAgentSettings, startAgents} from '../server/agents.ts';
import {migrate} from '../server/auth.ts';
import {migrateAiWork} from '../server/aiwork.ts';
import {migrateEvents} from '../server/events.ts';

function setup() {
  const t = new Tasks(openDb(':memory:'), () => '2026-11-10');
  migrate(t.db);
  migrateAiWork(t);
  migrateEvents(t);
  const posts: {url: string; body: any}[] = [];
  startAgents(t, {post: async (url, body) => { posts.push({url, body}); }});
  const david = t.createPerson({name: 'David', email: 'd@x.test'}), collin = t.createPerson({name: 'Collin', email: 'c@x.test'}), admin = t.createPerson({name: 'Ada', email: 'a@x.test'});
  t.db.prepare('update people set admin = 1 where id = ?').run(admin.id);
  t.db.prepare('update people set admin = 0 where id in (?, ?)').run(david.id, collin.id);
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  const dc = addAgent(t, david.id, {name: "David's Claude"}), cc = addAgent(t, collin.id, {name: "Collin's Claude", provider: 'claude'});
  return {t, david, collin, admin, p, dc, cc, posts};
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

test('agents belong to people; only the owner (or assignee, admin) approves their claims and work', () => {
  const {t, david, collin, admin, p, dc, cc} = setup();
  assert.equal(t.person(dc.id).kind, 'ai');
  assert.equal(t.person(dc.id).owner, david.id);
  assert.throws(() => addAgent(t, dc.id, {name: 'Sub-agent'}), /AI agents cannot add agents/);
  // Owner always comes with the agent.
  const i = t.createItem({projectId: p.id, title: 'Draft vendor email', assignees: [cc.id]});
  assert.deepEqual(i.assignees.sort(), [cc.id, collin.id].sort());
  // Claims: Collin's agent claims; David cannot accept it, Collin can.
  const j = t.createItem({projectId: p.id, title: 'Summarize call notes', fields: {worker: 'ai'}});
  t.claimTask(j.id, cc.id, 'I can do this');
  assert.throws(() => t.decideClaim(j.id, david.id, true), /Only Collin/);
  t.decideClaim(j.id, collin.id, true);
  assert.ok(t.item(j.id).assignees.includes(collin.id), 'owner added on accept');
  t.submitWork(j.id, cc.id, 'Done: summary in comments');
  assert.throws(() => t.reviewWork(j.id, david.id, true), /Only Collin/);
  t.reviewWork(j.id, admin.id, true);
  // Settings: only the owner or an admin changes them.
  assert.throws(() => saveAgentSettings(t, cc.id, {maxClaims: 2}, david.id), /Only Collin or an admin/);
  assert.equal(saveAgentSettings(t, cc.id, {maxClaims: 2, autoApprove: ['sop-07.26']}, collin.id).settings.autoApprove[0], 'SOP-07.26');
  assert.throws(() => saveAgentSettings(t, cc.id, {writePolicy: 'yolo' as never}, collin.id), /writePolicy/);
});

test('agent writes wait for the owner unless they follow an approved SOP; approval applies them', async () => {
  const {t, david, p, dc} = setup();
  const done = p.statuses.find(s => s.category === 'done')!.id;
  const item = t.createItem({projectId: p.id, title: 'Send weekly numbers', assignees: [david.id], due: '2026-11-13'});
  const call = await mcp(t, dc.id);
  // Held.
  const r = await call('update_item', {item: item.id, due: '2026-11-20'});
  assert.equal(r.state, 'pending');
  assert.equal(t.item(item.id).due, '2026-11-13', 'unchanged until approved');
  assert.match(t.listNotifications(david.id)[0].text, /proposes: Change OPS-1/);
  // Approve: applied, agent told.
  const decided = decideProposal(t, r.proposal, david.id, true);
  assert.equal(decided.state, 'approved');
  assert.equal(t.item(item.id).due, '2026-11-20');
  assert.match(t.listNotifications(dc.id)[0].text, /approved: Change OPS-1/);
  // Marking done needs a person: approval runs as the approver, so it works.
  const r2 = await call('update_item', {item: item.id, status: done});
  assert.equal(decideProposal(t, r2.proposal, david.id, true).state, 'approved');
  assert.ok(t.item(item.id).completed);
  // Reject.
  const r3 = await call('create_item', {project: p.id, title: 'Spam task'});
  assert.equal(decideProposal(t, r3.proposal, david.id, false, {note: 'Not needed'}).state, 'rejected');
  assert.ok(!t.listItems({projectId: p.id}).some(i => i.title === 'Spam task'));
  assert.throws(() => decideProposal(t, r3.proposal, david.id, true), /already rejected/);
  // Approved SOP: goes straight through, logged.
  saveAgentSettings(t, dc.id, {autoApprove: ['SOP-07.26']}, david.id);
  const routine = t.createItem({projectId: p.id, title: 'Daily call list', tags: ['SOP-07.26']});
  const direct = await call('update_item', {item: routine.id, estimate: 1});
  assert.equal(direct.estimate, 1);
  assert.match(t.workLog(routine.id).at(-1)!.text, /approved SOP-07.26/);
  // Direct policy: no holding.
  saveAgentSettings(t, dc.id, {writePolicy: 'direct'}, david.id);
  assert.equal((await call('update_item', {item: item.id, title: 'Send weekly numbers (v2)'})).title, 'Send weekly numbers (v2)');
  // Calendar changes are held too, and outside guests are refused.
  saveAgentSettings(t, dc.id, {writePolicy: 'review'}, david.id);
  const ev = await call('create_event', {title: 'Prep with Collin', start: '2026-11-17T10:00:00-07:00', duration: 30, attendees: ['Collin']});
  assert.equal(ev.state, 'pending');
  const approved = decideProposal(t, ev.proposal, david.id, true);
  assert.equal((approved.result as {organizer: string}).organizer, david.id, 'the owner organizes the meeting the agent drafted');
  await assert.rejects(call('create_event', {title: 'x', start: '2026-11-17T10:00:00-07:00', attendees: ['stranger@out.test']}), /outside the workspace/);
  assert.equal(listProposals(t, {owner: david.id, state: 'pending'}).length, 0);
});

test('suggest_work, agent_inbox and assignment triggers', async () => {
  const {t, david, collin, p, dc, cc, posts} = setup();
  saveAgentSettings(t, dc.id, {webhook: 'https://hooks.example.com/dc'}, david.id);
  // Assigning David (even by himself) tells his agent and fires its webhook.
  const it = t.createItem({projectId: p.id, title: 'Reconcile November receipts', assignees: [david.id]}, david.id);
  await new Promise(r => setTimeout(r, 5));
  assert.match(t.listNotifications(dc.id)[0].text, /David has a new task OPS-1/);
  assert.equal(posts[0].url, 'https://hooks.example.com/dc');
  assert.equal(posts[0].body.item.key, 'OPS-1');
  // Not when the task is marked for a human.
  t.createItem({projectId: p.id, title: 'Sign the lease', assignees: [david.id], fields: {worker: 'human'}}, david.id);
  assert.equal(t.listNotifications(dc.id).length, 1);

  const call = await mcp(t, dc.id);
  const inbox = await call('agent_inbox', {});
  assert.equal(inbox.owner.name, 'David');
  assert.ok(inbox.newForOwner.some((x: {key: string}) => x.key === 'OPS-1'));
  assert.ok(inbox.notifications.length >= 1);
  // Suggest new work for David: held, then approved -> assigned to David and his agent, accepted.
  const s = await call('suggest_work', {project: p.id, title: 'Draft December investor update', for_person: 'David', reason: 'Quarterly update due Jan 4', estimate: 2});
  assert.equal(s.state, 'pending');
  const d = decideProposal(t, s.proposal, david.id, true);
  const made = d.result as {id: string; assignees: string[]; fields: {review?: {state: string}}};
  assert.deepEqual(made.assignees.sort(), [david.id, dc.id].sort());
  assert.equal(made.fields.review?.state, 'accepted');
  // Suggest for Collin: goes to Collin and Collin's agent, Collin's agent claim needs... already accepted by approval.
  const s2 = await call('suggest_work', {item: it.id, for_person: 'Collin', reason: 'Collin has the receipts'});
  const d2 = decideProposal(t, s2.proposal, david.id, true);
  assert.ok((d2.result as {assignees: string[]}).assignees.includes(collin.id));
  assert.ok((d2.result as {assignees: string[]}).assignees.includes(cc.id));
  // Agent inbox shows the decision.
  const after = await call('agent_inbox', {since: '2000-01-01T00:00:00Z'});
  assert.ok(after.proposals.some((x: {state: string}) => x.state === 'approved'));
  const mine = await call('my_proposals', {});
  assert.equal(mine.length, 2);
  // Humans cannot use agent tools.
  const human = await mcp(t, david.id);
  await assert.rejects(human('agent_inbox', {}), /for AI agent accounts/);
  void agentInbox;
});

test('agents and proposals over the REST API', async () => {
  process.env.TASKS_NO_SYNC = '1';
  const {apiMiddleware} = await import('../server/api.ts');
  const t = new Tasks(openDb(':memory:'), () => '2026-11-10');
  const mw = apiMiddleware(t);
  const [david, collin] = [t.createPerson({name: 'David', email: 'd@x.test'}), t.createPerson({name: 'Collin', email: 'c@x.test'})];
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; person?: string; token?: string} = {}) => {
    const r = await fetch(base + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.person ? {'x-person': init.person} : {}), ...(init.token ? {authorization: `Bearer ${init.token}`} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  try {
    const agent = (await call('/agents', {method: 'POST', person: david.id, body: {name: "David's Claude"}})).json;
    assert.equal(agent.owner, david.id);
    assert.equal((await call('/agents', {person: collin.id})).json.length, 0, 'Collin sees only his own agents');
    const tok = (await call(`/agents/${agent.id}/token`, {method: 'POST', person: david.id, body: {name: 'Cowork'}})).json;
    assert.match(tok.mcpUrl, /\/mcp\?ws=main&key=tt_/);
    assert.equal((await call(`/agents/${agent.id}/token`, {method: 'POST', token: tok.token, body: {}})).status, 403, 'tokens cannot make tokens');
    const item = t.createItem({projectId: p.id, title: 'Books'});
    const held = await call(`/items/${item.id}`, {method: 'PATCH', token: tok.token, body: {title: 'Books (agent)'}});
    assert.equal(held.status, 202);
    assert.equal(t.item(item.id).title, 'Books');
    const list = (await call('/proposals?state=pending', {person: david.id})).json;
    assert.equal(list.length, 1);
    assert.equal((await call(`/proposals/${list[0].id}/decide`, {method: 'POST', token: tok.token, body: {approve: true}})).status, 403, 'agents cannot approve');
    assert.equal((await call(`/proposals/${list[0].id}/decide`, {method: 'POST', person: collin.id, body: {approve: true}})).status, 400);
    assert.equal((await call(`/proposals/${list[0].id}/decide`, {method: 'POST', person: david.id, body: {approve: true}})).json.state, 'approved');
    assert.equal(t.item(item.id).title, 'Books (agent)');
    const settings = await call(`/agents/${agent.id}`, {method: 'PATCH', person: david.id, body: {writePolicy: 'direct'}});
    assert.equal(settings.json.settings.writePolicy, 'direct');
    assert.equal((await call(`/items/${item.id}`, {method: 'PATCH', token: tok.token, body: {title: 'Books (direct)'}})).status, 200);
    void createToken;
  } finally { server.close(); }
});
