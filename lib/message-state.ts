/** Merge delivered pages and snapshots without retaining revoked channel content. */
export type DeliveredMessage = {
  id: number;
  userId: string;
  channel: string;
  recipient: string | null;
};
export function mergeMessages<T extends DeliveredMessage>(
  existing: T[],
  incoming: T[],
  viewerId: string,
  channel: string,
  hidden: Iterable<string> = [],
): T[] {
  const denied = new Set(hidden);
  return [
    ...new Map(
      [...existing, ...incoming]
        .filter(
          (m) =>
            !denied.has(m.userId) &&
            (m.recipient
              ? m.recipient === viewerId || m.userId === viewerId
              : m.channel === channel),
        )
        .map((m) => [m.id, m]),
    ).values(),
  ].sort((a, b) => a.id - b.id);
}

/** A public message from a peer must never advance that peer's DM cursor. */
export function messageCursor(
  messages: DeliveredMessage[],
  viewerId: string,
  scope: { peer?: string; channel?: string },
): number {
  const relevant = messages.filter((m) =>
    scope.peer
      ? Boolean(m.recipient) &&
        ((m.userId === scope.peer && m.recipient === viewerId) ||
          (m.userId === viewerId && m.recipient === scope.peer))
      : !m.recipient && m.channel === scope.channel,
  );
  return Math.max(0, ...relevant.map((m) => m.id));
}
