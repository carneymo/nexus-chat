import { randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { basicStrategy } from './blackjack-strategy.ts';
import {
  emptyBlackjackStats,
  type BlackjackStats,
} from '../lib/blackjack-stats.ts';
export const BLACKJACK_CHANNEL = 'Blackjack';
export type Hand = {
  cards: number[];
  bet: number;
  done: boolean;
  split: boolean;
  result?: string;
  returned?: number;
  offBook?: boolean;
};
type Player = { id: string; hands: Hand[] };
type Table = {
  revision: number;
  phase: 'betting' | 'playing' | 'settled';
  shoe: number[];
  dealer: number[];
  players: Player[];
  turn: number;
  hand: number;
  deadline: number;
  round: number;
  statsVersion?: number;
};
type Dependencies = {
  fail: (status: number, message: string) => never;
  canAccess: (id: string, name: string) => boolean;
  now?: () => number;
  shuffle?: () => number[];
};
export function handValue(cards: number[]) {
  let total = 0,
    aces = 0;
  for (const card of cards) {
    const rank = card % 13;
    if (rank === 0) {
      aces++;
      total += 11;
    } else total += Math.min(rank + 1, 10);
  }
  while (total > 21 && aces) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}
export function sixDeckShoe() {
  const cards = Array.from({ length: 312 }, (_, i) => i % 52);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
export function createBlackjack(db: DatabaseSync, deps: Dependencies) {
  const now = deps.now || Date.now,
    shuffle = deps.shuffle || sixDeckShoe,
    fail: Dependencies['fail'] = deps.fail;
  db.exec(`CREATE TABLE IF NOT EXISTS blackjack_wallets(user_id TEXT PRIMARY KEY REFERENCES users(id),balance INTEGER NOT NULL CHECK(balance>=0),day INTEGER NOT NULL,week INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS blackjack_ledger(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),amount INTEGER NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS blackjack_table(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS blackjack_actions(nonce TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS blackjack_stats(user_id TEXT PRIMARY KEY REFERENCES users(id),stats TEXT NOT NULL);`);
  function stats(id: string): BlackjackStats {
    const row = db
      .prepare('SELECT stats FROM blackjack_stats WHERE user_id=?')
      .get(id);
    return row
      ? { ...emptyBlackjackStats(), ...JSON.parse(String(row.stats)) }
      : emptyBlackjackStats();
  }
  function count(id: string, changes: Partial<BlackjackStats>) {
    const value = stats(id);
    for (const key of Object.keys(changes) as (keyof BlackjackStats)[])
      value[key] += changes[key]!;
    db.prepare(
      'INSERT INTO blackjack_stats VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET stats=excluded.stats',
    ).run(id, JSON.stringify(value));
  }
  db.prepare('INSERT OR IGNORE INTO channels(name) VALUES (?)').run(
    BLACKJACK_CHANNEL,
  );
  const fresh: Table = {
    revision: 0,
    phase: 'betting',
    shoe: [],
    dealer: [],
    players: [],
    turn: 0,
    hand: 0,
    deadline: 0,
    round: 0,
  };
  db.prepare('INSERT OR IGNORE INTO blackjack_table(id,state) VALUES(1,?)').run(
    JSON.stringify(fresh),
  );
  const read = () =>
    JSON.parse(
      String(
        db.prepare('SELECT state FROM blackjack_table WHERE id=1').get()!.state,
      ),
    ) as Table;
  const save = (t: Table) => {
    t.revision++;
    db.prepare('UPDATE blackjack_table SET state=? WHERE id=1').run(
      JSON.stringify(t),
    );
  };
  function transaction<T>(f: () => T) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = f();
      db.exec('COMMIT');
      return value;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  function money(id: string, amount: number, reason: string) {
    const r = db
      .prepare(
        'UPDATE blackjack_wallets SET balance=balance+? WHERE user_id=? AND balance+?>=0',
      )
      .run(amount, id, amount);
    if (!r.changes) fail(409, 'Not enough play credits.');
    db.prepare(
      'INSERT INTO blackjack_ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
    ).run(id, amount, reason, now());
  }
  function wallet(id: string) {
    const day = Math.floor(now() / 86400000),
      week = Math.floor((day + 3) / 7);
    const w = db
      .prepare('SELECT * FROM blackjack_wallets WHERE user_id=?')
      .get(id);
    if (!w) {
      db.prepare('INSERT INTO blackjack_wallets VALUES(?,0,?,?)').run(
        id,
        day,
        week,
      );
      money(id, 1020, 'Initial weekly and daily credits');
    } else {
      const days = Math.max(0, day - Number(w.day)),
        weeks = Math.max(0, week - Number(w.week));
      if (days || weeks) {
        money(
          id,
          days * 20 + weeks * 1000,
          `Scheduled grants: ${days} daily, ${weeks} weekly`,
        );
        db.prepare(
          'UPDATE blackjack_wallets SET day=?,week=? WHERE user_id=?',
        ).run(day, week, id);
      }
    }
    return Number(
      db
        .prepare('SELECT balance FROM blackjack_wallets WHERE user_id=?')
        .get(id)!.balance,
    );
  }
  function allowed(id: string) {
    const u = db
      .prepare('SELECT channel FROM users WHERE id=? AND disabled=0')
      .get(id);
    return (
      u?.channel === BLACKJACK_CHANNEL && deps.canAccess(id, BLACKJACK_CHANNEL)
    );
  }
  function draw(t: Table) {
    const card = t.shoe.pop();
    if (card === undefined) throw Error('Blackjack shoe exhausted');
    return card;
  }
  const natural = (h: Hand) =>
    !h.split && h.cards.length === 2 && handValue(h.cards).total === 21;
  function settle(t: Table) {
    const dealerNatural =
      t.dealer.length === 2 && handValue(t.dealer).total === 21;
    if (
      !dealerNatural &&
      t.players.some((p) =>
        p.hands.some((h) => handValue(h.cards).total <= 21 && !natural(h)),
      )
    )
      while (handValue(t.dealer).total < 17) t.dealer.push(draw(t));
    const dealer = handValue(t.dealer).total;
    for (const p of t.players)
      for (const h of p.hands) {
        const value = handValue(h.cards).total;
        let returned = 0,
          result = 'Lost';
        if (value > 21) result = 'Bust';
        else if (dealerNatural) {
          if (natural(h)) {
            returned = h.bet;
            result = 'Push';
          }
        } else if (natural(h)) {
          returned = h.bet * 2.5;
          result = 'Blackjack · 3:2';
        } else if (dealer > 21 || value > dealer) {
          returned = h.bet * 2;
          result = 'Won';
        } else if (value === dealer) {
          returned = h.bet;
          result = 'Push';
        }
        h.done = true;
        h.result = result;
        h.returned = returned;
        if (returned) money(p.id, returned, `Round ${t.round}: ${result}`);
        if (t.statsVersion === 1)
          count(p.id, {
            won: Number(returned > h.bet),
            lost: Number(returned < h.bet),
            pushes: Number(returned === h.bet),
            naturals: Number(natural(h)),
            offBookHands: Number(!!h.offBook),
            net: returned - h.bet,
          });
      }
    t.phase = 'settled';
    t.deadline = 0;
  }
  function advance(t: Table) {
    while (t.turn < t.players.length) {
      const p = t.players[t.turn];
      while (t.hand < p.hands.length) {
        const h = p.hands[t.hand];
        if (handValue(h.cards).total >= 21) h.done = true;
        if (!h.done) {
          t.deadline = now() + 30000;
          return;
        }
        t.hand++;
      }
      t.turn++;
      t.hand = 0;
    }
    settle(t);
  }
  function deal(t: Table) {
    if (t.phase !== 'betting' || !t.players.length) return;
    for (const p of t.players)
      if (!allowed(p.id)) {
        money(p.id, p.hands[0].bet, 'Wager refunded: left before deal');
        t.players = t.players.filter((x) => x.id !== p.id);
      }
    if (!t.players.length) {
      t.deadline = 0;
      return;
    }
    if (t.shoe.length < 208) t.shoe = shuffle();
    t.round++;
    t.statsVersion = 1;
    for (const p of t.players) count(p.id, { hands: 1 });
    t.dealer = [];
    for (let i = 0; i < 2; i++) {
      for (const p of t.players) p.hands[0].cards.push(draw(t));
      t.dealer.push(draw(t));
    }
    t.phase = 'playing';
    t.turn = 0;
    t.hand = 0;
    if (handValue(t.dealer).total === 21) settle(t);
    else advance(t);
  }
  function tick() {
    const t = read();
    if (!t.deadline || now() < t.deadline) return false;
    return transaction(() => {
      if (t.phase === 'betting') deal(t);
      else if (t.phase === 'playing') {
        if (t.statsVersion === 1) count(t.players[t.turn].id, { timeouts: 1 });
        t.players[t.turn].hands[t.hand].done = true;
        advance(t);
      }
      save(t);
      return true;
    });
  }
  function act(id: string, data: Record<string, unknown>) {
    if (!allowed(id)) fail(403, 'Join Blackjack to play.');
    if (typeof data.nonce !== 'string' || !/^[\w-]{16,80}$/.test(data.nonce))
      fail(400, 'Missing action identifier.');
    return transaction(() => {
      const prior = db
        .prepare('SELECT user_id FROM blackjack_actions WHERE nonce=?')
        .get(data.nonce as string);
      if (prior) {
        if (prior.user_id !== id) fail(409, 'Action identifier already used.');
        return;
      }
      const t = read();
      if (data.revision !== t.revision)
        fail(409, 'The table changed. Try again.');
      if (t.deadline && now() >= t.deadline)
        fail(409, 'The turn has expired. Wait for the table to update.');
      wallet(id);
      if (data.action === 'bet') {
        if (t.phase === 'playing') fail(409, 'Wait for the next round.');
        const bet = Number(data.bet);
        if (!Number.isInteger(bet) || bet < 10 || bet > 500 || bet % 10)
          fail(400, 'Bet 10–500 credits in increments of 10.');
        if (t.phase === 'settled') {
          t.phase = 'betting';
          t.players = [];
          t.dealer = [];
          t.turn = 0;
          t.hand = 0;
        }
        if (t.players.some((p) => p.id === id))
          fail(409, 'You already placed a bet.');
        if (t.players.length >= 6) fail(409, 'The table is full.');
        money(id, -bet, `Wager for round ${t.round + 1}`);
        t.players.push({
          id,
          hands: [{ cards: [], bet, done: false, split: false }],
        });
        if (!t.deadline) t.deadline = now() + 20000;
      } else if (data.action === 'cancel') {
        if (t.phase !== 'betting') fail(409, 'Cards already dealt.');
        const p = t.players.find((p) => p.id === id);
        if (!p) fail(409, 'No wager to cancel.');
        money(id, p.hands[0].bet, 'Wager cancelled');
        t.players = t.players.filter((p) => p.id !== id);
        if (!t.players.length) t.deadline = 0;
      } else if (data.action === 'deal') {
        if (t.phase !== 'betting' || t.players[0]?.id !== id)
          fail(403, 'The first bettor can deal early.');
        deal(t);
      } else {
        if (t.phase !== 'playing' || t.players[t.turn]?.id !== id)
          fail(409, 'It is not your turn.');
        const p = t.players[t.turn],
          h = p.hands[t.hand];
        if (h.done) fail(409, 'Hand complete.');
        const beforeValue = handValue(h.cards);
        const available =
          Number(
            db
              .prepare('SELECT balance FROM blackjack_wallets WHERE user_id=?')
              .get(id)!.balance,
          ) >= h.bet;
        const recommended = basicStrategy(
          h.cards,
          t.dealer[0],
          h.cards.length === 2 && available,
          p.hands.length < 4 && available,
        );
        // Count only successful deliberate actions; the transaction rolls back
        // this update together with any rejected double/split or card draw.
        if (t.statsVersion === 1) {
          const deviation = data.action !== recommended;
          if (deviation) h.offBook = true;
          count(id, {
            decisions: 1,
            deviations: Number(deviation),
            doubles: Number(data.action === 'double'),
            hard15Doubles: Number(
              data.action === 'double' &&
                beforeValue.total === 15 &&
                !beforeValue.soft,
            ),
            splits: Number(data.action === 'split'),
            hands: Number(data.action === 'split'),
          });
        }
        if (data.action === 'hit') h.cards.push(draw(t));
        else if (data.action === 'stand') h.done = true;
        else if (data.action === 'double') {
          if (h.cards.length !== 2)
            fail(400, 'Double only on your first two cards.');
          money(id, -h.bet, `Double round ${t.round}`);
          h.bet *= 2;
          h.cards.push(draw(t));
          h.done = true;
        } else if (data.action === 'split') {
          if (
            h.cards.length !== 2 ||
            Math.min((h.cards[0] % 13) + 1, 10) !==
              Math.min((h.cards[1] % 13) + 1, 10) ||
            p.hands.length >= 4
          )
            fail(400, 'Split equal-value pairs, up to four hands.');
          money(id, -h.bet, `Split round ${t.round}`);
          const ace = h.cards[0] % 13 === 0;
          const second: Hand = {
            cards: [h.cards.pop()!, draw(t)],
            bet: h.bet,
            done: ace,
            split: true,
          };
          h.cards.push(draw(t));
          h.split = true;
          h.done = ace;
          p.hands.splice(t.hand + 1, 0, second);
        } else fail(400, 'Unknown blackjack action.');
        advance(t);
      }
      save(t);
      db.prepare('INSERT INTO blackjack_actions VALUES(?,?,?)').run(
        data.nonce as string,
        id,
        now(),
      );
    });
  }
  function snapshot(id: string) {
    if (!allowed(id)) return undefined;
    const balance = transaction(() => wallet(id));
    const t = read();
    return {
      revision: t.revision,
      phase: t.phase,
      round: t.round,
      deadline: t.deadline,
      balance,
      leaderboard: db
        .prepare(
          'SELECT w.*, COALESCE(u.display_name,u.name) AS name FROM blackjack_wallets w JOIN users u ON u.id=w.user_id WHERE u.disabled=0',
        )
        .all()
        .filter((w) => deps.canAccess(String(w.user_id), BLACKJACK_CHANNEL))
        .map((w) => ({
          id: String(w.user_id),
          name: String(w.name),
          credits:
            Number(w.balance) +
            Math.max(0, Math.floor(now() / 86400000) - Number(w.day)) * 20 +
            Math.max(
              0,
              Math.floor((Math.floor(now() / 86400000) + 3) / 7) -
                Number(w.week),
            ) *
              1000 +
            (t.phase === 'settled'
              ? 0
              : t.players
                  .find((p) => p.id === w.user_id)
                  ?.hands.reduce((sum, h) => sum + h.bet, 0) || 0),
          stats: stats(String(w.user_id)),
        }))
        .sort((a, b) => b.credits - a.credits || a.id.localeCompare(b.id)),
      serverNow: now(),
      dealer: t.phase === 'playing' ? [t.dealer[0], null] : t.dealer,
      players: t.players.map((p, i) => ({
        ...p,
        name: String(
          db
            .prepare(
              'SELECT COALESCE(display_name,name) AS name FROM users WHERE id=?',
            )
            .get(p.id)?.name || 'Former player',
        ),
        active: t.phase === 'playing' && i === t.turn,
        activeHand: t.hand,
      })),
      firstBettor: t.players[0]?.id,
      remainingCards: t.shoe.length,
    };
  }
  return { act, snapshot, tick };
}
