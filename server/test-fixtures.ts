import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { tokenDigest } from './security.ts';

// Test-only disabled issuer avoids any public bootstrap/master-secret bypass.
export function testInvite(db: DatabaseSync) {
  db.prepare(
    "INSERT OR IGNORE INTO users(id,name,salt,password_hash,disabled) VALUES('test-issuer','TestIssuer','unused','unused',1)",
  ).run();
  db.prepare(
    "UPDATE security_settings SET value='1' WHERE key='registration_open'",
  ).run();
  const token = randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO server_invites(id,token_hash,creator,expires) VALUES(?,?,?,?)',
  ).run(randomUUID(), tokenDigest(token), 'test-issuer', Date.now() + 60000);
  return token;
}
