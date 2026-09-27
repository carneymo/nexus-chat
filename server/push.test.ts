import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { mentionedHandles, type PushPayload } from './push.ts';
import { testInvite } from './test-fixtures.ts';

void test('mentions use complete stable handles, excluding emails and mass mentions', () => {
  assert.deepEqual(
    [
      ...mentionedHandles(
        'Hi @Alice, @bob-two! test@Example.com @@nobody @this_handle_is_far_too_long_for_nexus',
      ),
    ],
    ['alice', 'bob-two'],
  );
});

void test('phone registration, authorized notifications, retries and session revocation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-push-'));
  const delivered: PushPayload[] = [];
  let failDelivery = false;
  let invalidToken = false;
  const config = {
    databasePath: join(directory, 'chat.sqlite'),
    staticPath: directory,
    origin: 'https://nexus.test',
    secureCookies: false,
    serverName: 'Test',
    pushSender: async (payload: PushPayload) => {
      if (failDelivery) throw new Error('Simulated outage');
      if (invalidToken) return 'invalid' as const;
      delivered.push(payload);
      return 'sent' as const;
    },
  };
  let app = createApp(config);
  let base = '';
  async function start() {
    await new Promise<void>((resolve) =>
      app.server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }
  async function request(
    path: string,
    cookie = '',
    data?: unknown,
    origin = config.origin,
  ) {
    return fetch(`${base}/api/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  async function register(name: string) {
    const response = await request('register', '', {
      name,
      password: 'long-test-password',
      inviteToken: testInvite(app.db),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const state = (await (await request('state', cookie)).json()) as {
      me: { id: string };
    };
    return { cookie, id: state.me.id };
  }
  const token = 'test-device-token:12345678901234567890';
  try {
    await start();
    const alice = await register('Alice');
    const bob = await register('Bob');
    const eve = await register('Eve');
    assert.equal((await request('push', '', { token })).status, 401);
    assert.equal(
      (await request('push', bob.cookie, { token }, 'https://evil.test'))
        .status,
      403,
    );
    assert.equal(
      (await request('push', bob.cookie, { token: 'bad' })).status,
      400,
    );
    assert.equal(
      (await request('push', bob.cookie, { token, dm: 'yes' })).status,
      400,
    );
    assert.equal((await request('push', bob.cookie, { token })).status, 200);
    assert.equal((await request('push', eve.cookie, { token })).status, 409);
    await request('push', eve.cookie, { token, action: 'remove' });
    assert.equal(
      app.db.prepare('SELECT count(*) AS n FROM push_devices').get()!.n,
      1,
    );
    const message = {
      text: 'Private content',
      recipient: bob.id,
      nonce: 'unique-message-id-0001',
    };
    assert.equal(
      (await request('messages', alice.cookie, message)).status,
      201,
    );
    assert.equal(
      (await request('messages', alice.cookie, message)).status,
      200,
    );
    assert.equal(
      app.db.prepare('SELECT count(*) AS n FROM push_outbox').get()!.n,
      1,
    );
    await app.flushPush();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].data.kind, 'dm');
    assert.equal(delivered[0].data.account, bob.id);
    assert.match(delivered[0].data.link, new RegExp(alice.id));
    assert.equal(JSON.stringify(delivered).includes('Private content'), false);
    await request('messages', alice.cookie, { text: 'Ordinary room message' });
    await app.flushPush();
    assert.equal(delivered.length, 1);
    await request('messages', alice.cookie, { text: 'Hi @Bob!' });
    await app.flushPush();
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].data.kind, 'mention');
    await request('push', bob.cookie, { token, mentions: false });
    await request('messages', alice.cookie, { text: 'Hi @Bob again' });
    await app.flushPush();
    assert.equal(delivered.length, 2);
    await request('push', bob.cookie, { token });
    // Recheck privacy at delivery time, including changes after enqueue.
    await request('messages', alice.cookie, {
      text: 'Wait',
      recipient: bob.id,
    });
    app.db.prepare("UPDATE users SET presence='dnd' WHERE id=?").run(bob.id);
    await app.flushPush();
    assert.equal(delivered.length, 2);
    app.db.prepare("UPDATE users SET presence='online' WHERE id=?").run(bob.id);
    app.db
      .prepare(
        'INSERT INTO peer_preferences(user_id,peer_id,muted) VALUES(?,?,1)',
      )
      .run(bob.id, alice.id);
    await request('messages', alice.cookie, {
      text: 'Muted',
      recipient: bob.id,
    });
    await app.flushPush();
    assert.equal(delivered.length, 2);
    app.db.prepare('DELETE FROM peer_preferences').run();
    await request('messages', alice.cookie, {
      text: 'Blocked before delivery',
      recipient: bob.id,
    });
    app.db
      .prepare(
        'INSERT INTO peer_preferences(user_id,peer_id,blocked) VALUES(?,?,1)',
      )
      .run(bob.id, alice.id);
    await app.flushPush();
    assert.equal(delivered.length, 2);
    assert.equal(
      (
        await request('messages', alice.cookie, {
          text: 'Blocked send',
          recipient: bob.id,
        })
      ).status,
      403,
    );
    app.db.prepare('DELETE FROM peer_preferences').run();
    await request('channel', alice.cookie, {
      name: 'Private',
      visibility: 'invite-only',
      createOnly: true,
    });
    await request('messages', alice.cookie, { text: 'Private room @Bob' });
    await app.flushPush();
    assert.equal(delivered.length, 2);
    app.db
      .prepare(
        "INSERT INTO channel_members(channel,user_id) VALUES('Private',?)",
      )
      .run(bob.id);
    await request('messages', alice.cookie, {
      text: 'Access revoked before delivery @Bob',
    });
    app.db
      .prepare(
        "DELETE FROM channel_members WHERE channel='Private' AND user_id=?",
      )
      .run(bob.id);
    await app.flushPush();
    assert.equal(delivered.length, 2);
    await request('channel', alice.cookie, {
      name: 'The Lobby',
      existingOnly: true,
    });
    failDelivery = true;
    await request('messages', alice.cookie, {
      text: 'Retried',
      recipient: bob.id,
    });
    await app.flushPush();
    assert.equal(
      app.db.prepare('SELECT attempts FROM push_outbox').get()!.attempts,
      1,
    );
    await app.close();
    app = createApp(config);
    await start();
    failDelivery = false;
    app.db.prepare('UPDATE push_outbox SET next_attempt=0').run();
    await app.flushPush();
    assert.equal(delivered.length, 3);
    await request('messages', alice.cookie, {
      text: 'Revoke before delivery',
      recipient: bob.id,
    });
    await request('logout', bob.cookie, {});
    await app.flushPush();
    assert.equal(delivered.length, 3);
    assert.equal(
      app.db.prepare('SELECT count(*) AS n FROM push_devices').get()!.n,
      0,
    );
    const loggedIn = await request('login', '', {
      name: 'Bob',
      password: 'long-test-password',
    });
    const newCookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
    await request('push', newCookie, { token });
    await request('messages', alice.cookie, {
      text: 'Uninstalled device',
      recipient: bob.id,
    });
    invalidToken = true;
    await app.flushPush();
    assert.equal(
      app.db.prepare('SELECT count(*) AS n FROM push_devices').get()!.n,
      0,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
