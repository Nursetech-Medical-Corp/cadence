// Usage: pnpm mcp -- --as <person name or id> [--workspace <id or name>]
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {openDb} from './db.ts';
import {createMcpServer} from './mcp.ts';
import {Tasks} from './service.ts';
import {listWorkspaces, workspaceDir} from './workspaces.ts';

const asIdx = process.argv.indexOf('--as');
const wsIdx = process.argv.indexOf('--workspace');
const want = wsIdx > 0 ? process.argv[wsIdx + 1].toLowerCase() : 'main';
const ws = listWorkspaces().find(w => w.id === want || w.name.toLowerCase() === want);
if (!ws) { console.error(`Unknown workspace "${want}". Workspaces: ${listWorkspaces().map(w => w.name).join(', ')}`); process.exit(1); }
const tasks = new Tasks(openDb(ws.db));
tasks.dataDir = workspaceDir(ws);
if (ws.id === 'main') tasks.seedIfEmpty();
await createMcpServer(tasks, asIdx > 0 ? process.argv[asIdx + 1] : null).connect(new StdioServerTransport());
