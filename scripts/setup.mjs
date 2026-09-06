import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) {
  console.log('Existing .env preserved.');
} else {
  writeFileSync(
    '.env',
    `INVITE_CODE=${randomBytes(24).toString('base64url')}\nSERVER_NAME=Nexus\nAPP_ORIGIN=http://127.0.0.1:3000\nHOST=127.0.0.1\nPORT=3001\nDATA_DIR=./data\nSTATIC_DIR=./dist/client\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Created .env with a random invite code. Read INVITE_CODE in that file to invite your crew.',
  );
}
