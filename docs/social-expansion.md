# Social expansion audit and feature matrix

Baseline: `49e20f5` / `v1.0.0`. Work branch: `feature/social-community`.

Production was inspected read-only. Its refreshed interface matches the baseline. All mutations and browser checks for this expansion used an isolated local SQLite database. **Production deployment has not been performed.**

“Implemented” below means the behavior has passed the stated validation. “Partial” identifies remaining end-to-end validation or an intentionally limited implementation, rather than implying release readiness for an untested path.

| Feature | Baseline | Current status | Decision | Required work / evidence |
|---|---|---|---|---|
| Public discovery and joining by name | Partial | Implemented | Adapt | Public-only discovery, explicit name join, separate Create UI; HTTP and private-channel creation UI checked. Existing legacy API creation remains compatible. |
| Durable channel owner/moderator | Missing | Implemented | Adapt | SQLite ownership and roles; owner/mod permissions, protected owners and restart persistence tested. Existing rooms remain server-managed. |
| Public, unlisted, invite-only access | Missing | Implemented | Adapt | Shared ACL for joining, snapshots, history, search, voice and sessions; private discovery and friendship bypass tests pass. |
| Selected home channel | Missing | Implemented | Adapt | Saved setting and sign-in restoration, safe Lobby fallback; settings UI and restoration API tested. |
| Live members versus offline location | Partial | Implemented | Adapt | Live SSE/voice membership drives online state; stored channel alone never means present. Multi-tab and final disconnect tested. |
| Configurable join/leave notices | Partial | Implemented | Adapt | Channel/user switches and DND filtering are wired; browser saved channel notices off; a real local SSE join/leave emitted no channel notices while the separate opted-in friend alert remained visible. |
| Channel links | Missing | Implemented | Adapt | Share name link and authenticated direct joining, with no access grant; clipboard success and a new tab restoring the authorized destination were verified. |
| Persistent kick/ban | Partial | Implemented | Adapt | Kick evicts membership, ban prevents rejoin until lifted, durable audit and restart test. Public-room kicks allow rejoining; use ban to prevent it. |
| Requests, acceptance, removal, friends list | Missing | Implemented | Adapt | Mutual accepted relationships replace the old account directory; request UI, acceptance, live update and removal/block policies tested. Directory remains under Find people. |
| Online, away, DND and away message | Missing | Implemented | Adapt | Saved states; mobile save checked; DND suppresses notices while retaining delivery and unread counts. |
| Pinned friends and online alerts | Missing | Implemented | Adapt | Durable per-peer preferences and sort order; opt-in online events/DND tested through SSE. Pin and online-alert toggles were verified on mobile. |
| Channel/activity privacy | Missing | Implemented | Adapt | Default friends visibility, optional everyone/nobody; channel ACL always wins. Listings and DMs redact location metadata. Explicit session invites share only that listing. |
| Offline cross-channel DMs and unread | Implemented / missing unread | Implemented | Keep/adapt | Stable account IDs, durable messages/read markers; mobile receive/reply and unread UI checked; blocked delivery and persistence tested. |
| Quick reply | Missing | Implemented | Adapt | Last incoming DM via button and /r; both were verified through the browser. |
| Paginated history | Partial | Implemented | Adapt | Cursor API, stable ID merging and scroll preservation implemented; 250-message API catchup and merge tests pass. Browser initial history contained 200 markers; Load earlier expanded to 250 with the earliest marker present and no duplicates. |
| Commands and autocomplete | Partial | Implemented | Adapt | /join, /w, /r, /me, /away, /dnd, /help, clickable suggestions and Tab completion; equivalent channel/friend/action/settings UI. Browser verified Tab completion, /away, /dnd (confirmed persisted), /help, /join, /w, /r, and /me. |
| Blocking/muting/friends-only DMs | Missing | Implemented | Adapt | Persistent peer preferences and server checks; blocks are reciprocal for delivery, muting hides incoming text/notices without deleting it. HTTP persistence tests pass. |
| Authorized search | Missing | Implemented | Adapt | Current channel or own DM conversation only; privacy and query authorization tested. Browser search returned the newly sent action message. |
| Profiles and stable identity | Partial | Implemented | Keep/adapt | Existing display name/handle/color preserved; preset glyph avatars, bio and HTTPS link added. Mobile bio/settings save and identity/history regression tested. No remote avatar tracking requests. |
| Owner/moderator badges | Partial | Implemented | Adapt | Server-derived badges in roster/profile; owner visible in browser. Moderator assignment was explicitly authorized for the synthetic local account and its profile badge was verified. |
| Separate community groups | Missing | Missing | Defer | Owned channels and durable membership are the shared community concept. No second group object, tag namespace or overlapping roster was added. |
| Open sessions | Missing | Implemented | Adapt | Activity/title/host/capacity/time/visibility/link, host close/cancel, four-hour expiry. Mobile creation/cancellation and server capacity races verified. |
| Session invitations | Missing | Implemented | Adapt | Host panel plus friend/profile controls; private ACL and explicit invitation behavior verified by HTTP. Friend-list invitation submitted in the browser and received by the target account; profile/roster uses the same invitation component. |
| Reconnect / duplicate handling | Partial | Implemented | Adapt | Snapshot generations/revisions, retained disconnect cursor, paged catchup, idempotent sends, authorized cache merging. Automated tests pass; a stopped-server browser test recovered all 250 missed messages exactly once after restart. |
| Multi-tab / voice cleanup | Implemented | Implemented | Keep | Original voice lifecycle tests retained. Added fresh channel authorization after asynchronous request bodies and shutdown cleanup guard. |
| Reporting and moderation audit | Partial | Implemented | Adapt | Authorized reports, admin report resolution/log UI, durable channel audit. API access tested; synthetic report submission, selected-message review and admin resolution were verified in the browser. |
| Rate limits, validation and request logs | Implemented | Implemented | Keep/adapt | Per-user mutation/read/invitation/report budgets; existing message/login/IP limits and content-free request logs retained. |
| Mobile and keyboard accessibility | Implemented | Partial | Keep/adapt | Reused dialogs, semantic forms, visible focus, compact controls. Mobile friend/DM/settings/session flows and reduced viewport checked. Real Android keyboard/assistive-technology check is outstanding. |
| Matchmaking, ladders, game hosting/maps, mass DM, rewards | Missing | Missing | Exclude | Outside Nexus's social scope; not added. |

## Architecture and data model

The runtime remains Node HTTP + SQLite + cookie sessions + personalized SSE. WebRTC/coturn voice transport is unchanged. `server/community.ts` centralizes channel access, relationships, presence privacy, history authorization, reporting and session rules. `server/community-schema.ts` applies additive, transactional schema changes.

New durable tables cover channel roles/bans, friendships, peer preferences, read markers, activities/membership/invitations, and reports. Existing user UUIDs, handles, message IDs and history remain intact. Channels gain owner/access/notice settings; accounts gain home/presence/privacy/profile settings; messages gain action type and a unique sender/nonce pair.

Membership is a durable access grant; presence is a live connection. Friendship is not a channel grant. The Lobby remains the permanent fallback. Session capacity includes the host and is independent of the existing eight-person voice limit. Listings expire four hours after the start; the heartbeat removes expired listings from connected clients within approximately 15 seconds.

New clients send the intended channel and an idempotency nonce with messages. The server rejects a changed destination rather than posting in the wrong room. Snapshot revisions reject delayed state updates. Catchup merges by message ID and filters against the current account/channel and block/mute preferences.

## Validation ledger

- Baseline: 16 tests passed before edits.
- Expanded suite: 31 tests passed; production build, type checking, lint and diff checks passed.
- HTTP/SSE coverage includes unauthorized access, private discovery/history/search, relationship privacy, durable bans and blocks across restart, DND, unread markers, nonce duplicates, pagination/catchup, multiple tabs, final presence cleanup, in-flight voice moderation, session invitation privacy, atomic capacity, expiry, migration preservation and original voice lifecycle.
- Browser checks used local test accounts: sign-in, invite-only channel creation, friend request, accepted relationship, offline DM/unread, mobile reply ordering, away/bio preference save, activity creation/cancellation. Desktop and 390px mobile layouts inspected; reduced viewport composer remained visible.
- Rows marked partial are implemented but have the stated end-to-end verification outstanding. They are not represented as fully verified features.

## Migration and deployment requirements

1. Review this branch and complete the outstanding browser checks before production deployment.
2. Use the existing SQLite backup command on Lightsail before updating the gateway. Back up runtime configuration separately and keep it private.
3. Build/recreate the existing gateway image using the repository's current deployment process. First startup applies schema version 4 automatically; no new npm service, port, TURN change or secret is required.
4. Existing channels remain public and server-managed. The existing administrator can adjust channel access; new channels have a persistent creator/owner. Existing accounts keep their handles and chosen colors.
5. Location/activity defaults are friends-only. Existing friendships do not exist to migrate: the previous Friends panel was an account directory. Users send/accept requests once. Existing received DMs initially count as unread because historical read state was never stored.
6. Check health, sign-in, two-user messaging, private-room access, and voice after an authorized deployment.
7. Keep `v1.0.0` as the source fallback. **Do not run the old gateway against the expanded database in production:** old code does not enforce the new channel/privacy rules. Rollback requires stopping the gateway and restoring the pre-migration SQLite backup together with the old image/configuration. This discards writes made after that backup; plan the maintenance window accordingly.

This change adds application authorization and privacy controls, not end-to-end encryption or encryption of the SQLite file. The existing HTTPS and deployment storage protections remain unchanged.

Additional browser evidence: moderator assignment/profile badge, pin and notification toggles, shared-link destination, /me rendering, scoped search, report submission/admin resolution, quick reply, direct friend-list session invitation, 250-message stopped-server catchup, and 200-to-250 history pagination. Production remained untouched.

Final UI command/notification checks: Tab expanded `/aw` to `/away`; /away and /dnd persisted; /help rendered; /join changed rooms; /w and /r delivered to the expected DM thread. Channel notice suppression and independent friend-online alerts passed a live SSE/browser check. The only unverified platform-specific item is a real Android keyboard/assistive-technology pass; viewport simulation is not a substitute for that device check.
