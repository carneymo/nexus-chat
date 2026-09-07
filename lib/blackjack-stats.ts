export type BlackjackStats = {
  hands: number;
  won: number;
  lost: number;
  pushes: number;
  naturals: number;
  decisions: number;
  deviations: number;
  offBookHands: number;
  doubles: number;
  hard15Doubles: number;
  splits: number;
  timeouts: number;
  net: number;
};
export const emptyBlackjackStats = (): BlackjackStats => ({
  hands: 0,
  won: 0,
  lost: 0,
  pushes: 0,
  naturals: 0,
  decisions: 0,
  deviations: 0,
  offBookHands: 0,
  doubles: 0,
  hard15Doubles: 0,
  splits: 0,
  timeouts: 0,
  net: 0,
});
export type BlackjackLeader = {
  id: string;
  name: string;
  credits: number;
  stats: BlackjackStats;
};
