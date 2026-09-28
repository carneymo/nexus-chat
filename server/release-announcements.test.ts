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
