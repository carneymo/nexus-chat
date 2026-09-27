import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileSendIntent, acknowledgeMobileSend } from './mobile-send.ts';

void test('mobile retries preserve nonce across process-like reloads without storing message text', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const first = await mobileSendIntent(storage, 'alice', 'private message');
  assert.equal(
    (await mobileSendIntent(storage, 'alice', 'private message')).nonce,
    first.nonce,
  );
  assert.notEqual(
    (await mobileSendIntent(storage, 'bob', 'private message')).nonce,
    first.nonce,
  );
  assert.notEqual(
    (await mobileSendIntent(storage, 'alice', 'different')).nonce,
    first.nonce,
  );
  assert.equal(
    [...values.values()].join('').includes('private message'),
    false,
  );
  storage.setItem('draft', 'private message');
  acknowledgeMobileSend(storage, 'alice', first.nonce, 'draft');
  assert.equal(storage.getItem('draft'), null);
  assert.notEqual(
    (await mobileSendIntent(storage, 'alice', 'private message')).nonce,
    first.nonce,
  );
});
