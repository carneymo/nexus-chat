export type VoiceMember = {
  id: string;
  userId: string;
  name: string;
  channel: string;
  muted: boolean;
};
export type VoiceView = {
  joined: boolean;
  muted: boolean;
  deafened: boolean;
  members: VoiceMember[];
  connections: Record<string, string>;
  error: string;
  playbackBlocked: boolean;
};
type Signal =
  | RTCSessionDescriptionInit
  | ({ type: 'candidate' } & RTCIceCandidateInit);
type Peer = {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  pending: RTCIceCandidateInit[];
  queue: Promise<void>;
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
};
async function command<T = { ok: boolean }>(
  path: string,
  data: unknown,
): Promise<T> {
  const response = await fetch(`/api/voice/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error || 'Voice connection failed.');
  return result as T;
}

// One instance owns a microphone and one channel's peer connections.
export class VoiceConnection {
  private id = '';
  private stopped = false;
  private stream?: MediaStream;
  private events?: EventSource;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private view: VoiceView = {
    joined: false,
    muted: false,
    deafened: false,
    members: [],
    connections: {},
    error: '',
    playbackBlocked: false,
  };
  private update: (view: VoiceView) => void;
  constructor(update: (view: VoiceView) => void) {
    this.update = update;
  }
  private publish() {
    this.update({ ...this.view, connections: { ...this.view.connections } });
  }
  async join() {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw new Error(
          'Voice requires a browser with microphone support over HTTPS.',
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      for (const track of stream.getAudioTracks())
        track.onended = () =>
          this.fail('Microphone disconnected. Join voice again to reconnect.');
      const result = await command<{ id: string; iceServers: RTCIceServer[] }>(
        'join',
        {},
      );
      this.id = result.id;
      if (this.stopped) {
        await command('leave', { id: this.id });
        return;
      }
      this.iceServers = result.iceServers;
      this.events = new EventSource(
        `/api/voice/events?id=${encodeURIComponent(this.id)}`,
      );
      this.readyTimer = setTimeout(
        () => this.fail('Voice connection timed out. Join again.'),
        15000,
      );
      this.events.onerror = () =>
        this.fail('Voice disconnected. Join voice again to reconnect.');
      this.events.addEventListener('roster', (event) => {
        if (this.stopped) return;
        const members = JSON.parse(event.data) as VoiceMember[];
        if (!members.some((person) => person.id === this.id)) {
          this.fail('You left this voice channel.');
          return;
        }
        clearTimeout(this.readyTimer);
        this.view.joined = true;
        this.view.members = members;
        const ids = new Set(members.map((person) => person.id));
        for (const id of this.peers.keys())
          if (!ids.has(id)) this.removePeer(id);
        for (const person of members)
          if (person.id !== this.id) this.peer(person.id);
        this.publish();
      });
      this.events.addEventListener('signal', (event) => {
        if (this.stopped) return;
        const { from, signal } = JSON.parse(event.data) as {
          from: string;
          signal: Signal;
        };
        if (!this.view.members.some((member) => member.id === from)) return;
        const peer = this.peer(from);
        peer.queue = peer.queue
          .then(() => this.receive(from, peer, signal))
          .catch(() => {
            this.view.connections[from] = 'Failed — rejoin voice';
            this.publish();
          });
      });
      this.heartbeat = setInterval(() => {
        void command('heartbeat', { id: this.id }).catch(() =>
          this.fail('Voice connection lost. Join again.'),
        );
      }, 20000);
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow it in your browser, then join again.'
          : error instanceof Error
            ? error.message
            : 'Unable to start voice.';
      this.fail(message);
    }
  }
  private peer(id: string) {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: 'relay',
    });
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = this.view.deafened;
    const peer: Peer = {
      pc,
      audio,
      pending: [],
      queue: Promise.resolve(),
      retries: 0,
    };
    this.peers.set(id, peer);
    this.view.connections[id] = 'Connecting';
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      void audio.play().catch(() => {
        this.view.playbackBlocked = true;
        this.publish();
      });
    };
    pc.onicecandidate = (event) => {
      if (event.candidate)
        void this.signal(id, {
          type: 'candidate',
          ...event.candidate.toJSON(),
        });
    };
    // Only the lexicographically first participant offers, including ICE restarts.
    // Both sides still queue signals and candidates until a remote description exists.
    pc.onnegotiationneeded = () => {
      if (this.id > id) return;
      peer.queue = peer.queue
        .then(async () => {
          if (pc.signalingState !== 'stable' || this.stopped) return;
          await pc.setLocalDescription(await pc.createOffer());
          await this.signal(id, pc.localDescription!.toJSON());
        })
        .catch(() => {
          this.view.connections[id] = 'Failed — rejoin voice';
          this.publish();
        });
    };
    pc.onconnectionstatechange = () => {
      if (this.stopped || !this.peers.has(id)) return;
      this.view.connections[id] =
        pc.connectionState === 'connected'
          ? 'Connected'
          : pc.connectionState === 'failed'
            ? 'Failed — rejoin voice'
            : 'Connecting';
      if (pc.connectionState === 'connected') {
        clearTimeout(peer.timer);
        peer.timer = undefined;
      }
      if (
        (pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected') &&
        this.id < id &&
        !peer.timer &&
        peer.retries < 2
      ) {
        peer.timer = setTimeout(() => {
          peer.timer = undefined;
          peer.retries++;
          if (!this.stopped && pc.connectionState !== 'connected')
            pc.restartIce();
        }, 5000);
      }
      this.publish();
    };
    for (const track of this.stream!.getAudioTracks())
      pc.addTrack(track, this.stream!);
    return peer;
  }
  private async signal(to: string, signal: Signal) {
    if (this.stopped) return;
    try {
      await command('signal', { id: this.id, to, signal });
    } catch {
      if (this.peers.has(to) && !this.stopped) {
        this.view.connections[to] = 'Connection interrupted';
        this.publish();
      }
    }
  }
  private async receive(id: string, peer: Peer, signal: Signal) {
    if (this.stopped || peer.pc.signalingState === 'closed') return;
    if (signal.type === 'candidate') {
      const { type: _type, ...candidate } = signal;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
      else peer.pending.push(candidate);
      return;
    }
    if (signal.type !== 'offer' && signal.type !== 'answer') return;
    await peer.pc.setRemoteDescription(signal);
    for (const candidate of peer.pending.splice(0))
      await peer.pc.addIceCandidate(candidate);
    if (signal.type === 'offer') {
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await this.signal(id, peer.pc.localDescription!.toJSON());
    }
  }
  async mute(muted: boolean) {
    if (this.stopped || !this.view.joined) return;
    for (const track of this.stream?.getAudioTracks() || [])
      track.enabled = !muted;
    this.view.muted = muted;
    this.publish();
    try {
      await command('mute', { id: this.id, muted });
    } catch {
      this.fail('Unable to update microphone state. Voice was disconnected.');
    }
  }
  deafen(deafened: boolean) {
    if (this.stopped || !this.view.joined) return;
    this.view.deafened = deafened;
    for (const peer of this.peers.values()) peer.audio.muted = deafened;
    this.publish();
  }
  async resumeAudio() {
    const results = await Promise.allSettled(
      [...this.peers.values()]
        .filter((peer) => peer.audio.srcObject)
        .map((peer) => peer.audio.play()),
    );
    this.view.playbackBlocked = results.some(
      (result) => result.status === 'rejected',
    );
    this.publish();
  }
  private removePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.timer);
    peer.pc.close();
    peer.audio.pause();
    peer.audio.srcObject = null;
    delete this.view.connections[id];
  }
  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.view.error = message;
    this.publish();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.readyTimer);
    this.events?.close();
    for (const track of this.stream?.getTracks() || []) {
      track.onended = null;
      track.stop();
    }
    for (const id of this.peers.keys()) this.removePeer(id);
    if (this.id)
      void fetch('/api/voice/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.id }),
        keepalive: true,
      }).catch(() => {});
    this.view = {
      ...this.view,
      joined: false,
      members: [],
      connections: {},
      muted: false,
      deafened: false,
    };
    this.publish();
  }
}
