'use client';
import { useState } from 'react';
export type SocialMember = {
  isAdmin?: number;
  id: string;
  name: string;
  handle?: string;
  channel: string;
  online: boolean;
  presence?: string;
  awayMessage?: string;
  avatar?: string;
  bio?: string;
  profileLink?: string;
  role?: string;
};
export type CommunityState = {
  channels: {
    name: string;
    visibility: string;
    role: string;
    notices: boolean;
    description?: string;
  }[];
  relationships: {
    requester: string;
    recipient: string;
    accepted: number;
    peer: string;
  }[];
  preferences: {
    peer_id: string;
    blocked: number;
    muted: number;
    pinned: number;
    notify: number;
  }[];
  unread: { peer: string; count: number }[];
  activities: {
    id: string;
    host: string;
    channel: string;
    activity: string;
    title: string;
    capacity: number;
    starts_at: number;
    expires_at: number;
    visibility: string;
    join_link: string;
    members: string[];
    invited: boolean;
  }[];
  settings: {
    homeChannel: string;
    presence: string;
    awayMessage: string;
    locationPrivacy: string;
    activityPrivacy: string;
    friendsOnlyDM: boolean;
    joinNotices: boolean;
    bio: string;
    avatar: string;
    profileLink: string;
  };
};
type Props = {
  state: CommunityState;
  me: SocialMember;
  members: SocialMember[];
  mutate: (data: Record<string, unknown>) => Promise<void>;
};
const optionLabels: Record<string, string> = {
  dnd: 'Do Not Disturb',
  'channel-invite': 'Invite to channel',
  'channel-kick': 'Kick from channel',
  'channel-ban': 'Ban from channel',
  'channel-unban': 'Lift channel ban',
  'channel-role': 'Set member role',
};
function Select({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value?: string;
  options: string[];
  onChange?: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select
        name={name}
        aria-label={label}
        defaultValue={value}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabels[option] || option}
          </option>
        ))}
      </select>
    </label>
  );
}
export function SocialSettings({ state, mutate }: Props) {
  const [saved, setSaved] = useState(false);
  const s = state.settings;
  return (
    <form
      className="dialog-form social-form"
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        setSaved(false);
        void mutate({
          action: 'settings',
          ...Object.fromEntries(f),
          friendsOnlyDM: f.has('friendsOnlyDM'),
          joinNotices: f.has('joinNotices'),
        })
          .then(() => setSaved(true))
          .catch(() => {});
      }}
    >
      <h3>Presence & privacy</h3>
      <Select
        name="homeChannel"
        label="Home channel"
        value={s.homeChannel}
        options={state.channels.map((c) => c.name)}
      />
      <Select
        name="presence"
        label="Status"
        value={s.presence}
        options={['online', 'away', 'dnd']}
      />
      <label>
        Away message
        <input
          name="awayMessage"
          maxLength={120}
          defaultValue={s.awayMessage}
        />
      </label>
      <Select
        name="locationPrivacy"
        label="Who can see my channel elsewhere?"
        value={s.locationPrivacy}
        options={['everyone', 'friends', 'nobody']}
      />
      <Select
        name="activityPrivacy"
        label="Who can see my activities?"
        value={s.activityPrivacy}
        options={['everyone', 'friends', 'nobody']}
      />
      <p className="field-help">
        People in your channel see you there. Private channel access is always
        required. Do Not Disturb silences alerts; messages still arrive.
      </p>
      <label className="option-row">
        Friends-only direct messages
        <input
          type="checkbox"
          name="friendsOnlyDM"
          defaultChecked={s.friendsOnlyDM}
        />
      </label>
      <label className="option-row">
        Show join/leave notices
        <input
          type="checkbox"
          name="joinNotices"
          defaultChecked={s.joinNotices}
        />
      </label>
      <Select
        name="avatar"
        label="Avatar"
        value={s.avatar}
        options={['◈', '✦', '★', '☾', '⚔', '♜', '☀', '◆']}
      />
      <label>
        Bio
        <textarea name="bio" maxLength={500} defaultValue={s.bio} />
      </label>
      <label>
        Profile link (optional HTTPS)
        <input name="profileLink" type="url" defaultValue={s.profileLink} />
      </label>
      <button className="dialog-action">Save preferences</button>
      {saved && <output>Preferences saved.</output>}
    </form>
  );
}
export function SessionInvites({
  state,
  me,
  peer,
  mutate,
}: Pick<Props, 'state' | 'me' | 'mutate'> & { peer: SocialMember }) {
  const [feedback, setFeedback] = useState('');
  if (peer.id === me.id) return null;
  return (
    <div className="social-actions">
      {state.activities
        .filter((s) => s.host === me.id)
        .map((s) => (
          <button
            key={s.id}
            onClick={() =>
              void mutate({
                action: 'session-invite',
                sessionId: s.id,
                peer: peer.id,
              })
                .then(() => setFeedback('Invitation sent.'))
                .catch(() => {})
            }
          >
            Invite to {s.title}
          </button>
        ))}
      {feedback && <output>{feedback}</output>}
    </div>
  );
}
export function FriendsPanel({
  state,
  me,
  members,
  mutate,
  whisper,
  profile,
}: Props & {
  whisper: (member: SocialMember) => void;
  profile: (id: string) => void;
}) {
  const [directory, setDirectory] = useState(false);
  const list = members
    .filter(
      (m) =>
        m.id !== me.id &&
        (directory ||
          state.relationships.some((r) => r.peer === m.id) ||
          state.unread.some((u) => u.peer === m.id) ||
          state.preferences.some((p) => p.peer_id === m.id && p.blocked)),
    )
    .sort(
      (a, b) =>
        Number(state.preferences.find((p) => p.peer_id === b.id)?.pinned || 0) -
          Number(
            state.preferences.find((p) => p.peer_id === a.id)?.pinned || 0,
          ) ||
        Number(b.online) - Number(a.online) ||
        a.name.localeCompare(b.name),
    );
  return (
    <div className="social-form">
      <button
        className="dialog-action"
        onClick={() => setDirectory(!directory)}
      >
        {directory ? 'Show friends & conversations' : 'Find people'}
      </button>
      {!list.length && <p>No friends yet. Find people to send a request.</p>}
      {list.map((m) => {
        const r = state.relationships.find((r) => r.peer === m.id),
          p = state.preferences.find((p) => p.peer_id === m.id);
        const update = (key: string, value: boolean) =>
          void mutate({
            action: 'peer-preferences',
            peer: m.id,
            blocked: Boolean(p?.blocked),
            muted: Boolean(p?.muted),
            pinned: Boolean(p?.pinned),
            notify: Boolean(p?.notify),
            [key]: value,
          }).catch(() => {});
        return (
          <section className="social-card" key={m.id}>
            <button className="profile-link" onClick={() => profile(m.id)}>
              {m.avatar || '◈'} {m.name} <small>@{m.handle}</small>
            </button>
            <p className={m.online ? 'friend-online' : 'friend-offline'}>
              {m.online
                ? m.presence === 'dnd'
                  ? 'Do Not Disturb'
                  : m.presence || 'Online'
                : 'Offline'}
              {m.online && m.channel ? ` · In ${m.channel}` : ''}
              {m.online && m.awayMessage ? ` · ${m.awayMessage}` : ''}
            </p>
            <div className="social-actions">
              <button onClick={() => whisper(m)}>
                Whisper
                {state.unread.find((u) => u.peer === m.id)?.count
                  ? ` (${state.unread.find((u) => u.peer === m.id)!.count})`
                  : ''}
              </button>
              {!r && !p?.blocked && (
                <button
                  onClick={() =>
                    void mutate({ action: 'friend-request', peer: m.id }).catch(
                      () => {},
                    )
                  }
                >
                  Add friend
                </button>
              )}
              {r && !r.accepted && r.recipient === me.id && (
                <button
                  onClick={() =>
                    void mutate({ action: 'friend-accept', peer: m.id }).catch(
                      () => {},
                    )
                  }
                >
                  Accept request
                </button>
              )}
              {r && (
                <button
                  onClick={() =>
                    void mutate({ action: 'friend-remove', peer: m.id }).catch(
                      () => {},
                    )
                  }
                >
                  {r.accepted
                    ? 'Remove friend'
                    : r.requester === me.id
                      ? 'Cancel request'
                      : 'Decline'}
                </button>
              )}
              <button
                aria-pressed={Boolean(p?.blocked)}
                onClick={() => update('blocked', !p?.blocked)}
              >
                {p?.blocked ? 'Unblock' : 'Block'}
              </button>
              <button
                aria-pressed={Boolean(p?.muted)}
                onClick={() => update('muted', !p?.muted)}
              >
                {p?.muted ? 'Unmute text' : 'Mute text'}
              </button>
              {Boolean(r?.accepted) && (
                <>
                  <button
                    aria-pressed={Boolean(p?.pinned)}
                    onClick={() => update('pinned', !p?.pinned)}
                  >
                    {p?.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    aria-pressed={Boolean(p?.notify)}
                    onClick={() => update('notify', !p?.notify)}
                  >
                    {p?.notify ? 'Online alerts on' : 'Online alerts off'}
                  </button>
                </>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
export function ChannelControls({ state, me, members, mutate }: Props) {
  const [action, setAction] = useState('channel-invite');
  const [feedback, setFeedback] = useState('');
  const update = (data: Record<string, unknown>) =>
    mutate(data).then(() => setFeedback('Channel updated.'));
  const c = state.channels.find((c) => c.name === me.channel);
  if (!c) return null;
  return (
    <div className="social-form">
      {feedback && <output>{feedback}</output>}
      <p>
        {c.visibility} · {c.role || 'visitor'}
      </p>
      <button
        className="dialog-action"
        onClick={() =>
          void navigator.clipboard
            .writeText(
              location.origin + '/?channel=' + encodeURIComponent(c.name),
            )
            .then(() => setFeedback('Channel link copied.'))
            .catch(() =>
              setFeedback(
                'Copy this link: ' +
                  location.origin +
                  '/?channel=' +
                  encodeURIComponent(c.name),
              ),
            )
        }
      >
        Copy channel link
      </button>
      {(me.isAdmin || ['owner', 'moderator'].includes(c.role)) && (
        <>
          <h3>Channel management</h3>
          {(me.isAdmin || c.role === 'owner') && (
            <form
              className="dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                const f = new FormData(event.currentTarget);
                void update({
                  action: 'channel-settings',
                  channel: c.name,
                  visibility: f.get('visibility'),
                  description: f.get('description'),
                  notices: f.has('notices'),
                }).catch(() => {});
              }}
            >
              <label>
                Description
                <input
                  name="description"
                  maxLength={280}
                  defaultValue={c.description || ''}
                  placeholder="What is this channel for?"
                />
              </label>
              <Select
                name="visibility"
                label="Access"
                value={c.visibility}
                options={['public', 'unlisted', 'invite-only']}
              />
              <label>
                Channel join/leave notices{' '}
                <input
                  type="checkbox"
                  name="notices"
                  defaultChecked={c.notices}
                />
              </label>
              <button className="dialog-action">Save channel</button>
            </form>
          )}
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              const f = new FormData(event.currentTarget);
              void update({ channel: c.name, ...Object.fromEntries(f) }).catch(
                () => {},
              );
            }}
          >
            <label>
              Account
              <select name="peer">
                {members
                  .filter((m) => m.id !== me.id)
                  .map((m) => (
                    <option value={m.id} key={m.id}>
                      {m.name} (@{m.handle})
                    </option>
                  ))}
              </select>
            </label>
            <Select
              name="action"
              label="Action"
              onChange={setAction}
              options={[
                'channel-invite',
                'channel-kick',
                'channel-ban',
                'channel-unban',
                ...(me.isAdmin || c.role === 'owner' ? ['channel-role'] : []),
              ]}
            />
            {action === 'channel-role' &&
              (me.isAdmin || c.role === 'owner') && (
                <Select
                  name="role"
                  label="Role when assigning"
                  options={['member', 'moderator']}
                />
              )}
            {['channel-kick', 'channel-ban'].includes(action) && (
              <label>
                Reason
                <input
                  name="reason"
                  defaultValue="Removed by moderator"
                  maxLength={200}
                />
              </label>
            )}
            <button className="dialog-action">Apply to account</button>
            <p className="field-help">
              Kick removes current membership; public channels can be rejoined.
              A ban prevents rejoining until explicitly lifted. Inviting never
              overrides a ban.
            </p>
          </form>
        </>
      )}
    </div>
  );
}
export function SessionsPanel({ state, me, members, mutate }: Props) {
  const [feedback, setFeedback] = useState('');
  return (
    <div className="social-form">
      <h3>Open sessions</h3>
      {feedback && <output>{feedback}</output>}
      {!state.activities.length && (
        <p>No open sessions visible to you. Start something together.</p>
      )}
      {state.activities.map((s) => (
        <section className="social-card" key={s.id}>
          <h3>{s.title}</h3>
          {s.invited && <p>Invited by the host</p>}
          <p>
            {s.activity} ·{' '}
            {members.find((m) => m.id === s.host)?.name || 'Host'} ·{' '}
            {s.members.length}/{s.capacity}
          </p>
          <p>
            {new Date(s.starts_at).toLocaleString()} · {s.channel} ·{' '}
            {s.visibility}
          </p>
          <p>
            {s.members
              .map((id) => members.find((m) => m.id === id)?.name || 'Member')
              .join(', ')}
          </p>
          {s.join_link && s.members.includes(me.id) && (
            <a href={s.join_link} target="_blank" rel="noopener noreferrer">
              Open external join link
            </a>
          )}
          <div className="social-actions">
            {s.host === me.id ? (
              <>
                <button
                  onClick={() =>
                    void mutate({
                      action: 'session-close',
                      sessionId: s.id,
                    }).catch(() => {})
                  }
                >
                  Close
                </button>
                <button
                  onClick={() =>
                    void mutate({
                      action: 'session-cancel',
                      sessionId: s.id,
                    }).catch(() => {})
                  }
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() =>
                  void mutate({
                    action: s.members.includes(me.id)
                      ? 'session-leave'
                      : 'session-join',
                    sessionId: s.id,
                  }).catch(() => {})
                }
              >
                {s.members.includes(me.id) ? 'Leave' : 'Join session'}
              </button>
            )}
          </div>
          {s.host === me.id && (
            <form
              className="dialog-form"
              onSubmit={(e) => {
                e.preventDefault();
                void mutate({
                  action: 'session-invite',
                  sessionId: s.id,
                  peer: new FormData(e.currentTarget).get('peer'),
                })
                  .then(() => setFeedback('Invitation sent.'))
                  .catch(() => {});
              }}
            >
              <label>
                Invite a friend or channel member
                <select name="peer">
                  {members
                    .filter(
                      (m) =>
                        m.id !== me.id &&
                        (state.relationships.some(
                          (r) => r.peer === m.id && r.accepted,
                        ) ||
                          (m.online && m.channel === me.channel)),
                    )
                    .map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </label>
              <button>Invite</button>
            </form>
          )}
        </section>
      ))}
      <details>
        <summary>Host a session</summary>
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget);
            void mutate({
              action: 'session-create',
              channel: me.channel,
              ...Object.fromEntries(f),
              capacity: Number(f.get('capacity')),
              startsAt: f.get('start')
                ? new Date(f.get('start') as string).getTime()
                : Date.now(),
            }).catch(() => {});
          }}
        >
          <label>
            Activity
            <input
              name="activity"
              required
              maxLength={60}
              placeholder="StarCraft, board games…"
            />
          </label>
          <label>
            Title
            <input name="title" required maxLength={100} />
          </label>
          <label>
            Capacity (including you)
            <input
              name="capacity"
              type="number"
              min={2}
              max={32}
              defaultValue={4}
              required
            />
          </label>
          <label>
            Start (blank = now)
            <input name="start" type="datetime-local" />
          </label>
          <Select
            name="visibility"
            label="Visibility"
            options={['friends', 'public', 'invite-only']}
          />
          <label>
            External join link (optional)
            <input name="joinLink" type="url" />
          </label>
          <p className="field-help">
            Listings expire four hours after their start. Your activity privacy
            and channel permissions also apply. An explicit invitation shares
            this listing with that person, but never grants private-channel
            access.
          </p>
          <button className="dialog-action">Open session</button>
        </form>
      </details>
    </div>
  );
}
