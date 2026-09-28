import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.ts';

void test('release announcements are opt-in, Releases-only, idempotent and respect archived channels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-release-'));
  const db = createStore(join(dir, 'nexus.sqlite'));
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../scripts/announce-release.mjs', import.meta.url),
        ),
        ...args,
      ],
      { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' },
    );
  try {
    db.prepare(
      "INSERT INTO users(id,name,salt,password_hash,is_admin) VALUES('admin','Admin','test','test',1)",
    ).run();
    assert.equal(run('aaaaaaa', 'Routine fix').status, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM messages').get()!.n, 0);
    assert.equal(
      db.prepare("SELECT name FROM channels WHERE name='Releases'").get(),
      undefined,
    );
    assert.equal(run('--prepare-channel').status, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM messages').get()!.n, 0);
    assert.equal(run('bbbbbbb', 'New feature', '--significant').status, 0);
    assert.equal(run('bbbbbbb', 'Retry', '--significant').status, 0);
    const posts = db.prepare('SELECT channel,text FROM messages').all();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].channel, 'Releases');
    assert.match(String(posts[0].text), /New feature/);
    db.prepare("UPDATE channels SET archived=1 WHERE name='Releases'").run();
    assert.notEqual(
      run('ccccccc', 'Another feature', '--significant').status,
      0,
    );
    assert.equal(db.prepare('SELECT count(*) n FROM messages').get()!.n, 1);
    assert.equal(
      db
        .prepare(
          "SELECT release FROM deployment_announcements WHERE release='ccccccc'",
        )
        .get(),
      undefined,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('release history preserves dates, archives duplicate broadcasts, and leaves normal messages alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-release-history-'));
  const db = createStore(join(dir, 'nexus.sqlite'));
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../scripts/migrate-release-history.mjs', import.meta.url),
        ),
        ...args,
      ],
      { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' },
    );
  try {
    db.prepare(
      "INSERT INTO users(id,name,salt,password_hash,is_admin) VALUES('admin','Admin','test','test',1)",
    ).run();
    db.prepare(
      "INSERT INTO channels(name,visibility) VALUES('Releases','public')",
    ).run();
    db.exec(
      'CREATE TABLE deployment_announcements(release TEXT PRIMARY KEY,created_at INTEGER,channels INTEGER)',
    );
    const posted = Date.parse('2026-09-27T22:00:00Z');
    db.prepare('INSERT INTO deployment_announcements VALUES(?,?,2)').run(
      'aaaaaaa',
      posted,
    );
    const text =
      'Nexus deployment announcement: Test feature. Release aaaaaaa.';
    for (const channel of ['The Lobby', 'After Hours'])
      db.prepare(
        "INSERT INTO messages(user_id,channel,text,created_at,kind) VALUES('admin',?,?,?,'event')",
      ).run(channel, text, posted);
    db.prepare(
      "INSERT INTO messages(user_id,channel,text,created_at,kind) VALUES('admin','The Lobby',?,?,'message')",
    ).run(text, posted);
    assert.equal(run().status, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM messages').get()!.n, 3);
    const applied = run('--apply');
    assert.equal(applied.status, 0, applied.stderr);
    const events = db
      .prepare("SELECT * FROM messages WHERE kind='event'")
      .all();
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, 'Releases');
    assert.equal(events[0].created_at, posted);
    assert.match(String(events[0].text), /Sep 27, 2026, 4:00 PM MDT/);
    assert.equal(
      db.prepare('SELECT count(*) n FROM release_history_backup').get()!.n,
      2,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM messages WHERE kind='message' AND channel='The Lobby'",
        )
        .get()!.n,
      1,
    );
    assert.equal(JSON.parse(run('--apply').stdout).releases, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
