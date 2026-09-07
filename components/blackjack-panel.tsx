'use client';
import { useEffect, useRef, useState } from 'react';
import { cue } from '@/lib/audio';
import { blackjackCue } from '@/lib/blackjack-audio';
type Hand = {
  cards: number[];
  bet: number;
  done: boolean;
  result?: string;
  returned?: number;
};
export type BlackjackState = {
  revision: number;
  phase: 'betting' | 'playing' | 'settled';
  round: number;
  deadline: number;
  balance: number;
  serverNow: number;
  dealer: (number | null)[];
  players: {
    id: string;
    name: string;
    hands: Hand[];
    active: boolean;
    activeHand: number;
  }[];
  firstBettor?: string;
  remainingCards: number;
};
function value(cards: number[]) {
  let total = 0,
    aces = 0;
  for (const c of cards) {
    if (c % 13 === 0) {
      total += 11;
      aces++;
    } else total += Math.min((c % 13) + 1, 10);
  }
  while (total > 21 && aces-- > 0) total -= 10;
  return total;
}
function Cards({ cards }: { cards: (number | null)[] }) {
  return (
    <span className="bj-cards">
      {cards.map((card, i) => (
        <span
          key={i}
          className={
            'bj-card ' +
            (card !== null && [1, 2].includes(Math.floor(card / 13))
              ? 'red'
              : '')
          }
          aria-label={
            card === null
              ? 'Hidden card'
              : `${['Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King'][card % 13]} of ${['spades', 'hearts', 'diamonds', 'clubs'][Math.floor(card / 13)]}`
          }
        >
          {card === null
            ? '◆'
            : `${['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][card % 13]}${['♠', '♥', '♦', '♣'][Math.floor(card / 13)]}`}
        </span>
      ))}
    </span>
  );
}
export function BlackjackPanel({
  table,
  userId,
  refresh,
  sound,
}: {
  table: BlackjackState;
  userId: string;
  refresh: () => Promise<unknown>;
  sound: boolean;
}) {
  const previousTable = useRef<BlackjackState | null>(null);
  useEffect(() => {
    const kind = blackjackCue(previousTable.current, table, userId);
    previousTable.current = table;
    if (kind) cue(kind, sound && document.visibilityState === 'visible');
  }, [table, userId, sound]);
  const [bet, setBet] = useState('20'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const me = table.players.find((p) => p.id === userId),
    hand = me?.hands[me.activeHand],
    turn = me?.active;
  async function act(action: string) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/blackjack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          bet: Number(bet),
          revision: table.revision,
          nonce: crypto.randomUUID(),
        }),
      });
      const result = (await r.json()) as { error?: string };
      if (!r.ok) throw Error(result.error || 'Action failed');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="blackjack-panel" aria-label="Blackjack table">
      <header>
        <strong>♠ Blackjack</strong>
        <span>{table.balance.toLocaleString()} credits</span>
      </header>
      <p className="bj-status">
        {table.phase === 'playing'
          ? 'Cards in play'
          : table.phase === 'settled'
            ? 'Round complete'
            : 'Place your bets'}
        {table.deadline > 0 &&
          ` · ${Math.max(0, Math.min(table.phase === 'betting' ? 20 : 30, Math.ceil((table.deadline - now) / 1000)))}s`}
      </p>
      <div className="bj-table">
        <div className="bj-dealer">
          <strong>Dealer · stands on soft 17</strong>
          <Cards cards={table.dealer} />
          {table.phase === 'settled' && (
            <span>Total {value(table.dealer as number[])}</span>
          )}
        </div>
        <div className="bj-players">
          {table.players.map((p) => (
            <div key={p.id} className={'bj-seat ' + (p.active ? 'active' : '')}>
              <strong>
                {p.name}
                {p.id === userId ? ' (you)' : ''}
              </strong>
              {p.hands.map((h, i) => (
                <div
                  key={i}
                  className={
                    p.active && p.activeHand === i ? 'bj-active-hand' : ''
                  }
                >
                  <Cards cards={h.cards} />
                  <small>
                    Bet {h.bet}
                    {h.cards.length > 0 ? ` · ${value(h.cards)}` : ''}
                    {h.result
                      ? ` · ${h.result} · returned ${h.returned}`
                      : p.active && p.activeHand === i
                        ? p.id === userId
                          ? ' · Your turn'
                          : ' · Playing'
                        : ''}
                  </small>
                </div>
              ))}
            </div>
          ))}
        </div>
        {!table.players.length && (
          <p>
            The table is open. Place a bet to start a 20-second betting window.
          </p>
        )}
      </div>
      <div className="bj-actions">
        {table.phase !== 'playing' && (!me || table.phase === 'settled') && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act('bet');
            }}
          >
            <label>
              Bet{' '}
              <input
                type="number"
                min={10}
                max={Math.min(500, table.balance)}
                step={10}
                value={bet}
                onChange={(e) => setBet(e.target.value)}
                aria-label="Bet credits"
              />
            </label>
            <button disabled={busy || table.balance < 10}>Place bet</button>
          </form>
        )}
        {table.phase === 'betting' && me && (
          <>
            <button disabled={busy} onClick={() => void act('cancel')}>
              Cancel bet
            </button>
            {table.firstBettor === userId && (
              <button disabled={busy} onClick={() => void act('deal')}>
                Deal now
              </button>
            )}
          </>
        )}
        {turn && hand && (
          <>
            {['hit', 'stand', 'double', 'split'].map((action) => (
              <button
                key={action}
                disabled={
                  busy ||
                  (action === 'double' &&
                    (hand.cards.length !== 2 || table.balance < hand.bet)) ||
                  (action === 'split' &&
                    (hand.cards.length !== 2 ||
                      Math.min((hand.cards[0] % 13) + 1, 10) !==
                        Math.min((hand.cards[1] % 13) + 1, 10) ||
                      me.hands.length >= 4 ||
                      table.balance < hand.bet))
                }
                onClick={() => void act(action)}
              >
                {action[0].toUpperCase() + action.slice(1)}
              </button>
            ))}
          </>
        )}
      </div>
      {table.balance < 10 && (
        <p>Your next daily grant adds 20 credits at midnight UTC.</p>
      )}
      {error && <output>{error}</output>}
      <details>
        <summary>Table rules & credits</summary>
        <p>
          Play credits only. Six decks, 3:2 natural blackjack, dealer stands on
          soft 17. Double on your first two cards; double after split allowed.
          Up to four hands. Split aces get one card each; split 21 pays 1:1. No
          insurance or surrender. Bets: 10–500 in steps of 10. Six players.
          Turns expire after 30 seconds and automatically stand.
        </p>
        <p>
          Start with 1,020 credits. Add 20 each day and 1,000 each Monday at
          00:00 UTC. Unused and missed grants accumulate. No purchases,
          transfers, or cash-out. Wagers are committed once dealt; leaving does
          not refund them.
        </p>
      </details>
    </section>
  );
}
