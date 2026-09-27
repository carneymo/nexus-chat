# Android integration

The Android app lives in `android/` and loads the existing HTTPS frontend. Authentication and
SSE stay same-origin; no CORS relaxation, JS-readable session cookie or mobile bearer-token bypass
is introduced. The WebView bridge is restricted to the configured origin and top-level frame.

## Backend

`POST /api/push` registers `{token, dm: true, mentions: true}` against the authenticated session.
`{token, action: "remove"}` removes only a token owned by that session. `GET /api/push` reports
whether the server sender is configured. These routes require authentication and the existing
origin validation. Registration is separately rate-limited and bounded to ten phones per account.

`push_devices` and `push_outbox` are additive tables. Device registrations reference session hashes
with cascade deletion, so logout, session revocation and expiry prevent future delivery. No account
or message identity migration is needed. Each message transaction queues eligible devices atomically;
nonce retries do not duplicate jobs. Only DMs and exact stable `@handle` mentions are eligible.
The sender rechecks mutes, blocks, DND, session validity and channel access immediately before sending.

The single-process worker polls every five seconds, processes up to 25 jobs per batch, and uses
bounded exponential retries (eight attempts, maximum job age 24 hours). Invalid FCM registrations
are removed; stale devices expire after 60 days. Provider requests have ten-second timeouts.
Delivery is at least once: the Android notification ID derives from the message ID to replace
repeated deliveries while a notification remains displayed. Already handed-off notifications cannot
be recalled by changing server permissions; lock-screen copy contains no message text.

The server sends FCM data messages with generic notification routing metadata. The Android service
checks the account stored by the signed-in app, suppresses alerts while foregrounded, and posts a
local notification. The updated UI renews registration on resume/token rotation, removes old tokens,
and exposes per-phone DM/mention controls in Options. Firebase registration is opt-in.

## Configuration and deployment

Without `FIREBASE_SERVICE_ACCOUNT_FILE`, push stays disabled and ordinary chat is unaffected.
Native Firebase configuration (`android/app/google-services.json`) is also required before an APK
can register for push. These are different files. See [Android setup](../android/README.md).

For Docker, keep the private server credential outside the checkout and enable the overlay:

```sh
docker compose -f compose.yaml -f compose.push.yaml config --quiet
docker compose -f compose.yaml -f compose.push.yaml up -d --build
```

Use the established production backup, review, activation and verification workflow around those
commands. Preserve the current registration setting, accounts, messages and TURN configuration.
Mount credentials read-only and ensure the gateway user can read them. Missing/invalid configured
credentials fail startup; omitting the variable is the supported no-push mode.

Deploy the frontend changes alongside the API. Serve the release certificate's public
`/.well-known/assetlinks.json` on `nexus-chat.net` to enable verified invitation/conversation links.
The Android build has its own release key; it never receives the server's private key.

After deployment, verify `/api/health`, unauthenticated `/api/push` rejection, signed-in registration,
the public association file, and two-account device delivery. Run the existing
`scripts/announce-release.mjs` only after production verification succeeds; record its result in the
release ledger as required by `AGENTS.md`. No deployment or announcement is performed by the APK build.

Rollback: disable the push overlay/sender and run the previous app image after the usual backup.
The added tables can remain. Expired queues are removed when a configured sender restarts; no destructive
down-migration is needed. Monitor `push-retry`/`push-worker-failed` logs, queue age, and invalid-token churn.

## Validation

`server/push.test.ts` covers route authentication/origin protection, token ownership, nonce deduplication,
DM/mention defaults, private-channel isolation, mutes/DND, restart retries, logout cleanup and invalid
FCM tokens. `server/fcm.test.ts` verifies signed OAuth claims, token caching and HTTP v1 payloads.
`lib/mobile.test.ts` covers conversation-link parsing. The regular gateway and voice suites remain required.
Android unit tests cover origin and deep-link boundaries; lint/build/signature verification are in its build script.
Physical Android 16 audio, notifications, keyboard and upgrade behavior remain device acceptance checks.
