import { testInvite } from './test-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from './app.ts';

type Reply = {
  id: string;
  iceServers: { urls: string[]; username: string; credential: string }[];
  voice: { id: string; muted: boolean }[];
};
void test(
  'voice permissions, signaling, roster and lifecycle',
  { timeout: 15000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-voice-'));
    const secret = 'test-turn-secret-not-production';
    const app = createApp({
      databasePath: join(directory, 'chat.sqlite'),
      staticPath: directory,

      origin: 'https://test.nexus',
      secureCookies: false,
      serverName: 'Test',
      turnSecret: secret,
      turnUrls: ['turn:relay.test:3478?transport=udp'],
    });
    await new Promise<void>((resolve) =>
      app.server.listen(0, '127.0.0.1', resolve),
    );
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const aborters: AbortController[] = [];
    async function request(path: string, cookie = '', body?: unknown) {
      const response = await fetch(`${base}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://test.nexus',
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        data: (await response.json()) as Reply,
        cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
      };
    }
    async function login(name: string) {
      return (
        await request('register', '', {
          name,
          password: 'test-long-password',
          inviteToken: testInvite(app.db),
        })
      ).cookie;
    }
    async function listen(id: string, cookie: string) {
      const abort = new AbortController();
      aborters.push(abort);
      const response = await fetch(`${base}/api/voice/events?id=${id}`, {
        headers: { Cookie: cookie },
        signal: abort.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      let content = '';
      void (async () => {
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            content += new TextDecoder().decode(result.value);
          }
        } catch {
          /* Expected on disconnect. */
        }
      })();
      return { abort, text: () => content };
    }
    try {
      assert.equal((await request('voice/join', '', {})).status, 401);
      const alice = await login('Alice'),
        bob = await login('Bob'),
        eve = await login('Eve');
      const a = await request('voice/join', alice, {});
      assert.equal(a.status, 200);
      const ice = a.data.iceServers[0];
      assert.equal(
        ice.credential,
        createHmac('sha1', secret).update(ice.username).digest('base64'),
      );
      assert.ok(Number(ice.username.split(':')[0]) > Date.now() / 1000);
      assert.equal((await request('voice/join', alice, {})).status, 409);
      const b = await request('voice/join', bob, {});
      await request('channel', eve, { name: 'Elsewhere' });
      const e = await request('voice/join', eve, {});
      const aStream = await listen(a.data.id, alice);
      await listen(b.data.id, bob);
      await listen(e.data.id, eve);
      assert.equal((await request('state', alice)).data.voice.length, 2);
      assert.equal(
        (await request('voice/mute', bob, { id: a.data.id, muted: true }))
          .status,
        403,
      );
      assert.equal(
        (await request('voice/mute', alice, { id: a.data.id, muted: 'yes' }))
          .status,
        400,
      );
      assert.equal(
        (await request('voice/mute', alice, { id: a.data.id, muted: true }))
          .status,
        200,
      );
      assert.equal(
        (await request('state', bob)).data.voice.find((p) => p.id === a.data.id)
          ?.muted,
        true,
      );
      assert.equal(
        (
          await request('voice/signal', alice, {
            id: a.data.id,
            to: e.data.id,
            signal: { type: 'offer', sdp: 'v=0' },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request('voice/signal', bob, {
            id: b.data.id,
            to: a.data.id,
            signal: { type: 'offer', sdp: 'v=0' },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request('voice/signal', alice, {
            id: a.data.id,
            to: b.data.id,
            signal: { type: 'candidate', candidate: 5 },
          })
        ).status,
        400,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(aStream.text(), /event: signal/);
      assert.match(aStream.text(), /"sdp":"v=0"/);
      await request('channel', bob, { name: 'Elsewhere' });
      assert.equal(
        (await request('state', alice)).data.voice.some(
          (p) => p.id === b.data.id,
        ),
        false,
      );
      assert.equal(
        (await request('voice/heartbeat', bob, { id: b.data.id })).status,
        403,
      );
      await request('logout', eve, {});
      assert.equal((await request('state', alice)).data.voice.length, 1);
      aStream.abort.abort();
      for (
        let i = 0;
        i < 20 && (await request('state', alice)).data.voice.length;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal((await request('state', alice)).data.voice.length, 0);
      assert.equal((await request('voice/join', alice, {})).status, 200);
    } finally {
      aborters.forEach((abort) => abort.abort());
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
