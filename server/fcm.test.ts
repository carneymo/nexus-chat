import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFcmSender } from './fcm.ts';

void test('FCM signs scoped authorization, caches tokens, and handles unregistered devices', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-fcm-'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const path = join(directory, 'credentials.json');
  writeFileSync(
    path,
    JSON.stringify({
      project_id: 'nexus-test',
      client_email: 'sender@nexus-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  );
  let authorizations = 0;
  let invalid = false;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string, options: RequestInit) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        authorizations++;
        const jwt = (options.body as URLSearchParams).get('assertion')!;
        const [header, claims, signature] = jwt.split('.');
        assert.equal(
          createVerify('RSA-SHA256')
            .update(`${header}.${claims}`)
            .verify(publicKey, signature, 'base64url'),
          true,
        );
        assert.equal(
          JSON.parse(Buffer.from(claims, 'base64url').toString()).scope,
          'https://www.googleapis.com/auth/firebase.messaging',
        );
        return Response.json({
          access_token: 'test-access-token',
          expires_in: 3600,
        });
      }
      assert.equal(
        url,
        'https://fcm.googleapis.com/v1/projects/nexus-test/messages:send',
      );
      assert.equal(
        (options.headers as Record<string, string>).Authorization,
        'Bearer test-access-token',
      );
      const payload = JSON.parse(options.body as string);
      assert.equal(payload.message.android.priority, 'high');
      assert.equal(payload.message.notification, undefined);
      return invalid
        ? Response.json(
            { error: { details: [{ errorCode: 'UNREGISTERED' }] } },
            { status: 404 },
          )
        : Response.json({ name: 'sent' });
    },
  );
  try {
    assert.equal(createFcmSender(), undefined);
    const send = createFcmSender(path)!;
    const payload = {
      token: 'test',
      data: {
        account: 'alice',
        link: '/#peer=bob',
        kind: 'dm',
        messageId: '1',
      },
    };
    assert.equal(await send(payload), 'sent');
    invalid = true;
    assert.equal(await send(payload), 'invalid');
    assert.equal(authorizations, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
