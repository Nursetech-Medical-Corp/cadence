// MCP over HTTP (Streamable HTTP, stateless) at /mcp, for AI apps that connect over the network.
// Requires "Authorization: Bearer tt_..." from Team > AI agents and tokens, or ?key=tt_... in the URL for
// clients that cannot send headers (claude.ai and Cowork custom connectors). Every tool runs through the
// permission guard, so an agent can do exactly what its person's role allows.
import type {IncomingMessage, ServerResponse} from 'node:http';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {Tasks} from './service.ts';
import {createMcpServer} from './mcp.ts';
import {guarded, tokenPerson} from './tokens.ts';

export async function handleMcpHttp(tasks: Tasks, req: IncomingMessage, res: ServerResponse) {
  const key = new URL(req.url ?? '/', 'http://local').searchParams.get('key');
  const person = tokenPerson(tasks.db, req.headers.authorization ?? (key ? `Bearer ${key}` : undefined));
  if (!person) {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.setHeader('www-authenticate', 'Bearer');
    res.end(JSON.stringify({error: 'Send Authorization: Bearer <token> or add ?key=<token> to the URL. Create one on the Team page under AI agents and tokens.'}));
    return;
  }
  let body: unknown;
  if (req.method === 'POST') {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 2_000_000) { res.statusCode = 413; res.end(); return; } }
    try { body = raw ? JSON.parse(raw) : undefined; } catch { res.statusCode = 400; res.end('Bad JSON'); return; }
  }
  const server = createMcpServer(guarded(tasks, person), person);
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req as IncomingMessage & {auth?: undefined}, res, body);
}
