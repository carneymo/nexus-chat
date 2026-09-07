'use client';
/* GIPHY requires direct media URLs; image optimization/proxying is prohibited. */
/* eslint-disable @next/next/no-img-element */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import {
  Radio,
  Menu,
  Headphones,
  MicOff,
  Users,
  Plus,
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
import {
  FriendsPanel,
  SocialSettings,
  ChannelControls,
  type CommunityState,
} from '@/components/community-panel';
import { AdminPanel } from '@/components/admin-panel';
import { GifPicker, GifMessage } from '@/components/gif-picker';
import { gifId, gifReference, isGifFromToday, type Gif } from '@/lib/giphy';
import {
  BlackjackPanel,
  type BlackjackState,
} from '@/components/blackjack-panel';
import { VoicePanel } from '@/components/voice-panel';
import { BlackjackLeaderboard } from '@/components/blackjack-leaderboard';
import type { VoiceMember } from '@/lib/voice-client';
import { mergeMessages, messageCursor } from '@/lib/message-state';
import { messageLinks } from '@/lib/message-links';
import { cue } from '@/lib/audio';
import { LegacyScrollArea } from '@/components/legacy-scroll-area';
import { registerDraftTool } from '@/lib/webmcp';

type Member = {
  presence?: string;
  awayMessage?: string;
  avatar?: string;
  bio?: string;
  profileLink?: string;
  role?: string;
  isAdmin?: number;
  handle?: string;
  color?: string;
  id: string;
  name: string;
  channel: string;
  online: boolean;
};
type Message = {
  kind?: string;
  id: number;
  name: string;
  userId: string;
  text: string;
  channel: string;
  recipient: string | null;
  createdAt: number;
};
type ChatEvent = {
  id: string;
  text: string;
  createdAt: number;
  recipient: string | null;
};
type State = {
  revision?: number;
  generation?: string;
  community?: CommunityState;
  voice?: VoiceMember[];
  blackjack?: BlackjackState;
  me: Member | null;
  channels: string[];
  members: Member[];
  messages: Message[];
  serverName: string;
};
type Panel =
  | 'search'
  | 'connect'
  | 'channels'
  | 'create'
  | 'friends'
  | 'settings'
  | 'admin'
  | 'profile'
  | null;
// Accounts without a chosen profile color use the same stable fallback for every viewer.
const callsignColors = [
  '#83d9ef',
  '#f2a5c5',
  '#b7b0ff',
  '#96dfa9',
  '#ffb58a',
  '#b4d5ff',
  '#e2bfef',
];
function callsignColor(id: string) {
  let hash = 0;
  for (const character of id)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return callsignColors[hash % callsignColors.length];
}
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
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [viewport, setViewport] = useState({
    height: 0,
    top: 0,
    keyboard: false,
  });
  const [panel, setPanel] = useState<Panel>(null);
  const [connected, setConnected] = useState(false);
  const channel = state.me?.channel || 'The Lobby';
  const [selectedRecipient, setRecipient] = useState<Member | null>(null);
  const recipient =
    state.members.find((member) => member.id === selectedRecipient?.id) ||
    selectedRecipient;
  const [draft, setDraft] = useState('');
  const [gifOpen, setGifOpen] = useState(false);
  const [selectedGif, setSelectedGif] = useState<Gif | null>(null);
  const [gifApiKey, setGifApiKey] = useState('');
  const gifUserId = state.me?.id;
  useEffect(() => {
    let active = true;
    if (gifUserId)
      void api<{ apiKey: string }>('gif-config')
        .then((data) => {
          if (active) setGifApiKey(data.apiKey);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [gifUserId]);
  const gifContext = [gifUserId, channel, recipient?.id].join(':');
  const [gifToday, setGifToday] = useState<number | null>(null);
  const [previousGifContext, setPreviousGifContext] = useState(gifContext);
  if (previousGifContext !== gifContext) {
    setPreviousGifContext(gifContext);
    setSelectedGif(null);
    setGifOpen(false);
  }
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const pendingSend = useRef<{ key: string; nonce: string } | null>(null);
  const currentState = useRef(state);
  useEffect(() => {
    currentState.current = state;
  }, [state]);
  const applyState = useCallback(
    (next: State) =>
      setState((previous) => {
        if (
          next.generation === previous.generation &&
          (next.revision || 0) < (previous.revision || 0)
        )
          return previous;
        if (
          !next.me ||
          previous.me?.id !== next.me.id ||
          previous.generation !== next.generation
        )
          return next;
        const denied = new Set(
          next.community?.preferences
            .filter((p) => p.blocked || p.muted)
            .map((p) => p.peer_id) || [],
        );
        return {
          ...next,
          messages: mergeMessages(
            previous.messages,
            next.messages,
            next.me.id,
            next.me.channel,
            denied,
          ),
        };
      }),
    [],
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState(true);
  const [scanlines, setScanlines] = useState(true);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [clock, setClock] = useState('--:--');
  const [date, setDate] = useState('TODAY');
  const log = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const scrollContext = useRef('');
  const scrollRestore = useRef<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const view = log.current;
    if (!view) return;
    let frame = 0;
    let height = view.clientHeight;
    let contentHeight = view.scrollHeight;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followMessages.current && !scrollRestore.current)
          view.scrollTop = view.scrollHeight;
        height = view.clientHeight;
        contentHeight = view.scrollHeight;
      });
    };
    const track = () => {
      // A layout change can emit scroll before ResizeObserver runs. It is not
      // a request to stop following the conversation.
      if (height !== view.clientHeight || contentHeight !== view.scrollHeight) {
        settle();
        return;
      }
      followMessages.current =
        view.scrollHeight - view.scrollTop - view.clientHeight < 80;
    };
    const observer = new ResizeObserver(settle);
    observer.observe(view);
    if (view.firstElementChild) observer.observe(view.firstElementChild);
    view.addEventListener('scroll', track);
    settle();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      view.removeEventListener('scroll', track);
    };
  }, []);
  const input = useRef<HTMLTextAreaElement>(null);
  const soundRef = useRef(sound);
  useEffect(() => {
    const visual = window.visualViewport;
    let baseline = window.innerHeight;
    const sync = () => {
      const height = visual?.height || window.innerHeight;
      const focused = document.activeElement?.matches('input, textarea');
      if (!focused) baseline = Math.max(height, window.innerHeight);
      document.documentElement.style.setProperty(
        '--visible-height',
        height + 'px',
      );
      setViewport({
        height,
        top: visual?.offsetTop || 0,
        keyboard: Boolean(focused && baseline - height > 120),
      });
    };
    sync();
    visual?.addEventListener('resize', sync);
    visual?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);
    return () => {
      visual?.removeEventListener('resize', sync);
      visual?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
      document.documentElement.style.removeProperty('--visible-height');
    };
  }, []);
  useEffect(() => {
    const field = input.current;
    if (field) {
      field.style.height = 'auto';
      field.style.height =
        Math.min(112, Math.max(44, field.scrollHeight + 2)) + 'px';
    }
  }, [draft, viewport]);
  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);
  useEffect(() => registerDraftTool(setDraft), []);

  const refresh = useCallback(async () => {
    const next = await api<State>('state');
    applyState(next);
    return next;
  }, [applyState]);
  useEffect(() => {
    const hydrate = setTimeout(() => {
      setSound(localStorage.getItem('nexus-sound') !== 'off');
      setScanlines(localStorage.getItem('nexus-scanlines') !== 'off');
    }, 0);
    const initialRefresh = setTimeout(() => {
      void refresh().catch(() => {});
    }, 0);
    const tick = () => {
      setGifToday(new Date().setHours(0, 0, 0, 0));
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
    let opened = false;
    let reconnectBaseline: State | null = null;
    stream.onopen = () => {
      setConnected(true);
      const reconnect = opened;
      opened = true;
      const prior = reconnectBaseline || currentState.current;
      reconnectBaseline = null;
      void (async () => {
        const next = await refresh();
        if (!reconnect || next.me?.id !== viewerId) return;
        const scopes = [
          { channel: next.me.channel },
          ...prior.members
            .filter((m) => m.id !== viewerId)
            .map((m) => ({ peer: m.id })),
        ];
        for (const scope of scopes) {
          if ('channel' in scope && scope.channel !== prior.me?.channel)
            continue;
          let after = messageCursor(prior.messages, viewerId, scope);
          if (!after && 'peer' in scope)
            after = Math.max(0, ...prior.messages.map((m) => m.id));
          while (true) {
            const query = new URLSearchParams({
              ...scope,
              after: String(after),
            } as Record<string, string>);
            const page = await api<{ messages: Message[] }>('history?' + query);
            if (!page.messages.length) break;
            setState((previous) =>
              previous.me?.id !== viewerId
                ? previous
                : {
                    ...previous,
                    messages: mergeMessages(
                      previous.messages,
                      page.messages,
                      viewerId,
                      previous.me.channel,
                      previous.community?.preferences
                        .filter((p) => p.blocked || p.muted)
                        .map((p) => p.peer_id),
                    ),
                  },
            );
            after = Math.max(...page.messages.map((m) => m.id));
            if (page.messages.length < 100) break;
          }
        }
      })().catch(() => {});
    };
    stream.onerror = () => {
      reconnectBaseline ||= currentState.current;
      setConnected(false);
      void refresh().catch(() => {});
    };
    stream.addEventListener('state', (event) => {
      const update: State = JSON.parse(event.data);
      applyState(update);
    });
    stream.addEventListener('notice', (event) => {
      const data = JSON.parse(event.data);
      setEvents((previous) => [
        ...previous.slice(-19),
        {
          id: crypto.randomUUID(),
          text: data.text,
          createdAt: data.createdAt ?? Date.now(),
          recipient: null,
        },
      ]);
      cue(data.kind === 'join' ? 'join' : 'message', soundRef.current);
    });
    return () => {
      stream.close();
      setConnected(false);
    };
  }, [viewerId, refresh, applyState]);
  useEffect(() => {
    if (scrollRestore.current && log.current) {
      followMessages.current = false;
      log.current.scrollTop =
        scrollRestore.current.top +
        log.current.scrollHeight -
        scrollRestore.current.height;
      scrollRestore.current = null;
      return;
    }
    const context = viewerId + ':' + channel + ':' + (recipient?.id || '');
    const changed = scrollContext.current !== context;
    scrollContext.current = context;
    if (changed) followMessages.current = true;
    if (!followMessages.current) return;
    log.current?.scrollTo({
      top: log.current.scrollHeight,
      behavior: 'instant',
    });
  }, [state.messages.length, viewerId, channel, recipient?.id, events.length]);
  function addEvent(text: string) {
    setEvents((previous) => [
      ...previous.slice(-19),
      {
        id: crypto.randomUUID(),
        text,
        createdAt: Date.now(),
        recipient: recipient?.id ?? null,
      },
    ]);
  }
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
    setMobileMenu(false);
    setError('');
    setSearchResults([]);
    setPanel(next);
    cue('click', sound);
  }
  async function join(name: string, visibility?: string) {
    if (!state.me) {
      open('connect');
      return;
    }
    await act(async () => {
      await api('channel', {
        name,
        visibility,
        existingOnly: visibility === undefined,
      });
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
    if (selectedGif) {
      const text = [draft.trim(), gifReference(selectedGif.id)]
        .filter(Boolean)
        .join('\n');
      if (text.length > 2000) {
        setError('Message and GIF must fit within 2000 characters.');
        return;
      }
      await act(async () => {
        const key = JSON.stringify([recipient?.id || channel, text, 'text']);
        if (pendingSend.current?.key !== key)
          pendingSend.current = { key, nonce: crypto.randomUUID() };
        await api('messages', {
          text,
          recipient: recipient?.id,
          channel: recipient ? undefined : channel,
          kind: 'text',
          nonce: pendingSend.current.nonce,
        });
        pendingSend.current = null;
        setSelectedGif(null);
        setDraft('');
        await refresh();
        input.current?.focus();
      });
      return;
    }
    const text = draft.trim();
    if (!text) return;
    if (text === '/join') {
      open('channels');
      setDraft('');
      return;
    }
    if (text === '/w') {
      open('friends');
      setDraft('');
      return;
    }
    if (
      text.startsWith('/') &&
      !/^\/(?:help|join|w|r|me|away|dnd)(?: |$)/.test(text)
    ) {
      addEvent('Unknown command. Use /help to see commands.');
      return;
    }
    if (text === '/help') {
      addEvent(
        '/join channel · /w handle message · /r message · /me action · /away message · /dnd · /help. Options controls presence and privacy; Friends opens whispers.',
      );
      setDraft('');
      return;
    }
    if (text.startsWith('/join ')) {
      await join(text.slice(6).trim());
      setDraft('');
      return;
    }
    if (text === '/away' || text.startsWith('/away ') || text === '/dnd') {
      await act(async () => {
        await api('community', {
          action: 'presence',
          presence:
            text === '/dnd'
              ? state.me?.presence === 'dnd'
                ? 'online'
                : 'dnd'
              : text === '/away' && state.me?.presence === 'away'
                ? 'online'
                : 'away',
          awayMessage: text.startsWith('/away ') ? text.slice(6) : '',
        });
        await refresh();
        setDraft('');
      });
      return;
    }
    await act(async () => {
      let to = recipient?.id;
      let content = text;
      if (text.startsWith('/w ')) {
        const [, name, ...words] = text.split(' ');
        const member = state.members.find(
          (member) =>
            (member.handle || member.name).toLowerCase() ===
            name?.toLowerCase(),
        );
        if (!member || member.id === state.me?.id)
          throw new Error('Choose another member’s callsign to whisper.');
        to = member.id;
        content = words.join(' ');
        setRecipient(member);
      }
      if (text.startsWith('/r ')) {
        const last = [...state.messages]
          .reverse()
          .find((m) => m.recipient === state.me?.id);
        if (!last) throw new Error('No direct-message sender to reply to yet.');
        to = last.userId;
        content = text.slice(3);
        setRecipient(state.members.find((m) => m.id === to) || null);
      }
      followMessages.current = true;
      const kind = text.startsWith('/me ') ? 'action' : 'text';
      if (kind === 'action') content = text.slice(4);
      const key = JSON.stringify([to || channel, content, kind]);
      if (pendingSend.current?.key !== key)
        pendingSend.current = { key, nonce: crypto.randomUUID() };
      await api('messages', {
        text: content,
        recipient: to,
        channel: to ? undefined : channel,
        kind,
        nonce: pendingSend.current.nonce,
      });
      pendingSend.current = null;
      setDraft('');
      await refresh();
      input.current?.focus();
    });
  }
  async function mutate(data: Record<string, unknown>) {
    setError('');
    try {
      await api('community', data);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
      throw cause;
    }
  }
  function whisper(member: Member) {
    setRecipient(member);
    setPanel(null);
    input.current?.focus();
  }
  useEffect(() => {
    if (!viewerId || !recipient?.id || document.visibilityState !== 'visible')
      return;
    const latest = Math.max(
      0,
      ...state.messages
        .filter((m) => m.userId === recipient.id && m.recipient === viewerId)
        .map((m) => m.id),
    );
    if (
      state.community?.unread.some((u) => u.peer === recipient.id && u.count) &&
      latest
    )
      void api('community', {
        action: 'read',
        peer: recipient.id,
        messageId: latest,
      }).catch(() => {});
  }, [viewerId, recipient?.id, state.messages, state.community?.unread]);
  const sharedLinkApplied = useRef(false);
  useEffect(() => {
    if (!viewerId) {
      sharedLinkApplied.current = false;
      return;
    }
    if (sharedLinkApplied.current) return;
    sharedLinkApplied.current = true;
    const name = new URLSearchParams(location.search).get('channel');
    if (name)
      void api('channel', { name, existingOnly: true })
        .then(() => refresh())
        .catch((cause) => setError(cause.message));
  }, [viewerId, refresh]);
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
  const timeline = [
    ...messages.map((message) => ({
      ...message,
      messageKind: message.kind,
      kind: 'message' as const,
    })),
    ...events
      .filter((event) => event.recipient === (recipient?.id ?? null))
      .map((event) => ({ kind: 'event' as const, ...event })),
  ].sort((a, b) => a.createdAt - b.createdAt);
  const voiceByUser = new Map(
    (state.voice || [])
      .filter((person) => person.channel === channel)
      .map((person) => [person.userId, person]),
  );
  const whisperCount =
    state.community?.unread.reduce((total, u) => total + u.count, 0) || 0;

  return (
    <main
      className={`station ${scanlines ? 'crt-on' : ''} ${mobileMenu ? 'mobile-menu-open' : ''} ${viewport.keyboard ? 'keyboard-open' : ''} ${state.me ? 'is-signed-in' : ''}`}
      style={
        viewport.height
          ? ({
              '--visible-height': viewport.height + 'px',
              '--visible-top': viewport.top + 'px',
            } as React.CSSProperties)
          : undefined
      }
    >
      <div className="outer-status">
        <span>
          <i className="led" /> PRIVATE COMMUNICATIONS NETWORK
        </span>
        <span>
          SECTOR 01 <b> / </b> {clock}
        </span>
      </div>
      <section className="chassis" aria-label="Nexus chat terminal">
        <div className="mobile-topbar">
          <span className="mobile-wordmark">
            NEXUS{' '}
            <small>
              <i className="led" />
              {state.me ? 'CONNECTED' : 'GATEWAY'}
            </small>
          </span>
          <button
            aria-label="Open navigation"
            aria-expanded={mobileMenu}
            onClick={() => setMobileMenu(!mobileMenu)}
          >
            {mobileMenu ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
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
              <span>Channels</span>
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
            <button
              className="metal-button mobile-copy"
              onClick={() =>
                void act(async () => {
                  await navigator.clipboard.writeText(window.location.origin);
                  addEvent(
                    'Gateway link copied. Share the invite code separately.',
                  );
                  setMobileMenu(false);
                })
              }
            >
              <Copy />
              <span>Copy link</span>
            </button>
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
              <div className="mobile-channel-actions">
                <button
                  onClick={() => open('channels')}
                  aria-label="Choose channel"
                >
                  <Radio size={18} />
                </button>
                <button
                  onClick={() => open('friends')}
                  aria-label="Show friends and members"
                >
                  <Users size={18} />
                </button>
              </div>
            </header>
            <VoicePanel
              key={`${viewerId}-${channel}`}
              channel={channel}
              userId={viewerId}
              members={state.voice || []}
            />
            {state.me && state.blackjack && !recipient && (
              <BlackjackPanel
                table={state.blackjack}
                sound={sound}
                userId={state.me.id}
                refresh={refresh}
              />
            )}
            <LegacyScrollArea
              className="chat-screen"
              viewportRef={log}
              role="log"
              aria-label="Conversation"
              aria-live="polite"
            >
              {state.me && (
                <div className="history-tools">
                  <button
                    className="history-button"
                    onClick={() =>
                      void act(async () => {
                        const query = new URLSearchParams(
                          recipient ? { peer: recipient.id } : { channel },
                        );
                        query.set(
                          'before',
                          String(
                            Math.min(
                              ...messages.map((m) => m.id),
                              Number.MAX_SAFE_INTEGER,
                            ),
                          ),
                        );
                        const page = await api<{ messages: Message[] }>(
                          'history?' + query,
                        );
                        const view = log.current;
                        if (view && page.messages.length)
                          scrollRestore.current = {
                            height: view.scrollHeight,
                            top: view.scrollTop,
                          };
                        setState((previous) =>
                          !previous.me
                            ? previous
                            : {
                                ...previous,
                                messages: mergeMessages(
                                  previous.messages,
                                  page.messages,
                                  previous.me.id,
                                  previous.me.channel,
                                  previous.community?.preferences
                                    .filter((p) => p.blocked || p.muted)
                                    .map((p) => p.peer_id),
                                ),
                              },
                        );
                        if (!page.messages.length)
                          addEvent('No earlier messages.');
                      })
                    }
                  >
                    Load earlier messages
                  </button>
                  <button
                    className="history-button"
                    onClick={() => open('search')}
                  >
                    Search
                  </button>
                </div>
              )}
              <div className="channel-intro">
                <p>YOU HAVE REACHED</p>
                <h2>{recipient ? recipient.name : channel}</h2>
                <span>
                  {recipient
                    ? 'A private conversation between your accounts.'
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
              {timeline.map((message) =>
                message.kind === 'event' ? (
                  <p className="event-line" key={message.id}>
                    » {message.text}
                  </p>
                ) : (
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
                        style={{
                          color:
                            state.members.find(
                              (member) => member.id === message.userId,
                            )?.color || callsignColor(message.userId),
                        }}
                        onClick={() => {
                          const member = state.members.find(
                            (member) => member.id === message.userId,
                          );
                          if (member) {
                            setProfileId(member.id);
                            open('profile');
                          }
                        }}
                      >
                        {message.messageKind === 'action'
                          ? `* ${state.members.find((m) => m.id === message.userId)?.name || message.name}`
                          : `<${state.members.find((m) => m.id === message.userId)?.name || message.name}>`}
                      </button>{' '}
                      <span>
                        {message.text.split('\n').map((line, lineIndex) =>
                          gifId(line) ? (
                            <GifMessage
                              key={lineIndex}
                              id={gifId(line)!}
                              apiKey={gifApiKey}
                              autoLoad={isGifFromToday(
                                message.createdAt,
                                gifToday,
                              )}
                            />
                          ) : (
                            <span key={lineIndex}>
                              {messageLinks(line).map((part, index) =>
                                part.href ? (
                                  <a
                                    key={index}
                                    className="message-link"
                                    href={part.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {part.text}
                                  </a>
                                ) : (
                                  part.text
                                ),
                              )}
                              {lineIndex < message.text.split('\n').length - 1
                                ? '\n'
                                : ''}
                            </span>
                          ),
                        )}
                      </span>
                    </div>
                  </div>
                ),
              )}
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
            {draft.startsWith('/') && !draft.includes(' ') && (
              <div
                className="command-suggestions"
                aria-label="Command suggestions"
              >
                {['/join', '/w', '/r', '/me', '/away', '/dnd', '/help']
                  .filter((command) => command.startsWith(draft))
                  .map((command) => (
                    <button
                      key={command}
                      onClick={() => {
                        setDraft(command + ' ');
                        input.current?.focus();
                      }}
                    >
                      {command}
                    </button>
                  ))}
              </div>
            )}
            {selectedGif && (
              <div className="gif-draft">
                <img
                  src={selectedGif.still}
                  alt={selectedGif.title}
                  referrerPolicy="no-referrer"
                />
                <span>Ready to send · Powered By GIPHY</span>
                <button
                  aria-label="Remove GIF"
                  onClick={() => setSelectedGif(null)}
                >
                  <X size={18} />
                </button>
              </div>
            )}
            {gifOpen && (
              <GifPicker
                open={gifOpen}
                onClose={() => setGifOpen(false)}
                onSelect={setSelectedGif}
                apiKey={gifApiKey}
              />
            )}
            <form className="composer" onSubmit={send}>
              <span className="prompt">›</span>
              <textarea
                rows={1}
                onFocus={() => setMobileMenu(false)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Tab' &&
                    draft.startsWith('/') &&
                    !draft.includes(' ')
                  ) {
                    const suggestion = [
                      '/join',
                      '/w',
                      '/r',
                      '/me',
                      '/away',
                      '/dnd',
                      '/help',
                    ].find((command) => command.startsWith(draft));
                    if (suggestion) {
                      event.preventDefault();
                      setDraft(suggestion + ' ');
                      return;
                    }
                  }
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    window.matchMedia('(min-width: 801px)').matches
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
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
              {state.me && (
                <button
                  type="button"
                  className="gif-button"
                  aria-label="Choose GIF"
                  onClick={() => setGifOpen(true)}
                >
                  GIF
                </button>
              )}
              <button
                className="send-button"
                disabled={busy || (!!state.me && !draft.trim() && !selectedGif)}
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
                    addEvent('/join channel · /w callsign message · /help')
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
                      onClick={() => (setProfileId(member.id), open('profile'))}
                    >
                      <span className="member-avatar">
                        {member.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span
                        className="member-name"
                        style={{
                          color: member.color || callsignColor(member.id),
                        }}
                      >
                        {member.name}{' '}
                        {member.role === 'owner'
                          ? ' · Owner'
                          : member.role === 'moderator'
                            ? ' · Mod'
                            : ''}
                        <small>
                          {member.id === state.me?.id
                            ? member.presence === 'online'
                              ? 'You · ready to chat'
                              : `You · ${member.presence}`
                            : member.presence === 'online'
                              ? 'In the channel'
                              : member.presence === 'dnd'
                                ? 'Do Not Disturb'
                                : `Away${member.awayMessage ? ' · ' + member.awayMessage : ''}`}
                        </small>
                      </span>
                      {voiceByUser.has(member.id) && (
                        <span
                          className="member-voice"
                          title={
                            voiceByUser.get(member.id)?.muted
                              ? 'In voice — microphone muted'
                              : 'In voice'
                          }
                          aria-label={
                            voiceByUser.get(member.id)?.muted
                              ? 'In voice — microphone muted'
                              : 'In voice'
                          }
                        >
                          {voiceByUser.get(member.id)?.muted ? (
                            <MicOff size={15} />
                          ) : (
                            <Headphones size={15} />
                          )}
                          <span>Voice</span>
                        </span>
                      )}
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
                  A private gateway for your crew.
                </span>
              </div>
            </div>
            {state.blackjack ? (
              <BlackjackLeaderboard
                players={state.blackjack.leaderboard || []}
              />
            ) : (
              <div className="channel-details">
                <span>CHANNEL INFO</span>
                <h3>{channel}</h3>
                <p>A place to hang out between games.</p>
                <div>
                  <span>Access</span>
                  <b>
                    <Lock size={11} />{' '}
                    {state.community?.channels.find((c) => c.name === channel)
                      ?.visibility || 'public'}
                  </b>
                </div>
                <div>
                  <span>Gateway</span>
                  <b>{state.serverName}</b>
                </div>
                <button
                  onClick={() =>
                    void act(async () => {
                      await navigator.clipboard.writeText(
                        window.location.origin,
                      );
                      addEvent(
                        'Gateway link copied. Share the invite code separately.',
                      );
                    })
                  }
                >
                  <Copy size={13} /> Copy gateway link
                </button>
              </div>
            )}
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
              {
                online.filter((m) =>
                  state.community?.relationships.some(
                    (r) => r.peer === m.id && r.accepted,
                  ),
                ).length
              }{' '}
              friends online
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
            {panel === 'search'
              ? 'Search conversation'
              : panel === 'connect'
                ? authMode === 'register'
                  ? 'Create account'
                  : 'Welcome back'
                : panel === 'channels'
                  ? 'Select channel'
                  : panel === 'create'
                    ? 'Create channel'
                    : panel === 'friends'
                      ? 'Your friends'
                      : panel === 'profile'
                        ? 'Member profile'
                        : panel === 'admin'
                          ? 'Server management'
                          : 'Terminal options'}
          </DialogTitle>
          {error && (
            <p role="alert" className="error-strip">
              {error}
            </p>
          )}
          <DialogDescription>
            {panel === 'connect'
              ? 'One account keeps your identity and history together.'
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
                  await api(authMode, {
                    ...Object.fromEntries(fields),
                    mode: authMode,
                  });
                  await refresh();
                  setPanel(null);
                  cue('join', sound);
                });
              }}
            >
              <div className="auth-mode">
                <button
                  type="button"
                  aria-pressed={authMode === 'login'}
                  onClick={() => {
                    setAuthMode('login');
                    setError('');
                  }}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  aria-pressed={authMode === 'register'}
                  onClick={() => {
                    setAuthMode('register');
                    setError('');
                  }}
                >
                  Create account
                </button>
              </div>
              <label>
                Account handle
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
                  autoComplete={
                    authMode === 'register'
                      ? 'new-password'
                      : 'current-password'
                  }
                  placeholder="At least 10 characters"
                />
              </label>
              {authMode === 'register' && (
                <label>
                  Server invite code
                  <input
                    name="invite"
                    required
                    type="password"
                    maxLength={128}
                    placeholder="Required only to create your account"
                    autoComplete="off"
                  />
                </label>
              )}
              <p className="field-help">
                {authMode === 'register'
                  ? 'Your account handle stays permanent. You can change your display name later.'
                  : 'No invite code needed. Your session stays signed in for 30 days.'}
              </p>
              <button className="dialog-action" disabled={busy}>
                {busy
                  ? 'Connecting…'
                  : authMode === 'register'
                    ? 'Create account'
                    : 'Sign in'}
              </button>
            </form>
          )}
          {panel === 'search' && (
            <div className="social-form">
              <form
                className="dialog-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const q = new FormData(e.currentTarget).get('q') as string;
                  void act(async () => {
                    const query = new URLSearchParams({
                      ...(recipient ? { peer: recipient.id } : { channel }),
                      q,
                    });
                    setSearchResults(
                      (await api<{ messages: Message[] }>('search?' + query))
                        .messages,
                    );
                  });
                }}
              >
                <label>
                  Search this {recipient ? 'conversation' : 'channel'}
                  <input name="q" required maxLength={100} />
                </label>
                <button className="dialog-action">Search</button>
              </form>
              {searchResults.map((m) => (
                <p key={m.id}>
                  <strong>
                    {state.members.find((person) => person.id === m.userId)
                      ?.name || m.name}
                  </strong>{' '}
                  · {new Date(m.createdAt).toLocaleString()}
                  <br />
                  {m.text}
                </p>
              ))}
            </div>
          )}
          {panel === 'channels' && (
            <div className="channel-list">
              <form
                className="dialog-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void join(
                    new FormData(e.currentTarget).get('name') as string,
                  );
                }}
              >
                <label>
                  Join by name
                  <input name="name" minLength={2} maxLength={32} required />
                </label>
                <button className="dialog-action">Join channel</button>
              </form>
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
                void join(
                  fields.get('name') as string,
                  fields.get('visibility') as string,
                );
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
              <label>
                Access
                <select name="visibility">
                  <option>public</option>
                  <option>unlisted</option>
                  <option>invite-only</option>
                </select>
              </label>
              <button className="dialog-action" disabled={busy}>
                Create & join
              </button>
            </form>
          )}
          {panel === 'friends' && state.me && state.community && (
            <FriendsPanel
              state={state.community}
              me={state.me}
              members={state.members}
              mutate={mutate}
              whisper={whisper}
              profile={(id) => {
                setProfileId(id);
                open('profile');
              }}
            />
          )}
          {(panel === 'profile' || panel === 'settings') &&
            (() => {
              const person =
                panel === 'settings'
                  ? state.me
                  : state.members.find((member) => member.id === profileId);
              if (!person) return null;
              return (
                <div className="profile-card">
                  <h3
                    style={{ color: person.color || callsignColor(person.id) }}
                  >
                    {person.name}
                  </h3>
                  <p>
                    {person.avatar} @{person.handle || person.name}{' '}
                    {person.role && ['owner', 'moderator'].includes(person.role)
                      ? ' · ' + person.role
                      : ''}
                  </p>
                  <p>{person.bio}</p>
                  {person.profileLink && (
                    <a
                      href={person.profileLink}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Profile link
                    </a>
                  )}
                  {person.id === state.me?.id ? (
                    <form
                      className="dialog-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const fields = new FormData(event.currentTarget);
                        void act(async () => {
                          await api('profile', Object.fromEntries(fields));
                          await refresh();
                          setPanel(null);
                        });
                      }}
                    >
                      <label>
                        Display name
                        <input
                          name="displayName"
                          defaultValue={person.name}
                          minLength={2}
                          maxLength={32}
                          required
                        />
                      </label>
                      <fieldset className="profile-colors">
                        <legend>Name color</legend>
                        {[...callsignColors, '#f1d17e'].map((color, index) => (
                          <label key={color} style={{ color }}>
                            <input
                              type="radio"
                              name="color"
                              value={color}
                              defaultChecked={
                                color ===
                                (person.color || callsignColor(person.id))
                              }
                              required
                            />
                            <span className="color-swatch" aria-hidden="true">
                              ✓
                            </span>
                            <span className="sr-only">
                              {
                                [
                                  'Cyan',
                                  'Rose',
                                  'Lavender',
                                  'Green',
                                  'Peach',
                                  'Blue',
                                  'Lilac',
                                  'Gold',
                                ][index]
                              }
                            </span>
                          </label>
                        ))}
                      </fieldset>
                      <p className="field-help">
                        Your account handle and message history stay the same.
                      </p>
                      <button className="dialog-action" disabled={busy}>
                        Save profile
                      </button>
                    </form>
                  ) : (
                    <button
                      className="dialog-action"
                      onClick={() => {
                        setRecipient(person);
                        setPanel(null);
                      }}
                    >
                      Whisper to {person.name}
                    </button>
                  )}
                </div>
              );
            })()}
          {panel === 'admin' && !!state.me?.isAdmin && <AdminPanel />}
          {panel === 'settings' && !!state.me?.isAdmin && (
            <button className="dialog-action" onClick={() => open('admin')}>
              Manage server · Admin
            </button>
          )}
          {panel === 'settings' && state.me && state.community && (
            <details className="channel-options">
              <summary>Channel settings · {channel}</summary>
              <ChannelControls
                state={state.community}
                me={state.me}
                members={state.members}
                mutate={mutate}
              />
            </details>
          )}
          {panel === 'settings' && state.me && state.community && (
            <SocialSettings
              state={state.community}
              me={state.me}
              members={state.members}
              mutate={mutate}
            />
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
