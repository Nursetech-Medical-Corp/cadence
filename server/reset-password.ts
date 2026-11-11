// For the server owner: sets a new password for an account and signs it out everywhere.
//   pnpm reset-password someone@example.com            (prints a new random password)
//   pnpm reset-password someone@example.com "new pass"
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openAccounts} from './accounts.ts';
import {hashPassword} from './auth.ts';
import {listWorkspaces} from './workspaces.ts';

const [email = '', given] = process.argv.slice(2).map((a, n) => n === 0 ? a.trim().toLowerCase() : a);
if (!email.includes('@')) { console.error('Usage: pnpm reset-password <email> [new password]'); process.exit(1); }
const password = given ?? randomBytes(12).toString('base64url');
const hash = hashPassword(password);
const workspaces = listWorkspaces();
const accounts = openAccounts();
accounts.setHash(email, hash);
let found = 0;
for (const w of workspaces) {
  const db = new DatabaseSync(w.db);
  found += Number(db.prepare('update people set password = ? where lower(email) = ?').run(hash, email).changes);
  db.close();
}
console.log(`Password set for ${email}${given ? '' : `: ${password}`}`);
if (!found) console.log('Note: no workspace has a person with this email yet. Add them on a Team page so they can get in.');
