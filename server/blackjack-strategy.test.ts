import test from 'node:test';
import assert from 'node:assert/strict';
import { basicStrategy } from './blackjack-strategy.ts';
void test('S17 basic strategy distinguishes hard/soft totals, pairs and legal fallbacks', () => {
  assert.equal(basicStrategy([9, 4], 9, true, true), 'hit'); // hard15 v10
  assert.equal(basicStrategy([9, 4], 5, true, true), 'stand');
  assert.equal(basicStrategy([0, 6], 4, true, true), 'double'); // soft18 v5
  assert.equal(basicStrategy([0, 6], 4, false, true), 'stand');
  assert.equal(basicStrategy([0, 7], 5, true, true), 'stand'); // soft19, S17
  assert.equal(basicStrategy([4, 5], 0, true, true), 'hit'); //11 vA, S17
  assert.equal(basicStrategy([4, 5], 9, true, true), 'double');
  assert.equal(basicStrategy([4, 5], 9, false, false), 'hit');
  assert.equal(basicStrategy([7, 20], 9, true, true), 'split');
  assert.equal(basicStrategy([7, 20], 9, true, false), 'hit');
  assert.equal(basicStrategy([3, 16], 4, true, true), 'split'); //4s v5 DAS
  assert.equal(basicStrategy([3, 16], 3, true, true), 'hit');
  assert.equal(basicStrategy([8, 21], 6, true, true), 'stand'); //9s v7
  assert.equal(basicStrategy([8, 21], 7, true, true), 'split');
  assert.equal(basicStrategy([4, 17], 8, true, true), 'double'); //5s never split
});
