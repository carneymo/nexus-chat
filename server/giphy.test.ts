import { testInvite } from './test-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
void test('GIF configuration requires authentication and honors origin checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-gif-'));
  const app = createApp({
    databasePath: join(dir, 'db.sqlite'),
    staticPath: dir,

    origin: 'https://nexus.test',
    secureCookies: false,
    serverName: 'Test',
    giphyApiKey: 'synthetic-public-key',
  });
  try {
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
    const base =
      'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
    assert.equal((await fetch(base + '/api/gif-config')).status, 401);
    const registration = await fetch(base + '/api/register', {
      method: 'POST',
      headers: {
        Origin: 'https://nexus.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'GifTester',
        password: 'synthetic-password',
        inviteToken: testInvite(app.db),
      }),
    });
    assert.equal(registration.status, 200);
    const cookie = registration.headers.get('set-cookie')!.split(';')[0];
    const config = await fetch(base + '/api/gif-config', {
      headers: { Cookie: cookie, Origin: 'https://nexus.test' },
    });
    assert.deepEqual(await config.json(), { apiKey: 'synthetic-public-key' });
    assert.match(config.headers.get('cache-control') || '', /no-store/);
    assert.equal(
      (
        await fetch(base + '/api/gif-config', {
          headers: { Cookie: cookie, Origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
