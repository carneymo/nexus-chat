import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationLink } from './mobile.ts';

void test('conversation links decode channels and bind notification links to their account', () => {
  assert.deepEqual(parseConversationLink('#channel=The+Lobby&account=alice'), {
    kind: 'channel',
    value: 'The Lobby',
    account: 'alice',
  });
  assert.deepEqual(parseConversationLink('#peer=bob'), {
    kind: 'peer',
    value: 'bob',
    account: undefined,
  });
  for (const hash of [
    '#peer=a&channel=x',
    '#peer=a&peer=b',
    '#peer=javascript:alert(1)',
    '#channel=%0a',
    '#invite=bad',
    '#peer=a&redirect=evil',
  ])
    assert.equal(parseConversationLink(hash), null, hash);
});
