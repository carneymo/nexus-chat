// Total-dependent 4–8 deck S17 strategy, DAS, dealer peek, no surrender.
// Reference: https://wizardofodds.com/games/blackjack/strategy/4-decks/
export function basicStrategy(
  cards: number[],
  dealer: number,
  canDouble: boolean,
  canSplit: boolean,
) {
  const ranks = cards.map((c) =>
    c % 13 === 0 ? 11 : Math.min((c % 13) + 1, 10),
  );
  const up = dealer % 13 === 0 ? 11 : Math.min((dealer % 13) + 1, 10);
  let total = ranks.reduce((a, b) => a + b, 0),
    aces = ranks.filter((r) => r === 11).length;
  while (total > 21 && aces) {
    total -= 10;
    aces--;
  }
  if (canSplit && ranks.length === 2 && ranks[0] === ranks[1]) {
    const pair = ranks[0];
    if (
      pair === 11 ||
      pair === 8 ||
      ((pair === 2 || pair === 3 || pair === 7) && up <= 7) ||
      (pair === 4 && up >= 5 && up <= 6) ||
      (pair === 6 && up <= 6) ||
      (pair === 9 && (up <= 6 || up === 8 || up === 9))
    )
      return 'split';
  }
  const double = (fallback: 'hit' | 'stand') =>
    canDouble ? 'double' : fallback;
  if (aces) {
    if (total >= 19) return 'stand';
    if (total === 18)
      return up >= 3 && up <= 6 ? double('stand') : up <= 8 ? 'stand' : 'hit';
    if (
      (total === 17 && up >= 3 && up <= 6) ||
      ((total === 15 || total === 16) && up >= 4 && up <= 6) ||
      (total <= 14 && up >= 5 && up <= 6)
    )
      return double('hit');
    return 'hit';
  }
  if (total >= 17) return 'stand';
  if (total >= 13) return up <= 6 ? 'stand' : 'hit';
  if (total === 12) return up >= 4 && up <= 6 ? 'stand' : 'hit';
  if (
    (total === 11 && up <= 10) ||
    (total === 10 && up <= 9) ||
    (total === 9 && up >= 3 && up <= 6)
  )
    return double('hit');
  return 'hit';
}
