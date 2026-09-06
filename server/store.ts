import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type User = {
  id: string;
  name: string;
  salt: string;
  password_hash: string;
  channel: string;
};
export function createStore(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS channels (name TEXT PRIMARY KEY COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'The Lobby' REFERENCES channels(name)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
      channel TEXT NOT NULL REFERENCES channels(name), recipient TEXT REFERENCES users(id),
      text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000), created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel,id) WHERE recipient IS NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient,id) WHERE recipient IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(user_id,id) WHERE recipient IS NOT NULL;

  `);
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(users)')
      .all()
      .map((column) => column.name),
  );
  if (!columns.has('display_name'))
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  if (!columns.has('color')) db.exec('ALTER TABLE users ADD COLUMN color TEXT');
  db.exec('PRAGMA user_version=2');
  for (const name of ['The Lobby', 'After Hours', 'Looking for Group'])
    db.prepare('INSERT OR IGNORE INTO channels(name) VALUES (?)').run(name);
  db.exec('PRAGMA optimize');
  return db;
}
