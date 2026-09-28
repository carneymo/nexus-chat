import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { createCommunity } from './community.ts';

void test('whisper badge counts only accessible active senders and preserves disabled-account history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-whisper-count-'));
  const db = createStore(join(dir, 'nexus.sqlite'));
  try {
    const community = createCommunity(db, {
      online: () => false,
      removeVoice: () => {},
      fail: (_status, message) => {
        throw Error(message);
      },
    });
    for (const id of ['viewer', 'active', 'disabled'])
      db.prepare(
        'INSERT INTO users(id,name,salt,password_hash,disabled) VALUES(?,?,?,?,?)',
      ).run(id, id, 'test', 'test', id === 'disabled' ? 1 : 0);
    const insert = db.prepare(
      "INSERT INTO messages(user_id,recipient,channel,text,created_at) VALUES(?,'viewer','The Lobby','test',?)",
    );
    insert.run('disabled', Date.now());
    insert.run('disabled', Date.now());
    const activeId = Number(insert.run('active', Date.now()).lastInsertRowid);
    assert.deepEqual(
      community.snapshot('viewer').unread!.map((r) => ({ ...r })),
      [{ peer: 'active', count: 1 }],
    );
    community.mutate('viewer', {
      action: 'read',
      peer: 'active',
      messageId: activeId,
    });
    assert.deepEqual(community.snapshot('viewer').unread, []);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM messages WHERE user_id='disabled'")
        .get()!.n,
      2,
    );
    // Restoring an account restores access to its still-unread history.
    db.prepare("UPDATE users SET disabled=0 WHERE id='disabled'").run();
    assert.deepEqual(
      community.snapshot('viewer').unread!.map((r) => ({ ...r })),
      [{ peer: 'disabled', count: 2 }],
    );
    community.mutate('viewer', {
      action: 'peer-preferences',
      peer: 'disabled',
      muted: true,
    });
    assert.deepEqual(community.snapshot('viewer').unread, []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
