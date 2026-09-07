# Security operations

Registration is closed on the first startup with this migration, including existing installations. The shared `INVITE_CODE` is ignored and no longer injected by Compose. Existing accounts and sessions remain intact. Review **Manage server → Admission and account security**, then open registration and generate single-use, seven-day invitation links. New admissions record the invitation ID and timestamp; pre-migration membership is explicitly unreviewed. A review marker records operator verification, not an automated claim of identity.

`REGISTRATION_ALLOWED=false` is an additional deployment-level shutdown switch. Neither the UI nor console can reopen admission until this is changed. Closing registration leaves unused invitation links stored, but blocks their use; revoke links as well if they must remain invalid after reopening. Registration rechecks shutdown, expiry, revocation, and use after password hashing, in the same transaction as account creation.

## Emergency account response

Run commands in the production checkout. They never output passwords, tokens, or message contents:

```sh
sudo docker compose exec -T gateway node scripts/security-admin.ts members
sudo docker compose exec -T gateway node scripts/security-admin.ts close
sudo docker compose exec -T gateway node scripts/security-admin.ts revoke HANDLE
sudo docker compose exec -T gateway node scripts/security-admin.ts suspend HANDLE
```

`revoke` deletes all sessions and unused invitations issued by that account. It does not change the password; use `suspend` for stolen credentials. `suspend` disables the account, invalidates its password, revokes sessions/invitations, and preserves messages. Unlike the ordinary account-removal UI, the console can suspend the last administrator. Console access remains the recovery boundary. A suspended account cannot regain access merely by restoring its enabled flag.

Set a replacement password without putting it in shell history or process arguments (Bash):

```sh
read -r -s -p 'New account password: ' nexus_password; printf '\n'
printf '%s' "$nexus_password" | sudo docker compose exec -T gateway node scripts/security-admin.ts reset-password HANDLE
unset nexus_password
sudo docker compose exec -T gateway node scripts/security-admin.ts restore HANDLE
```

Password reset preserves the disabled flag until explicit restoration and revokes sessions again. Session changes increment an authentication version so a login already performing scrypt cannot issue a new session using stale credentials. New HTTP calls reject revoked tokens; broadcasts filter revoked sessions before sending data. Console-initiated idle SSE/voice cleanup runs within the existing 15-second heartbeat. Administrator UI revocation disconnects those sessions immediately. Already-delivered messages and independent TURN credentials cannot be recalled.

For an entirely new server, use the same secure stdin pattern with `bootstrap HANDLE` instead of `reset-password HANDLE`. Bootstrap succeeds only while there are zero accounts. Then sign in, review membership, open registration, and issue invitations. There is no public bootstrap password or master invite.

## Proxy identity

Caddy overwrites `X-Nexus-Client-IP` with the connecting peer's address. The gateway accepts it only from an exact IP in `TRUSTED_PROXY_IPS`; other callers cannot change their identity using forwarding headers. Missing/malformed identity from an allowlisted proxy is rejected. Authenticated API budgets are keyed by account and cannot be consumed by anonymous traffic from the same network.

Compose assigns both services fixed addresses so gateway startup cannot consume Caddy's address. Defaults: `NEXUS_PROXY_IP=172.30.91.2`, `NEXUS_GATEWAY_IP=172.30.91.3`, `NEXUS_NETWORK_SUBNET=172.30.91.0/29`. For an existing network, explicitly preserve its observed subnet and both addresses in `.env` before rollout. Verify that the addresses belong to the intended services and are distinct. Never allowlist the entire Docker subnet or publish the gateway port. If another CDN/proxy is introduced, update and retest the trust model; do not trust its client-supplied headers by default.

## Local alert logs

The host monitor is independent of the gateway, so a crashed process cannot suppress its own restart alert. Install after confirming the checkout is `/home/ubuntu/nexus`:

```sh
sudo install -m 644 scripts/nexus-security-watch.service scripts/nexus-security-watch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-security-watch.timer
sudo systemctl start nexus-security-watch.service
sudo journalctl -u nexus-security-watch.service --since today
```

It runs every minute, inspects gateway/Caddy start identities and health, and measures filesystem capacity for `/` and container mount sources. It reads at most 20,000 gateway log lines from the last five minutes, counting deduplicated request IDs. Default alerts: at least 20 responses of either 401 or 429 and at least 20% of all logged responses; disk at least 85% used or less than 1 GiB free; stopped/unhealthy services; process restart/container replacement; monitor failure. Onset, recovery, and 15-minute persistent-condition reminders are JSON journal records. First-run startup establishes a baseline. Docker log rotation bounds gateway logs to three 10 MiB files. Monitoring large log windows can undercount at extreme traffic volumes; edge/DDoS protection is a separate concern.

Optional systemd environment overrides: `NEXUS_ALERT_401_COUNT`, `NEXUS_ALERT_429_COUNT`, `NEXUS_DISK_PERCENT`. These are local alerts only, per owner preference: no webhook, email, or external notification delivery is configured. Journald retention follows host policy. Review alerts regularly; this setup cannot notify anyone if the entire host is offline.

## Validation and rollout

Run `node --test server/*.test.ts lib/*.test.ts`, TypeScript, lint, frontend build, and `python3 scripts/security-watch.test.py`. For the actual Caddy regression, set `CADDY_BIN` to a verified Caddy executable before running `node --test server/security.test.ts`; without it, that one test is explicitly skipped. It uses only loopback, ephemeral ports, and an in-memory database, and derives its proxy config from the real Caddyfile.

Before activation: record membership/counts, back up SQLite and private configuration, retain the old image, validate the Caddy config, and run security tests on an isolated candidate container. First startup adds security fields/settings and the invitation table where absent. Keep registration closed until the intended membership has been verified. Expect existing streams/voice to reconnect when the gateway is recreated. Avoid switching during an active game or call.

Rollback restores the prior image and matching proxy configuration/network assumptions. The additive fields preserve old data, but the old image reopens the master-invite path: rollback is an emergency availability measure with explicitly reduced security. Never restore a database over the running service; prefer preserving post-deployment messages and fixing forward. Review any intervening credential/session changes before rolling back.
