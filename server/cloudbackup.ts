// Encrypted off-server backups: each snapshot is gzipped, encrypted with AES-256-GCM using a key derived from
// CADENCE_BACKUP_PASSPHRASE, and uploaded to any S3-compatible bucket (Backblaze B2, Cloudflare R2, AWS S3, Wasabi,
// MinIO). The bucket only ever holds ciphertext; without the passphrase the files are useless.
//
// Settings (environment, so secrets never sit in the database or the backups themselves):
//   CADENCE_BACKUP_S3_ENDPOINT   https://s3.us-west-004.backblazeb2.com   (or https://<account>.r2.cloudflarestorage.com)
//   CADENCE_BACKUP_S3_REGION     us-west-004   (R2: auto)
//   CADENCE_BACKUP_S3_BUCKET     cadence-backups
//   CADENCE_BACKUP_S3_KEY_ID / CADENCE_BACKUP_S3_SECRET
//   CADENCE_BACKUP_S3_PREFIX     optional folder, default "cadence"
//   CADENCE_BACKUP_PASSPHRASE    long random phrase; store it in a password manager. Lose it and the backups are lost.
// Decrypt a download with: pnpm decrypt-backup <file.enc> [out.db]
import {createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';

const MAGIC = Buffer.from('CADENC1');

export type CloudConfig = {endpoint: string; region: string; bucket: string; keyId: string; secret: string; prefix: string; passphrase: string};

export function cloudConfig(env = process.env): CloudConfig | null {
  const c = {endpoint: env.CADENCE_BACKUP_S3_ENDPOINT ?? '', region: env.CADENCE_BACKUP_S3_REGION || 'auto', bucket: env.CADENCE_BACKUP_S3_BUCKET ?? '',
    keyId: env.CADENCE_BACKUP_S3_KEY_ID ?? '', secret: env.CADENCE_BACKUP_S3_SECRET ?? '', prefix: (env.CADENCE_BACKUP_S3_PREFIX ?? 'cadence').replace(/^\/+|\/+$/g, ''),
    passphrase: env.CADENCE_BACKUP_PASSPHRASE ?? ''};
  return c.endpoint && c.bucket && c.keyId && c.secret && c.passphrase ? c : null;
}

export function encrypt(plain: Buffer, passphrase: string) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, passphrase: string) {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Cadence encrypted backup');
  let o = MAGIC.length;
  const salt = blob.subarray(o, o += 16), iv = blob.subarray(o, o += 12), tag = blob.subarray(o, o += 16);
  const d = createDecipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
  d.setAuthTag(tag);
  return gunzipSync(Buffer.concat([d.update(blob.subarray(o)), d.final()]));
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();

/** PUT one object with AWS Signature V4 (path-style URL, works with every S3-compatible service). */
export async function putObject(c: CloudConfig, key: string, body: Buffer) {
  const url = new URL(`${c.endpoint.replace(/\/+$/, '')}/${c.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amz.slice(0, 8);
  const hash = sha256(body);
  const headers: Record<string, string> = {host: url.host, 'x-amz-content-sha256': hash, 'x-amz-date': amz, 'content-type': 'application/octet-stream'};
  const names = Object.keys(headers).sort();
  const canonical = ['PUT', url.pathname, '', ...names.map(n => `${n}:${headers[n]}`), '', names.join(';'), hash].join('\n');
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${c.secret}`, day), c.region), 's3'), 'aws4_request');
  const auth = `AWS4-HMAC-SHA256 Credential=${c.keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', kSign).update(toSign).digest('hex')}`;
  const r = await fetch(url, {method: 'PUT', headers: {...headers, authorization: auth}, body: new Uint8Array(body)});
  if (!r.ok) throw new Error(`Cloud backup upload failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export type CloudStatus = {configured: boolean; bucket?: string; lastOk?: string; lastFile?: string; lastError?: string};
const status = new Map<string, CloudStatus>();
export const cloudStatus = (workspace: string): CloudStatus => {
  const c = cloudConfig();
  return {configured: !!c, ...(c ? {bucket: `${c.bucket}/${c.prefix}`} : {}), ...status.get(workspace)};
};

/** Encrypt and upload a snapshot file. Never throws; the outcome shows on the admin's Data and backups page. */
export async function uploadSnapshot(workspace: string, file: string) {
  const c = cloudConfig();
  if (!c) return false;
  try {
    const key = `${c.prefix}/${workspace}/${basename(file)}.enc`;
    await putObject(c, key, encrypt(readFileSync(file), c.passphrase));
    status.set(workspace, {configured: true, lastOk: new Date().toISOString(), lastFile: key});
    return true;
  } catch (e) {
    status.set(workspace, {...status.get(workspace), configured: true, lastError: `${new Date().toISOString()}: ${e instanceof Error ? e.message : String(e)}`});
    console.error('Cloud backup failed', e);
    return false;
  }
}
