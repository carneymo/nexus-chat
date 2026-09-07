import { resolve } from 'node:path';
import { createApp } from './app.ts';

const production = process.env.NODE_ENV === 'production';
const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:3000';
if (production && !origin.startsWith('https://'))
  throw new Error('Production requires an HTTPS APP_ORIGIN.');
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535.');
const app = createApp({
  databasePath: resolve(process.env.DATA_DIR || './data', 'nexus.sqlite'),
  staticPath: resolve(process.env.STATIC_DIR || './dist/client'),
  registrationAllowed: process.env.REGISTRATION_ALLOWED !== 'false',
  trustedProxyIPs: process.env.TRUSTED_PROXY_IPS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  origin,
  secureCookies: production,
  serverName: process.env.SERVER_NAME || 'Nexus',
  log: true,
  giphyApiKey: process.env.GIPHY_API_KEY,
  turnUrls: process.env.TURN_URLS?.split(',')
    .map((url) => url.trim())
    .filter(Boolean),
  turnSecret: process.env.TURN_SECRET,
});
app.server.listen(port, process.env.HOST || '127.0.0.1', () =>
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'gateway-start',
      port,
      pid: process.pid,
    }),
  ),
);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
