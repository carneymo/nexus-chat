'use client';
import { useEffect, useState } from 'react';
type AdminState = {
  registrationOpen: boolean;
  registrationAllowed: boolean;
  membership: {
    id: string;
    handle: string;
    isAdmin: number;
    disabled: number;
    inviteId: string | null;
    reviewedAt: number | null;
    sessions: number;
  }[];
  invites?: { id: string; expires: number }[];
  reports?: {
    id: number;
    reporter: string;
    message_id: number;
    reason: string;
    messageText?: string;
    reportedHandle?: string;
    resolved: number;
  }[];
  audit?: {
    id: number;
    actor: string;
    action: string;
    target: string;
    created_at: number;
  }[];
  users: {
    id: string;
    handle: string;
    name: string;
    isAdmin: number;
    disabled: number;
  }[];
  channels: { name: string; archived: number }[];
};
type Pending = { action: string; target: string; label: string };
async function admin<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/admin/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(data.error || 'Admin request failed.');
  if (
    path === 'state' &&
    !Array.isArray((data as Partial<AdminState>).membership)
  )
    throw new Error(
      'Server management is temporarily unavailable because the app and gateway versions do not match. Restart the gateway, then reopen this panel.',
    );
  return data as T;
}
export function AdminPanel() {
  const [state, setState] = useState<AdminState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteFeedback, setInviteFeedback] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function securityChange(body: unknown) {
    setBusy(true);
    setError('');
    try {
      await admin('security', body);
      setState(await admin<AdminState>('state'));
      setInviteUrl('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void admin<AdminState>('state')
      .then((data) => {
        if (active) setState(data);
      })
      .catch((cause) => {
        if (active) setError(String(cause.message));
      });
    return () => {
      active = false;
    };
  }, []);
  function choose(action: string, target: string, label: string) {
    setPending({ action, target, label });
    setConfirmation('');
    setError('');
  }
  if (pending)
    return (
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          void admin('action', {
            action: pending.action,
            target: pending.target,
            confirm:
              pending.action === 'delete-channel'
                ? confirmation
                : pending.label,
          })
            .then(() => admin<AdminState>('state'))
            .then((data) => {
              setState(data);
              setPending(null);
            })
            .catch((cause) => setError(String(cause.message)))
            .finally(() => setBusy(false));
        }}
      >
        <h3>
          {pending.action === 'delete-channel'
            ? 'Permanently delete'
            : pending.action.startsWith('restore')
              ? pending.action === 'restore-user'
                ? 'Restore access for'
                : 'Restore'
              : pending.action === 'remove-user'
                ? 'Remove access for'
                : 'Remove'}{' '}
          <strong>&ldquo;{pending.label}&rdquo;</strong>
        </h3>
        <p className="field-help">
          {pending.action === 'delete-channel'
            ? 'This permanently deletes the channel, its channel messages, images, and activity sessions. It cannot be restored. Direct messages are kept.'
            : pending.action === 'remove-user'
              ? 'They will be signed out immediately and cannot sign in again until you restore access. Their messages are kept.'
              : pending.action === 'remove-channel'
                ? 'Members leave voice and return to The Lobby. The channel disappears from the channel list; history is retained for restoration.'
                : 'This restores access. Removed user sessions stay revoked.'}
        </p>
        {pending.action === 'delete-channel' && (
          <label>
            <span>
              Type <strong>&ldquo;{pending.label}&rdquo;</strong> to confirm
              (without quotes)
            </span>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              required
            />
          </label>
        )}
        {error && (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        )}
        <button
          className="dialog-action"
          disabled={
            busy ||
            (pending.action === 'delete-channel' &&
              confirmation !== pending.label)
          }
        >
          {busy
            ? 'Applying…'
            : pending.action === 'remove-user'
              ? 'Remove access'
              : pending.action === 'restore-user'
                ? 'Restore access'
                : 'Confirm'}
        </button>
        <button
          type="button"
          className="dialog-action"
          disabled={busy}
          onClick={() => setPending(null)}
        >
          Cancel
        </button>
      </form>
    );
  return (
    <div className="admin-panel">
      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      {!state ? (
        <p>Loading server management…</p>
      ) : (
        <>
          <section className="invite-management">
            <h3>Invite someone</h3>
            <p className="field-help">
              Send a private link. One person can use it to create an account
              within seven days.
            </p>
            {!state.registrationAllowed ? (
              <output>New members are disabled in server settings.</output>
            ) : !state.registrationOpen ? (
              <div className="admission-status">
                <p>
                  New members are paused. Existing members can still sign in.
                </p>
                <button
                  className="invite-action"
                  disabled={busy}
                  onClick={() =>
                    void securityChange({
                      action: 'registration',
                      open: true,
                      confirm: 'OPEN',
                    })
                  }
                >
                  Allow new members
                </button>
              </div>
            ) : null}
            {state.registrationOpen && (
              <button
                className="dialog-action"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError('');
                  setInviteFeedback('');
                  void admin<{ url: string }>('invites', {})
                    .then(async (result) => {
                      setInviteUrl(result.url);
                      setState(await admin<AdminState>('state'));
                    })
                    .catch((cause) => setError(cause.message))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? 'Working…' : 'Invite someone'}
              </button>
            )}
            {inviteUrl && (
              <>
                <label>
                  Invite link
                  <input
                    aria-label="Invite link"
                    readOnly
                    value={inviteUrl}
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                <button
                  className="invite-action invite-copy"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(inviteUrl)
                      .then(() => setInviteFeedback('Invite link copied.'))
                      .catch(() =>
                        setInviteFeedback('Select the link above and copy it.'),
                      );
                  }}
                >
                  Copy invite link
                </button>
              </>
            )}
            <output>{inviteFeedback}</output>
            {!!state.invites?.length && (
              <details>
                <summary>Active invite links ({state.invites.length})</summary>
                {state.invites.map((invite) => (
                  <div className="invite-row" key={invite.id}>
                    <span>
                      Expires {new Date(invite.expires).toLocaleDateString()}
                    </span>
                    <button
                      className="invite-action"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        void admin('invites', { revoke: invite.id })
                          .then(async () => {
                            setInviteUrl('');
                            setState(await admin<AdminState>('state'));
                          })
                          .catch((cause) => setError(cause.message))
                          .finally(() => setBusy(false));
                      }}
                    >
                      Cancel link
                    </button>
                  </div>
                ))}
              </details>
            )}
            {state.registrationOpen && (
              <details>
                <summary>Pause new members</summary>
                <p className="field-help">
                  Stops all invite links from accepting new accounts. Existing
                  members can still sign in. Links work again when you allow new
                  members.
                </p>
                <button
                  className="invite-action"
                  disabled={busy}
                  onClick={() =>
                    void securityChange({
                      action: 'registration',
                      open: false,
                      confirm: 'CLOSE',
                    })
                  }
                >
                  Pause new members
                </button>
              </details>
            )}
          </section>
          <h3>Members</h3>
          <div className="admin-list member-access-list">
            {state.users.map((user) => (
              <div key={user.id}>
                <span>
                  {user.name}
                  <small>
                    @{user.handle} ·{' '}
                    {user.isAdmin
                      ? 'Admin'
                      : user.disabled
                        ? 'Access removed'
                        : 'Has access'}
                  </small>
                </span>
                {!user.isAdmin && (
                  <button
                    className="invite-action"
                    disabled={busy}
                    aria-label={`${user.disabled ? 'Restore' : 'Remove'} access for @${user.handle}`}
                    onClick={() =>
                      choose(
                        user.disabled ? 'restore-user' : 'remove-user',
                        user.id,
                        user.handle,
                      )
                    }
                  >
                    {user.disabled ? 'Restore access' : 'Remove access'}
                  </button>
                )}
              </div>
            ))}
          </div>
          <details className="membership-review">
            <summary>Review existing members</summary>
            <p className="field-help">
              Confirm that you recognize accounts created before private
              invitations were introduced. This records your review; it does not
              change access.
            </p>
            {state.membership
              .filter((member) => !member.reviewedAt && !member.disabled)
              .map((member) => (
                <div className="invite-row" key={member.id}>
                  <span>@{member.handle}</span>
                  <button
                    className="invite-action"
                    disabled={busy}
                    aria-label={`Confirm I recognize @${member.handle}`}
                    onClick={() =>
                      void securityChange({
                        action: 'review',
                        target: member.id,
                        confirm: member.handle,
                      })
                    }
                  >
                    I recognize them
                  </button>
                </div>
              ))}
            {!state.membership.some(
              (member) => !member.reviewedAt && !member.disabled,
            ) && <p>All active members reviewed.</p>}
          </details>
          <details>
            <summary>Reports & moderation log</summary>
            {state.reports
              ?.filter((r) => !r.resolved)
              .map((r) => (
                <div className="social-card" key={r.id}>
                  <p>
                    Report #{r.id} · Message #{r.message_id}
                  </p>
                  <p>
                    @{r.reportedHandle}: {r.messageText}
                  </p>
                  <p>{r.reason}</p>
                  <button
                    onClick={() => {
                      void fetch('/api/community', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          action: 'report-resolve',
                          reportId: r.id,
                        }),
                      })
                        .then(async (response) => {
                          if (!response.ok)
                            throw new Error('Unable to resolve report.');
                          setState(await admin<AdminState>('state'));
                        })
                        .catch((cause) => setError(cause.message));
                    }}
                  >
                    Mark resolved
                  </button>
                </div>
              ))}
            {state.audit?.map((entry) => (
              <p key={entry.id}>
                {new Date(entry.created_at).toLocaleString()} · {entry.action} ·{' '}
                {entry.target}
              </p>
            ))}
          </details>
          <h3>Channels</h3>
          <div className="admin-list">
            {state.channels.map((channel) => (
              <div key={channel.name}>
                <span>
                  {channel.name}
                  {!!channel.archived && <small>Removed</small>}
                </span>
                {!!channel.archived && channel.name !== 'The Lobby' && (
                  <button
                    onClick={() =>
                      choose('delete-channel', channel.name, channel.name)
                    }
                  >
                    Delete permanently
                  </button>
                )}
                {channel.name !== 'The Lobby' && (
                  <button
                    onClick={() =>
                      choose(
                        channel.archived ? 'restore-channel' : 'remove-channel',
                        channel.name,
                        channel.name,
                      )
                    }
                  >
                    {channel.archived ? 'Restore' : 'Remove'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
