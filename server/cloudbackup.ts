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
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {restoreSnapshotFile, retention, snapFromName, type BackupSettings, type Snap} from './backup.ts';
import type {Db} from './db.ts';
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

/** One S3 request signed with AWS Signature V4 (path-style URL, works with every S3-compatible service). */
async function s3(c: CloudConfig, method: 'GET' | 'PUT' | 'DELETE', key: string, opts: {query?: Record<string, string>; body?: Buffer} = {}) {
  const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  const path = `/${c.bucket}${key ? '/' + key.split('/').map(enc).join('/') : ''}`;
  const query = Object.entries(opts.query ?? {}).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const base = new URL(c.endpoint.replace(/\/+$/, ''));
  const url = new URL(`${base.origin}${path}${query ? '?' + query : ''}`);
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amz.slice(0, 8);
  const hash = sha256(opts.body ?? '');
  const headers: Record<string, string> = {host: url.host, 'x-amz-content-sha256': hash, 'x-amz-date': amz, ...(opts.body ? {'content-type': 'application/octet-stream'} : {})};
  const names = Object.keys(headers).sort();
  const canonical = [method, path, query, ...names.map(n => `${n}:${headers[n]}`), '', names.join(';'), hash].join('\n');
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${c.secret}`, day), c.region), 's3'), 'aws4_request');
  const auth = `AWS4-HMAC-SHA256 Credential=${c.keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', kSign).update(toSign).digest('hex')}`;
  const r = await fetch(url, {method, headers: {...headers, authorization: auth}, ...(opts.body ? {body: new Uint8Array(opts.body)} : {})});
  if (!r.ok) throw new Error(`Cloud backup ${method} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}

export const putObject = async (c: CloudConfig, key: string, body: Buffer) => { await s3(c, 'PUT', key, {body}); };
export const getObject = async (c: CloudConfig, key: string) => Buffer.from(await (await s3(c, 'GET', key)).arrayBuffer());
export const deleteObject = async (c: CloudConfig, key: string) => { await s3(c, 'DELETE', key); };

/** Every object under a prefix (ListObjectsV2, following continuation tokens). */
export async function listObjects(c: CloudConfig, prefix: string) {
  const out: {key: string; bytes: number}[] = [];
  let token = '';
  for (let page = 0; page < 100; page++) {
    const xml = await (await s3(c, 'GET', '', {query: {'list-type': '2', prefix, ...(token ? {'continuation-token': token} : {})}})).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1], size = /<Size>(\d+)<\/Size>/.exec(m[1])?.[1];
      if (key) out.push({key: key.replace(/&amp;/g, '&'), bytes: Number(size ?? 0)});
    }
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '';
    if (!token) break;
  }
  return out;
}

/** Cloud copies for a workspace, with the same keep rules as local snapshots (keptAs empty means it will be removed). */
export async function listCloud(workspace: string, settings: BackupSettings): Promise<(Snap & {key: string})[]> {
  const c = cloudConfig();
  if (!c) return [];
  const prefix = `${c.prefix}/${workspace}/`;
  const snaps = (await listObjects(c, prefix)).flatMap(o => { const s = snapFromName(o.key.slice(prefix.length), o.bytes); return s ? [{...s, key: o.key}] : []; })
    .sort((a, b) => b.created.localeCompare(a.created));
  const kept = new Map(retention(snaps, settings).map(x => [x.name, x.keptAs]));
  return snaps.map(x => ({...x, keptAs: kept.get(x.name)}));
}

/** Removes cloud copies the keep rules no longer want. Manual and before-restore copies are never removed. */
export async function pruneCloud(workspace: string, settings: BackupSettings) {
  const c = cloudConfig();
  if (!c) return 0;
  let n = 0;
  for (const x of await listCloud(workspace, settings)) if (!x.keptAs && x.reason === 'auto') { await deleteObject(c, x.key); n++; }
  return n;
}

/** Downloads, decrypts and restores a cloud copy into the live workspace (a before-restore snapshot is taken first). */
export async function restoreFromCloud(db: Db, workspace: string, key: string, dir?: string) {
  const c = cloudConfig();
  if (!c) throw new Error('Cloud backups are not set up on this server');
  if (!key.startsWith(`${c.prefix}/${workspace}/`)) throw new Error('That backup belongs to another workspace');
  const tmp = join(tmpdir(), `cadence-cloud-${process.pid}-${Date.now()}.db`);
  writeFileSync(tmp, decrypt(await getObject(c, key), c.passphrase));
  try { return restoreSnapshotFile(db, tmp, dir); } finally { rmSync(tmp, {force: true}); }
}

export type CloudStatus = {configured: boolean; bucket?: string; lastOk?: string; lastFile?: string; lastError?: string; pruned?: number};
const status = new Map<string, CloudStatus>();
export const cloudStatus = (workspace: string): CloudStatus => {
  const c = cloudConfig();
  return {configured: !!c, ...(c ? {bucket: `${c.bucket}/${c.prefix}`} : {}), ...status.get(workspace)};
};

/**
 * Encrypt and upload a snapshot file, then prune the cloud copies with the same keep rules as local ones.
 * Skipped when the backup target is local only. Never throws; the outcome shows on the Data and backups page.
 */
export async function uploadSnapshot(workspace: string, file: string, settings: BackupSettings) {
  const c = cloudConfig();
  if (!c || settings.target === 'local') return false;
  try {
    const key = `${c.prefix}/${workspace}/${basename(file)}.enc`;
    await putObject(c, key, encrypt(readFileSync(file), c.passphrase));
    const pruned = await pruneCloud(workspace, settings);
    status.set(workspace, {configured: true, lastOk: new Date().toISOString(), lastFile: key, ...(pruned ? {pruned} : {})});
    return true;
  } catch (e) {
    status.set(workspace, {...status.get(workspace), configured: true, lastError: `${new Date().toISOString()}: ${e instanceof Error ? e.message : String(e)}`});
    console.error('Cloud backup failed', e);
    return false;
  }
}
