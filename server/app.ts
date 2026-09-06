import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { createStore, type User } from './store.ts';

export type Config = {
  databasePath: string;
  staticPath: string;
  inviteCode: string;
  origin: string;
  secureCookies: boolean;
  serverName: string;
  log?: boolean;
};
type Session = { user: User; hash: string; expires: number };
type Client = { response: ServerResponse; session: Session };
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const same = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const passwordHash = (password: string, salt: string): Promise<string> =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (error, key) =>
      error ? reject(error) : resolve(key.toString('hex')),
    ),
  );
function containsControlCharacters(text: string) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

export function createApp(config: Config) {
  if (config.inviteCode.length < 16)
    throw new Error('INVITE_CODE must be at least 16 characters.');
  const db = createStore(config.databasePath);
  const clients = new Set<Client>();
  const limits = new Map<string, { count: number; until: number }>();
  let activeHashes = 0;
  function rate(key: string, max: number, duration: number) {
    const now = Date.now();
    let value = limits.get(key);
    if (!value || value.until <= now) {
      if (limits.size >= 5000)
        for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
      if (limits.size >= 5000) fail(503, 'Server is busy. Try again shortly.');
      value = { count: 0, until: now + duration };
      limits.set(key, value);
    }
    if (++value.count > max)
      fail(429, 'Too many requests. Please wait a moment.');
  }
  function sessionFor(request: IncomingMessage): Session | null {
    const token = /(?:^|;\s*)nexus_session=([a-f0-9]{64})(?:;|$)/.exec(
      request.headers.cookie || '',
    )?.[1];
    if (!token) return null;
    const hash = digest(token);
    const record = db
      .prepare(
        'SELECT user_id, expires FROM sessions WHERE token_hash = ? AND expires > ?',
      )
      .get(hash, Date.now()) as
      | { user_id: string; expires: number }
      | undefined;
    if (!record) return null;
    const user = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(record.user_id) as User;
    return { user, hash, expires: record.expires };
  }
  const online = (id: string) =>
    [...clients].some(
      (client) => client.session.user.id === id && !client.response.destroyed,
    );
  function stateFor(id?: string) {
    const channelRows = db
      .prepare('SELECT name FROM channels ORDER BY rowid')
      .all() as { name: string }[];
    const base = {
      serverName: config.serverName,
      channels: channelRows.map((row) => row.name),
    };
    if (!id) return { ...base, me: null, members: [], messages: [] };
    const members = (
      db
        .prepare(
          'SELECT id, name, channel FROM users ORDER BY name COLLATE NOCASE',
        )
        .all() as Pick<User, 'id' | 'name' | 'channel'>[]
    ).map((user) => ({ ...user, online: online(user.id) }));
    const me = members.find((member) => member.id === id) ?? null;
    if (!me) return { ...base, me: null, members: [], messages: [] };
    const columns =
      'm.id, u.name, m.user_id AS userId, m.channel, m.recipient, m.text, m.created_at AS createdAt';
    const publicMessages = db
      .prepare(
        `SELECT ${columns} FROM messages m JOIN users u ON u.id = m.user_id WHERE m.channel = ? AND m.recipient IS NULL ORDER BY m.id DESC LIMIT 200`,
      )
      .all(me.channel);
    const whispers = db
      .prepare(
        `SELECT ${columns} FROM messages m JOIN users u ON u.id = m.user_id WHERE m.recipient IS NOT NULL AND (m.recipient = ? OR m.user_id = ?) ORDER BY m.id DESC LIMIT 200`,
      )
      .all(id, id);
    const messages = [...publicMessages, ...whispers].sort(
      (a, b) => Number(a.id) - Number(b.id),
    );
    return { ...base, me, members, messages };
  }
  function event(client: Client, kind: string, value: unknown) {
    if (client.response.destroyed) return;
    // Disconnect slow clients; native EventSource reconnects and receives a fresh snapshot.
    if (client.response.writableLength > 1024 * 1024) {
      client.response.destroy();
      return;
    }
    client.response.write(`event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  function broadcast() {
    const snapshots = new Map<string, ReturnType<typeof stateFor>>();
    for (const client of clients) {
      const id = client.session.user.id;
      if (!snapshots.has(id)) snapshots.set(id, stateFor(id));
      event(client, 'state', snapshots.get(id));
    }
  }
  function notice(
    text: string,
    kind: string,
    filter: (client: Client) => boolean,
  ) {
    for (const client of clients)
      if (filter(client))
        event(client, 'notice', { text, kind, createdAt: Date.now() });
  }
  const currentChannel = (client: Client) =>
    (
      db
        .prepare('SELECT channel FROM users WHERE id = ?')
        .get(client.session.user.id) as { channel: string } | undefined
    )?.channel;
  function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(value));
  }
  async function body(
    request: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    if (!request.headers['content-type']?.startsWith('application/json'))
      fail(415, 'Use JSON for this request.');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 16_384) fail(413, 'Request is too large.');
      chunks.push(chunk);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      fail(400, 'Invalid JSON.');
    }
    if (!value || Array.isArray(value) || typeof value !== 'object')
      fail(400, 'Expected an object.');
    return value as Record<string, unknown>;
  }
  const cookie = (token: string, maxAge: number) =>
    `nexus_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
  const staticRoot = resolve(config.staticPath);
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const start = Date.now();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (config.secureCookies)
      response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    response.on('finish', () => {
      if (config.log)
        console.log(
          JSON.stringify({
            level: 'info',
            requestId,
            method: request.method,
            path: pathname,
            status: response.statusCode,
            durationMs: Date.now() - start,
          }),
        );
    });
    try {
      const ip = request.socket.remoteAddress || 'unknown';
      // The reverse proxy must preserve Origin. Never trust arbitrary forwarded headers.
      if (request.headers.origin && request.headers.origin !== config.origin)
        fail(403, 'This gateway does not accept requests from that origin.');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (pathname === '/api/health' && request.method === 'GET') {
        db.prepare('SELECT 1').get();
        json(response, 200, { status: 'ok' });
        return;
      }
      if (pathname.startsWith('/api/')) {
        rate(`api:${ip}`, 600, 60_000);
        const session = sessionFor(request);
        if (pathname === '/api/state' && request.method === 'GET') {
          json(response, 200, stateFor(session?.user.id));
          return;
        }
        if (pathname === '/api/login' && request.method === 'POST') {
          rate(`login:${ip}`, 30, 15 * 60_000);
          const data = await body(request);
          const name = typeof data.name === 'string' ? data.name.trim() : '';
          const password =
            typeof data.password === 'string' ? data.password : '';
          if (
            !/^[A-Za-z0-9_-]{2,20}$/.test(name) ||
            password.length < 10 ||
            password.length > 128
          )
            fail(
              400,
              'Use a 2–20 character callsign and a password of 10–128 characters.',
            );
          rate(`name:${name.toLowerCase()}`, 15, 15 * 60_000);
          if (activeHashes >= 4)
            fail(503, 'Gateway is busy. Try connecting again shortly.');
          let user = db
            .prepare('SELECT * FROM users WHERE name = ?')
            .get(name) as User | undefined;
          const salt = user?.salt || randomBytes(16).toString('hex');
          activeHashes++;
          let hash: string;
          try {
            hash = await passwordHash(password, salt);
          } finally {
            activeHashes--;
          }
          if (user) {
            if (!same(hash, user.password_hash))
              fail(401, 'Callsign, password, or invite code is incorrect.');
          } else {
            if (
              typeof data.invite !== 'string' ||
              !same(data.invite, config.inviteCode)
            )
              fail(401, 'Callsign, password, or invite code is incorrect.');
            if (
              Number(
                db.prepare('SELECT COUNT(*) AS count FROM users').get()!.count,
              ) >= 50
            )
              fail(409, 'This gateway has reached its 50-member limit.');
            user = {
              id: randomUUID(),
              name,
              salt,
              password_hash: hash,
              channel: 'The Lobby',
            };
            try {
              db.prepare(
                'INSERT INTO users(id,name,salt,password_hash) VALUES (?,?,?,?)',
              ).run(user.id, name, salt, hash);
            } catch (error) {
              if (String(error).includes('UNIQUE'))
                fail(409, 'That callsign was just registered. Try signing in.');
              throw error;
            }
          }
          db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
          const count = Number(
            db
              .prepare(
                'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?',
              )
              .get(user.id)!.count,
          );
          if (count >= 10)
            fail(
              409,
              'Too many signed-in sessions. Sign out on another device first.',
            );
          const token = randomBytes(32).toString('hex');
          const expires = Date.now() + 30 * 86400_000;
          db.prepare(
            'INSERT INTO sessions(token_hash,user_id,expires) VALUES (?,?,?)',
          ).run(digest(token), user.id, expires);
          response.setHeader('Set-Cookie', cookie(token, 30 * 86400));
          json(response, 200, { ok: true });
          broadcast();
          return;
        }
        if (!session) fail(401, 'Connect to the gateway first.');
        if (pathname === '/api/events' && request.method === 'GET') {
          if (
            [...clients].filter(
              (client) => client.session.user.id === session.user.id,
            ).length >= 5
          )
            fail(429, 'Too many open tabs. Close another gateway tab.');
          const wasOnline = online(session.user.id);
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          response.write('retry: 2500\n\n');
          const client: Client = { response, session };
          clients.add(client);
          response.on('close', () => {
            clients.delete(client);
            if (!online(session.user.id)) {
              const channel = currentChannel(client);
              notice(
                `${session.user.name} has left the channel.`,
                'leave',
                (other) => currentChannel(other) === channel,
              );
            }
            broadcast();
          });
          broadcast();
          if (!wasOnline)
            notice(
              `${session.user.name} has joined the channel.`,
              'join',
              (other) =>
                other !== client &&
                currentChannel(other) === session.user.channel,
            );
          return;
        }
        if (pathname === '/api/logout' && request.method === 'POST') {
          await body(request);
          db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(
            session.hash,
          );
          for (const client of clients)
            if (client.session.hash === session.hash) client.response.end();
          response.setHeader('Set-Cookie', cookie('', 0));
          json(response, 200, { ok: true });
          return;
        }
        if (pathname === '/api/channel' && request.method === 'POST') {
          rate(`channel:${session.user.id}`, 15, 60_000);
          const data = await body(request);
          const name = typeof data.name === 'string' ? data.name.trim() : '';
          if (!/^[A-Za-z0-9 _-]{2,32}$/.test(name))
            fail(
              400,
              'Use 2–32 letters, numbers, spaces, underscores, or hyphens.',
            );
          let target = db
            .prepare('SELECT name FROM channels WHERE name = ?')
            .get(name) as { name: string } | undefined;
          if (!target) {
            if (
              Number(
                db.prepare('SELECT COUNT(*) AS count FROM channels').get()!
                  .count,
              ) >= 32
            )
              fail(409, 'This gateway has reached its 32-channel limit.');
            db.prepare('INSERT INTO channels(name) VALUES (?)').run(name);
            target = { name };
          }
          db.prepare('UPDATE users SET channel = ? WHERE id = ?').run(
            target.name,
            session.user.id,
          );
          if (session.user.channel !== target.name) {
            notice(
              `${session.user.name} has left the channel.`,
              'leave',
              (client) =>
                client.session.user.id !== session.user.id &&
                currentChannel(client) === session.user.channel,
            );
            notice(
              `${session.user.name} has joined the channel.`,
              'join',
              (client) =>
                client.session.user.id !== session.user.id &&
                currentChannel(client) === target.name,
            );
          }
          json(response, 200, { ok: true });
          broadcast();
          return;
        }
        if (pathname === '/api/messages' && request.method === 'POST') {
          rate(`message:${session.user.id}`, 40, 60_000);
          const data = await body(request);
          const text = typeof data.text === 'string' ? data.text.trim() : '';
          if (!text || text.length > 2000 || containsControlCharacters(text))
            fail(400, 'Messages must contain 1–2000 printable characters.');
          const recipient =
            data.recipient === undefined || data.recipient === null
              ? null
              : data.recipient;
          if (
            recipient !== null &&
            (typeof recipient !== 'string' ||
              recipient === session.user.id ||
              !db.prepare('SELECT id FROM users WHERE id = ?').get(recipient))
          )
            fail(400, 'Choose another member to whisper to.');
          const result = db
            .prepare(
              'INSERT INTO messages(user_id,channel,recipient,text,created_at) VALUES (?,?,?,?,?)',
            )
            .run(
              session.user.id,
              session.user.channel,
              recipient as string | null,
              text,
              Date.now(),
            );
          json(response, 201, { id: Number(result.lastInsertRowid) });
          broadcast();
          if (recipient)
            notice(
              `${session.user.name} sent you a whisper. Open Friends to reply.`,
              'message',
              (client) => client.session.user.id === recipient,
            );
          return;
        }
        fail(404, 'Unknown gateway command.');
      }
      if (!['GET', 'HEAD'].includes(request.method || ''))
        fail(405, 'Method not allowed.');
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        fail(400, 'Invalid path.');
      }
      if (decoded.includes('\0') || decoded.includes('\\'))
        fail(400, 'Invalid path.');
      let file = resolve(staticRoot, `.${decoded}`);
      if (file !== staticRoot && !file.startsWith(staticRoot + sep))
        fail(403, 'Invalid path.');
      if (existsSync(file) && statSync(file).isDirectory())
        file = resolve(file, 'index.html');
      if (!existsSync(file) || !statSync(file).isFile())
        fail(404, 'Not found.');
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.json': 'application/json',
        '.txt': 'text/plain',
      };
      response.writeHead(200, {
        'Content-Type': types[extname(file)] || 'application/octet-stream',
        'Cache-Control':
          extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
        'Content-Length': statSync(file).size,
      });
      if (request.method === 'HEAD') response.end();
      else
        createReadStream(file)
          .on('error', () => response.destroy())
          .pipe(response);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500)
        console.error(
          JSON.stringify({
            level: 'error',
            requestId,
            error: error instanceof Error ? error.message : 'unknown',
          }),
        );
      if (!response.headersSent)
        json(response, status, {
          error:
            status === 500
              ? 'The gateway encountered a problem. Please try again.'
              : (error as Error).message,
        });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 300;
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (
        client.session.expires <= Date.now() ||
        !db
          .prepare('SELECT 1 FROM sessions WHERE token_hash = ?')
          .get(client.session.hash)
      )
        client.response.end();
      else if (!client.response.destroyed)
        client.response.write(': heartbeat\n\n');
    }
    for (const [key, value] of limits)
      if (value.until <= Date.now()) limits.delete(key);
  }, 15_000);
  heartbeat.unref();
  async function close() {
    clearInterval(heartbeat);
    for (const client of clients) client.response.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
  return { server, close, db };
}
