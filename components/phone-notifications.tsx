'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { isAndroidApp, phoneCommand, type PhoneStatus } from '@/lib/mobile';

export function PhoneNotifications({
  userId,
  visible,
}: {
  userId?: string;
  visible: boolean;
}) {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [settings, setSettings] = useState({
    dm: true,
    mentions: true,
    lobby: true,
  });
  const [readyFor, setReadyFor] = useState<string>();
  const [registration, setRegistration] = useState('');
  const [resume, setResume] = useState(0);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active)
        setTarget(
          visible
            ? document.getElementById('phone-notification-options')
            : null,
        );
    });
    return () => {
      active = false;
    };
  }, [visible]);
  useEffect(() => {
    if (!isAndroidApp()) return;
    const receive = (event: Event) =>
      setStatus((event as CustomEvent<PhoneStatus>).detail);
    const resumed = () => {
      setResume((n) => n + 1);
      phoneCommand('ready');
    };
    window.addEventListener('nexus-phone-status', receive);
    window.addEventListener('nexus-resume', resumed);
    phoneCommand('ready');
    return () => {
      window.removeEventListener('nexus-phone-status', receive);
      window.removeEventListener('nexus-resume', resumed);
    };
  }, []);
  useEffect(() => {
    if (!isAndroidApp()) return;
    phoneCommand('session', { account: userId || '' });
    let saved = { dm: true, mentions: true, lobby: true };
    try {
      const value = JSON.parse(
        localStorage.getItem(`nexus-push:${userId}`) || '{}',
      );
      saved = {
        dm: value.dm !== false,
        mentions: value.mentions !== false,
        lobby: value.lobby !== false,
      };
    } catch {
      /* Default preferences survive unavailable storage. */
    }
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setSettings(saved);
        setReadyFor(userId);
      }
    });
    return () => {
      active = false;
    };
  }, [userId]);
  useEffect(() => {
    if (!userId || readyFor !== userId || !status?.token) return;
    const controller = new AbortController();
    const enabled = status.enabled && status.permission;
    const key = `nexus-push-token:${userId}`;
    async function register() {
      setRegistration('Updating phone notifications…');
      let previous: string | null = null;
      try {
        previous = localStorage.getItem(key);
      } catch {
        /* Optional token cleanup. */
      }
      if (previous && previous !== status!.token)
        await fetch('/api/push', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: previous, action: 'remove' }),
        });
      const response = await fetch('/api/push', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: status!.token,
          dm: settings.dm,
          mentions: settings.mentions,
          lobby: settings.lobby,
          ...(enabled ? {} : { action: 'remove' }),
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(
          result.error || 'Phone notifications need a server update.',
        );
      try {
        localStorage.setItem(key, status!.token);
      } catch {
        /* No persistent preferences. */
      }
      setRegistration(
        enabled
          ? 'This phone is registered for notifications.'
          : 'Phone notifications are off.',
      );
    }
    void register().catch((error: Error) => {
      if (!controller.signal.aborted)
        setRegistration(error.message || 'Could not register notifications.');
    });
    return () => controller.abort();
  }, [
    userId,
    readyFor,
    status?.token,
    status?.enabled,
    status?.permission,
    settings.dm,
    settings.mentions,
    settings.lobby,
    resume,
  ]);
  function update(key: 'dm' | 'mentions' | 'lobby', value: boolean) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    try {
      localStorage.setItem(`nexus-push:${userId}`, JSON.stringify(next));
    } catch {
      /* Optional preferences. */
    }
  }
  if (!visible || !userId || !status || !target) return null;
  return createPortal(
    <div className="phone-notifications">
      <h3>Phone notifications</h3>
      {!status.configured ? (
        <p>
          Notifications will be available after the app’s Firebase setup is
          complete.
        </p>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={settings.dm}
              onChange={(event) => update('dm', event.target.checked)}
            />{' '}
            Whispers and direct messages
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.mentions}
              onChange={(event) => update('mentions', event.target.checked)}
            />{' '}
            Mentions of my @handle
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.lobby}
              onChange={(event) => update('lobby', event.target.checked)}
            />{' '}
            New messages in The Lobby
          </label>
          <p>
            Other channels stay quiet unless you are mentioned. Message text
            stays inside Nexus. Blocks, mutes, and Do Not Disturb apply.
          </p>
          <button
            type="button"
            onClick={() =>
              phoneCommand(
                status.enabled ? 'disableNotifications' : 'enableNotifications',
              )
            }
          >
            {status.enabled
              ? 'Turn off phone notifications'
              : 'Enable phone notifications'}
          </button>
          <button
            type="button"
            onClick={() => phoneCommand('notificationSettings')}
          >
            Android notification settings
          </button>
          <button
            type="button"
            onClick={() => {
              if (status.enabled) phoneCommand('enableNotifications');
              setResume((n) => n + 1);
            }}
          >
            Retry registration
          </button>
          <output>
            {status.error ||
              registration ||
              'Enable notifications to register this phone.'}
          </output>
        </>
      )}
    </div>,
    target,
  );
}
