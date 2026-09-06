import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type Config } from './app.ts';
type TestState = {
  me: { id: string; name: string; channel: string };
  members: { id: string; online: boolean }[];
  messages: { text: string; userId: string }[];
};

void test('gateway integration: authentication, delivery, privacy, and persistence', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-test-'));
  const staticPath = join(directory, 'public');
  mkdirSync(staticPath);
  writeFileSync(join(staticPath, 'index.html'), '<h1>Nexus</h1>');
  writeFileSync(join(directory, 'secret.txt'), 'private');
  const config: Config = {
    databasePath: join(directory, 'chat.sqlite'),
    staticPath,
    inviteCode: 'test-invite-code-123456789',
    origin: 'https://nexus.test',
    secureCookies: false,
    serverName: 'Test Gateway',
  };
  let app = createApp(config);
  async function start() {
    await new Promise<void>((resolve) =>
      app.server.listen(0, '127.0.0.1', resolve),
    );
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }
  let base = await start();
  async function request(
    path: string,
    cookie = '',
    body?: unknown,
    origin = config.origin,
  ) {
    const response = await fetch(`${base}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, data: (await response.json()) as TestState };
  }
  async function login(name: string) {
    let result = await request('register', '', {
      name,
      password: 'long-test-password',
      invite: config.inviteCode,
    });
    if (result.response.status === 409)
      result = await request('login', '', {
        name,
        password: 'long-test-password',
      });
    assert.equal(result.response.status, 200);
    assert.match(
      result.response.headers.get('set-cookie')!,
      /HttpOnly; SameSite=Strict/,
    );
    return result.response.headers.get('set-cookie')!.split(';')[0];
  }
  const abort = new AbortController();
  try {
    let alice = '';
    let bob = '';
    let eve = '';
    let aliceId = '';
    let bobId = '';
    await t.test(
      'invite and authentication required; unsafe origins rejected',
      async () => {
        assert.equal(
          (await request('messages', '', { text: 'unauthorized' })).response
            .status,
          401,
        );
        assert.equal(
          (
            await request('login', '', {
              name: 'Intruder',
              password: 'long-test-password',
              invite: 'wrong',
            })
          ).response.status,
          401,
        );
        assert.equal(
          (
            await request(
              'login',
              '',
              { name: 'Intruder', password: 'long-test-password' },
              'https://evil.test',
            )
          ).response.status,
          403,
        );
        const publicState = (await request('state')).data;
        assert.deepEqual(publicState.members, []);
        assert.deepEqual(publicState.messages, []);
        alice = await login('Alice');
        bob = await login('Bob');
        eve = await login('Eve');
        aliceId = (await request('state', alice)).data.me.id;
        bobId = (await request('state', bob)).data.me.id;
        assert.equal(
          (
            await request('login', '', {
              name: 'alice',
              password: 'wrong-password-long',
            })
          ).response.status,
          401,
        );
        const users = app.db.prepare('SELECT password_hash FROM users').all();
        assert.ok(
          users.every((user) => user.password_hash !== 'long-test-password'),
        );
      },
    );
    await t.test(
      'messages are delivered and HTML remains plain data',
      async () => {
        const sent = await request('messages', alice, {
          text: '<script>alert(1)</script>',
        });
        assert.equal(sent.response.status, 201);
        const state = (await request('state', bob)).data;
        assert.equal(state.messages[0].text, '<script>alert(1)</script>');
        assert.equal(state.messages[0].userId, aliceId);
      },
    );
    await t.test(
      'whispers are visible only to sender and recipient',
      async () => {
        assert.equal(
          (
            await request('messages', alice, {
              text: 'private conversation',
              recipient: bobId,
            })
          ).response.status,
          201,
        );
        assert.ok(
          (await request('state', bob)).data.messages.some(
            (message) => message.text === 'private conversation',
          ),
        );
        assert.ok(
          (await request('state', alice)).data.messages.some(
            (message) => message.text === 'private conversation',
          ),
        );
        assert.ok(
          !(await request('state', eve)).data.messages.some(
            (message) => message.text === 'private conversation',
          ),
        );
        assert.equal(
          (
            await request('messages', alice, {
              text: 'bad target',
              recipient: 'missing-user',
            })
          ).response.status,
          400,
        );
      },
    );
    await t.test(
      'channels isolate history and preserve shared whispers',
      async () => {
        assert.equal(
          (await request('channel', alice, { name: 'War Room' })).response
            .status,
          200,
        );
        await request('messages', alice, { text: 'room-specific' });
        assert.ok(
          !(await request('state', bob)).data.messages.some(
            (message) => message.text === 'room-specific',
          ),
        );
        await request('channel', bob, { name: 'war room' });
        const state = (await request('state', bob)).data;
        assert.equal(state.me.channel, 'War Room');
        assert.ok(
          state.messages.some((message) => message.text === 'room-specific'),
        );
        assert.ok(
          state.messages.some(
            (message) => message.text === 'private conversation',
          ),
        );
        assert.equal(
          (await request('channel', alice, { name: '<invalid>' })).response
            .status,
          400,
        );
      },
    );
    await t.test('SSE sends real presence and live updates', async () => {
      const response = await fetch(`${base}/api/events`, {
        headers: { Cookie: bob },
        signal: abort.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /event-stream/);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      async function until(text: string) {
        const deadline = setTimeout(() => abort.abort(), 5000);
        try {
          while (!received.includes(text)) {
            const next = await reader.read();
            assert.equal(next.done, false);
            received += decoder.decode(next.value);
          }
        } finally {
          clearTimeout(deadline);
        }
      }
      await until('event: state');
      assert.equal(
        (await request('state', alice)).data.members.find(
          (member) => member.id === bobId,
        )?.online,
        true,
      );
      await request('messages', alice, { text: 'live-delivery-proof' });
      await until('live-delivery-proof');
      await reader.cancel();
    });
    await t.test('validation, body limits, and file isolation', async () => {
      assert.equal(
        (await request('messages', alice, { text: '' })).response.status,
        400,
      );
      assert.equal(
        (await request('messages', alice, { text: 'x'.repeat(2001) })).response
          .status,
        400,
      );
      assert.equal(
        (await request('messages', alice, { text: 'x'.repeat(17000) })).response
          .status,
        413,
      );
      assert.equal((await fetch(base)).status, 200);
      assert.notEqual((await fetch(`${base}/%2e%2e%2fsecret.txt`)).status, 200);
      const privateFile = await fetch(`${base}/.env`);
      assert.equal(privateFile.status, 404);
      assert.equal((await request('health')).response.status, 200);
    });
    await t.test(
      'messages, accounts, and sessions survive a restart',
      async () => {
        await app.close();
        app = createApp(config);
        base = await start();
        const state = (await request('state', bob)).data;
        assert.equal(state.me.name, 'Bob');
        assert.ok(
          state.messages.some(
            (message) => message.text === 'live-delivery-proof',
          ),
        );
        assert.ok(state.members.every((member) => member.online === false));
      },
    );
    await t.test('logout and expiration revoke access', async () => {
      assert.equal((await request('logout', bob, {})).response.status, 200);
      assert.equal(
        (await request('messages', bob, { text: 'should fail' })).response
          .status,
        401,
      );
      app.db
        .prepare('UPDATE sessions SET expires = 0 WHERE user_id = ?')
        .run(aliceId);
      assert.equal(
        (await request('messages', alice, { text: 'expired' })).response.status,
        401,
      );
    });
    await t.test('flood protection limits messages', async () => {
      let limited = false;
      for (let index = 0; index < 42; index++) {
        const result = await request('messages', eve, {
          text: `message-${index}`,
        });
        if (result.response.status === 429) {
          limited = true;
          break;
        }
      }
      assert.equal(limited, true);
    });
  } finally {
    abort.abort();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
