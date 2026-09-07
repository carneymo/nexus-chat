import { testInvite } from './test-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';

void test('HTTP descriptions, permanent deletion, and single-use server invitations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-management-'));
  const config = {
    databasePath: join(directory, 'chat.sqlite'),
    staticPath: directory,

    origin: 'https://nexus.test',
    secureCookies: false,
    serverName: 'Test',
  };
  let app = createApp(config);
  let base = '';
  async function start() {
    await new Promise<void>((resolve) =>
      app.server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }
  async function call(path: string, cookie = '', body?: unknown) {
    const response = await fetch(`${base}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
      data: (await response.json()) as {
        url: string;
        id: number;
        me: { id: string };
        community: { channels: { name: string; description: string }[] };
        invites: { id: string }[];
      },
    };
  }
  try {
    await start();
    const owner = await call('register', '', {
      name: 'Owner',
      password: 'long-password',
      inviteToken: testInvite(app.db),
    });
    const member = await call('register', '', {
      name: 'Member',
      password: 'long-password',
      inviteToken: testInvite(app.db),
    });
    const ownerId = (await call('state', owner.cookie)).data.me.id;
    const memberId = (await call('state', member.cookie)).data.me.id;
    app.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(ownerId);
    assert.equal(
      (
        await call('channel', owner.cookie, {
          name: 'New Room',
          description: 'For game nights',
          visibility: 'invite-only',
          createOnly: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await call('state', owner.cookie)).data.community.channels.find(
        (c) => c.name === 'New Room',
      )!.description,
      'For game nights',
    );
    assert.equal(
      (
        await call('channel', owner.cookie, {
          name: 'New Room',
          description: 'Ignored?',
          visibility: 'public',
          createOnly: true,
        })
      ).status,
      409,
    );
    assert.ok(
      !(await call('state', member.cookie)).data.community.channels.some(
        (c) => c.name === 'New Room',
      ),
    );
    assert.equal(
      (
        await call('community', owner.cookie, {
          action: 'channel-settings',
          channel: 'New Room',
          visibility: 'invite-only',
          notices: true,
          description: 'Updated description',
        })
      ).status,
      200,
    );
    assert.equal(
      (await call('state', owner.cookie)).data.community.channels.find(
        (c) => c.name === 'New Room',
      )!.description,
      'Updated description',
    );
    const image = {
      name: 'test.png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=',
    };
    const posted = await call('messages', owner.cookie, {
      text: 'Channel image',
      image,
    });
    await call('messages', owner.cookie, {
      text: 'Keep this whisper',
      recipient: memberId,
    });
    const action = {
      action: 'delete-channel',
      target: 'New Room',
      confirm: 'New Room',
    };
    assert.equal(
      (await call('admin/action', member.cookie, action)).status,
      403,
    );
    assert.equal(
      (await call('admin/action', owner.cookie, action)).status,
      409,
    );
    assert.equal(
      (
        await call('admin/action', owner.cookie, {
          ...action,
          action: 'remove-channel',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call('admin/action', owner.cookie, {
          ...action,
          confirm: 'Wrong',
        })
      ).status,
      400,
    );
    assert.equal(
      (await call('admin/action', owner.cookie, action)).status,
      200,
    );
    assert.equal(
      app.db.prepare('SELECT 1 FROM channels WHERE name=?').get('New Room'),
      undefined,
    );
    assert.equal(
      app.db
        .prepare('SELECT 1 FROM message_images WHERE message_id=?')
        .get(posted.data.id),
      undefined,
    );
    assert.ok(
      app.db
        .prepare('SELECT 1 FROM messages WHERE text=?')
        .get('Keep this whisper'),
    );
    assert.deepEqual(app.db.prepare('PRAGMA foreign_key_check').all(), []);
    for (const action of ['remove-channel', 'delete-channel'])
      assert.equal(
        (
          await call('admin/action', owner.cookie, {
            action,
            target: 'After Hours',
            confirm: 'After Hours',
          })
        ).status,
        200,
      );
    assert.equal((await call('admin/invites', member.cookie, {})).status, 403);
    const invite = await call('admin/invites', owner.cookie, {});
    assert.equal(invite.status, 201);
    const token = new URL(invite.data.url).hash.slice('#invite='.length);
    assert.ok(
      !JSON.stringify(
        app.db.prepare('SELECT * FROM server_invites').all(),
      ).includes(token),
    );
    const results = await Promise.all(
      ['FriendOne', 'FriendTwo'].map((name) =>
        call('register', '', {
          name,
          password: 'long-password',
          inviteToken: token,
        }),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.status).sort((a, b) => a - b),
      [200, 401],
    );
    const expired = await call('admin/invites', owner.cookie, {});
    app.db.prepare('UPDATE server_invites SET expires=0').run();
    assert.equal(
      (
        await call('register', '', {
          name: 'Expired',
          password: 'long-password',
          inviteToken: new URL(expired.data.url).hash.slice(8),
        })
      ).status,
      401,
    );
    const revoked = await call('admin/invites', owner.cookie, {});
    const pending = (await call('admin/state', owner.cookie)).data.invites;
    assert.equal(
      (await call('admin/invites', owner.cookie, { revoke: pending[0].id }))
        .status,
      200,
    );
    assert.equal(
      (
        await call('register', '', {
          name: 'Revoked',
          password: 'long-password',
          inviteToken: new URL(revoked.data.url).hash.slice(8),
        })
      ).status,
      401,
    );
    await app.close();
    app = createApp(config);
    await start();
    assert.equal(
      app.db.prepare('SELECT 1 FROM channels WHERE name=?').get('After Hours'),
      undefined,
    );
    assert.equal(
      app.db.prepare('SELECT 1 FROM channels WHERE name=?').get('New Room'),
      undefined,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
