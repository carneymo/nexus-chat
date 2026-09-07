'use client';
import type { BlackjackLeader } from '@/lib/blackjack-stats';

export function BlackjackLeaderboard({
  players,
}: {
  players: BlackjackLeader[];
}) {
  return (
    <section className="bj-leaderboard" aria-label="Blackjack leaderboard">
      <h3>♠ Credit leaders</h3>
      <p>Choose a player for stats.</p>
      {players.length === 0 && <p>No players yet. Place the first bet.</p>}
      {players.map((player, index) => {
        const s = player.stats,
          completed = s.won + s.lost + s.pushes;
        const rank = players.findIndex((p) => p.credits === player.credits) + 1;
        return (
          <details key={player.id}>
            <summary>
              <span className="bj-rank">{index === 0 ? '♛' : rank}</span>
              <span className="bj-leader-name">{player.name}</span>
              <strong>{player.credits.toLocaleString()}</strong>
            </summary>
            <dl>
              {(
                [
                  ['Hands dealt', s.hands],
                  ['Won', s.won],
                  ['Lost', s.lost],
                  ['Pushed', s.pushes],
                  [
                    'Win rate',
                    completed
                      ? `${Math.round((s.won / completed) * 100)}%`
                      : '—',
                  ],
                  ['Blackjacks', s.naturals],
                  ['Net winnings', s.net.toLocaleString()],
                  ['Hands against the book', s.offBookHands],
                  ['Off-book decisions', `${s.deviations} / ${s.decisions}`],
                  ['Doubles', s.doubles],
                  ['Hard 15 doubles', s.hard15Doubles],
                  ['Splits', s.splits],
                  ['Timeout stands', s.timeouts],
                ] as [string, number | string][]
              ).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        );
      })}
      <details className="bj-stat-notes">
        <summary>About these stats</summary>
        <p>
          Credits include outstanding bets and earned daily/weekly grants. Ties
          share a rank. Net winnings exclude grants.
        </p>
        <p>
          Stats start with rounds dealt after this update. Splits create another
          hand; wins and losses count when settled. Win rate includes pushes.
        </p>
        <p>
          Against the book compares choices with six-deck basic strategy: dealer
          stands on soft 17, double after split, no surrender. Unaffordable
          moves and split limits are respected. Timeout stands are not judged.
          This is a strategy comparison, not a prediction of who will win.
        </p>
      </details>
    </section>
  );
}
