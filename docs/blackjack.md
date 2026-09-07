# Blackjack channel

One shared six-player table in the dedicated `Blackjack` channel. Chat and channel voice remain available. This is play-credit entertainment only: no purchases, transfers, prizes, or cash-out.

## Rules

- Six decks, cryptographic Fisher–Yates shuffle. Reshuffle between rounds when fewer than 208 cards remain (a conservative cut point that reserves ample cards for splits).
- Dealer stands on soft 17; checks for natural blackjack before player actions.
- Natural blackjack pays 3:2; ordinary wins 1:1; ties return the stake.
- Double on any initial two cards (including after splitting), one final card.
- Equal-value splits, maximum four hands. Split aces receive one card each, cannot be resplit, and a split 21 is not a natural.
- Bets 10–500 credits, increments of 10. Six bettors per round. No insurance or surrender.
- First wager opens a 20-second betting window; first bettor may deal early. Each decision has 30 seconds, then automatically stands. Existing hand state survives restart; overdue decisions advance on the timer after startup.
- Cancelling or leaving before dealing refunds the wager. Once dealt, leaving, disconnecting or moderation does not refund a hand; the timeout completes play.

## Credits

First entry grants 1,020 credits (initial 1,000 plus today's 20). Each UTC calendar day adds 20, and each Monday at 00:00 UTC adds another 1,000. Missed grants accumulate and are applied on the next Blackjack snapshot/action, using persistent day/week markers. Multiple tabs and reconnects cannot claim twice. With less than the 10-credit minimum, wait for replenishment. Credits belong to the stable account ID, not the display name.

## Architecture and operations

`server/blackjack.ts` owns the shoe, dealer, turns and payouts. Four additive SQLite tables store wallets, ledger entries, table JSON, and action nonces. All actions, debits and settlement occur in one SQLite transaction. Revision checks reject stale simultaneous actions; per-user nonce replay is idempotent. The existing authenticated API and personalized SSE carry table state. Only current authorized Blackjack channel members receive it; the shoe and dealer hole card are never serialized during play. Rate limits and post-body session checks apply. A one-second timer progresses expired turns and broadcasts transitions.

The channel is inserted if absent, but an existing archived channel is not restored automatically. Administrator/channel ACL controls still apply. No separate process, dependency or port. The module initializes its additive tables independently of the core schema version. Back up the complete SQLite database before an authorized deployment. Prefer draining a live round before maintenance; never switch to older code during an active round without a recovery plan for reserved wagers.

## Verification

Automated coverage: six-deck composition, soft totals, 3:2 payout, dealer natural, soft17 stand, double payout, split payout/aces, max hands, insufficient credits and next-day recovery, daily/weekly grants, duplicate nonce, stale revisions, simultaneous HTTP wagers, unauthorized/banned access, hole-card/shoe privacy, pre-deal refund, and persisted timeout settlement after restart. Existing chat/voice tests remain part of the suite.

Local UI: channel discovery, place bet, deal, split, stand, settlement and updated balance verified; desktop and 390px mobile inspected. Physical Android keyboard and six real friends playing together remain device/load checks, not claims made by automated coverage. Co-op adventure is deferred. Production has not been deployed for this feature.

Blackjack audio uses the existing synth infrastructure and Sound setting, with distinct bright card and turn accents, a rising bell-like win chime, and an original descending arcade-style loss phrase. Gateway connection sounds remain unchanged. Initial and repeated snapshots stay silent; hidden tabs suppress playback. Transition classification tests pass. Browser audio still requires a user gesture; final volume/tone preference should be reviewed by listening locally.
