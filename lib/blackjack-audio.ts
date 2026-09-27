import type { SoundCue } from './audio';

/** Follow actual card completion, including reduced motion, instead of guessing a delay. */
export function afterCardReveals(
  animations: Pick<Animation, 'finished'>[],
  play: () => void,
  frames = {
    request: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    cancel: (id: number) => cancelAnimationFrame(id),
  },
) {
  let cancelled = false;
  let frame: number | undefined;
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (cancelled) return;
    frame = frames.request(() => {
      if (!cancelled) play();
    });
  });
  return () => {
    cancelled = true;
    if (frame !== undefined) frames.cancel(frame);
  };
}
type Table = {
  revision: number;
  round: number;
  phase: string;
  players: {
    id: string;
    active: boolean;
    activeHand: number;
    hands: { cards: number[]; bet: number; returned?: number }[];
  }[];
};
/** One cue per authoritative transition; snapshots/reloads never replay results. */
export function blackjackCue(
  previous: Table | null,
  next: Table,
  userId: string,
): SoundCue | null {
  if (!previous || next.revision <= previous.revision) return null;
  const me = next.players.find((p) => p.id === userId),
    before = previous.players.find((p) => p.id === userId);
  if (
    next.phase === 'settled' &&
    (previous.phase !== 'settled' || previous.round !== next.round)
  ) {
    if (!me) return null;
    const net = me.hands.reduce((sum, h) => sum + (h.returned || 0) - h.bet, 0);
    return net > 0 ? 'win' : net < 0 ? 'loss' : 'push';
  }
  if (
    me?.active &&
    (!before?.active ||
      me.activeHand !== before.activeHand ||
      next.round !== previous.round)
  )
    return 'turn';
  const cards = (t: Table) =>
    t.players.reduce(
      (sum, p) => sum + p.hands.reduce((n, h) => n + h.cards.length, 0),
      0,
    );
  if (cards(next) > cards(previous)) return 'deal';
  if (next.players.length > previous.players.length) return 'chips';
  if (
    me &&
    before &&
    me.hands.reduce((sum, h) => sum + h.bet, 0) >
      before.hands.reduce((sum, h) => sum + h.bet, 0)
  )
    return 'chips';
  return null;
}
