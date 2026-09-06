import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceConnection, type VoiceView } from './voice-client.ts';

void test('voice client releases microphone, mutes immediately, and closes on stream failure', async () => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function replace(name: string, value: unknown) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const track = {
    enabled: true,
    onended: null as (() => void) | null,
    stop: () => {
      stopped++;
    },
  };
  let stopped = 0;
  const requests: { path: string; body: { muted?: boolean } }[] = [];
  const instances: FakeEvents[] = [];
  class FakeEvents {
    onerror?: () => void;
    closed = false;
    handlers = new Map<string, (event: { data: string }) => void>();
    constructor() {
      instances.push(this);
    }
    addEventListener(type: string, handler: (event: { data: string }) => void) {
      this.handlers.set(type, handler);
    }
    close() {
      this.closed = true;
    }
    roster() {
      this.handlers.get('roster')?.({
        data: JSON.stringify([
          {
            id: 'self',
            userId: 'user',
            name: 'Alice',
            channel: 'Lobby',
            muted: false,
          },
        ]),
      });
    }
  }
  let view: VoiceView | undefined;
  let client: VoiceConnection | undefined;
  try {
    replace('window', { RTCPeerConnection: class {} });
    replace('navigator', {
      mediaDevices: {
        getUserMedia: async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        }),
      },
    });
    replace('EventSource', FakeEvents);
    replace('fetch', async (path: string, init: { body: string }) => {
      requests.push({ path, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify(
          path.endsWith('/join')
            ? { id: 'self', iceServers: [] }
            : { ok: true },
        ),
        { status: 200 },
      );
    });
    client = new VoiceConnection((next) => {
      view = next;
    });
    await client.join();
    instances[0].roster();
    assert.equal(view?.joined, true);
    const mute = client.mute(true);
    assert.equal(track.enabled, false);
    await mute;
    assert.ok(
      requests.some(
        (request) => request.path.endsWith('/mute') && request.body.muted,
      ),
    );
    await client.mute(false);
    assert.equal(track.enabled, true);
    instances[0].onerror?.();
    assert.equal(stopped, 1);
    assert.equal(instances[0].closed, true);
    assert.equal(view?.joined, false);
    assert.match(view?.error || '', /disconnected/);
    assert.ok(requests.some((request) => request.path.endsWith('/leave')));
    client.stop();
    assert.equal(stopped, 1);
  } finally {
    client?.stop();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
