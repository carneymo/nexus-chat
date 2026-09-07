import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, messageCursor } from './message-state.ts';
void test('overlapping catchup pages deduplicate and preserve authorized chronological history', () => {
  const message = (id: number) => ({
    id,
    userId: 'friend',
    channel: 'Lobby',
    recipient: null,
    text: 'old',
  });
  const merged = mergeMessages(
    [message(2), message(1)],
    [{ ...message(2), text: 'new' }, message(3)],
    'me',
    'Lobby',
  );
  assert.deepEqual(
    merged.map((m) => m.id),
    [1, 2, 3],
  );
  assert.equal(merged[1].text, 'new');
});
void test('channel changes, unrelated DMs, and hidden senders cannot enter the displayed cache', () => {
  const prior = [
    { id: 1, userId: 'friend', channel: 'Private', recipient: null },
    { id: 2, userId: 'friend', channel: '', recipient: 'me' },
    { id: 3, userId: 'stranger', channel: '', recipient: 'other' },
  ];
  assert.deepEqual(
    mergeMessages(prior, [], 'me', 'Lobby').map((m) => m.id),
    [2],
  );
  assert.deepEqual(mergeMessages(prior, [], 'me', 'Lobby', ['friend']), []);
  assert.deepEqual(mergeMessages(prior, [], 'new-account', 'Lobby'), []);
});

void test('DM catchup cursors ignore newer public messages from the same person', () => {
  const messages = [
    { id: 5, userId: 'friend', channel: '', recipient: 'me' },
    { id: 999, userId: 'friend', channel: 'Lobby', recipient: null },
  ];
  assert.equal(messageCursor(messages, 'me', { peer: 'friend' }), 5);
  assert.equal(messageCursor(messages, 'me', { channel: 'Lobby' }), 999);
});
