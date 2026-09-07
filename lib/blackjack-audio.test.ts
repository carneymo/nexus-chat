import test from 'node:test';
import assert from 'node:assert/strict';
import { blackjackCue } from './blackjack-audio.ts';
const table = (revision: number, phase = 'playing', returned?: number) => ({
  revision,
  round: 1,
  phase,
  players: [
    {
      id: 'me',
      active: phase === 'playing',
      activeHand: 0,
      hands: [{ cards: [5, 6], bet: 20, returned }],
    },
  ],
});
void test('blackjack sounds ignore initial/repeated snapshots and classify personal outcomes', () => {
  assert.equal(blackjackCue(null, table(1), 'me'), null);
  assert.equal(blackjackCue(table(1), table(1), 'me'), null);
  assert.equal(blackjackCue(table(1), table(2, 'settled', 40), 'me'), 'win');
  assert.equal(blackjackCue(table(1), table(2, 'settled', 0), 'me'), 'loss');
  assert.equal(blackjackCue(table(1), table(2, 'settled', 20), 'me'), 'push');
  assert.equal(
    blackjackCue(table(1), table(2, 'settled', 40), 'spectator'),
    null,
  );
  assert.equal(
    blackjackCue(table(2, 'settled', 40), table(3, 'settled', 40), 'me'),
    null,
  );
});
void test('blackjack sounds identify cards, turn changes and wagers', () => {
  const before = table(1),
    after = table(2);
  after.players[0].hands[0].cards.push(2);
  assert.equal(blackjackCue(before, after, 'me'), 'deal');
  before.players[0].active = false;
  assert.equal(blackjackCue(before, after, 'me'), 'turn');
  assert.equal(
    blackjackCue(
      { ...before, players: [] },
      {
        ...after,
        phase: 'betting',
        players: [
          {
            ...after.players[0],
            active: false,
            hands: [{ cards: [], bet: 20, returned: undefined }],
          },
        ],
      },
      'me',
    ),
    'chips',
  );
});
