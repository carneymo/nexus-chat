import { testInvite } from './test-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { createBlackjack, handValue, sixDeckShoe } from './blackjack.ts';
void test('stats persist exactly once, respect access, and rank total credits fairly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-bj-stats-'));
  const db = createStore(join(dir, 'test.sqlite'));
  let clock = Date.UTC(2026, 8, 6, 12),
    allowed = true,
    nonce = 0;
  const deps = {
    now: () => clock,
    canAccess: () => allowed,
    fail: (_: number, message: string): never => {
      throw Error(message);
    },
  };
  let game = createBlackjack(db, deps);
  const act = (action: string) => {
    const data = {
      action,
      bet: 20,
      revision: game.snapshot('a')!.revision,
      nonce: `stats-action-${String(++nonce).padStart(16, '0')}`,
    };
    game.act('a', data);
    game.act('a', data);
  };
  const arrange = (cards: number[]) => {
    const t = JSON.parse(
      String(db.prepare('SELECT state FROM blackjack_table').get()!.state),
    );
    t.shoe = [...Array(250).fill(9), ...cards.reverse()];
    db.prepare('UPDATE blackjack_table SET state=?').run(JSON.stringify(t));
  };
  const mine = () => game.snapshot('a')!.leaderboard.find((p) => p.id === 'a')!;
  try {
    for (const id of ['a', 'b'])
      db.prepare(
        "INSERT INTO users(id,name,salt,password_hash,channel) VALUES(?,?, 'salt','hash','Blackjack')",
      ).run(id, id);
    game.snapshot('b');
    act('bet');
    assert.equal(mine().credits, 1020); // stake remains in ranking
    act('cancel');
    assert.equal(mine().stats.hands, 0);
    act('bet');
    arrange([9, 9, 4, 7, 5]);
    act('deal'); //hard15 v18, double draws6 ->21
    act('double');
    assert.deepEqual(mine().stats, {
      hands: 1,
      won: 1,
      lost: 0,
      pushes: 0,
      naturals: 0,
      decisions: 1,
      deviations: 1,
      offBookHands: 1,
      doubles: 1,
      hard15Doubles: 1,
      splits: 0,
      timeouts: 0,
      net: 40,
    });
    assert.equal(mine().credits, 1060);
    game = createBlackjack(db, deps);
    assert.equal(mine().stats.hard15Doubles, 1);
    assert.equal(game.tick(), false);
    act('bet');
    arrange([9, 9, 7, 7]);
    act('deal'); //18 v18 timeout push
    clock += 31000;
    game.tick();
    game.tick();
    assert.equal(mine().stats.timeouts, 1);
    assert.equal(mine().stats.pushes, 1);
    assert.equal(mine().stats.decisions, 1);
    act('bet');
    arrange([7, 9, 20, 7, 9, 9]);
    act('deal');
    act('split');
    act('stand');
    act('stand');
    assert.equal(mine().stats.hands, 4);
    assert.equal(mine().stats.splits, 1);
    assert.equal(mine().stats.pushes, 3);
    clock += 86400000; //Monday: same grants for offline b and active a
    assert.equal(
      game.snapshot('a')!.leaderboard.find((p) => p.id === 'b')!.credits,
      2040,
    );
    assert.equal(mine().stats.net, 40);
    db.prepare("UPDATE users SET disabled=1 WHERE id='b'").run();
    assert.equal(game.snapshot('a')!.leaderboard.length, 1);
    allowed = false;
    assert.equal(game.snapshot('a'), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
void test('six-deck shoe and soft/hard hand totals', () => {
  const shoe = sixDeckShoe();
  assert.equal(shoe.length, 312);
  for (let card = 0; card < 52; card++)
    assert.equal(shoe.filter((c) => c === card).length, 6);
  assert.deepEqual(handValue([0, 5]), { total: 17, soft: true });
  assert.deepEqual(handValue([0, 5, 12]), { total: 17, soft: false });
  assert.equal(handValue([0, 13, 9]).total, 12);
});
void test('blackjack ledger, rules, hidden cards and restart persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-blackjack-'));
  let db = createStore(join(dir, 'test.sqlite'));
  let clock = Date.UTC(2026, 8, 6, 12);
  let access = true;
  const deps = {
    now: () => clock,
    canAccess: () => access,
    fail: (status: number, message: string): never => {
      throw new Error(status + ': ' + message);
    },
    shuffle: () => Array(312).fill(9) as number[],
  };
  let game = createBlackjack(db, deps);
  for (const id of ['alice', 'bob'])
    db.prepare(
      "INSERT INTO users(id,name,salt,password_hash,channel) VALUES(?,?, 'salt','hash','Blackjack')",
    ).run(id, id);
  let nonce = 0;
  const act = (id: string, action: string, bet = 20) =>
    game.act(id, {
      action,
      bet,
      revision: game.snapshot(id)!.revision,
      nonce: 'test-nonce-' + String(++nonce).padStart(16, '0'),
    });
  const arrange = (cards: number[]) => {
    const row = db.prepare('SELECT state FROM blackjack_table').get()!;
    const state = JSON.parse(String(row.state));
    state.shoe = [...Array(250).fill(9), ...cards.reverse()];
    db.prepare('UPDATE blackjack_table SET state=?').run(JSON.stringify(state));
  };
  try {
    assert.equal(game.snapshot('alice')!.balance, 1020);
    assert.equal(game.snapshot('alice')!.balance, 1020);
    clock += 86400000;
    assert.equal(game.snapshot('alice')!.balance, 2040); // Monday daily + weekly
    clock += 86400000;
    assert.equal(game.snapshot('alice')!.balance, 2060);
    const data = {
      action: 'bet',
      bet: 20,
      revision: game.snapshot('alice')!.revision,
      nonce: 'exactly-once-123456789',
    };
    game.act('alice', data);
    game.act('alice', data);
    assert.equal(game.snapshot('alice')!.balance, 2040);
    assert.throws(() => game.act('bob', data), /identifier already used/);
    assert.throws(
      () =>
        game.act('alice', {
          action: 'cancel',
          revision: -1,
          nonce: 'stale-revision-12345',
        }),
      /table changed/,
    );
    act('alice', 'cancel');
    assert.equal(game.snapshot('alice')!.balance, 2060);
    // player blackjack versus dealer 19: stake20, returned50
    act('alice', 'bet');
    arrange([0, 9, 12, 8]);
    act('alice', 'deal');
    assert.equal(game.snapshot('alice')!.balance, 2090);
    assert.equal(
      game.snapshot('alice')!.players[0].hands[0].result,
      'Blackjack · 3:2',
    );
    // soft17 must stand; player18 wins
    act('alice', 'bet');
    arrange([9, 0, 7, 5]);
    act('alice', 'deal');
    assert.deepEqual(game.snapshot('alice')!.dealer, [0, null]);
    assert.equal(
      JSON.stringify(game.snapshot('alice')).includes('"shoe"'),
      false,
    );
    act('alice', 'stand');
    assert.deepEqual(game.snapshot('alice')!.dealer, [0, 5]);
    assert.equal(game.snapshot('alice')!.balance, 2110);
    // double: eleven ->21 versus dealer17
    act('alice', 'bet');
    arrange([4, 9, 5, 6, 9]);
    act('alice', 'deal');
    act('alice', 'double');
    assert.equal(game.snapshot('alice')!.balance, 2150);
    // two split eights; both stand at18 versus17
    act('alice', 'bet');
    arrange([7, 9, 20, 6, 9, 9]);
    act('alice', 'deal');
    act('alice', 'split');
    assert.equal(game.snapshot('alice')!.players[0].hands.length, 2);
    act('alice', 'stand');
    act('alice', 'stand');
    assert.equal(game.snapshot('alice')!.balance, 2190);
    // split aces receive one card, 21 pays ordinary win
    act('alice', 'bet');
    arrange([0, 9, 13, 6, 9, 9]);
    act('alice', 'deal');
    act('alice', 'split');
    assert.equal(game.snapshot('alice')!.phase, 'settled');
    assert.equal(game.snapshot('alice')!.balance, 2230);
    // opening dealer blackjack settles immediately
    act('alice', 'bet');
    arrange([9, 0, 8, 12]);
    act('alice', 'deal');
    assert.equal(game.snapshot('alice')!.balance, 2210);
    // invalid bets cannot debit
    assert.throws(() => act('alice', 'bet', 15), /increments/);
    assert.equal(game.snapshot('alice')!.balance, 2210);
    // persisted hand recovers and timeout stands exactly once
    act('alice', 'bet');
    arrange([9, 9, 7, 6]);
    act('alice', 'deal');
    db.close();
    db = createStore(join(dir, 'test.sqlite'));
    game = createBlackjack(db, deps);
    assert.equal(game.snapshot('alice')!.phase, 'playing');
    clock += 31000;
    assert.equal(game.tick(), true);
    assert.equal(game.tick(), false);
    assert.equal(game.snapshot('alice')!.balance, 2230);
    access = false;
    assert.equal(game.snapshot('alice'), undefined);
    assert.throws(() => act('alice', 'bet'), /revision|Join Blackjack/);
    access = true;
    // cancel/refund if player leaves before deal
    act('alice', 'bet');
    db.prepare("UPDATE users SET channel='The Lobby' WHERE id='alice'").run();
    clock += 21000;
    game.tick();
    db.prepare("UPDATE users SET channel='Blackjack' WHERE id='alice'").run();
    assert.equal(game.snapshot('alice')!.balance, 2230);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('HTTP blackjack authorizes channel access and serializes simultaneous wagers', async () => {
  const { createApp } = await import('./app.ts');
  const dir = mkdtempSync(join(tmpdir(), 'nexus-bj-http-'));
  const app = createApp({
    databasePath: join(dir, 'test.sqlite'),
    staticPath: dir,

    origin: 'https://nexus.test',
    secureCookies: false,
    serverName: 'Test',
  });
  try {
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
    const base =
      'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
    const post = (path: string, cookie: string, data: unknown) =>
      fetch(base + '/api/' + path, {
        method: 'POST',
        headers: {
          Origin: 'https://nexus.test',
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });
    const register = async (name: string) => {
      const r = await post('register', '', {
        name,
        password: 'test-password-long',
        inviteToken: testInvite(app.db),
      });
      assert.equal(r.status, 200);
      return r.headers.get('set-cookie')!.split(';')[0];
    };
    const alice = await register('Alice'),
      bob = await register('Bob');
    const state = async (cookie: string) =>
      (await (
        await fetch(base + '/api/state', { headers: { Cookie: cookie } })
      ).json()) as {
        me: { id: string };
        blackjack?: { revision: number; balance: number; players: unknown[] };
      };
    assert.equal((await post('blackjack', '', { action: 'bet' })).status, 401);
    assert.equal(
      (
        await post('blackjack', alice, {
          action: 'bet',
          nonce: 'outside-room-123456',
        })
      ).status,
      403,
    );
    for (const cookie of [alice, bob])
      assert.equal(
        (
          await post('channel', cookie, {
            name: 'Blackjack',
            existingOnly: true,
          })
        ).status,
        200,
      );
    const initial = await state(alice);
    const request = {
      action: 'bet',
      bet: 20,
      revision: initial.blackjack!.revision,
    };
    const replies = await Promise.all([
      post('blackjack', alice, { ...request, nonce: 'race-alice-123456789' }),
      post('blackjack', bob, { ...request, nonce: 'race-bob-1234567890' }),
    ]);
    assert.deepEqual(
      replies.map((r) => r.status).sort((a, b) => a - b),
      [200, 409],
    );
    const after = await state(alice);
    assert.equal(after.blackjack!.players.length, 1);
    const winner = replies[0].status === 200 ? alice : bob;
    const nonce =
      winner === alice ? 'race-alice-123456789' : 'race-bob-1234567890';
    assert.equal(
      (await post('blackjack', winner, { ...request, nonce })).status,
      200,
    );
    assert.equal((await state(winner)).blackjack!.balance, 1000);
    assert.equal(
      (await post('channel', bob, { name: 'The Lobby', existingOnly: true }))
        .status,
      200,
    );
    assert.equal((await state(bob)).blackjack, undefined);
    const aliceId = (await state(alice)).me.id;
    app.db
      .prepare(
        'INSERT INTO channel_bans(channel,user_id,actor,reason,created_at) VALUES(?,?,?,?,?)',
      )
      .run('Blackjack', aliceId, aliceId, 'test', Date.now());
    assert.equal((await state(alice)).blackjack, undefined);
    assert.equal(
      (
        await post('blackjack', alice, {
          action: 'bet',
          nonce: 'banned-request-12345',
        })
      ).status,
      403,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('turn ownership, insufficient credits, split limit and exactly-once daily recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-bj-limits-'));
  const db = createStore(join(dir, 'db.sqlite'));
  let now = Date.UTC(2026, 8, 8, 12);
  const game = createBlackjack(db, {
    now: () => now,
    canAccess: () => true,
    fail: (s, m): never => {
      throw Error(s + ': ' + m);
    },
  });
  for (const id of ['a', 'b'])
    db.prepare(
      "INSERT INTO users(id,name,salt,password_hash,channel) VALUES(?,?,'x','x','Blackjack')",
    ).run(id, id);
  let n = 0;
  const act = (id: string, action: string) =>
    game.act(id, {
      action,
      bet: 20,
      revision: game.snapshot(id)!.revision,
      nonce: 'limits-' + String(++n).padStart(20, '0'),
    });
  try {
    game.snapshot('a');
    game.snapshot('b');
    db.prepare(
      "UPDATE blackjack_wallets SET balance=0 WHERE user_id='a'",
    ).run();
    assert.throws(() => act('a', 'bet'), /Not enough/);
    assert.equal(game.snapshot('a')!.balance, 0);
    now += 86400000;
    assert.equal(game.snapshot('a')!.balance, 20);
    assert.equal(game.snapshot('a')!.balance, 20);
    act('a', 'bet');
    act('b', 'bet');
    const t = JSON.parse(
      String(db.prepare('SELECT state FROM blackjack_table').get()!.state),
    );
    t.shoe = [
      ...Array(250).fill(4),
      ...[7, 4, 9, 20, 5, 6, 7, 7, 7, 7, 7, 7, 9].reverse(),
    ];
    db.prepare('UPDATE blackjack_table SET state=?').run(JSON.stringify(t));
    act('a', 'deal');
    assert.throws(() => act('b', 'hit'), /not your turn/);
    assert.throws(() => act('a', 'double'), /Not enough/);
    assert.throws(() => act('a', 'split'), /Not enough/);
    assert.equal(game.snapshot('a')!.balance, 0);
    db.prepare(
      "UPDATE blackjack_wallets SET balance=100 WHERE user_id='a'",
    ).run();
    act('a', 'split');
    act('a', 'split');
    act('a', 'split');
    assert.equal(game.snapshot('a')!.players[0].hands.length, 4);
    assert.throws(() => act('a', 'split'), /four hands/);
    act('a', 'hit');
    if (game.snapshot('a')!.players[0].active) {
      const h =
        game.snapshot('a')!.players[0].hands[
          game.snapshot('a')!.players[0].activeHand
        ];
      if (h.cards.length > 2)
        assert.throws(() => act('a', 'double'), /first two/);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
