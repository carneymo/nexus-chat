# Nexus Chat for Android — private beta

This is a small Kotlin Android shell for the existing React app at `https://nexus-chat.net`.
It preserves the server's HTTPS origin, HttpOnly session cookie, origin protection, HTTP API,
SSE and WebRTC. Web fixes arrive on reload; shell updates are signed APKs installed over the
previous version. No Play Store listing is needed.

## What is included

- Existing sign-in, invite registration, channels, whispers, GIFs and image selection.
- Native microphone permission, Android Back handling, keyboard/system-bar insets and external-link confirmation.
- Foreground voice. Locking the phone or switching apps ends voice; rejoin explicitly.
- Text drafts per account/conversation and catchup on resume in the updated web frontend.
- FCM notification integration for whispers/DMs, exact `@handle` mentions and optional Lobby messages.
- Notification taps open their conversation; account and channel permissions are checked again.

Minimum Android is 9 (API 28); target/compile SDK is Android 16 (API 36).
The initial physical-device acceptance targets are Samsung Android 16 / One UI 8 phones.
There is no device allowlist and no phone serial number is collected or needed.

## Install

Share only `releases/Nexus-Chat-0.1.2-release.apk` and optionally its SHA-256 file.
Download it on the phone, allow installation from that browser when prompted, and install.
Use the existing Nexus account. The app's login is separate from Chrome's login.
On Samsung, Auto Blocker may prevent sideloading; follow the phone's installation prompt/settings
and restore preferred security settings after installation. Do not disable Play Protect.

The first artifact can be built without Firebase configuration: chat and foreground voice remain
usable, but **push is not active**. Enabling push requires both the Firebase-configured APK and
the backend/web changes in the same repository to be deployed.

## Firebase setup

1. Create a Firebase project owned by you. Analytics is not required for this app.
2. Register an Android app with package name **`net.nexuschat.android`**.
3. Download its `google-services.json` into `android/app/google-services.json`. This client
   configuration is compiled into the APK; it is not the server private key.
4. Enable the Firebase Cloud Messaging HTTP v1 API for that project. Create a dedicated service
   account with the Firebase Cloud Messaging API Admin role, then obtain its service-account JSON.
   Keep that file on the server outside the checkout, readable by the gateway container's user.
5. Set `FIREBASE_SERVICE_ACCOUNT_FILE` to its absolute host path and deploy with the optional
   `compose.push.yaml` overlay. The file mounts read-only at `/run/secrets/nexus-firebase.json`.
6. Increment `versionCode`/`versionName`, rebuild using the **same release signing key**, and install over the beta.
7. Open **Options → Phone notifications → Enable phone notifications** while signed in, and grant
   Android notification permission. Confirm the UI says the phone is registered.

Never put the service-account JSON into the APK, `public/`, source control or a shared download.
Firebase receives device tokens and routing metadata (account ID, sender ID or channel name,
message ID), not message text. Android displays generic whisper, mention and Lobby notifications.

Sources: [Firebase Android setup](https://firebase.google.com/docs/cloud-messaging/android/get-started),
[HTTP v1 authorization](https://firebase.google.com/docs/cloud-messaging/send/v1-api).

## Build and signing

Requires JDK 17, Android SDK platform 36/build-tools 35.0.0 and Gradle 8.13. The local `.tools/`
installation is ignored by Git. `scripts/build.ps1` sets project-local Gradle and Android caches;
set `ANDROID_HOME` if using another SDK. Override `-JavaHome` when necessary.

```powershell
# Once only, for a new identity; never replace a key already used by installed apps.
./scripts/create-signing.ps1
./scripts/build.ps1
```

The build runs Android unit tests and lint, creates the release APK, verifies its signature,
and writes a SHA-256 sidecar. Gradle may need network access for pinned dependencies.

Back up **`nexus-release.jks` and `signing.properties` together privately**. Losing the signing key
prevents compatible updates. Neither file belongs in `releases/` or a shared archive.
Do not distribute debug builds; they have a different package ID.

## Conversation and invitation links

`scripts/create-app-links.ps1` prepares `public/.well-known/assetlinks.json` using the public
certificate fingerprint. Publish that file on the existing Nexus domain with the frontend.
Android can then verify ownership of `https://nexus-chat.net/` links. Until verification succeeds,
use Android's **Open by default → Open supported links** setting, or open invites in the browser.
Notification taps use an explicit activity and do not depend on domain verification.

Links use `/#peer=USER_ID`, `/#channel=ENCODED_NAME`, or the existing `/#invite=TOKEN` format.
Notification links also carry `account=USER_ID` to prevent opening another account's conversation.
The backend still authorizes access; links never grant membership or bypass invitation rules.

## Device acceptance before sharing broadly

On each Samsung (and the third phone when available):

1. Install, sign in, close/reopen, rotate the phone and verify session persistence.
2. Send a channel message and whisper between two accounts; select, send and delete an image.
3. Type a draft, switch apps, reopen; then terminate/relaunch and verify the text draft returns.
   Selected image files and GIF drafts must be reselected after process termination.
4. Switch Wi-Fi/mobile data; confirm reconnect and history catchup. Retry a failed send and check for duplicates.
5. Join voice across two networks, grant microphone access, test mute/deafen and speaker/Bluetooth audio.
   Lock the phone or switch apps: verify the microphone indicator stops and voice requires rejoining.
6. With Firebase configured, enable notifications. Background the app and send a whisper and an
   `@handle` mention and Lobby message. Verify generic notifications and correct tap destination.
   Disable Lobby notifications and confirm ordinary Lobby messages stay quiet; other channels remain mention-only.
7. Verify DND/mute/block, revoked private-channel access, notification permission denial, logout,
   account switching and an expired session do not expose another account's notifications.
8. Install a newer APK signed with the same key over this version; confirm login and preferences survive.

Force-stopping an Android app prevents push until it is opened again. Notifications are best-effort;
SSE plus authorized history remain the source of truth. Samsung battery restrictions and Bluetooth
routing require physical-device checks. No locked-screen/background calls are implemented.

## Server operations

See [the backend integration guide](../docs/android.md). Deployment is a separate production
operation: back up SQLite, deploy through the established Nexus workflow, verify health and assets,
then run the existing deployment announcement mechanism. This build does not create a separate
Sites deployment or migrate the existing server.
