import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createStore } from '../server/store.ts';
import {
  bootstrapOwner,
  hashPassword,
  membershipReview,
  registrationOpen,
  reviewAccount,
  revokeAccount,
  securityAudit,
  setRegistration,
} from '../server/security.ts';

const [action, handle] = process.argv.slice(2);
const commands = [
  'members',
  'review',
  'open',
  'close',
  'revoke',
  'suspend',
  'reset-password',
  'restore',
  'bootstrap',
];
if (!commands.includes(action))
  throw new Error(
    `Usage: node scripts/security-admin.ts ${commands.join('|')} [HANDLE]. Passwords for bootstrap/reset-password must be supplied on stdin.`,
  );
const db = createStore(
  resolve(process.env.DATA_DIR || './data', 'nexus.sqlite'),
);
async function readPassword() {
  if (process.stdin.isTTY)
    throw new Error(
      'Supply the new password through stdin using a secure prompt; never put it in command arguments.',
    );
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk.toString();
    if (value.length > 132) throw new Error('Password is too long.');
  }
  const password = value.replace(/\r?\n$/, '');
  if (password.length < 10 || password.length > 128 || /[\r\n]/.test(password))
    throw new Error('Use a single password of 10–128 characters.');
  return password;
}
try {
  if (action === 'members')
    console.log(
      JSON.stringify(
        {
          registrationOpen: registrationOpen(db),
          members: membershipReview(db),
        },
        null,
        2,
      ),
    );
  else if (action === 'open' || action === 'close') {
    if (action === 'open' && process.env.REGISTRATION_ALLOWED === 'false')
      throw new Error(
        'REGISTRATION_ALLOWED=false forbids opening registration.',
      );
    setRegistration(db, action === 'open', 'server-console');
  } else if (action === 'bootstrap')
    await bootstrapOwner(db, handle || '', await readPassword());
  else {
    const user = db
      .prepare('SELECT * FROM users WHERE name=?')
      .get(handle || '');
    if (!user) throw new Error('Account not found.');
    const id = String(user.id);
    if (action === 'review') reviewAccount(db, id, 'server-console');
    else if (action === 'revoke' || action === 'suspend')
      revokeAccount(db, id, 'server-console', action === 'suspend');
    else if (action === 'reset-password') {
      const salt = randomBytes(16).toString('hex');
      const hash = await hashPassword(await readPassword(), salt);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          'UPDATE users SET salt=?,password_hash=?,auth_version=auth_version+1 WHERE id=?',
        ).run(salt, hash, id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
        db.prepare('DELETE FROM server_invites WHERE creator=?').run(id);
        securityAudit(db, 'server-console', 'reset-password', id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } else if (action === 'restore') {
      db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(id);
      securityAudit(db, 'server-console', 'security-restore', id);
    }
  }
  if (action !== 'members')
    console.log(JSON.stringify({ ok: true, action, handle: handle || null }));
} finally {
  db.close();
}
