import { testInvite } from './test-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { parseImage, MAX_IMAGE_BYTES } from './images.ts';

type ImageState = {
  me: { id: string };
  imageRevision: number;
  messages: {
    id: number;
    imageName: string;
    imageDeleted: number;
    text: string;
  }[];
};

const image = {
  name: 'photo.png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=',
};

void test('image validation rejects unsupported, oversized, and malformed payloads', () => {
  assert.equal(parseImage(image).mime, 'image/png');
  for (const invalid of [
    null,
    { ...image, name: '../\nphoto.png' },
    { ...image, data: '%%%%' },
    {
      ...image,
      data: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),
    },
    { ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') },
  ])
    assert.throws(() => parseImage(invalid));
  // Large valid base64 must not overflow the regular expression stack.
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
  Buffer.from(image.data, 'base64').copy(bytes);
  assert.equal(
    parseImage({ ...image, data: bytes.toString('base64') }).bytes.length,
    MAX_IMAGE_BYTES,
  );
});

void test('image messaging: privacy, retries, deletion, and restart persistence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-images-'));
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
  async function request(path: string, cookie = '', data?: unknown) {
    return fetch(`${base}/api/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        Origin: config.origin,
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
    const state = (await (await request('state', cookie)).json()) as ImageState;
    return { cookie, id: state.me.id as string };
  }
  try {
    await start();
    const alice = await register('Alice');
    const bob = await register('Bob');
    const eve = await register('Eve');
    assert.equal((await request('messages', '', { image })).status, 401);
    const payload = {
      text: 'A photo',
      image,
      recipient: bob.id,
      nonce: 'image-retry-123456789',
    };
    const sent = await request('messages', alice.cookie, payload);
    assert.equal(sent.status, 201);
    const { id } = (await sent.json()) as { id: number };
    assert.equal(
      (await request('messages', alice.cookie, payload)).status,
      200,
    );
    assert.equal(
      (
        await request('messages', alice.cookie, {
          ...payload,
          image: { ...image, name: 'different.png' },
        })
      ).status,
      409,
    );
    for (const user of [alice, bob]) {
      const result = await request(`images/${id}`, user.cookie);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('content-type'), 'image/png');
      assert.match(result.headers.get('cache-control')!, /no-store/);
      assert.deepEqual(
        Buffer.from(await result.arrayBuffer()),
        Buffer.from(image.data, 'base64'),
      );
    }
    assert.equal((await request(`images/${id}`, eve.cookie)).status, 404);
    assert.equal((await request(`images/${id}`, '')).status, 401);
    assert.equal(
      (await request(`images/${id}/delete`, bob.cookie, {})).status,
      403,
    );
    const state = (await (
      await request('state', bob.cookie)
    ).json()) as ImageState;
    assert.equal(
      state.messages.find((m: { id: number }) => m.id === id)!.imageName,
      image.name,
    );
    assert.ok(!JSON.stringify(state).includes(image.data));
    await app.close();
    app = createApp(config);
    await start();
    assert.equal((await request(`images/${id}`, bob.cookie)).status, 200);
    assert.equal(
      (await request(`images/${id}/delete`, alice.cookie, {})).status,
      200,
    );
    assert.equal((await request(`images/${id}`, bob.cookie)).status, 404);
    assert.equal(
      app.db
        .prepare('SELECT data FROM message_images WHERE message_id=?')
        .get(id)!.data,
      null,
    );
    const after = (await (
      await request('state', bob.cookie)
    ).json()) as ImageState;
    assert.equal(after.imageRevision, state.imageRevision + 1);
    assert.equal(
      after.messages.find((m: { id: number }) => m.id === id)!.text,
      'A photo',
    );
    assert.equal(
      after.messages.find((m: { id: number }) => m.id === id)!.imageDeleted,
      1,
    );
    // A delayed retry cannot restore deleted bytes.
    assert.equal(
      (await request('messages', alice.cookie, payload)).status,
      200,
    );
    assert.equal((await request(`images/${id}`, bob.cookie)).status, 404);
    const publicSend = await request('messages', alice.cookie, { image });
    assert.equal(publicSend.status, 201);
    const publicId = ((await publicSend.json()) as { id: number }).id;
    assert.equal((await request(`images/${publicId}`, eve.cookie)).status, 200);
    app.db
      .prepare(
        'INSERT INTO channel_bans(channel,user_id,actor,reason,created_at) VALUES (?,?,?,?,?)',
      )
      .run('The Lobby', eve.id, alice.id, 'test', Date.now());
    assert.equal((await request(`images/${publicId}`, eve.cookie)).status, 404);
    const count = app.db.prepare('SELECT count(*) AS n FROM messages').get()!.n;
    assert.equal(
      (
        await request('messages', alice.cookie, {
          image: { ...image, data: 'bad!' },
        })
      ).status,
      400,
    );
    assert.equal(
      app.db.prepare('SELECT count(*) AS n FROM messages').get()!.n,
      count,
    );
    await app.close();
    app = createApp(config);
    await start();
    assert.equal((await request(`images/${id}`, bob.cookie)).status, 404);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
