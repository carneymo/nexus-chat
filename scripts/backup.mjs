import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const source = resolve(process.env.DATA_DIR || './data', 'nexus.sqlite');
if (!existsSync(source))
  throw new Error('No database to back up. Start the gateway first.');
mkdirSync('backups', { recursive: true });
const target = resolve(
  'backups',
  `nexus-${new Date().toISOString().replaceAll(':', '-')}.sqlite`,
);
const db = new DatabaseSync(source);
try {
  await backup(db, target);
  console.log(`Backup saved to ${target}`);
} finally {
  db.close();
}
