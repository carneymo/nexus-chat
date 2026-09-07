import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
void test('legacy database migration preserves identity, messages and public access, and is repeatable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-migration-')),
    path = join(dir, 'old.sqlite');
  let db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE channels(name TEXT PRIMARY KEY COLLATE NOCASE);
  CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT UNIQUE COLLATE NOCASE,salt TEXT,password_hash TEXT,channel TEXT REFERENCES channels(name));
  CREATE TABLE messages(id INTEGER PRIMARY KEY,user_id TEXT REFERENCES users(id),channel TEXT REFERENCES channels(name),recipient TEXT REFERENCES users(id),text TEXT,created_at INTEGER);
  INSERT INTO channels VALUES('Old Room');INSERT INTO users VALUES('stable-id','OriginalHandle','salt','hash','Old Room');
  INSERT INTO messages VALUES(77,'stable-id','Old Room',NULL,'Preserved history',1234);PRAGMA user_version=3;`);
    db.close();
    db = createStore(path);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.equal(
      db.prepare('SELECT name FROM users WHERE id=?').get('stable-id')!.name,
      'OriginalHandle',
    );
    assert.equal(
      db.prepare('SELECT text FROM messages WHERE id=77').get()!.text,
      'Preserved history',
    );
    assert.equal(
      db.prepare("SELECT visibility FROM channels WHERE name='Old Room'").get()!
        .visibility,
      'public',
    );
    assert.equal(
      db.prepare("SELECT owner_id FROM channels WHERE name='Old Room'").get()!
        .owner_id,
      null,
    );
    db.close();
    db = createStore(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
