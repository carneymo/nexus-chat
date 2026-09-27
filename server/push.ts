import type { DatabaseSync } from 'node:sqlite';

export type PushPayload = {
  token: string;
  data: { account: string; link: string; kind: string; messageId: string };
};
export type PushSender = (payload: PushPayload) => Promise<'sent' | 'invalid'>;
type Session = { user: { id: string }; hash: string };
type Message = {
  id: number;
  user_id: string;
  channel: string;
  recipient: string | null;
  text: string;
  created_at: number;
};
type Device = {
  token: string;
  user_id: string;
  session_hash: string;
  dm: number;
  mentions: number;
  lobby: number;
};
type Dependencies = {
  canAccess: (id: string, channel: string) => boolean;
  shouldNotify: (id: string, source?: string, kind?: string) => boolean;
  fail: (status: number, message: string) => never;
};

/** Exact account handles only: no @everyone, display-name matching, or email matches. */
export function mentionedHandles(text: string): Set<string> {
  return new Set(
    [
      ...text.matchAll(
        /(?:^|[^A-Za-z0-9_@-])@([A-Za-z0-9_-]{2,20})(?![A-Za-z0-9_-])/g,
      ),
    ].map((match) => match[1].toLowerCase()),
  );
}

export function createPush(
  db: DatabaseSync,
  dependencies: Dependencies,
  send?: PushSender,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_devices (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      dm INTEGER NOT NULL DEFAULT 1, mentions INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_devices(user_id);
    CREATE TABLE IF NOT EXISTS push_outbox (
      token TEXT NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
      PRIMARY KEY(token,message_id));
  `);
  if (
    !db
      .prepare('PRAGMA table_info(push_devices)')
      .all()
      .some((column) => column.name === 'lobby')
  )
    db.exec(
      'ALTER TABLE push_devices ADD COLUMN lobby INTEGER NOT NULL DEFAULT 0',
    );
  const { fail } = dependencies;
  function register(session: Session, data: Record<string, unknown>) {
    const token = data.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_:-]{20,4096}$/.test(token))
      fail(400, 'Invalid notification registration.');
    const validToken = token as string;
    if (data.action === 'remove') {
      db.prepare(
        'DELETE FROM push_devices WHERE token=? AND session_hash=?',
      ).run(validToken, session.hash);
      return { enabled: Boolean(send) };
    }
    if (!send)
      fail(503, 'Phone notifications are not configured on this server yet.');
    for (const key of ['dm', 'mentions', 'lobby'])
      if (data[key] !== undefined && typeof data[key] !== 'boolean')
        fail(400, 'Choose enabled or disabled.');
    const prior = db
      .prepare('SELECT * FROM push_devices WHERE token=?')
      .get(validToken) as Device | undefined;
    // Possession of an FCM token alone must not let another account claim the device.
    if (prior && prior.user_id !== session.user.id)
      fail(409, 'Sign out of the previous account on this phone first.');
    if (
      !prior &&
      Number(
        db
          .prepare('SELECT count(*) AS n FROM push_devices WHERE user_id=?')
          .get(session.user.id)!.n,
      ) >= 10
    )
      fail(409, 'Too many registered phones. Sign out on another phone first.');
    if (prior && prior.session_hash !== session.hash)
      db.prepare('DELETE FROM push_outbox WHERE token=?').run(validToken);
    db.prepare(`INSERT INTO push_devices(token,user_id,session_hash,dm,mentions,lobby,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(token) DO UPDATE SET session_hash=excluded.session_hash,dm=excluded.dm,mentions=excluded.mentions,lobby=excluded.lobby,updated_at=excluded.updated_at`).run(
      validToken,
      session.user.id,
      session.hash,
      Number(data.dm !== false),
      Number(data.mentions !== false),
      Number(data.lobby === true),
      Date.now(),
    );
    return { enabled: true };
  }
  function eligible(device: Device, message: Message) {
    if (
      device.user_id === message.user_id ||
      !dependencies.shouldNotify(device.user_id, message.user_id, 'message')
    )
      return false;
    if (message.recipient)
      return Boolean(device.dm && device.user_id === message.recipient);
    if (!dependencies.canAccess(device.user_id, message.channel)) return false;
    if (device.lobby && message.channel === 'The Lobby') return true;
    const user = db
      .prepare('SELECT name FROM users WHERE id=?')
      .get(device.user_id);
    return Boolean(
      device.mentions &&
      user &&
      dependencies.canAccess(device.user_id, message.channel) &&
      mentionedHandles(message.text).has(String(user.name).toLowerCase()),
    );
  }
  // Called inside the message transaction: retries of the same nonce do not enqueue twice.
  function enqueue(messageId: number) {
    if (!send) return;
    const message = db
      .prepare('SELECT * FROM messages WHERE id=?')
      .get(messageId) as Message;
    const devices = db
      .prepare(`SELECT d.* FROM push_devices d JOIN sessions s ON s.token_hash=d.session_hash
      WHERE s.expires>?`)
      .all(Date.now()) as Device[];
    for (const device of devices)
      if (eligible(device, message))
        db.prepare(
          'INSERT OR IGNORE INTO push_outbox(token,message_id,next_attempt) VALUES(?,?,?)',
        ).run(device.token, messageId, Date.now());
  }
  let running: Promise<void> | undefined;
  let stopped = false;
  async function drain() {
    if (!send || stopped) return;
    const now = Date.now();
    db.prepare(
      `DELETE FROM push_devices WHERE updated_at<? OR session_hash IN (SELECT token_hash FROM sessions WHERE expires<=?)`,
    ).run(now - 60 * 86400_000, now);
    db.prepare(
      `DELETE FROM push_outbox WHERE attempts>=8 OR message_id IN (SELECT id FROM messages WHERE created_at<?)`,
    ).run(now - 86400_000);
    const jobs = db
      .prepare(
        'SELECT token,message_id,attempts FROM push_outbox WHERE next_attempt<=? ORDER BY message_id LIMIT 25',
      )
      .all(now) as { token: string; message_id: number; attempts: number }[];
    for (const job of jobs) {
      if (stopped) break;
      const device = db
        .prepare('SELECT * FROM push_devices WHERE token=?')
        .get(job.token) as Device | undefined;
      const message = db
        .prepare('SELECT * FROM messages WHERE id=?')
        .get(job.message_id) as Message | undefined;
      const remove = () =>
        db
          .prepare('DELETE FROM push_outbox WHERE token=? AND message_id=?')
          .run(job.token, job.message_id);
      if (
        !device ||
        !message ||
        !eligible(device, message) ||
        !db
          .prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires>?')
          .get(device.session_hash, Date.now())
      ) {
        remove();
        continue;
      }
      const params = new URLSearchParams(
        message.recipient
          ? { peer: message.user_id }
          : { channel: message.channel },
      );
      params.set('account', device.user_id);
      try {
        const result = await send({
          token: device.token,
          data: {
            account: device.user_id,
            link: `/#${params}`,
            kind: message.recipient
              ? 'dm'
              : device.lobby && message.channel === 'The Lobby'
                ? 'channel'
                : 'mention',
            messageId: String(message.id),
          },
        });
        if (result === 'invalid')
          db.prepare(
            'DELETE FROM push_devices WHERE token=? AND session_hash=?',
          ).run(job.token, device.session_hash);
        else remove();
      } catch {
        // Never log tokens, payloads, service-account data or provider error bodies.
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'push-retry',
            attempt: job.attempts + 1,
          }),
        );
        db.prepare(
          'UPDATE push_outbox SET attempts=attempts+1,next_attempt=? WHERE token=? AND message_id=?',
        ).run(
          Date.now() + Math.min(3600000, 15000 * 2 ** job.attempts),
          job.token,
          job.message_id,
        );
      }
    }
  }
  function flush(): Promise<void> {
    if (!running)
      running = drain().finally(() => {
        running = undefined;
      });
    return running;
  }
  const timer = send
    ? setInterval(() => {
        void flush().catch(() => {
          console.warn(
            JSON.stringify({ level: 'warn', event: 'push-worker-failed' }),
          );
        });
      }, 5000)
    : undefined;
  timer?.unref();
  async function close() {
    stopped = true;
    clearInterval(timer);
    await running;
  }
  return { register, enqueue, flush, close, enabled: Boolean(send) };
}
