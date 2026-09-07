import { testInvite } from './test-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { request as httpRequest } from 'node:http';
import type { CommunityState } from '../components/community-panel.tsx';
type Result = {
  id: number;
  me: { id: string; channel: string };
  members: { id: string; channel: string; online: boolean }[];
  channels: string[];
  messages: { id: number; text: string; channel: string }[];
  community: CommunityState;
};

void test('community permissions, persistence, delivery and session concurrency', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-community-'));
  const config = {
    databasePath: join(dir, 'chat.sqlite'),
    staticPath: dir,

    origin: 'https://nexus.test',
    secureCookies: false,
    serverName: 'Test',
    turnUrls: ['turn:relay.test:3478'],
    turnSecret: 'test-turn-secret-no-real-relay',
  };
  let app = createApp(config);
  let base = '';
  async function start() {
    await new Promise<void>((resolve) =>
      app.server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }
  await start();
  async function request(path: string, cookie = '', body?: unknown) {
    const response = await fetch(base + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        Origin: config.origin,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: (await response.json()) as Result,
      cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
    };
  }
  async function register(name: string) {
    const result = await request('register', '', {
      name,
      password: 'test-password-long',
      inviteToken: testInvite(app.db),
    });
    assert.equal(result.status, 200);
    const state = await request('state', result.cookie);
    return { cookie: result.cookie, id: state.data.me.id };
  }
  const a = await register('Alice'),
    b = await register('Bob'),
    e = await register('Eve');
  const mutate = (user: typeof a, body: unknown) =>
    request('community', user.cookie, body);
  const streams: AbortController[] = [];
  async function stream(user: typeof a) {
    const abort = new AbortController();
    streams.push(abort);
    const response = await fetch(base + '/api/events', {
      headers: { Cookie: user.cookie },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    let output = '';
    void (async () => {
      try {
        const reader = response.body!.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          output += new TextDecoder().decode(value);
        }
      } catch {}
    })();
    await new Promise((r) => setTimeout(r, 30));
    return { abort, text: () => output };
  }
  try {
    await t.test(
      'private discovery, history, search and location stay private even for friends',
      async () => {
        assert.equal(
          (
            await request('channel', a.cookie, {
              name: 'Secret Room',
              visibility: 'invite-only',
            })
          ).status,
          200,
        );
        assert.equal(
          (await request('messages', a.cookie, { text: 'private-secret' }))
            .status,
          201,
        );
        assert.equal(
          (await mutate(a, { action: 'friend-request', peer: b.id })).status,
          200,
        );
        assert.equal(
          (await mutate(b, { action: 'friend-accept', peer: a.id })).status,
          200,
        );
        const state = (await request('state', b.cookie)).data;
        assert.ok(!state.channels.includes('Secret Room'));
        assert.equal(
          state.members.find((m: { id: string }) => m.id === a.id)!.channel,
          '',
        );
        assert.equal(
          (await request('channel', b.cookie, { name: 'Secret Room' })).status,
          404,
        );
        assert.equal(
          (await request('history?channel=Secret%20Room', b.cookie)).status,
          404,
        );
        assert.equal(
          (await request('search?channel=Secret%20Room&q=private', b.cookie))
            .status,
          404,
        );
        assert.ok(
          !(await request('state')).data.channels.includes('Secret Room'),
        );
        assert.equal(
          (
            await mutate(a, {
              action: 'channel-invite',
              channel: 'Secret Room',
              peer: b.id,
            })
          ).status,
          200,
        );
        assert.equal(
          (await request('channel', b.cookie, { name: 'Secret Room' })).status,
          200,
        );
        assert.equal(
          (await request('history?channel=Secret%20Room', b.cookie)).data
            .messages[0].text,
          'private-secret',
        );
        assert.equal(
          (
            await request('messages', a.cookie, {
              text: 'cross-room DM',
              recipient: e.id,
            })
          ).status,
          201,
        );
        assert.equal(
          (await request('state', e.cookie)).data.messages.find(
            (m: { text: string }) => m.text === 'cross-room DM',
          )!.channel,
          '',
        );
      },
    );
    await t.test(
      'durable owner/moderator, ban, revoke, restart and unban rules',
      async () => {
        assert.equal(
          (
            await mutate(e, {
              action: 'channel-role',
              channel: 'Secret Room',
              peer: b.id,
              role: 'moderator',
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await mutate(a, {
              action: 'channel-role',
              channel: 'Secret Room',
              peer: b.id,
              role: 'moderator',
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await mutate(b, {
              action: 'channel-ban',
              channel: 'Secret Room',
              peer: a.id,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await mutate(a, {
              action: 'channel-ban',
              channel: 'Secret Room',
              peer: b.id,
              reason: 'test ban',
            })
          ).status,
          200,
        );
        assert.equal(
          (await request('state', b.cookie)).data.me.channel,
          'The Lobby',
        );
        await app.close();
        app = createApp(config);
        await start();
        assert.equal(
          (await request('channel', b.cookie, { name: 'Secret Room' })).status,
          404,
        );
        assert.equal(
          (await request('history?channel=Secret%20Room', b.cookie)).status,
          404,
        );
        assert.equal(
          (
            await mutate(a, {
              action: 'channel-invite',
              channel: 'Secret Room',
              peer: b.id,
            })
          ).status,
          200,
        );
        assert.equal(
          (await request('channel', b.cookie, { name: 'Secret Room' })).status,
          404,
        );
        assert.equal(
          (
            await mutate(a, {
              action: 'channel-unban',
              channel: 'Secret Room',
              peer: b.id,
            })
          ).status,
          200,
        );
        assert.equal(
          (await request('channel', b.cookie, { name: 'Secret Room' })).status,
          200,
        );
        assert.ok(
          Number(
            app.db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get()!.n,
          ) >= 4,
        );
      },
    );
    await t.test(
      'unlisted channels require a name and home restores on login',
      async () => {
        await request('channel', e.cookie, {
          name: 'Known by name',
          visibility: 'unlisted',
        });
        assert.ok(
          !(await request('state', a.cookie)).data.channels.includes(
            'Known by name',
          ),
        );
        assert.equal(
          (await request('channel', a.cookie, { name: 'Known by name' }))
            .status,
          200,
        );
        const settings = (await request('state', a.cookie)).data.community
          .settings;
        assert.equal(
          (
            await mutate(a, {
              action: 'settings',
              ...settings,
              homeChannel: 'Known by name',
            })
          ).status,
          200,
        );
        await request('channel', a.cookie, { name: 'The Lobby' });
        const login = await request('login', '', {
          name: 'Alice',
          password: 'test-password-long',
        });
        assert.equal(
          (await request('state', login.cookie)).data.me.channel,
          'Known by name',
        );
      },
    );
    await t.test(
      'friends-only messages, blocking, muting, DND and offline unread',
      async () => {
        const settings = (await request('state', b.cookie)).data.community
          .settings;
        await mutate(b, {
          action: 'settings',
          ...settings,
          friendsOnlyDM: true,
          presence: 'dnd',
        });
        assert.equal(
          (
            await request('messages', e.cookie, {
              text: 'unwanted',
              recipient: b.id,
            })
          ).status,
          403,
        );
        const bs = await stream(b);
        const sent = await request('messages', a.cookie, {
          text: 'quiet delivery',
          recipient: b.id,
        });
        assert.equal(sent.status, 201);
        await new Promise((r) => setTimeout(r, 40));
        assert.ok(!bs.text().includes('event: notice'));
        assert.equal(
          (await request('state', b.cookie)).data.community.unread.find(
            (u: { peer: string }) => u.peer === a.id,
          )!.count,
          1,
        );
        await mutate(b, {
          action: 'read',
          peer: a.id,
          messageId: sent.data.id,
        });
        assert.ok(
          !(await request('state', b.cookie)).data.community.unread.some(
            (u: { peer: string }) => u.peer === a.id,
          ),
        );
        await mutate(b, {
          action: 'peer-preferences',
          peer: a.id,
          muted: true,
        });
        assert.equal(
          (
            await request('messages', a.cookie, {
              text: 'muted but saved',
              recipient: b.id,
            })
          ).status,
          201,
        );
        assert.equal(
          (await request('history?peer=' + a.id, b.cookie)).data.messages
            .length,
          0,
        );
        await mutate(b, {
          action: 'peer-preferences',
          peer: a.id,
          blocked: true,
        });
        assert.equal(
          (
            await request('messages', a.cookie, {
              text: 'blocked',
              recipient: b.id,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request('messages', b.cookie, {
              text: 'also blocked',
              recipient: a.id,
            })
          ).status,
          403,
        );
        assert.equal(
          (await mutate(a, { action: 'friend-request', peer: b.id })).status,
          403,
        );
        await app.close();
        app = createApp(config);
        await start();
        assert.equal(
          (
            await request('messages', a.cookie, {
              text: 'still blocked',
              recipient: b.id,
            })
          ).status,
          403,
        );
        await mutate(b, { action: 'peer-preferences', peer: a.id });
      },
    );
    await t.test(
      'idempotency, cursor catchup, pagination and report access',
      async () => {
        await request('channel', a.cookie, { name: 'The Lobby' });
        const body = { text: 'once', nonce: 'nonce-0123456789abcdef' };
        const results = await Promise.all([
          request('messages', a.cookie, body),
          request('messages', a.cookie, body),
        ]);
        assert.equal(results[0].data.id, results[1].data.id);
        assert.equal(
          (await request('messages', a.cookie, { ...body, text: 'different' }))
            .status,
          409,
        );
        const insert = app.db.prepare(
          "INSERT INTO messages(user_id,channel,text,created_at) VALUES(?,'The Lobby',?,?)",
        );
        for (let n = 0; n < 250; n++)
          insert.run(a.id, 'catchup-' + n, Date.now());
        let after = results[0].data.id;
        const ids: number[] = [];
        for (;;) {
          const page = (
            await request(
              'history?channel=The%20Lobby&after=' + after,
              a.cookie,
            )
          ).data.messages;
          if (!page.length) break;
          ids.push(...page.map((m: { id: number }) => m.id));
          after = page.at(-1)!.id;
        }
        assert.equal(ids.length, 250);
        assert.equal(new Set(ids).size, 250);
        const recent = (await request('history?channel=The%20Lobby', a.cookie))
          .data.messages;
        const older = (
          await request(
            'history?channel=The%20Lobby&before=' + recent.at(-1)!.id,
            a.cookie,
          )
        ).data.messages;
        assert.equal(recent.length, 100);
        assert.equal(older.length, 100);
        assert.ok(older[0].id < recent.at(-1)!.id);
        const secret = app.db
          .prepare("SELECT id FROM messages WHERE text='private-secret'")
          .get()!;
        assert.equal(
          (
            await mutate(e, {
              action: 'report',
              messageId: secret.id,
              reason: 'cannot read',
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await mutate(a, {
              action: 'report',
              messageId: recent[0].id,
              reason: 'test report',
            })
          ).status,
          200,
        );
        assert.equal(
          (await mutate(e, { action: 'report-resolve', reportId: 1 })).status,
          403,
        );
      },
    );
    await t.test(
      'session visibility, capacity races, host controls and expiration',
      async () => {
        const settings = (await request('state', a.cookie)).data.community
          .settings;
        await mutate(a, {
          action: 'settings',
          ...settings,
          activityPrivacy: 'everyone',
        });
        await mutate(a, {
          action: 'session-create',
          channel: 'The Lobby',
          activity: 'StarCraft',
          title: 'Two seats',
          capacity: 2,
          visibility: 'public',
          joinLink: 'https://example.org/join',
        });
        const listing = (await request('state', e.cookie)).data.community
          .activities[0];
        assert.equal(listing.join_link, '');
        const results = await Promise.all([
          mutate(b, { action: 'session-join', sessionId: listing.id }),
          mutate(e, { action: 'session-join', sessionId: listing.id }),
        ]);
        assert.deepEqual(
          results.map((r) => r.status).sort((a, b) => a - b),
          [200, 409],
        );
        assert.equal(
          Number(
            app.db
              .prepare(
                'SELECT COUNT(*) AS n FROM activity_members WHERE session_id=?',
              )
              .get(listing.id)!.n,
          ),
          2,
        );
        assert.equal(
          (await mutate(e, { action: 'session-close', sessionId: listing.id }))
            .status,
          403,
        );
        await mutate(a, { action: 'session-close', sessionId: listing.id });
        assert.equal(
          (await mutate(b, { action: 'session-join', sessionId: listing.id }))
            .status,
          404,
        );
        await mutate(a, {
          action: 'session-create',
          channel: 'The Lobby',
          activity: 'Games',
          title: 'Expired',
          capacity: 4,
          visibility: 'public',
        });
        app.db
          .prepare(
            "UPDATE activity_sessions SET expires_at=1 WHERE status='open'",
          )
          .run();
        assert.equal(
          (await request('state', a.cookie)).data.community.activities.length,
          0,
        );
        await request('channel', a.cookie, { name: 'Secret Room' });
        await mutate(a, {
          action: 'session-create',
          channel: 'Secret Room',
          activity: 'Games',
          title: 'Secret listing',
          capacity: 4,
          visibility: 'public',
        });
        assert.ok(
          !(await request('state', e.cookie)).data.community.activities.some(
            (s: { title: string }) => s.title === 'Secret listing',
          ),
        );
      },
    );
    await t.test(
      'session invitations do not grant private-channel access',
      async () => {
        await mutate(a, { action: 'friend-request', peer: e.id });
        await mutate(e, { action: 'friend-accept', peer: a.id });
        const listing = (
          await request('state', a.cookie)
        ).data.community.activities.find((s) => s.title === 'Secret listing')!;
        assert.equal(
          (
            await mutate(a, {
              action: 'session-invite',
              sessionId: listing.id,
              peer: e.id,
            })
          ).status,
          403,
        );
        await mutate(a, {
          action: 'channel-invite',
          channel: 'Secret Room',
          peer: e.id,
        });
        assert.equal(
          (
            await mutate(a, {
              action: 'session-invite',
              sessionId: listing.id,
              peer: e.id,
            })
          ).status,
          200,
        );
        assert.ok(
          (await request('state', e.cookie)).data.community.activities.find(
            (s) => s.id === listing.id,
          )?.invited,
        );
        await mutate(a, {
          action: 'channel-ban',
          channel: 'Secret Room',
          peer: e.id,
        });
        assert.ok(
          !(await request('state', e.cookie)).data.community.activities.some(
            (s) => s.id === listing.id,
          ),
        );
      },
    );
    await t.test(
      'stale sends and voice joins cannot race a channel ban',
      async () => {
        await request('channel', b.cookie, { name: 'Secret Room' });
        assert.equal(
          (
            await request('messages', b.cookie, {
              text: 'wrong destination',
              channel: 'The Lobby',
            })
          ).status,
          409,
        );
        let complete: () => void = () => {};
        const pending = new Promise<number>((resolve) => {
          const req = httpRequest(
            base + '/api/voice/join',
            {
              method: 'POST',
              headers: {
                Cookie: b.cookie,
                Origin: config.origin,
                'Content-Type': 'application/json',
              },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode!));
            },
          );
          req.write('{');
          complete = () => req.end('}');
        });
        await new Promise((r) => setTimeout(r, 30));
        await mutate(a, {
          action: 'channel-ban',
          channel: 'Secret Room',
          peer: b.id,
        });
        complete();
        assert.equal(await pending, 409);
        assert.equal(
          (await request('state', b.cookie)).data.me.channel,
          'The Lobby',
        );
      },
    );
    await t.test(
      'friend online alerts are opt-in and DND suppresses them',
      async () => {
        await mutate(a, { action: 'friend-request', peer: e.id });
        await mutate(e, { action: 'friend-accept', peer: a.id });
        await mutate(a, {
          action: 'peer-preferences',
          peer: e.id,
          pinned: true,
          notify: true,
        });
        const observer = await stream(a);
        const first = await stream(e);
        await new Promise((r) => setTimeout(r, 30));
        assert.ok(observer.text().includes('Eve is online.'));
        first.abort.abort();
        await new Promise((r) => setTimeout(r, 40));
        const prior = observer.text().length;
        await mutate(a, { action: 'presence', presence: 'dnd' });
        const second = await stream(e);
        await new Promise((r) => setTimeout(r, 30));
        assert.ok(!observer.text().slice(prior).includes('event: notice'));
        second.abort.abort();
        observer.abort.abort();
        await new Promise((r) => setTimeout(r, 40));
      },
    );
    await t.test(
      'multiple tabs remain online until last connection leaves',
      async () => {
        const first = await stream(e),
          second = await stream(e);
        assert.equal(
          (await request('state', a.cookie)).data.members.find(
            (m: { id: string }) => m.id === e.id,
          )!.online,
          true,
        );
        first.abort.abort();
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(
          (await request('state', a.cookie)).data.members.find(
            (m: { id: string }) => m.id === e.id,
          )!.online,
          true,
        );
        second.abort.abort();
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(
          (await request('state', a.cookie)).data.members.find(
            (m: { id: string }) => m.id === e.id,
          )!.online,
          false,
        );
      },
    );
  } finally {
    for (const s of streams) s.abort();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
