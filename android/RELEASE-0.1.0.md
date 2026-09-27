# Nexus Android 0.1.0 — local private beta

Rebuilt and revalidated September 27, 2026. Package `net.nexuschat.android`, version code 1, Android 9+,
target SDK 36 (Android 16). Release APK is approximately 8.3 MB.

Artifact: `releases/Nexus-Chat-0.1.0-release.apk`

SHA-256: `31ad9b921a24cf582b3a425891647ea727c6c8d5562087864fe1c8139454840e`

## Verified locally

- Android release compilation, two origin/deep-link unit tests and lint (no errors).
- Release APK signature verification and 16 KB ZIP alignment.
- Final launcher icon resolves to its bitmap resource without a recursive drawable reference.
- Web TypeScript and project lint, including the new phone notification component.
- Full gateway/client suite: 57 passed, zero failed, one existing real-Caddy test skipped.
- Production web export including the public App Links certificate association.
- Notification tests cover privacy, permission changes before delivery, retries, revocation,
  nonce deduplication and HTTP v1 authorization. They use a controlled sender, not live Firebase.

## Pending external steps

- No Firebase project configuration was supplied. This APK has push disabled. Supply the client
  configuration, provision the server sender, increment the version, and rebuild with the same key.
- Shared web/API changes are local, not deployed. They provide draft/send recovery, resume catchup,
  notification controls, conversation routing, explicit voice lifecycle UI and the App Links association.
- No phone or emulator was connected. Real Samsung Android 16 install, keyboard, audio, lock-screen
  behavior, notification delivery and upgrade acceptance remain to be checked.
- No production deployment, channel announcement or external download hosting was performed.

The APK loads the currently hosted Nexus frontend. Existing chat and foreground voice use the
existing server. The shell includes a microphone-release compatibility guard for older hosted
frontend versions; full mobile behavior requires deploying the accompanying frontend update.

Release signing material is stored outside `releases/` and ignored by Git. Back up the keystore
and signing properties privately; share only the APK and its checksum.

See [installation and Firebase setup](README.md) and [server integration](../docs/android.md).
