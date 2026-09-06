#!/usr/bin/env bash
# Run from the checkout: sudo bash scripts/setup-turn.sh nexus-chat.net 52.24.107.223
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run this script with sudo.' >&2; exit 1; fi
DOMAIN=${1:?Pass the chat domain}
PUBLIC_IP=${2:?Pass the public IPv4 address}
[[ $DOMAIN =~ ^[a-zA-Z0-9.-]+$ && $PUBLIC_IP =~ ^[0-9.]+$ ]] || exit 1
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
PRIVATE_IP=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1);exit}}')
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
systemctl mask --runtime coturn.service
systemctl stop coturn.service || true
apt-get install -y coturn
python3 - "$REPO_DIR/.env" "$DOMAIN" "$PUBLIC_IP" "$PRIVATE_IP" <<'PY'
import os, pathlib, secrets, sys
path = pathlib.Path(sys.argv[1])
lines = path.read_text().splitlines()
values = dict(line.split('=', 1) for line in lines if '=' in line and not line.startswith('#'))
secret = values.get('TURN_SECRET') or secrets.token_hex(32)
domain, public, private = sys.argv[2:]
lines = [line for line in lines if not line.startswith(('TURN_SECRET=', 'TURN_URLS='))]
lines += [f'TURN_SECRET={secret}', f'TURN_URLS=turn:{domain}:3478?transport=udp,turn:{domain}:3478?transport=tcp']
path.write_text('\n'.join(lines) + '\n')
os.chmod(path, 0o600)
config = f'''listening-port=3478
listening-ip={private}
relay-ip={private}
external-ip={public}/{private}
relay-threads=2
min-port=49160
max-port=49300
realm={domain}
fingerprint
use-auth-secret
static-auth-secret={secret}
no-cli
no-tls
no-dtls
no-tcp-relay
no-multicast-peers
user-quota=20
total-quota=160
max-bps=128000
stale-nonce=600
no-rfc5780
no-stun-backward-compatibility
log-file=syslog
simple-log
'''
for network in ['0.0.0.0-0.255.255.255', '10.0.0.0-10.255.255.255', '100.64.0.0-100.127.255.255', '127.0.0.0-127.255.255.255', '169.254.0.0-169.254.255.255', '172.16.0.0-172.31.255.255', '192.168.0.0-192.168.255.255', '224.0.0.0-255.255.255.255', '::1', 'fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff']:
    config += f'denied-peer-ip={network}\n'
turn = pathlib.Path('/etc/turnserver.conf')
if turn.exists():
    backup = pathlib.Path('/etc/turnserver.conf.nexus-backup')
    if not backup.exists():
        backup.write_bytes(turn.read_bytes())
        os.chmod(backup, 0o600)
turn.write_text(config)
os.chmod(turn, 0o640)
PY
chown root:turnserver /etc/turnserver.conf
systemctl unmask --runtime coturn.service
systemctl enable coturn
systemctl restart coturn
systemctl is-active --quiet coturn
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 3478/tcp
  ufw allow 3478/udp
  ufw allow 49160:49300/udp
fi
echo 'Voice relay configured. Open Lightsail TCP/UDP 3478 and UDP 49160-49300, then rebuild Docker Compose.'
