import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

export const tokenDigest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (error, key) =>
      error ? reject(error) : resolve(key.toString('hex')),
    ),
  );
}
export function normalizeIP(value: string): string {
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4)
    return value.slice(7);
  if (!isIP(value)) throw new Error('Expected an IP address.');
  // Canonicalize IPv6 so alternate spellings cannot create new rate-limit buckets.
  return isIP(value) === 6
    ? new URL(`http://[${value}]/`).hostname.slice(1, -1)
    : value;
}
export function clientAddress(
  request: IncomingMessage,
  trusted: Set<string>,
): string {
  const peer = normalizeIP(request.socket.remoteAddress || '127.0.0.1');
  if (!trusted.has(peer)) return peer;
  const header = request.headers['x-nexus-client-ip'];
  if (typeof header !== 'string')
    throw new Error('Trusted proxy did not provide client identity.');
  return normalizeIP(header);
}
export function requestPath(target: string): string {
  const hasControl = (value: string) =>
    value
      .split('')
      .some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      );
  // Only origin-form requests are accepted; never interpret // as an authority.
  if (
    !target.startsWith('/') ||
    target.startsWith('//') ||
    /[\\\s#]/.test(target) ||
    hasControl(target)
  )
    throw new Error('Invalid request target.');
  const url = new URL(target, 'http://localhost');
  const decoded = decodeURIComponent(url.pathname);
  if (decoded.includes('\\') || hasControl(decoded))
    throw new Error('Invalid request target.');
  return url.pathname;
}
export function registrationOpen(db: DatabaseSync, allowed = true) {
  return (
    allowed &&
    db
      .prepare(
        "SELECT value FROM security_settings WHERE key='registration_open'",
      )
      .get()?.value === '1'
  );
}
export function securityAudit(
  db: DatabaseSync,
  actor: string,
  action: string,
  target: string,
) {
  db.prepare(
    'INSERT INTO admin_audit(actor,action,target,created_at) VALUES(?,?,?,?)',
  ).run(actor, action, target, Date.now());
}
export function setRegistration(
  db: DatabaseSync,
  open: boolean,
  actor: string,
) {
  db.prepare(
    "UPDATE security_settings SET value=? WHERE key='registration_open'",
  ).run(open ? '1' : '0');
  securityAudit(
    db,
    actor,
    open ? 'registration-open' : 'registration-close',
    'server',
  );
}
export function revokeAccount(
  db: DatabaseSync,
  id: string,
  actor: string,
  suspend = false,
) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (suspend) {
      // Invalidate the password too: restoring the account cannot revive stolen credentials.
      db.prepare(
        "UPDATE users SET disabled=1, channel='The Lobby', salt=?, password_hash=? WHERE id=?",
      ).run(
        randomBytes(16).toString('hex'),
        randomBytes(64).toString('hex'),
        id,
      );
    }
    db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(
      id,
    );
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM server_invites WHERE creator=?').run(id);
    securityAudit(
      db,
      actor,
      suspend ? 'security-suspend' : 'revoke-sessions',
      id,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function membershipReview(db: DatabaseSync) {
  return db
    .prepare(`SELECT u.id,u.name AS handle,u.is_admin AS isAdmin,u.disabled,
    u.registered_at AS registeredAt,u.invite_id AS inviteId,u.reviewed_at AS reviewedAt,
    u.reviewed_by AS reviewedBy,(SELECT count(*) FROM sessions s WHERE s.user_id=u.id AND s.expires>?) AS sessions
    FROM users u ORDER BY u.is_admin DESC,u.name COLLATE NOCASE`)
    .all(Date.now());
}
export function reviewAccount(db: DatabaseSync, id: string, actor: string) {
  db.prepare('UPDATE users SET reviewed_at=?,reviewed_by=? WHERE id=?').run(
    Date.now(),
    actor,
    id,
  );
  securityAudit(db, actor, 'membership-reviewed', id);
}
// Console bootstrap is deliberately separate from public registration.
export async function bootstrapOwner(
  db: DatabaseSync,
  handle: string,
  password: string,
) {
  if (
    !/^[A-Za-z0-9_-]{2,20}$/.test(handle) ||
    password.length < 10 ||
    password.length > 128
  )
    throw new Error('Use a valid handle and a 10–128 character password.');
  const salt = randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Number(db.prepare('SELECT count(*) AS n FROM users').get()!.n))
      throw new Error('Bootstrap requires an empty server.');
    const id = randomUUID();
    db.prepare(
      'INSERT INTO users(id,name,salt,password_hash,is_admin,registered_at,reviewed_at,reviewed_by) VALUES(?,?,?,?,1,?,?,?)',
    ).run(id, handle, salt, hash, Date.now(), Date.now(), 'server-console');
    securityAudit(db, 'server-console', 'bootstrap-owner', id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
