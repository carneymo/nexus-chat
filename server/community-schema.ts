import type { DatabaseSync } from 'node:sqlite';

/** Additive schema: existing channel access and account identity are preserved. */
export function migrateCommunity(db: DatabaseSync) {
  const add = (table: string, name: string, definition: string) => {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((row) => row.name === name)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    add('channels', 'owner_id', 'TEXT REFERENCES users(id)');
    add('channels', 'visibility', "TEXT NOT NULL DEFAULT 'public'");
    add('channels', 'notices', 'INTEGER NOT NULL DEFAULT 1');
    add('users', 'home_channel', "TEXT NOT NULL DEFAULT 'The Lobby'");
    add('users', 'presence', "TEXT NOT NULL DEFAULT 'online'");
    add('users', 'away_message', "TEXT NOT NULL DEFAULT ''");
    add('users', 'location_privacy', "TEXT NOT NULL DEFAULT 'friends'");
    add('users', 'activity_privacy', "TEXT NOT NULL DEFAULT 'friends'");
    add('users', 'friends_only_dm', 'INTEGER NOT NULL DEFAULT 0');
    add('users', 'join_notices', 'INTEGER NOT NULL DEFAULT 1');
    add('users', 'bio', "TEXT NOT NULL DEFAULT ''");
    add('users', 'avatar', "TEXT NOT NULL DEFAULT '◈'");
    add('users', 'profile_link', "TEXT NOT NULL DEFAULT ''");
    add('messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");
    add('messages', 'nonce', 'TEXT');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_nonce ON messages(user_id,nonce) WHERE nonce IS NOT NULL;
      CREATE TABLE IF NOT EXISTS channel_members (
        channel TEXT NOT NULL REFERENCES channels(name) COLLATE NOCASE,
        user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL DEFAULT 'member',
        PRIMARY KEY(channel,user_id));
      CREATE TABLE IF NOT EXISTS channel_bans (
        channel TEXT NOT NULL REFERENCES channels(name) COLLATE NOCASE,
        user_id TEXT NOT NULL REFERENCES users(id), actor TEXT NOT NULL REFERENCES users(id),
        reason TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(channel,user_id));
      CREATE TABLE IF NOT EXISTS friendships (
        requester TEXT NOT NULL REFERENCES users(id), recipient TEXT NOT NULL REFERENCES users(id),
        accepted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        PRIMARY KEY(requester,recipient), CHECK(requester <> recipient));
      CREATE TABLE IF NOT EXISTS peer_preferences (
        user_id TEXT NOT NULL REFERENCES users(id), peer_id TEXT NOT NULL REFERENCES users(id),
        blocked INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0, notify INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,peer_id));
      CREATE TABLE IF NOT EXISTS read_markers (
        user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL, message_id INTEGER NOT NULL,
        PRIMARY KEY(user_id,scope));
      CREATE TABLE IF NOT EXISTS activity_sessions (
        id TEXT PRIMARY KEY, host TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL REFERENCES channels(name),
        activity TEXT NOT NULL, title TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 2 AND 32),
        starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, visibility TEXT NOT NULL,
        join_link TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open');
      CREATE TABLE IF NOT EXISTS activity_members (
        session_id TEXT NOT NULL REFERENCES activity_sessions(id), user_id TEXT NOT NULL REFERENCES users(id),
        PRIMARY KEY(session_id,user_id));
      CREATE TABLE IF NOT EXISTS activity_invites (
        session_id TEXT NOT NULL REFERENCES activity_sessions(id), user_id TEXT NOT NULL REFERENCES users(id),
        actor TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(session_id,user_id));
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY, reporter TEXT NOT NULL REFERENCES users(id), message_id INTEGER REFERENCES messages(id),
        reason TEXT NOT NULL, created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_friend_recipient ON friendships(recipient,accepted);
      CREATE INDEX IF NOT EXISTS idx_activity_expiry ON activity_sessions(status,expires_at);
      PRAGMA user_version=4;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
