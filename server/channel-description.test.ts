import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { createCommunity } from './community.ts';

void test('channel descriptions: creation, authorized edits, privacy, validation and persistence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-description-'));
  const path = join(directory, 'chat.sqlite');
  let db = createStore(path);
  const dependencies = {
    fail: (status: number, message: string): never => {
      throw new Error(`${status}: ${message}`);
    },
    online: () => false,
    removeVoice: () => {},
  };
  try {
    for (const id of ['owner', 'visitor', 'admin'])
      db.prepare(
        'INSERT INTO users(id,name,salt,password_hash,is_admin) VALUES(?,?,?,?,?)',
      ).run(id, id, 'test', 'test', id === 'admin' ? 1 : 0);
    let community = createCommunity(db, dependencies);
    community.join('owner', 'Game Room', 'public', false, 'Weekend games');
    assert.equal(community.channel('Game Room')!.description, 'Weekend games');
    community.join('visitor', 'Game Room', 'public', false, 'Cannot overwrite');
    assert.equal(community.channel('Game Room')!.description, 'Weekend games');
    const settings = {
      action: 'channel-settings',
      channel: 'Game Room',
      visibility: 'public',
      notices: true,
      description: 'Bring your own snacks',
    };
    assert.throws(() => community.mutate('visitor', settings), /403/);
    community.mutate('owner', settings);
    assert.equal(
      community.channelList('visitor').find((c) => c.name === 'Game Room')!
        .description,
      'Bring your own snacks',
    );
    assert.throws(
      () =>
        community.mutate('owner', {
          ...settings,
          description: 'x'.repeat(281),
        }),
      /400/,
    );
    assert.equal(
      community.channel('Game Room')!.description,
      'Bring your own snacks',
    );
    assert.throws(
      () =>
        community.join(
          'owner',
          'Invalid Room',
          'public',
          false,
          'x'.repeat(281),
        ),
      /400/,
    );
    assert.equal(community.channel('Invalid Room'), undefined);
    community.join(
      'owner',
      'Secret Room',
      'invite-only',
      false,
      'Private description',
    );
    assert.ok(
      !community.channelList('visitor').some((c) => c.name === 'Secret Room'),
    );
    community.mutate('admin', {
      ...settings,
      channel: 'The Lobby',
      description: 'Welcome everyone',
    });
    assert.throws(
      () =>
        community.mutate('admin', {
          ...settings,
          channel: 'The Lobby',
          visibility: 'invite-only',
        }),
      /409/,
    );
    db.close();
    db = createStore(path);
    community = createCommunity(db, dependencies);
    assert.equal(
      community.channel('The Lobby')!.description,
      'Welcome everyone',
    );
    assert.equal(
      community.channel('Game Room')!.description,
      'Bring your own snacks',
    );
    community.mutate('owner', { ...settings, description: '' });
    db.close();
    db = createStore(path);
    assert.equal(
      createCommunity(db, dependencies).channel('Game Room')!.description,
      '',
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
