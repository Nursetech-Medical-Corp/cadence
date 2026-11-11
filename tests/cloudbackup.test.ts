import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {cloudConfig, decrypt, encrypt, putObject} from '../server/cloudbackup.ts';

test('backups are encrypted, tamper-evident, and need the passphrase', () => {
  const plain = Buffer.from('SQLite format 3\0 some data '.repeat(50));
  const blob = encrypt(plain, 'long passphrase');
  assert.ok(!blob.includes(Buffer.from('SQLite')), 'no plaintext in the blob');
  assert.deepEqual(decrypt(blob, 'long passphrase'), plain);
  assert.throws(() => decrypt(blob, 'wrong'));
  const bad = Buffer.from(blob); bad[bad.length - 1] ^= 1;
  assert.throws(() => decrypt(bad, 'long passphrase'));
});

test('upload sends a signed PUT of the ciphertext to the bucket path', async () => {
  let got: {method?: string; url?: string; auth?: string; body?: Buffer} = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    got = {method: req.method, url: req.url, auth: String(req.headers.authorization), body: Buffer.concat(chunks)};
    res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  try {
    const c = cloudConfig({CADENCE_BACKUP_S3_ENDPOINT: `http://127.0.0.1:${(server.address() as {port: number}).port}`, CADENCE_BACKUP_S3_BUCKET: 'b',
      CADENCE_BACKUP_S3_KEY_ID: 'AKID', CADENCE_BACKUP_S3_SECRET: 'secret', CADENCE_BACKUP_PASSPHRASE: 'pp', CADENCE_BACKUP_S3_REGION: 'us-east-1'})!;
    assert.equal(cloudConfig({}), null, 'off without settings');
    await putObject(c, 'cadence/main/tasks-1.db.enc', encrypt(Buffer.from('db'), c.passphrase));
    assert.equal(got.method, 'PUT');
    assert.equal(got.url, '/b/cadence/main/tasks-1.db.enc');
    assert.match(got.auth!, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(decrypt(got.body!, 'pp').toString(), 'db');
  } finally { server.close(); }
});

import {listCloud, pruneCloud, restoreFromCloud, uploadSnapshot} from '../server/cloudbackup.ts';
import {DEFAULT_SETTINGS, snapshot} from '../server/backup.ts';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** A tiny in-memory S3: PUT, GET, DELETE and ListObjectsV2. */
async function fakeS3() {
  const objects = new Map<string, Buffer>();
  const server = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x');
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const key = decodeURIComponent(u.pathname.split('/').slice(2).join('/'));
    if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); return res.end(); }
    if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
    if (u.searchParams.get('list-type') === '2') {
      const p = u.searchParams.get('prefix') ?? '';
      return res.end(`<ListBucketResult>${[...objects].filter(([k]) => k.startsWith(p)).map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`).join('')}</ListBucketResult>`);
    }
    const o = objects.get(key); if (!o) { res.statusCode = 404; return res.end(); }
    res.end(o);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  Object.assign(process.env, {CADENCE_BACKUP_S3_ENDPOINT: `http://127.0.0.1:${(server.address() as {port: number}).port}`, CADENCE_BACKUP_S3_BUCKET: 'b',
    CADENCE_BACKUP_S3_KEY_ID: 'k', CADENCE_BACKUP_S3_SECRET: 's', CADENCE_BACKUP_PASSPHRASE: 'pp', CADENCE_BACKUP_S3_REGION: 'auto'});
  return {objects, close: () => { server.close(); for (const k of ['CADENCE_BACKUP_S3_ENDPOINT', 'CADENCE_BACKUP_S3_BUCKET', 'CADENCE_BACKUP_S3_KEY_ID', 'CADENCE_BACKUP_S3_SECRET', 'CADENCE_BACKUP_PASSPHRASE']) delete process.env[k]; }};
}

test('cloud copies follow the same keep rules as local ones, and a cloud copy restores the workspace', async () => {
  const s3 = await fakeS3();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'cad-cloud-'));
    const tasks = new Tasks(openDb(':memory:'), () => '2026-11-10');
    const p = tasks.createProject({name: 'Finance'});
    tasks.createItem({projectId: p.id, title: 'Before'});
    const settings = {...DEFAULT_SETTINGS, keepRecent: 1, keepDaily: 0, keepWeekly: 0, keepMonthly: 0};
    // Old auto copies already in the bucket, plus a manual one that must survive.
    for (const n of ['tasks-2026-01-01T00-00-00-auto.db.enc', 'tasks-2026-01-02T00-00-00-auto.db.enc', 'tasks-2026-01-03T00-00-00-manual.db.enc']) s3.objects.set(`cadence/main/${n}`, Buffer.from('x'));
    const file = snapshot(tasks.db, 'auto', dir);
    assert.equal(await uploadSnapshot('main', file, {...settings, target: 'local'}), false, 'local-only target skips the cloud');
    assert.equal(await uploadSnapshot('main', file, settings), true);
    const left = [...s3.objects.keys()].sort();
    assert.equal(left.length, 2, left.join());
    assert.ok(left.some(k => k.endsWith('manual.db.enc')) && left.some(k => k.endsWith(file.split('/').pop() + '.enc')));
    assert.equal(await pruneCloud('main', settings), 0);

    tasks.createItem({projectId: p.id, title: 'After'});
    const cloud = await listCloud('main', settings);
    const mine = cloud.find(x => x.reason === 'auto')!;
    await assert.rejects(restoreFromCloud(tasks.db, 'other', mine.key, dir), /another workspace/);
    const r = await restoreFromCloud(tasks.db, 'main', mine.key, dir);
    assert.ok(r.snapshotBefore);
    const titles = tasks.listItems({projectId: p.id}).map(i => i.title);
    assert.ok(titles.includes('Before') && !titles.includes('After'));
  } finally { s3.close(); }
});
