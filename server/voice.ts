import { createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type VoiceSession = {
  user: { id: string; name: string; channel: string };
  hash: string;
  expires: number;
};
type Participant = {
  id: string;
  userId: string;
  name: string;
  channel: string;
  muted: boolean;
  session: string;
  expires: number;
  seen: number;
  response?: ServerResponse;
};
export type VoiceConfig = { turnUrls?: string[]; turnSecret?: string };
type Dependencies = {
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  json: (response: ServerResponse, status: number, value: unknown) => void;
  fail: (status: number, message: string) => never;
  changed: () => void;
  sessionValid: (hash: string) => boolean;
};
export function createVoice(config: VoiceConfig, deps: Dependencies) {
  const people = new Map<string, Participant>();
  const roster = () =>
    [...people.values()]
      .filter((p) => p.response && !p.response.destroyed)
      .map(({ id, userId, name, channel, muted }) => ({
        id,
        userId,
        name,
        channel,
        muted,
      }));
  function emit(person: Participant, kind: string, data: unknown) {
    if (!person.response || person.response.destroyed) return;
    if (person.response.writableLength > 65536) {
      person.response.destroy();
      return;
    }
    person.response.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function changed() {
    const members = roster();
    for (const person of people.values())
      emit(
        person,
        'roster',
        members.filter((p) => p.channel === person.channel),
      );
    deps.changed();
  }
  function remove(id: string) {
    const person = people.get(id);
    if (!person) return;
    people.delete(id);
    person.response?.end();
    changed();
  }
  function renameUser(userId: string, name: string) {
    for (const person of people.values())
      if (person.userId === userId) person.name = name;
    changed();
  }
  function removeUser(userId: string) {
    for (const person of people.values())
      if (person.userId === userId) remove(person.id);
  }
  function removeSession(hash: string) {
    for (const person of people.values())
      if (person.session === hash) remove(person.id);
  }
  const timer = setInterval(() => {
    for (const person of people.values()) {
      if (
        person.expires <= Date.now() ||
        Date.now() - person.seen > 150000 ||
        !deps.sessionValid(person.session)
      )
        remove(person.id);
      else person.response?.write(': heartbeat\n\n');
    }
  }, 15000);
  timer.unref();
  function iceServers(userId: string) {
    if (!config.turnSecret || !config.turnUrls?.length) return [];
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${userId}`;
    const credential = createHmac('sha1', config.turnSecret)
      .update(username)
      .digest('base64');
    return [{ urls: config.turnUrls, username, credential }];
  }
  async function handle(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
    session: VoiceSession,
  ) {
    if (path === '/api/voice/join' && request.method === 'POST') {
      await deps.body(request);
      if (!config.turnSecret || !config.turnUrls?.length)
        deps.fail(503, 'Voice relay is not configured yet.');
      if ([...people.values()].some((p) => p.userId === session.user.id))
        deps.fail(
          409,
          'You are already in voice in another tab or device. Leave there first.',
        );
      if (
        [...people.values()].filter((p) => p.channel === session.user.channel)
          .length >= 8
      )
        deps.fail(409, 'Voice is full (8 people per channel).');
      const person: Participant = {
        id: randomUUID(),
        userId: session.user.id,
        name: session.user.name,
        channel: session.user.channel,
        muted: false,
        session: session.hash,
        expires: session.expires,
        seen: Date.now(),
      };
      people.set(person.id, person);
      deps.json(response, 200, {
        id: person.id,
        iceServers: iceServers(person.userId),
      });
      return;
    }
    if (path === '/api/voice/events' && request.method === 'GET') {
      const id =
        new URL(request.url!, 'http://localhost').searchParams.get('id') || '';
      const person = people.get(id);
      if (
        !person ||
        person.session !== session.hash ||
        person.channel !== session.user.channel
      )
        deps.fail(403, 'Join voice first.');
      if (person.response) deps.fail(409, 'Voice connection is already open.');
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write(': connected\n\n');
      person.response = response;
      person.seen = Date.now();
      response.on('close', () => remove(id));
      changed();
      return;
    }
    if (request.method !== 'POST') deps.fail(404, 'Unknown voice command.');
    const data = await deps.body(request);
    const person = people.get(typeof data.id === 'string' ? data.id : '');
    if (
      !person ||
      person.session !== session.hash ||
      person.channel !== session.user.channel
    )
      deps.fail(403, 'Join voice first.');
    person.seen = Date.now();
    if (path === '/api/voice/leave') remove(person.id);
    else if (path === '/api/voice/mute') {
      if (typeof data.muted !== 'boolean')
        deps.fail(400, 'Specify mute state.');
      person.muted = data.muted;
      changed();
    } else if (path === '/api/voice/heartbeat') {
      /* Refresh the membership lease. */
    } else if (path === '/api/voice/signal') {
      const target = people.get(typeof data.to === 'string' ? data.to : '');
      if (
        !person.response ||
        !target?.response ||
        target.channel !== person.channel ||
        target.id === person.id
      )
        deps.fail(403, 'That person is not in your voice channel.');
      const signal = data.signal as Record<string, unknown> | undefined;
      if (!signal || typeof signal !== 'object' || Array.isArray(signal))
        deps.fail(400, 'Invalid voice signal.');
      if (signal.type === 'offer' || signal.type === 'answer') {
        if (typeof signal.sdp !== 'string' || signal.sdp.length > 12000)
          deps.fail(400, 'Invalid voice description.');
        emit(target, 'signal', {
          from: person.id,
          signal: { type: signal.type, sdp: signal.sdp },
        });
      } else if (signal.type === 'candidate') {
        if (
          typeof signal.candidate !== 'string' ||
          signal.candidate.length > 2048 ||
          (signal.sdpMid !== null && typeof signal.sdpMid !== 'string') ||
          (signal.sdpMLineIndex !== null &&
            (!Number.isInteger(signal.sdpMLineIndex) ||
              Number(signal.sdpMLineIndex) < 0))
        )
          deps.fail(400, 'Invalid voice candidate.');
        emit(target, 'signal', {
          from: person.id,
          signal: {
            type: 'candidate',
            candidate: signal.candidate,
            sdpMid: signal.sdpMid,
            sdpMLineIndex: signal.sdpMLineIndex,
          },
        });
      } else deps.fail(400, 'Unsupported voice signal.');
    } else deps.fail(404, 'Unknown voice command.');
    deps.json(response, 200, { ok: true });
  }
  function close() {
    clearInterval(timer);
    const active = [...people.values()];
    people.clear();
    for (const person of active) person.response?.destroy();
  }
  return { handle, roster, removeUser, removeSession, renameUser, close };
}
