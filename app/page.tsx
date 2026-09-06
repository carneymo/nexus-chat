'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import {
  Radio,
  Users,
  Plus,
  LogIn,
  Settings,
  Power,
  Volume2,
  VolumeX,
  ChevronRight,
  Shield,
  Signal,
  Hash,
  X,
  Lock,
  Copy,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { cue } from '@/lib/audio';
import { LegacyScrollArea } from '@/components/legacy-scroll-area';
import { registerDraftTool } from '@/lib/webmcp';

type Member = { id: string; name: string; channel: string; online: boolean };
type Message = {
  id: number;
  name: string;
  userId: string;
  text: string;
  channel: string;
  recipient: string | null;
  createdAt: number;
};
type State = {
  me: Member | null;
  channels: string[];
  members: Member[];
  messages: Message[];
  serverName: string;
};
type Panel = 'connect' | 'channels' | 'create' | 'friends' | 'settings' | null;
const initial: State = {
  me: null,
  channels: ['The Lobby', 'After Hours', 'Looking for Group'],
  members: [],
  messages: [],
  serverName: 'Nexus',
};
async function api<T = { ok: boolean }>(
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      (data as { error?: string }).error ||
        'Unable to reach the server. Try again.',
    );
  return data as T;
}

export default function Home() {
  const [state, setState] = useState<State>(initial);
  const [panel, setPanel] = useState<Panel>(null);
  const [connected, setConnected] = useState(false);
  const [channel, setChannel] = useState('The Lobby');
  const [recipient, setRecipient] = useState<Member | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState(true);
  const [scanlines, setScanlines] = useState(true);
  const [events, setEvents] = useState<string[]>([]);
  const [clock, setClock] = useState('--:--');
  const [date, setDate] = useState('TODAY');
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const soundRef = useRef(sound);
  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);
  useEffect(() => registerDraftTool(setDraft), []);

  const refresh = useCallback(async () => {
    const next = await api<State>('state');
    setState(next);
    if (next.me) setChannel(next.me.channel);
    return next;
  }, []);
  useEffect(() => {
    const hydrate = setTimeout(() => {
      setSound(localStorage.getItem('nexus-sound') !== 'off');
      setScanlines(localStorage.getItem('nexus-scanlines') !== 'off');
    }, 0);
    const initialRefresh = setTimeout(() => {
      void refresh().catch(() => {});
    }, 0);
    const tick = () => {
      setClock(
        new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
      );
      setDate(
        new Date().toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
        }),
      );
    };
    const firstTick = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(hydrate);
      clearTimeout(firstTick);
      clearTimeout(initialRefresh);
      clearInterval(timer);
    };
  }, [refresh]);
  const viewerId = state.me?.id;
  useEffect(() => {
    if (!viewerId) return;
    const stream = new EventSource('/api/events');
    stream.onopen = () => {
      setConnected(true);
      void refresh().catch(() => {});
    };
    stream.onerror = () => {
      setConnected(false);
      void refresh().catch(() => {});
    };
    stream.addEventListener('state', (event) => {
      const update: State = JSON.parse(event.data);
      setState(update);
      if (update.me) setChannel(update.me.channel);
    });
    stream.addEventListener('notice', (event) => {
      const data = JSON.parse(event.data);
      setEvents((previous) => [...previous.slice(-19), data.text]);
      cue(data.kind === 'join' ? 'join' : 'message', soundRef.current);
    });
    return () => {
      stream.close();
      setConnected(false);
    };
  }, [viewerId, refresh]);
  useEffect(() => {
    log.current?.scrollTo({
      top: log.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [state.messages.length, channel, recipient?.id, events.length]);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  }
  function open(next: Panel) {
    setError('');
    setPanel(next);
    cue('click', sound);
  }
  async function join(name: string) {
    if (!state.me) {
      open('connect');
      return;
    }
    await act(async () => {
      await api('channel', { name });
      await refresh();
      setRecipient(null);
      setEvents([]);
      setPanel(null);
      cue('join', sound);
    });
  }
  async function send(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state.me) {
      open('connect');
      return;
    }
    const text = draft.trim();
    if (!text) return;
    if (text === '/help') {
      setEvents((previous) => [
        ...previous,
        '/join channel · /w callsign message · /help',
      ]);
      setDraft('');
      return;
    }
    if (text.startsWith('/join ')) {
      await join(text.slice(6).trim());
      setDraft('');
      return;
    }
    await act(async () => {
      let to = recipient?.id;
      let content = text;
      if (text.startsWith('/w ')) {
        const [, name, ...words] = text.split(' ');
        const member = state.members.find(
          (member) => member.name.toLowerCase() === name?.toLowerCase(),
        );
        if (!member || member.id === state.me?.id)
          throw new Error('Choose another member’s callsign to whisper.');
        to = member.id;
        content = words.join(' ');
        setRecipient(member);
      }
      await api('messages', { text: content, recipient: to });
      setDraft('');
      await refresh();
      input.current?.focus();
    });
  }
  const online = state.members.filter((member) => member.online);
  const roster = online.filter((member) => member.channel === channel);
  const messages = state.messages.filter((message) =>
    recipient
      ? message.recipient &&
        ((message.userId === recipient.id &&
          message.recipient === state.me?.id) ||
          (message.userId === state.me?.id &&
            message.recipient === recipient.id))
      : !message.recipient && message.channel === channel,
  );
  const whisperCount = state.messages.filter(
    (message) => message.recipient === state.me?.id,
  ).length;

  return (
    <main className={`station ${scanlines ? 'crt-on' : ''}`}>
      <div className="outer-status">
        <span>
          <i className="led" /> PRIVATE COMMUNICATIONS NETWORK
        </span>
        <span>
          SECTOR 01 <b> / </b> {clock}
        </span>
      </div>
      <section className="chassis" aria-label="Nexus chat terminal">
        <div className="hardware-top">
          <span className="bolt" />
          <div className="wordmark">
            NEXUS<span>COMMUNICATIONS</span>
          </div>
          <div className="top-vents" />
          <div className="hardware-label">
            PERSONAL GATEWAY
            <br />
            <b>NX–01</b>
          </div>
          <span className="bolt" />
        </div>
        <header className="banner-frame">
          <div className="banner-screen">
            <div className="banner-kicker">
              <span className="led" /> GATEWAY /{' '}
              {state.serverName.toUpperCase()}
            </div>
            <div className="banner-title">
              Welcome to <strong>the other side.</strong>
              <span className="cursor">_</span>
            </div>
            <div className="banner-bottom">
              <span>A familiar place. A few good friends.</span>
              <span>
                CHANNEL OPEN. MAKE YOURSELF AT HOME.
                <span className="little-cross"> ✦</span>
              </span>
            </div>
          </div>
          <div className="banner-end">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </header>
        <div className="workspace">
          <nav className="command-rail" aria-label="Main controls">
            <button
              className="metal-button active"
              onClick={() => open('channels')}
            >
              <Radio />
              <span>Channel</span>
              <small>01</small>
            </button>
            <button className="metal-button" onClick={() => open('friends')}>
              <Users />
              <span>Friends</span>
              <small>02</small>
            </button>
            <div className="rail-separator" />
            <button
              className="metal-button"
              onClick={() => open(state.me ? 'create' : 'connect')}
            >
              <Plus />
              <span>Create</span>
              <small>03</small>
            </button>
            <button
              className="metal-button"
              onClick={() => open(state.me ? 'channels' : 'connect')}
            >
              <LogIn />
              <span>Join</span>
              <small>04</small>
            </button>
            <div className="rail-spacer" />
            <button className="metal-button" onClick={() => open('settings')}>
              <Settings />
              <span>Options</span>
              <small>05</small>
            </button>
            <button
              className="metal-button quit"
              onClick={() =>
                state.me
                  ? void act(async () => {
                      await api('logout', {});
                      setState(initial);
                      setRecipient(null);
                      setEvents([]);
                    })
                  : open('connect')
              }
            >
              <Power />
              <span>{state.me ? 'Quit' : 'Connect'}</span>
              <small>06</small>
            </button>
            <div className="rail-bottom">
              <span className="bolt" />
              <div className="vent" />
              <span className="bolt" />
            </div>
          </nav>
          <section className="chat-module">
            <header className="panel-header">
              <div>
                <Hash size={16} />
                <h1>{recipient ? `Whisper: ${recipient.name}` : channel}</h1>
                <span className="channel-tag">
                  {recipient ? 'PRIVATE' : 'CHANNEL'}
                </span>
              </div>
              <span className="header-count">{roster.length} online</span>
            </header>
            <LegacyScrollArea
              className="chat-screen"
              viewportRef={log}
              role="log"
              aria-label="Conversation"
              aria-live="polite"
            >
              <div className="channel-intro">
                <div className="intro-mark">
                  <Radio size={25} strokeWidth={1.25} />
                </div>
                <p>YOU HAVE REACHED</p>
                <h2>{recipient ? recipient.name : channel}</h2>
                <span>
                  {recipient
                    ? 'Only you and this friend can read these whispers.'
                    : 'The games change. The crew stays the same.'}
                </span>
              </div>
              <div className="day-divider">
                <span /> {date} <span />
              </div>
              <div className="system-lines">
                <p>
                  <span>»</span> Welcome to {state.serverName}. Make yourself at
                  home.
                </p>
                <p>
                  <span>»</span>{' '}
                  {state.me
                    ? `Signed in as ${state.me.name}.`
                    : 'Your friends are one connection away.'}
                </p>
                <p className="muted">
                  <span>»</span>{' '}
                  {state.me
                    ? 'Type /help for channel commands.'
                    : 'Choose Connect to enter your callsign and join the channel.'}
                </p>
              </div>
              {messages.map((message) => (
                <div
                  className={`message ${message.recipient ? 'private-message' : ''}`}
                  key={message.id}
                >
                  <time title={new Date(message.createdAt).toLocaleString()}>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </time>
                  <div>
                    <button
                      className="callsign"
                      onClick={() => {
                        const member = state.members.find(
                          (member) => member.id === message.userId,
                        );
                        if (member && member.id !== state.me?.id)
                          setRecipient(member);
                      }}
                    >{`<${message.name}>`}</button>{' '}
                    <span>{message.text}</span>
                  </div>
                </div>
              ))}
              {events.map((event, index) => (
                <p className="event-line" key={`${event}-${index}`}>
                  » {event}
                </p>
              ))}
              {!state.me && (
                <button
                  className="connect-inline"
                  onClick={() => open('connect')}
                >
                  <ChevronRight size={15} /> Enter the channel
                </button>
              )}
            </LegacyScrollArea>
            {recipient && (
              <div className="whisper-strip">
                <Lock size={13} /> Whispering to {recipient.name}
                <button
                  onClick={() => setRecipient(null)}
                  aria-label="Return to channel"
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {error && (
              <p className="error-strip" role="alert">
                {error}
              </p>
            )}
            <form className="composer" onSubmit={send}>
              <span className="prompt">›</span>
              <input
                ref={input}
                aria-label="Message"
                placeholder={
                  state.me
                    ? `Message ${recipient?.name || channel}…`
                    : 'Connect to join the conversation…'
                }
                maxLength={2000}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                autoComplete="off"
              />
              <button
                className="send-button"
                disabled={busy || (!!state.me && !draft.trim())}
                type="submit"
              >
                Send <ChevronRight size={15} />
              </button>
            </form>
            <div className="composer-help">
              <span>
                <kbd>ENTER</kbd> to send <span className="help-divider">/</span>{' '}
                <button
                  onClick={() =>
                    setEvents((previous) => [
                      ...previous,
                      '/join channel · /w callsign message · /help',
                    ])
                  }
                >
                  /help
                </button>{' '}
                for commands
              </span>
              <span>{draft.length} / 2000</span>
            </div>
          </section>
          <aside className="roster-module">
            <header className="panel-header">
              <h2>In this channel</h2>
              <span className="roster-number">
                {roster.length.toString().padStart(2, '0')}
              </span>
            </header>
            <div className="roster-screen">
              <div className="roster-label">
                <span className="led" /> ONLINE — {roster.length}
              </div>
              {roster.length > 0 && (
                <LegacyScrollArea
                  className="roster-list"
                  aria-label="Online members"
                >
                  {roster.map((member) => (
                    <button
                      key={member.id}
                      className={`member ${recipient?.id === member.id ? 'selected' : ''}`}
                      onClick={() =>
                        member.id !== state.me?.id && setRecipient(member)
                      }
                    >
                      <span className="member-avatar">
                        {member.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="member-name">
                        {member.name}
                        <small>
                          {member.id === state.me?.id
                            ? 'You · ready to chat'
                            : 'In the channel'}
                        </small>
                      </span>
                      <Signal className="signal" size={17} />
                    </button>
                  ))}
                </LegacyScrollArea>
              )}
              {roster.length === 0 && (
                <div className="roster-empty">
                  <Users size={27} strokeWidth={1} />
                  <p>A quiet channel.</p>
                  <span>
                    {state.me
                      ? 'Send a friend your gateway link.'
                      : 'Connect and make it yours.'}
                  </span>
                </div>
              )}
              <div className="roster-info">
                <Shield size={15} />
                <span>
                  Just you and your people.
                  <br />
                  Invite-only. Always.
                </span>
              </div>
            </div>
            <div className="channel-details">
              <span>CHANNEL INFO</span>
              <h3>{channel}</h3>
              <p>A place to hang out between games.</p>
              <div>
                <span>Access</span>
                <b>
                  <Lock size={11} /> Invite only
                </b>
              </div>
              <div>
                <span>Gateway</span>
                <b>{state.serverName}</b>
              </div>
              <button
                onClick={() =>
                  void act(async () => {
                    await navigator.clipboard.writeText(window.location.origin);
                    setEvents((previous) => [
                      ...previous,
                      'Gateway link copied. Share the invite code separately.',
                    ]);
                  })
                }
              >
                <Copy size={13} /> Copy gateway link
              </button>
            </div>
            <button
              className="whisper-button"
              onClick={() =>
                recipient ? input.current?.focus() : open('friends')
              }
            >
              <Lock size={14} /> Whisper{' '}
              <span>{whisperCount.toString().padStart(2, '0')}</span>
            </button>
          </aside>
        </div>
        <footer className="station-footer">
          <span>
            <i className={`led ${connected ? '' : 'offline'}`} />
            {connected
              ? 'CONNECTED'
              : state.me
                ? 'RECONNECTING'
                : 'STANDING BY'}
            <b>·</b>
            {state.me?.name || 'No callsign'}
          </span>
          <div>
            <span>
              {online.length} {online.length === 1 ? 'friend' : 'friends'}{' '}
              online
            </span>
            <button
              onClick={() => {
                const enabled = !sound;
                setSound(enabled);
                localStorage.setItem('nexus-sound', enabled ? 'on' : 'off');
                cue('join', enabled);
              }}
              aria-label={sound ? 'Mute sounds' : 'Enable sounds'}
            >
              {sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
              <span>SOUND {sound ? 'ON' : 'OFF'}</span>
            </button>
            <span className="bolt" />
          </div>
        </footer>
      </section>
      <div className="under-chassis">
        <span>
          NEXUS <b> / </b> YOUR OWN LITTLE CORNER OF THE INTERNET
        </span>
        <span>NO FEED. NO NOISE. JUST FRIENDS.</span>
      </div>
      <Dialog
        open={panel !== null}
        onOpenChange={(value) => !value && setPanel(null)}
      >
        <DialogContent className="nexus-dialog">
          <DialogTitle>
            {panel === 'connect'
              ? 'Establish connection'
              : panel === 'channels'
                ? 'Select channel'
                : panel === 'create'
                  ? 'Create channel'
                  : panel === 'friends'
                    ? 'Your friends'
                    : 'Terminal options'}
          </DialogTitle>
          <DialogDescription>
            {panel === 'connect'
              ? 'Choose a callsign. Your password keeps it yours.'
              : panel === 'channels'
                ? 'Find a place for your next conversation.'
                : panel === 'create'
                  ? 'Open a new channel for your crew.'
                  : panel === 'friends'
                    ? 'Select a friend to open a private whisper.'
                    : 'Tune your corner of the network.'}
          </DialogDescription>
          {panel === 'connect' && (
            <form
              className="dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                void act(async () => {
                  await api('login', Object.fromEntries(fields));
                  await refresh();
                  setPanel(null);
                  cue('join', sound);
                });
              }}
            >
              <label>
                Callsign
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={20}
                  pattern="[A-Za-z0-9_-]+"
                  placeholder="e.g. Raynor"
                  autoComplete="username"
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  minLength={10}
                  maxLength={128}
                  required
                  autoComplete="current-password"
                  placeholder="At least 10 characters"
                />
              </label>
              <label>
                Server invite code
                <input
                  name="invite"
                  type="password"
                  maxLength={128}
                  placeholder="Required for your first connection"
                  autoComplete="off"
                />
              </label>
              <p className="field-help">
                First time? Your callsign is registered when you connect with an
                invite code.
              </p>
              <button className="dialog-action" disabled={busy}>
                {busy ? 'Connecting…' : 'Connect to gateway'}
              </button>
            </form>
          )}
          {panel === 'channels' && (
            <div className="channel-list">
              {state.channels.map((name) => (
                <button
                  key={name}
                  disabled={busy}
                  onClick={() => void join(name)}
                >
                  <Hash size={17} />
                  <span>{name}</span>
                  <small>
                    {online.filter((member) => member.channel === name).length}{' '}
                    online
                  </small>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          )}
          {panel === 'create' && (
            <form
              className="dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                void join(fields.get('name') as string);
              }}
            >
              <label>
                Channel name
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={32}
                  placeholder="The War Room"
                />
              </label>
              <button className="dialog-action" disabled={busy}>
                Create & join
              </button>
            </form>
          )}
          {panel === 'friends' && (
            <div className="channel-list">
              {state.members
                .filter((member) => member.id !== state.me?.id)
                .map((member) => (
                  <button
                    key={member.id}
                    onClick={() => {
                      setRecipient(member);
                      setPanel(null);
                      input.current?.focus();
                    }}
                  >
                    <i className={`led ${member.online ? '' : 'offline'}`} />
                    <span>{member.name}</span>
                    <small>{member.online ? 'Online' : 'Offline'}</small>
                    <Lock size={14} />
                  </button>
                ))}
              {state.members.filter((member) => member.id !== state.me?.id)
                .length === 0 && (
                <p className="field-help">
                  Your crew will appear here after they connect. Share your
                  gateway link and invite code to bring them in.
                </p>
              )}
            </div>
          )}
          {panel === 'settings' && (
            <div className="dialog-form">
              <label className="option-row" htmlFor="sound-toggle">
                Sound effects
                <Checkbox
                  id="sound-toggle"
                  checked={sound}
                  onCheckedChange={(value) => {
                    setSound(value);
                    localStorage.setItem('nexus-sound', value ? 'on' : 'off');
                    cue('join', value);
                  }}
                />
              </label>
              <button
                className="preview-sound"
                onClick={() => cue('join', true)}
              >
                <Volume2 size={15} /> Test join sound
              </button>
              <label className="option-row" htmlFor="crt-toggle">
                CRT scanlines
                <Checkbox
                  id="crt-toggle"
                  checked={scanlines}
                  onCheckedChange={(value) => {
                    setScanlines(value);
                    localStorage.setItem(
                      'nexus-scanlines',
                      value ? 'on' : 'off',
                    );
                  }}
                />
              </label>
              <label>
                Custom join sound URL
                <input
                  placeholder="/sounds/join.wav"
                  defaultValue={
                    typeof window !== 'undefined'
                      ? localStorage.getItem('nexus-audio-join') || ''
                      : ''
                  }
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (
                      value &&
                      !value.startsWith('/sounds/') &&
                      !value.startsWith('https://')
                    ) {
                      setError('Use a /sounds/ path or an HTTPS audio URL.');
                      return;
                    }
                    localStorage.setItem('nexus-audio-join', value);
                  }}
                />
              </label>
              <p className="field-help">
                An original synth cue is included. Use your own audio file to
                customize the arrival sound.
              </p>
            </div>
          )}
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
