'use client';
import { useEffect, useState } from 'react';
type AdminState = {
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
  return data as T;
}
export function AdminPanel() {
  const [state, setState] = useState<AdminState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
            confirm: confirmation,
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
          {pending.action.startsWith('restore') ? 'Restore' : 'Remove'}{' '}
          {pending.label}
        </h3>
        <p className="field-help">
          {pending.action === 'remove-user'
            ? 'This revokes every session and disconnects voice. The account cannot sign in until restored. Its handle and history are retained.'
            : pending.action === 'remove-channel'
              ? 'Members leave voice and return to The Lobby. The channel disappears from the channel list; history is retained for restoration.'
              : 'This restores access. Removed user sessions stay revoked.'}
        </p>
        <label>
          Type {pending.label} to confirm
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            required
          />
        </label>
        {error && (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        )}
        <button
          className="dialog-action"
          disabled={busy || confirmation !== pending.label}
        >
          {busy ? 'Applying…' : 'Confirm'}
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
          <h3>Accounts</h3>
          <div className="admin-list">
            {state.users.map((user) => (
              <div key={user.id}>
                <span>
                  {user.name}
                  <small>
                    @{user.handle} ·{' '}
                    {user.isAdmin
                      ? 'Admin'
                      : user.disabled
                        ? 'Removed'
                        : 'Member'}
                  </small>
                </span>
                {!user.isAdmin && (
                  <button
                    onClick={() =>
                      choose(
                        user.disabled ? 'restore-user' : 'remove-user',
                        user.id,
                        user.handle,
                      )
                    }
                  >
                    {user.disabled ? 'Restore' : 'Remove'}
                  </button>
                )}
              </div>
            ))}
          </div>
          <h3>Channels</h3>
          <div className="admin-list">
            {state.channels.map((channel) => (
              <div key={channel.name}>
                <span>
                  {channel.name}
                  {!!channel.archived && <small>Removed</small>}
                </span>
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
