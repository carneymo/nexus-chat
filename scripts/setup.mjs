import { existsSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) {
  console.log('Existing .env preserved.');
} else {
  writeFileSync(
    '.env',
    `REGISTRATION_ALLOWED=true\nSERVER_NAME=Nexus\nAPP_ORIGIN=http://127.0.0.1:3000\nHOST=127.0.0.1\nPORT=3001\nDATA_DIR=./data\nSTATIC_DIR=./dist/client\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Created .env. Bootstrap the first owner using scripts/security-admin.ts; registration starts closed.',
  );
}
