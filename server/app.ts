import { createBlackjack } from './blackjack.ts';
import { createCommunity } from './community.ts';
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
import { createVoice, type VoiceConfig } from './voice.ts';
import { createStore, type User } from './store.ts';

export type Config = VoiceConfig & {
  databasePath: string;
  staticPath: string;
  inviteCode: string;
  origin: string;
  secureCookies: boolean;
  serverName: string;
  log?: boolean;
  giphyApiKey?: string;
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
  let closing = false;
  const generation = randomUUID();
  let revision = 0;
  const limits = new Map<string, { count: number; until: number }>();
  const voice = createVoice(config, {
    body,
    json,
    fail,
    changed: broadcast,
    authorize: (session) => {
      const fresh = community.account(session.user.id);
      if (!fresh || fresh.channel !== session.user.channel)
        fail(409, 'Channel changed. Join voice again.');
      community.requireAccess(session.user.id, session.user.channel);
    },
    sessionValid: (hash) =>
      Boolean(
        db
          .prepare(
            'SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ?',
          )
          .get(hash, Date.now()),
      ),
  });
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
    if (!user || user.disabled) return null;
    return { user, hash, expires: record.expires };
  }
  const online = (id: string) =>
    voice.roster().some((member) => member.userId === id) ||
    [...clients].some(
      (client) => client.session.user.id === id && !client.response.destroyed,
    );
  const community = createCommunity(db, {
    fail,
    online,
    removeVoice: (id) => voice.removeUser(id),
  });
  const blackjack = createBlackjack(db, {
    fail,
    canAccess: community.canAccess,
  });
  function stateFor(id?: string) {
    const channelRows = community.channelList(id);
    const base = {
      generation,
      revision,
      serverName: config.serverName,
      channels: channelRows.map((row) => row.name),
    };
    if (!id) return { ...base, me: null, members: [], messages: [] };
    const members = (
      db
        .prepare(
          'SELECT id, COALESCE(display_name, name) AS name, name AS handle, color, channel, is_admin AS isAdmin, presence, away_message AS awayMessage, avatar, bio, profile_link AS profileLink FROM users WHERE disabled = 0 ORDER BY name COLLATE NOCASE',
        )
        .all() as Pick<User, 'id' | 'name' | 'channel'>[]
    ).map((user) => ({
      ...user,
      channel: community.visibleLocation(id, user.id, user.channel)
        ? user.channel
        : '',
      online: online(user.id) && !community.blocked(id, user.id),
      present:
        online(user.id) && community.visibleLocation(id, user.id, user.channel),
      role: community.visibleLocation(id, user.id, user.channel)
        ? community.role(user.id, user.channel)
        : '',
    }));
    const me = members.find((member) => member.id === id) ?? null;
    if (!me) return { ...base, me: null, members: [], messages: [] };
    const columns = community.messageColumns;
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
    const filtered = messages.filter(
      (m) =>
        !db
          .prepare(
            'SELECT 1 FROM peer_preferences WHERE user_id=? AND peer_id=? AND (blocked=1 OR muted=1)',
          )
          .get(id, String(m.userId)) &&
        (m.recipient || community.canAccess(id, String(m.channel))),
    );
    return {
      ...base,
      me,
      members,
      messages: filtered,
      community: community.snapshot(id),
      blackjack: blackjack.snapshot(id),
      voice: voice
        .roster()
        .filter((v) => community.visibleLocation(id, v.userId, v.channel)),
    };
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
    if (closing) return;
    revision++;
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
    source?: string,
  ) {
    for (const client of clients)
      if (
        filter(client) &&
        community.shouldNotify(client.session.user.id, source, kind) &&
        (!['join', 'leave'].includes(kind) ||
          community.channel(currentChannel(client) || '')?.notices)
      )
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
    if (
      !['/api/login', '/api/register'].includes(
        new URL(request.url || '/', 'http://localhost').pathname,
      ) &&
      !sessionFor(request)
    )
      fail(401, 'Connect to the gateway first.');
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
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.giphy.com; connect-src 'self' https://api.giphy.com; media-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
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
        if (
          (pathname === '/api/login' || pathname === '/api/register') &&
          request.method === 'POST'
        ) {
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
          if (pathname === '/api/register' && user)
            fail(
              409,
              'That account handle is already registered. Sign in instead.',
            );
          if (pathname === '/api/login' && !user)
            fail(401, 'Account handle or password is incorrect.');
          if (
            user &&
            db.prepare('SELECT disabled FROM users WHERE id = ?').get(user.id)
              ?.disabled
          )
            fail(401, 'Account handle or password is incorrect.');
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
          if (!online(user.id)) {
            const home = String(
              community.account(user.id)?.home_channel || 'The Lobby',
            );
            db.prepare('UPDATE users SET channel=? WHERE id=?').run(
              community.canAccess(user.id, home) ? home : 'The Lobby',
              user.id,
            );
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
        if (pathname === '/api/gif-config' && request.method === 'GET') {
          json(response, 200, { apiKey: config.giphyApiKey || '' });
          return;
        }
        if (pathname === '/api/blackjack' && request.method === 'POST') {
          const data = await body(request);
          if (!sessionFor(request)) fail(401, 'Session expired.');
          rate('blackjack:' + session.user.id, 60, 60000);
          if (blackjack.tick()) broadcast();
          blackjack.act(session.user.id, data);
          broadcast();
          json(response, 200, { ok: true });
          return;
        }
        if (pathname === '/api/community' && request.method === 'POST') {
          const data = await body(request);
          if (data.action === 'read')
            rate('read:' + session.user.id, 600, 60000);
          else rate('community:' + session.user.id, 60, 60000);
          if (data.action === 'report')
            rate('report:' + session.user.id, 5, 600000);
          if (
            data.action === 'friend-request' ||
            data.action === 'session-invite'
          )
            rate('invite:' + session.user.id, 10, 60000);
          community.mutate(session.user.id, data);
          broadcast();
          json(response, 200, { ok: true });
          return;
        }
        if (
          (pathname === '/api/history' || pathname === '/api/search') &&
          request.method === 'GET'
        ) {
          const query = new URL(request.url!, 'http://localhost').searchParams;
          const messages = community.history(session.user.id, {
            channel: query.get('channel') || undefined,
            peer: query.get('peer') || undefined,
            before: Number(query.get('before')) || undefined,
            after: query.has('after') ? Number(query.get('after')) : undefined,
            query:
              pathname === '/api/search'
                ? query.get('q') || undefined
                : undefined,
          });
          json(response, 200, { messages });
          return;
        }
        if (pathname.startsWith('/api/admin/')) {
          if (!session.user.is_admin)
            fail(403, 'Administrator access required.');
          if (pathname === '/api/admin/state' && request.method === 'GET') {
            json(response, 200, {
              reports: db
                .prepare(
                  'SELECT r.*,m.text AS messageText,u.name AS reportedHandle FROM reports r JOIN messages m ON m.id=r.message_id JOIN users u ON u.id=m.user_id ORDER BY r.id DESC LIMIT 100',
                )
                .all(),
              audit: db
                .prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 100')
                .all(),
              users: db
                .prepare(
                  'SELECT id, name AS handle, COALESCE(display_name,name) AS name, is_admin AS isAdmin, disabled FROM users ORDER BY name COLLATE NOCASE',
                )
                .all(),
              channels: db
                .prepare(
                  'SELECT name, archived FROM channels ORDER BY name COLLATE NOCASE',
                )
                .all(),
            });
            return;
          }
          if (pathname !== '/api/admin/action' || request.method !== 'POST')
            fail(404, 'Unknown admin action.');
          rate(`admin:${session.user.id}`, 30, 60000);
          const data = await body(request);
          if (!sessionFor(request)?.user.is_admin)
            fail(403, 'Administrator access required.');
          const action = data.action;
          if (
            ![
              'remove-user',
              'restore-user',
              'remove-channel',
              'restore-channel',
            ].includes(String(action))
          )
            fail(400, 'Choose a supported admin action.');
          let removedUser: string | undefined;
          let displaced: string[] = [];
          db.exec('BEGIN IMMEDIATE');
          try {
            if (action === 'remove-user' || action === 'restore-user') {
              if (typeof data.target !== 'string')
                fail(400, 'Choose an account.');
              const target = db
                .prepare('SELECT id, name, is_admin FROM users WHERE id = ?')
                .get(data.target);
              if (!target) fail(404, 'Account not found.');
              if (target.is_admin)
                fail(409, 'Administrator accounts cannot be removed here.');
              if (data.confirm !== target.name)
                fail(400, 'Type the exact account handle to confirm.');
              db.prepare(
                'UPDATE users SET disabled = ?, channel = ? WHERE id = ?',
              ).run(action === 'remove-user' ? 1 : 0, 'The Lobby', data.target);
              if (action === 'remove-user') {
                db.prepare('DELETE FROM sessions WHERE user_id = ?').run(
                  data.target,
                );
                removedUser = data.target;
              }
            } else {
              if (typeof data.target !== 'string')
                fail(400, 'Choose a channel.');
              const target = db
                .prepare('SELECT name, archived FROM channels WHERE name = ?')
                .get(data.target);
              if (!target) fail(404, 'Channel not found.');
              if (target.name === 'The Lobby')
                fail(409, 'The Lobby is the permanent fallback channel.');
              if (data.confirm !== target.name)
                fail(400, 'Type the exact channel name to confirm.');
              if (action === 'remove-channel') {
                displaced = db
                  .prepare('SELECT id FROM users WHERE channel = ?')
                  .all(String(target.name))
                  .map((row) => String(row.id));
                db.prepare(
                  'UPDATE users SET channel = ? WHERE channel = ?',
                ).run('The Lobby', String(target.name));
              }
              db.prepare('UPDATE channels SET archived = ? WHERE name = ?').run(
                action === 'remove-channel' ? 1 : 0,
                String(target.name),
              );
            }
            db.prepare(
              'INSERT INTO admin_audit(actor,action,target,created_at) VALUES(?,?,?,?)',
            ).run(
              session.user.id,
              String(action),
              String(data.target),
              Date.now(),
            );
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          if (removedUser) {
            voice.removeUser(removedUser);
            for (const client of clients)
              if (client.session.user.id === removedUser) {
                event(client, 'state', stateFor());
                client.response.end();
              }
          }
          for (const id of displaced) voice.removeUser(id);
          broadcast();
          json(response, 200, { ok: true });
          return;
        }
        if (pathname === '/api/profile' && request.method === 'POST') {
          rate(`profile:${session.user.id}`, 20, 60000);
          const data = await body(request);
          const name =
            typeof data.displayName === 'string' ? data.displayName.trim() : '';
          const colors = [
            '#83d9ef',
            '#f2a5c5',
            '#b7b0ff',
            '#96dfa9',
            '#ffb58a',
            '#b4d5ff',
            '#e2bfef',
            '#f1d17e',
          ];
          if (
            name.length < 2 ||
            name.length > 32 ||
            /[<>\p{Cc}\p{Cf}]/u.test(name)
          )
            fail(
              400,
              'Use a display name of 2–32 characters without control characters or angle brackets.',
            );
          if (typeof data.color !== 'string' || !colors.includes(data.color))
            fail(400, 'Choose a color from the palette.');
          db.prepare(
            'UPDATE users SET display_name = ?, color = ? WHERE id = ?',
          ).run(name, data.color, session.user.id);
          voice.renameUser(session.user.id, name);
          json(response, 200, { ok: true });
          broadcast();
          return;
        }
        if (pathname.startsWith('/api/voice/')) {
          community.requireAccess(session.user.id, session.user.channel);
          rate(`voice:${session.user.id}`, 400, 60_000);
          await voice.handle(pathname, request, response, {
            ...session,
            user: {
              ...session.user,
              name: String(
                db
                  .prepare(
                    'SELECT COALESCE(display_name, name) AS name FROM users WHERE id = ?',
                  )
                  .get(session.user.id)!.name,
              ),
            },
          });
          return;
        }
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
            if (closing) return;
            if (!online(session.user.id)) {
              const channel = currentChannel(client);
              notice(
                `${session.user.name} has left the channel.`,
                'leave',
                (other) => currentChannel(other) === channel,
                session.user.id,
              );
            }
            broadcast();
          });
          broadcast();
          if (!wasOnline)
            notice(
              session.user.name + ' is online.',
              'friend-online',
              (other) =>
                community.friends(other.session.user.id, session.user.id) &&
                Boolean(
                  db
                    .prepare(
                      'SELECT notify FROM peer_preferences WHERE user_id=? AND peer_id=?',
                    )
                    .get(other.session.user.id, session.user.id)?.notify,
                ),
              session.user.id,
            );
          if (!wasOnline)
            notice(
              `${session.user.name} has joined the channel.`,
              'join',
              (other) =>
                other !== client &&
                currentChannel(other) === session.user.channel,
              session.user.id,
            );
          return;
        }
        if (pathname === '/api/logout' && request.method === 'POST') {
          await body(request);
          voice.removeSession(session.hash);
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
          const target = {
            name: community.join(
              session.user.id,
              name,
              data.visibility,
              data.existingOnly === true,
            ),
          };
          if (session.user.channel !== target.name)
            voice.removeUser(session.user.id);
          db.prepare('UPDATE users SET channel = ? WHERE id = ?').run(
            target.name,
            session.user.id,
          );
          if (session.user.channel !== target.name && online(session.user.id)) {
            notice(
              `${session.user.name} has left the channel.`,
              'leave',
              (client) =>
                client.session.user.id !== session.user.id &&
                currentChannel(client) === session.user.channel,
              session.user.id,
            );
            notice(
              `${session.user.name} has joined the channel.`,
              'join',
              (client) =>
                client.session.user.id !== session.user.id &&
                currentChannel(client) === target.name,
              session.user.id,
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
              !db
                .prepare('SELECT id FROM users WHERE id = ? AND disabled=0')
                .get(recipient))
          )
            fail(400, 'Choose another member to whisper to.');
          const fresh = community.account(session.user.id)!;
          if (
            !recipient &&
            (fresh.channel !== session.user.channel ||
              (data.channel !== undefined && data.channel !== fresh.channel))
          )
            fail(
              409,
              'Your channel changed. Review the destination before sending again.',
            );
          if (recipient) community.allowDM(session.user.id, String(recipient));
          else community.requireAccess(session.user.id, String(fresh.channel));
          const nonce =
            typeof data.nonce === 'string' &&
            /^[a-zA-Z0-9-]{16,80}$/.test(data.nonce)
              ? data.nonce
              : null;
          if (data.nonce !== undefined && !nonce)
            fail(400, 'Invalid message identifier.');
          if (nonce) {
            const prior = db
              .prepare(
                'SELECT id,text,recipient,kind FROM messages WHERE user_id=? AND nonce=?',
              )
              .get(session.user.id, nonce);
            if (prior) {
              if (
                prior.text !== text ||
                prior.recipient !== recipient ||
                prior.kind !== (data.kind === 'action' ? 'action' : 'text')
              )
                fail(
                  409,
                  'Message identifier already used for different content.',
                );
              json(response, 200, { id: Number(prior.id) });
              return;
            }
          }
          if (
            data.kind !== undefined &&
            data.kind !== 'text' &&
            data.kind !== 'action'
          )
            fail(400, 'Choose text or action message type.');
          const kind = data.kind === 'action' ? 'action' : 'text';
          const result = db
            .prepare(
              'INSERT INTO messages(user_id,channel,recipient,text,created_at,kind,nonce) VALUES (?,?,?,?,?,?,?)',
            )
            .run(
              session.user.id,
              String(fresh.channel),
              recipient as string | null,
              text,
              Date.now(),
              kind,
              nonce,
            );
          json(response, 201, { id: Number(result.lastInsertRowid) });
          broadcast();
          if (recipient)
            notice(
              `${session.user.name} sent you a whisper. Open Friends to reply.`,
              'message',
              (client) =>
                client.session.user.id === recipient &&
                community.shouldNotify(
                  String(recipient),
                  session.user.id,
                  'message',
                ),
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
  const blackjackTimer = setInterval(() => {
    try {
      if (blackjack.tick()) broadcast();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'blackjack',
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
  }, 1000);
  blackjackTimer.unref();
  const heartbeat = setInterval(() => {
    if (community.expire()) broadcast();
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
    closing = true;
    clearInterval(heartbeat);
    clearInterval(blackjackTimer);
    voice.close();
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
