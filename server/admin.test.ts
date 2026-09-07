import { testInvite } from './test-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { createStore } from './store.ts';
void test('admin authorization, removal, restoration and protected resources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-admin-'));
  const databasePath = join(dir, 'chat.sqlite');
  const app = createApp({
    databasePath,
    staticPath: dir,

    origin: 'https://test.nexus',
    secureCookies: false,
    serverName: 'Test',
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  async function call(path: string, cookie = '', body?: unknown) {
    const response = await fetch(base + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
      data: (await response.json()) as {
        me: { id: string; isAdmin: number; channel: string };
        members: { id: string }[];
        channels: string[];
      },
    };
  }
  try {
    const owner = (
      await call('register', '', {
        name: 'Owner',
        password: 'long-test-password',
        inviteToken: testInvite(app.db),
      })
    ).cookie;
    const member = (
      await call('register', '', {
        name: 'Tester',
        password: 'long-test-password',
        inviteToken: testInvite(app.db),
      })
    ).cookie;
    const ownerId = (await call('state', owner)).data.me.id;
    const memberId = (await call('state', member)).data.me.id;
    assert.equal((await call('admin/state')).status, 401);
    assert.equal((await call('admin/state', member)).status, 403);
    assert.equal(
      (
        await call('admin/action', member, {
          action: 'remove-user',
          target: ownerId,
          confirm: 'Owner',
        })
      ).status,
      403,
    );
    await call('profile', member, {
      displayName: 'Tester',
      color: '#83d9ef',
      is_admin: 1,
    });
    assert.equal((await call('admin/state', member)).status, 403);
    app.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(ownerId);
    assert.equal((await call('admin/state', owner)).status, 200);
    assert.equal(
      (
        await call('admin/action', owner, {
          action: 'remove-user',
          target: ownerId,
          confirm: 'Owner',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call('admin/action', owner, {
          action: 'remove-user',
          target: memberId,
          confirm: 'Wrong',
        })
      ).status,
      400,
    );
    await call('messages', member, { text: 'Preserve history' });
    assert.equal(
      (
        await call('admin/action', owner, {
          action: 'remove-user',
          target: memberId,
          confirm: 'Tester',
        })
      ).status,
      200,
    );
    assert.equal(
      (await call('messages', member, { text: 'Revoked' })).status,
      401,
    );
    assert.equal(
      (
        await call('login', '', {
          name: 'Tester',
          password: 'long-test-password',
        })
      ).status,
      401,
    );
    assert.ok(
      !(await call('state', owner)).data.members.some((m) => m.id === memberId),
    );
    assert.equal(
      Number(
        app.db
          .prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id=?')
          .get(memberId)!.n,
      ),
      1,
    );
    assert.equal(
      (
        await call('admin/action', owner, {
          action: 'restore-user',
          target: memberId,
          confirm: 'Tester',
        })
      ).status,
      200,
    );
    const restored = (
      await call('login', '', {
        name: 'Tester',
        password: 'long-test-password',
      })
    ).cookie;
    assert.ok(restored);
    await call('channel', restored, { name: 'After Hours' });
    assert.equal(
      (
        await call('admin/action', owner, {
          action: 'remove-channel',
          target: 'The Lobby',
          confirm: 'The Lobby',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call('admin/action', owner, {
          action: 'remove-channel',
          target: 'After Hours',
          confirm: 'After Hours',
        })
      ).status,
      200,
    );
    assert.equal((await call('state', restored)).data.me.channel, 'The Lobby');
    assert.ok(
      !(await call('state', owner)).data.channels.includes('After Hours'),
    );
    assert.equal(
      (await call('channel', restored, { name: 'after hours' })).status,
      409,
    );
    assert.equal(
      (
        await call('admin/action', owner, {
          action: 'restore-channel',
          target: 'After Hours',
          confirm: 'After Hours',
        })
      ).status,
      200,
    );
    assert.equal(
      (await call('channel', restored, { name: 'After Hours' })).status,
      200,
    );
    await call('admin/action', owner, {
      action: 'remove-channel',
      target: 'After Hours',
      confirm: 'After Hours',
    });
    assert.equal(
      Number(app.db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action!='account-registered'").get()!.n),
      5,
    );
  } finally {
    await app.close();
  }
  const db = createStore(databasePath);
  try {
    assert.equal(
      db
        .prepare('SELECT archived FROM channels WHERE name=?')
        .get('After Hours')!.archived,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
