import { resolve } from 'node:path';
import { createStore } from '../server/store.ts';
const handle = process.argv[2];
if (!handle)
  throw new Error('Usage: node scripts/grant-admin.ts ACCOUNT_HANDLE');
const db = createStore(
  resolve(process.env.DATA_DIR || './data', 'nexus.sqlite'),
);
try {
  const user = db
    .prepare('SELECT id, name, disabled FROM users WHERE name = ?')
    .get(handle);
  if (!user || user.disabled)
    throw new Error('An active existing account is required.');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
  db.prepare(
    'INSERT INTO admin_audit(actor,action,target,created_at) VALUES(?,?,?,?)',
  ).run('server-console', 'grant-admin', user.id, Date.now());
  db.exec('COMMIT');
  console.log(
    `Administrator granted to @${String(user.name)}. Refresh the site.`,
  );
} finally {
  db.close();
}
