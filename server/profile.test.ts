import { testInvite } from './test-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';

void test('profile updates preserve account identity and message history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-profile-'));
  const app = createApp({
    databasePath: join(directory, 'chat.sqlite'),
    staticPath: directory,

    origin: 'https://test.nexus',
    secureCookies: false,
    serverName: 'Test',
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let cookie = '';
  async function call(path: string, body?: unknown) {
    const response = await fetch(base + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    return {
      status: response.status,
      data: (await response.json()) as {
        me: { id: string; name: string; handle: string; color: string };
        messages: { userId: string; name: string; text: string }[];
      },
    };
  }
  try {
    const credentials = {
      name: 'Alice',
      password: 'very-long-password',
      inviteToken: testInvite(app.db),
    };
    assert.equal((await call('login', credentials)).status, 401);
    assert.equal((await call('register', credentials)).status, 200);
    const before = (await call('state')).data.me;
    await call('messages', { text: 'Keep my history' });
    assert.equal(
      (await call('profile', { displayName: 'Alice Smith', color: '#83d9ef' }))
        .status,
      200,
    );
    const after = (await call('state')).data;
    assert.equal(after.me.id, before.id);
    assert.equal(after.me.handle, 'Alice');
    assert.equal(after.me.name, 'Alice Smith');
    assert.equal(after.messages[0].userId, before.id);
    assert.equal(after.messages[0].name, 'Alice Smith');
    assert.equal(
      (
        await call('profile', {
          displayName: 'Bad\u202ename',
          color: '#83d9ef',
        })
      ).status,
      400,
    );
    assert.equal(
      (await call('profile', { displayName: 'Alice', color: '#000000' }))
        .status,
      400,
    );
    assert.equal((await call('register', credentials)).status, 401);
    assert.equal((await call('register', { ...credentials, inviteToken: testInvite(app.db) })).status, 409);
    await call('logout', {});
    assert.equal(
      (await call('profile', { displayName: 'Nobody', color: '#83d9ef' }))
        .status,
      401,
    );
    assert.equal(
      (await call('login', { name: 'Alice', password: 'very-long-password' }))
        .status,
      200,
    );
    assert.equal((await call('state')).data.me.name, 'Alice Smith');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
