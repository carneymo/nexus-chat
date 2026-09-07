import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type Channel = {
  name: string;
  owner_id: string | null;
  visibility: string;
  notices: number;
  archived: number;
};
type Activity = {
  id: string;
  host: string;
  channel: string;
  visibility: string;
  expires_at: number;
  status: string;
  capacity: number;
  join_link: string;
};
type Dependencies = {
  fail: (status: number, message: string) => never;
  online: (id: string) => boolean;
  removeVoice: (id: string) => void;
};
export function createCommunity(db: DatabaseSync, dependencies: Dependencies) {
  const { online, removeVoice } = dependencies;
  const fail: Dependencies['fail'] = dependencies.fail;
  const account = (id: string) =>
    db.prepare('SELECT * FROM users WHERE id=? AND disabled=0').get(id);
  const channel = (name: string) =>
    db.prepare('SELECT * FROM channels WHERE name=?').get(name) as
      | Channel
      | undefined;
  const role = (id: string, name: string) =>
    channel(name)?.owner_id === id
      ? 'owner'
      : String(
          db
            .prepare(
              'SELECT role FROM channel_members WHERE channel=? AND user_id=?',
            )
            .get(name, id)?.role || '',
        );
  const blocked = (a: string, b: string) =>
    Boolean(
      db
        .prepare(
          'SELECT 1 FROM peer_preferences WHERE (user_id=? AND peer_id=? OR user_id=? AND peer_id=?) AND blocked=1',
        )
        .get(a, b, b, a),
    );
  const friends = (a: string, b: string) =>
    !blocked(a, b) &&
    Boolean(
      db
        .prepare(
          'SELECT 1 FROM friendships WHERE accepted=1 AND (requester=? AND recipient=? OR requester=? AND recipient=?)',
        )
        .get(a, b, b, a),
    );
  const canAccess = (id: string, name: string) => {
    const c = channel(name);
    return Boolean(
      c &&
      !c.archived &&
      account(id) &&
      !db
        .prepare('SELECT 1 FROM channel_bans WHERE channel=? AND user_id=?')
        .get(name, id) &&
      (c.visibility !== 'invite-only' || role(id, name)),
    );
  };
  function requireAccess(id: string, name: string) {
    if (!canAccess(id, name))
      fail(404, 'Channel unavailable or access not granted.');
  }
  function requireModerator(id: string, name: string) {
    if (
      !account(id)?.is_admin &&
      !['owner', 'moderator'].includes(role(id, name))
    )
      fail(403, 'Channel owner or moderator access required.');
    if (!channel(name) || channel(name)!.archived)
      fail(404, 'Channel unavailable.');
  }
  function audit(actor: string, action: string, target: string) {
    db.prepare(
      'INSERT INTO admin_audit(actor,action,target,created_at) VALUES(?,?,?,?)',
    ).run(actor, action, target, Date.now());
  }
  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function text(value: unknown, max: number, required = true) {
    if (
      typeof value !== 'string' ||
      value.length > max ||
      (required && !value.trim()) ||
      /[\p{Cc}\p{Cf}]/u.test(value)
    )
      fail(400, `Use ${required ? '1' : '0'}–${max} printable characters.`);
    return value.trim();
  }
  function choice(value: unknown, choices: string[]) {
    if (typeof value !== 'string' || !choices.includes(value))
      fail(400, 'Choose a supported option.');
    return value;
  }
  function link(value: unknown) {
    const v = text(value ?? '', 500, false);
    if (v) {
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:' || u.username || u.password) throw Error();
      } catch {
        fail(400, 'Use an HTTPS link without embedded credentials.');
      }
    }
    return v;
  }
  function peer(value: unknown, id: string) {
    const p = text(value, 100);
    if (p === id || !account(p)) fail(404, 'Choose another active account.');
    return p;
  }
  function visibleLocation(viewer: string, id: string, name: string) {
    const user = account(id);
    if (viewer === id) return true;
    if (!user || blocked(viewer, id) || !canAccess(viewer, name)) return false;
    const me = account(viewer);
    return (
      (online(viewer) && online(id) && me?.channel === name) ||
      user.location_privacy === 'everyone' ||
      (user.location_privacy === 'friends' && friends(viewer, id))
    );
  }
  function channelList(id?: string) {
    return (
      db
        .prepare('SELECT * FROM channels WHERE archived=0 ORDER BY rowid')
        .all() as Channel[]
    )
      .filter((c) =>
        id
          ? canAccess(id, c.name) &&
            (c.visibility === 'public' ||
              Boolean(role(id, c.name)) ||
              account(id)?.channel === c.name)
          : c.visibility === 'public',
      )
      .map((c) => ({
        name: c.name,
        visibility: c.visibility,
        role: id ? role(id, c.name) : '',
        notices: Boolean(c.notices),
      }));
  }
  function allowDM(sender: string, recipient: string) {
    const target = account(recipient);
    if (
      !target ||
      blocked(sender, recipient) ||
      (target.friends_only_dm && !friends(sender, recipient))
    )
      fail(403, 'This account is not accepting your direct messages.');
  }
  function shouldNotify(id: string, source?: string, kind?: string) {
    const u = account(id);
    if (!u || u.presence === 'dnd') return false;
    if (
      source &&
      (blocked(id, source) ||
        db
          .prepare(
            'SELECT muted FROM peer_preferences WHERE user_id=? AND peer_id=?',
          )
          .get(id, source)?.muted)
    )
      return false;
    return !['join', 'leave'].includes(kind || '') || Boolean(u.join_notices);
  }
  const messageColumns =
    "m.id, COALESCE(u.display_name,u.name) AS name,u.name AS handle,u.color,m.user_id AS userId,CASE WHEN m.recipient IS NULL THEN m.channel ELSE '' END AS channel,m.recipient,m.text,m.kind,m.created_at AS createdAt";
  function history(
    id: string,
    scope: {
      channel?: string;
      peer?: string;
      before?: number;
      after?: number;
      query?: string;
    },
  ) {
    for (const cursor of [scope.before, scope.after])
      if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
        fail(400, 'Invalid history cursor.');
    const parameters: (string | number)[] = [];
    let condition = '';
    if (scope.peer) {
      if (
        scope.peer === id ||
        !db.prepare('SELECT id FROM users WHERE id=?').get(scope.peer)
      )
        fail(404, 'Conversation unavailable.');
      condition =
        'm.recipient IS NOT NULL AND ((m.user_id=? AND m.recipient=?) OR (m.user_id=? AND m.recipient=?))';
      parameters.push(id, scope.peer, scope.peer, id);
    } else {
      const name = scope.channel || String(account(id)?.channel);
      requireAccess(id, name);
      condition = 'm.recipient IS NULL AND m.channel=?';
      parameters.push(name);
    }
    condition +=
      ' AND NOT EXISTS (SELECT 1 FROM peer_preferences p WHERE p.user_id=? AND p.peer_id=m.user_id AND (p.blocked=1 OR p.muted=1))';
    parameters.push(id);
    if (scope.before) {
      condition += ' AND m.id<?';
      parameters.push(scope.before);
    }
    if (scope.after !== undefined) {
      condition += ' AND m.id>?';
      parameters.push(scope.after);
    }
    if (scope.query) {
      condition += ' AND instr(lower(m.text),lower(?))>0';
      parameters.push(text(scope.query, 100));
    }
    return db
      .prepare(
        `SELECT ${messageColumns} FROM messages m JOIN users u ON u.id=m.user_id WHERE ${condition} ORDER BY m.id ${scope.after !== undefined ? 'ASC' : 'DESC'} LIMIT 100`,
      )
      .all(...parameters);
  }
  function activityVisible(id: string, s: Activity) {
    if (!canAccess(id, s.channel) || blocked(id, s.host)) return false;
    if (s.host === id) return true;
    const invited = Boolean(
      db
        .prepare(
          'SELECT 1 FROM activity_invites WHERE session_id=? AND user_id=?',
        )
        .get(s.id, id),
    );
    // An explicit session invitation grants visibility to this listing, never channel access.
    if (invited) return true;
    if (channel(s.channel)?.visibility === 'unlisted' && !role(id, s.channel))
      return false;
    const host = account(s.host);
    if (
      !host ||
      host.activity_privacy === 'nobody' ||
      (host.activity_privacy === 'friends' && !friends(id, s.host))
    )
      return false;
    return (
      s.visibility === 'public' ||
      (s.visibility === 'friends' && friends(id, s.host))
    );
  }
  function snapshot(id: string) {
    const me = account(id);
    if (!me) return {};
    const relationships = db
      .prepare(
        `SELECT f.*,CASE WHEN requester=? THEN recipient ELSE requester END AS peer FROM friendships f WHERE requester=? OR recipient=?`,
      )
      .all(id, id, id)
      .filter((f) => !blocked(id, String(f.peer)));
    const activities = (
      db
        .prepare(
          "SELECT * FROM activity_sessions WHERE status='open' AND expires_at>? ORDER BY starts_at",
        )
        .all(Date.now()) as Activity[]
    )
      .filter((s) => activityVisible(id, s))
      .map((s) => ({
        ...s,
        channel: visibleLocation(id, s.host, s.channel) ? s.channel : '',
        join_link:
          s.host === id ||
          db
            .prepare(
              'SELECT 1 FROM activity_members WHERE session_id=? AND user_id=?',
            )
            .get(s.id, id)
            ? s.join_link
            : '',
        members: db
          .prepare('SELECT user_id FROM activity_members WHERE session_id=?')
          .all(s.id)
          .map((m) => m.user_id),
        invited: Boolean(
          db
            .prepare(
              'SELECT 1 FROM activity_invites WHERE session_id=? AND user_id=?',
            )
            .get(s.id, id),
        ),
      }));
    const unread = db
      .prepare(
        `SELECT m.user_id AS peer,COUNT(*) AS count FROM messages m WHERE m.recipient=? AND m.id>COALESCE((SELECT message_id FROM read_markers WHERE user_id=? AND scope='dm:'||m.user_id),0) AND NOT EXISTS(SELECT 1 FROM peer_preferences p WHERE p.user_id=? AND p.peer_id=m.user_id AND (p.blocked=1 OR p.muted=1)) GROUP BY m.user_id`,
      )
      .all(id, id, id);
    return {
      channels: channelList(id),
      relationships,
      preferences: db
        .prepare('SELECT * FROM peer_preferences WHERE user_id=?')
        .all(id),
      unread,
      activities,
      settings: {
        homeChannel: me.home_channel,
        presence: me.presence,
        awayMessage: me.away_message,
        locationPrivacy: me.location_privacy,
        activityPrivacy: me.activity_privacy,
        friendsOnlyDM: Boolean(me.friends_only_dm),
        joinNotices: Boolean(me.join_notices),
        bio: me.bio,
        avatar: me.avatar,
        profileLink: me.profile_link,
      },
    };
  }
  function join(
    id: string,
    name: string,
    visibility?: unknown,
    existingOnly = false,
  ) {
    if (!/^[A-Za-z0-9 _-]{2,32}$/.test(name))
      fail(400, 'Use 2–32 letters, numbers, spaces, underscores, or hyphens.');
    let c = channel(name);
    if (c?.archived) fail(409, 'This channel was removed by an administrator.');
    if (!c) {
      if (
        Number(
          db
            .prepare('SELECT COUNT(*) AS n FROM channels WHERE archived=0')
            .get()!.n,
        ) >= 32
      )
        fail(409, 'This gateway has reached its 32-channel limit.');
      if (existingOnly)
        fail(404, 'Channel not found. Use Create to open a new channel.');
      const access = choice(visibility ?? 'public', [
        'public',
        'unlisted',
        'invite-only',
      ]);
      transaction(() => {
        db.prepare(
          'INSERT INTO channels(name,owner_id,visibility) VALUES(?,?,?)',
        ).run(name, id, access);
        db.prepare(
          "INSERT INTO channel_members(channel,user_id,role) VALUES(?,?,'owner')",
        ).run(name, id);
      });
      c = channel(name)!;
    }
    requireAccess(id, c.name);
    db.prepare(
      "INSERT OR IGNORE INTO channel_members(channel,user_id,role) VALUES(?,?,'member')",
    ).run(c.name, id);
    db.prepare('UPDATE users SET channel=? WHERE id=?').run(c.name, id);
    return c.name;
  }
  function mutate(id: string, data: Record<string, unknown>) {
    const action = text(data.action, 40);
    for (const key of [
      'friendsOnlyDM',
      'joinNotices',
      'blocked',
      'muted',
      'pinned',
      'notify',
      'notices',
    ]) {
      if (data[key] !== undefined && typeof data[key] !== 'boolean')
        fail(400, 'Preference values must be true or false.');
    }
    if (action === 'settings') {
      const home = text(data.homeChannel, 32);
      requireAccess(id, home);
      db.prepare(
        'UPDATE users SET home_channel=?,presence=?,away_message=?,location_privacy=?,activity_privacy=?,friends_only_dm=?,join_notices=?,bio=?,avatar=?,profile_link=? WHERE id=?',
      ).run(
        channel(home)!.name,
        choice(data.presence, ['online', 'away', 'dnd']),
        text(data.awayMessage ?? '', 120, false),
        choice(data.locationPrivacy, ['everyone', 'friends', 'nobody']),
        choice(data.activityPrivacy, ['everyone', 'friends', 'nobody']),
        data.friendsOnlyDM === true ? 1 : 0,
        data.joinNotices === true ? 1 : 0,
        text(data.bio ?? '', 500, false),
        choice(data.avatar ?? '◈', ['◈', '✦', '★', '☾', '⚔', '♜', '☀', '◆']),
        link(data.profileLink),
        id,
      );
    } else if (action === 'presence') {
      db.prepare('UPDATE users SET presence=?,away_message=? WHERE id=?').run(
        choice(data.presence, ['online', 'away', 'dnd']),
        text(data.awayMessage ?? '', 120, false),
        id,
      );
    } else if (
      [
        'friend-request',
        'friend-accept',
        'friend-remove',
        'peer-preferences',
      ].includes(action)
    ) {
      const target = peer(data.peer, id);
      if (action === 'friend-remove')
        db.prepare(
          'DELETE FROM friendships WHERE requester=? AND recipient=? OR requester=? AND recipient=?',
        ).run(id, target, target, id);
      else if (action === 'peer-preferences')
        transaction(() => {
          db.prepare(
            'INSERT INTO peer_preferences(user_id,peer_id,blocked,muted,pinned,notify) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,peer_id) DO UPDATE SET blocked=excluded.blocked,muted=excluded.muted,pinned=excluded.pinned,notify=excluded.notify',
          ).run(
            id,
            target,
            data.blocked === true ? 1 : 0,
            data.muted === true ? 1 : 0,
            data.pinned === true ? 1 : 0,
            data.notify === true ? 1 : 0,
          );
          if (data.blocked === true)
            db.prepare(
              'DELETE FROM friendships WHERE requester=? AND recipient=? OR requester=? AND recipient=?',
            ).run(id, target, target, id);
        });
      else {
        if (blocked(id, target)) fail(403, 'Friend request unavailable.');
        if (action === 'friend-accept') {
          if (
            !db
              .prepare(
                'UPDATE friendships SET accepted=1 WHERE requester=? AND recipient=?',
              )
              .run(target, id).changes
          )
            fail(404, 'No incoming request.');
        } else if (
          !db
            .prepare(
              'SELECT 1 FROM friendships WHERE requester=? AND recipient=? OR requester=? AND recipient=?',
            )
            .get(id, target, target, id)
        )
          db.prepare(
            'INSERT INTO friendships(requester,recipient,created_at) VALUES(?,?,?)',
          ).run(id, target, Date.now());
      }
    } else if (action === 'channel-settings') {
      const name = text(data.channel, 32);
      requireModerator(id, name);
      if (role(id, name) !== 'owner' && !account(id)?.is_admin)
        fail(403, 'Only the owner can change channel access.');
      if (name.toLowerCase() === 'the lobby')
        fail(409, 'The Lobby stays public.');
      transaction(() => {
        db.prepare(
          'UPDATE channels SET visibility=?,notices=? WHERE name=?',
        ).run(
          choice(data.visibility, ['public', 'unlisted', 'invite-only']),
          data.notices === true ? 1 : 0,
          name,
        );
        audit(id, action, name);
      });
    } else if (
      [
        'channel-invite',
        'channel-kick',
        'channel-ban',
        'channel-unban',
        'channel-role',
      ].includes(action)
    ) {
      const name = text(data.channel, 32);
      requireModerator(id, name);
      const target = peer(data.peer, id);
      if (
        name.toLowerCase() === 'the lobby' &&
        ['channel-ban', 'channel-kick'].includes(action)
      )
        fail(409, 'Use server moderation for the permanent Lobby.');
      if (
        account(target)?.is_admin ||
        role(target, name) === 'owner' ||
        (role(target, name) === 'moderator' &&
          role(id, name) !== 'owner' &&
          !account(id)?.is_admin)
      )
        fail(403, 'Cannot moderate this account.');
      transaction(() => {
        if (action === 'channel-invite')
          db.prepare(
            "INSERT OR IGNORE INTO channel_members(channel,user_id,role) VALUES(?,?,'member')",
          ).run(name, target);
        if (action === 'channel-role') {
          if (role(id, name) !== 'owner' && !account(id)?.is_admin)
            fail(403, 'Only the owner appoints moderators.');
          db.prepare(
            'INSERT INTO channel_members(channel,user_id,role) VALUES(?,?,?) ON CONFLICT(channel,user_id) DO UPDATE SET role=excluded.role',
          ).run(name, target, choice(data.role, ['member', 'moderator']));
        }
        if (action === 'channel-unban')
          db.prepare(
            'DELETE FROM channel_bans WHERE channel=? AND user_id=?',
          ).run(name, target);
        if (action === 'channel-ban' || action === 'channel-kick') {
          if (action === 'channel-ban')
            db.prepare(
              'INSERT OR REPLACE INTO channel_bans(channel,user_id,actor,reason,created_at) VALUES(?,?,?,?,?)',
            ).run(
              name,
              target,
              id,
              text(data.reason ?? 'Removed by moderator', 200),
              Date.now(),
            );
          db.prepare(
            'DELETE FROM channel_members WHERE channel=? AND user_id=?',
          ).run(name, target);
          db.prepare(
            'DELETE FROM activity_members WHERE user_id=? AND session_id IN (SELECT id FROM activity_sessions WHERE channel=?)',
          ).run(target, name);
          db.prepare(
            "UPDATE users SET channel='The Lobby' WHERE id=? AND channel=?",
          ).run(target, name);
        }
        audit(id, action, `${name}:${target}`);
      });
      if (action === 'channel-ban' || action === 'channel-kick')
        removeVoice(target);
    } else if (action === 'read') {
      const target = peer(data.peer, id);
      const marker = Number(data.messageId);
      if (!Number.isSafeInteger(marker) || marker < 0)
        fail(400, 'Invalid read marker.');
      const maximum = Number(
        db
          .prepare(
            'SELECT MAX(id) AS id FROM messages WHERE user_id=? AND recipient=?',
          )
          .get(target, id)?.id || 0,
      );
      db.prepare(
        'INSERT INTO read_markers(user_id,scope,message_id) VALUES(?,?,?) ON CONFLICT(user_id,scope) DO UPDATE SET message_id=MAX(message_id,excluded.message_id)',
      ).run(id, 'dm:' + target, Math.min(marker, maximum));
    } else if (action === 'session-create') {
      const name = text(data.channel, 32);
      requireAccess(id, name);
      const capacity = Number(data.capacity),
        start = Number(data.startsAt) || Date.now();
      if (
        !Number.isInteger(capacity) ||
        capacity < 2 ||
        capacity > 32 ||
        !Number.isFinite(start) ||
        start < Date.now() - 60000 ||
        start > Date.now() + 7 * 86400000
      )
        fail(400, 'Choose 2–32 people and a start within the next week.');
      if (
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM activity_sessions WHERE host=? AND status='open' AND expires_at>?",
            )
            .get(id, Date.now())!.n,
        ) >= 3
      )
        fail(409, 'Close an existing session before opening another.');
      const sessionId = randomUUID();
      transaction(() => {
        db.prepare(
          'INSERT INTO activity_sessions(id,host,channel,activity,title,capacity,starts_at,expires_at,visibility,join_link) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(
          sessionId,
          id,
          name,
          text(data.activity, 60),
          text(data.title, 100),
          capacity,
          start,
          start + 4 * 3600000,
          choice(data.visibility, ['public', 'friends', 'invite-only']),
          link(data.joinLink),
        );
        db.prepare(
          'INSERT INTO activity_members(session_id,user_id) VALUES(?,?)',
        ).run(sessionId, id);
      });
    } else if (
      [
        'session-join',
        'session-leave',
        'session-invite',
        'session-close',
        'session-cancel',
      ].includes(action)
    ) {
      const sessionId = text(data.sessionId, 100);
      transaction(() => {
        const s = db
          .prepare('SELECT * FROM activity_sessions WHERE id=?')
          .get(sessionId) as Activity | undefined;
        if (
          !s ||
          s.status !== 'open' ||
          s.expires_at <= Date.now() ||
          !activityVisible(id, s)
        )
          fail(404, 'Session unavailable.');
        if (action === 'session-join') {
          if (
            !db
              .prepare(
                'SELECT 1 FROM activity_members WHERE session_id=? AND user_id=?',
              )
              .get(sessionId, id)
          ) {
            if (
              Number(
                db
                  .prepare(
                    'SELECT COUNT(*) AS n FROM activity_members WHERE session_id=?',
                  )
                  .get(sessionId)!.n,
              ) >= s.capacity
            )
              fail(409, 'This session is full.');
            db.prepare(
              'INSERT INTO activity_members(session_id,user_id) VALUES(?,?)',
            ).run(sessionId, id);
          }
        } else if (action === 'session-leave') {
          if (s.host === id) fail(409, 'Close your session instead.');
          db.prepare(
            'DELETE FROM activity_members WHERE session_id=? AND user_id=?',
          ).run(sessionId, id);
        } else {
          if (s.host !== id) fail(403, 'Only the host can do that.');
          if (action === 'session-invite') {
            const target = peer(data.peer, id);
            allowDM(id, target);
            if (
              !canAccess(target, s.channel) ||
              (!friends(id, target) &&
                !(online(target) && account(target)?.channel === s.channel))
            )
              fail(
                403,
                'Invite a friend or someone present in this channel with access.',
              );
            db.prepare(
              'INSERT OR IGNORE INTO activity_invites(session_id,user_id,actor) VALUES(?,?,?)',
            ).run(sessionId, target, id);
          } else
            db.prepare('UPDATE activity_sessions SET status=? WHERE id=?').run(
              action === 'session-close' ? 'closed' : 'cancelled',
              sessionId,
            );
        }
      });
    } else if (action === 'report') {
      const message = db
        .prepare('SELECT * FROM messages WHERE id=?')
        .get(Number(data.messageId));
      if (!message) fail(404, 'Message unavailable.');
      if (message.recipient) {
        if (message.recipient !== id && message.user_id !== id)
          fail(404, 'Message unavailable.');
      } else requireAccess(id, String(message.channel));
      db.prepare(
        'INSERT INTO reports(reporter,message_id,reason,created_at) VALUES(?,?,?,?)',
      ).run(id, Number(message.id), text(data.reason, 500), Date.now());
    } else if (action === 'report-resolve') {
      if (!account(id)?.is_admin) fail(403, 'Administrator access required.');
      transaction(() => {
        db.prepare('UPDATE reports SET resolved=1 WHERE id=?').run(
          Number(data.reportId),
        );
        audit(id, action, String(data.reportId));
      });
    } else fail(400, 'Unknown community action.');
    for (const user of db
      .prepare('SELECT id,channel FROM users WHERE disabled=0')
      .all()) {
      if (!canAccess(String(user.id), String(user.channel))) {
        db.prepare("UPDATE users SET channel='The Lobby' WHERE id=?").run(
          user.id,
        );
        removeVoice(String(user.id));
      }
    }
  }
  function expire() {
    return Number(
      db
        .prepare(
          "UPDATE activity_sessions SET status='expired' WHERE status='open' AND expires_at<=?",
        )
        .run(Date.now()).changes,
    );
  }
  return {
    expire,
    account,
    channel,
    role,
    blocked,
    friends,
    canAccess,
    requireAccess,
    visibleLocation,
    channelList,
    allowDM,
    shouldNotify,
    messageColumns,
    history,
    snapshot,
    join,
    mutate,
  };
}
