// Every MCP tool must be documented so AI agents know it exists and how to use it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('every MCP tool is named in AI-GUIDE.md or MCP.md', () => {
  const src = readFileSync(new URL('../server/mcp.ts', import.meta.url), 'utf8');
  const docs = readFileSync(new URL('../docs/AI-GUIDE.md', import.meta.url), 'utf8') + readFileSync(new URL('../docs/MCP.md', import.meta.url), 'utf8');
  const tools = [...src.matchAll(/tool\('([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(tools.length > 50);
  const missing = tools.filter(t => !docs.includes('`' + t + '`'));
  assert.deepEqual(missing, [], 'Document these tools in docs/AI-GUIDE.md or docs/MCP.md: ' + missing.join(', '));
});
