import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {migrate} from '../server/auth.ts';
import {migrateSops, setSopLinks} from '../server/sops.ts';
import {setBoardPoster, settleBoards, startBoards} from '../server/boards.ts';
import {createMcpServer} from '../server/mcp.ts';
import {guarded} from '../server/tokens.ts';

function setup() {
  const t = new Tasks(openDb(':memory:'), () => '2026-11-14');
  migrate(t.db); migrateSops(t);
  const posts: {url: string; body: any}[] = [];
  setBoardPoster(async (url, body) => { posts.push({url, body}); if (url.includes('fail')) throw new Error('Answered 500'); });
  startBoards(t);
  const david = t.createPerson({name: 'David', email: 'd@x.test'});
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  const done = p.statuses.find(s => s.category === 'done')!.id;
  return {t, david, p, done, posts};
}

test('whiteboards: create, edit with ops, validate, delete', () => {
  const {t, david, p} = setup();
  const b = t.createBoard({name: 'Onboarding', projectId: p.id, nodes: [
    {id: 'a', kind: 'task', x: 0, y: 0, w: 0, h: 0, text: 'Collect W-9'},
    {id: 's', kind: 'sticky', x: 0, y: 200, w: 0, h: 0, text: 'Ask finance'},
  ], edges: [{id: 'e1', from: 's', to: 'a'}]}, david.id);
  assert.equal(b.nodes[0].w, 220, 'default size per kind');
  assert.equal(b.edges[0].kind, 'link', 'a sticky only links, it is not a step');
  assert.match(b.hookKey, /^wb_/);
  const u = t.updateBoard(b.id, {addNodes: [{id: 'b', kind: 'task', x: 300, y: 0, w: 0, h: 0, text: 'Set up payroll'}], addEdges: [{id: 'e2', from: 'a', to: 'b'}], updateNodes: [{id: 'a', text: 'Collect W-9 form'}]}, david.id);
  assert.equal(u.nodes.length, 3);
  assert.equal(u.edges.find(e => e.id === 'e2')!.kind, 'flow');
  assert.equal(u.nodes.find(n => n.id === 'a')!.text, 'Collect W-9 form');
  const r = t.updateBoard(b.id, {removeNodes: ['a']}, david.id);
  assert.equal(r.edges.length, 0, 'removing a node removes its connections');
  assert.throws(() => t.updateBoard(b.id, {addNodes: [{id: 'x', kind: 'link', x: 0, y: 0, w: 0, h: 0, text: 'x', url: 'javascript:alert(1)'}]}, david.id), /https/);
  assert.throws(() => t.updateBoard(b.id, {addEdges: [{id: 'z', from: 'b', to: 'nope'}]}, david.id), /two nodes/);
  assert.throws(() => t.createBoard({name: 'x', nodes: [{id: 't', kind: 'trigger', x: 0, y: 0, w: 0, h: 0, text: '', trigger: {on: 'completed'}}]}, david.id), /needs a tag/);
  t.deleteBoard(b.id);
  assert.equal(t.listBoards().length, 0);
});

test('whiteboards: draw routines by SOP with their document; create tasks from cards with dependencies', () => {
  const {t, david, p} = setup();
  setSopLinks(t, [{code: 'SOP-07.2', url: 'https://docs.google.com/document/d/abc', title: 'Outreach'}]);
  const a = t.createItem({projectId: p.id, title: 'Pull list', tags: ['SOP-07.2'], due: '2026-11-16', recur: {every: 1, unit: 'week', mode: 'schedule'}}, david.id);
  const b = t.createItem({projectId: p.id, title: 'Send emails', tags: ['SOP-07.2'], deps: [a.id], due: '2026-11-17', recur: {every: 1, unit: 'week', mode: 'schedule'}}, david.id);
  const map = t.boardFromItems({routines: true}, david.id);
  const frame = map.nodes.find(n => n.kind === 'frame')!;
  assert.match(frame.text, /SOP-07.2 Outreach/);
  assert.equal(map.nodes.find(n => n.kind === 'link')!.url, 'https://docs.google.com/document/d/abc');
  const na = map.nodes.find(n => n.itemId === a.id)!, nb = map.nodes.find(n => n.itemId === b.id)!;
  assert.ok(nb.x > na.x, 'later steps sit to the right');
  assert.ok(map.edges.some(e => e.from === na.id && e.to === nb.id), 'dependencies become arrows');
  assert.equal(t.listBoards({itemId: b.id}).length, 1, 'boards are found from their items');

  // Design new work on the board, then turn it into tasks.
  const d = t.createBoard({name: 'New hire', projectId: p.id, nodes: [
    {id: 'n1', kind: 'task', x: 0, y: 0, w: 0, h: 0, text: 'Send offer\nUse the template', assignees: [david.id], worker: 'human', estimate: 1},
    {id: 'n2', kind: 'task', x: 300, y: 0, w: 0, h: 0, text: 'Set up accounts', worker: 'ai', repeat: 'month'},
    {id: 'doc', kind: 'link', x: 300, y: 200, w: 0, h: 0, text: 'IT SOP', url: 'https://drive.google.com/file/d/xyz'},
  ], edges: [{id: 'e', from: 'n1', to: 'n2'}, {id: 'l', from: 'doc', to: 'n2'}]}, david.id);
  const out = t.boardToTasks(d.id, david.id);
  assert.equal(out.created.length, 2);
  const offer = t.item(out.board.nodes.find(n => n.id === 'n1')!.itemId!), accounts = t.item(out.board.nodes.find(n => n.id === 'n2')!.itemId!);
  assert.equal(offer.title, 'Send offer');
  assert.equal(offer.body, 'Use the template');
  assert.deepEqual(accounts.deps, [offer.id], 'arrow became a dependency');
  assert.equal(accounts.fields.worker, 'ai');
  assert.equal(accounts.recur?.unit, 'month', 'repeat makes it a routine');
  assert.match(accounts.body, /drive\.google\.com/, 'linked documents go in the task');
  assert.equal(t.boardToTasks(d.id, david.id).created.length, 0, 'running it again creates nothing new');
});

test('whiteboards: a run makes tasks in order, fires webhooks when steps are done, logs and finishes', async () => {
  const {t, david, p, done, posts} = setup();
  const linked = t.createItem({projectId: p.id, title: 'Existing check'}, david.id);
  const b = t.createBoard({name: 'Monthly close', projectId: p.id, webhooks: [{id: 'h', url: 'https://hooks.example.com/all', events: ['run.done']}], nodes: [
    {id: 'go', kind: 'trigger', x: 0, y: 0, w: 0, h: 0, text: 'Start', trigger: {on: 'manual'}},
    {id: 't1', kind: 'task', x: 200, y: 0, w: 0, h: 0, text: 'Reconcile bank', assignees: [david.id]},
    {id: 't2', kind: 'task', x: 200, y: 150, w: 0, h: 0, text: 'Existing', itemId: linked.id},
    {id: 'w', kind: 'webhook', x: 400, y: 0, w: 0, h: 0, text: 'Tell Zapier', url: 'https://hooks.example.com/zap'},
    {id: 't3', kind: 'task', x: 600, y: 0, w: 0, h: 0, text: 'Send report'},
    {id: 'end', kind: 'end', x: 800, y: 0, w: 0, h: 0, text: 'Done'},
  ], edges: [{id: '1', from: 'go', to: 't1'}, {id: '2', from: 'go', to: 't2'}, {id: '3', from: 't1', to: 'w'}, {id: '4', from: 't2', to: 'w'}, {id: '5', from: 'w', to: 't3'}, {id: '6', from: 't3', to: 'end'}]}, david.id);
  const run = t.runBoard(b.id, david.id, {input: {month: 'October'}});
  const step = (r: typeof run, n: string) => r.steps.find(s => s.node === n)!;
  assert.equal(step(run, 't2').itemId, linked.id, 'linked cards are tracked, not copied');
  const t1 = t.item(step(run, 't1').itemId!), t3 = t.item(step(run, 't3').itemId!);
  assert.equal(t1.parentId, run.parentItem);
  assert.deepEqual(t3.deps.sort(), [t1.id, linked.id].sort(), 'through the webhook, the next task waits on both');
  assert.equal(step(run, 'w').state, 'waiting');
  assert.equal(step(run, 't3').state, 'waiting');
  t.updateItem(t1.id, {status: done}, david.id);
  assert.equal(step(t.boardRun(run.id), 'w').state, 'waiting', 'webhook waits for every step before it');
  t.updateItem(linked.id, {status: done}, david.id);
  await settleBoards();
  const mid = t.boardRun(run.id);
  assert.equal(step(mid, 'w').state, 'fired');
  const zap = posts.find(x => x.url.endsWith('/zap'))!;
  assert.equal(zap.body.event, 'board.step');
  assert.equal(zap.body.run.input.month, 'October');
  assert.equal(step(mid, 't3').state, 'open');
  t.updateItem(t3.id, {status: done}, david.id);
  await settleBoards();
  const fin = t.boardRun(run.id);
  assert.equal(fin.state, 'done');
  assert.ok(t.item(run.parentItem!).completed, 'the run task closes with the run');
  assert.ok(posts.some(x => x.url.endsWith('/all') && x.body.event === 'run.done'), 'board webhooks hear run.done');
  assert.ok(fin.log.some(l => /Webhook sent/.test(l.text)));
});

test('whiteboards: failed webhooks can be retried; finishing a tagged item and schedules start runs', async () => {
  const {t, david, p, done, posts} = setup();
  const b = t.createBoard({name: 'Ping', projectId: p.id, nodes: [{id: 'w', kind: 'webhook', x: 0, y: 0, w: 0, h: 0, text: 'Ping', url: 'https://x.test/fail'}]}, david.id);
  const run = t.runBoard(b.id, david.id);
  await settleBoards();
  assert.equal(t.boardRun(run.id).state, 'failed');
  t.updateBoard(b.id, {updateNodes: [{id: 'w', url: 'https://x.test/ok'}]}, david.id);
  t.boardRunAction(run.id, 'retry', 'w');
  await settleBoards();
  assert.equal(t.boardRun(run.id).state, 'done');

  const tr = t.createBoard({name: 'After intake', projectId: p.id, nodes: [
    {id: 'when', kind: 'trigger', x: 0, y: 0, w: 0, h: 0, text: 'When intake is done', trigger: {on: 'completed', tag: 'intake'}},
    {id: 'f', kind: 'task', x: 200, y: 0, w: 0, h: 0, text: 'Follow up'}], edges: [{id: 'e', from: 'when', to: 'f'}]}, david.id);
  const intake = t.createItem({projectId: p.id, title: 'Intake form', tags: ['intake']}, david.id);
  t.updateItem(intake.id, {status: done}, david.id);
  const runs = t.listBoardRuns(tr.id);
  assert.equal(runs.length, 1);
  assert.match(runs[0].trigger, /finished OPS-/);

  const sch = t.createBoard({name: 'Weekly', projectId: p.id, nodes: [
    {id: 's', kind: 'trigger', x: 0, y: 0, w: 0, h: 0, text: 'Every week', trigger: {on: 'schedule', every: 'week'}},
    {id: 'x', kind: 'task', x: 200, y: 0, w: 0, h: 0, text: 'Review'}], edges: [{id: 'e', from: 's', to: 'x'}]}, david.id);
  t.periodic(); t.periodic();
  assert.equal(t.listBoardRuns(sch.id).length, 1, 'once per period');
  void posts;
});

test('whiteboards over REST (inbound hook) and MCP with permissions', async () => {
  process.env.TASKS_NO_SYNC = '1';
  const {apiMiddleware} = await import('../server/api.ts');
  const t = new Tasks(openDb(':memory:'), () => '2026-11-14');
  setBoardPoster(async () => {});
  const mw = apiMiddleware(t);
  const david = t.createPerson({name: 'David', email: 'd@x.test'});
  const p = t.createProject({name: 'Ops', key: 'OPS'});
  const server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
  const call = async (path: string, init: {method?: string; body?: unknown; person?: string} = {}) => {
    const r = await fetch(base + path, {method: init.method ?? 'GET', headers: {'content-type': 'application/json', ...(init.person ? {'x-person': init.person} : {})}, body: init.body === undefined ? undefined : JSON.stringify(init.body)});
    return {status: r.status, json: await r.json().catch(() => null)};
  };
  try {
    const made = await call('/boards', {method: 'POST', person: david.id, body: {name: 'Lead in', projectId: p.id, nodes: [
      {id: 'h', kind: 'trigger', x: 0, y: 0, text: 'From the form', trigger: {on: 'webhook'}}, {id: 'c', kind: 'task', x: 250, y: 0, text: 'Call the lead'}], edges: [{from: 'h', to: 'c'}]}});
    assert.equal(made.status, 201);
    assert.match(made.json.hookUrl, /\/api\/hooks\/wb_/);
    const patched = await call(`/boards/${made.json.id}`, {method: 'PATCH', person: david.id, body: {name: 'Leads in'}});
    assert.equal(patched.json.name, 'Leads in');
    const hook = await fetch(base + '/hooks/' + made.json.hookKey, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'Pat', phone: '555'})});
    assert.equal(hook.status, 202);
    const runs = (await call(`/boards/${made.json.id}/runs`, {person: david.id})).json;
    assert.equal(runs[0].trigger, 'webhook');
    assert.equal(runs[0].input.name, 'Pat');
    assert.equal((await fetch(base + '/hooks/wb_nope', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).status, 404);
    const routineMap = await call('/boards/from-items', {method: 'POST', person: david.id, body: {itemIds: [runs[0].steps[0].itemId]}});
    assert.equal(routineMap.status, 201);

    // MCP, through the permission guard.
    const mcpServer = createMcpServer(guarded(t, david.id), david.id);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({name: 'test', version: '1'});
    await Promise.all([mcpServer.connect(a), client.connect(b)]);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({name, arguments: args});
      const text = (r.content as {text: string}[])[0].text;
      if (r.isError) throw new Error(text);
      return JSON.parse(text);
    };
    const bd = await tool('create_board', {name: 'Agent flow', project: 'OPS', nodes: [{id: 'a', kind: 'task', text: 'Draft', worker: 'ai'}, {id: 'b', kind: 'task', text: 'Approve', assignees: ['David']}], edges: [{from: 'a', to: 'b'}]});
    await tool('update_board', {board: bd.id, add_nodes: [{id: 'd', kind: 'link', text: 'SOP', url: 'https://docs.google.com/document/d/1'}], add_edges: [{from: 'd', to: 'a'}]});
    const got = await tool('get_board', {board: 'Agent flow'});
    assert.equal(got.nodes.length, 3);
    const tt = await tool('board_to_tasks', {board: bd.id});
    assert.equal(tt.created.length, 2);
    const again = await tool('get_board', {board: bd.id});
    assert.match(again.nodes.find((n: any) => n.id === 'b').itemKey, /^OPS-/);
    const run = await tool('run_board', {board: bd.id});
    assert.equal(run.state, 'running');
    assert.ok((await tool('list_board_runs', {board: bd.id})).length >= 1);
    assert.ok((await tool('list_boards', {})).length >= 3);
    await tool('board_run_action', {run: run.id, action: 'cancel'});
    await tool('delete_board', {board: bd.id});
  } finally { server.close(); }
});
