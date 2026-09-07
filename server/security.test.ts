import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createApp } from './app.ts';
import {
  bootstrapOwner,
  revokeAccount,
  setRegistration,
  tokenDigest,
} from './security.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { createStore } from './store.ts';

void test('console recovery preserves history and closed registration across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-recovery-'));
  const { fileURLToPath } = await import('node:url');
  async function consoleAction(action: string, password = '') {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../scripts/security-admin.ts', import.meta.url)),
        action,
        'Owner',
      ],
      {
        env: { ...process.env, DATA_DIR: directory },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.stdin.end(password);
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.ok(
      !password || !output.includes(password),
      'Password must not appear in output',
    );
  }
  await consoleAction('bootstrap', 'original-owner-password');
  let db = createStore(join(directory, 'nexus.sqlite'));
  const owner = db.prepare("SELECT id FROM users WHERE name='Owner'").get()!.id;
  db.prepare(
    "INSERT INTO messages(user_id,channel,text,created_at) VALUES(?,'The Lobby','Preserve history',?)",
  ).run(owner, Date.now());
  db.close();
  await consoleAction('suspend');
  await consoleAction('reset-password', 'replacement-owner-password');
  db = createStore(join(directory, 'nexus.sqlite'));
  assert.equal(
    db.prepare('SELECT disabled FROM users WHERE id=?').get(owner)!.disabled,
    1,
  );
  db.close();
  await consoleAction('restore');
  const app = createApp({
    databasePath: join(directory, 'nexus.sqlite'),
    staticPath: directory,
    origin: 'https://nexus.test',
    secureCookies: false,
    serverName: 'Recovery',
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const port = (app.server.address() as { port: number }).port;
  try {
    assert.equal(
      (
        await call(port, '/api/login', {
          name: 'Owner',
          password: 'original-owner-password',
        })
      ).status,
      401,
    );
    const restored = await call(port, '/api/login', {
      name: 'Owner',
      password: 'replacement-owner-password',
    });
    assert.equal(restored.status, 200);
    assert.equal((await call(port, '/api/state')).data.registrationOpen, false);
    assert.equal(
      app.db.prepare('SELECT count(*) AS n FROM messages').get()!.n,
      1,
    );
    await consoleAction('revoke');
    assert.equal(
      (await call(port, '/api/history', undefined, restored.cookie)).status,
      401,
    );
  } finally {
    await app.close();
  }
});

async function fixture(trustedProxyIPs: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-security-'));
  const app = createApp({
    databasePath: ':memory:',
    staticPath: directory,
    origin: 'https://nexus.test',
    secureCookies: false,
    serverName: 'Test',
    trustedProxyIPs,
  });
  await bootstrapOwner(app.db, 'Owner', 'test-owner-password');
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const port = (app.server.address() as { port: number }).port;
  return { app, port, directory };
}
type TestData = {
  registrationOpen?: boolean;
  me: { id: string; handle: string };
};
function call(
  port: number,
  path: string,
  body?: unknown,
  cookie = '',
  localAddress = '127.0.0.1',
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; cookie: string; data: TestData }>(
    (resolve, reject) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          localAddress,
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            ...headers,
          },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () => {
            let data = {};
            try {
              data = JSON.parse(text);
            } catch {
              /* Proxy errors can be plain text. */
            }
            resolve({
              status: response.statusCode!,
              cookie: response.headers['set-cookie']?.[0]?.split(';')[0] || '',
              data: data as TestData,
            });
          });
        },
      );
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    },
  );
}
function invite(app: ReturnType<typeof createApp>) {
  const token = randomBytes(32).toString('hex');
  const owner = app.db
    .prepare("SELECT id FROM users WHERE name='Owner'")
    .get()!.id;
  app.db
    .prepare(
      'INSERT INTO server_invites(id,token_hash,creator,expires) VALUES(?,?,?,?)',
    )
    .run(randomUUID(), tokenDigest(token), owner, Date.now() + 60000);
  return token;
}

void test('malformed targets do not terminate gateway; untrusted headers cannot change identity', async () => {
  const { app, port } = await fixture();
  try {
    for (const path of ['//[', '/%zz', '/%00', '/%5c', '//evil.test/api/state'])
      assert.equal((await call(port, path)).status, 400);
    assert.equal((await call(port, '/api/health')).status, 200);
    for (let n = 0; n < 30; n++)
      assert.equal(
        (
          await call(port, '/api/login', {}, '', '127.0.0.1', {
            'X-Nexus-Client-IP': `192.0.2.${n + 1}`,
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await call(port, '/api/login', {}, '', '127.0.0.1', {
          'X-Nexus-Client-IP': '198.51.100.1',
        })
      ).status,
      429,
    );
  } finally {
    await app.close();
  }
});

void test('closed migration, single-use admission races, membership and emergency revocation', async () => {
  const { app, port } = await fixture();
  try {
    assert.equal((await call(port, '/api/state')).data.registrationOpen, false);
    assert.equal(
      (
        await call(port, '/api/register', {
          name: 'NoEntry',
          password: 'test-password',
          invite: 'any-old-master-code',
        })
      ).status,
      403,
    );
    const owner = await call(port, '/api/login', {
      name: 'Owner',
      password: 'test-owner-password',
    });
    const ownerId = (await call(port, '/api/state', undefined, owner.cookie))
      .data.me.id;
    const change = (body: unknown) =>
      call(port, '/api/admin/security', body, owner.cookie);
    assert.equal(
      (await change({ action: 'registration', open: true, confirm: 'OPEN' }))
        .status,
      200,
    );
    assert.equal(
      (
        await call(port, '/api/register', {
          name: 'Owner',
          password: 'test-password',
          invite: 'any-old-master-code',
        })
      ).status,
      401,
    );
    const shared = invite(app);
    const attempts = await Promise.all(
      ['MemberOne', 'MemberTwo'].map((name) =>
        call(port, '/api/register', {
          name,
          password: 'member-password',
          inviteToken: shared,
        }),
      ),
    );
    assert.deepEqual(
      attempts.map((r) => r.status).sort((a, b) => a - b),
      [200, 401],
    );
    const member = attempts.find((r) => r.status === 200)!;
    const memberState = (
      await call(port, '/api/state', undefined, member.cookie)
    ).data.me;
    const memberId = memberState.id;
    assert.equal(
      (
        await call(
          port,
          '/api/admin/security',
          { action: 'registration', open: false, confirm: 'CLOSE' },
          member.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await change({
          action: 'review',
          target: memberId,
          confirm: memberState.handle,
        })
      ).status,
      200,
    );
    assert.ok(
      app.db
        .prepare('SELECT reviewed_at,invite_id FROM users WHERE id=?')
        .get(memberId)!.invite_id,
    );
    // Schedule changes during scrypt using the real HTTP request callback, after body parsing starts.
    const revokedToken = invite(app);
    const onRegister = (request: { url?: string }) => {
      if (request.url === '/api/register')
        setImmediate(() =>
          app.db
            .prepare('DELETE FROM server_invites WHERE token_hash=?')
            .run(tokenDigest(revokedToken)),
        );
    };
    app.server.on('request', onRegister);
    assert.equal(
      (
        await call(port, '/api/register', {
          name: 'RevokedInvite',
          password: 'member-password',
          inviteToken: revokedToken,
        })
      ).status,
      401,
    );
    app.server.off('request', onRegister);
    const closeToken = invite(app);
    const closeDuringHash = () =>
      setImmediate(() => setRegistration(app.db, false, 'test-console'));
    app.server.once('request', closeDuringHash);
    assert.equal(
      (
        await call(port, '/api/register', {
          name: 'ClosedRace',
          password: 'member-password',
          inviteToken: closeToken,
        })
      ).status,
      403,
    );
    const onLogin = () =>
      setImmediate(() => revokeAccount(app.db, memberId, 'test-console'));
    app.server.once('request', onLogin);
    assert.equal(
      (
        await call(port, '/api/login', {
          name: memberState.handle,
          password: 'member-password',
        })
      ).status,
      401,
    );
    assert.equal(
      (await call(port, '/api/history', undefined, member.cookie)).status,
      401,
    );
    assert.equal(
      (
        await change({
          action: 'suspend',
          target: memberId,
          confirm: memberState.handle,
        })
      ).status,
      200,
    );
    app.db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(memberId);
    assert.equal(
      (
        await call(port, '/api/login', {
          name: memberState.handle,
          password: 'member-password',
        })
      ).status,
      401,
    );
    // Console can contain even the last administrator; bootstrap cannot become a takeover path.
    await assert.rejects(
      bootstrapOwner(app.db, 'NewOwner', 'another-password'),
      /empty server/,
    );
    revokeAccount(app.db, ownerId, 'server-console', true);
    assert.equal(
      (await call(port, '/api/admin/state', undefined, owner.cookie)).status,
      401,
    );
    assert.equal(
      app.db.prepare('SELECT disabled FROM users WHERE id=?').get(ownerId)!
        .disabled,
      1,
    );
  } finally {
    await app.close();
  }
});

void test(
  'real Caddy proxy overwrites spoofed identity and isolates visitors and signed-in traffic',
  { skip: !process.env.CADDY_BIN },
  async () => {
    const { app, port, directory } = await fixture(['127.0.0.1']);
    const reserve = createServer();
    await new Promise<void>((resolve) =>
      reserve.listen(0, '127.0.0.1', resolve),
    );
    const proxyPort = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../Caddyfile', import.meta.url),
      'utf8',
    );
    const configPath = join(directory, 'Caddyfile');
    writeFileSync(
      configPath,
      '{\n admin off\n auto_https off\n}\n' +
        source
          .replace('{$DOMAIN}', `http://127.0.0.1:${proxyPort}`)
          .replace('gateway:3001', `127.0.0.1:${port}`),
    );
    const proxy = spawn(
      process.env.CADDY_BIN!,
      ['run', '--config', configPath, '--adapter', 'caddyfile'],
      { windowsHide: true, stdio: 'ignore' },
    );
    const exit = once(proxy, 'exit');
    try {
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try {
          ready = (await call(proxyPort, '/api/health')).status === 200;
        } catch {
          /* Startup. */
        }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ready, 'Caddy must start');
      assert.equal((await call(proxyPort, '//[')).status, 400);
      assert.equal((await call(proxyPort, '/api/health')).status, 200);
      for (let n = 0; n < 30; n++)
        assert.equal(
          (
            await call(proxyPort, '/api/login', {}, '', '127.0.0.1', {
              'X-Nexus-Client-IP': `192.0.2.${n + 1}`,
              'X-Forwarded-For': `192.0.2.${n + 1}`,
            })
          ).status,
          400,
        );
      assert.equal((await call(proxyPort, '/api/login', {})).status, 429);
      const owner = await call(
        proxyPort,
        '/api/login',
        { name: 'Owner', password: 'test-owner-password' },
        '',
        '127.0.0.2',
      );
      assert.equal(
        owner.status,
        200,
        'A distinct real client must still sign in',
      );
      let status = 0;
      for (let n = 0; n <= 600 && status !== 429; n++)
        status = (await call(proxyPort, '/api/history')).status;
      assert.equal(status, 429);
      assert.equal(
        (await call(proxyPort, '/api/history', undefined, owner.cookie)).status,
        200,
        'Authenticated budget survives anonymous exhaustion',
      );
      assert.equal(
        (await call(port, '/api/health')).status,
        400,
        'Allowlisted proxy must supply identity',
      );
    } finally {
      proxy.kill();
      await exit;
      await app.close();
    }
  },
);
