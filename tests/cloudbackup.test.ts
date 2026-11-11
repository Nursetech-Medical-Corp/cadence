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
