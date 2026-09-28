# Release announcements

Routine deployments are quiet. Do not announce bug fixes, layout tuning, maintenance, or each commit. Record those changes in Git and the deployment record.

After a verified production deployment containing a major version update or significant user-facing feature, post one concise announcement in the public Releases channel only. Never broadcast releases to The Lobby, Blackjack, other channels, or private messages. Batch related improvements into one useful summary; include a refresh/reopen reminder when needed.

Use `node scripts/announce-release.mjs <commit> <summary> --significant` only when the release qualifies. Without that explicit flag the script skips posting. `node scripts/announce-release.mjs --prepare-channel` creates Releases without posting. Existing archived/private/deleted channels are not automatically reopened or made public. Release IDs are recorded to prevent duplicates; record the script result in the deployment record. Do not announce local previews or failed deployments.

Release posts include their original posting date and time in America/Denver (MST/MDT). Preserve original timestamps when migrating history. `node scripts/migrate-release-history.mjs` previews migration; `--apply` archives original announcement rows, moves them into Releases, and consolidates identical broadcasts. Back up production before applying.
