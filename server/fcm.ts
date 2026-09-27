import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import type { PushSender } from './push.ts';

/** Dependency-free HTTP v1 sender. Credentials live only on the server, mounted read-only. */
export function createFcmSender(
  credentialsPath?: string,
): PushSender | undefined {
  if (!credentialsPath) return undefined;
  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
    project_id?: string;
    client_email?: string;
    private_key?: string;
  };
  if (
    !credentials.project_id ||
    !/^[a-z][a-z0-9-]{4,62}$/.test(credentials.project_id) ||
    !credentials.client_email?.endsWith('.iam.gserviceaccount.com') ||
    !credentials.private_key
  )
    throw new Error('Invalid Firebase service-account configuration.');
  let cached: { value: string; expires: number } | undefined;
  async function accessToken() {
    if (cached && cached.expires > Date.now() + 60000) return cached.value;
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(credentials.private_key!, 'base64url');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!response.ok) throw new Error('Firebase authorization failed.');
    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token || !Number.isFinite(data.expires_in))
      throw new Error('Invalid Firebase authorization response.');
    cached = {
      value: data.access_token,
      expires: Date.now() + Number(data.expires_in) * 1000,
    };
    return cached.value;
  }
  return async ({ token, data }) => {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            data,
            android: { priority: 'high', ttl: '86400s' },
          },
        }),
      },
    );
    if (response.ok) return 'sent';
    if (response.status === 401) cached = undefined;
    const error = (await response.json().catch(() => ({}))) as {
      error?: { details?: { errorCode?: string }[] };
    };
    if (
      error.error?.details?.some(
        (detail) => detail.errorCode === 'UNREGISTERED',
      )
    )
      return 'invalid';
    throw new Error(`Firebase delivery failed (${response.status}).`);
  };
}
