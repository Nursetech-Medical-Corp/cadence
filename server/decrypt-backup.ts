// pnpm decrypt-backup <file.enc> [out.db]   (reads CADENCE_BACKUP_PASSPHRASE, or asks for it)
import {readFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {decrypt} from './cloudbackup.ts';

const [file, out] = process.argv.slice(2);
if (!file) { console.error('Usage: pnpm decrypt-backup <file.enc> [out.db]'); process.exit(1); }
let pass = process.env.CADENCE_BACKUP_PASSPHRASE;
if (!pass) { const rl = createInterface({input: process.stdin, output: process.stdout}); pass = await rl.question('Backup passphrase: '); rl.close(); }
const target = out ?? file.replace(/\.enc$/, '');
writeFileSync(target, decrypt(readFileSync(file), pass));
console.log(`Wrote ${target}. Restore it by stopping Cadence and replacing data/tasks.db (or the workspace's .db) with it.`);
