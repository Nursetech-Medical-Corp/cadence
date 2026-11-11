// Production server: the built app (dist/) and the API on one port. Sign-in is required unless
// CADENCE_REQUIRE_LOGIN=0. Put it behind an HTTPS proxy (Caddy, nginx, a tunnel) that sets X-Forwarded-Proto,
// so session cookies are marked Secure.
//   pnpm build && pnpm start          (PORT=8080, HOST=127.0.0.1 by default)
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {extname, join, resolve, sep} from 'node:path';

process.env.CADENCE_REQUIRE_LOGIN ??= '1';
const {apiMiddleware} = await import('./api.ts');

const DIST = resolve(import.meta.dirname, '..', 'dist');
const TYPES: Record<string, string> = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json'};
const api = apiMiddleware();

createServer((req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
  void api(req, res, async () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
    let file = resolve(DIST, '.' + decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    if (!file.startsWith(DIST + sep)) file = join(DIST, 'index.html');
    // Anything that is not a built file gets the app (routes live after the #).
    try { if (!(await stat(file)).isFile()) throw new Error('not a file'); } catch { file = join(DIST, 'index.html'); }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.end(await readFile(file));
  });
}).listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Cadence on http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 8080} (sign-in ${process.env.CADENCE_REQUIRE_LOGIN === '1' ? 'required' : 'off'})`);
});
